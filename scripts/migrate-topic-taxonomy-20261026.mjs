import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { topicSlug, isReservedTopicSlug, FEATURED_TOPIC_ID } from '../public/js/shared/topics.js';
import { legacyTopicRouteKey } from '../topic-service.js';
import { canonicalizeContextValues, serializeRankingContextValues } from '../ranking-service.js';
import { preserveContextPies } from '../private-category-service.js';
import { verifySlugBackup } from './migrate-topic-slugs-20261023.mjs';

export const TOPIC_TAXONOMY_MIGRATION = 'official_topic_taxonomy_20261026';
export const topicTaxonomy = JSON.parse(readFileSync(new URL('../ops/topic-taxonomy-20261026.json', import.meta.url), 'utf8'));
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const parseValues = value => typeof value === 'string' ? JSON.parse(value) : value;
const allIDs = spec => [...spec.categories, ...spec.retiredCategories].map(row => row.ID);

export function topicTaxonomyPlan(rows, spec = topicTaxonomy) {
    const IDs = allIDs(spec), byID = new Map(rows.map(row => [Number(row.ID), row]));
    if (spec.featuredTopicID !== FEATURED_TOPIC_ID || spec.categories[0]?.ID !== FEATURED_TOPIC_ID
        || new Set(IDs).size !== IDs.length || IDs.some(ID => !Number.isSafeInteger(ID) || ID < 1)) {
        throw new Error('Invalid official topic identities');
    }
    const targets = new Set(spec.categories.map(row => row.ID)), slugs = new Set();
    if (rows.some(row => row.owner_user_ID == null && row.created_by_user_ID == null && row.is_active
        && !IDs.includes(Number(row.ID)))) throw new Error('Unplanned active official topic');
    const topics = spec.categories.map(node => {
        const current = byID.get(node.ID), slug = topicSlug(node.name);
        if (!current || current.owner_user_ID != null || current.created_by_user_ID != null || !current.is_active
            || ![node.previousName, node.name].includes(current.name) || current.parent_ID != null
            || current.slug !== topicSlug(current.name)) {
            throw new Error('Official topic identity changed: ' + node.ID);
        }
        if (isReservedTopicSlug(slug) || slugs.has(slug)) throw new Error('Reserved or colliding topic URL: ' + slug);
        if (rows.some(row => row.owner_user_ID == null && row.slug === slug && Number(row.ID) !== node.ID)) {
            throw new Error('Topic URL belongs to another topic: ' + slug);
        }
        slugs.add(slug);
        return { ...node, slug, before: current.slug };
    });
    const retired = spec.retiredCategories.map(node => {
        const current = byID.get(node.ID);
        if (!current || current.owner_user_ID != null || current.created_by_user_ID != null
            || current.name !== node.name || current.parent_ID != null || node.targetID != null && !targets.has(node.targetID)) {
            throw new Error('Retired topic identity changed: ' + node.ID);
        }
        return { ...node, slug: current.slug };
    });
    return { topics, retired };
}

export function taxonomyDimensions(key, spec = topicTaxonomy) {
    return (spec.dimensions[key] ?? []).map((dimension, index) => {
        const options = [spec.neutralOption, ...dimension.options];
        if (new Set(options.map(option => option.key)).size !== options.length) throw new Error('Duplicate dimension option');
        return { key: dimension.key, name: dimension.name, position: (index + 1) * 10,
            options: options.map((option, position) => ({ ...option, position: position * 10,
                isDefault: position === 0, isNeutral: position === 0 })) };
    });
}

