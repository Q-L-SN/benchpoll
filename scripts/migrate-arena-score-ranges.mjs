#!/usr/bin/env node

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const MIGRATION_ID = '018_arena_score_ranges';
const PREVIOUS_MIGRATION_ID = '017_required_score_ranges';
const LOCK_NAME = 'benchpoll_arena_score_ranges_migration';
const ARENA_SCORE_MIN = -500;
const ARENA_SCORE_MAX = 1500;

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

const arenaTagPredicate = `EXISTS (
    SELECT 1
    FROM benchmark_tag_links
    JOIN benchmark_tags ON benchmark_tags.ID = benchmark_tag_links.tag_ID
    WHERE benchmark_tag_links.benchmark_ID = benchmark_conditions.benchmark_ID
      AND benchmark_tags.is_active = 1
      AND LOWER(benchmark_tags.name) = 'arena'
)`;

async function inspectArenaConditions(connection) {
    const [[row]] = await connection.query(`
        SELECT
            COUNT(*) AS arena_conditions,
            SUM(
                uses_percentage_scale <> 0
                OR score_min IS NULL
                OR score_max IS NULL
                OR score_min <> ${ARENA_SCORE_MIN}
                OR score_max <> ${ARENA_SCORE_MAX}
            ) AS mismatched_conditions
        FROM benchmark_conditions
        WHERE ${arenaTagPredicate}`);
    return {
        arenaConditions: Number(row.arena_conditions ?? 0),
        mismatchedConditions: Number(row.mismatched_conditions ?? 0)
    };
}

async function repairArenaConditions(connection) {
    const [result] = await connection.query(`
        UPDATE benchmark_conditions
        SET uses_percentage_scale = 0,
            score_min = ${ARENA_SCORE_MIN},
            score_max = ${ARENA_SCORE_MAX},
            updated_at = CURRENT_TIMESTAMP
        WHERE ${arenaTagPredicate}
          AND (
              uses_percentage_scale <> 0
              OR score_min IS NULL
              OR score_max IS NULL
              OR score_min <> ${ARENA_SCORE_MIN}
              OR score_max <> ${ARENA_SCORE_MAX}
          )`);
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
    try {
        const updatedConditions = await repairArenaConditions(connection);
        const report = await inspectArenaConditions(connection);
        if (report.mismatchedConditions !== 0) {
            throw new Error(`Arena score-range migration verification failed: ${JSON.stringify(report)}`);
        }
        await connection.execute(
            'INSERT INTO schema_migrations (migration_id) VALUES (?)',
            [MIGRATION_ID]
        );
        await connection.commit();
        return { applied: true, updatedConditions, ...report };
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
            ...(await inspectArenaConditions(connection))
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
