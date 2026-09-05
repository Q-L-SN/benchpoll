#!/usr/bin/env node

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const MIGRATION_ID = '017_required_score_ranges';
const PREVIOUS_MIGRATION_ID = '016_open_score_ranges';
const LOCK_NAME = 'benchpoll_required_score_ranges_migration';

function readLocalCredentials() {
    const credentialPath = path.resolve('db-credentials.local.md');
    if (!fs.existsSync(credentialPath)) {
        return null;
    }
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

async function checkConstraintExists(connection, constraintName) {
    const [rows] = await connection.execute(`
        SELECT 1
        FROM information_schema.TABLE_CONSTRAINTS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'benchmark_conditions'
          AND CONSTRAINT_NAME = ?
          AND CONSTRAINT_TYPE = 'CHECK'
        LIMIT 1`, [constraintName]);
    return rows.length === 1;
}

async function preflight(connection) {
    const [[conditions]] = await connection.query(`
        SELECT
            SUM(uses_percentage_scale = 1
                AND (score_min IS NOT NULL OR score_max IS NOT NULL)) AS invalid_percentage,
            SUM(uses_percentage_scale = 0
                AND (score_min IS NULL OR score_max IS NULL OR score_max <= score_min)) AS invalid_custom
        FROM benchmark_conditions`);
    const [[results]] = await connection.query(`
        SELECT COUNT(*) AS invalid_percentage_results
        FROM benchmark_results
        JOIN benchmark_conditions
          ON benchmark_conditions.ID = benchmark_results.benchmark_condition_ID
        WHERE benchmark_results.status = 'accepted'
          AND benchmark_conditions.uses_percentage_scale = 1
          AND (benchmark_results.raw_score < 0 OR benchmark_results.raw_score > 100)`);
    return {
        invalidPercentageConditions: Number(conditions.invalid_percentage ?? 0),
        invalidCustomConditions: Number(conditions.invalid_custom ?? 0),
        invalidPercentageResults: Number(results.invalid_percentage_results ?? 0)
    };
}

async function repairArenaConditions(connection) {
    const [result] = await connection.execute(`
        UPDATE benchmark_conditions
        JOIN benchmarks ON benchmarks.ID = benchmark_conditions.benchmark_ID
        JOIN benchmark_tag_links
          ON benchmark_tag_links.benchmark_ID = benchmarks.ID
        JOIN benchmark_tags ON benchmark_tags.ID = benchmark_tag_links.tag_ID
        SET benchmark_conditions.score_min = -500,
            benchmark_conditions.score_max = 1500,
            benchmark_conditions.updated_at = CURRENT_TIMESTAMP
        WHERE benchmark_conditions.uses_percentage_scale = 0
          AND (benchmark_conditions.score_min IS NULL
               OR benchmark_conditions.score_max IS NULL)
          AND benchmark_tags.is_active = 1
          AND LOWER(benchmark_tags.name) = 'arena'`);
    return Number(result.affectedRows);
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
    const [previous] = await connection.execute(
        'SELECT 1 FROM schema_migrations WHERE migration_id = ? LIMIT 1',
        [PREVIOUS_MIGRATION_ID]
    );
    if (previous.length !== 1) {
        throw new Error(`Apply ${PREVIOUS_MIGRATION_ID} before ${MIGRATION_ID}.`);
    }
    await connection.beginTransaction();
    let repairedArenaConditions;
    let report;
    try {
        repairedArenaConditions = await repairArenaConditions(connection);
        report = await preflight(connection);
        if (Object.values(report).some(count => count !== 0)) {
            throw new Error(`Score-range migration preflight failed: ${JSON.stringify(report)}`);
        }
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    }

    const constraintName = 'chk_benchmark_conditions_range';
    if (await checkConstraintExists(connection, constraintName)) {
        await connection.query(`ALTER TABLE benchmark_conditions DROP CHECK ${constraintName}`);
    }
    await connection.query(`
        ALTER TABLE benchmark_conditions
        ADD CONSTRAINT ${constraintName} CHECK (
            (uses_percentage_scale = 1 AND score_min IS NULL AND score_max IS NULL)
            OR
            (uses_percentage_scale = 0
                AND score_min IS NOT NULL
                AND score_max IS NOT NULL
                AND score_max > score_min)
        )`);
    await connection.execute(
        'INSERT INTO schema_migrations (migration_id) VALUES (?)',
        [MIGRATION_ID]
    );
    return { applied: true, repairedArenaConditions, ...report };
}

const connection = await mysql.createConnection(databaseConfig());
try {
    if (!APPLY) {
        const [[arenaRepair]] = await connection.query(`
            SELECT COUNT(DISTINCT benchmark_conditions.ID) AS count
            FROM benchmark_conditions
            JOIN benchmarks ON benchmarks.ID = benchmark_conditions.benchmark_ID
            JOIN benchmark_tag_links
              ON benchmark_tag_links.benchmark_ID = benchmarks.ID
            JOIN benchmark_tags ON benchmark_tags.ID = benchmark_tag_links.tag_ID
            WHERE benchmark_conditions.uses_percentage_scale = 0
              AND (benchmark_conditions.score_min IS NULL
                   OR benchmark_conditions.score_max IS NULL)
              AND benchmark_tags.is_active = 1
              AND LOWER(benchmark_tags.name) = 'arena'`);
        console.log(JSON.stringify({
            migration: MIGRATION_ID,
            dryRun: true,
            repairableArenaConditions: Number(arenaRepair.count),
            ...(await preflight(connection))
        }, null, 2));
        process.exitCode = 0;
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
