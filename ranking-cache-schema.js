export const RANKING_DATA_TABLES = ['benchmark_results', 'benchmark_conditions', 'benchmarks', 'models',
    'organizations', 'score_fields', 'score_field_options'];
export const RANKING_CATALOGUE_TABLES = ['personal_pie_weights', 'personal_pie_score_rules',
    'benchmark_families', 'benchmark_family_members', 'personal_pies', 'users', 'ranking_contexts', 'categories'];
export const rankingCacheTriggers = [...RANKING_DATA_TABLES.map(table => [table, 'data_revision']),
    ...RANKING_CATALOGUE_TABLES.map(table => [table, 'catalogue_revision'])].flatMap(([table, column]) =>
    ['INSERT', 'UPDATE', 'DELETE'].map(event => ({
        table, event,
        name: `bp_rank_${table}_${event.toLowerCase()}`,
        sql: `CREATE TRIGGER bp_rank_${table}_${event.toLowerCase()} AFTER ${event} ON ${table}
            FOR EACH ROW UPDATE ranking_cache_revisions SET ${column} = ${column} + 1 WHERE ID = ${column === 'data_revision' ? 1 : 2}`
    })));

export async function installRankingCacheSchema(connection) {
    const [[lock]] = await connection.query("SELECT GET_LOCK('benchpoll-ranking-cache-schema', 20) AS acquired");
    if (!Number(lock.acquired)) throw new Error('Ranking cache schema is already being changed');
    try {
        await connection.query(`CREATE TABLE IF NOT EXISTS ranking_cache_revisions (
            ID tinyint unsigned NOT NULL PRIMARY KEY,
            epoch char(36) NOT NULL,
            data_revision bigint unsigned NOT NULL DEFAULT 0,
            catalogue_revision bigint unsigned NOT NULL DEFAULT 0,
            ready boolean NOT NULL DEFAULT 0
        ) ENGINE=InnoDB`);
        await connection.query('INSERT IGNORE INTO ranking_cache_revisions (ID, epoch) VALUES (1, UUID()), (2, UUID())');
        await connection.query('UPDATE ranking_cache_revisions SET ready = 0, epoch = UUID() WHERE ID IN (1, 2)');
        const [installed] = await connection.query('SHOW TRIGGERS');
        const byName = new Map(installed.map(row => [row.Trigger, row]));
        for (const trigger of rankingCacheTriggers) {
            const existing = byName.get(trigger.name);
            if (existing) {
                const statement = trigger.sql.split('FOR EACH ROW ')[1].replace(/\s+/g, ' ').trim();
                if (existing.Table !== trigger.table || existing.Timing !== 'AFTER' || existing.Event !== trigger.event
                    || existing.Statement.replace(/\s+/g, ' ').trim() !== statement) {
                    throw new Error(`Unexpected existing ranking trigger: ${trigger.name}`);
                }
            } else await connection.query(trigger.sql);
        }
        await connection.query('UPDATE ranking_cache_revisions SET ready = 1 WHERE ID IN (1, 2)');
        return { triggers: rankingCacheTriggers.length, businessRowsChanged: 0 };
    } finally { await connection.query("SELECT RELEASE_LOCK('benchpoll-ranking-cache-schema')"); }
}
