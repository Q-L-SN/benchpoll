#!/usr/bin/env node

import 'dotenv/config';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const MIGRATION_ID = '012_admin_messages';
const UNIFIED_ACCOUNTS_MIGRATION_ID = '014_unified_reviewer_accounts';
const LOCK_NAME = 'benchpoll_admin_messages_migration';

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

async function tableExists(connection, table) {
    const [rows] = await connection.execute(`
        SELECT 1
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table]);
    return rows.length === 1;
}

async function verifySchema(connection) {
    for (const table of ['admin_messages', 'admin_message_reads']) {
        if (!await tableExists(connection, table)) {
            throw new Error(`${table} schema verification failed: table is missing`);
        }
    }
    const [messageColumns] = await connection.execute(`
        SELECT COLUMN_NAME AS name
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admin_messages'`);
    const messageColumnNames = new Set(messageColumns.map(column => column.name));
    for (const name of ['ID', 'sender_admin_ID', 'recipient_scope', 'body', 'created_at']) {
        if (!messageColumnNames.has(name)) {
            throw new Error(`admin_messages schema verification failed: ${name} is missing`);
        }
    }
    const [readColumns] = await connection.execute(`
        SELECT COLUMN_NAME AS name
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admin_message_reads'`);
    const readColumnNames = new Set(readColumns.map(column => column.name));
    for (const name of ['message_ID', 'admin_ID', 'read_at']) {
        if (!readColumnNames.has(name)) {
            throw new Error(`admin_message_reads schema verification failed: ${name} is missing`);
        }
    }
}

async function verifyUnifiedSchema(connection) {
    for (const table of ['admin_messages', 'admin_message_reads']) {
        if (!await tableExists(connection, table)) {
            throw new Error(`${table} schema verification failed: table is missing`);
        }
    }
    const [messageColumns] = await connection.execute(`
        SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admin_messages'`);
    const messages = new Map(messageColumns.map(column => [column.name, column]));
    if (String(messages.get('sender_user_ID')?.type).toLowerCase() !== 'bigint unsigned'
        || messages.has('sender_admin_ID')) {
        throw new Error('admin_messages schema verification failed: sender is not an ordinary user ID');
    }
    const [readColumns] = await connection.execute(`
        SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admin_message_reads'`);
    const reads = new Map(readColumns.map(column => [column.name, column]));
    if (String(reads.get('user_ID')?.type).toLowerCase() !== 'bigint unsigned'
        || reads.has('admin_ID')) {
        throw new Error('admin_message_reads schema verification failed: reader is not an ordinary user ID');
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
        await verifyUnifiedSchema(connection);
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
        await verifySchema(connection);
        return { applied: false, verified: true, alreadyAppliedAt: existing[0].applied_at };
    }

    await connection.query(`
        CREATE TABLE admin_messages (
            ID BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            sender_admin_ID INT UNSIGNED NOT NULL,
            recipient_scope ENUM('senior') NOT NULL DEFAULT 'senior',
            body TEXT NOT NULL,
            created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            PRIMARY KEY (ID),
            KEY idx_admin_messages_created (created_at),
            KEY idx_admin_messages_sender_created (sender_admin_ID, created_at),
            CONSTRAINT fk_admin_messages_sender
                FOREIGN KEY (sender_admin_ID) REFERENCES admin (ID) ON DELETE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await connection.query(`
        CREATE TABLE admin_message_reads (
            message_ID BIGINT UNSIGNED NOT NULL,
            admin_ID INT UNSIGNED NOT NULL,
            read_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            PRIMARY KEY (message_ID, admin_ID),
            KEY idx_admin_message_reads_admin (admin_ID, read_at),
            CONSTRAINT fk_admin_message_reads_message
                FOREIGN KEY (message_ID) REFERENCES admin_messages (ID) ON DELETE CASCADE,
            CONSTRAINT fk_admin_message_reads_admin
                FOREIGN KEY (admin_ID) REFERENCES admin (ID) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await verifySchema(connection);
    await connection.execute('INSERT INTO schema_migrations (migration_id) VALUES (?)', [MIGRATION_ID]);
    return { applied: true, verified: true, creates: ['admin_messages', 'admin_message_reads'] };
}

if (!APPLY) {
    console.log(JSON.stringify({
        migration: MIGRATION_ID,
        dryRun: true,
        creates: ['admin_messages', 'admin_message_reads']
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
