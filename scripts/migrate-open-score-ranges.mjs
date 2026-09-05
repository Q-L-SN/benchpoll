#!/usr/bin/env node

import 'dotenv/config';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const MIGRATION_ID = '016_open_score_ranges';
const LOCK_NAME = 'benchpoll_open_score_ranges_migration';

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

async function tableExists(connection, tableName) {
    const [rows] = await connection.execute(`
        SELECT 1
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        LIMIT 1`, [tableName]);
    return rows.length === 1;
}

async function checkConstraintExists(connection, tableName, constraintName) {
    const [rows] = await connection.execute(`
        SELECT 1
        FROM information_schema.TABLE_CONSTRAINTS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND CONSTRAINT_NAME = ?
          AND CONSTRAINT_TYPE = 'CHECK'
        LIMIT 1`, [tableName, constraintName]);
    return rows.length === 1;
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
        return { applied: false, alreadyAppliedAt: existing[0].applied_at };
    }
    if (!await tableExists(connection, 'benchmark_conditions')) {
        throw new Error('Required table is missing: benchmark_conditions');
    }

    const constraintName = 'chk_benchmark_conditions_range';
    if (await checkConstraintExists(connection, 'benchmark_conditions', constraintName)) {
        await connection.query(
            `ALTER TABLE benchmark_conditions DROP CHECK ${constraintName}`
        );
    }
    await connection.query(`
        ALTER TABLE benchmark_conditions
        ADD CONSTRAINT ${constraintName} CHECK (
            (uses_percentage_scale = 1 AND score_min IS NULL AND score_max IS NULL)
            OR
            (uses_percentage_scale = 0 AND (
                (score_min IS NULL AND score_max IS NULL)
                OR (score_min IS NULL AND score_max IS NOT NULL)
                OR (score_min IS NOT NULL AND score_max IS NULL)
                OR (score_min IS NOT NULL AND score_max IS NOT NULL AND score_max > score_min)
            ))
        )`);

    const [[invalid]] = await connection.query(`
        SELECT COUNT(*) AS count
        FROM benchmark_conditions
        WHERE (uses_percentage_scale = 1
               AND (score_min IS NOT NULL OR score_max IS NOT NULL))
           OR (uses_percentage_scale = 0
               AND score_min IS NOT NULL AND score_max IS NOT NULL
               AND score_max <= score_min)`);
    if (Number(invalid.count) !== 0) {
        throw new Error(`Open score range invariant failed for ${invalid.count} rows.`);
    }
    await connection.execute(
        'INSERT INTO schema_migrations (migration_id) VALUES (?)',
        [MIGRATION_ID]
    );
    return { applied: true };
}

if (!APPLY) {
    console.log(JSON.stringify({
        migration: MIGRATION_ID,
        dryRun: true,
        allows: [
            'custom score ranges with only a lower bound',
            'custom score ranges with only an upper bound',
            'custom score ranges with both bounds or neither bound'
        ],
        supersededBy: '017_required_score_ranges'
    }, null, 2));
    process.exit(0);
}

const connection = await mysql.createConnection(databaseConfig());
try {
    const [[lock]] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [LOCK_NAME]);
    if (Number(lock.acquired) !== 1) {
        throw new Error('Could not acquire the database migration lock.');
    }
    try {
        const result = await applyMigration(connection);
        console.log(JSON.stringify({ migration: MIGRATION_ID, ...result }, null, 2));
    } finally {
        await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
    }
} finally {
    await connection.end();
}
