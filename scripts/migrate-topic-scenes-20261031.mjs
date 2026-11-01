import 'dotenv/config';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { topicSlug } from '../public/js/shared/topics.js';
import { sceneContext, EMPTY_TOPIC_CONTEXT_HASH } from '../topic-scenes-service.js';
import { verifySlugBackup } from './migrate-topic-slugs-20261023.mjs';

export const TOPIC_SCENES_MIGRATION = 'topic_scenes_references_20261031';
export const CONTEXTUAL_OFFICIAL_TOPIC_IDS = Object.freeze([210, 172, 173, 190, 191, 192, 219]);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const orderedValues = value => {
    const record = parse(value);
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || Object.values(record).some(item => typeof item !== 'string')) throw new Error('Invalid stored context');
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]));
};
const cleanType = value => String(value).toLowerCase().replace(/\(\d+\)/g, '');
const weightCheck = 'weight_basis_points BETWEEN 100 AND 10000';
const sceneActiveCheck = 'is_active IN (0, 1) AND is_default IN (0, 1) AND (is_default = 0 OR is_active = 1)';
const proposalStateCheck = `(status = 'open' AND moderation_log_ID IS NULL AND topic_ID IS NULL AND scene_context_ID IS NULL AND promoted_at IS NULL AND decided_at IS NULL)
    OR (status = 'pending' AND moderation_log_ID IS NOT NULL AND topic_ID IS NULL AND scene_context_ID IS NULL AND promoted_at IS NOT NULL AND decided_at IS NULL)
    OR (status = 'approved' AND moderation_log_ID IS NOT NULL AND promoted_at IS NOT NULL AND decided_at IS NOT NULL
        AND ((parent_topic_ID IS NULL AND topic_ID IS NOT NULL AND scene_context_ID IS NULL)
            OR (parent_topic_ID IS NOT NULL AND topic_ID IS NULL AND scene_context_ID IS NOT NULL)))
    OR (status = 'rejected' AND moderation_log_ID IS NOT NULL AND topic_ID IS NULL AND scene_context_ID IS NULL AND promoted_at IS NOT NULL AND decided_at IS NOT NULL)`;
const proposalIdentityCheck = `(parent_topic_ID IS NULL AND scene_context_ID IS NULL AND scene_reservation_slug IS NULL AND scene_reservation_name IS NULL)
    OR (parent_topic_ID IS NOT NULL AND topic_ID IS NULL AND reservation_slug IS NULL AND reservation_name IS NULL)`;
