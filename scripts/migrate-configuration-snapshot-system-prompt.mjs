#!/usr/bin/env node

import 'dotenv/config';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const MIGRATION_ID = '003_model_configuration_snapshot_system_prompt';
const LOCK_NAME = 'benchpoll_configuration_snapshot_system_prompt_migration';

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

    const [result] = await connection.query(`
        UPDATE evaluation_results
        JOIN model_configurations
          ON model_configurations.ID = evaluation_results.model_configuration_ID
        SET evaluation_results.model_configuration_snapshot = JSON_MERGE_PATCH(
                evaluation_results.model_configuration_snapshot,
                JSON_OBJECT('systemPrompt', model_configurations.system_prompt)
            )
        WHERE JSON_CONTAINS_PATH(
                evaluation_results.model_configuration_snapshot,
                'one',
                '$.systemPrompt'
            ) = 0`);
    await connection.execute('INSERT INTO schema_migrations (migration_id) VALUES (?)', [MIGRATION_ID]);
    return { applied: true, snapshotsUpdated: Number(result.affectedRows) };
}

if (!APPLY) {
    console.log(JSON.stringify({
        migration: MIGRATION_ID,
        dryRun: true,
        updates: ['evaluation_results.model_configuration_snapshot.systemPrompt']
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
        const result = await applyMigration(connection);
        console.log(JSON.stringify({ migration: MIGRATION_ID, ...result }, null, 2));
    } finally {
        await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
    }
} finally {
    await connection.end();
}
