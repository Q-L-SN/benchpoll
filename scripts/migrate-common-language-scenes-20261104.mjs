import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { EMPTY_TOPIC_CONTEXT_HASH, sceneContext, lockTopicReferenceGraph } from '../topic-scenes-service.js';
import { normalizeTopicSummary } from '../public/js/shared/topics.js';
import { verifySlugBackup } from './migrate-topic-slugs-20261023.mjs';

export const COMMON_LANGUAGE_SCENES = JSON.parse(readFileSync(new URL('../ops/common-language-scenes-20261104.json', import.meta.url), 'utf8'));
export const COMMON_LANGUAGE_SCENES_MIGRATION = 'common_language_scenes_20261104';
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const canonical = value => value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const equal = (a, b) => digest(a) === digest(b);
const numericID = value => {
    const ID = Number(value);
    if (!Number.isSafeInteger(ID) || ID <= 0) throw new Error('Invalid scene identity');
    return ID;
};

function validateSpec() {
    if (COMMON_LANGUAGE_SCENES.version !== COMMON_LANGUAGE_SCENES_MIGRATION
        || COMMON_LANGUAGE_SCENES.language.ID !== 219 || COMMON_LANGUAGE_SCENES.coding.ID !== 180) throw new Error('Unexpected scene specification');
    for (const topic of [COMMON_LANGUAGE_SCENES.language, COMMON_LANGUAGE_SCENES.coding]) {
        if (topic.scenes[0].name !== 'General' || topic.scenes[0].slug !== 'general'
            || new Set(topic.scenes.map(scene => scene.name.toLowerCase())).size !== topic.scenes.length
            || new Set(topic.scenes.map(scene => scene.slug)).size !== topic.scenes.length
            || topic.scenes.some(scene => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scene.slug))) throw new Error('Invalid scene names or paths');
    }
}

export async function readCommonLanguageSceneState(db, { lock = false } = {}) {
    const suffix = lock ? ' FOR UPDATE' : '';
    const [topics] = await db.query(`SELECT ID, name, slug, description, is_active, parent_ID, owner_user_ID, created_by_user_ID
        FROM categories WHERE ID IN (180, 219) ORDER BY ID${suffix}`);
    const [contexts] = await db.query(`SELECT ID, category_ID, context_values, context_hash
        FROM ranking_contexts WHERE category_ID IN (180, 219) ORDER BY ID${suffix}`);
    const [scenes] = await db.query(`SELECT context_ID, category_ID, name, slug, description, position, is_default, is_active, legacy_context_values
        FROM topic_scenes WHERE category_ID IN (180, 219) ORDER BY context_ID${suffix}`);
    return { topics, contexts: contexts.map(row => ({ ...row, context_values: parse(row.context_values) })),
        scenes: scenes.map(row => ({ ...row, legacy_context_values: parse(row.legacy_context_values) })) };
}

