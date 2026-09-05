#!/usr/bin/env node

import 'dotenv/config';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const MIGRATION_ID = '006_category_integrity';
const LOCK_NAME = 'benchpoll_category_integrity_migration';
const INDEX_NAME = 'uq_categories_parent_name';

function databaseConfig() {
    const password = process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD;
    if (password === undefined) {
        throw new Error('Database credentials are unavailable.');
    }
    return {
        host: process.env.BENCHPOLL_DB_HOST || 'localhost',
        port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
        user: process.env.BENCHPOLL_DB_USER || 'root',
        password,
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks',
        charset: 'utf8mb4'
    };
}

async function indexExists(connection) {
    const [rows] = await connection.execute(`
        SELECT 1
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'categories'
          AND INDEX_NAME = ?
        LIMIT 1`, [INDEX_NAME]);
    return rows.length > 0;
}

async function assertNoDuplicateSiblings(connection) {
    const [rows] = await connection.query(`
        SELECT parent_ID, name, COUNT(*) AS duplicate_count
        FROM categories
        WHERE parent_ID IS NOT NULL
        GROUP BY parent_ID, name
        HAVING COUNT(*) > 1
        LIMIT 1`);
    if (rows.length > 0) {
        throw new Error('Duplicate sibling categories exist; resolve them before applying this migration.');
    }
}

async function verifyPostconditions(connection) {
    if (!await indexExists(connection)) {
        throw new Error('Migration marker exists but the category sibling unique index is missing.');
    }
    await assertNoDuplicateSiblings(connection);
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

    await assertNoDuplicateSiblings(connection);
    if (!await indexExists(connection)) {
        await connection.query(`
            ALTER TABLE categories
            ADD UNIQUE KEY ${INDEX_NAME} (parent_ID, name)`);
    }
    await connection.execute('INSERT INTO schema_migrations (migration_id) VALUES (?)', [MIGRATION_ID]);
    return { applied: true, index: INDEX_NAME };
}

if (!APPLY) {
    console.log(JSON.stringify({
        migration: MIGRATION_ID,
        dryRun: true,
        changes: [`categories.${INDEX_NAME} (parent_ID, name)`],
        behavior: 'fails when duplicate sibling categories already exist'
    }, null, 2));
    process.exit(0);
}

const connection = await mysql.createConnection(databaseConfig());
try {
    const [[lock]] = await connection.query('SELECT GET_LOCK(?, 20) AS acquired', [LOCK_NAME]);
    if (Number(lock.acquired) !== 1) {
        throw new Error('Could not acquire the database migration lock.');
    }
    try {
        console.log(JSON.stringify({ migration: MIGRATION_ID, ...await applyMigration(connection) }, null, 2));
    } finally {
        await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
    }
} finally {
    await connection.end();
}