export function taxonomyContextPlan(contexts, plan, spec = topicTaxonomy) {
    const targets = new Map(plan.topics.map(topic => [topic.ID, topic]));
    const source = new Map([...plan.topics.map(topic => [topic.ID, { targetID: topic.ID }]),
        ...plan.retired.map(topic => [topic.ID, topic])]);
    const groups = new Map(), removed = [];
    for (const context of contexts) {
        const rule = source.get(Number(context.category_ID));
        if (!rule) continue;
        if (rule.targetID == null) { removed.push({ ...context }); continue; }
        const values = parseValues(context.context_values);
        if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid stored topic context');
        if (serializeRankingContextValues(values).contextHash !== context.context_hash) throw new Error('Stored context hash mismatch');
        const dimensions = taxonomyDimensions(targets.get(rule.targetID).key, spec);
        const projected = Object.fromEntries(dimensions.map(dimension => [dimension.key,
            values[dimension.key] ?? rule.contextDefaults?.[dimension.key] ?? spec.neutralOption.key]));
        const canonical = canonicalizeContextValues(projected, dimensions, { requireAllDimensions: true }).contextValues;
        const { serialized, contextHash } = serializeRankingContextValues(canonical);
        const key = rule.targetID + ':' + contextHash;
        if (!groups.has(key)) groups.set(key, { categoryID: rule.targetID, values: canonical, serialized, hash: contextHash, contexts: [] });
        groups.get(key).contexts.push({ ...context, neutral: Object.values(values).every(value => value === spec.neutralOption.key) });
    }
    for (const group of groups.values()) {
        group.contexts.sort((a, b) => Number(Number(b.category_ID) === group.categoryID && b.context_hash === group.hash)
            - Number(Number(a.category_ID) === group.categoryID && a.context_hash === group.hash)
            || Number(Number(b.category_ID) === group.categoryID) - Number(Number(a.category_ID) === group.categoryID)
            || Number(b.neutral) - Number(a.neutral) || Number(a.ID) - Number(b.ID));
        group.keeperID = Number(group.contexts[0].ID);
    }
    return { groups: [...groups.values()], removed };
}

export async function readTaxonomyState(db, lock = false) {
    const state = {}, suffix = lock ? ' FOR UPDATE' : '';
    for (const [key, table] of Object.entries({ categories: 'categories', dimensions: 'ranking_dimensions',
        options: 'ranking_dimension_options', contexts: 'ranking_contexts', pies: 'personal_pies', posts: 'discussion_posts' })) {
        [state[key]] = await db.query(`SELECT * FROM ${table} ORDER BY ID${suffix}`);
    }
    return state;
}

export async function verifyTaxonomyReferences(db) {
    const allowed = new Set(['categories.parent_ID:categories', 'ranking_contexts.category_ID:categories',
        'personal_pies.context_ID:ranking_contexts', 'discussion_posts.category_ID:categories',
        'discussion_posts.context_ID:ranking_contexts', 'topic_legacy_routes.category_ID:categories']);
    const [references] = await db.query(`SELECT table_name AS tableName, column_name AS columnName,
        referenced_table_name AS target, table_schema = DATABASE() AS localReference
        FROM information_schema.key_column_usage WHERE referenced_table_schema = DATABASE()
        AND referenced_table_name IN ('categories', 'ranking_contexts')`);
    if (references.some(reference => !Number(reference.localReference)
        || !allowed.has(reference.tableName + '.' + reference.columnName + ':' + reference.target))) {
        throw new Error('Unreviewed topic or context foreign-key reference');
    }
}

export async function taxonomyPreservation(db) {
    const result = {};
    const [tables] = await db.query(`SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = DATABASE() AND (table_name IN ('users', 'user_public_profiles', 'personal_pies',
            'benchmark_families', 'benchmark_family_members', 'discussion_posts', 'discussion_mentions', 'discussion_votes')
            OR LEFT(table_name, 13) = 'personal_pie_') ORDER BY table_name`);
    for (const { name: table } of tables) {
        if (!/^[a-z_]+$/.test(table)) throw new Error('Unexpected protected table');
        const [keys] = await db.execute(`SELECT column_name AS name FROM information_schema.key_column_usage
            WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = 'PRIMARY' ORDER BY ordinal_position`, [table]);
        if (!keys.length || keys.some(key => !/^[a-zA-Z_]+$/.test(key.name))) throw new Error('Protected table needs a stable primary key');
        const [rows] = await db.query(`SELECT * FROM ${table} ORDER BY ${keys.map(key => key.name).join(', ')}`);
        const normalized = rows.map(row => {
            const copy = { ...row };
            if (table === 'personal_pies') delete copy.context_ID;
            if (table === 'discussion_posts') { delete copy.category_ID; delete copy.context_ID; }
            return copy;
        });
        result[table] = { count: rows.length, digest: hash(normalized) };
    }
    return result;
}

function storedDimensions(state, ID) {
    return state.dimensions.filter(row => Number(row.scope_category_ID) === ID && row.is_active)
        .sort((a, b) => Number(a.position) - Number(b.position) || Number(a.ID) - Number(b.ID))
        .map(row => ({ key: row.dimension_key, name: row.name, position: Number(row.position),
            options: state.options.filter(option => Number(option.dimension_ID) === Number(row.ID))
                .sort((a, b) => Number(a.position) - Number(b.position) || Number(a.ID) - Number(b.ID))
                .map(option => ({ key: option.option_key, name: option.name, position: Number(option.position),
                    isDefault: Boolean(option.is_default), isNeutral: Boolean(option.is_neutral) })) }));
}

