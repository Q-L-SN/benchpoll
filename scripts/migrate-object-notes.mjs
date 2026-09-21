import 'dotenv/config';
import mysql from 'mysql2/promise';

const apply = process.argv.includes('--apply');
const connection = await mysql.createConnection({
    host: process.env.BENCHPOLL_DB_HOST || 'localhost',
    port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
    user: process.env.BENCHPOLL_DB_USER || 'root',
    password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', charset: 'utf8mb4'
});
const tables = ['benchmarks', 'models', 'benchmark_results', 'categories', 'ranking_dimensions'];
try {
    const [[lock]] = await connection.execute("SELECT GET_LOCK('benchpoll_object_notes', 10) AS acquired");
    if (Number(lock.acquired) !== 1) throw Error('Migration is already running');
    const pending = [];
    for (const table of tables) {
        const [columns] = await connection.execute(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table]);
        if (!columns.length) throw Error(`Missing table: ${table}`);
        if (!columns.some(column => column.COLUMN_NAME === 'notes')) pending.push(table);
    }
    const [[merges]] = await connection.execute(`SELECT COUNT(*) AS count FROM moderation_logs
        WHERE status = 'pending' AND JSON_UNQUOTE(JSON_EXTRACT(content, '$.operation')) = 'merge'`);
    if (Number(merges.count)) throw Error('Pending structured merges require manual review before deployment');
    if (apply) {
        // Old review-only comments remain in the audit history, not in public object data.
        for (const table of pending) await connection.query(`ALTER TABLE ${mysql.escapeId(table)} ADD COLUMN notes TEXT NULL`);
        await connection.execute(`INSERT INTO schema_migrations (migration_id)
            SELECT '027_object_notes' WHERE NOT EXISTS
            (SELECT 1 FROM schema_migrations WHERE migration_id = '027_object_notes')`);
    }
    console.log(JSON.stringify({ applied: apply, tables, added: apply ? pending : [], pending: apply ? [] : pending }));
} catch (error) {
    console.error(error.code || error.message);
    process.exitCode = 1;
} finally {
    await connection.execute("SELECT RELEASE_LOCK('benchpoll_object_notes')");
    await connection.end();
}
