#!/usr/bin/env node

import 'dotenv/config';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const MIGRATION_ID = '011_moderation_admin_audit';
const UNIFIED_ACCOUNTS_MIGRATION_ID = '014_unified_reviewer_accounts';
const LOCK_NAME = 'benchpoll_moderation_admin_audit_migration';
const AUDIT_TABLE = 'moderation_audit_logs';

const REQUIRED_COLUMNS = new Map([
    ['ID', { type: 'bigint unsigned', nullable: false }],
    ['moderation_log_ID', { type: 'int unsigned', nullable: true }],
    ['reviewer_admin_ID', { type: 'int unsigned', nullable: false }],
    ['action_type', { type: 'varchar(48)', nullable: false }],
    ['request_type', { type: 'varchar(64)', nullable: false }],
    ['request_summary', { type: 'varchar(255)', nullable: false }],
    ['status_before', { type: 'varchar(32)', nullable: false }],
    ['status_after', { type: 'varchar(32)', nullable: false }],
    ['request_before', { type: 'json', nullable: false }],
    ['request_after', { type: 'json', nullable: true }],
    ['executed_sql', { type: 'longtext', nullable: false }],
    ['database_response', { type: 'json', nullable: false }],
    ['outcome', { type: "enum('success','failure')", nullable: false }],
    ['duration_ms', { type: 'int unsigned', nullable: false }],
    ['created_at', { type: 'datetime(3)', nullable: false }]
]);

const REQUIRED_INDEXES = new Map([
    ['PRIMARY', ['ID']],
    ['idx_moderation_audit_log_created', ['moderation_log_ID', 'created_at']],
    ['idx_moderation_audit_admin_created', ['reviewer_admin_ID', 'created_at']],
    ['idx_moderation_audit_action_created', ['action_type', 'created_at']]
]);

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

function failSchema(message) {
    throw new Error(`${AUDIT_TABLE} schema verification failed: ${message}`);
}

async function verifyAuditTable(connection) {
    const [tables] = await connection.execute(`
        SELECT ENGINE AS engine
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [AUDIT_TABLE]);
    if (tables.length !== 1) {
        failSchema('table is missing');
    }
    if (String(tables[0].engine).toLowerCase() !== 'innodb') {
        failSchema(`expected InnoDB, received ${tables[0].engine}`);
    }

    const [columns] = await connection.execute(`
        SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [AUDIT_TABLE]);
    const columnsByName = new Map(columns.map(column => [column.name, column]));
    for (const [name, expected] of REQUIRED_COLUMNS) {
        const actual = columnsByName.get(name);
        if (!actual) {
            failSchema(`required column ${name} is missing`);
        }
        if (String(actual.type).toLowerCase() !== expected.type) {
            failSchema(`column ${name} expected ${expected.type}, received ${actual.type}`);
        }
        const nullable = actual.nullable === 'YES';
        if (nullable !== expected.nullable) {
            failSchema(`column ${name} has an invalid nullability rule`);
        }
    }

    const [indexes] = await connection.execute(`
        SELECT INDEX_NAME AS name, COLUMN_NAME AS columnName, SEQ_IN_INDEX AS position
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        ORDER BY INDEX_NAME, SEQ_IN_INDEX`, [AUDIT_TABLE]);
    const indexesByName = new Map();
    for (const index of indexes) {
        const columnsForIndex = indexesByName.get(index.name) ?? [];
        columnsForIndex[Number(index.position) - 1] = index.columnName;
        indexesByName.set(index.name, columnsForIndex);
    }
    for (const [name, expectedColumns] of REQUIRED_INDEXES) {
        const actualColumns = indexesByName.get(name);
        if (!actualColumns || actualColumns.join(',') !== expectedColumns.join(',')) {
            failSchema(`index ${name} expected (${expectedColumns.join(', ')}), received (${actualColumns?.join(', ') ?? 'missing'})`);
        }
    }

    const [foreignKeys] = await connection.execute(`
        SELECT kcu.CONSTRAINT_NAME AS name,
               kcu.COLUMN_NAME AS columnName,
               kcu.REFERENCED_TABLE_NAME AS referencedTable,
               kcu.REFERENCED_COLUMN_NAME AS referencedColumn,
               rc.DELETE_RULE AS deleteRule
        FROM information_schema.KEY_COLUMN_USAGE AS kcu
        JOIN information_schema.REFERENTIAL_CONSTRAINTS AS rc
          ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
         AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
        WHERE kcu.TABLE_SCHEMA = DATABASE()
          AND kcu.TABLE_NAME = ?
          AND kcu.REFERENCED_TABLE_NAME IS NOT NULL`, [AUDIT_TABLE]);
    const moderationLogForeignKey = foreignKeys.find(key => key.name === 'fk_moderation_audit_log');
    if (!moderationLogForeignKey
        || moderationLogForeignKey.columnName !== 'moderation_log_ID'
        || moderationLogForeignKey.referencedTable !== 'moderation_logs'
        || moderationLogForeignKey.referencedColumn !== 'ID'
        || moderationLogForeignKey.deleteRule !== 'SET NULL') {
        failSchema('foreign key fk_moderation_audit_log is missing or invalid');
    }
}

