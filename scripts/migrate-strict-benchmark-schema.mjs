#!/usr/bin/env node

import 'dotenv/config';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const MIGRATION_ID = '015_strict_benchmark_schema';
const LOCK_NAME = 'benchpoll_strict_benchmark_schema_migration';

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

async function columnExists(connection, tableName, columnName) {
    const [rows] = await connection.execute(`
        SELECT 1
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
        LIMIT 1`, [tableName, columnName]);
    return rows.length === 1;
}

async function assertExactColumns(connection, tableName, expectedColumns) {
    const [rows] = await connection.execute(`
        SELECT COLUMN_NAME
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`, [tableName]);
    const actual = rows.map(row => row.COLUMN_NAME);
    if (JSON.stringify(actual) !== JSON.stringify(expectedColumns)) {
        throw new Error(`Unexpected columns in ${tableName}: ${JSON.stringify({ expectedColumns, actual })}`);
    }
}

async function createCanonicalTables(connection) {
    await connection.query(`
        CREATE TABLE benchmarks (
            ID INT UNSIGNED NOT NULL AUTO_INCREMENT,
            name VARCHAR(192) NOT NULL,
            introduction_url VARCHAR(2048) NULL,
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (ID),
            UNIQUE KEY uq_benchmarks_name (name),
            CONSTRAINT chk_benchmarks_active CHECK (is_active IN (0, 1))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    await connection.query(`
        CREATE TABLE benchmark_conditions (
            ID BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            benchmark_ID INT UNSIGNED NOT NULL,
            condition_key VARCHAR(128) NOT NULL,
            name VARCHAR(192) NOT NULL,
            score_direction ENUM('higher','lower','closer_to_target') NOT NULL,
            target_value DECIMAL(18,6) NULL,
            uses_percentage_scale TINYINT(1) NOT NULL,
            score_min DECIMAL(18,6) NULL,
            score_max DECIMAL(18,6) NULL,
            is_default TINYINT(1) NOT NULL DEFAULT 0,
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            default_marker TINYINT GENERATED ALWAYS AS (
                CASE WHEN is_default = 1 AND is_active = 1 THEN 1 ELSE NULL END
            ) STORED,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (ID),
            UNIQUE KEY uq_benchmark_conditions_key (benchmark_ID, condition_key),
            UNIQUE KEY uq_benchmark_conditions_default (benchmark_ID, default_marker),
            KEY idx_benchmark_conditions_active (benchmark_ID, is_active, name),
            CONSTRAINT fk_benchmark_conditions_benchmark
                FOREIGN KEY (benchmark_ID) REFERENCES benchmarks (ID) ON DELETE CASCADE,
            CONSTRAINT chk_benchmark_conditions_percentage CHECK (uses_percentage_scale IN (0, 1)),
            CONSTRAINT chk_benchmark_conditions_default CHECK (is_default IN (0, 1)),
            CONSTRAINT chk_benchmark_conditions_active CHECK (is_active IN (0, 1)),
            CONSTRAINT chk_benchmark_conditions_range CHECK (
                (uses_percentage_scale = 1 AND score_min IS NULL AND score_max IS NULL)
                OR
                (uses_percentage_scale = 0
                    AND score_min IS NOT NULL
                    AND score_max IS NOT NULL
                    AND score_max > score_min)
            ),
            CONSTRAINT chk_benchmark_conditions_target CHECK (
                (score_direction = 'closer_to_target' AND target_value IS NOT NULL
                    AND (uses_percentage_scale = 0 OR (target_value >= 0 AND target_value <= 100))
                    AND (score_min IS NULL OR target_value >= score_min)
                    AND (score_max IS NULL OR target_value <= score_max))
                OR (score_direction <> 'closer_to_target' AND target_value IS NULL)
            )
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    await connection.query(`
        CREATE TABLE benchmark_tags (
            ID INT UNSIGNED NOT NULL AUTO_INCREMENT,
            tag_key VARCHAR(96) NOT NULL,
            name VARCHAR(96) NOT NULL,
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (ID),
            UNIQUE KEY uq_benchmark_tags_key (tag_key),
            UNIQUE KEY uq_benchmark_tags_name (name),
            CONSTRAINT chk_benchmark_tags_active CHECK (is_active IN (0, 1))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    await connection.query(`
        CREATE TABLE benchmark_tag_links (
            benchmark_ID INT UNSIGNED NOT NULL,
            tag_ID INT UNSIGNED NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (benchmark_ID, tag_ID),
            KEY idx_benchmark_tag_links_tag (tag_ID, benchmark_ID),
            CONSTRAINT fk_benchmark_tag_links_benchmark
                FOREIGN KEY (benchmark_ID) REFERENCES benchmarks (ID) ON DELETE CASCADE,
            CONSTRAINT fk_benchmark_tag_links_tag
                FOREIGN KEY (tag_ID) REFERENCES benchmark_tags (ID) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    await connection.query(`
        CREATE TABLE model_conditions (
            ID BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            model_ID INT UNSIGNED NOT NULL,
            condition_key VARCHAR(128) NOT NULL,
            name VARCHAR(192) NOT NULL,
            is_default TINYINT(1) NOT NULL DEFAULT 0,
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            default_marker TINYINT GENERATED ALWAYS AS (
                CASE WHEN is_default = 1 AND is_active = 1 THEN 1 ELSE NULL END
            ) STORED,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (ID),
            UNIQUE KEY uq_model_conditions_key (model_ID, condition_key),
            UNIQUE KEY uq_model_conditions_default (model_ID, default_marker),
            KEY idx_model_conditions_active (model_ID, is_active, name),
            CONSTRAINT fk_model_conditions_model
                FOREIGN KEY (model_ID) REFERENCES models (ID) ON DELETE CASCADE,
            CONSTRAINT chk_model_conditions_default CHECK (is_default IN (0, 1)),
            CONSTRAINT chk_model_conditions_active CHECK (is_active IN (0, 1))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    await connection.query(`
        CREATE TABLE benchmark_results (
            ID BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            model_ID INT UNSIGNED NOT NULL,
            model_condition_ID BIGINT UNSIGNED NOT NULL,
            benchmark_ID INT UNSIGNED NOT NULL,
            benchmark_condition_ID BIGINT UNSIGNED NOT NULL,
            raw_score DECIMAL(18,6) NOT NULL,
            source_url VARCHAR(2048) NOT NULL,
            source_type ENUM('vendor_official','third_party_lab','paper','other') NOT NULL,
            source_title VARCHAR(255) NULL,
            benchmark_condition_snapshot JSON NOT NULL,
            model_condition_snapshot JSON NOT NULL,
            submitted_by BIGINT UNSIGNED NULL,
            moderation_log_ID INT UNSIGNED NULL,
            status ENUM('accepted','superseded') NOT NULL DEFAULT 'accepted',
            accepted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (ID),
            KEY idx_benchmark_results_model_status (model_ID, status),
            KEY idx_benchmark_results_model_condition_status (model_condition_ID, status),
            KEY idx_benchmark_results_benchmark_status (benchmark_ID, status),
            KEY idx_benchmark_results_benchmark_condition_status (benchmark_condition_ID, status),
            KEY idx_benchmark_results_submitter (submitted_by),
            KEY idx_benchmark_results_moderation_log (moderation_log_ID),
            CONSTRAINT fk_benchmark_results_model
                FOREIGN KEY (model_ID) REFERENCES models (ID) ON DELETE CASCADE,
            CONSTRAINT fk_benchmark_results_model_condition
                FOREIGN KEY (model_condition_ID) REFERENCES model_conditions (ID) ON DELETE RESTRICT,
            CONSTRAINT fk_benchmark_results_benchmark
                FOREIGN KEY (benchmark_ID) REFERENCES benchmarks (ID) ON DELETE CASCADE,
            CONSTRAINT fk_benchmark_results_benchmark_condition
                FOREIGN KEY (benchmark_condition_ID) REFERENCES benchmark_conditions (ID) ON DELETE RESTRICT,
            CONSTRAINT fk_benchmark_results_submitter
                FOREIGN KEY (submitted_by) REFERENCES users (ID) ON DELETE SET NULL,
            CONSTRAINT fk_benchmark_results_moderation_log
                FOREIGN KEY (moderation_log_ID) REFERENCES moderation_logs (ID) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    await connection.query(`
        CREATE TABLE personal_pie_weights_v15 (
            pie_ID BIGINT UNSIGNED NOT NULL,
            benchmark_condition_ID BIGINT UNSIGNED NOT NULL,
            weight_basis_points SMALLINT UNSIGNED NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (pie_ID, benchmark_condition_ID),
            KEY idx_personal_pie_weights_condition (benchmark_condition_ID),
            CONSTRAINT fk_personal_pie_weights_pie
                FOREIGN KEY (pie_ID) REFERENCES personal_pies (ID) ON DELETE CASCADE,
            CONSTRAINT fk_personal_pie_weights_condition
                FOREIGN KEY (benchmark_condition_ID) REFERENCES benchmark_conditions (ID) ON DELETE CASCADE,
            CONSTRAINT chk_personal_pie_weight_basis_points
                CHECK (weight_basis_points >= 100 AND weight_basis_points <= 10000)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
}

async function copyCanonicalData(connection) {
    await connection.query(`
        INSERT INTO benchmarks (ID, name, introduction_url, is_active, created_at, updated_at)
        SELECT objects.ID, objects.name, objects.url,
               EXISTS (
                   SELECT 1 FROM evaluation_profiles
                   WHERE evaluation_profiles.object_ID = objects.ID
                     AND evaluation_profiles.is_active = 1
               ),
               objects.created_at, objects.updated_at
        FROM objects`);

    await connection.query(`
        INSERT INTO benchmark_conditions
            (ID, benchmark_ID, condition_key, name, score_direction, target_value,
             uses_percentage_scale, score_min, score_max, is_default, is_active,
             created_at, updated_at)
        SELECT evaluation_profiles.ID,
               evaluation_profiles.object_ID,
               evaluation_profiles.profile_key,
               evaluation_profiles.name,
               CASE evaluation_profiles.score_direction
                   WHEN 'lower' THEN 'lower'
                   WHEN 'closer_to_target' THEN 'closer_to_target'
                   ELSE 'higher'
               END,
               CASE
                   WHEN JSON_UNQUOTE(JSON_EXTRACT(evaluation_profiles.protocol_conditions, '$.scoreScale')) = 'percentage'
                       THEN evaluation_profiles.target_value * 100
                   ELSE evaluation_profiles.target_value
               END,
               CASE
                   WHEN JSON_UNQUOTE(JSON_EXTRACT(evaluation_profiles.protocol_conditions, '$.scoreScale')) = 'percentage'
                       THEN 1
                   ELSE 0
               END,
               CASE
                   WHEN JSON_UNQUOTE(JSON_EXTRACT(evaluation_profiles.protocol_conditions, '$.scoreScale')) = 'percentage'
                       THEN NULL
                   ELSE evaluation_profiles.score_min
               END,
               CASE
                   WHEN JSON_UNQUOTE(JSON_EXTRACT(evaluation_profiles.protocol_conditions, '$.scoreScale')) = 'percentage'
                       THEN NULL
                   ELSE evaluation_profiles.score_max
               END,
               evaluation_profiles.is_default,
               evaluation_profiles.is_active,
               evaluation_profiles.created_at,
               evaluation_profiles.updated_at
        FROM evaluation_profiles`);

    await connection.query(`
        INSERT INTO benchmark_tags (ID, tag_key, name, is_active, created_at, updated_at)
        SELECT ID, tag_key, name, is_active, created_at, updated_at
        FROM evaluation_tags`);
    await connection.query(`
        INSERT INTO benchmark_tags (tag_key, name, is_active)
        VALUES ('benchmark', 'benchmark', 1), ('arena', 'arena', 1)
        ON DUPLICATE KEY UPDATE is_active = 1`);
    await connection.query(`
        INSERT INTO benchmark_tag_links (benchmark_ID, tag_ID, created_at)
        SELECT object_ID, tag_ID, created_at
        FROM evaluation_object_tags`);
    await connection.query(`
        INSERT IGNORE INTO benchmark_tag_links (benchmark_ID, tag_ID)
        SELECT objects.ID, benchmark_tags.ID
        FROM objects
        JOIN benchmark_tags ON benchmark_tags.tag_key = objects.object_type`);

    await connection.query(`
        INSERT INTO model_conditions
            (ID, model_ID, condition_key, name, is_default, is_active, created_at, updated_at)
        SELECT ID, model_ID, configuration_key, name, is_default, is_active, created_at, updated_at
        FROM model_configurations`);

    await connection.query(`
        INSERT INTO benchmark_results
            (ID, model_ID, model_condition_ID, benchmark_ID, benchmark_condition_ID,
             raw_score, source_url, source_type, source_title,
             benchmark_condition_snapshot, model_condition_snapshot, submitted_by,
             moderation_log_ID, status, accepted_at, created_at, updated_at)
        SELECT evaluation_results.ID,
               evaluation_results.model_ID,
               evaluation_results.model_configuration_ID,
               evaluation_results.object_ID,
               evaluation_results.evaluation_profile_ID,
               CASE
                   WHEN JSON_UNQUOTE(JSON_EXTRACT(evaluation_profiles.protocol_conditions, '$.scoreScale')) = 'percentage'
                       THEN evaluation_results.raw_score * 100
                   ELSE evaluation_results.raw_score
               END,
               evaluation_results.source_url,
               evaluation_results.source_type,
               evaluation_results.source_title,
               JSON_OBJECT(
                   'conditionID', evaluation_profiles.ID,
                   'benchmarkID', evaluation_profiles.object_ID,
                   'name', evaluation_profiles.name,
                   'scoreDirection', evaluation_profiles.score_direction,
                   'targetValue', CASE
                       WHEN JSON_UNQUOTE(JSON_EXTRACT(evaluation_profiles.protocol_conditions, '$.scoreScale')) = 'percentage'
                           THEN evaluation_profiles.target_value * 100
                       ELSE evaluation_profiles.target_value
                   END,
                   'usesPercentageScale',
                       JSON_UNQUOTE(JSON_EXTRACT(evaluation_profiles.protocol_conditions, '$.scoreScale')) = 'percentage',
                   'scoreMin', CASE
                       WHEN JSON_UNQUOTE(JSON_EXTRACT(evaluation_profiles.protocol_conditions, '$.scoreScale')) = 'percentage'
                           THEN NULL ELSE evaluation_profiles.score_min END,
                   'scoreMax', CASE
                       WHEN JSON_UNQUOTE(JSON_EXTRACT(evaluation_profiles.protocol_conditions, '$.scoreScale')) = 'percentage'
                           THEN NULL ELSE evaluation_profiles.score_max END
               ),
               JSON_OBJECT(
                   'conditionID', model_configurations.ID,
                   'modelID', model_configurations.model_ID,
                   'name', model_configurations.name
               ),
               evaluation_results.submitted_by,
               evaluation_results.moderation_log_ID,
               evaluation_results.status,
               evaluation_results.accepted_at,
               evaluation_results.created_at,
               evaluation_results.updated_at
        FROM evaluation_results
        JOIN evaluation_profiles
          ON evaluation_profiles.ID = evaluation_results.evaluation_profile_ID
        JOIN model_configurations
          ON model_configurations.ID = evaluation_results.model_configuration_ID`);

    await connection.query(`
        INSERT INTO personal_pie_weights_v15
            (pie_ID, benchmark_condition_ID, weight_basis_points, created_at, updated_at)
        SELECT pie_ID, evaluation_profile_ID, weight_basis_points, created_at, updated_at
        FROM personal_pie_weights`);
}

function strictBenchmarkCondition(profile) {
    const protocol = profile?.protocolConditions && typeof profile.protocolConditions === 'object'
        ? profile.protocolConditions
        : {};
    const usesPercentageScale = protocol.scoreScale === 'percentage';
    return {
        clientRef: profile?.clientRef ?? null,
        name: String(profile?.name ?? ''),
        scoreDirection: ['higher', 'lower', 'closer_to_target'].includes(profile?.scoreDirection)
            ? profile.scoreDirection
            : 'higher',
        targetValue: profile?.targetValue == null
            ? null
            : usesPercentageScale ? Number(profile.targetValue) * 100 : Number(profile.targetValue),
        usesPercentageScale,
        scoreMin: usesPercentageScale ? null : profile?.scoreMin ?? null,
        scoreMax: usesPercentageScale ? null : profile?.scoreMax ?? null,
        isDefault: Boolean(profile?.isDefault)
    };
}

function strictModelCondition(configuration) {
    return {
        clientRef: configuration?.clientRef ?? null,
        name: String(configuration?.name ?? ''),
        isDefault: Boolean(configuration?.isDefault)
    };
}

function strictContributionContent(content) {
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
        return content;
    }
    if (content.type === 'new_evaluation') {
        return {
            schemaVersion: 5,
            type: 'new_benchmark',
            benchmarks: (content.evaluations ?? []).map(benchmark => ({
                clientRef: benchmark.clientRef ?? null,
                existingBenchmarkID: benchmark.existingObjectID ?? null,
                existingBenchmarkRef: benchmark.existingObjectRef ?? null,
                name: String(benchmark.name ?? ''),
                introductionURL: benchmark.url ?? '',
                tags: Array.isArray(benchmark.tags) ? benchmark.tags : [],
                reviewerNotes: benchmark.notes ?? '',
                conditions: (benchmark.profiles ?? []).map(strictBenchmarkCondition)
            }))
        };
    }
    if (content.type === 'new_model') {
        return {
            schemaVersion: 5,
            type: 'new_model',
            models: (content.models ?? []).map(model => ({
                clientRef: model.clientRef ?? null,
                existingModelID: model.existingModelID ?? null,
                existingModelRef: model.existingModelRef ?? null,
                name: String(model.name ?? ''),
                introductionURL: model.url ?? '',
                reviewerNotes: model.notes ?? '',
                vendor: model.vendor ?? null,
                conditions: (model.configurations ?? []).map(strictModelCondition)
            }))
        };
    }
    if (content.type === 'model_result') {
        return {
            schemaVersion: 6,
            type: 'benchmark_result',
            reviewerNotes: content.notes ?? '',
            results: (content.results ?? []).map(result => ({
                clientRef: result.clientRef ?? null,
                modelID: result.modelID ?? null,
                modelRef: result.modelRef ?? null,
                modelConditionID: result.modelConfigurationID ?? null,
                modelConditionRef: result.modelConfigurationRef ?? null,
                benchmarkID: result.objectID ?? null,
                benchmarkRef: result.objectRef ?? null,
                benchmarkConditionID: result.evaluationProfileID ?? null,
                benchmarkConditionRef: result.evaluationProfileRef ?? null,
                rawScore: result.rawScore,
                source: result.source
            }))
        };
    }
    if (content.type === 'benchmark_result') {
        const contextFreeContent = { ...content };
        delete contextFreeContent.context;
        return {
            ...contextFreeContent,
            schemaVersion: Math.max(6, Number(content.schemaVersion) || 0)
        };
    }
    if (content.type === 'entity_change' && content.targetKind === 'result') {
        const stripContext = value => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
            const contextFreeValue = { ...value };
            delete contextFreeValue.context;
            return contextFreeValue;
        };
        return {
            ...content,
            schemaVersion: Math.max(6, Number(content.schemaVersion) || 0),
            before: stripContext(content.before),
            after: stripContext(content.after),
            changes: Array.isArray(content.changes)
                ? content.changes.filter(change => !String(change?.field ?? '').startsWith('context'))
                : []
        };
    }
    return { ...content, schemaVersion: Math.max(5, Number(content.schemaVersion) || 0) };
}

async function migrateModerationContent(connection) {
    const [rows] = await connection.execute('SELECT ID, content FROM moderation_logs ORDER BY ID');
    for (const row of rows) {
        const parsed = typeof row.content === 'string' ? JSON.parse(row.content) : row.content;
        const strict = strictContributionContent(parsed);
        if (JSON.stringify(strict) !== JSON.stringify(parsed)) {
            await connection.execute(
                'UPDATE moderation_logs SET content = ?, updated_at = updated_at WHERE ID = ?',
                [JSON.stringify(strict), row.ID]
            );
        }
    }
}

async function removeLegacySchema(connection) {
    await connection.query(`
        RENAME TABLE personal_pie_weights TO legacy_personal_pie_weights,
                     personal_pie_weights_v15 TO personal_pie_weights`);
    await connection.query('DROP TABLE legacy_personal_pie_weights');
    await connection.query('DROP TABLE evaluation_results');
    await connection.query('DROP TABLE evaluation_object_tags');
    await connection.query('DROP TABLE evaluation_profiles');
    await connection.query('DROP TABLE evaluation_tags');
    await connection.query('DROP TABLE objects');
    await connection.query('DROP TABLE model_configurations');
    if (await tableExists(connection, 'votes')) {
        await connection.query('DROP TABLE votes');
    }
    if (await tableExists(connection, 'category_templates')) {
        await connection.query('DROP TABLE category_templates');
    }
    if (await columnExists(connection, 'categories', 'template')) {
        await connection.query('ALTER TABLE categories DROP COLUMN template');
    }
    if (await columnExists(connection, 'categories', 'is_folder')) {
        await connection.query('ALTER TABLE categories DROP COLUMN is_folder');
    }
    if (!await columnExists(connection, 'categories', 'is_active')) {
        await connection.query('ALTER TABLE categories ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER name');
    }
    if (!await columnExists(connection, 'categories', 'created_at')) {
        await connection.query('ALTER TABLE categories ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER is_active');
    }
    if (!await columnExists(connection, 'categories', 'updated_at')) {
        await connection.query('ALTER TABLE categories ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at');
    }
    if (await columnExists(connection, 'models', 'url')) {
        await connection.query(
            'ALTER TABLE models CHANGE COLUMN url introduction_url VARCHAR(2048) NULL'
        );
    }
    if (await columnExists(connection, 'vendors', 'url')) {
        await connection.query('ALTER TABLE vendors DROP COLUMN url');
    }
    if (await columnExists(connection, 'ranking_contexts', 'template_values')) {
        await connection.query(`
            ALTER TABLE ranking_contexts
            CHANGE COLUMN template_values context_values JSON NOT NULL`);
    }
    if (await columnExists(connection, 'ranking_contexts', 'template_hash')) {
        await connection.query(`
            ALTER TABLE ranking_contexts
            CHANGE COLUMN template_hash context_hash CHAR(64) NOT NULL`);
    }
    if (await columnExists(connection, 'users', 'vote_quota')) {
        await connection.query('ALTER TABLE users DROP COLUMN vote_quota');
    }
    if (await columnExists(connection, 'users', 'vote_used')) {
        await connection.query('ALTER TABLE users DROP COLUMN vote_used');
    }
}

async function assertCanonicalCounts(connection, before) {
    const [[after]] = await connection.query(`
        SELECT
            (SELECT COUNT(*) FROM benchmarks) AS benchmarkCount,
            (SELECT COUNT(*) FROM benchmark_conditions) AS benchmarkConditionCount,
            (SELECT COUNT(*) FROM model_conditions) AS modelConditionCount,
            (SELECT COUNT(*) FROM benchmark_results) AS resultCount,
            (SELECT COUNT(*) FROM personal_pie_weights) AS weightCount`);
    const expected = {
        benchmarkCount: Number(before.benchmarkCount),
        benchmarkConditionCount: Number(before.benchmarkConditionCount),
        modelConditionCount: Number(before.modelConditionCount),
        resultCount: Number(before.resultCount),
        weightCount: Number(before.weightCount)
    };
    const actual = Object.fromEntries(Object.entries(after).map(([key, value]) => [key, Number(value)]));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Canonical schema row-count mismatch: ${JSON.stringify({ expected, actual })}`);
    }
}

async function assertCanonicalSchema(connection) {
    for (const tableName of [
        'benchmarks', 'benchmark_conditions', 'benchmark_tags', 'benchmark_tag_links',
        'model_conditions', 'benchmark_results', 'personal_pie_weights'
    ]) {
        if (!await tableExists(connection, tableName)) {
            throw new Error(`Canonical table is missing after migration: ${tableName}`);
        }
    }
    for (const tableName of [
        'objects', 'evaluation_profiles', 'evaluation_tags', 'evaluation_object_tags',
        'evaluation_results', 'model_configurations', 'votes', 'category_templates'
    ]) {
        if (await tableExists(connection, tableName)) {
            throw new Error(`Legacy table remains after migration: ${tableName}`);
        }
    }
    for (const [tableName, columnName] of [
        ['categories', 'template'], ['categories', 'is_folder'],
        ['users', 'vote_quota'], ['users', 'vote_used'], ['models', 'url'],
        ['vendors', 'url'], ['ranking_contexts', 'template_values'],
        ['ranking_contexts', 'template_hash']
    ]) {
        if (await columnExists(connection, tableName, columnName)) {
            throw new Error(`Legacy column remains after migration: ${tableName}.${columnName}`);
        }
    }
    if (!await columnExists(connection, 'models', 'introduction_url')) {
        throw new Error('Canonical column is missing after migration: models.introduction_url');
    }
    if (!await columnExists(connection, 'ranking_contexts', 'context_values')
        || !await columnExists(connection, 'ranking_contexts', 'context_hash')) {
        throw new Error('Canonical ranking context columns are missing after migration.');
    }
    const exactBusinessColumns = {
        benchmarks: [
            'ID', 'name', 'introduction_url', 'is_active', 'created_at', 'updated_at'
        ],
        benchmark_conditions: [
            'ID', 'benchmark_ID', 'condition_key', 'name', 'score_direction',
            'target_value', 'uses_percentage_scale', 'score_min', 'score_max',
            'is_default', 'is_active', 'default_marker', 'created_at', 'updated_at'
        ],
        benchmark_tags: [
            'ID', 'tag_key', 'name', 'is_active', 'created_at', 'updated_at'
        ],
        benchmark_tag_links: ['benchmark_ID', 'tag_ID', 'created_at'],
        models: [
            'ID', 'vendor_ID', 'slug', 'name', 'introduction_url',
            'is_active', 'created_at', 'updated_at'
        ],
        vendors: ['ID', 'slug', 'name', 'logo_key', 'created_at', 'updated_at'],
        categories: [
            'ID', 'parent_ID', 'name', 'is_active', 'created_at', 'updated_at'
        ],
        ranking_dimensions: [
            'ID', 'scope_category_ID', 'dimension_key', 'name', 'position',
            'is_active', 'created_at', 'updated_at'
        ],
        ranking_dimension_options: [
            'ID', 'dimension_ID', 'option_key', 'name', 'position',
            'is_default', 'is_neutral', 'created_at', 'updated_at'
        ],
        model_conditions: [
            'ID', 'model_ID', 'condition_key', 'name', 'is_default', 'is_active',
            'default_marker', 'created_at', 'updated_at'
        ],
        ranking_contexts: [
            'ID', 'category_ID', 'context_values', 'context_hash', 'created_at', 'updated_at'
        ],
        benchmark_results: [
            'ID', 'model_ID', 'model_condition_ID', 'benchmark_ID',
            'benchmark_condition_ID', 'raw_score', 'source_url',
            'source_type', 'source_title', 'benchmark_condition_snapshot',
            'model_condition_snapshot', 'submitted_by', 'moderation_log_ID', 'status',
            'accepted_at', 'created_at', 'updated_at'
        ],
        personal_pies: [
            'ID', 'user_ID', 'context_ID', 'revision', 'created_at', 'updated_at'
        ],
        personal_pie_weights: [
            'pie_ID', 'benchmark_condition_ID', 'weight_basis_points', 'created_at', 'updated_at'
        ]
    };
    for (const [tableName, columns] of Object.entries(exactBusinessColumns)) {
        await assertExactColumns(connection, tableName, columns);
    }
    const [[invalidConditions]] = await connection.query(`
        SELECT COUNT(*) AS count
        FROM benchmark_conditions
        WHERE (uses_percentage_scale = 1
               AND (score_min IS NOT NULL OR score_max IS NOT NULL))
           OR (uses_percentage_scale = 0
               AND (score_min IS NULL OR score_max IS NULL OR score_max <= score_min))`);
    if (Number(invalidConditions.count) !== 0) {
        throw new Error(`Canonical benchmark condition invariant failed for ${invalidConditions.count} rows.`);
    }
    const [[invalidDefaults]] = await connection.query(`
        SELECT
            (SELECT COUNT(*) FROM benchmarks
             WHERE is_active = 1 AND (
                 SELECT COUNT(*) FROM benchmark_conditions
                 WHERE benchmark_conditions.benchmark_ID = benchmarks.ID
                   AND benchmark_conditions.is_active = 1
                   AND benchmark_conditions.is_default = 1
             ) > 1) +
            (SELECT COUNT(*) FROM models
             WHERE is_active = 1 AND (
                 SELECT COUNT(*) FROM model_conditions
                 WHERE model_conditions.model_ID = models.ID
                   AND model_conditions.is_active = 1
                   AND model_conditions.is_default = 1
             ) > 1) AS count`);
    if (Number(invalidDefaults.count) !== 0) {
        throw new Error(`Multiple active default conditions exist for ${invalidDefaults.count} objects.`);
    }
    const [[invalidResults]] = await connection.query(`
        SELECT COUNT(*) AS count
        FROM benchmark_results
        JOIN model_conditions ON model_conditions.ID = benchmark_results.model_condition_ID
        JOIN benchmark_conditions ON benchmark_conditions.ID = benchmark_results.benchmark_condition_ID
        WHERE model_conditions.model_ID <> benchmark_results.model_ID
           OR benchmark_conditions.benchmark_ID <> benchmark_results.benchmark_ID
           OR benchmark_results.source_url = ''
           OR (benchmark_conditions.uses_percentage_scale = 1
               AND (benchmark_results.raw_score < 0 OR benchmark_results.raw_score > 100))`);
    if (Number(invalidResults.count) !== 0) {
        throw new Error(`Canonical benchmark result invariant failed for ${invalidResults.count} rows.`);
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
        return { applied: false, alreadyAppliedAt: existing[0].applied_at };
    }
    for (const tableName of [
        'objects', 'evaluation_profiles', 'evaluation_tags', 'evaluation_object_tags',
        'evaluation_results', 'model_configurations', 'personal_pie_weights'
    ]) {
        if (!await tableExists(connection, tableName)) {
            throw new Error(`Required legacy source table is missing: ${tableName}`);
        }
    }
    for (const tableName of [
        'benchmarks', 'benchmark_conditions', 'benchmark_tags', 'benchmark_tag_links',
        'benchmark_results', 'model_conditions', 'personal_pie_weights_v15'
    ]) {
        if (await tableExists(connection, tableName)) {
            throw new Error(`Canonical target table already exists without migration record: ${tableName}`);
        }
    }
    const [[before]] = await connection.query(`
        SELECT
            (SELECT COUNT(*) FROM objects) AS benchmarkCount,
            (SELECT COUNT(*) FROM evaluation_profiles) AS benchmarkConditionCount,
            (SELECT COUNT(*) FROM model_configurations) AS modelConditionCount,
            (SELECT COUNT(*) FROM evaluation_results) AS resultCount,
            (SELECT COUNT(*) FROM personal_pie_weights) AS weightCount`);
    await createCanonicalTables(connection);
    await copyCanonicalData(connection);
    await migrateModerationContent(connection);
    await removeLegacySchema(connection);
    await assertCanonicalCounts(connection, before);
    await assertCanonicalSchema(connection);
    await connection.execute(
        'INSERT INTO schema_migrations (migration_id) VALUES (?)',
        [MIGRATION_ID]
    );
    return { applied: true, rows: before };
}

if (!APPLY) {
    console.log(JSON.stringify({
        migration: MIGRATION_ID,
        dryRun: true,
        creates: [
            'benchmarks', 'benchmark_conditions', 'benchmark_tags', 'benchmark_tag_links',
            'model_conditions', 'benchmark_results'
        ],
        removes: [
            'objects', 'evaluation_profiles', 'evaluation_tags', 'evaluation_object_tags',
            'model_configurations', 'evaluation_results', 'votes', 'category_templates'
        ],
        renames: [
            'models.url -> models.introduction_url',
            'ranking_contexts.template_values -> ranking_contexts.context_values',
            'ranking_contexts.template_hash -> ranking_contexts.context_hash'
        ],
        removesColumns: [
            'categories.template', 'categories.is_folder',
            'users.vote_quota', 'users.vote_used', 'vendors.url'
        ],
        clearsImplicitScoreRange: '0..100 rows without results',
        percentageRepresentation: 'uses_percentage_scale = 1; score_min/score_max = NULL'
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
