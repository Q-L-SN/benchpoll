#!/usr/bin/env node

import crypto from 'node:crypto';
import 'dotenv/config';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const MIGRATION_ID = '008_canonical_ranking_context_hashes';
const LOCK_NAME = 'benchpoll_ranking_context_hash_migration';

function databaseConfig() {
    const password = process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD;
    if (password === undefined) throw new Error('Database credentials are unavailable.');
    return {
        host: process.env.BENCHPOLL_DB_HOST || 'localhost',
        port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
        user: process.env.BENCHPOLL_DB_USER || 'root',
        password,
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks',
        charset: 'utf8mb4'
    };
}

function canonicalContext(value, contextID) {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error(`Ranking context ${contextID} has invalid template values.`);
    }
    const canonical = Object.fromEntries(
        Object.keys(parsed).sort().map(key => [key, parsed[key]])
    );
    const serialized = JSON.stringify(canonical);
    return {
        serialized,
        templateHash: crypto.createHash('sha256').update(serialized).digest('hex')
    };
}

async function loadCanonicalRows(connection, lockRows = false) {
    const [rows] = await connection.query(`
        SELECT ID, category_ID, template_values, template_hash
        FROM ranking_contexts
        ORDER BY ID${lockRows ? ' FOR UPDATE' : ''}`);
    const canonicalRows = rows.map(row => ({
        ID: Number(row.ID),
        categoryID: Number(row.category_ID),
        currentHash: row.template_hash,
        ...canonicalContext(row.template_values, Number(row.ID))
    }));
    const identities = new Set();
    for (const row of canonicalRows) {
        const identity = `${row.categoryID}:${row.templateHash}`;
        if (identities.has(identity)) {
            throw new Error('Semantically duplicate ranking contexts exist; merge them before migration.');
        }
        identities.add(identity);
    }
    return canonicalRows;
}

async function verifyPostconditions(connection) {
    const rows = await loadCanonicalRows(connection);
    const mismatches = rows.filter(row => row.currentHash !== row.templateHash);
    if (mismatches.length > 0) {
        throw new Error(`${mismatches.length} ranking context hashes are not canonical.`);
    }
}

async function applyMigration(connection) {
    await connection.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            migration_id VARCHAR(128) NOT NULL,
            applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (migration_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    const [existing] = await connection.execute(
        'SELECT applied_at FROM schema_migrations WHERE migration_id = ?',
        [MIGRATION_ID]
    );
    if (existing.length > 0) {
        await verifyPostconditions(connection);
        return { applied: false, verified: true, alreadyAppliedAt: existing[0].applied_at };
    }

    await connection.beginTransaction();
    try {
        const rows = await loadCanonicalRows(connection, true);
        for (const row of rows) {
            const temporaryHash = crypto
                .createHash('sha256')
                .update(`${MIGRATION_ID}:${row.ID}`)
                .digest('hex');
            await connection.execute(
                'UPDATE ranking_contexts SET template_hash = ? WHERE ID = ?',
                [temporaryHash, row.ID]
            );
        }
        for (const row of rows) {
            await connection.execute(`
                UPDATE ranking_contexts
                SET template_values = ?, template_hash = ?
                WHERE ID = ?`, [row.serialized, row.templateHash, row.ID]);
        }
        await connection.execute('INSERT INTO schema_migrations (migration_id) VALUES (?)', [MIGRATION_ID]);
        await connection.commit();
        return { applied: true, contextsUpdated: rows.length };
    } catch (error) {
        await connection.rollback();
        throw error;
    }
}

if (!APPLY) {
    console.log(JSON.stringify({
        migration: MIGRATION_ID,
        dryRun: true,
        changes: ['canonical key ordering for ranking_contexts.template_values and template_hash'],
        behavior: 'fails instead of merging semantically duplicate contexts'
    }, null, 2));
    process.exit(0);
}

const connection = await mysql.createConnection(databaseConfig());
try {
    const [[lock]] = await connection.query('SELECT GET_LOCK(?, 20) AS acquired', [LOCK_NAME]);
    if (Number(lock.acquired) !== 1) throw new Error('Could not acquire the database migration lock.');
    try {
        console.log(JSON.stringify({ migration: MIGRATION_ID, ...await applyMigration(connection) }, null, 2));
    } finally {
        await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
    }
} finally {
    await connection.end();
}
