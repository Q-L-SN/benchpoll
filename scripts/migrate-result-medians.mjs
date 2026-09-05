#!/usr/bin/env node

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const MIGRATION_ID = '020_result_medians';
const PREVIOUS_MIGRATION_ID = '019_literal_default_conditions';
const LOCK_NAME = 'benchpoll_result_medians_migration';
const OBSOLETE_INDEX = 'uq_benchmark_results_current_context';
const OBSOLETE_COLUMN = 'current_marker';

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

async function indexExists(connection, indexName) {
    const [rows] = await connection.execute(`
        SELECT 1
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'benchmark_results'
          AND INDEX_NAME = ?
        LIMIT 1`, [indexName]);
    return rows.length === 1;
}

async function columnExists(connection, columnName) {
    const [rows] = await connection.execute(`
        SELECT 1
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'benchmark_results'
          AND COLUMN_NAME = ?
        LIMIT 1`, [columnName]);
    return rows.length === 1;
}

async function schemaState(connection) {
    return {
        obsoleteUniqueIndex: await indexExists(connection, OBSOLETE_INDEX),
        obsoleteCurrentMarker: await columnExists(connection, OBSOLETE_COLUMN)
    };
}

async function verifyPostconditions(connection) {
    const state = await schemaState(connection);
    if (state.obsoleteUniqueIndex || state.obsoleteCurrentMarker) {
        throw new Error(`Result-median schema invariant failed: ${JSON.stringify(state)}`);
    }
    return state;
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

    const before = await schemaState(connection);
    if (before.obsoleteUniqueIndex) {
        await connection.query(`
            ALTER TABLE benchmark_results
            DROP INDEX uq_benchmark_results_current_context`);
    }
    if (before.obsoleteCurrentMarker) {
        await connection.query(`
            ALTER TABLE benchmark_results
            DROP COLUMN current_marker`);
    }
    const after = await verifyPostconditions(connection);
    await connection.execute(
        'INSERT INTO schema_migrations (migration_id) VALUES (?)',
        [MIGRATION_ID]
    );
    return { applied: true, before, after };
}

const connection = await mysql.createConnection(databaseConfig());
try {
    if (!APPLY) {
        console.log(JSON.stringify({
            migration: MIGRATION_ID,
            dryRun: true,
            ...(await schemaState(connection))
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
