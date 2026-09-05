#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const MIGRATION_ID = '019_literal_default_conditions';
const PREVIOUS_MIGRATION_ID = '018_arena_score_ranges';
const LOCK_NAME = 'benchpoll_literal_default_conditions_migration';

function readLocalCredentials() {
    const credentialPath = path.resolve('db-credentials.local.md');
    if (!fs.existsSync(credentialPath)) return null;
    const content = fs.readFileSync(credentialPath, 'utf8');
    const readValue = key => content
        .match(new RegExp(`^${key}\\s*[:=]\\s*[\\x60"]?(.+?)[\\x60"]?\\s*$`, 'mi'))?.[1]
        ?.trim();
    return {
        host: readValue('host') || 'localhost',
        port: Number(readValue('port') || 3306),
        user: readValue('user'),
        password: readValue('password'),
        database: readValue('database') || 'benchmarks'
    };
}

function databaseConfig() {
    const password = process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD;
    const local = password === undefined ? readLocalCredentials() : null;
    const config = local ?? {
        host: process.env.BENCHPOLL_DB_HOST || 'localhost',
        port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
        user: process.env.BENCHPOLL_DB_USER || 'root',
        password,
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks'
    };
    if (!config?.user || config.password === undefined || !Number.isInteger(config.port)) {
        throw new Error('Database credentials are unavailable or incomplete.');
    }
    return { ...config, charset: 'utf8mb4' };
}

async function mismatchCounts(connection) {
    const [[benchmarkRow]] = await connection.query(`
        SELECT COUNT(*) AS count
        FROM benchmark_conditions
        WHERE is_active = 1
          AND is_default <> (LOWER(TRIM(name)) = 'default')`);
    const [[modelRow]] = await connection.query(`
        SELECT COUNT(*) AS count
        FROM model_conditions
        WHERE is_active = 1
          AND is_default <> (LOWER(TRIM(name)) = 'default')`);
    const [[keyRow]] = await connection.query(`
        SELECT
            (SELECT COUNT(*) FROM benchmark_conditions
             WHERE is_active = 1
               AND (condition_key = 'default') <> (LOWER(TRIM(name)) = 'default')) +
            (SELECT COUNT(*) FROM model_conditions
             WHERE is_active = 1
               AND (condition_key = 'default') <> (LOWER(TRIM(name)) = 'default')) AS count`);
    return {
        benchmarkFlagMismatches: Number(benchmarkRow.count),
        modelFlagMismatches: Number(modelRow.count),
        keyMismatches: Number(keyRow.count)
    };
}

async function verifyPostconditions(connection) {
    const report = await mismatchCounts(connection);
    if (report.benchmarkFlagMismatches !== 0
        || report.modelFlagMismatches !== 0
        || report.keyMismatches !== 0) {
        throw new Error(`Literal default-condition invariant failed: ${JSON.stringify(report)}`);
    }
    return report;
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
        return {
            applied: false,
            alreadyAppliedAt: existing[0].applied_at,
            ...(await verifyPostconditions(connection))
        };
    }
    const [previous] = await connection.execute(
        'SELECT 1 FROM schema_migrations WHERE migration_id = ? LIMIT 1',
        [PREVIOUS_MIGRATION_ID]
    );
    if (previous.length !== 1) {
        throw new Error(`Apply ${PREVIOUS_MIGRATION_ID} before ${MIGRATION_ID}.`);
    }

    const before = await mismatchCounts(connection);
    if (before.keyMismatches !== 0) {
        throw new Error(`Condition keys require manual repair before this migration: ${before.keyMismatches}`);
    }

    await connection.beginTransaction();
    try {
        const [benchmarkResult] = await connection.query(`
            UPDATE benchmark_conditions
            SET is_default = (LOWER(TRIM(name)) = 'default'),
                updated_at = CURRENT_TIMESTAMP
            WHERE is_default <> (LOWER(TRIM(name)) = 'default')`);
        const [modelResult] = await connection.query(`
            UPDATE model_conditions
            SET is_default = (LOWER(TRIM(name)) = 'default'),
                updated_at = CURRENT_TIMESTAMP
            WHERE is_default <> (LOWER(TRIM(name)) = 'default')`);
        const report = await verifyPostconditions(connection);
        await connection.execute(
            'INSERT INTO schema_migrations (migration_id) VALUES (?)',
            [MIGRATION_ID]
        );
        await connection.commit();
        return {
            applied: true,
            updatedBenchmarkConditions: Number(benchmarkResult.affectedRows),
            updatedModelConditions: Number(modelResult.affectedRows),
            ...report
        };
    } catch (error) {
        await connection.rollback();
        throw error;
    }
}

const connection = await mysql.createConnection(databaseConfig());
try {
    if (!APPLY) {
        console.log(JSON.stringify({
            migration: MIGRATION_ID,
            dryRun: true,
            ...(await mismatchCounts(connection))
        }, null, 2));
    } else {
        const [[lock]] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [LOCK_NAME]);
        if (Number(lock.acquired) !== 1) {
            throw new Error('Could not acquire the database migration lock.');
        }
        try {
            console.log(JSON.stringify({
                migration: MIGRATION_ID,
                ...(await applyMigration(connection))
            }, null, 2));
        } finally {
            await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
        }
    }
} finally {
    await connection.end();
}
