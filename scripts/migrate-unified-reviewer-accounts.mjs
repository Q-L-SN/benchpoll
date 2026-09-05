#!/usr/bin/env node

import 'dotenv/config';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const seniorUserArgument = process.argv.find(argument => argument.startsWith('--senior-user-id='));
const SENIOR_USER_ID = seniorUserArgument
    ? Number(seniorUserArgument.slice('--senior-user-id='.length))
    : null;
const MIGRATION_ID = '014_unified_reviewer_accounts';
const LOCK_NAME = 'benchpoll_unified_reviewer_accounts_migration';

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

function requireSeniorUserID() {
    if (!Number.isSafeInteger(SENIOR_USER_ID) || SENIOR_USER_ID < 1) {
        throw new Error('Pass the existing GitHub user ID with --senior-user-id=<positive integer>.');
    }
}

async function tableExists(connection, table) {
    const [rows] = await connection.execute(`
        SELECT 1
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table]);
    return rows.length === 1;
}

async function columnRecord(connection, table, column) {
    const [rows] = await connection.execute(`
        SELECT COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, column]);
    return rows[0] ?? null;
}

async function indexExists(connection, table, index) {
    const [rows] = await connection.execute(`
        SELECT 1
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
        LIMIT 1`, [table, index]);
    return rows.length === 1;
}

async function foreignKeyExists(connection, table, constraint) {
    const [rows] = await connection.execute(`
        SELECT 1
        FROM information_schema.TABLE_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND CONSTRAINT_NAME = ?
          AND CONSTRAINT_TYPE = 'FOREIGN KEY'`, [table, constraint]);
    return rows.length === 1;
}

async function dropForeignKeyIfPresent(connection, table, constraint) {
    if (await foreignKeyExists(connection, table, constraint)) {
        await connection.query(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${constraint}\``);
    }
}

async function dropIndexIfPresent(connection, table, index) {
    if (await indexExists(connection, table, index)) {
        await connection.query(`ALTER TABLE \`${table}\` DROP INDEX \`${index}\``);
    }
}

async function migrateAuditActor(connection) {
    if (!await tableExists(connection, 'moderation_audit_logs')) return;
    const oldColumn = await columnRecord(connection, 'moderation_audit_logs', 'reviewer_admin_ID');
    if (oldColumn) {
        await connection.execute(
            'UPDATE moderation_audit_logs SET reviewer_admin_ID = ?',
            [SENIOR_USER_ID]
        );
        await dropIndexIfPresent(connection, 'moderation_audit_logs', 'idx_moderation_audit_admin_created');
        await connection.query(`
            ALTER TABLE moderation_audit_logs
            CHANGE COLUMN reviewer_admin_ID reviewer_user_ID BIGINT UNSIGNED NOT NULL`);
    }
    const actorColumn = await columnRecord(connection, 'moderation_audit_logs', 'reviewer_user_ID');
    if (!actorColumn) throw new Error('moderation_audit_logs.reviewer_user_ID is missing.');
    if (String(actorColumn.columnType).toLowerCase() !== 'bigint unsigned') {
        await connection.query(`
            ALTER TABLE moderation_audit_logs
            MODIFY COLUMN reviewer_user_ID BIGINT UNSIGNED NOT NULL`);
    }
    if (!await indexExists(connection, 'moderation_audit_logs', 'idx_moderation_audit_user_created')) {
        await connection.query(`
            ALTER TABLE moderation_audit_logs
            ADD KEY idx_moderation_audit_user_created (reviewer_user_ID, created_at)`);
    }
    if (!await foreignKeyExists(connection, 'moderation_audit_logs', 'fk_moderation_audit_reviewer_user')) {
        await connection.query(`
            ALTER TABLE moderation_audit_logs
            ADD CONSTRAINT fk_moderation_audit_reviewer_user
            FOREIGN KEY (reviewer_user_ID) REFERENCES users (ID) ON DELETE RESTRICT`);
    }
}

