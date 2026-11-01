import 'dotenv/config';
import { createConnection } from 'mysql2/promise';
import { initPool, pool } from '../db.js';
import { installRankingCacheSchema, rankingCacheTriggers } from '../ranking-cache-schema.js';

if (!process.argv.includes('--apply')) {
    console.log(JSON.stringify({ dryRun: true, triggers: rankingCacheTriggers.length,
        changes: 'Add transactionally versioned ranking cache invalidation; no scores or weights are rewritten.' }));
} else {
    const admin = process.argv.includes('--admin-socket');
    if (admin && process.getuid?.() !== 0) throw new Error('Administrator socket migration must run as the local root user');
    if (!admin) initPool(process.env.DB_PASSWORD);
    const connection = admin ? await createConnection({
        user: 'root', socketPath: '/var/run/mysqld/mysqld.sock',
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks'
    }) : await pool.getConnection();
    try { console.log(JSON.stringify(await installRankingCacheSchema(connection))); }
    finally {
        if (admin) await connection.end();
        else { connection.release(); await pool.end(); }
    }
}