export function planCommonLanguageScenes(state) {
    validateSpec();
    const { language, coding } = COMMON_LANGUAGE_SCENES;
    for (const definition of [language, coding]) {
        const topic = state.topics.find(row => Number(row.ID) === definition.ID);
        if (!topic || topic.name !== definition.name || topic.slug !== definition.slug || Number(topic.is_active) !== 1
            || topic.owner_user_ID != null || topic.created_by_user_ID != null || topic.parent_ID != null) throw new Error('Official topic identity changed');
        normalizeTopicSummary(topic.description);
    }
    const languageScenes = state.scenes.filter(row => Number(row.category_ID) === language.ID && Number(row.is_active) === 1);
    if (languageScenes.length !== language.expectedActiveScenes
        || languageScenes.filter(row => Number(row.is_default) === 1).length !== 1
        || languageScenes.find(row => Number(row.is_default) === 1)?.slug !== 'general') throw new Error('Language scene baseline changed; review before applying');
    for (const row of languageScenes) {
        const context = state.contexts.find(item => Number(item.ID) === Number(row.context_ID));
        const expected = sceneContext(numericID(row.context_ID));
        if (!context || Number(context.category_ID) !== language.ID || context.context_hash !== expected.contextHash
            || !equal(context.context_values, expected.contextValues)) throw new Error('Language scene identity is inconsistent');
    }
    const retained = language.scenes.map((definition, index) => {
        const candidates = languageScenes.filter(row => row.name === definition.name && row.slug === definition.slug
            && row.legacy_context_values?.language === definition.language
            && Object.entries(row.legacy_context_values).every(([key, value]) => key === 'language' || value === 'any'));
        if (candidates.length !== 1) throw new Error('Retained language scene is missing or ambiguous');
        return { contextID: numericID(candidates[0].context_ID), categoryID: language.ID, name: definition.name,
            slug: definition.slug, position: index * 10, isDefault: index === 0 };
    });
    if (state.scenes.some(row => Number(row.category_ID) === coding.ID && Number(row.is_active) === 1)) {
        throw new Error('Coding already has active scenes; review before applying');
    }
    const roots = state.contexts.filter(row => Number(row.category_ID) === coding.ID && row.context_hash === EMPTY_TOPIC_CONTEXT_HASH);
    if (roots.length !== 1 || !equal(roots[0].context_values, {})
        || state.scenes.some(row => Number(row.context_ID) === Number(roots[0].ID))) throw new Error('Coding root identity is inconsistent');
    const added = coding.scenes.map((scene, index) => {
        if (state.scenes.some(row => Number(row.category_ID) === coding.ID
            && (row.slug === scene.slug || row.name.toLowerCase() === scene.name.toLowerCase()))) throw new Error('Coding scene name or path is already reserved');
        return { contextID: index === 0 ? numericID(roots[0].ID) : null, categoryID: coding.ID, ...scene,
            position: index * 10, isDefault: index === 0 };
    });
    const retainedIDs = new Set(retained.map(row => row.contextID));
    return { planHash: digest({ spec: COMMON_LANGUAGE_SCENES, state }), retained, added,
        retired: languageScenes.filter(row => !retainedIDs.has(Number(row.context_ID)))
            .map(row => ({ contextID: numericID(row.context_ID), name: row.name, slug: row.slug })) };
}

async function assertSchema(db) {
    const tables = ['categories', 'ranking_contexts', 'topic_scenes', 'schema_migrations', 'topic_migration_archive',
        'topic_reference_lock', 'ranking_cache_revisions'];
    const [rows] = await db.execute(`SELECT TABLE_NAME AS name, ENGINE AS engine FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${tables.map(() => '?').join(',')})`, tables);
    if (tables.some(name => !rows.some(row => row.name === name && row.engine === 'InnoDB'))) throw new Error('Scene migration requires the existing transactional schema');
}

// Only digests enter the archive; user content is never logged or copied into it.
async function protectedDigests(db) {
    const [tables] = await db.query(`SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()
        AND (TABLE_NAME = 'personal_pies' OR LEFT(TABLE_NAME, 13) = 'personal_pie_'
            OR TABLE_NAME IN ('discussion_posts', 'discussion_mentions', 'discussion_votes',
                'topic_proposals', 'topic_proposal_votes', 'topic_proposal_snapshots')) ORDER BY TABLE_NAME`);
    const result = {};
    for (const { name } of tables) {
        if (!/^[a-z_]+$/.test(name)) throw new Error('Invalid protected table');
        const [keys] = await db.execute(`SELECT COLUMN_NAME AS name FROM information_schema.KEY_COLUMN_USAGE
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION`, [name]);
        if (!keys.length || keys.some(key => !/^[a-zA-Z_]+$/.test(key.name))) throw new Error('Protected table needs a primary key');
        const [rows] = await db.query(`SELECT * FROM ${name} ORDER BY ${keys.map(key => key.name).join(', ')}`);
        result[name] = { count: rows.length, sha256: digest(rows) };
    }
    return result;
}

