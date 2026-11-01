import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { topicSlug } from '../../public/js/shared/topics.js';
import { legacyTopicRouteKey } from '../../topic-service.js';
import { sceneContext, EMPTY_TOPIC_CONTEXT_HASH } from '../../topic-scenes-service.js';
import { planTopicScenes, TOPIC_SCENES_MIGRATION } from '../../scripts/migrate-topic-scenes-20261031.mjs';
import { sceneSchemaDatabase } from './topic-scenes-schema-fixture-20261031.mjs';

const old = JSON.parse(readFileSync(new URL('../../ops/topic-taxonomy-20261026.json', import.meta.url), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const clone = value => structuredClone(value);
const serialize = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));

export function sceneTaxonomyFixtureState() {
    let dimensionID = 1, optionID = 1, contextID = 5000;
    const dimensions = [], options = [];
    for (const topic of old.categories) for (const [index, definition] of (old.dimensions[topic.key] ?? []).entries()) {
        const ID = dimensionID++;
        dimensions.push({ ID, scope_category_ID: topic.ID, dimension_key: definition.key, name: definition.name, position: index * 10, is_active: 1 });
        for (const [position, option] of [old.neutralOption, ...definition.options].entries()) options.push({ ID: optionID++, dimension_ID: ID,
            option_key: option.key, name: option.name, position: position * 10, is_neutral: Number(position === 0), is_default: Number(position === 0) });
    }
    const categories = old.categories.map(topic => ({ ID: topic.ID, name: topic.name, slug: topicSlug(topic.name),
        description: `Assess ${topic.name}.`, position: topic.position, is_active: 1, parent_ID: null, owner_user_ID: null, created_by_user_ID: null }));
    const contexts = old.categories.map(topic => {
        const ID = ({ 54: 1060, 172: 1095, 196: 1090, 231: 1093 })[topic.ID] ?? 3000 + topic.ID;
        const context_values = serialize(Object.fromEntries((old.dimensions[topic.key] ?? []).map(d => [d.key, 'any'])));
        return { ID, category_ID: topic.ID, context_values, context_hash: hash(context_values), updated_at: '2026-10-31 01:00:00' };
    });
    const preScene = { categories, contexts, dimensions, options, pies: [{ ID: 1, context_ID: 1095 }], posts: [] };
    const plan = planTopicScenes(preScene), scenes = [];
    for (const topic of plan.topics) for (const scene of topic.scenes) {
        const ID = scene.contextID ?? contextID++, canonical = sceneContext(ID);
        const context = contexts.find(row => row.ID === ID);
        if (context) Object.assign(context, { context_values: canonical.serialized, context_hash: canonical.contextHash });
        else contexts.push({ ID, category_ID: topic.categoryID, context_values: canonical.serialized, context_hash: canonical.contextHash, updated_at: '2026-10-31 01:00:00' });
        scenes.push({ context_ID: ID, category_ID: topic.categoryID, name: scene.name, slug: scene.slug, description: scene.description,
            position: scene.position, is_default: Number(scene.isDefault), is_active: 1, legacy_context_values: JSON.stringify(scene.legacyValues) });
    }
    for (const dimension of dimensions) dimension.is_active = 0;
    for (const [ID, name, owner, creator] of [[9000, 'Private topic', 5, 5], [9002, 'Unrelated public topic', null, 5], [9004, 'Other official topic', null, null]]) {
        categories.push({ ID, name, slug: topicSlug(name), description: `An untouched ${name}.`, position: 900, is_active: 1,
            parent_ID: null, owner_user_ID: owner, created_by_user_ID: creator });
        contexts.push({ ID: ID + 1, category_ID: ID, context_values: '{}', context_hash: EMPTY_TOPIC_CONTEXT_HASH, updated_at: '2026-10-31 01:00:00' });
    }
    const privateScene = sceneContext(9001);
    Object.assign(contexts.find(row => row.ID === 9001), { context_values: privateScene.serialized, context_hash: privateScene.contextHash });
    scenes.push({ context_ID: 9001, category_ID: 9000, name: 'General', slug: 'general', description: 'Private scene stays untouched.',
        position: 0, is_default: 1, is_active: 1, legacy_context_values: '{}' });
    const find = (categoryID, key, value) => scenes.find(scene => scene.category_ID === categoryID && parse(scene.legacy_context_values)[key] === value).context_ID;
    const vector = find(172, 'output', 'vector'), project = find(173, 'output', 'project_file');
    const translation = find(219, 'task', 'translation_target'), content = find(191, 'reference_content', 'present');
    const pies = [{ ID: 1, context_ID: 1095, user_ID: 5, revision: 3 }, { ID: 2, context_ID: 1090, user_ID: 5, revision: 1 },
        { ID: 3, context_ID: 1093, user_ID: 5, revision: 2 }, { ID: 4, context_ID: 9001, user_ID: 5, revision: 6 },
        { ID: 5, context_ID: vector, user_ID: 5, revision: 1 }, { ID: 6, context_ID: translation, user_ID: 5, revision: 1 }];
    const weights = [1, 2, 3, 5, 6].map(ID => ({ pie_ID: ID, condition_ID: 100 + ID, weight_basis_points: 10000 }));
    const references = [{ pie_ID: 4, target_context_ID: vector, weight_basis_points: 3000 },
        { pie_ID: 4, target_context_ID: project, weight_basis_points: 3000 }, { pie_ID: 4, target_context_ID: translation, weight_basis_points: 4000 }];
    const posts = [[vector, 172], [project, 173], [translation, 219], [content, 191], [1093, 231]].map(([ID, category_ID], index) => ({
        ID: index + 1, context_ID: ID, category_ID, author_ID: 5, body: `Preserve historical discussion ${index}.`, hidden_at: null }));
    const aliases = [['professional-work', 231], ['customer-service', 231], ['office-data', 196], ['computer', 176], ['my-public-alias', 9002]]
        .map(([slug, category_ID]) => { const route_key = legacyTopicRouteKey(slug); return { route_key, route_hash: hash(route_key), category_ID }; });
    return { categories, contexts, scenes, dimensions, options, pies, posts, references, proposals: [], aliases, weights,
        fallbackRules: [{ pie_ID: 5, condition_ID: 105, rule_ID: 7 }], mentions: [{ ID: 1, post_ID: 1, label: 'Preserve' }],
        discussionVotes: [{ post_ID: 1, user_ID: 5, value: 1 }], proposalVotes: [],
        markers: [{ migration_id: TOPIC_SCENES_MIGRATION }], archives: [], cacheRevision: 7, database: 'benchpoll_taxonomy_rehearsal_fixture' };
}

