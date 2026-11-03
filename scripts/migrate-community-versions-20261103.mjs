import 'dotenv/config';
import mysql from 'mysql2/promise';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function inspectCommunityVersions(connection) {
    const [columns] = await connection.execute(`SELECT COLUMN_TYPE AS type, COLUMN_DEFAULT AS defaultValue,
        IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'personal_pie_weights' AND COLUMN_NAME = 'follow_community_version'`);
    const column = columns[0];
    if (column && (!/^tinyint(?:\(1\))?$/.test(column.type) || String(column.defaultValue) !== '0' || column.nullable !== 'NO')) {
        throw new Error('Unexpected follow_community_version definition');
    }
    return { missing: !column };
}

export async function migrateCommunityVersions(connection, { apply = false } = {}) {
    if (!apply) return { applied: false, ...await inspectCommunityVersions(connection) };
    const lock = 'benchpoll_community_versions_20261103';
    const [[row]] = await connection.execute('SELECT GET_LOCK(?, 30) AS acquired', [lock]);
    if (Number(row?.acquired) !== 1) throw new Error('Version choice migration is busy');
    try {
        const before = await inspectCommunityVersions(connection);
        // Additive only: all existing condition allocations remain explicit choices.
        if (before.missing) await connection.execute(`ALTER TABLE personal_pie_weights
            ADD COLUMN follow_community_version TINYINT(1) NOT NULL DEFAULT 0, ALGORITHM=INSTANT`);
        return { applied: true, changed: before.missing, ...await inspectCommunityVersions(connection) };
    } finally { await connection.execute('SELECT RELEASE_LOCK(?)', [lock]); }
}

async function main() {
    const password = process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD;
    if (password === undefined) throw new Error('Database credentials are unavailable');
    const connection = await mysql.createConnection({ host: process.env.BENCHPOLL_DB_HOST || 'localhost',
        port: Number(process.env.BENCHPOLL_DB_PORT || 3306), user: process.env.BENCHPOLL_DB_USER || 'root', password,
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', charset: 'utf8mb4' });
    try { console.log(JSON.stringify(await migrateCommunityVersions(connection, { apply: process.argv.includes('--apply') }))); }
    finally { await connection.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
