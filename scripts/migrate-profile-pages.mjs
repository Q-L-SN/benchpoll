import mysql from 'mysql2/promise';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureProfilePagesSchema, backfillProfileIDs } from '../profile-schema.js';

export async function migrateProfilePages(connection, { apply = false } = {}) {
    if (!apply) {
        const [columns] = await connection.execute(`SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_public_profiles'`);
        const existing = new Set(columns.map(column => column.name));
        return { applied: false, missingColumns: ['public_id', 'bio', 'publish_favorites', 'publish_configured_topics'].filter(name => !existing.has(name)),
            bootstrapOrdering: 'Existing users: ascending stored user ID. New users: registration order, skipping occupied IDs.' };
    }
    const lock = 'benchpoll_profile_pages';
    const [[row]] = await connection.execute('SELECT GET_LOCK(?, 30) AS acquired', [lock]);
    if (Number(row?.acquired) !== 1) throw new Error('Profile pages migration is busy.');
    try {
        const schema = await ensureProfilePagesSchema(connection);
        await connection.beginTransaction();
        try {
            const backfill = await backfillProfileIDs(connection);
            await connection.commit();
            return { applied: true, ...schema, ...backfill };
        } catch (error) { await connection.rollback(); throw error; }
    } finally { await connection.execute('SELECT RELEASE_LOCK(?)', [lock]); }
}

async function main() {
    if (!process.env.BENCHPOLL_DB_NAME || process.env.BENCHPOLL_DB_PASSWORD === undefined) {
        throw new Error('Provide explicit BENCHPOLL_DB_NAME and BENCHPOLL_DB_PASSWORD for the intended database.');
    }
    const connection = await mysql.createConnection({ host: process.env.BENCHPOLL_DB_HOST || 'localhost',
        port: Number(process.env.BENCHPOLL_DB_PORT || 3306), user: process.env.BENCHPOLL_DB_USER || 'root',
        password: process.env.BENCHPOLL_DB_PASSWORD, database: process.env.BENCHPOLL_DB_NAME,
        charset: 'utf8mb4', supportBigNumbers: true, bigNumberStrings: true });
    try { console.log(JSON.stringify(await migrateProfilePages(connection, { apply: process.argv.includes('--apply') }))); }
    finally { await connection.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