const tableKeys = {
    categories: ['categories', ['ID']], ranking_contexts: ['contexts', ['ID']], topic_scenes: ['scenes', ['context_ID']],
    ranking_dimensions: ['dimensions', ['ID']], ranking_dimension_options: ['options', ['ID']], personal_pies: ['pies', ['ID']],
    discussion_posts: ['posts', ['ID']], personal_pie_topic_weights: ['references', ['pie_ID', 'target_context_ID']],
    topic_proposals: ['proposals', ['ID']], topic_legacy_routes: ['aliases', ['route_key']], personal_pie_weights: ['weights', ['pie_ID', 'condition_ID']],
    personal_pie_fallback_rules: ['fallbackRules', ['pie_ID', 'condition_ID']], discussion_mentions: ['mentions', ['ID']],
    discussion_votes: ['discussionVotes', ['post_ID', 'user_ID']], topic_proposal_votes: ['proposalVotes', ['proposal_ID', 'user_ID']]
};

export function sceneTaxonomyDatabase(initial = sceneTaxonomyFixtureState()) {
    let state = clone(initial), snapshot = null, failPattern = null, loseCommit = false;
    const schemaFixture = sceneSchemaDatabase(), calls = [];
    const extraForeignKeys = [];
    const equal = (a, b) => String(a) === String(b);
    const checkScene = scene => {
        if (!state.contexts.some(row => equal(row.ID, scene.context_ID) && equal(row.category_ID, scene.category_ID))) throw new Error('FK scene/context category');
        if (![0, 1].includes(scene.is_active) || ![0, 1].includes(scene.is_default) || scene.is_default && !scene.is_active) throw new Error('CHECK scene flags');
        for (const row of state.scenes.filter(row => !equal(row.context_ID, scene.context_ID))) {
            if (equal(row.category_ID, scene.category_ID) && (row.name.toLowerCase() === scene.name.toLowerCase() || row.slug === scene.slug)) throw new Error('UNIQUE scene name/slug');
            if (equal(row.category_ID, scene.category_ID) && row.is_default && scene.is_default) throw new Error('UNIQUE default scene');
        }
    };
    async function execute(raw, args = []) {
        const sql = raw.replace(/\s+/g, ' ').trim(); calls.push({ sql, args: clone(args) });
        if (failPattern?.test(sql)) { failPattern = null; throw new Error('injected_taxonomy_failure'); }
        if (sql === 'SELECT DATABASE() AS name') return [[{ name: state.database }]];
        if (sql === 'SELECT @@datadir AS dataDirectory') return [[{ dataDirectory: tmpdir() }]];
        if (sql === 'SET SESSION sql_log_bin = 0') return [{}];
        if (sql.startsWith('SELECT migration_id FROM schema_migrations')) return [clone(state.markers.filter(row => row.migration_id === args[0]))];
        if (sql.startsWith('SELECT payload FROM topic_migration_archive')) return [clone(state.archives.filter(row => row.migration_id === args[0]))];
        if (sql.includes('FROM information_schema.TABLES') && sql.includes('TABLE_NAME IN (') && args.length) return [args.map(name => ({ name, engine: 'InnoDB' }))];
        if (sql.includes('FROM information_schema.TABLES') && sql.includes('LEFT(TABLE_NAME')) return [Object.keys(tableKeys).filter(name => name.startsWith('personal_pie')
            || ['discussion_posts', 'discussion_mentions', 'discussion_votes', 'topic_proposals', 'topic_proposal_votes'].includes(name)).sort().map(name => ({ name }))];
        if (sql.includes('FROM information_schema.KEY_COLUMN_USAGE') && sql.includes('REFERENCED_TABLE_NAME IN')) {
            return [[...schemaFixture.schema.foreignKeys.filter(row => row.referencedTable === 'ranking_contexts').map(row => ({
                tableName: row.tableName, columnName: row.columnName, target: row.referencedTable, targetColumn: row.referencedColumn, localReference: 1 })),
            { tableName: 'personal_pies', columnName: 'context_ID', target: 'ranking_contexts', targetColumn: 'ID', localReference: 1 },
            { tableName: 'discussion_posts', columnName: 'context_ID', target: 'ranking_contexts', targetColumn: 'ID', localReference: 1 }, ...extraForeignKeys]];
        }
        if (sql.includes('FROM information_schema.KEY_COLUMN_USAGE') && sql.includes("CONSTRAINT_NAME = 'PRIMARY'")) {
            return [tableKeys[args[0]][1].map(name => ({ name }))];
        }
        const select = sql.match(/^SELECT \* FROM ([a-z_]+) ORDER BY /);
        if (select && tableKeys[select[1]]) {
            const [key, fields] = tableKeys[select[1]];
            return [clone(state[key]).sort((a, b) => { for (const field of fields) {
                const compare = typeof a[field] === 'number' && typeof b[field] === 'number' ? a[field] - b[field] : String(a[field]).localeCompare(String(b[field]));
                if (compare) return compare;
            } return 0; })];
        }
        if (sql.startsWith('SELECT c.ID FROM categories c LEFT JOIN topic_scenes')) {
            return [state.categories.filter(row => Number(row.is_active) === 1).filter(topic => {
                const scenes = state.scenes.filter(row => equal(row.category_ID, topic.ID) && Number(row.is_active) === 1);
                return scenes.length ? scenes.filter(row => row.is_default).length !== 1
                    : !state.contexts.some(row => equal(row.category_ID, topic.ID) && row.context_hash === EMPTY_TOPIC_CONTEXT_HASH);
            }).map(row => ({ ID: row.ID }))];
        }
        if (sql.startsWith('SELECT s.*, rc.context_values')) return [state.scenes.map(scene => {
            const context = state.contexts.find(row => equal(row.ID, scene.context_ID));
            if (!context) throw new Error('FK context missing');
            return { ...clone(scene), context_values: context.context_values, context_hash: context.context_hash, context_category_ID: context.category_ID };
        })];
        if (sql.startsWith('SELECT d.ID FROM ranking_dimensions')) return [state.dimensions.filter(row => row.is_active && state.categories.some(c => equal(c.ID, row.scope_category_ID) && c.is_active))];
        if (sql.startsWith('SELECT rc.ID FROM ranking_contexts rc')) return [state.contexts.filter(context => {
            const registered = state.scenes.some(scene => equal(scene.context_ID, context.ID)
                && (!sql.includes('ON s.context_ID = rc.ID AND s.is_active = 1') || scene.is_active));
            return state.categories.some(row => equal(row.ID, context.category_ID) && row.is_active) && !registered
                && context.context_hash !== EMPTY_TOPIC_CONTEXT_HASH && [...state.pies, ...state.posts].some(row => equal(row.context_ID, context.ID));
        }).slice(0, 1).map(row => ({ ID: row.ID }))];
        if (sql.includes('information_schema.') || sql.startsWith('SELECT ID FROM ranking_cache_revisions') || sql.startsWith('SELECT ID FROM topic_reference_lock')) {
            return schemaFixture.db.execute(raw, args);
        }
        if (sql.startsWith('INSERT INTO categories ')) {
            const [name, slug, description, position] = args;
            if (state.categories.some(row => row.owner_user_ID == null && row.slug === slug)) throw new Error('UNIQUE public slug');
            const ID = Math.max(...state.categories.map(row => Number(row.ID))) + 1;
            state.categories.push({ ID, name, slug, description, position, owner_user_ID: null, created_by_user_ID: null, parent_ID: null, is_active: 1 });
            return [{ insertId: ID, affectedRows: 1 }];
        }
        if (sql.startsWith('UPDATE categories SET name')) {
            const [name, slug, description, position, ID] = args, row = state.categories.find(row => equal(row.ID, ID) && row.owner_user_ID == null && row.created_by_user_ID == null);
            if (!row) return [{ affectedRows: 0 }];
            if (state.categories.some(other => other !== row && other.owner_user_ID == null && other.slug === slug)) throw new Error('UNIQUE public slug');
            Object.assign(row, { name, slug, description, position }); return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('UPDATE topic_legacy_routes SET category_ID')) {
            let count = 0; for (const row of state.aliases) if (equal(row.category_ID, args[1])) { row.category_ID = args[0]; count++; }
            return [{ affectedRows: count }];
        }
        if (sql.startsWith('INSERT INTO topic_legacy_routes')) {
            const [route_hash, route_key, category_ID] = args;
            if (state.aliases.some(row => row.route_hash === route_hash)) throw new Error('UNIQUE route hash');
            state.aliases.push({ route_hash, route_key, category_ID }); return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('UPDATE topic_scenes SET is_default = 0')) {
            let count = 0; for (const row of state.scenes) if (equal(row.category_ID, args[0]) && row.is_default === 1) { row.is_default = 0; count++; }
            return [{ affectedRows: count }];
        }
        if (sql.startsWith('UPDATE topic_scenes SET is_active = 0')) {
            const row = state.scenes.find(row => equal(row.context_ID, args[0]));
            if (row) Object.assign(row, { is_active: 0, is_default: 0 }); return [{ affectedRows: Number(Boolean(row)) }];
        }
        if (sql.startsWith('DELETE FROM topic_scenes')) {
            const length = state.scenes.length;
            state.scenes = state.scenes.filter(row => !(equal(row.context_ID, args[0]) && equal(row.category_ID, args[1])));
            return [{ affectedRows: length - state.scenes.length }];
        }
        if (sql.startsWith('UPDATE ranking_contexts SET category_ID')) {
            const [categoryID, ID, sourceID] = args, row = state.contexts.find(row => equal(row.ID, ID) && equal(row.category_ID, sourceID));
            if (!row) return [{ affectedRows: 0 }];
            if (state.scenes.some(row => equal(row.context_ID, ID)) || state.proposals.some(row => equal(row.scene_context_ID, ID))) throw new Error('FK composite context restrict');
            if (state.contexts.some(other => other !== row && equal(other.category_ID, categoryID) && other.context_hash === row.context_hash)) throw new Error('UNIQUE context hash');
            row.category_ID = categoryID; return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('UPDATE discussion_posts SET category_ID')) {
            let count = 0; for (const row of state.posts) if (equal(row.context_ID, args[1]) && equal(row.category_ID, args[2])) { row.category_ID = args[0]; count++; }
            return [{ affectedRows: count }];
        }
        if (sql.startsWith('INSERT INTO ranking_contexts')) {
            const [category_ID, context_values, context_hash] = sql.includes("VALUES (?, '{}', ?)") ? [args[0], '{}', args[1]] : args;
            if (state.contexts.some(row => equal(row.category_ID, category_ID) && row.context_hash === context_hash)) throw new Error('UNIQUE context identity');
            const ID = Math.max(...state.contexts.map(row => Number(row.ID))) + 1;
            state.contexts.push({ ID, category_ID, context_values, context_hash, updated_at: '2026-10-31 02:00:00' }); return [{ insertId: ID, affectedRows: 1 }];
        }
        if (sql.startsWith('UPDATE ranking_contexts SET context_values')) {
            const [context_values, context_hash, ID, categoryID] = args, row = state.contexts.find(row => equal(row.ID, ID) && equal(row.category_ID, categoryID));
            if (!row) return [{ affectedRows: 0 }];
            if (state.contexts.some(other => other !== row && equal(other.category_ID, categoryID) && other.context_hash === context_hash)) throw new Error('UNIQUE context identity');
            Object.assign(row, { context_values, context_hash }); return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('INSERT INTO topic_scenes')) {
            const [context_ID, category_ID, name, slug, description, position, is_default, legacy_context_values] = args;
            if (state.scenes.some(row => equal(row.context_ID, context_ID))) throw new Error('UNIQUE scene context');
            const row = { context_ID, category_ID, name, slug, description, position, is_default, is_active: 1, legacy_context_values };
            checkScene(row); state.scenes.push(row); return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('UPDATE topic_scenes SET name')) {
            const [name, slug, description, position, is_default, ID, categoryID] = args, row = state.scenes.find(row => equal(row.context_ID, ID) && equal(row.category_ID, categoryID));
            if (!row) return [{ affectedRows: 0 }];
            const next = { ...row, name, slug, description, position, is_default, is_active: 1 }; checkScene(next); Object.assign(row, next); return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('UPDATE categories SET is_active = 0')) {
            const row = state.categories.find(row => equal(row.ID, args[0]) && row.owner_user_ID == null && row.created_by_user_ID == null);
            if (row) row.is_active = 0; return [{ affectedRows: Number(Boolean(row)) }];
        }
        if (sql.startsWith('INSERT INTO topic_migration_archive')) {
            if (state.archives.some(row => row.migration_id === args[0])) throw new Error('UNIQUE migration archive');
            state.archives.push({ migration_id: args[0], payload: args[1] }); return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('INSERT INTO schema_migrations')) {
            if (state.markers.some(row => row.migration_id === args[0])) throw new Error('UNIQUE migration marker');
            state.markers.push({ migration_id: args[0] }); return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('UPDATE ranking_cache_revisions SET catalogue_revision')) { state.cacheRevision++; return [{ affectedRows: 1 }]; }
        throw new Error('Unexpected taxonomy fixture SQL: ' + sql);
    }
    const db = { execute, query: execute,
        async beginTransaction() { if (snapshot) throw new Error('Nested transaction'); snapshot = clone(state); calls.push({ sql: 'BEGIN' }); },
        async commit() { snapshot = null; calls.push({ sql: 'COMMIT' }); if (loseCommit) { loseCommit = false; throw new Error('commit_ack_lost'); } },
        async rollback() { if (snapshot) state = snapshot; snapshot = null; calls.push({ sql: 'ROLLBACK' }); } };
    return { db, calls, schema: schemaFixture.schema, extraForeignKeys, get state() { return state; },
        failNext(pattern) { failPattern = pattern; }, loseCommitAcknowledgement() { loseCommit = true; } };
}
