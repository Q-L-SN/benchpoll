import { EMPTY_TOPIC_CONTEXT_HASH } from '../../topic-scenes-service.js';
import { TOPIC_SCENES_MIGRATION, topicSceneCacheTriggers } from '../../scripts/migrate-topic-scenes-20261031.mjs';

export function sceneSchemaDatabase() {
    const tables = ['topic_scenes', 'personal_pie_topic_weights', 'topic_reference_lock', 'topic_proposals'];
    const definitions = {
        topic_scenes: { context_ID: 'bigint unsigned', category_ID: 'int unsigned', name: 'varchar(128)', slug: 'varchar(80)',
            description: 'varchar(180)', position: 'int unsigned', is_default: 'tinyint unsigned', is_active: 'tinyint unsigned',
            legacy_context_values: 'json', default_category_ID: 'int unsigned' },
        personal_pie_topic_weights: { pie_ID: 'bigint unsigned', target_context_ID: 'bigint unsigned', weight_basis_points: 'smallint unsigned' },
        topic_reference_lock: { ID: 'tinyint unsigned' },
        topic_proposals: { parent_topic_ID: 'int unsigned', scene_context_ID: 'bigint unsigned',
            scene_reservation_slug: 'varchar(80)', scene_reservation_name: 'varchar(128)', reservation_slug: 'varchar(80)', revision: 'int unsigned' }
    };
    const schema = {
        tables: tables.map(name => ({ name, engine: 'InnoDB' })),
        columns: Object.entries(definitions).flatMap(([tableName, columns]) => Object.entries(columns).map(([name, type]) => ({
            tableName, name, type, nullable: tableName === 'topic_proposals' || ['legacy_context_values', 'default_category_ID'].includes(name) ? 'YES' : 'NO',
            extra: name === 'default_category_ID' ? 'STORED GENERATED' : '',
            generation: name === 'default_category_ID' ? '(case when ((`is_default` = 1) and (`is_active` = 1)) then `category_ID` else NULL end)' : ''
        }))),
        indexes: [
            ['ranking_contexts', 'uq_ranking_context_identity', 'ID,category_ID'],
            ['topic_scenes', 'PRIMARY', 'context_ID'], ['topic_scenes', 'uq_topic_scene_slug', 'category_ID,slug'],
            ['topic_scenes', 'uq_topic_scene_name', 'category_ID,name'], ['topic_scenes', 'uq_topic_scene_default', 'default_category_ID'],
            ['personal_pie_topic_weights', 'PRIMARY', 'pie_ID,target_context_ID'], ['topic_reference_lock', 'PRIMARY', 'ID'],
            ['topic_proposals', 'uq_scene_proposal_context', 'scene_context_ID'],
            ['topic_proposals', 'uq_scene_proposal_slug', 'parent_topic_ID,scene_reservation_slug'],
            ['topic_proposals', 'uq_scene_proposal_name', 'parent_topic_ID,scene_reservation_name']
        ].map(([tableName, name, columnsList]) => ({ tableName, name, columnsList, nonUnique: 0 })),
        foreignKeys: [
            ['topic_scenes', 'fk_topic_scene_context', 'context_ID,category_ID', 'ranking_contexts', 'ID,category_ID', 'RESTRICT'],
            ['topic_scenes', 'fk_topic_scene_category', 'category_ID', 'categories', 'ID', 'RESTRICT'],
            ['personal_pie_topic_weights', 'fk_topic_weight_pie', 'pie_ID', 'personal_pies', 'ID', 'CASCADE'],
            ['personal_pie_topic_weights', 'fk_topic_weight_context', 'target_context_ID', 'ranking_contexts', 'ID', 'RESTRICT'],
            ['topic_proposals', 'fk_scene_proposal_category', 'parent_topic_ID', 'categories', 'ID', 'RESTRICT'],
            ['topic_proposals', 'fk_scene_proposal_context', 'scene_context_ID,parent_topic_ID', 'ranking_contexts', 'ID,category_ID', 'RESTRICT']
        ].flatMap(([tableName, name, columns, referencedTable, targets, deleteRule]) => columns.split(',').map((columnName, index) => ({
            tableName, name, columnName, position: index + 1, referencedTable,
            referencedColumn: targets.split(',')[index], deleteRule, updateRule: 'NO ACTION'
        }))),
        checks: [
            ['topic_scenes', 'ck_topic_scene_active', '((is_active in (0, 1)) and (is_default in (0, 1)) and ((is_default = 0) or (is_active = 1)))'],
            ['personal_pie_topic_weights', 'ck_topic_weight_basis_points', '(weight_basis_points between 100 and 10000)'],
            ['topic_reference_lock', 'ck_topic_reference_singleton', '(ID = 1)'],
            ['topic_proposals', 'ck_scene_proposal_identity', `(parent_topic_ID is null and scene_context_ID is null and scene_reservation_slug is null and scene_reservation_name is null)
                or (parent_topic_ID is not null and topic_ID is null and reservation_slug is null and reservation_name is null)`],
            ['topic_proposals', 'ck_topic_proposal_state', `(status = _utf8mb4'open' and moderation_log_ID is null and topic_ID is null and scene_context_ID is null and promoted_at is null and decided_at is null)
                or (status = _utf8mb4'pending' and moderation_log_ID is not null and topic_ID is null and scene_context_ID is null and promoted_at is not null and decided_at is null)
                or (status = _utf8mb4'approved' and moderation_log_ID is not null and promoted_at is not null and decided_at is not null
                    and ((parent_topic_ID is null and topic_ID is not null and scene_context_ID is null)
                        or (parent_topic_ID is not null and topic_ID is null and scene_context_ID is not null)))
                or (status = _utf8mb4'rejected' and moderation_log_ID is not null and topic_ID is null and scene_context_ID is null and promoted_at is not null and decided_at is not null)`]
        ].map(([tableName, name, clause]) => ({ tableName, name, clause, enforced: 'YES' })),
        triggers: topicSceneCacheTriggers().map(row => ({ ...row, tableName: row.table, timing: 'AFTER' })),
        invalidWeights: [], marker: true, cache: true, graph: true
    };
    const calls = [];
    let loseDDLAcknowledgement = false;
    async function execute(sql, args = []) {
        const statement = sql.replace(/\s+/g, ' ').trim();
        calls.push({ sql: statement, args });
        if (statement.includes('FROM information_schema.COLUMNS')) {
            if (statement.includes("COLUMN_NAME = 'ID'")) return [[{ type: args[0] === 'categories' ? 'int unsigned' : 'bigint unsigned' }]];
            if (statement.includes('COLUMN_NAME AS name FROM')) return [schema.columns.filter(row => row.tableName === args[0])];
            return [schema.columns];
        }
        if (statement.includes('FROM information_schema.TABLES')) return [schema.tables];
        if (statement.includes('FROM information_schema.STATISTICS')) return [statement.includes("INDEX_NAME = 'uq_ranking_context_identity'")
            ? schema.indexes.filter(row => row.name === 'uq_ranking_context_identity') : schema.indexes];
        if (statement.includes('JOIN information_schema.CHECK_CONSTRAINTS')) return [schema.checks];
        if (statement.includes('FROM information_schema.TABLE_CONSTRAINTS')) {
            const constraints = [
                ...schema.checks.map(row => ({ ...row, type: 'CHECK' })),
                ...schema.foreignKeys.map(row => ({ ...row, type: 'FOREIGN KEY' })),
                ...schema.indexes.map(row => ({ ...row, type: row.name === 'PRIMARY' ? 'PRIMARY KEY' : 'UNIQUE' }))
            ];
            return [statement.includes("TABLE_NAME = 'topic_proposals'") ? constraints.filter(row => row.tableName === 'topic_proposals') : constraints];
        }
        if (statement.includes('FROM information_schema.KEY_COLUMN_USAGE')) return [schema.foreignKeys];
        if (statement.includes('FROM information_schema.TRIGGERS')) return [schema.triggers];
        if (statement.startsWith('CREATE TABLE IF NOT EXISTS')) return [{}];
        if (statement.startsWith('ALTER TABLE personal_pie_topic_weights')) {
            const row = schema.checks.find(row => row.name === 'ck_topic_weight_basis_points');
            if (row) Object.assign(row, { clause: 'weight_basis_points BETWEEN 100 AND 10000', enforced: 'YES' });
            else schema.checks.push({ tableName: 'personal_pie_topic_weights', name: 'ck_topic_weight_basis_points',
                clause: 'weight_basis_points BETWEEN 100 AND 10000', enforced: 'YES' });
            if (loseDDLAcknowledgement) { loseDDLAcknowledgement = false; throw new Error('ddl_ack_lost'); }
            return [{}];
        }
        if (statement.startsWith('SELECT pie_ID, target_context_ID, weight_basis_points')) return [schema.invalidWeights];
        if (statement.startsWith('INSERT IGNORE INTO topic_reference_lock')) { schema.graph = true; return [{ affectedRows: 0 }]; }
        if (statement.startsWith('SELECT ID FROM topic_reference_lock')) return [schema.graph ? [{ ID: 1 }] : []];
        if (statement.startsWith('SELECT ID FROM ranking_cache_revisions')) return [schema.cache ? [{ ID: 2 }] : []];
        if (statement.startsWith('SELECT migration_id FROM schema_migrations')) return [schema.marker ? [{ migration_id: TOPIC_SCENES_MIGRATION }] : []];
        if (statement.startsWith('SELECT c.ID FROM categories c LEFT JOIN topic_scenes')) return [[]];
        if (statement.startsWith('SELECT s.*, rc.context_values')) return [[]];
        if (statement.startsWith('SELECT d.ID FROM ranking_dimensions')) return [[]];
        if (statement.startsWith('SELECT rc.ID FROM ranking_contexts rc')) {
            if (!statement.includes(EMPTY_TOPIC_CONTEXT_HASH)) throw new Error('Expected root hash exclusion');
            return [schema.orphanContexts ?? []];
        }
        throw new Error('Unexpected schema fixture SQL: ' + statement);
    }
    const db = { execute, query: execute,
        async beginTransaction() { calls.push({ sql: 'BEGIN' }); },
        async commit() { calls.push({ sql: 'COMMIT' }); },
        async rollback() { calls.push({ sql: 'ROLLBACK' }); } };
    return { db, schema, calls, loseNextDDLAcknowledgement() { loseDDLAcknowledgement = true; } };
}
