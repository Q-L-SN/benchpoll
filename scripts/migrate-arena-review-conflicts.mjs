import 'dotenv/config';
import mysql from 'mysql2/promise';
import { initializeArenaConflictSchema } from '../arena-sync-conflicts.js';

const apply = process.argv.includes('--apply');
if (apply && !process.argv.includes('--backup-confirmed')) throw new Error('Back up and verify the database before applying');
const database = process.env.BENCHPOLL_DB_NAME || 'benchmarks';
if (!/^[a-zA-Z0-9_]+$/.test(database)) throw new Error('Invalid database name');
const connection = await mysql.createConnection({
    socketPath: process.env.BENCHPOLL_DB_SOCKET || '/var/run/mysqld/mysqld.sock',
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database, charset: 'utf8mb4', timezone: 'Z'
});
let locked = false;
try {
    const [tables] = await connection.query("SHOW TABLES LIKE 'arena_sync_conflicts'");
    if (apply) {
        const [[{ acquired }]] = await connection.query("SELECT GET_LOCK('benchpoll_arena_latest_import',30) acquired");
        if (Number(acquired) !== 1) throw new Error('Arena schema lock unavailable');
        locked = true;
        await initializeArenaConflictSchema(connection);
        if (process.argv.includes('--grant-worker')) {
            const [users] = await connection.query("SELECT User FROM mysql.user WHERE User='benchpoll_sync' AND Host='localhost'");
            if (users.length !== 1) throw new Error('The restricted score-sync account must be installed first');
            await connection.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON \`${database}\`.arena_sync_conflicts TO 'benchpoll_sync'@'localhost'`);
        }
    }
    console.log(JSON.stringify({ apply, database, queueExisted: tables.length === 1, scoreDataChanged: false,
        workerGrantApplied: apply && process.argv.includes('--grant-worker') }));
} finally {
    try { if (locked) await connection.query("SELECT RELEASE_LOCK('benchpoll_arena_latest_import')"); }
    finally { await connection.end(); }
}