export async function verifyTopicTaxonomy(db, spec = topicTaxonomy) {
    await verifyTaxonomyReferences(db);
    const state = await readTaxonomyState(db), plan = topicTaxonomyPlan(state.categories, spec);
    const [aliases] = await db.query('SELECT route_key, category_ID FROM topic_legacy_routes');
    const aliasOwners = new Map(aliases.map(alias => [alias.route_key, Number(alias.category_ID)]));
    for (const topic of plan.topics) {
        const canonicalKey = legacyTopicRouteKey(topic.slug), previousKey = legacyTopicRouteKey(topicSlug(topic.previousName));
        if (aliasOwners.has(canonicalKey) && aliasOwners.get(canonicalKey) !== topic.ID
            || previousKey !== canonicalKey && aliasOwners.get(previousKey) !== topic.ID) throw new Error('Renamed topic route ownership mismatch');
    }
    for (const topic of plan.retired.filter(topic => topic.targetID != null)) {
        if (aliasOwners.get(legacyTopicRouteKey(topic.slug)) !== topic.targetID
            || aliases.some(alias => Number(alias.category_ID) === topic.ID)) throw new Error('Merged topic route ownership mismatch');
    }
    for (const topic of plan.topics) {
        const row = state.categories.find(row => Number(row.ID) === topic.ID);
        if (row.name !== topic.name || row.slug !== topic.slug || Number(row.position) !== topic.position
            || JSON.stringify(storedDimensions(state, topic.ID)) !== JSON.stringify(taxonomyDimensions(topic.key, spec))) {
            throw new Error('Official topic or dimensions do not match specification: ' + topic.ID);
        }
    }
    const retiredIDs = new Set(plan.retired.map(row => row.ID));
    if (state.categories.some(row => retiredIDs.has(Number(row.ID)) && row.is_active)
        || state.dimensions.some(row => retiredIDs.has(Number(row.scope_category_ID)) && row.is_active)) throw new Error('Retired official topic remains active');
    const contexts = taxonomyContextPlan(state.contexts, plan, spec);
    for (const group of contexts.groups) {
        if (group.contexts.length !== 1 || Number(group.contexts[0].category_ID) !== group.categoryID
            || group.contexts[0].context_hash !== group.hash) throw new Error('Topic contexts have not been consolidated');
    }
    const byContext = new Map(state.contexts.map(context => [Number(context.ID), context]));
    if (state.pies.some(pie => retiredIDs.has(Number(byContext.get(Number(pie.context_ID))?.category_ID)))) throw new Error('Retired topic still owns a Pie');
    for (const post of state.posts) {
        const context = byContext.get(Number(post.context_ID));
        if (!context || Number(context.category_ID) !== Number(post.category_ID)) throw new Error('Discussion context and topic differ');
    }
    return { verified: true, officialTopics: plan.topics.length, retiredTopics: plan.retired.length,
        activeDimensions: plan.topics.reduce((sum, topic) => sum + taxonomyDimensions(topic.key, spec).length, 0),
        contexts: state.contexts.length, pies: state.pies.length, discussions: state.posts.length };
}

async function writeDimensions(db, plan, spec) {
    for (const ID of allIDs(spec)) await db.execute('UPDATE ranking_dimensions SET is_active = 0 WHERE scope_category_ID = ?', [ID]);
    for (const topic of plan.topics) for (const dimension of taxonomyDimensions(topic.key, spec)) {
        await db.execute(`INSERT INTO ranking_dimensions (scope_category_ID, dimension_key, name, position, is_active)
            VALUES (?, ?, ?, ?, 1) ON DUPLICATE KEY UPDATE name = VALUES(name), position = VALUES(position), is_active = 1`,
        [topic.ID, dimension.key, dimension.name, dimension.position]);
        const [[stored]] = await db.execute('SELECT ID FROM ranking_dimensions WHERE scope_category_ID = ? AND dimension_key = ?', [topic.ID, dimension.key]);
        const keys = dimension.options.map(option => option.key);
        await db.execute(`DELETE FROM ranking_dimension_options WHERE dimension_ID = ? AND option_key NOT IN (${keys.map(() => '?').join(',')})`, [stored.ID, ...keys]);
        for (const option of dimension.options) await db.execute(`INSERT INTO ranking_dimension_options
            (dimension_ID, option_key, name, position, is_default, is_neutral) VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE name = VALUES(name), position = VALUES(position), is_default = VALUES(is_default), is_neutral = VALUES(is_neutral)`,
        [stored.ID, option.key, option.name, option.position, Number(option.isDefault), Number(option.isNeutral)]);
    }
}

