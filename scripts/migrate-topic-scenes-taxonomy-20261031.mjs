import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { topicSlug, isReservedTopicSlug, normalizeTopicSummary } from '../public/js/shared/topics.js';
// Historical migration identity; independent of the current public URL catalogue.
const FEATURED_TOPIC_ID = 54;
import { legacyTopicRouteKey } from './historical-topic-route-key.mjs';
import { EMPTY_TOPIC_CONTEXT_HASH, sceneContext, lockTopicReferenceGraph } from '../topic-scenes-service.js';
import { TOPIC_SCENES_MIGRATION, verifyTopicScenesSchema, verifyTopicScenesMigration } from './migrate-topic-scenes-20261031.mjs';
import { verifySlugBackup } from './migrate-topic-slugs-20261023.mjs';

export const TOPIC_SCENES_TAXONOMY_MIGRATION = 'official_topic_scenes_taxonomy_20261031';
export const topicScenesTaxonomy = JSON.parse(readFileSync(new URL('../ops/topic-scenes-taxonomy-20261031.json', import.meta.url), 'utf8'));
const oldTaxonomy = JSON.parse(readFileSync(new URL('../ops/topic-taxonomy-20261026.json', import.meta.url), 'utf8'));
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const id = value => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid taxonomy identity');
    return number;
};
const values = value => {
    const record = parse(value);
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || Object.values(record).some(item => typeof item !== 'string')) throw new Error('Invalid legacy scene values');
    return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
};
const significant = value => Object.fromEntries(Object.entries(values(value)).filter(([, item]) => item !== 'any'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const official = row => row && row.owner_user_ID == null && row.created_by_user_ID == null && row.parent_ID == null;
const rehearsalName = name => /^benchpoll_(?:scenes|taxonomy)_rehearsal_[a-z0-9_]+$/.test(name);
const stateTables = { categories: ['categories', 'ID'], contexts: ['ranking_contexts', 'ID'],
    scenes: ['topic_scenes', 'context_ID'], dimensions: ['ranking_dimensions', 'ID'], options: ['ranking_dimension_options', 'ID'],
    pies: ['personal_pies', 'ID'], posts: ['discussion_posts', 'ID'], references: ['personal_pie_topic_weights', 'pie_ID, target_context_ID'],
    proposals: ['topic_proposals', 'ID'], aliases: ['topic_legacy_routes', 'route_key'] };

export function validateSceneTaxonomy(spec = topicScenesTaxonomy) {
    const topics = spec.topics, oldLanguages = oldTaxonomy.dimensions.language.find(row => row.key === 'language').options;
    if (spec.version !== TOPIC_SCENES_TAXONOMY_MIGRATION || spec.featuredTopicID !== FEATURED_TOPIC_ID
        || topics.length !== 32 || topics[0]?.ID !== FEATURED_TOPIC_ID || spec.expectedTopics !== 32
        || spec.expectedActiveScenes !== 209 || topics.reduce((sum, row) => sum + row.scenes.length, 0) !== 209
        || new Set(topics.map(row => row.key)).size !== topics.length) throw new Error('Invalid official taxonomy specification');
    const retainedIDs = topics.filter(row => row.ID != null).map(row => row.ID);
    if (new Set(retainedIDs).size !== 29 || retainedIDs.some(value => id(value) !== value)
        || !same([...retainedIDs].sort((a, b) => a - b), oldTaxonomy.categories.map(row => row.ID).filter(ID => ID !== 231).sort((a, b) => a - b))
        || !same(spec.retiredTopics, [{ ID: 231, name: 'Computer Work', targetID: 196 }])) throw new Error('Invalid official topic identity set');
    const languages = topics.find(row => row.ID === 219)?.scenes.slice(1);
    if (!same(languages.map(row => ({ key: row.language, name: row.name })), oldLanguages)
        || languages.some(row => !same(row.match, { language: row.language }))) throw new Error('The 184 language identities/order must remain unchanged');
    const slugs = new Set();
    for (const [index, topic] of topics.entries()) {
        const slug = topicSlug(topic.name);
        if (topic.position !== (index + 1) * 10 || isReservedTopicSlug(slug) || slugs.has(slug)) throw new Error('Invalid official topic order or URL');
        slugs.add(slug); normalizeTopicSummary(topic.description);
        for (const scene of topic.scenes) if (!scene.name || scene.name.length > 128 || scene.match !== null
            && (!scene.match || Object.values(scene.match).some(value => typeof value !== 'string' || value === 'any'))) throw new Error('Invalid scene specification');
    }
    return { topics: topics.length, activeScenes: 209, languages: languages.length };
}

export async function readSceneTaxonomyState(db, { lock = false } = {}) {
    const state = {};
    for (const [key, [table, order]] of Object.entries(stateTables)) {
        [state[key]] = await db.query(`SELECT * FROM ${table} ORDER BY ${order}${lock ? ' FOR UPDATE' : ''}`);
    }
    return state;
}

function namedScenes(topic) {
    const names = new Set(), slugs = new Set();
    return topic.scenes.map((scene, index) => {
        let name = scene.name;
        if (names.has(name.toLowerCase()) || slugs.has(topicSlug(name))) {
            if (!scene.language) throw new Error('Duplicate official scene name');
            name += ` (${scene.language})`;
        }
        const slug = topicSlug(name);
        if (names.has(name.toLowerCase()) || slugs.has(slug)) throw new Error('Duplicate official scene identity');
        names.add(name.toLowerCase()); slugs.add(slug);
        return { ...scene, name, slug, position: index * 10, isDefault: index === 0,
            description: normalizeTopicSummary(`${topic.name}: ${name}.`) };
    });
}

export function planSceneTaxonomy(state, spec = topicScenesTaxonomy) {
    validateSceneTaxonomy(spec);
    const byID = new Map(state.categories.map(row => [id(row.ID), row]));
    const assigned = new Set();
    const topics = spec.topics.map(definition => {
        const current = definition.ID == null ? null : byID.get(definition.ID), slug = topicSlug(definition.name);
        if (definition.ID != null && (!official(current) || Number(current.is_active) !== 1
            || ![definition.previousName, definition.name].includes(current.name) || current.slug !== topicSlug(current.name))) {
            throw new Error(`Official topic identity changed: ${definition.ID}`);
        }
        if (state.categories.some(row => row.owner_user_ID == null && Number(row.ID) !== definition.ID && row.slug === slug)
            || state.aliases.some(row => legacyTopicRouteKey(row.route_key) === legacyTopicRouteKey(slug) && Number(row.category_ID) !== definition.ID)
            || state.proposals.some(row => ['open', 'pending'].includes(row.status)
                && (row.reservation_slug === slug || row.reservation_name?.toLowerCase() === definition.name.toLowerCase()))) {
            throw new Error(`Official topic URL/name is already reserved: ${slug}`);
        }
        const topic = { ...definition, slug, beforeSlug: current?.slug ?? null,
            description: current && !definition.previousName ? normalizeTopicSummary(current.description) : definition.description };
        topic.scenes = namedScenes(topic).map(scene => {
            const sourceID = scene.sourceTopicID ?? definition.ID;
            const candidates = scene.match === null || sourceID == null ? [] : state.scenes.filter(row => Number(row.category_ID) === sourceID
                && row.legacy_context_values != null && same(significant(row.legacy_context_values), values(scene.match)));
            const active = candidates.filter(row => Number(row.is_active) === 1);
            const defaults = active.filter(row => Number(row.is_default) === 1);
            const preferred = defaults.length === 1 && !Object.keys(scene.match).length ? defaults : active.length ? active : candidates;
            if (preferred.length > 1) throw new Error(`Ambiguous legacy scene: ${topic.name} / ${scene.name}`);
            const existing = preferred[0];
            if (existing) {
                const contextID = id(existing.context_ID), context = state.contexts.find(row => Number(row.ID) === contextID);
                const canonical = sceneContext(contextID);
                if (!context || Number(context.category_ID) !== sourceID || context.context_hash !== canonical.contextHash
                    || !same(values(context.context_values), canonical.contextValues) || assigned.has(contextID)) throw new Error('Scene identity is corrupt or reused');
                if (sourceID !== definition.ID && state.proposals.some(row => Number(row.scene_context_ID) === contextID)) {
                    throw new Error(`Moving a scene with an attached proposal requires explicit review: ${contextID}`);
                }
                assigned.add(contextID);
            }
            const result = { ...scene, contextID: existing ? id(existing.context_ID) : null,
                sourceCategoryID: existing ? sourceID : null, legacyValues: existing ? parse(existing.legacy_context_values) : null };
            if (definition.ID != null && state.scenes.some(row => Number(row.category_ID) === definition.ID
                && Number(row.context_ID) !== result.contextID && (row.slug === result.slug || row.name.toLowerCase() === result.name.toLowerCase()))) {
                throw new Error(`Scene name belongs to a different context: ${topic.name} / ${result.name}`);
            }
            return result;
        });
        return topic;
    });
    const retired = spec.retiredTopics.map(definition => {
        const current = byID.get(definition.ID);
        if (!official(current) || Number(current.is_active) !== 1 || current.name !== definition.name || current.slug !== topicSlug(current.name)) {
            throw new Error(`Retired topic identity changed: ${definition.ID}`);
        }
        return { ...definition, slug: current.slug };
    });
    const managedIDs = new Set([...topics.filter(row => row.ID != null), ...retired].map(row => row.ID));
    return { topics, retired, retireSceneIDs: state.scenes.filter(row => managedIDs.has(Number(row.category_ID))
        && Number(row.is_active) === 1 && !assigned.has(Number(row.context_ID))).map(row => id(row.context_ID)),
    moveScenes: topics.flatMap(topic => topic.scenes.filter(scene => scene.contextID != null && scene.sourceCategoryID !== topic.ID)
        .map(scene => ({ contextID: scene.contextID, sourceCategoryID: scene.sourceCategoryID, targetKey: topic.key }))) };
}

export async function verifySceneTaxonomySchema(db) {
    await verifyTopicScenesSchema(db);
    const required = [...new Set([...Object.values(stateTables).map(([table]) => table),
        'schema_migrations', 'topic_migration_archive', 'ranking_cache_revisions'])];
    const [tables] = await db.query(`SELECT TABLE_NAME AS name, ENGINE AS engine FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${required.map(() => '?').join(', ')})`, required);
    if (required.some(table => !tables.some(row => row.name === table && row.engine === 'InnoDB'))) throw new Error('Taxonomy requires transactional tables');
    const [markers] = await db.execute('SELECT migration_id FROM schema_migrations WHERE migration_id = ?', [TOPIC_SCENES_MIGRATION]);
    if (markers.length !== 1) throw new Error('Apply the base topic scene migration first');
    const [foreignKeys] = await db.query(`SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
        REFERENCED_TABLE_NAME AS target, REFERENCED_COLUMN_NAME AS targetColumn,
        TABLE_SCHEMA = DATABASE() AS localReference FROM information_schema.KEY_COLUMN_USAGE
        WHERE REFERENCED_TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IN ('ranking_contexts', 'topic_scenes')`);
    const allowed = new Set(['topic_scenes.context_ID:ranking_contexts.ID', 'topic_scenes.category_ID:ranking_contexts.category_ID',
        'personal_pies.context_ID:ranking_contexts.ID', 'discussion_posts.context_ID:ranking_contexts.ID',
        'personal_pie_topic_weights.target_context_ID:ranking_contexts.ID',
        'topic_proposals.scene_context_ID:ranking_contexts.ID', 'topic_proposals.parent_topic_ID:ranking_contexts.category_ID']);
    if (foreignKeys.some(row => !Number(row.localReference)
        || !allowed.has(`${row.tableName}.${row.columnName}:${row.target}.${row.targetColumn}`))) throw new Error('Unreviewed scene/context foreign key');
    return { schemaReady: true };
}

async function protectedDigests(db, moveScenes = []) {
    const [tables] = await db.query(`SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()
        AND (TABLE_NAME IN ('discussion_posts', 'discussion_mentions', 'discussion_votes', 'topic_proposals', 'topic_proposal_votes')
            OR TABLE_NAME = 'personal_pies' OR LEFT(TABLE_NAME, 13) = 'personal_pie_') ORDER BY TABLE_NAME`);
    const sourceCategories = new Map(moveScenes.map(row => [row.contextID, row.sourceCategoryID]));
    const result = {};
    for (const { name } of tables) {
        if (!/^[a-z_]+$/.test(name)) throw new Error('Invalid protected table');
        const [keys] = await db.execute(`SELECT COLUMN_NAME AS name FROM information_schema.KEY_COLUMN_USAGE
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION`, [name]);
        if (!keys.length || keys.some(row => !/^[a-zA-Z_]+$/.test(row.name))) throw new Error('Protected table needs a primary key');
        const [rows] = await db.query(`SELECT * FROM ${name} ORDER BY ${keys.map(row => row.name).join(', ')}`);
        result[name] = { count: rows.length, sha256: hash(rows.map(row => name === 'discussion_posts' && sourceCategories.has(Number(row.context_ID))
            ? { ...row, category_ID: String(sourceCategories.get(Number(row.context_ID))) } : row)) };
    }
    return result;
}

function untouchedDigest(state, managedIDs) {
    const unmanagedDimensions = new Set(state.dimensions.filter(row => !managedIDs.has(Number(row.scope_category_ID))).map(row => Number(row.ID)));
    return hash({ categories: state.categories.filter(row => !managedIDs.has(Number(row.ID))),
        contexts: state.contexts.filter(row => !managedIDs.has(Number(row.category_ID))),
        scenes: state.scenes.filter(row => !managedIDs.has(Number(row.category_ID))),
        dimensions: state.dimensions, options: state.options,
        unrelatedOptions: state.options.filter(row => unmanagedDimensions.has(Number(row.dimension_ID))) });
}

async function archiveRecord(db) {
    const [rows] = await db.execute('SELECT payload FROM topic_migration_archive WHERE migration_id = ?', [TOPIC_SCENES_TAXONOMY_MIGRATION]);
    if (rows.length !== 1) throw new Error('Missing taxonomy identity archive');
    const archive = parse(rows[0].payload);
    if (archive.specHash !== hash(topicScenesTaxonomy)) throw new Error('Taxonomy specification/archive mismatch');
    return archive;
}

export async function verifyTopicScenesTaxonomy(db, { archive = null } = {}) {
    validateSceneTaxonomy();
    await verifySceneTaxonomySchema(db);
    archive ??= await archiveRecord(db);
    if (archive.specHash !== hash(topicScenesTaxonomy)) throw new Error('Taxonomy specification/archive mismatch');
    const state = await readSceneTaxonomyState(db), byContext = new Map(state.contexts.map(row => [id(row.ID), row]));
    const managedIDs = new Set(Object.values(archive.topicIDs).map(id));
    if (managedIDs.size !== 32) throw new Error('Taxonomy topic identities are incomplete');
    let activeScenes = 0;
    for (const topic of topicScenesTaxonomy.topics) {
        const ID = id(archive.topicIDs[topic.key]), current = state.categories.find(row => Number(row.ID) === ID);
        if (topic.ID != null && ID !== topic.ID || !official(current) || Number(current.is_active) !== 1
            || current.name !== topic.name || current.slug !== topicSlug(topic.name) || Number(current.position) !== topic.position) throw new Error('Official taxonomy topic mismatch');
        normalizeTopicSummary(current.description);
        const scenes = state.scenes.filter(row => Number(row.category_ID) === ID && Number(row.is_active) === 1)
            .sort((a, b) => Number(b.is_default) - Number(a.is_default) || Number(a.position) - Number(b.position));
        const expected = namedScenes(topic);
        if (scenes.length !== expected.length) throw new Error(`Official scene count mismatch: ${topic.key}`);
        for (const [index, scene] of scenes.entries()) {
            const desired = expected[index];
            if (id(scene.context_ID) !== archive.sceneIDs[topic.key][index] || scene.name !== desired.name || scene.slug !== desired.slug
                || Number(scene.position) !== desired.position || Number(scene.is_default) !== Number(desired.isDefault)) throw new Error('Official scene identity/order mismatch');
            normalizeTopicSummary(scene.description);
        }
        if (!scenes.length && !state.contexts.some(row => Number(row.category_ID) === ID && row.context_hash === EMPTY_TOPIC_CONTEXT_HASH)) throw new Error('Standalone topic is missing its root');
        activeScenes += scenes.length;
    }
    for (const topic of topicScenesTaxonomy.retiredTopics) {
        const current = state.categories.find(row => Number(row.ID) === topic.ID);
        if (!official(current) || current.name !== topic.name || Number(current.is_active) !== 0
            || state.scenes.some(row => Number(row.category_ID) === topic.ID && Number(row.is_active) === 1)) throw new Error('Retired topic remains active');
        if (!state.aliases.some(row => row.route_key === legacyTopicRouteKey(topicSlug(topic.name)) && Number(row.category_ID) === topic.targetID)
            || state.aliases.some(row => Number(row.category_ID) === topic.ID)) throw new Error('Retired topic links do not redirect');
    }
    for (const [slug, categoryID] of Object.entries(archive.expectedAliases)) {
        if (!state.aliases.some(row => row.route_key === slug && Number(row.category_ID) === categoryID)) throw new Error('Old topic link was lost');
    }
    for (const original of archive.contexts) {
        const current = byContext.get(id(original.ID)), move = archive.moveScenes.find(row => row.contextID === Number(original.ID));
        if (!current || Number(current.category_ID) !== (move ? archive.topicIDs[move.targetKey] : Number(original.category_ID))
            || current.context_hash !== original.context_hash || !same(values(current.context_values), values(original.context_values))) throw new Error('Historical context identity changed');
    }
    for (const ID of archive.retireSceneIDs) {
        const scene = state.scenes.find(row => Number(row.context_ID) === ID);
        if (!scene || Number(scene.is_active) !== 0 || Number(scene.is_default) !== 0) throw new Error('Retired scene history was lost/reactivated');
    }
    for (const original of archive.before.scenes) {
        const current = state.scenes.find(row => Number(row.context_ID) === Number(original.context_ID));
        const move = archive.moveScenes.find(row => row.contextID === Number(original.context_ID));
        if (!current || Number(current.category_ID) !== (move ? archive.topicIDs[move.targetKey] : Number(original.category_ID))
            || !same(parse(current.legacy_context_values), parse(original.legacy_context_values))) throw new Error('Historical scene identity/aliases changed');
        if (archive.retireSceneIDs.includes(Number(original.context_ID))
            && ['name', 'slug', 'description', 'position'].some(key => current[key] !== original[key])) throw new Error('Retired scene metadata changed');
    }
    if (state.posts.some(row => Number(byContext.get(Number(row.context_ID))?.category_ID) !== Number(row.category_ID))) throw new Error('Discussion/context category mismatch');
    if (activeScenes !== 209) throw new Error('Official active scene total mismatch');
    const base = await verifyTopicScenesMigration(db);
    return { verified: true, officialTopics: 32, activeScenes, languages: 184, featuredTopicID: FEATURED_TOPIC_ID,
        topicIDs: archive.topicIDs, retiredScenes: archive.retireSceneIDs.length, baseCompatible: base.verified };
}

async function writeAliases(db, state, plan) {
    const owners = new Map(state.aliases.map(row => [row.route_key, Number(row.category_ID)]));
    for (const retired of plan.retired) {
        await db.execute('UPDATE topic_legacy_routes SET category_ID = ? WHERE category_ID = ?', [retired.targetID, retired.ID]);
        for (const [key, owner] of owners) if (owner === retired.ID) owners.set(key, retired.targetID);
    }
    for (const row of [...plan.topics.filter(row => row.beforeSlug && row.beforeSlug !== row.slug)
        .map(row => ({ slug: row.beforeSlug, targetID: row.ID })), ...plan.retired]) {
        const key = legacyTopicRouteKey(row.slug);
        if (owners.has(key) && owners.get(key) !== row.targetID) throw new Error(`Old topic link belongs to another topic: ${key}`);
        if (!owners.has(key)) await db.execute('INSERT INTO topic_legacy_routes (route_hash, route_key, category_ID) VALUES (UNHEX(?), ?, ?)', [hash(key), key, row.targetID]);
        owners.set(key, row.targetID);
    }
    const affectedIDs = new Set([...plan.topics.map(row => row.ID), ...plan.retired.map(row => row.targetID)]);
    return Object.fromEntries([...owners].filter(([, owner]) => affectedIDs.has(owner)));
}

export function assertTaxonomyRehearsalSpace(info) {
    const available = BigInt(info.bavail) * BigInt(info.bsize), required = 2n * 1024n ** 3n;
    if (available < required) throw new Error('Taxonomy rehearsal requires at least 2 GiB free on the database volume');
    return { availableBytes: available.toString(), requiredBytes: required.toString() };
}

async function authorizeWrite(db, { backupManifest = null, rehearsal = false } = {}) {
    const [[row]] = await db.query('SELECT DATABASE() AS name');
    if (rehearsal) {
        if (!rehearsalName(row.name)) throw new Error('Taxonomy rehearsal requires an isolated database');
        const [[server]] = await db.query('SELECT @@datadir AS dataDirectory');
        assertTaxonomyRehearsalSpace(await statfs(server.dataDirectory, { bigint: true }));
        await db.query('SET SESSION sql_log_bin = 0');
    } else await verifySlugBackup(backupManifest, row.name);
}

export async function migrateTopicScenesTaxonomy(db, options = {}) {
    await authorizeWrite(db, options);
    await verifySceneTaxonomySchema(db);
    await db.beginTransaction();
    try {
        await lockTopicReferenceGraph(db);
        const [markers] = await db.execute('SELECT migration_id FROM schema_migrations WHERE migration_id = ? FOR UPDATE', [TOPIC_SCENES_TAXONOMY_MIGRATION]);
        if (markers.length) {
            const verified = await verifyTopicScenesTaxonomy(db);
            await db.commit(); return { applied: false, ...verified };
        }
        const [existingArchive] = await db.execute('SELECT payload FROM topic_migration_archive WHERE migration_id = ?', [TOPIC_SCENES_TAXONOMY_MIGRATION]);
        if (existingArchive.length) throw new Error('Unmarked taxonomy archive requires review');
        const state = await readSceneTaxonomyState(db, { lock: true }), plan = planSceneTaxonomy(state);
        const protectedBefore = await protectedDigests(db, plan.moveScenes);
        const managedIDs = new Set([...plan.topics.filter(row => row.ID != null).map(row => row.ID), ...plan.retired.map(row => row.ID)]);
        const untouchedBefore = untouchedDigest(state, managedIDs);
        const archive = { specHash: hash(topicScenesTaxonomy), topicIDs: {}, sceneIDs: {}, moveScenes: plan.moveScenes,
            retireSceneIDs: plan.retireSceneIDs, contexts: state.contexts, protectedBefore,
            before: { categories: state.categories.filter(row => managedIDs.has(Number(row.ID))),
                scenes: state.scenes.filter(row => managedIDs.has(Number(row.category_ID))) } };
        for (const topic of plan.topics) {
            if (topic.ID == null) {
                const [inserted] = await db.execute(`INSERT INTO categories
                    (name, slug, description, owner_user_ID, created_by_user_ID, parent_ID, position, is_active)
                    VALUES (?, ?, ?, NULL, NULL, NULL, ?, 1)`, [topic.name, topic.slug, topic.description, topic.position]);
                topic.ID = id(inserted.insertId); managedIDs.add(topic.ID);
            } else await db.execute(`UPDATE categories SET name = ?, slug = ?, description = ?, position = ?
                WHERE ID = ? AND owner_user_ID IS NULL AND created_by_user_ID IS NULL`, [topic.name, topic.slug, topic.description, topic.position, topic.ID]);
            archive.topicIDs[topic.key] = topic.ID;
        }
        archive.expectedAliases = await writeAliases(db, state, plan);
        for (const topic of [...plan.topics, ...plan.retired]) await db.execute('UPDATE topic_scenes SET is_default = 0 WHERE category_ID = ? AND is_default = 1', [topic.ID]);
        for (const ID of plan.retireSceneIDs) await db.execute('UPDATE topic_scenes SET is_active = 0, is_default = 0 WHERE context_ID = ?', [ID]);
        for (const topic of plan.topics) {
            archive.sceneIDs[topic.key] = [];
            if (!topic.scenes.length) {
                if (!state.contexts.some(row => Number(row.category_ID) === topic.ID && row.context_hash === EMPTY_TOPIC_CONTEXT_HASH)) {
                    await db.execute(`INSERT INTO ranking_contexts (category_ID, context_values, context_hash) VALUES (?, '{}', ?)`, [topic.ID, EMPTY_TOPIC_CONTEXT_HASH]);
                }
                continue;
            }
            for (const scene of topic.scenes) {
                let contextID = scene.contextID;
                if (contextID !== null && scene.sourceCategoryID !== topic.ID) {
                    // RESTRICT composite FKs are never disabled; remove only the registry row while retaining its context ID.
                    await db.execute('DELETE FROM topic_scenes WHERE context_ID = ? AND category_ID = ?', [contextID, scene.sourceCategoryID]);
                    await db.execute('UPDATE ranking_contexts SET category_ID = ?, updated_at = updated_at WHERE ID = ? AND category_ID = ?', [topic.ID, contextID, scene.sourceCategoryID]);
                    await db.execute('UPDATE discussion_posts SET category_ID = ? WHERE context_ID = ? AND category_ID = ?', [topic.ID, contextID, scene.sourceCategoryID]);
                } else if (contextID === null) {
                    const pending = JSON.stringify({ taxonomy: TOPIC_SCENES_TAXONOMY_MIGRATION, topic: topic.key, scene: scene.slug });
                    const [inserted] = await db.execute('INSERT INTO ranking_contexts (category_ID, context_values, context_hash) VALUES (?, ?, ?)', [topic.ID, pending, hash(pending)]);
                    contextID = id(inserted.insertId);
                    const canonical = sceneContext(contextID);
                    await db.execute('UPDATE ranking_contexts SET context_values = ?, context_hash = ?, updated_at = updated_at WHERE ID = ? AND category_ID = ?',
                        [canonical.serialized, canonical.contextHash, contextID, topic.ID]);
                }
                if (scene.contextID !== null && scene.sourceCategoryID === topic.ID) {
                    await db.execute(`UPDATE topic_scenes SET name = ?, slug = ?, description = ?, position = ?, is_default = ?, is_active = 1
                        WHERE context_ID = ? AND category_ID = ?`, [scene.name, scene.slug, scene.description, scene.position, Number(scene.isDefault), contextID, topic.ID]);
                } else await db.execute(`INSERT INTO topic_scenes
                    (context_ID, category_ID, name, slug, description, position, is_default, is_active, legacy_context_values)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`, [contextID, topic.ID, scene.name, scene.slug, scene.description,
                    scene.position, Number(scene.isDefault), scene.legacyValues === null ? null : JSON.stringify(scene.legacyValues)]);
                archive.sceneIDs[topic.key].push(contextID);
            }
        }
        for (const topic of plan.retired) await db.execute('UPDATE categories SET is_active = 0 WHERE ID = ? AND owner_user_ID IS NULL AND created_by_user_ID IS NULL', [topic.ID]);
        const after = await readSceneTaxonomyState(db);
        if (untouchedBefore !== untouchedDigest(after, managedIDs)) throw new Error('Taxonomy altered an unrelated topic or legacy dimension');
        if (!same(protectedBefore, await protectedDigests(db, plan.moveScenes))) throw new Error('Taxonomy altered protected weights, references, discussions or proposals');
        const verified = await verifyTopicScenesTaxonomy(db, { archive });
        await db.execute('INSERT INTO topic_migration_archive (migration_id, payload) VALUES (?, ?)', [TOPIC_SCENES_TAXONOMY_MIGRATION, JSON.stringify(archive)]);
        await db.execute('INSERT INTO schema_migrations (migration_id) VALUES (?)', [TOPIC_SCENES_TAXONOMY_MIGRATION]);
        await db.execute('UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2');
        await db.commit();
        return { applied: true, ...verified, moveScenes: plan.moveScenes, protectedDataUnchanged: true };
    } catch (error) { await db.rollback(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const apply = process.argv.includes('--apply'), check = process.argv.includes('--check'), rehearsal = process.argv.includes('--rehearse');
    if (check && (apply || rehearsal)) throw new Error('Use --check separately');
    const database = process.env.BENCHPOLL_DB_NAME || 'benchmarks';
    const backupManifest = process.argv.find(arg => arg.startsWith('--backup-manifest='))?.slice(18);
    if (rehearsal && !rehearsalName(database)) throw new Error('Taxonomy rehearsal requires an isolated database');
    if (apply && !rehearsal && !backupManifest) throw new Error('A fresh backup manifest is required');
    const db = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
        host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
        user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
        database, supportBigNumbers: true, bigNumberStrings: true });
    try {
        const [[lock]] = await db.query('SELECT GET_LOCK(?, 30) AS acquired', [TOPIC_SCENES_TAXONOMY_MIGRATION]);
        if (Number(lock.acquired) !== 1) throw new Error('Taxonomy migration is already running');
        try {
            let result;
            if (check) result = await verifyTopicScenesTaxonomy(db);
            else if (apply || rehearsal) result = await migrateTopicScenesTaxonomy(db, { backupManifest, rehearsal });
            else {
                await verifySceneTaxonomySchema(db);
                const [markers] = await db.execute('SELECT migration_id FROM schema_migrations WHERE migration_id = ?', [TOPIC_SCENES_TAXONOMY_MIGRATION]);
                result = markers.length ? { dryRun: true, ...await verifyTopicScenesTaxonomy(db) }
                    : { dryRun: true, backupRequired: true, plan: planSceneTaxonomy(await readSceneTaxonomyState(db)) };
            }
            console.log(JSON.stringify({ migration: TOPIC_SCENES_TAXONOMY_MIGRATION, database, ...result }, null, 2));
        } finally { await db.query('SELECT RELEASE_LOCK(?)', [TOPIC_SCENES_TAXONOMY_MIGRATION]); }
    } finally { await db.end(); }
}
