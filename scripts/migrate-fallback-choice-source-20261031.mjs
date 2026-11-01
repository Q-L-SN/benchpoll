import 'dotenv/config';
import mysql from 'mysql2/promise';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function inspectFallbackChoiceSource(connection) {
    const [columns] = await connection.execute(`SELECT COLUMN_TYPE AS type, COLUMN_DEFAULT AS defaultValue,
        IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'personal_pie_score_rules' AND COLUMN_NAME = 'selection_source'`);
    const column = columns[0];
    if (column && (column.type !== "enum('selected','custom')" || column.defaultValue !== 'selected' || column.nullable !== 'NO')) {
        throw new Error('Unexpected fallback selection_source definition');
    }
    return { missing: !column };
}

export async function migrateFallbackChoiceSource(connection, { apply = false } = {}) {
    if (!apply) return { applied: false, ...await inspectFallbackChoiceSource(connection) };
    const lock = 'benchpoll_fallback_choice_source_20261031';
    const [[row]] = await connection.execute('SELECT GET_LOCK(?, 30) AS acquired', [lock]);
    if (Number(row?.acquired) !== 1) throw new Error('Fallback choice migration is busy');
    try {
        const before = await inspectFallbackChoiceSource(connection);
        if (before.missing) await connection.execute(`ALTER TABLE personal_pie_score_rules
            ADD COLUMN selection_source ENUM('selected','custom') NOT NULL DEFAULT 'selected', ALGORITHM=INSTANT`);
        return { applied: true, changed: before.missing, ...await inspectFallbackChoiceSource(connection) };
    } finally { await connection.execute('SELECT RELEASE_LOCK(?)', [lock]); }
}

async function main() {
    const password = process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD;
    if (password === undefined) throw new Error('Database credentials are unavailable');
    const connection = await mysql.createConnection({ host: process.env.BENCHPOLL_DB_HOST || 'localhost',
        port: Number(process.env.BENCHPOLL_DB_PORT || 3306), user: process.env.BENCHPOLL_DB_USER || 'root', password,
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', charset: 'utf8mb4', supportBigNumbers: true, bigNumberStrings: true });
    try { console.log(JSON.stringify(await migrateFallbackChoiceSource(connection, { apply: process.argv.includes('--apply') }))); }
    finally { await connection.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