async function writeAliases(db, plan) {
    const [aliases] = await db.query('SELECT route_key, category_ID FROM topic_legacy_routes FOR UPDATE');
    const merges = new Map(plan.retired.filter(topic => topic.targetID != null).map(topic => [topic.ID, topic.targetID]));
    const owners = new Map(aliases.map(row => [row.route_key, merges.get(Number(row.category_ID)) ?? Number(row.category_ID)]));
    for (const topic of plan.topics) if (owners.has(legacyTopicRouteKey(topic.slug)) && owners.get(legacyTopicRouteKey(topic.slug)) !== topic.ID) {
        throw new Error('Canonical URL conflicts with a retained link: ' + topic.slug);
    }
    for (const [before, after] of merges) await db.execute('UPDATE topic_legacy_routes SET category_ID = ? WHERE category_ID = ?', [after, before]);
    for (const topic of [...plan.topics.filter(topic => topic.before !== topic.slug).map(topic => ({ slug: topic.before, targetID: topic.ID })),
        ...plan.retired.filter(topic => topic.targetID != null)]) {
        if (!topic.slug) throw new Error('Missing previous topic address');
        const key = legacyTopicRouteKey(topic.slug);
        if (owners.has(key) && owners.get(key) !== topic.targetID) throw new Error('Old URL belongs to another topic: ' + topic.slug);
        if (!owners.has(key)) {
            await db.execute('INSERT INTO topic_legacy_routes (route_hash, route_key, category_ID) VALUES (UNHEX(?), ?, ?)', [hash(key), key, topic.targetID]);
            owners.set(key, topic.targetID);
        }
    }
}

