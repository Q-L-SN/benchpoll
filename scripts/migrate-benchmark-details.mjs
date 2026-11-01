import 'dotenv/config';
import mysql from 'mysql2/promise';
import { initializeScoreSyncSchema } from '../score-sync-service.js';
import { initializeArenaSyncSchema } from '../arena-sync.js';

const apply = process.argv.includes('--apply');
if (apply && !process.argv.includes('--backup-confirmed')) throw new Error('Back up and verify the database before applying');
const connection = await mysql.createConnection({
    socketPath: process.env.BENCHPOLL_DB_SOCKET || '/var/run/mysqld/mysqld.sock',
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', charset: 'utf8mb4', timezone: 'Z'
});
try {
    const [existing] = await connection.query('SHOW COLUMNS FROM benchmarks');
    const columns = new Set(existing.map(column => column.Field));
    const additions = [
        ['description', 'TEXT NULL'],
        ['request_official_sync', 'BOOLEAN NOT NULL DEFAULT FALSE'],
        ['official_sync_url', 'VARCHAR(2048) NULL'],
        ['official_sync_instructions', 'TEXT NULL'],
        ['scores_updated_at', 'DATETIME(3) NULL']
    ].filter(([name]) => !columns.has(name));
    console.log(JSON.stringify({ apply, additions }));
    if (!apply) process.exitCode = 0;
    else {
        for (const [name, definition] of additions) await connection.query(`ALTER TABLE benchmarks ADD COLUMN ${name} ${definition}`);
        await initializeScoreSyncSchema(connection);
        await initializeArenaSyncSchema(connection);
        await connection.query(`UPDATE benchmarks b SET request_official_sync=TRUE,
            official_sync_url='https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset'
            WHERE EXISTS (SELECT 1 FROM benchmark_conditions c WHERE c.benchmark_ID=b.ID AND c.score_source='arena_official')`);
        await connection.query(`UPDATE benchmarks b JOIN (
            SELECT r.benchmark_ID, MAX(r.accepted_at) AS last_score_at FROM benchmark_results r
        LEFT JOIN moderation_logs m ON m.ID=r.moderation_log_ID
            WHERE COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.content,'$.type')),'') <> 'entity_change'
            GROUP BY r.benchmark_ID
        ) scores ON scores.benchmark_ID=b.ID SET b.scores_updated_at=scores.last_score_at WHERE b.scores_updated_at IS NULL`);
        console.log(JSON.stringify({ applied: true }));
    }
} finally { await connection.end(); }
