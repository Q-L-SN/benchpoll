#!/usr/bin/env node

import 'dotenv/config';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const MIGRATION_ID = '005_ranking_integrity';
const LOCK_NAME = 'benchpoll_ranking_integrity_migration';

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
    return rows.length > 0;
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

async function migratePieWeights(connection) {
    const hasLegacyColumn = await columnExists(connection, 'personal_pie_weights', 'object_ID');
    const hasProfileColumn = await columnExists(connection, 'personal_pie_weights', 'evaluation_profile_ID');
    if (hasLegacyColumn === hasProfileColumn) {
        throw new Error('personal_pie_weights must contain exactly one supported identity column.');
    }
    if (hasProfileColumn) {
        return { migratedWeights: false, weightRows: null };
    }
    if (await tableExists(connection, 'personal_pie_weights_v2')
        || await tableExists(connection, 'personal_pie_weights_legacy_005')) {
        throw new Error('A partial personal_pie_weights migration exists; inspect it before retrying.');
    }

    const [ambiguous] = await connection.query(`
        SELECT weights.object_ID, COUNT(profiles.ID) AS profile_count
        FROM (SELECT DISTINCT object_ID FROM personal_pie_weights) AS weights
        LEFT JOIN evaluation_profiles AS profiles
          ON profiles.object_ID = weights.object_ID
         AND profiles.is_default = 1
         AND profiles.is_active = 1
        GROUP BY weights.object_ID
        HAVING COUNT(profiles.ID) <> 1`);
    if (ambiguous.length > 0) {
        throw new Error(`Cannot map ${ambiguous.length} evaluation objects to one active default profile.`);
    }

    const [[before]] = await connection.query('SELECT COUNT(*) AS count FROM personal_pie_weights');
    await connection.query(`
        CREATE TABLE personal_pie_weights_v2 (
            pie_ID BIGINT UNSIGNED NOT NULL,
            evaluation_profile_ID BIGINT UNSIGNED NOT NULL,
            weight_basis_points SMALLINT UNSIGNED NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (pie_ID, evaluation_profile_ID),
            KEY idx_personal_pie_weights_profile (evaluation_profile_ID),
            CONSTRAINT chk_personal_pie_profile_weight_005
                CHECK (weight_basis_points BETWEEN 100 AND 10000),
            CONSTRAINT fk_personal_pie_profile_pie_005
                FOREIGN KEY (pie_ID) REFERENCES personal_pies (ID) ON DELETE CASCADE,
            CONSTRAINT fk_personal_pie_profile_005
                FOREIGN KEY (evaluation_profile_ID) REFERENCES evaluation_profiles (ID) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await connection.query(`
        INSERT INTO personal_pie_weights_v2
            (pie_ID, evaluation_profile_ID, weight_basis_points, created_at, updated_at)
        SELECT weights.pie_ID, profiles.ID, weights.weight_basis_points,
               weights.created_at, weights.updated_at
        FROM personal_pie_weights AS weights
        JOIN evaluation_profiles AS profiles
          ON profiles.object_ID = weights.object_ID
         AND profiles.is_default = 1
         AND profiles.is_active = 1`);

    const [[after]] = await connection.query('SELECT COUNT(*) AS count FROM personal_pie_weights_v2');
    if (Number(after.count) !== Number(before.count)) {
        throw new Error(`Pie weight copy mismatch: expected ${before.count}, copied ${after.count}.`);
    }
    const [invalidTotals] = await connection.query(`
        SELECT pie_ID, SUM(weight_basis_points) AS total
        FROM personal_pie_weights_v2
        GROUP BY pie_ID
        HAVING SUM(weight_basis_points) <> 10000`);
    if (invalidTotals.length > 0) {
        throw new Error(`${invalidTotals.length} personal pies do not total 100 percent.`);
    }

    await connection.query(`
        RENAME TABLE
            personal_pie_weights TO personal_pie_weights_legacy_005,
            personal_pie_weights_v2 TO personal_pie_weights`);
    await connection.query('DROP TABLE personal_pie_weights_legacy_005');
    return { migratedWeights: true, weightRows: Number(after.count) };
}

async function enforceResultContext(connection) {
    if (!await columnExists(connection, 'evaluation_results', 'ranking_context_ID')) {
        throw new Error('evaluation_results.ranking_context_ID is missing; apply migration 004 first.');
    }
    const [[missing]] = await connection.query(`
        SELECT COUNT(*) AS count
        FROM evaluation_results
        WHERE ranking_context_ID IS NULL`);
    if (Number(missing.count) > 0) {
        throw new Error(`${missing.count} evaluation results have no exact ranking context.`);
    }
    const [duplicates] = await connection.query(`
        SELECT ranking_context_ID, model_configuration_ID, evaluation_profile_ID, COUNT(*) AS count
        FROM evaluation_results
        WHERE status = 'accepted'
        GROUP BY ranking_context_ID, model_configuration_ID, evaluation_profile_ID
        HAVING COUNT(*) > 1`);
    if (duplicates.length > 0) {
        throw new Error(`${duplicates.length} accepted result identities are duplicated.`);
    }

    await connection.query(`
        ALTER TABLE evaluation_results
        MODIFY COLUMN ranking_context_ID BIGINT UNSIGNED NOT NULL`);
    if (!await indexExists(connection, 'evaluation_results', 'uq_evaluation_results_current_context')) {
        await connection.query(`
            ALTER TABLE evaluation_results
            ADD UNIQUE KEY uq_evaluation_results_current_context
                (ranking_context_ID, model_configuration_ID, evaluation_profile_ID, current_marker)`);
    }
    return { resultContextRequired: true, resultRowsChecked: 0 };
}

async function verifyMigrationPostconditions(connection) {
    const hasLegacyColumn = await columnExists(connection, 'personal_pie_weights', 'object_ID');
    const hasProfileColumn = await columnExists(connection, 'personal_pie_weights', 'evaluation_profile_ID');
    if (hasLegacyColumn || !hasProfileColumn) {
        throw new Error('Migration marker exists but personal_pie_weights still uses the legacy identity.');
    }
    const [[nullableContext]] = await connection.query(`
        SELECT COUNT(*) AS count
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'evaluation_results'
          AND COLUMN_NAME = 'ranking_context_ID'
          AND IS_NULLABLE = 'YES'`);
    if (Number(nullableContext.count) !== 0) {
        throw new Error('Migration marker exists but evaluation_results.ranking_context_ID is nullable.');
    }
    if (!await indexExists(connection, 'evaluation_results', 'uq_evaluation_results_current_context')) {
        throw new Error('Migration marker exists but the exact accepted-result unique index is missing.');
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
        await verifyMigrationPostconditions(connection);
        return { applied: false, verified: true, alreadyAppliedAt: existing[0].applied_at };
    }

    const weightResult = await migratePieWeights(connection);
    const resultContext = await enforceResultContext(connection);
    await connection.execute('INSERT INTO schema_migrations (migration_id) VALUES (?)', [MIGRATION_ID]);
    return { applied: true, ...weightResult, ...resultContext };
}

if (!APPLY) {
    console.log(JSON.stringify({
        migration: MIGRATION_ID,
        dryRun: true,
        changes: [
            'personal_pie_weights.object_ID -> evaluation_profile_ID',
            'evaluation_results.ranking_context_ID -> NOT NULL'
        ],
        behavior: 'fails instead of guessing when existing data cannot be mapped exactly'
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
