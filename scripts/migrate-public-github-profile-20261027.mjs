import 'dotenv/config';
import mysql from 'mysql2/promise';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensurePublicGitHubProfileSchema } from '../user-profile-service.js';

export async function migratePublicGitHubProfile(connection, { apply = false } = {}) {
    if (!apply) {
        const [columns] = await connection.execute(`SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_public_profiles'`);
        const existing = new Set(columns.map(column => column.name));
        return { applied: false, missingColumns: ['github_username', 'show_github_profile'].filter(name => !existing.has(name)) };
    }
    const lock = 'benchpoll_public_github_profile_20261027';
    const [[row]] = await connection.execute('SELECT GET_LOCK(?, 30) AS acquired', [lock]);
    if (Number(row?.acquired) !== 1) throw new Error('Public GitHub profile migration is busy.');
    try { return { applied: true, ...await ensurePublicGitHubProfileSchema(connection) }; }
    finally { await connection.execute('SELECT RELEASE_LOCK(?)', [lock]); }
}

async function main() {
    const password = process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD;
    if (password === undefined) throw new Error('Database credentials are unavailable.');
    const connection = await mysql.createConnection({
        host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
        user: process.env.BENCHPOLL_DB_USER || 'root', password,
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', charset: 'utf8mb4',
        supportBigNumbers: true, bigNumberStrings: true
    });
    try { console.log(JSON.stringify(await migratePublicGitHubProfile(connection, { apply: process.argv.includes('--apply') }))); }
    finally { await connection.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