async function verifyUnifiedAuditTable(connection) {
    const reviewerColumn = await connection.execute(`
        SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = 'reviewer_user_ID'`, [AUDIT_TABLE]);
    const reviewer = reviewerColumn[0][0];
    if (!reviewer
        || String(reviewer.type).toLowerCase() !== 'bigint unsigned'
        || reviewer.nullable !== 'NO') {
        failSchema('reviewer_user_ID is missing or invalid after the unified-account migration');
    }
    const [legacyColumns] = await connection.execute(`
        SELECT 1
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = 'reviewer_admin_ID'`, [AUDIT_TABLE]);
    if (legacyColumns.length > 0) {
        failSchema('legacy reviewer_admin_ID still exists after the unified-account migration');
    }
}

async function applyMigration(connection) {
    await connection.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            migration_id VARCHAR(128) NOT NULL,
            applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (migration_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    const [unifiedAccounts] = await connection.execute(
        'SELECT applied_at FROM schema_migrations WHERE migration_id = ?',
        [UNIFIED_ACCOUNTS_MIGRATION_ID]
    );
    if (unifiedAccounts.length > 0) {
        await verifyUnifiedAuditTable(connection);
        return {
            applied: false,
            verified: true,
            supersededBy: UNIFIED_ACCOUNTS_MIGRATION_ID
        };
    }
    const [existing] = await connection.execute(
        'SELECT applied_at FROM schema_migrations WHERE migration_id = ?',
        [MIGRATION_ID]
    );
    if (existing.length > 0) {
        await verifyAuditTable(connection);
        return { applied: false, verified: true, alreadyAppliedAt: existing[0].applied_at };
    }

    await connection.query(`
        CREATE TABLE IF NOT EXISTS moderation_audit_logs (
            ID BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            moderation_log_ID INT UNSIGNED NULL,
            reviewer_admin_ID INT UNSIGNED NOT NULL,
            action_type VARCHAR(48) NOT NULL,
            request_type VARCHAR(64) NOT NULL,
            request_summary VARCHAR(255) NOT NULL,
            status_before VARCHAR(32) NOT NULL,
            status_after VARCHAR(32) NOT NULL,
            request_before JSON NOT NULL,
            request_after JSON NULL,
            executed_sql LONGTEXT NOT NULL,
            database_response JSON NOT NULL,
            outcome ENUM('success','failure') NOT NULL,
            duration_ms INT UNSIGNED NOT NULL,
            created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            PRIMARY KEY (ID),
            KEY idx_moderation_audit_log_created (moderation_log_ID, created_at),
            KEY idx_moderation_audit_admin_created (reviewer_admin_ID, created_at),
            KEY idx_moderation_audit_action_created (action_type, created_at),
            CONSTRAINT fk_moderation_audit_log
                FOREIGN KEY (moderation_log_ID) REFERENCES moderation_logs (ID) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await verifyAuditTable(connection);
    await connection.execute('INSERT INTO schema_migrations (migration_id) VALUES (?)', [MIGRATION_ID]);
    return { applied: true, verified: true, creates: [AUDIT_TABLE] };
}

if (!APPLY) {
    console.log(JSON.stringify({
        migration: MIGRATION_ID,
        dryRun: true,
        creates: [AUDIT_TABLE]
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
