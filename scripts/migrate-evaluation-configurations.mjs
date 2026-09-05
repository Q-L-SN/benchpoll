#!/usr/bin/env node

import 'dotenv/config';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const MIGRATION_ID = '002_evaluation_and_model_configurations';
const LOCK_NAME = 'benchpoll_evaluation_configuration_migration';

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

async function ensureColumn(connection, tableName, columnName, definition) {
    if (!await columnExists(connection, tableName, columnName)) {
        await connection.query(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${definition}`);
    }
}

async function ensureIndex(connection, tableName, indexName, definition) {
    if (!await indexExists(connection, tableName, indexName)) {
        await connection.query(`ALTER TABLE \`${tableName}\` ADD ${definition}`);
    }
}

async function ensureConstraint(connection, tableName, constraintName, definition) {
    if (!await constraintExists(connection, tableName, constraintName)) {
        await connection.query(`ALTER TABLE \`${tableName}\` ADD CONSTRAINT \`${constraintName}\` ${definition}`);
    }
}

async function createConfigurationTables(connection) {
    await connection.query(`
        CREATE TABLE IF NOT EXISTS evaluation_profiles (
            ID BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            object_ID INT UNSIGNED NOT NULL,
            profile_key VARCHAR(128) NOT NULL,
            name VARCHAR(192) NOT NULL,
            description TEXT NULL,
            dataset_version VARCHAR(128) NULL,
            dataset_split VARCHAR(128) NULL,
            metric_name VARCHAR(128) NULL,
            pass_k INT UNSIGNED NULL,
            score_min DECIMAL(18,6) NOT NULL DEFAULT 0,
            score_max DECIMAL(18,6) NOT NULL DEFAULT 100,
            score_direction ENUM('higher','lower','closer_to_target','not_rankable') NOT NULL DEFAULT 'higher',
            target_value DECIMAL(18,6) NULL,
            protocol_conditions JSON NULL,
            is_default TINYINT(1) NOT NULL DEFAULT 0,
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            default_marker TINYINT GENERATED ALWAYS AS (
                CASE WHEN is_default = 1 THEN 1 ELSE NULL END
            ) STORED,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (ID),
            UNIQUE KEY uq_evaluation_profiles_key (object_ID, profile_key),
            UNIQUE KEY uq_evaluation_profiles_default (object_ID, default_marker),
            KEY idx_evaluation_profiles_active (object_ID, is_active, name),
            CONSTRAINT fk_evaluation_profiles_object
                FOREIGN KEY (object_ID) REFERENCES objects (ID) ON DELETE CASCADE,
            CONSTRAINT chk_evaluation_profiles_score_range CHECK (score_max > score_min),
            CONSTRAINT chk_evaluation_profiles_pass_k CHECK (pass_k IS NULL OR pass_k > 0)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS model_configurations (
            ID BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            model_ID INT UNSIGNED NOT NULL,
            configuration_key VARCHAR(128) NOT NULL,
            name VARCHAR(192) NOT NULL,
            provider_effort_label VARCHAR(96) NULL,
            reasoning_token_budget INT UNSIGNED NULL,
            reasoning_budget_type ENUM('unknown','maximum','fixed','adaptive') NOT NULL DEFAULT 'unknown',
            temperature DECIMAL(8,6) NULL,
            top_p DECIMAL(8,6) NULL,
            system_prompt TEXT NULL,
            model_version VARCHAR(128) NULL,
            api_version VARCHAR(128) NULL,
            additional_settings JSON NULL,
            is_default TINYINT(1) NOT NULL DEFAULT 0,
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            default_marker TINYINT GENERATED ALWAYS AS (
                CASE WHEN is_default = 1 THEN 1 ELSE NULL END
            ) STORED,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (ID),
            UNIQUE KEY uq_model_configurations_key (model_ID, configuration_key),
            UNIQUE KEY uq_model_configurations_default (model_ID, default_marker),
            KEY idx_model_configurations_active (model_ID, is_active, name),
            CONSTRAINT fk_model_configurations_model
                FOREIGN KEY (model_ID) REFERENCES models (ID) ON DELETE CASCADE,
            CONSTRAINT chk_model_configurations_temperature CHECK (temperature IS NULL OR temperature >= 0),
            CONSTRAINT chk_model_configurations_top_p CHECK (top_p IS NULL OR (top_p >= 0 AND top_p <= 1))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS evaluation_tags (
            ID INT UNSIGNED NOT NULL AUTO_INCREMENT,
            tag_key VARCHAR(96) NOT NULL,
            name VARCHAR(96) NOT NULL,
            tag_kind ENUM('capability','protocol','freeform') NOT NULL DEFAULT 'freeform',
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (ID),
            UNIQUE KEY uq_evaluation_tags_key (tag_key),
            UNIQUE KEY uq_evaluation_tags_name (name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS evaluation_object_tags (
            object_ID INT UNSIGNED NOT NULL,
            tag_ID INT UNSIGNED NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (object_ID, tag_ID),
            KEY idx_evaluation_object_tags_tag (tag_ID, object_ID),
            CONSTRAINT fk_evaluation_object_tags_object
                FOREIGN KEY (object_ID) REFERENCES objects (ID) ON DELETE CASCADE,
            CONSTRAINT fk_evaluation_object_tags_tag
                FOREIGN KEY (tag_ID) REFERENCES evaluation_tags (ID) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
}

async function seedDefaults(connection) {
    await connection.query(`
        INSERT INTO evaluation_profiles
            (object_ID, profile_key, name, score_min, score_max, score_direction,
             protocol_conditions, is_default, is_active)
        SELECT objects.ID, 'default', 'Default', objects.score_min, objects.score_max,
               CASE WHEN objects.higher_is_better = 1 THEN 'higher' ELSE 'lower' END,
               JSON_OBJECT(
                   'inputModality', objects.input_modality,
                   'outputModality', objects.output_modality,
                   'realtime', objects.is_realtime
               ),
               1, 1
        FROM objects
        LEFT JOIN evaluation_profiles
            ON evaluation_profiles.object_ID = objects.ID
           AND evaluation_profiles.profile_key = 'default'
        WHERE evaluation_profiles.ID IS NULL`);

    await connection.query(`
        INSERT INTO model_configurations
            (model_ID, configuration_key, name, reasoning_budget_type, is_default, is_active)
        SELECT models.ID, 'default', 'Default', 'unknown', 1, 1
        FROM models
        LEFT JOIN model_configurations
            ON model_configurations.model_ID = models.ID
           AND model_configurations.configuration_key = 'default'
        WHERE model_configurations.ID IS NULL`);
}

async function extendResults(connection) {
    await ensureColumn(connection, 'evaluation_results', 'model_configuration_ID', 'BIGINT UNSIGNED NULL AFTER `model_ID`');
    await ensureColumn(connection, 'evaluation_results', 'evaluation_profile_ID', 'BIGINT UNSIGNED NULL AFTER `object_ID`');
    await ensureColumn(connection, 'evaluation_results', 'evaluation_conditions_snapshot', 'JSON NULL AFTER `source_title`');
    await ensureColumn(connection, 'evaluation_results', 'model_configuration_snapshot', 'JSON NULL AFTER `evaluation_conditions_snapshot`');
    await ensureColumn(connection, 'evaluation_results', 'run_conditions', 'JSON NULL AFTER `model_configuration_snapshot`');
    await ensureColumn(connection, 'evaluation_results', 'notes', 'TEXT NULL AFTER `run_conditions`');

    await connection.query(`
        UPDATE evaluation_results
        JOIN evaluation_profiles
          ON evaluation_profiles.object_ID = evaluation_results.object_ID
         AND evaluation_profiles.is_default = 1
        JOIN model_configurations
          ON model_configurations.model_ID = evaluation_results.model_ID
         AND model_configurations.is_default = 1
        SET evaluation_results.evaluation_profile_ID = evaluation_profiles.ID,
            evaluation_results.model_configuration_ID = model_configurations.ID
        WHERE evaluation_results.evaluation_profile_ID IS NULL
           OR evaluation_results.model_configuration_ID IS NULL`);

    await connection.query(`
        UPDATE evaluation_results
        JOIN evaluation_profiles ON evaluation_profiles.ID = evaluation_results.evaluation_profile_ID
        JOIN model_configurations ON model_configurations.ID = evaluation_results.model_configuration_ID
        SET evaluation_results.evaluation_conditions_snapshot = JSON_OBJECT(
                'profileID', evaluation_profiles.ID,
                'profileName', evaluation_profiles.name,
                'datasetVersion', evaluation_profiles.dataset_version,
                'datasetSplit', evaluation_profiles.dataset_split,
                'metricName', evaluation_profiles.metric_name,
                'passK', evaluation_profiles.pass_k,
                'scoreMin', evaluation_profiles.score_min,
                'scoreMax', evaluation_profiles.score_max,
                'scoreDirection', evaluation_profiles.score_direction,
                'targetValue', evaluation_profiles.target_value,
                'protocolConditions', evaluation_profiles.protocol_conditions
            ),
            evaluation_results.model_configuration_snapshot = JSON_OBJECT(
                'configurationID', model_configurations.ID,
                'configurationName', model_configurations.name,
                'providerEffortLabel', model_configurations.provider_effort_label,
                'reasoningTokenBudget', model_configurations.reasoning_token_budget,
                'reasoningBudgetType', model_configurations.reasoning_budget_type,
                'temperature', model_configurations.temperature,
                'topP', model_configurations.top_p,
                'systemPrompt', model_configurations.system_prompt,
                'modelVersion', model_configurations.model_version,
                'apiVersion', model_configurations.api_version,
                'additionalSettings', model_configurations.additional_settings
            )
        WHERE evaluation_results.evaluation_conditions_snapshot IS NULL
           OR evaluation_results.model_configuration_snapshot IS NULL`);

    await connection.query(`
        ALTER TABLE evaluation_results
        MODIFY COLUMN model_configuration_ID BIGINT UNSIGNED NOT NULL,
        MODIFY COLUMN evaluation_profile_ID BIGINT UNSIGNED NOT NULL,
        MODIFY COLUMN evaluation_conditions_snapshot JSON NOT NULL,
        MODIFY COLUMN model_configuration_snapshot JSON NOT NULL`);

    if (await indexExists(connection, 'evaluation_results', 'uq_evaluation_results_current')) {
        await connection.query('ALTER TABLE evaluation_results DROP INDEX uq_evaluation_results_current');
    }
    await ensureIndex(
        connection,
        'evaluation_results',
        'uq_evaluation_results_current_configuration',
        'UNIQUE KEY `uq_evaluation_results_current_configuration` (`model_configuration_ID`, `evaluation_profile_ID`, `current_marker`)'
    );
    await ensureIndex(
        connection,
        'evaluation_results',
        'idx_evaluation_results_profile_status',
        'KEY `idx_evaluation_results_profile_status` (`evaluation_profile_ID`, `status`)'
    );
    await ensureIndex(
        connection,
        'evaluation_results',
        'idx_evaluation_results_configuration_status',
        'KEY `idx_evaluation_results_configuration_status` (`model_configuration_ID`, `status`)'
    );
    await ensureConstraint(
        connection,
        'evaluation_results',
        'fk_evaluation_results_profile',
        'FOREIGN KEY (`evaluation_profile_ID`) REFERENCES `evaluation_profiles` (`ID`) ON DELETE RESTRICT'
    );
    await ensureConstraint(
        connection,
        'evaluation_results',
        'fk_evaluation_results_model_configuration',
        'FOREIGN KEY (`model_configuration_ID`) REFERENCES `model_configurations` (`ID`) ON DELETE RESTRICT'
    );
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

    await createConfigurationTables(connection);
    await seedDefaults(connection);
    await extendResults(connection);
    await connection.execute('INSERT INTO schema_migrations (migration_id) VALUES (?)', [MIGRATION_ID]);
    return { applied: true };
}

if (!APPLY) {
    console.log(JSON.stringify({
        migration: MIGRATION_ID,
        dryRun: true,
        creates: [
            'evaluation_profiles',
            'model_configurations',
            'evaluation_tags',
            'evaluation_object_tags'
        ],
        extends: ['evaluation_results'],
        backfills: ['one default profile per evaluation', 'one default configuration per model']
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