export async function verifyCommonLanguageScenes(db, suppliedArchive = null) {
    const [archives] = suppliedArchive ? [[]] : await db.execute('SELECT payload FROM topic_migration_archive WHERE migration_id = ?', [COMMON_LANGUAGE_SCENES_MIGRATION]);
    const archive = suppliedArchive ?? (archives.length === 1 ? parse(archives[0].payload) : null);
    if (!archive || archive.specHash !== digest(COMMON_LANGUAGE_SCENES)) throw new Error('Missing or mismatched scene migration archive');
    const state = await readCommonLanguageSceneState(db);
    if (!equal(state.topics, archive.before.topics)) throw new Error('Topic metadata changed during scene migration');
    for (const definition of [COMMON_LANGUAGE_SCENES.language, COMMON_LANGUAGE_SCENES.coding]) {
        const active = state.scenes.filter(row => Number(row.category_ID) === definition.ID && Number(row.is_active) === 1)
            .sort((a, b) => Number(a.position) - Number(b.position));
        const expected = archive.scenes.filter(row => row.categoryID === definition.ID);
        if (active.length !== definition.scenes.length || expected.length !== active.length) throw new Error('Scene catalogue count mismatch');
        for (const [index, row] of active.entries()) {
            const target = expected[index], context = state.contexts.find(item => Number(item.ID) === target.contextID);
            const canonicalContext = sceneContext(target.contextID);
            if (Number(row.context_ID) !== target.contextID || row.name !== definition.scenes[index].name
                || row.slug !== definition.scenes[index].slug || Number(row.position) !== index * 10
                || Number(row.is_default) !== Number(index === 0) || !context || Number(context.category_ID) !== definition.ID
                || context.context_hash !== canonicalContext.contextHash || !equal(context.context_values, canonicalContext.contextValues)) throw new Error('Scene identity, default or path mismatch');
        }
    }
    const codingRootID = archive.scenes.find(row => row.categoryID === 180 && row.isDefault).contextID;
    for (const original of archive.before.contexts) {
        if (Number(original.ID) === codingRootID) continue;
        if (!state.contexts.some(row => equal(row, original))) throw new Error('Historical context changed');
    }
    const retained = new Map(archive.scenes.filter(row => row.categoryID === 219).map(row => [row.contextID, row]));
    const retired = new Set(archive.retired.map(row => row.contextID));
    for (const original of archive.before.scenes) {
        const desired = { ...original }, ID = Number(original.context_ID);
        if (retired.has(ID)) Object.assign(desired, { is_active: 0, is_default: 0 });
        if (retained.has(ID)) Object.assign(desired, { position: retained.get(ID).position });
        if (!state.scenes.some(row => equal(row, desired))) throw new Error('Scene history or metadata changed unexpectedly');
    }
    return { verified: true, languageScenes: 9, codingScenes: 11, retiredLanguageScenes: archive.retired.length,
        codingGeneralContextID: codingRootID, retainedContextIDs: [...retained.keys()] };
}