export async function applyTopicTaxonomy(db, spec = topicTaxonomy) {
    await db.beginTransaction();
    try {
        const [markers] = await db.execute('SELECT migration_id FROM schema_migrations WHERE migration_id = ? FOR UPDATE', [TOPIC_TAXONOMY_MIGRATION]);
        if (markers.length) { const result = await verifyTopicTaxonomy(db, spec); await db.commit(); return { applied: false, ...result }; }
        await verifyTaxonomyReferences(db);
        const state = await readTaxonomyState(db, true), before = await taxonomyPreservation(db);
        const plan = topicTaxonomyPlan(state.categories, spec), contexts = taxonomyContextPlan(state.contexts, plan, spec);
        const managed = new Set(allIDs(spec));
        const untouched = hash({ categories: state.categories.filter(row => !managed.has(Number(row.ID))),
            dimensions: state.dimensions.filter(row => !managed.has(Number(row.scope_category_ID))),
            options: state.options.filter(row => !state.dimensions.some(dimension => Number(dimension.ID) === Number(row.dimension_ID) && managed.has(Number(dimension.scope_category_ID)))) });
        const preserved = [], deletedContexts = [], movedPies = [], movedPosts = [];
        for (const context of contexts.removed) {
            if (state.posts.some(post => Number(post.context_ID) === Number(context.ID))) throw new Error('Removed topic with discussion needs an explicit destination');
            const source = plan.retired.find(topic => topic.ID === Number(context.category_ID));
            preserved.push(...await preserveContextPies(db, context.ID, source.name, source.name));
        }
        await writeAliases(db, plan);
        await writeDimensions(db, plan, spec);
        for (const group of contexts.groups) {
            const users = new Set(state.pies.filter(pie => Number(pie.context_ID) === group.keeperID).map(pie => String(pie.user_ID)));
            for (const context of group.contexts) {
                if (Number(context.ID) !== group.keeperID) {
                    for (const pie of state.pies.filter(pie => Number(pie.context_ID) === Number(context.ID))) {
                        if (users.has(String(pie.user_ID))) {
                            const source = state.categories.find(topic => Number(topic.ID) === Number(context.category_ID));
                            preserved.push(...await preserveContextPies(db, context.ID, source.name, source.name, pie.user_ID));
                        } else {
                            await db.execute('UPDATE personal_pies SET context_ID = ?, updated_at = updated_at WHERE ID = ?', [group.keeperID, pie.ID]);
                            movedPies.push({ ID: Number(pie.ID), before: Number(context.ID), after: group.keeperID });
                            users.add(String(pie.user_ID));
                        }
                    }
                }
                for (const post of state.posts.filter(post => Number(post.context_ID) === Number(context.ID))) {
                    if (Number(post.category_ID) !== Number(context.category_ID)) throw new Error('Existing discussion context mismatch');
                    if (Number(post.context_ID) !== group.keeperID || Number(post.category_ID) !== group.categoryID) {
                        movedPosts.push({ ID: Number(post.ID), before: { categoryID: Number(post.category_ID), contextID: Number(post.context_ID) },
                            after: { categoryID: group.categoryID, contextID: group.keeperID } });
                    }
                }
                await db.execute('UPDATE discussion_posts SET category_ID = ?, context_ID = ? WHERE context_ID = ?',
                    [group.categoryID, group.keeperID, context.ID]);
                if (Number(context.ID) !== group.keeperID) {
                    await db.execute('DELETE FROM ranking_contexts WHERE ID = ?', [context.ID]);
                    deletedContexts.push(Number(context.ID));
                }
            }
            await db.execute('UPDATE ranking_contexts SET category_ID = ?, context_values = ?, context_hash = ?, updated_at = updated_at WHERE ID = ?',
                [group.categoryID, group.serialized, group.hash, group.keeperID]);
        }
        for (const topic of plan.topics) await db.execute('UPDATE categories SET name = ?, slug = ?, position = ?, updated_at = updated_at WHERE ID = ?',
            [topic.name, topic.slug, topic.position, topic.ID]);
        for (const topic of plan.retired) await db.execute('UPDATE categories SET is_active = 0, updated_at = updated_at WHERE ID = ?', [topic.ID]);
        const after = await taxonomyPreservation(db);
        if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Migration changed protected content, weights or identity');
        const finalState = await readTaxonomyState(db);
        const addedPrivateIDs = new Set(preserved.map(row => row.categoryID));
        if (hash({ categories: finalState.categories.filter(row => !managed.has(Number(row.ID)) && !addedPrivateIDs.has(Number(row.ID))),
            dimensions: finalState.dimensions.filter(row => !managed.has(Number(row.scope_category_ID))),
            options: finalState.options.filter(row => !finalState.dimensions.some(dimension => Number(dimension.ID) === Number(row.dimension_ID) && managed.has(Number(dimension.scope_category_ID)))) }) !== untouched) {
            throw new Error('Migration changed an unrelated or private topic');
        }
        const verified = await verifyTopicTaxonomy(db, spec);
        const changes = { deletedContexts, movedPies, movedPosts, preservedPies: preserved };
        await db.execute('INSERT INTO topic_migration_archive (migration_id, payload) VALUES (?, ?)', [TOPIC_TAXONOMY_MIGRATION,
            JSON.stringify({ before: state, plan, changes, preservation: before })]);
        await db.execute('INSERT INTO schema_migrations (migration_id) VALUES (?)', [TOPIC_TAXONOMY_MIGRATION]);
        await db.commit();
        return { applied: true, ...verified, ...changes, protectedDataUnchanged: true };
    } catch (error) { await db.rollback(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const database = process.env.BENCHPOLL_DB_NAME || 'benchmarks';
    const apply = process.argv.includes('--apply'), rehearse = process.argv.includes('--rehearse');
    if (rehearse && !/^benchpoll_taxonomy_rehearsal_\d+$/.test(database)) throw new Error('Rehearsal requires an isolated metadata database');
    if (apply && !rehearse) await verifySlugBackup(process.argv.find(arg => arg.startsWith('--backup-manifest='))?.slice(18), database);
    const db = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
        host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
        user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.DB_PASSWORD, database,
        supportBigNumbers: true, bigNumberStrings: true });
    try {
        const [[lock]] = await db.query('SELECT GET_LOCK(?, 30) AS acquired', [TOPIC_TAXONOMY_MIGRATION]);
        if (Number(lock.acquired) !== 1) throw new Error('Official topic migration is already running');
        try {
            if (apply || rehearse) console.log(JSON.stringify(await applyTopicTaxonomy(db)));
            else {
                const state = await readTaxonomyState(db), plan = topicTaxonomyPlan(state.categories);
                const contexts = taxonomyContextPlan(state.contexts, plan);
                console.log(JSON.stringify({ dryRun: true, topics: plan.topics, retired: plan.retired,
                    contextGroups: contexts.groups.map(group => ({ categoryID: group.categoryID, contextID: group.keeperID,
                        sourceContextIDs: group.contexts.map(context => Number(context.ID)), values: group.values })),
                    removedContextIDs: contexts.removed.map(context => Number(context.ID)) }));
            }
        } finally { await db.query('SELECT RELEASE_LOCK(?)', [TOPIC_TAXONOMY_MIGRATION]); }
    } finally { await db.end(); }
}