// CHECK_CLAUSE can escape literal delimiters even though SHOW CREATE does not.
const checkSignature = value => String(value).toLowerCase().replace(/\\'/g, "'")
    .replace(/_(?:utf8mb4|utf8mb3|utf8|ascii|latin1)(?=')/g, '').replace(/[`\s()]/g, '');

export function topicScenesDDL(types = { categories: 'INT UNSIGNED', ranking_contexts: 'BIGINT UNSIGNED', personal_pies: 'BIGINT UNSIGNED' }) {
    for (const name of ['categories', 'ranking_contexts', 'personal_pies']) {
        if (!/^(INT|BIGINT) UNSIGNED$/.test(types[name])) throw new Error('Invalid scene reference type');
    }
    return [
        `CREATE TABLE IF NOT EXISTS topic_scenes (
            context_ID ${types.ranking_contexts} NOT NULL,
            category_ID ${types.categories} NOT NULL,
            name VARCHAR(128) NOT NULL,
            slug VARCHAR(80) NOT NULL,
            description VARCHAR(180) NOT NULL,
            position INT UNSIGNED NOT NULL DEFAULT 0,
            is_default TINYINT UNSIGNED NOT NULL DEFAULT 0,
            is_active TINYINT UNSIGNED NOT NULL DEFAULT 1,
            legacy_context_values JSON NULL,
            default_category_ID ${types.categories} GENERATED ALWAYS AS (CASE WHEN is_default = 1 AND is_active = 1 THEN category_ID ELSE NULL END) STORED,
            PRIMARY KEY (context_ID),
            UNIQUE KEY uq_topic_scene_slug (category_ID, slug),
            UNIQUE KEY uq_topic_scene_name (category_ID, name),
            UNIQUE KEY uq_topic_scene_default (default_category_ID),
            KEY idx_topic_scene_order (category_ID, is_active, is_default, position),
            CONSTRAINT fk_topic_scene_context FOREIGN KEY (context_ID, category_ID) REFERENCES ranking_contexts (ID, category_ID) ON DELETE RESTRICT,
            CONSTRAINT fk_topic_scene_category FOREIGN KEY (category_ID) REFERENCES categories (ID) ON DELETE RESTRICT,
            CONSTRAINT ck_topic_scene_active CHECK (${sceneActiveCheck})
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
        `CREATE TABLE IF NOT EXISTS personal_pie_topic_weights (
            pie_ID ${types.personal_pies} NOT NULL,
            target_context_ID ${types.ranking_contexts} NOT NULL,
            weight_basis_points SMALLINT UNSIGNED NOT NULL,
            PRIMARY KEY (pie_ID, target_context_ID),
            KEY idx_topic_weight_target (target_context_ID),
            CONSTRAINT fk_topic_weight_pie FOREIGN KEY (pie_ID) REFERENCES personal_pies (ID) ON DELETE CASCADE,
            CONSTRAINT fk_topic_weight_context FOREIGN KEY (target_context_ID) REFERENCES ranking_contexts (ID) ON DELETE RESTRICT,
            CONSTRAINT ck_topic_weight_basis_points CHECK (${weightCheck})
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
        `CREATE TABLE IF NOT EXISTS topic_reference_lock (
            ID TINYINT UNSIGNED NOT NULL,
            PRIMARY KEY (ID),
            CONSTRAINT ck_topic_reference_singleton CHECK (ID = 1)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
    ];
}

export function topicSceneCacheTriggers() {
    return ['topic_scenes', 'personal_pie_topic_weights'].flatMap(table => ['INSERT', 'UPDATE', 'DELETE'].map(event => ({
        name: `scene_cache_${table === 'topic_scenes' ? 'scene' : 'reference'}_${event.toLowerCase()}`,
        table, event,
        statement: `UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2`
    })));
}

async function referenceTypes(connection) {
    const types = {};
    for (const table of ['categories', 'ranking_contexts', 'personal_pies']) {
        const [rows] = await connection.execute(`SELECT COLUMN_TYPE AS type FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'ID'`, [table]);
        const type = cleanType(rows[0]?.type);
        if (!/^(int|bigint) unsigned$/.test(type)) throw new Error(`Unsupported scene foreign key: ${table}.ID`);
        types[table] = type.toUpperCase();
    }
    return types;
}

async function schemaColumns(connection, table) {
    const [rows] = await connection.execute(`SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table]);
    return new Set(rows.map(row => row.name));
}

async function schemaChecks(connection) {
    const [rows] = await connection.execute(`SELECT t.TABLE_NAME AS tableName, t.CONSTRAINT_NAME AS name,
        t.ENFORCED AS enforced, c.CHECK_CLAUSE AS clause
        FROM information_schema.TABLE_CONSTRAINTS t JOIN information_schema.CHECK_CONSTRAINTS c
            ON c.CONSTRAINT_SCHEMA = t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME = t.CONSTRAINT_NAME
        WHERE t.CONSTRAINT_SCHEMA = DATABASE() AND t.CONSTRAINT_TYPE = 'CHECK'
          AND t.TABLE_NAME IN ('topic_scenes', 'personal_pie_topic_weights', 'topic_reference_lock', 'topic_proposals')`);
    return rows;
}

async function ensureTopicWeightBounds(connection) {
    const existing = (await schemaChecks(connection)).find(row => row.tableName === 'personal_pie_topic_weights'
        && row.name === 'ck_topic_weight_basis_points');
    const signature = existing && checkSignature(existing.clause);
    if (signature === checkSignature(weightCheck) && existing.enforced === 'YES') return;
    if (existing && ![weightCheck, 'weight_basis_points BETWEEN 1 AND 10000'].some(clause => checkSignature(clause) === signature)) {
        throw new Error('Unexpected topic reference weight constraint');
    }
    const [invalid] = await connection.execute(`SELECT pie_ID, target_context_ID, weight_basis_points
        FROM personal_pie_topic_weights WHERE weight_basis_points < 100 OR weight_basis_points > 10000 LIMIT 1`);
    if (invalid.length) throw new Error('Topic reference weights below the API minimum require review; no weights were changed');
    await connection.query(`ALTER TABLE personal_pie_topic_weights
        ${existing ? 'DROP CHECK ck_topic_weight_basis_points,' : ''}
        ADD CONSTRAINT ck_topic_weight_basis_points CHECK (${weightCheck}) ENFORCED`);
}

export async function ensureTopicScenesSchema(connection) {
    const types = await referenceTypes(connection);
    const [indexes] = await connection.execute(`SELECT INDEX_NAME AS name FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ranking_contexts' AND INDEX_NAME = 'uq_ranking_context_identity'`);
    if (!indexes.length) await connection.query('ALTER TABLE ranking_contexts ADD UNIQUE KEY uq_ranking_context_identity (ID, category_ID)');
    for (const ddl of topicScenesDDL(types)) await connection.query(ddl);
    await ensureTopicWeightBounds(connection);
    await connection.execute('INSERT IGNORE INTO topic_reference_lock (ID) VALUES (1)');
    const [triggers] = await connection.execute(`SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tableName,
        EVENT_MANIPULATION AS event, ACTION_TIMING AS timing, ACTION_STATEMENT AS statement FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE IN ('topic_scenes', 'personal_pie_topic_weights')`);
    for (const trigger of topicSceneCacheTriggers()) {
        const existing = triggers.find(row => row.name === trigger.name);
        if (existing) {
            if (existing.tableName !== trigger.table || existing.event !== trigger.event || existing.timing !== 'AFTER'
                || existing.statement.replace(/`/g, '').replace(/\s+/g, ' ').trim() !== trigger.statement) {
                throw new Error('Scene cache trigger differs from expected definition');
            }
        } else await connection.query(`CREATE TRIGGER ${trigger.name} AFTER ${trigger.event} ON ${trigger.table}
            FOR EACH ROW ${trigger.statement}`);
    }
    const columns = await schemaColumns(connection, 'topic_proposals');
    if (!columns.has('reservation_slug') || !columns.has('revision')) throw new Error('Current topic proposal schema is required');
    for (const [name, definition] of [
        ['parent_topic_ID', `${types.categories} NULL`], ['scene_context_ID', `${types.ranking_contexts} NULL`],
        ['scene_reservation_slug', 'VARCHAR(80) NULL'], ['scene_reservation_name', 'VARCHAR(128) NULL']
    ]) if (!columns.has(name)) await connection.query(`ALTER TABLE topic_proposals ADD COLUMN ${name} ${definition}`);
    const [keys] = await connection.execute(`SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'topic_proposals'`);
    const names = new Set(keys.map(row => row.name));
    for (const [name, definition] of [
        ['fk_scene_proposal_category', `FOREIGN KEY (parent_topic_ID) REFERENCES categories (ID) ON DELETE RESTRICT`],
        ['fk_scene_proposal_context', `FOREIGN KEY (scene_context_ID, parent_topic_ID) REFERENCES ranking_contexts (ID, category_ID) ON DELETE RESTRICT`],
        ['uq_scene_proposal_context', 'UNIQUE KEY uq_scene_proposal_context (scene_context_ID)'],
        ['uq_scene_proposal_slug', 'UNIQUE KEY uq_scene_proposal_slug (parent_topic_ID, scene_reservation_slug)'],
        ['uq_scene_proposal_name', 'UNIQUE KEY uq_scene_proposal_name (parent_topic_ID, scene_reservation_name)']
    ]) if (!names.has(name)) await connection.query(`ALTER TABLE topic_proposals ADD ${definition.startsWith('UNIQUE') ? definition : `CONSTRAINT ${name} ${definition}`}`);
    // Keep topic_ID reserved for approved top-level topics; approved scenes use scene_context_ID.
    if (!names.has('ck_scene_proposal_identity')) {
        await connection.query(`ALTER TABLE topic_proposals
            DROP CHECK ck_topic_proposal_state,
            ADD CONSTRAINT ck_topic_proposal_state CHECK (${proposalStateCheck}),
            ADD CONSTRAINT ck_scene_proposal_identity CHECK (${proposalIdentityCheck})`);
    }
    return { migration: TOPIC_SCENES_MIGRATION, ...await verifyTopicScenesSchema(connection) };
}

export async function verifyTopicScenesSchema(connection) {
    const types = await referenceTypes(connection);
    const [tables] = await connection.execute(`SELECT TABLE_NAME AS name, ENGINE AS engine FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('topic_scenes', 'personal_pie_topic_weights', 'topic_reference_lock', 'topic_proposals')`);
    if (tables.length !== 4 || tables.some(table => table.engine !== 'InnoDB')) throw new Error('Scene tables must use InnoDB');
    const [columns] = await connection.execute(`SELECT TABLE_NAME AS tableName, COLUMN_NAME AS name, COLUMN_TYPE AS type,
        IS_NULLABLE AS nullable, EXTRA AS extra, GENERATION_EXPRESSION AS generation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('topic_scenes', 'personal_pie_topic_weights', 'topic_reference_lock', 'topic_proposals')`);
    const expected = {
        topic_scenes: { context_ID: types.ranking_contexts, category_ID: types.categories, name: 'VARCHAR(128)', slug: 'VARCHAR(80)',
            description: 'VARCHAR(180)', position: 'INT UNSIGNED', is_default: 'TINYINT UNSIGNED', is_active: 'TINYINT UNSIGNED',
            legacy_context_values: 'JSON', default_category_ID: types.categories },
        personal_pie_topic_weights: { pie_ID: types.personal_pies, target_context_ID: types.ranking_contexts, weight_basis_points: 'SMALLINT UNSIGNED' },
        topic_reference_lock: { ID: 'TINYINT UNSIGNED' },
        topic_proposals: { parent_topic_ID: types.categories, scene_context_ID: types.ranking_contexts,
            scene_reservation_slug: 'VARCHAR(80)', scene_reservation_name: 'VARCHAR(128)' }
    };
    for (const [tableName, fields] of Object.entries(expected)) for (const [name, type] of Object.entries(fields)) {
        const column = columns.find(row => row.tableName === tableName && row.name === name);
        const normalize = value => /^(?:tinyint|smallint|int|bigint)\b/i.test(value) ? cleanType(value) : String(value).toLowerCase();
        const nullable = tableName === 'topic_proposals' || ['legacy_context_values', 'default_category_ID'].includes(name);
        if (!column || normalize(column.type) !== normalize(type) || column.nullable !== (nullable ? 'YES' : 'NO')) {
            throw new Error(`Invalid scene schema column: ${tableName}.${name}`);
        }
    }
    const generated = columns.find(row => row.tableName === 'topic_scenes' && row.name === 'default_category_ID');
    if (generated.extra !== 'STORED GENERATED' || checkSignature(generated.generation)
        !== checkSignature('CASE WHEN is_default = 1 AND is_active = 1 THEN category_ID ELSE NULL END')) {
        throw new Error('Invalid default scene generated column');
    }
    const [indexes] = await connection.execute(`SELECT TABLE_NAME AS tableName, INDEX_NAME AS name, NON_UNIQUE AS nonUnique,
        GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS columnsList FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('topic_scenes', 'personal_pie_topic_weights', 'topic_reference_lock', 'topic_proposals', 'ranking_contexts')
        GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE`);
    for (const [table, name, columnsList] of [
        ['ranking_contexts', 'uq_ranking_context_identity', 'ID,category_ID'],
        ['topic_scenes', 'PRIMARY', 'context_ID'], ['topic_scenes', 'uq_topic_scene_slug', 'category_ID,slug'],
        ['topic_scenes', 'uq_topic_scene_name', 'category_ID,name'], ['topic_scenes', 'uq_topic_scene_default', 'default_category_ID'],
        ['personal_pie_topic_weights', 'PRIMARY', 'pie_ID,target_context_ID'], ['topic_reference_lock', 'PRIMARY', 'ID'],
        ['topic_proposals', 'uq_scene_proposal_context', 'scene_context_ID'],
        ['topic_proposals', 'uq_scene_proposal_slug', 'parent_topic_ID,scene_reservation_slug'],
        ['topic_proposals', 'uq_scene_proposal_name', 'parent_topic_ID,scene_reservation_name']
    ]) if (!indexes.some(row => row.tableName === table && row.name === name && Number(row.nonUnique) === 0 && row.columnsList === columnsList)) {
        throw new Error(`Invalid scene schema index: ${table}.${name}`);
    }
    const [constraints] = await connection.execute(`SELECT TABLE_NAME AS tableName, CONSTRAINT_NAME AS name, CONSTRAINT_TYPE AS type
        FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('topic_scenes', 'personal_pie_topic_weights', 'topic_reference_lock', 'topic_proposals')`);
    for (const [tableName, name, type] of [
        ['topic_scenes', 'fk_topic_scene_context', 'FOREIGN KEY'], ['topic_scenes', 'fk_topic_scene_category', 'FOREIGN KEY'],
        ['topic_scenes', 'ck_topic_scene_active', 'CHECK'], ['personal_pie_topic_weights', 'fk_topic_weight_pie', 'FOREIGN KEY'],
        ['personal_pie_topic_weights', 'fk_topic_weight_context', 'FOREIGN KEY'], ['personal_pie_topic_weights', 'ck_topic_weight_basis_points', 'CHECK'],
        ['topic_reference_lock', 'ck_topic_reference_singleton', 'CHECK'], ['topic_proposals', 'fk_scene_proposal_category', 'FOREIGN KEY'],
        ['topic_proposals', 'fk_scene_proposal_context', 'FOREIGN KEY'], ['topic_proposals', 'ck_scene_proposal_identity', 'CHECK'],
        ['topic_proposals', 'ck_topic_proposal_state', 'CHECK']
    ]) if (!constraints.some(row => row.tableName === tableName && row.name === name && row.type === type)) {
        throw new Error(`Missing scene schema constraint: ${name}`);
    }
    const checks = await schemaChecks(connection);
    for (const constraint of constraints.filter(row => row.type === 'CHECK')) {
        if (!checks.some(row => row.tableName === constraint.tableName && row.name === constraint.name && row.enforced === 'YES')) {
            throw new Error(`Scene schema check must be enforced: ${constraint.name}`);
        }
    }
    for (const [tableName, name, clause] of [
        ['topic_scenes', 'ck_topic_scene_active', sceneActiveCheck],
        ['personal_pie_topic_weights', 'ck_topic_weight_basis_points', weightCheck],
        ['topic_reference_lock', 'ck_topic_reference_singleton', 'ID = 1'],
        ['topic_proposals', 'ck_scene_proposal_identity', proposalIdentityCheck],
        ['topic_proposals', 'ck_topic_proposal_state', proposalStateCheck]
    ]) if (!checks.some(row => row.tableName === tableName && row.name === name && checkSignature(row.clause) === checkSignature(clause))) {
        throw new Error(`Invalid scene schema check definition: ${name}`);
    }
    const [foreignKeys] = await connection.execute(`SELECT k.TABLE_NAME AS tableName, k.CONSTRAINT_NAME AS name,
        k.COLUMN_NAME AS columnName, k.ORDINAL_POSITION AS position, k.REFERENCED_TABLE_NAME AS referencedTable,
        k.REFERENCED_COLUMN_NAME AS referencedColumn, r.DELETE_RULE AS deleteRule, r.UPDATE_RULE AS updateRule
        FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
            ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.TABLE_NAME = k.TABLE_NAME AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        WHERE k.CONSTRAINT_SCHEMA = DATABASE()
          AND k.TABLE_NAME IN ('topic_scenes', 'personal_pie_topic_weights', 'topic_proposals')`);
    for (const [table, name, columnNames, target, targetColumns, deleteRule] of [
        ['topic_scenes', 'fk_topic_scene_context', 'context_ID,category_ID', 'ranking_contexts', 'ID,category_ID', 'RESTRICT'],
        ['topic_scenes', 'fk_topic_scene_category', 'category_ID', 'categories', 'ID', 'RESTRICT'],
        ['personal_pie_topic_weights', 'fk_topic_weight_pie', 'pie_ID', 'personal_pies', 'ID', 'CASCADE'],
        ['personal_pie_topic_weights', 'fk_topic_weight_context', 'target_context_ID', 'ranking_contexts', 'ID', 'RESTRICT'],
        ['topic_proposals', 'fk_scene_proposal_category', 'parent_topic_ID', 'categories', 'ID', 'RESTRICT'],
        ['topic_proposals', 'fk_scene_proposal_context', 'scene_context_ID,parent_topic_ID', 'ranking_contexts', 'ID,category_ID', 'RESTRICT']
    ]) {
        const rows = foreignKeys.filter(row => row.tableName === table && row.name === name).sort((a, b) => Number(a.position) - Number(b.position));
        if (rows.map(row => row.columnName).join(',') !== columnNames || rows.map(row => row.referencedColumn).join(',') !== targetColumns
            || rows.some(row => row.referencedTable !== target || row.deleteRule !== deleteRule || !['RESTRICT', 'NO ACTION'].includes(row.updateRule))) {
            throw new Error(`Invalid scene schema foreign key: ${name}`);
        }
    }
    const [triggers] = await connection.execute(`SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tableName,
        EVENT_MANIPULATION AS event, ACTION_TIMING AS timing, ACTION_STATEMENT AS statement FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE IN ('topic_scenes', 'personal_pie_topic_weights')`);
    for (const expected of topicSceneCacheTriggers()) if (!triggers.some(row => row.name === expected.name
        && row.tableName === expected.table && row.event === expected.event && row.timing === 'AFTER'
        && row.statement.replace(/`/g, '').replace(/\s+/g, ' ').trim() === expected.statement)) {
        throw new Error('Missing scene cache invalidation trigger');
    }
    const [cache] = await connection.execute('SELECT ID FROM ranking_cache_revisions WHERE ID = 2');
    if (cache.length !== 1) throw new Error('Ranking catalogue cache revision row is missing');
    return { schemaReady: true };
}

function scopedDimensions(categoryID, dimensions, options) {
    return dimensions.filter(row => Number(row.scope_category_ID) === categoryID && Number(row.is_active) === 1)
        .sort((a, b) => Number(a.position) - Number(b.position) || Number(a.ID) - Number(b.ID))
        .map(row => ({ key: row.dimension_key, name: row.name,
            options: options.filter(option => Number(option.dimension_ID) === Number(row.ID))
                .sort((a, b) => Number(a.position) - Number(b.position) || Number(a.ID) - Number(b.ID)) }));
}

const optionNames = {
    realtime: { no: 'Non-real-time', yes: 'Real-time' },
    output: { bitmap: 'Bitmap output', vector: 'Vector output', finished_video: 'Finished video', project_file: 'Editable project' },
    reference_image: { none: 'No reference image', single: 'Single reference image', multiple: 'Multiple reference images', present: 'With reference images', yes: 'With reference images' },
    reference_video: { none: 'No reference video', present: 'With reference video', yes: 'With reference video' },
    reference_content: { none: 'No reference content', present: 'With reference content', yes: 'With reference content' },
    task: { translation_target: 'Translation target' }
};

export function legacySceneName(values, dimensions) {
    const parts = [];
    for (const [key, value] of Object.entries(orderedValues(values))) {
        const dimension = dimensions.find(item => item.key === key);
        const option = dimension?.options.find(item => item.option_key === value);
        if (value === 'any' || Number(option?.is_neutral) === 1) continue;
        const label = optionNames[key]?.[value] ?? (key === 'language' ? option?.name ?? value
            : `${dimension?.name ?? key}: ${option?.name ?? value}`);
        parts.push(label);
    }
    return parts.length ? parts.join(' / ') : 'General';
}

export function planTopicScenes(state) {
    const topics = [];
    const usedIDs = new Set([...(state.pies ?? []).map(row => Number(row.context_ID)),
        ...(state.posts ?? []).map(row => Number(row.context_ID))]);
    for (const category of state.categories.filter(row => Number(row.is_active) === 1)) {
        const categoryID = Number(category.ID);
        const dimensions = scopedDimensions(categoryID, state.dimensions, state.options);
        const contexts = state.contexts.filter(row => Number(row.category_ID) === categoryID)
            .map(row => ({ ...row, ID: Number(row.ID), values: orderedValues(row.context_values) }));
        for (const context of contexts) {
            if (hash(context.values) !== context.context_hash) throw new Error(`Stored context hash mismatch: ${context.ID}`);
        }
        const neutral = values => Object.entries(values).every(([key, value]) => value === 'any'
            || Number(dimensions.find(item => item.key === key)?.options.find(option => option.option_key === value)?.is_neutral) === 1);
        const needsScenes = dimensions.length > 0 || contexts.some(row => usedIDs.has(row.ID) && Object.keys(row.values).length > 0);
        if (!needsScenes) {
            topics.push({ categoryID, name: category.name, description: category.description, scenes: [],
                rootContextID: contexts.find(row => !Object.keys(row.values).length)?.ID ?? null });
            continue;
        }
        const neutralValues = Object.fromEntries(dimensions.map(dimension => [dimension.key,
            dimension.options.find(option => Number(option.is_neutral) === 1)?.option_key ?? 'any']));
        const neutralContexts = contexts.filter(row => neutral(row.values)).sort((a, b) =>
            Number(JSON.stringify(b.values) === JSON.stringify(orderedValues(neutralValues)))
            - Number(JSON.stringify(a.values) === JSON.stringify(orderedValues(neutralValues))) || a.ID - b.ID);
        const defaultContext = neutralContexts[0];
        const scenes = [{ contextID: defaultContext?.ID ?? null, name: 'General', description: category.description,
            legacyValues: defaultContext?.values ?? orderedValues(neutralValues), isDefault: true, position: 0 }];
        const selectedIDs = new Set(defaultContext ? [defaultContext.ID] : []);
        const signatures = new Set([JSON.stringify(scenes[0].legacyValues)]);
        // Each former option stays selectable, including languages; only Cartesian combinations disappear.
        for (const dimension of dimensions) for (const option of dimension.options) {
            if (Number(option.is_neutral) === 1 || option.option_key === 'any') continue;
            const values = orderedValues({ ...neutralValues, [dimension.key]: option.option_key });
            const signature = JSON.stringify(values);
            if (signatures.has(signature)) continue;
            const existing = contexts.find(row => JSON.stringify(row.values) === signature);
            scenes.push({ contextID: existing?.ID ?? null, name: legacySceneName(values, dimensions),
                description: `${category.name}: ${legacySceneName(values, dimensions)}.`.slice(0, 180),
                legacyValues: values, isDefault: false, position: scenes.length * 10 });
            signatures.add(signature);
            if (existing) selectedIDs.add(existing.ID);
        }
        for (const context of contexts.filter(row => usedIDs.has(row.ID) && !selectedIDs.has(row.ID))) {
            scenes.push({ contextID: context.ID, name: legacySceneName(context.values, dimensions),
                description: `${category.name}: ${legacySceneName(context.values, dimensions)}.`.slice(0, 180),
                legacyValues: context.values, isDefault: false, position: scenes.length * 10 });
            selectedIDs.add(context.ID);
        }
        const names = new Set(), slugs = new Set();
        for (const scene of scenes) {
            let name = [...scene.name].slice(0, 128).join(''), slug = topicSlug(name);
            const suffix = ` ${scene.contextID ?? scene.position}`;
            if (names.has(name.toLowerCase()) || slugs.has(slug)) {
                name = [...name].slice(0, 128 - suffix.length).join('') + suffix;
                slug = topicSlug(name).slice(0, 80 - suffix.length) + '-' + suffix.trim();
            }
            if (names.has(name.toLowerCase()) || slugs.has(slug)) throw new Error('Scene name collision requires manual resolution');
            scene.name = name; scene.slug = slug;
            names.add(name.toLowerCase()); slugs.add(slug);
        }
        topics.push({ categoryID, name: category.name, description: category.description, scenes, rootContextID: defaultContext?.ID ?? null });
    }
    return { topics, languagePolicy: 'Every existing language option becomes one independent scene; no language/task combinations are generated.',
        preservesContextIDs: true, generatesCartesianCombinations: false };
}

export async function readTopicScenesMigrationState(connection, { lock = false } = {}) {
    const state = {}, suffix = lock ? ' FOR UPDATE' : '';
    for (const [key, table] of Object.entries({ categories: 'categories', dimensions: 'ranking_dimensions',
        options: 'ranking_dimension_options', contexts: 'ranking_contexts', pies: 'personal_pies', posts: 'discussion_posts' })) {
        [state[key]] = await connection.query(`SELECT * FROM ${table} ORDER BY ID${suffix}`);
    }
    return state;
}

async function protectedDigests(connection) {
    const [tables] = await connection.query(`SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = DATABASE() AND (table_name IN ('users', 'categories', 'personal_pies', 'discussion_posts',
            'discussion_mentions', 'discussion_votes', 'ranking_dimension_options') OR LEFT(table_name, 13) = 'personal_pie_') ORDER BY table_name`);
    const result = {};
    for (const { name } of tables) {
        if (!/^[a-z_]+$/.test(name)) throw new Error('Invalid protected table');
        const [keys] = await connection.execute(`SELECT column_name AS name FROM information_schema.key_column_usage
            WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = 'PRIMARY' ORDER BY ordinal_position`, [name]);
        if (!keys.length || keys.some(key => !/^[a-zA-Z_]+$/.test(key.name))) throw new Error('Missing protected primary key');
        const [rows] = await connection.query(`SELECT * FROM ${name} ORDER BY ${keys.map(key => key.name).join(', ')}`);
        result[name] = { count: rows.length, hash: hash(rows) };
    }
    return result;
}

export async function verifyTopicScenesMigration(connection) {
    await verifyTopicScenesSchema(connection);
    const [invalid] = await connection.query(`SELECT c.ID FROM categories c LEFT JOIN topic_scenes s
        ON s.category_ID = c.ID AND s.is_active = 1 WHERE c.is_active = 1 GROUP BY c.ID
        HAVING (COUNT(s.context_ID) > 0 AND SUM(s.is_default) <> 1)
            OR (COUNT(s.context_ID) = 0 AND NOT EXISTS (SELECT 1 FROM ranking_contexts rc
                WHERE rc.category_ID = c.ID AND rc.context_hash = '${EMPTY_TOPIC_CONTEXT_HASH}'))`);
    if (invalid.length) throw new Error('Active topic has no unique default/root context');
    const [scenes] = await connection.query(`SELECT s.*, rc.context_values, rc.context_hash, rc.category_ID AS context_category_ID
        FROM topic_scenes s JOIN ranking_contexts rc ON rc.ID = s.context_ID ORDER BY s.context_ID`);
    for (const scene of scenes) {
        const canonical = sceneContext(Number(scene.context_ID));
        if (Number(scene.category_ID) !== Number(scene.context_category_ID) || scene.context_hash !== canonical.contextHash
            || JSON.stringify(orderedValues(scene.context_values)) !== canonical.serialized) throw new Error('Scene context identity mismatch');
    }
    const [dimensions] = await connection.query(`SELECT d.ID FROM ranking_dimensions d JOIN categories c
        ON c.ID = d.scope_category_ID WHERE c.is_active = 1 AND d.is_active = 1`);
    if (dimensions.length) throw new Error('Legacy context selectors remain active');
    const [orphans] = await connection.query(`SELECT rc.ID FROM ranking_contexts rc JOIN categories c ON c.ID = rc.category_ID
        LEFT JOIN topic_scenes s ON s.context_ID = rc.ID
        WHERE c.is_active = 1 AND s.context_ID IS NULL AND rc.context_hash <> '${EMPTY_TOPIC_CONTEXT_HASH}'
        AND (EXISTS(SELECT 1 FROM personal_pies p WHERE p.context_ID = rc.ID)
            OR EXISTS(SELECT 1 FROM discussion_posts p WHERE p.context_ID = rc.ID)) LIMIT 1`);
    if (orphans.length) throw new Error('Configured legacy context is missing its scene');
    const [locks] = await connection.execute('SELECT ID FROM topic_reference_lock WHERE ID = 1');
    if (locks.length !== 1) throw new Error('Reference graph lock is missing');
    return { verified: true, scenes: scenes.length, topicsWithScenes: new Set(scenes.filter(row => Number(row.is_active) === 1).map(row => Number(row.category_ID))).size };
}

export async function migrateTopicScenes(connection) {
    await ensureTopicScenesSchema(connection);
    await connection.beginTransaction();
    try {
        await connection.execute('SELECT ID FROM topic_reference_lock WHERE ID = 1 FOR UPDATE');
        const [markers] = await connection.execute('SELECT migration_id FROM schema_migrations WHERE migration_id = ? FOR UPDATE', [TOPIC_SCENES_MIGRATION]);
        if (markers.length) {
            const verified = await verifyTopicScenesMigration(connection);
            await connection.commit();
            return { applied: false, ...verified };
        }
        const [preexisting] = await connection.query('SELECT context_ID FROM topic_scenes LIMIT 1');
        if (preexisting.length) throw new Error('Unmarked scene data requires review before migration');
        const state = await readTopicScenesMigrationState(connection, { lock: true });
        const before = await protectedDigests(connection), plan = planTopicScenes(state);
        const addedContextIDs = [], convertedContextIDs = [];
        for (const topic of plan.topics) {
            if (!topic.scenes.length) {
                if (topic.rootContextID === null) {
                    const [result] = await connection.execute(`INSERT INTO ranking_contexts (category_ID, context_values, context_hash)
                        VALUES (?, '{}', ?)`, [topic.categoryID, EMPTY_TOPIC_CONTEXT_HASH]);
                    addedContextIDs.push(Number(result.insertId));
                }
                continue;
            }
            for (const scene of topic.scenes) {
                let ID = scene.contextID;
                if (ID === null) {
                    const serialized = JSON.stringify(orderedValues(scene.legacyValues));
                    const [result] = await connection.execute(`INSERT INTO ranking_contexts (category_ID, context_values, context_hash)
                        VALUES (?, ?, ?)`, [topic.categoryID, serialized, hash(orderedValues(scene.legacyValues))]);
                    ID = Number(result.insertId); addedContextIDs.push(ID);
                } else convertedContextIDs.push(ID);
                const canonical = sceneContext(ID);
                await connection.execute(`UPDATE ranking_contexts SET context_values = ?, context_hash = ?, updated_at = updated_at
                    WHERE ID = ? AND category_ID = ?`, [canonical.serialized, canonical.contextHash, ID, topic.categoryID]);
                await connection.execute(`INSERT INTO topic_scenes
                    (context_ID, category_ID, name, slug, description, position, is_default, is_active, legacy_context_values)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`, [ID, topic.categoryID, scene.name, scene.slug,
                    scene.description, scene.position, Number(scene.isDefault), JSON.stringify(scene.legacyValues)]);
            }
            await connection.execute('UPDATE ranking_dimensions SET is_active = 0 WHERE scope_category_ID = ?', [topic.categoryID]);
        }
        const [remainingContexts] = await connection.query('SELECT ID, category_ID FROM ranking_contexts ORDER BY ID');
        if (state.contexts.some(original => !remainingContexts.some(row => Number(row.ID) === Number(original.ID)
            && Number(row.category_ID) === Number(original.category_ID)))) throw new Error('Migration moved or deleted a context identity');
        const after = await protectedDigests(connection);
        if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Migration altered protected data, weights or discussions');
        const verified = await verifyTopicScenesMigration(connection);
        await connection.execute('INSERT INTO topic_migration_archive (migration_id, payload) VALUES (?, ?)',
            [TOPIC_SCENES_MIGRATION, JSON.stringify({ before: state, plan, preservation: before, addedContextIDs, convertedContextIDs })]);
        await connection.execute('INSERT INTO schema_migrations (migration_id) VALUES (?)', [TOPIC_SCENES_MIGRATION]);
        await connection.commit();
        return { applied: true, ...verified, addedContextIDs, convertedContextIDs, protectedDataUnchanged: true,
            languagePolicy: plan.languagePolicy };
    } catch (error) { await connection.rollback(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const apply = process.argv.includes('--apply'), check = process.argv.includes('--check'), rehearse = process.argv.includes('--rehearse');
    const database = process.env.BENCHPOLL_DB_NAME || 'benchmarks';
    if (check && (apply || rehearse)) throw new Error('Use --check separately');
    if (rehearse && !/^benchpoll_scenes_rehearsal_[a-z0-9_]+$/.test(database)) throw new Error('Rehearsal requires an isolated scene database');
    if (apply && !rehearse) await verifySlugBackup(process.argv.find(arg => arg.startsWith('--backup-manifest='))?.slice(18), database);
    const connection = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
        host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
        user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
        database, supportBigNumbers: true, bigNumberStrings: true });
    try {
        const [[lock]] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [TOPIC_SCENES_MIGRATION]);
        if (Number(lock.acquired) !== 1) throw new Error('Scene migration is already running');
        try {
            const result = check ? await verifyTopicScenesMigration(connection) : apply || rehearse ? await migrateTopicScenes(connection)
                : { dryRun: true, plan: planTopicScenes(await readTopicScenesMigrationState(connection)), backupRequired: true };
            console.log(JSON.stringify({ migration: TOPIC_SCENES_MIGRATION, database, ...result }, null, 2));
        } finally { await connection.query('SELECT RELEASE_LOCK(?)', [TOPIC_SCENES_MIGRATION]); }
    } finally { await connection.end(); }
}