export async function migrateCommonLanguageScenes(db, { apply = false, expectedPlanHash = null, backupManifest = null, rehearsal = false } = {}) {
    validateSpec(); await assertSchema(db);
    const [markers] = await db.execute('SELECT migration_id FROM schema_migrations WHERE migration_id = ?', [COMMON_LANGUAGE_SCENES_MIGRATION]);
    if (markers.length) return { applied: false, alreadyApplied: true, ...await verifyCommonLanguageScenes(db) };
    if (!apply) return { dryRun: true, ...planCommonLanguageScenes(await readCommonLanguageSceneState(db)) };
    if (!/^[a-f0-9]{64}$/.test(expectedPlanHash ?? '')) throw new Error('Apply requires the reviewed --expect-plan hash');
    const [[database]] = await db.query('SELECT DATABASE() AS name');
    if (rehearsal) {
        if (!/^benchpoll_(?:lifecycle_test|common_scenes_rehearsal)_[a-z0-9_]+$/.test(database.name)) throw new Error('Rehearsal requires an isolated development database');
    } else await verifySlugBackup(backupManifest, database.name);
    await db.beginTransaction();
    try {
        await lockTopicReferenceGraph(db);
        const [lockedMarkers] = await db.execute('SELECT migration_id FROM schema_migrations WHERE migration_id = ? FOR UPDATE', [COMMON_LANGUAGE_SCENES_MIGRATION]);
        if (lockedMarkers.length) {
            const result = { applied: false, alreadyApplied: true, ...await verifyCommonLanguageScenes(db) };
            await db.commit(); return result;
        }
        const [orphaned] = await db.execute('SELECT migration_id FROM topic_migration_archive WHERE migration_id = ?', [COMMON_LANGUAGE_SCENES_MIGRATION]);
        if (orphaned.length) throw new Error('An unmarked scene archive requires review');
        const before = await readCommonLanguageSceneState(db, { lock: true }), plan = planCommonLanguageScenes(before);
        if (plan.planHash !== expectedPlanHash) throw new Error('Scene plan changed; inspect and review the new plan');
        const protectedBefore = await protectedDigests(db);
        for (const scene of plan.retired) await db.execute(`UPDATE topic_scenes SET is_active = 0, is_default = 0
            WHERE context_ID = ? AND category_ID = 219`, [scene.contextID]);
        for (const scene of plan.retained) await db.execute('UPDATE topic_scenes SET position = ? WHERE context_ID = ? AND category_ID = 219', [scene.position, scene.contextID]);
        const description = before.topics.find(row => Number(row.ID) === 180).description;
        for (const scene of plan.added) {
            if (scene.contextID === null) {
                const pending = JSON.stringify({ migration: COMMON_LANGUAGE_SCENES_MIGRATION, scene: scene.slug });
                const [inserted] = await db.execute('INSERT INTO ranking_contexts (category_ID, context_values, context_hash) VALUES (180, ?, ?)',
                    [pending, createHash('sha256').update(pending).digest('hex')]);
                scene.contextID = numericID(inserted.insertId);
            }
            const context = sceneContext(scene.contextID);
            await db.execute(`UPDATE ranking_contexts SET context_values = ?, context_hash = ?, updated_at = updated_at
                WHERE ID = ? AND category_ID = 180`, [context.serialized, context.contextHash, scene.contextID]);
            await db.execute(`INSERT INTO topic_scenes
                (context_ID, category_ID, name, slug, description, position, is_default, is_active, legacy_context_values)
                VALUES (?, 180, ?, ?, ?, ?, ?, 1, ?)`, [scene.contextID, scene.name, scene.slug, description,
                scene.position, Number(scene.isDefault), scene.isDefault ? '{}' : null]);
        }
        if (!equal(protectedBefore, await protectedDigests(db))) throw new Error('Protected weights, discussions or proposals changed');
        const archive = { specHash: digest(COMMON_LANGUAGE_SCENES), planHash: plan.planHash, before,
            scenes: [...plan.retained, ...plan.added], retired: plan.retired, protectedBefore };
        const result = await verifyCommonLanguageScenes(db, archive);
        await db.execute('INSERT INTO topic_migration_archive (migration_id, payload) VALUES (?, ?)', [COMMON_LANGUAGE_SCENES_MIGRATION, JSON.stringify(archive)]);
        await db.execute('INSERT INTO schema_migrations (migration_id) VALUES (?)', [COMMON_LANGUAGE_SCENES_MIGRATION]);
        await db.execute('UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2');
        await db.commit();
        return { applied: true, protectedDataUnchanged: true, ...result };
    } catch (error) { await db.rollback(); throw error; }
}

async function main() {
    const args = process.argv.slice(2), apply = args.includes('--apply'), rehearsal = args.includes('--rehearse');
    if (args.some(arg => !['--apply', '--rehearse', '--check'].includes(arg) && !/^--(?:expect-plan|backup-manifest)=.+/.test(arg))
        || args.includes('--check') && apply || rehearsal && !apply) throw new Error('Use inspection, --check, or --apply --expect-plan=<sha256> [--backup-manifest=<path> | --rehearse]');
    const password = process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD;
    if (password === undefined) throw new Error('Database credentials are unavailable');
    const db = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
        host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
        user: process.env.BENCHPOLL_DB_USER || 'root', password, database: process.env.BENCHPOLL_DB_NAME || 'benchmarks',
        supportBigNumbers: true, bigNumberStrings: true, charset: 'utf8mb4' });
    try {
        const options = { apply, rehearsal, expectedPlanHash: args.find(arg => arg.startsWith('--expect-plan='))?.slice(14),
            backupManifest: args.find(arg => arg.startsWith('--backup-manifest='))?.slice(18) };
        console.log(JSON.stringify(args.includes('--check') ? await verifyCommonLanguageScenes(db) : await migrateCommonLanguageScenes(db, options)));
    } finally { await db.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
}
