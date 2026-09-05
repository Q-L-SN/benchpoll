#!/usr/bin/env node

import 'dotenv/config';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const MIGRATION_ID = '010_session_integrity';
const LOCK_NAME = 'benchpoll_session_integrity_migration';

function databaseConfig() {
    const password = process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD;
    if (password === undefined) throw new Error('Database credentials are unavailable.');
    return {
        host: process.env.BENCHPOLL_DB_HOST || 'localhost',
        port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
        user: process.env.BENCHPOLL_DB_USER || 'root',
        password,
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks',
        charset: 'utf8mb4'
    };
}

async function scalar(connection, sql, params = []) {
    const [rows] = await connection.execute(sql, params);
    return Number(Object.values(rows[0] ?? { value: 0 })[0]);
}

async function foreignKeyForColumn(connection, columnName) {
    const [rows] = await connection.execute(`
        SELECT key_usage.CONSTRAINT_NAME, referential.DELETE_RULE,
               key_usage.REFERENCED_TABLE_NAME, key_usage.REFERENCED_COLUMN_NAME
        FROM information_schema.KEY_COLUMN_USAGE AS key_usage
        JOIN information_schema.REFERENTIAL_CONSTRAINTS AS referential
          ON referential.CONSTRAINT_SCHEMA = key_usage.CONSTRAINT_SCHEMA
         AND referential.TABLE_NAME = key_usage.TABLE_NAME
         AND referential.CONSTRAINT_NAME = key_usage.CONSTRAINT_NAME
        WHERE key_usage.CONSTRAINT_SCHEMA = DATABASE()
          AND key_usage.TABLE_NAME = 'user_sessions'
          AND key_usage.COLUMN_NAME = ?`, [columnName]);
    if (rows.length > 1) {
        throw new Error(`user_sessions.${columnName} has multiple foreign keys.`);
    }
    return rows[0] ?? null;
}

async function verifyPostconditions(connection) {
    const orphanSessions = await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM user_sessions
        LEFT JOIN sessions ON sessions.session_id = user_sessions.session_ID
        WHERE sessions.session_id IS NULL`);
    const orphanUsers = await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM user_sessions
        LEFT JOIN users ON users.ID = user_sessions.user_ID
        WHERE users.ID IS NULL`);
    if (orphanSessions !== 0 || orphanUsers !== 0) {
        throw new Error(`Session mappings still contain ${orphanSessions} missing sessions and ${orphanUsers} missing users.`);
    }

    const sessionForeignKey = await foreignKeyForColumn(connection, 'session_ID');
    const userForeignKey = await foreignKeyForColumn(connection, 'user_ID');
    if (sessionForeignKey?.REFERENCED_TABLE_NAME !== 'sessions'
        || sessionForeignKey?.REFERENCED_COLUMN_NAME !== 'session_id'
        || sessionForeignKey?.DELETE_RULE !== 'CASCADE') {
        throw new Error('user_sessions.session_ID must cascade from sessions.session_id.');
    }
    if (userForeignKey?.REFERENCED_TABLE_NAME !== 'users'
        || userForeignKey?.REFERENCED_COLUMN_NAME !== 'ID'
        || userForeignKey?.DELETE_RULE !== 'CASCADE') {
        throw new Error('user_sessions.user_ID must cascade from users.ID.');
    }

    const [collations] = await connection.execute(`
        SELECT TABLE_NAME, COLLATION_NAME
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND ((TABLE_NAME = 'sessions' AND COLUMN_NAME = 'session_id')
            OR (TABLE_NAME = 'user_sessions' AND COLUMN_NAME = 'session_ID'))`);
    if (collations.length !== 2
        || collations.some(row => row.COLLATION_NAME !== 'utf8mb4_bin')) {
        throw new Error('Session identifier columns must both use utf8mb4_bin.');
    }
}

async function ensureNoConflictingForeignKey(connection, columnName) {
    const foreignKey = await foreignKeyForColumn(connection, columnName);
    if (!foreignKey) return false;
    const expected = columnName === 'session_ID'
        ? { table: 'sessions', column: 'session_id' }
        : { table: 'users', column: 'ID' };
    if (foreignKey.REFERENCED_TABLE_NAME !== expected.table
        || foreignKey.REFERENCED_COLUMN_NAME !== expected.column
        || foreignKey.DELETE_RULE !== 'CASCADE') {
        throw new Error(`user_sessions.${columnName} has an incompatible foreign key; manual resolution is required.`);
    }
    return true;
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
        await verifyPostconditions(connection);
        return { applied: false, verified: true, alreadyAppliedAt: existing[0].applied_at };
    }

    const orphanSessionsRemoved = await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM user_sessions
        LEFT JOIN sessions ON sessions.session_id = user_sessions.session_ID
        WHERE sessions.session_id IS NULL`);
    const orphanUsersRemoved = await scalar(connection, `
        SELECT COUNT(*) AS count
        FROM user_sessions
        LEFT JOIN users ON users.ID = user_sessions.user_ID
        WHERE users.ID IS NULL`);
    await connection.execute(`
        DELETE user_sessions
        FROM user_sessions
        LEFT JOIN sessions ON sessions.session_id = user_sessions.session_ID
        LEFT JOIN users ON users.ID = user_sessions.user_ID
        WHERE sessions.session_id IS NULL OR users.ID IS NULL`);

    await connection.query(`
        ALTER TABLE user_sessions
        MODIFY session_ID VARCHAR(128)
            CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL`);

    if (!await ensureNoConflictingForeignKey(connection, 'session_ID')) {
        await connection.query(`
            ALTER TABLE user_sessions
            ADD CONSTRAINT fk_user_sessions_session
            FOREIGN KEY (session_ID) REFERENCES sessions(session_id)
            ON DELETE CASCADE ON UPDATE CASCADE`);
    }
    if (!await ensureNoConflictingForeignKey(connection, 'user_ID')) {
        await connection.query(`
            ALTER TABLE user_sessions
            ADD CONSTRAINT fk_user_sessions_user
            FOREIGN KEY (user_ID) REFERENCES users(ID)
            ON DELETE CASCADE ON UPDATE CASCADE`);
    }

    await verifyPostconditions(connection);
    await connection.execute('INSERT INTO schema_migrations (migration_id) VALUES (?)', [MIGRATION_ID]);
    return { applied: true, orphanSessionsRemoved, orphanUsersRemoved };
}

if (!APPLY) {
    console.log(JSON.stringify({
        migration: MIGRATION_ID,
        dryRun: true,
        changes: [
            'remove user-session mappings whose session or user no longer exists',
            'align session identifier collations',
            'cascade user-session mappings when sessions or users are deleted'
        ]
    }, null, 2));
    process.exit(0);
}

const connection = await mysql.createConnection(databaseConfig());
try {
    const [[lock]] = await connection.query('SELECT GET_LOCK(?, 20) AS acquired', [LOCK_NAME]);
    if (Number(lock.acquired) !== 1) throw new Error('Could not acquire the database migration lock.');
    try {
        console.log(JSON.stringify({ migration: MIGRATION_ID, ...await applyMigration(connection) }, null, 2));
    } finally {
        await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
    }
} finally {
    await connection.end();
}
