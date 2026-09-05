#!/usr/bin/env node

import 'dotenv/config';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const MIGRATION_ID = '007_category_tree_integrity';
const LOCK_NAME = 'benchpoll_category_tree_integrity_migration';
const CONSTRAINT_NAME = 'fk_categories_parent';

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

async function scalar(connection, sql, params = []) {
    const [rows] = await connection.execute(sql, params);
    return Number(Object.values(rows[0] ?? { value: 0 })[0]);
}

async function constraintExists(connection) {
    return await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM information_schema.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE()
          AND TABLE_NAME = 'categories'
          AND CONSTRAINT_NAME = ?`, [CONSTRAINT_NAME]) === 1;
}

async function assertTreeIntegrity(connection) {
    const rootCount = await scalar(connection, 'SELECT COUNT(*) AS count FROM categories WHERE parent_ID IS NULL');
    if (rootCount !== 1) throw new Error(`Expected exactly one root category; found ${rootCount}.`);

    const orphanCount = await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM categories AS child
        LEFT JOIN categories AS parent ON parent.ID = child.parent_ID
        WHERE child.parent_ID IS NOT NULL AND parent.ID IS NULL`);
    if (orphanCount !== 0) throw new Error(`${orphanCount} orphan categories exist.`);

    const cycleCount = await scalar(connection, `
        WITH RECURSIVE walk AS (
            SELECT ID, parent_ID, CAST(ID AS CHAR(4096)) AS visited, 0 AS cycle
            FROM categories
            UNION ALL
            SELECT walk.ID, parent.parent_ID,
                   CONCAT(walk.visited, ',', parent.ID),
                   FIND_IN_SET(parent.ID, walk.visited) > 0
            FROM walk
            JOIN categories AS parent ON parent.ID = walk.parent_ID
            WHERE walk.parent_ID IS NOT NULL AND walk.cycle = 0
        )
        SELECT COUNT(*) AS count FROM walk WHERE cycle = 1`);
    if (cycleCount !== 0) throw new Error(`${cycleCount} category cycles exist.`);
}

async function verifyPostconditions(connection) {
    await assertTreeIntegrity(connection);
    if (!await constraintExists(connection)) {
        throw new Error('Migration marker exists but the category parent foreign key is missing.');
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

    await assertTreeIntegrity(connection);
    if (!await constraintExists(connection)) {
        await connection.query(`
            ALTER TABLE categories
            ADD CONSTRAINT ${CONSTRAINT_NAME}
            FOREIGN KEY (parent_ID) REFERENCES categories (ID)
            ON DELETE RESTRICT ON UPDATE RESTRICT`);
    }
    await connection.execute('INSERT INTO schema_migrations (migration_id) VALUES (?)', [MIGRATION_ID]);
    return { applied: true, constraint: CONSTRAINT_NAME };
}

if (!APPLY) {
    console.log(JSON.stringify({
        migration: MIGRATION_ID,
        dryRun: true,
        changes: [`categories.${CONSTRAINT_NAME}`],
        behavior: 'requires exactly one root and rejects orphaned or cyclic category trees'
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
