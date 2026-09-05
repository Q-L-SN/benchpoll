#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const MIGRATION_ID = '022_personal_fallback_rules';
const PREVIOUS_MIGRATION_ID = '021_context_free_results';
const LOCK_NAME = 'benchpoll_personal_fallback_rules_migration';
const RULE_TABLE = 'personal_pie_score_rules';
const COMPONENT_TABLE = 'personal_pie_score_rule_components';

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

async function tableExists(connection, tableName) {
    const [rows] = await connection.execute(`
        SELECT 1
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        LIMIT 1`, [tableName]);
    return rows.length === 1;
}

async function tableColumns(connection, tableName) {
    const [rows] = await connection.execute(`
        SELECT COLUMN_NAME
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`, [tableName]);
    return rows.map(row => row.COLUMN_NAME);
}

async function foreignKeys(connection, tableName) {
    const [rows] = await connection.execute(`
        SELECT CONSTRAINT_NAME, REFERENCED_TABLE_NAME, DELETE_RULE
        FROM information_schema.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ?
        ORDER BY CONSTRAINT_NAME`, [tableName]);
    return rows.map(row => ({
        name: row.CONSTRAINT_NAME,
        referencedTable: row.REFERENCED_TABLE_NAME,
        deleteRule: row.DELETE_RULE
    }));
}

async function schemaState(connection) {
    const ruleTable = await tableExists(connection, RULE_TABLE);
    const componentTable = await tableExists(connection, COMPONENT_TABLE);
    return {
        ruleTable,
        componentTable,
        ruleColumns: ruleTable ? await tableColumns(connection, RULE_TABLE) : [],
        componentColumns: componentTable ? await tableColumns(connection, COMPONENT_TABLE) : [],
        ruleForeignKeys: ruleTable ? await foreignKeys(connection, RULE_TABLE) : [],
        componentForeignKeys: componentTable ? await foreignKeys(connection, COMPONENT_TABLE) : []
    };
}

function sameValues(actual, expected) {
    return JSON.stringify(actual) === JSON.stringify(expected);
}

async function verifyPostconditions(connection) {
    const state = await schemaState(connection);
    const expectedRuleColumns = [
        'pie_ID',
        'primary_benchmark_condition_ID',
        'mode',
        'created_at',
        'updated_at'
    ];
    const expectedComponentColumns = [
        'pie_ID',
        'primary_benchmark_condition_ID',
        'fallback_benchmark_condition_ID',
        'weight_basis_points',
        'created_at',
        'updated_at'
    ];
    if (!state.ruleTable || !state.componentTable
        || !sameValues(state.ruleColumns, expectedRuleColumns)
        || !sameValues(state.componentColumns, expectedComponentColumns)) {
        throw new Error(`Personal fallback schema invariant failed: ${JSON.stringify(state)}`);
    }
    const rulePrimary = state.ruleForeignKeys.find(key => key.name === 'fk_pie_score_rule_primary_weight');
    const componentRule = state.componentForeignKeys.find(key => key.name === 'fk_pie_score_component_rule');
    const componentFallback = state.componentForeignKeys.find(key => key.name === 'fk_pie_score_component_fallback');
    if (rulePrimary?.referencedTable !== 'personal_pie_weights' || rulePrimary.deleteRule !== 'CASCADE'
        || componentRule?.referencedTable !== RULE_TABLE || componentRule.deleteRule !== 'CASCADE'
        || componentFallback?.referencedTable !== 'benchmark_conditions' || componentFallback.deleteRule !== 'RESTRICT') {
        throw new Error(`Personal fallback foreign-key invariant failed: ${JSON.stringify(state)}`);
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
    if (before.ruleTable || before.componentTable) {
        throw new Error(`Unmarked partial personal fallback schema exists: ${JSON.stringify(before)}`);
    }

    await connection.query(`
        CREATE TABLE personal_pie_score_rules (
            pie_ID BIGINT UNSIGNED NOT NULL,
            primary_benchmark_condition_ID BIGINT UNSIGNED NOT NULL,
            mode ENUM('fallback_if_missing') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (pie_ID, primary_benchmark_condition_ID),
            CONSTRAINT fk_pie_score_rule_primary_weight
                FOREIGN KEY (pie_ID, primary_benchmark_condition_ID)
                REFERENCES personal_pie_weights (pie_ID, benchmark_condition_ID)
                ON DELETE CASCADE,
            CONSTRAINT chk_pie_score_rule_mode
                CHECK (mode = 'fallback_if_missing')
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    await connection.query(`
        CREATE TABLE personal_pie_score_rule_components (
            pie_ID BIGINT UNSIGNED NOT NULL,
            primary_benchmark_condition_ID BIGINT UNSIGNED NOT NULL,
            fallback_benchmark_condition_ID BIGINT UNSIGNED NOT NULL,
            weight_basis_points SMALLINT UNSIGNED NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (
                pie_ID,
                primary_benchmark_condition_ID,
                fallback_benchmark_condition_ID
            ),
            KEY idx_pie_score_component_fallback (fallback_benchmark_condition_ID),
            CONSTRAINT fk_pie_score_component_rule
                FOREIGN KEY (pie_ID, primary_benchmark_condition_ID)
                REFERENCES personal_pie_score_rules (pie_ID, primary_benchmark_condition_ID)
                ON DELETE CASCADE,
            CONSTRAINT fk_pie_score_component_fallback
                FOREIGN KEY (fallback_benchmark_condition_ID)
                REFERENCES benchmark_conditions (ID)
                ON DELETE RESTRICT,
            CONSTRAINT chk_pie_score_component_weight
                CHECK (weight_basis_points BETWEEN 100 AND 10000),
            CONSTRAINT chk_pie_score_component_not_self
                CHECK (primary_benchmark_condition_ID <> fallback_benchmark_condition_ID)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

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
