#!/usr/bin/env node

import 'dotenv/config';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const MIGRATION_ID = '004_result_ranking_context';
const LOCK_NAME = 'benchpoll_result_ranking_context_migration';

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

async function columnExists(connection, tableName, columnName) {
    const [rows] = await connection.execute(`
        SELECT 1
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
        LIMIT 1`, [tableName, columnName]);
    return rows.length > 0;
}

async function indexExists(connection, tableName, indexName) {
    const [rows] = await connection.execute(`
        SELECT 1
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
        LIMIT 1`, [tableName, indexName]);
    return rows.length > 0;
}

async function constraintExists(connection, tableName, constraintName) {
    const [rows] = await connection.execute(`
        SELECT 1
        FROM information_schema.TABLE_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?
        LIMIT 1`, [tableName, constraintName]);
    return rows.length > 0;
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

    if (!await columnExists(connection, 'evaluation_results', 'ranking_context_ID')) {
        await connection.query(`
            ALTER TABLE evaluation_results
            ADD COLUMN ranking_context_ID BIGINT UNSIGNED NULL AFTER evaluation_profile_ID`);
    }

    const [backfill] = await connection.query(`
        UPDATE evaluation_results
        JOIN ranking_contexts
          ON ranking_contexts.ID = CAST(
                NULLIF(JSON_UNQUOTE(JSON_EXTRACT(evaluation_results.run_conditions, '$.rankingContext.ID')), 'null')
                AS UNSIGNED
             )
        SET evaluation_results.ranking_context_ID = ranking_contexts.ID
        WHERE evaluation_results.ranking_context_ID IS NULL
          AND JSON_EXTRACT(evaluation_results.run_conditions, '$.rankingContext.ID') IS NOT NULL`);

    if (await indexExists(connection, 'evaluation_results', 'uq_evaluation_results_current_configuration')) {
        await connection.query(`
            ALTER TABLE evaluation_results
            DROP INDEX uq_evaluation_results_current_configuration`);
    }
    if (!await indexExists(connection, 'evaluation_results', 'uq_evaluation_results_current_context')) {
        await connection.query(`
            ALTER TABLE evaluation_results
            ADD UNIQUE KEY uq_evaluation_results_current_context
                (ranking_context_ID, model_configuration_ID, evaluation_profile_ID, current_marker)`);
    }
    if (!await indexExists(connection, 'evaluation_results', 'idx_evaluation_results_context_status')) {
        await connection.query(`
            ALTER TABLE evaluation_results
            ADD KEY idx_evaluation_results_context_status
                (ranking_context_ID, status, model_configuration_ID, evaluation_profile_ID)`);
    }
    if (!await constraintExists(connection, 'evaluation_results', 'fk_evaluation_results_ranking_context')) {
        await connection.query(`
            ALTER TABLE evaluation_results
            ADD CONSTRAINT fk_evaluation_results_ranking_context
                FOREIGN KEY (ranking_context_ID) REFERENCES ranking_contexts (ID) ON DELETE RESTRICT`);
    }

    await connection.execute('INSERT INTO schema_migrations (migration_id) VALUES (?)', [MIGRATION_ID]);
    return { applied: true, resultsBackfilled: Number(backfill.affectedRows) };
}

if (!APPLY) {
    console.log(JSON.stringify({
        migration: MIGRATION_ID,
        dryRun: true,
        adds: ['evaluation_results.ranking_context_ID'],
        changesCurrentResultKey: true,
        backfillsFrom: 'evaluation_results.run_conditions.rankingContext.ID'
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