async function migrateReviewerMessages(connection) {
    if (await tableExists(connection, 'admin_messages')) {
        await dropForeignKeyIfPresent(connection, 'admin_messages', 'fk_admin_messages_sender');
        const oldSender = await columnRecord(connection, 'admin_messages', 'sender_admin_ID');
        if (oldSender) {
            await connection.execute('UPDATE admin_messages SET sender_admin_ID = ?', [SENIOR_USER_ID]);
            await dropIndexIfPresent(connection, 'admin_messages', 'idx_admin_messages_sender_created');
            await connection.query(`
                ALTER TABLE admin_messages
                CHANGE COLUMN sender_admin_ID sender_user_ID BIGINT UNSIGNED NOT NULL`);
        }
        if (!await indexExists(connection, 'admin_messages', 'idx_admin_messages_sender_created')) {
            await connection.query(`
                ALTER TABLE admin_messages
                ADD KEY idx_admin_messages_sender_created (sender_user_ID, created_at)`);
        }
        if (!await foreignKeyExists(connection, 'admin_messages', 'fk_admin_messages_sender_user')) {
            await connection.query(`
                ALTER TABLE admin_messages
                ADD CONSTRAINT fk_admin_messages_sender_user
                FOREIGN KEY (sender_user_ID) REFERENCES users (ID) ON DELETE RESTRICT`);
        }
    }

    if (await tableExists(connection, 'admin_message_reads')) {
        await dropForeignKeyIfPresent(connection, 'admin_message_reads', 'fk_admin_message_reads_admin');
        const oldReader = await columnRecord(connection, 'admin_message_reads', 'admin_ID');
        if (oldReader) {
            await connection.execute('UPDATE admin_message_reads SET admin_ID = ?', [SENIOR_USER_ID]);
            await dropIndexIfPresent(connection, 'admin_message_reads', 'idx_admin_message_reads_admin');
            await connection.query(`
                ALTER TABLE admin_message_reads
                CHANGE COLUMN admin_ID user_ID BIGINT UNSIGNED NOT NULL`);
        }
        if (!await indexExists(connection, 'admin_message_reads', 'idx_admin_message_reads_user')) {
            await connection.query(`
                ALTER TABLE admin_message_reads
                ADD KEY idx_admin_message_reads_user (user_ID, read_at)`);
        }
        if (!await foreignKeyExists(connection, 'admin_message_reads', 'fk_admin_message_reads_user')) {
            await connection.query(`
                ALTER TABLE admin_message_reads
                ADD CONSTRAINT fk_admin_message_reads_user
                FOREIGN KEY (user_ID) REFERENCES users (ID) ON DELETE CASCADE`);
        }
    }
}

async function verifyMigration(connection) {
    const role = await columnRecord(connection, 'users', 'role');
    if (!role || String(role.columnType).toLowerCase() !== "enum('user','reviewer','senior')") {
        throw new Error('users.role does not have the expected enum definition.');
    }
    const [seniorRows] = await connection.execute(
        "SELECT role FROM users WHERE ID = ? AND deleted_at IS NULL",
        [SENIOR_USER_ID]
    );
    if (seniorRows[0]?.role !== 'senior') {
        throw new Error('The selected GitHub account is not assigned the senior role.');
    }
    if (await tableExists(connection, 'admin')) {
        throw new Error('The retired admin table still exists.');
    }
    const auditActor = await columnRecord(connection, 'moderation_audit_logs', 'reviewer_user_ID');
    if (!auditActor || String(auditActor.columnType).toLowerCase() !== 'bigint unsigned') {
        throw new Error('The moderation audit actor was not migrated to a user ID.');
    }
}

async function applyMigration(connection) {
    requireSeniorUserID();
    await connection.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            migration_id VARCHAR(128) NOT NULL,
            applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (migration_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    const [userRows] = await connection.execute(
        'SELECT ID FROM users WHERE ID = ? AND deleted_at IS NULL LIMIT 1',
        [SENIOR_USER_ID]
    );
    if (userRows.length !== 1) {
        throw new Error('The selected senior GitHub user does not exist or is deleted.');
    }
    const [existing] = await connection.execute(
        'SELECT applied_at FROM schema_migrations WHERE migration_id = ?',
        [MIGRATION_ID]
    );
    if (existing.length > 0) {
        await verifyMigration(connection);
        return { applied: false, verified: true, alreadyAppliedAt: existing[0].applied_at };
    }

    if (!await columnRecord(connection, 'users', 'role')) {
        await connection.query(`
            ALTER TABLE users
            ADD COLUMN role ENUM('user','reviewer','senior') NOT NULL DEFAULT 'user' AFTER name`);
    }
    await connection.execute("UPDATE users SET role = 'senior' WHERE ID = ?", [SENIOR_USER_ID]);

    if (await tableExists(connection, 'admin')) {
        const [admins] = await connection.execute('SELECT ID FROM admin ORDER BY ID');
        if (admins.length > 1) {
            throw new Error('Multiple legacy administrators require an explicit identity mapping before migration.');
        }
    }

    await migrateAuditActor(connection);
    await migrateReviewerMessages(connection);

    if (await tableExists(connection, 'admin')) {
        await connection.query('DROP TABLE admin');
    }
    await connection.execute('INSERT INTO schema_migrations (migration_id) VALUES (?)', [MIGRATION_ID]);
    await verifyMigration(connection);
    return { applied: true, verified: true, seniorUserID: SENIOR_USER_ID };
}

if (!APPLY) {
    console.log(JSON.stringify({
        migration: MIGRATION_ID,
        dryRun: true,
        requires: '--senior-user-id=<existing GitHub user ID>',
        changes: [
            'adds users.role',
            'moves reviewer audit and message ownership to users',
            'removes the legacy admin table'
        ]
    }, null, 2));
    process.exit(0);
}

const connection = await mysql.createConnection(databaseConfig());
try {
    const [[lock]] = await connection.query('SELECT GET_LOCK(?, 20) AS acquired', [LOCK_NAME]);
    if (Number(lock.acquired) !== 1) {
        throw new Error('Could not acquire the unified reviewer account migration lock.');
    }
    try {
        console.log(JSON.stringify({ migration: MIGRATION_ID, ...await applyMigration(connection) }, null, 2));
    } finally {
        await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
    }
} finally {
    await connection.end();
}
