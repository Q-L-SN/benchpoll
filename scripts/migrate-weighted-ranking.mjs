#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const MIGRATION_ID = '001_weighted_ranking';
const LOCK_NAME = 'benchpoll_weighted_ranking_migration';

function readCredentialFile() {
    const credentialPath = path.resolve('db-credentials.local.md');
    if (!fs.existsSync(credentialPath)) {
        return {};
    }
    const content = fs.readFileSync(credentialPath, 'utf8');
    const readValue = key => {
        const match = content.match(new RegExp(`^${key}\\s*[:=]\\s*[\`\"]?(.+?)[\`\"]?\\s*$`, 'mi'));
        return match?.[1]?.trim();
    };
    return {
        host: readValue('host'),
        port: readValue('port'),
        user: readValue('user'),
        password: readValue('password'),
        database: readValue('database')
    };
}

function databaseConfig() {
    const local = readCredentialFile();
    const config = {
        host: process.env.BENCHPOLL_DB_HOST || local.host || 'localhost',
        port: Number(process.env.BENCHPOLL_DB_PORT || local.port || 3306),
        user: process.env.BENCHPOLL_DB_USER || local.user,
        password: process.env.BENCHPOLL_DB_PASSWORD || local.password,
        database: process.env.BENCHPOLL_DB_NAME || local.database || 'benchmarks',
        charset: 'utf8mb4'
    };
    if (!config.user || config.password === undefined) {
        throw new Error('Database credentials are unavailable. Configure BENCHPOLL_DB_* or db-credentials.local.md.');
    }
    return config;
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

async function createTables(connection) {
    await connection.query(`
        CREATE TABLE IF NOT EXISTS ranking_dimensions (
            ID INT UNSIGNED NOT NULL AUTO_INCREMENT,
            scope_category_ID INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '0 means globally available',
            dimension_key VARCHAR(64) NOT NULL,
            name VARCHAR(128) NOT NULL,
            position SMALLINT UNSIGNED NOT NULL DEFAULT 0,
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (ID),
            UNIQUE KEY uq_ranking_dimensions_scope_key (scope_category_ID, dimension_key),
            KEY idx_ranking_dimensions_scope_position (scope_category_ID, is_active, position)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS ranking_dimension_options (
            ID INT UNSIGNED NOT NULL AUTO_INCREMENT,
            dimension_ID INT UNSIGNED NOT NULL,
            option_key VARCHAR(64) NOT NULL,
            name VARCHAR(128) NOT NULL,
            position SMALLINT UNSIGNED NOT NULL DEFAULT 0,
            is_default TINYINT(1) NOT NULL DEFAULT 0,
            is_neutral TINYINT(1) NOT NULL DEFAULT 0,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (ID),
            UNIQUE KEY uq_ranking_dimension_options_key (dimension_ID, option_key),
            KEY idx_ranking_dimension_options_position (dimension_ID, position),
            CONSTRAINT fk_ranking_dimension_options_dimension
                FOREIGN KEY (dimension_ID) REFERENCES ranking_dimensions (ID) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS ranking_contexts (
            ID BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            category_ID INT UNSIGNED NOT NULL,
            template_values JSON NOT NULL,
            template_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (ID),
            UNIQUE KEY uq_ranking_context_category_hash (category_ID, template_hash),
            CONSTRAINT fk_ranking_context_category
                FOREIGN KEY (category_ID) REFERENCES categories (ID) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS personal_pies (
            ID BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            user_ID BIGINT UNSIGNED NOT NULL,
            context_ID BIGINT UNSIGNED NOT NULL,
            revision INT UNSIGNED NOT NULL DEFAULT 1,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (ID),
            UNIQUE KEY uq_personal_pie_user_context (user_ID, context_ID),
            KEY idx_personal_pie_context (context_ID),
            CONSTRAINT fk_personal_pie_user
                FOREIGN KEY (user_ID) REFERENCES users (ID) ON DELETE CASCADE,
            CONSTRAINT fk_personal_pie_context
                FOREIGN KEY (context_ID) REFERENCES ranking_contexts (ID) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS personal_pie_weights (
            pie_ID BIGINT UNSIGNED NOT NULL,
            object_ID INT UNSIGNED NOT NULL,
            weight_basis_points SMALLINT UNSIGNED NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (pie_ID, object_ID),
            KEY idx_personal_pie_weights_object (object_ID),
            CONSTRAINT chk_personal_pie_weight CHECK (weight_basis_points BETWEEN 100 AND 10000),
            CONSTRAINT fk_personal_pie_weight_pie
                FOREIGN KEY (pie_ID) REFERENCES personal_pies (ID) ON DELETE CASCADE,
            CONSTRAINT fk_personal_pie_weight_object
                FOREIGN KEY (object_ID) REFERENCES objects (ID) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS vendors (
            ID INT UNSIGNED NOT NULL AUTO_INCREMENT,
            slug VARCHAR(96) NOT NULL,
            name VARCHAR(128) NOT NULL,
            logo_key VARCHAR(96) NULL,
            url VARCHAR(512) NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (ID),
            UNIQUE KEY uq_vendors_slug (slug),
            UNIQUE KEY uq_vendors_name (name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS models (
            ID INT UNSIGNED NOT NULL AUTO_INCREMENT,
            vendor_ID INT UNSIGNED NOT NULL,
            slug VARCHAR(128) NOT NULL,
            name VARCHAR(192) NOT NULL,
            url VARCHAR(512) NULL,
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (ID),
            UNIQUE KEY uq_models_slug (slug),
            UNIQUE KEY uq_models_vendor_name (vendor_ID, name),
            KEY idx_models_active_name (is_active, name),
            CONSTRAINT fk_models_vendor
                FOREIGN KEY (vendor_ID) REFERENCES vendors (ID) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS evaluation_results (
            ID BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            model_ID INT UNSIGNED NOT NULL,
            object_ID INT UNSIGNED NOT NULL,
            raw_score DECIMAL(18,6) NOT NULL,
            source_url VARCHAR(2048) NOT NULL,
            source_type ENUM('vendor_official','third_party_lab','paper','other') NOT NULL,
            source_title VARCHAR(255) NULL,
            submitted_by BIGINT UNSIGNED NULL,
            moderation_log_ID INT UNSIGNED NULL,
            status ENUM('accepted','superseded') NOT NULL DEFAULT 'accepted',
            current_marker TINYINT GENERATED ALWAYS AS (
                CASE WHEN status = 'accepted' THEN 1 ELSE NULL END
            ) STORED,
            accepted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (ID),
            UNIQUE KEY uq_evaluation_results_current (model_ID, object_ID, current_marker),
            KEY idx_evaluation_results_object_status (object_ID, status),
            KEY idx_evaluation_results_model_status (model_ID, status),
            CONSTRAINT fk_evaluation_results_model
                FOREIGN KEY (model_ID) REFERENCES models (ID) ON DELETE CASCADE,
            CONSTRAINT fk_evaluation_results_object
                FOREIGN KEY (object_ID) REFERENCES objects (ID) ON DELETE CASCADE,
            CONSTRAINT fk_evaluation_results_submitter
                FOREIGN KEY (submitted_by) REFERENCES users (ID) ON DELETE SET NULL,
            CONSTRAINT fk_evaluation_results_moderation_log
                FOREIGN KEY (moderation_log_ID) REFERENCES moderation_logs (ID) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
}

async function addObjectMetadata(connection) {
    await ensureColumn(connection, 'objects', 'object_type', "ENUM('benchmark','arena','protocol','other') NOT NULL DEFAULT 'benchmark' AFTER `name`");
    await ensureColumn(connection, 'objects', 'description', 'TEXT NULL AFTER `object_type`');
    await ensureColumn(connection, 'objects', 'score_min', 'DECIMAL(18,6) NOT NULL DEFAULT 0 AFTER `url`');
    await ensureColumn(connection, 'objects', 'score_max', 'DECIMAL(18,6) NOT NULL DEFAULT 100 AFTER `score_min`');
    await ensureColumn(connection, 'objects', 'higher_is_better', 'TINYINT(1) NOT NULL DEFAULT 1 AFTER `score_max`');
    await ensureColumn(connection, 'objects', 'created_at', 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER `higher_is_better`');
    await ensureColumn(connection, 'objects', 'updated_at', 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`');

    const [duplicateObjects] = await connection.query(`
        SELECT name
        FROM objects
        GROUP BY name
        HAVING COUNT(*) > 1
        LIMIT 1`);
    if (duplicateObjects.length > 0) {
        throw new Error('Cannot add the object-name uniqueness constraint while duplicate names exist.');
    }
    await ensureIndex(connection, 'objects', 'uq_objects_name', 'UNIQUE KEY `uq_objects_name` (`name`)');
    await ensureIndex(connection, 'votes', 'idx_votes_scope_object_date', 'KEY `idx_votes_scope_object_date` (`target_category_ID`, `target_object_ID`, `date`)');
    await ensureIndex(connection, 'votes', 'idx_votes_user_scope_object_date', 'KEY `idx_votes_user_scope_object_date` (`user_ID`, `target_category_ID`, `target_object_ID`, `date`)');
    await ensureIndex(connection, 'moderation_logs', 'idx_moderation_status_created', 'KEY `idx_moderation_status_created` (`status`, `created_at`)');
}

async function seedDimensions(connection) {
    const dimensions = [
        {
            key: 'web',
            name: 'Web access',
            position: 10,
            options: [
                ['allowed', 'Allowed', 10, 1, 0],
                ['disallowed', 'Disallowed', 20, 0, 0],
                ['any', 'Any', 30, 0, 1]
            ]
        },
        {
            key: 'code',
            name: 'Code execution',
            position: 20,
            options: [
                ['sandboxed', 'Sandboxed', 10, 1, 0],
                ['full_access', 'Full access', 20, 0, 0],
                ['disallowed', 'Disallowed', 30, 0, 0],
                ['any', 'Any', 40, 0, 1]
            ]
        },
        {
            key: 'scope',
            name: 'Model scope',
            position: 30,
            options: [
                ['any', 'Any', 10, 1, 1],
                ['open_models', 'Open models', 20, 0, 0],
                ['closed_models', 'Closed models', 30, 0, 0]
            ]
        }
    ];

    for (const dimension of dimensions) {
        await connection.execute(`
            INSERT INTO ranking_dimensions (scope_category_ID, dimension_key, name, position, is_active)
            VALUES (0, ?, ?, ?, 1)
            ON DUPLICATE KEY UPDATE name = VALUES(name), position = VALUES(position), is_active = 1`,
        [dimension.key, dimension.name, dimension.position]);
        const [[row]] = await connection.execute(
            'SELECT ID FROM ranking_dimensions WHERE scope_category_ID = 0 AND dimension_key = ?',
            [dimension.key]
        );
        for (const [key, name, position, isDefault, isNeutral] of dimension.options) {
            await connection.execute(`
                INSERT INTO ranking_dimension_options
                    (dimension_ID, option_key, name, position, is_default, is_neutral)
                VALUES (?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    name = VALUES(name), position = VALUES(position),
                    is_default = VALUES(is_default), is_neutral = VALUES(is_neutral)`,
            [row.ID, key, name, position, isDefault, isNeutral]);
        }
    }
}

async function seedModels(connection) {
    const seed = [
        ['openai', 'OpenAI', 'openai', 'gpt-4o', 'GPT-4o'],
        ['anthropic', 'Anthropic', 'anthropic', 'claude-3-5-sonnet', 'Claude 3.5 Sonnet'],
        ['google', 'Google', 'google', 'gemini-1-5-pro', 'Gemini 1.5 Pro'],
        ['meta', 'Meta', 'meta', 'llama-3-1-405b', 'Llama 3.1 405B'],
        ['mistral', 'Mistral AI', 'mistral', 'mistral-large-2', 'Mistral Large 2'],
        ['google', 'Google', 'google', 'gemini-1-5-flash', 'Gemini 1.5 Flash'],
        ['amazon', 'Amazon', 'amazon', 'amazon-nova-pro', 'Amazon Nova Pro'],
        ['cohere', 'Cohere', 'cohere', 'command-r-plus', 'Command R+'],
        ['qwen', 'Alibaba Qwen', 'qwen', 'qwen-2-5-72b', 'Qwen 2.5 72B'],
        ['microsoft', 'Microsoft', 'microsoft', 'phi-3-medium', 'Phi-3-medium'],
        ['xai', 'xAI', 'xai', 'grok-2', 'Grok 2'],
        ['deepseek', 'DeepSeek', 'deepseek', 'deepseek-coder-v2', 'DeepSeek Coder V2'],
        ['zhipu', 'Zhipu AI', 'zhipu', 'zhipu-ai-glm-4', 'Zhipu AI GLM-4']
    ];

    for (const [vendorSlug, vendorName, logoKey, modelSlug, modelName] of seed) {
        await connection.execute(`
            INSERT INTO vendors (slug, name, logo_key)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE name = VALUES(name), logo_key = VALUES(logo_key)`,
        [vendorSlug, vendorName, logoKey]);
        const [[vendor]] = await connection.execute('SELECT ID FROM vendors WHERE slug = ?', [vendorSlug]);
        await connection.execute(`
            INSERT INTO models (vendor_ID, slug, name, is_active)
            VALUES (?, ?, ?, 1)
            ON DUPLICATE KEY UPDATE vendor_ID = VALUES(vendor_ID), name = VALUES(name), is_active = 1`,
        [vendor.ID, modelSlug, modelName]);
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
        'SELECT migration_id, applied_at FROM schema_migrations WHERE migration_id = ?',
        [MIGRATION_ID]
    );
    if (existing.length > 0) {
        return { applied: false, alreadyAppliedAt: existing[0].applied_at };
    }

    await addObjectMetadata(connection);
    await createTables(connection);
    await connection.beginTransaction();
    try {
        await seedDimensions(connection);
        await seedModels(connection);
        await connection.execute('INSERT INTO schema_migrations (migration_id) VALUES (?)', [MIGRATION_ID]);
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    }
    return { applied: true };
}

const connection = await mysql.createConnection(databaseConfig());
try {
    if (!APPLY) {
        console.log('Dry run: weighted-ranking migration is ready. Re-run with --apply.');
        console.log(JSON.stringify({
            migration: MIGRATION_ID,
            addsObjectMetadata: true,
            creates: [
                'ranking_dimensions',
                'ranking_dimension_options',
                'ranking_contexts',
                'personal_pies',
                'personal_pie_weights',
                'vendors',
                'models',
                'evaluation_results'
            ],
            preserves: ['votes', 'category_templates']
        }, null, 2));
    } else {
        const [[lock]] = await connection.query('SELECT GET_LOCK(?, 15) AS acquired', [LOCK_NAME]);
        if (Number(lock.acquired) !== 1) {
            throw new Error('Could not acquire the database migration lock.');
        }
        try {
            const result = await applyMigration(connection);
            console.log(JSON.stringify({ migration: MIGRATION_ID, ...result }, null, 2));
        } finally {
            await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
        }
    }
} finally {
    await connection.end();
}
