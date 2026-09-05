import 'dotenv/config';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const MIGRATION_ID = '013_moderation_email_notifications';
const LOCK_NAME = 'benchpoll_moderation_email_notifications_migration';
const OUTBOX_TABLE = 'moderation_email_outbox';

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

async function columnNames(connection, table) {
    const [rows] = await connection.execute(`
        SELECT COLUMN_NAME AS name
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table]);
    return new Set(rows.map(row => row.name));
}

async function tableExists(connection, table) {
    const [rows] = await connection.execute(`
        SELECT 1
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table]);
    return rows.length === 1;
}

async function verifySchema(connection) {
    const userColumns = await columnNames(connection, 'users');
    for (const name of ['email', 'email_verified_at']) {
        if (!userColumns.has(name)) {
            throw new Error(`users schema verification failed: ${name} is missing`);
        }
    }
    if (!await tableExists(connection, OUTBOX_TABLE)) {
        throw new Error(`${OUTBOX_TABLE} schema verification failed: table is missing`);
    }
    const outboxColumns = await columnNames(connection, OUTBOX_TABLE);
    for (const name of [
        'ID',
        'moderation_log_ID',
        'user_ID',
        'recipient_email',
        'decision',
        'contribution_type',
        'delivery_status',
        'attempt_count',
        'next_attempt_at',
        'locked_at',
        'sent_at',
        'last_error',
        'created_at',
        'updated_at'
    ]) {
        if (!outboxColumns.has(name)) {
            throw new Error(`${OUTBOX_TABLE} schema verification failed: ${name} is missing`);
        }
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
        await verifySchema(connection);
        return { applied: false, verified: true, alreadyAppliedAt: existing[0].applied_at };
    }

    const userColumns = await columnNames(connection, 'users');
    if (!userColumns.has('email')) {
        await connection.query('ALTER TABLE users ADD COLUMN email VARCHAR(320) NULL AFTER profile_picture_URL');
    }
    if (!userColumns.has('email_verified_at')) {
        await connection.query('ALTER TABLE users ADD COLUMN email_verified_at DATETIME(3) NULL AFTER email');
    }
    await connection.query(`
        CREATE TABLE ${OUTBOX_TABLE} (
            ID BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            moderation_log_ID INT UNSIGNED NOT NULL,
            user_ID BIGINT UNSIGNED NOT NULL,
            recipient_email VARCHAR(320) NULL,
            decision ENUM('approved', 'rejected') NOT NULL,
            contribution_type VARCHAR(64) NOT NULL,
            delivery_status ENUM('pending', 'sending', 'sent', 'failed') NOT NULL DEFAULT 'pending',
            attempt_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
            next_attempt_at DATETIME(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
            locked_at DATETIME(3) NULL,
            sent_at DATETIME(3) NULL,
            last_error VARCHAR(1000) NULL,
            created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
            PRIMARY KEY (ID),
            UNIQUE KEY uq_moderation_email_outbox_log (moderation_log_ID),
            KEY idx_moderation_email_outbox_delivery (delivery_status, next_attempt_at),
            KEY idx_moderation_email_outbox_user (user_ID, created_at),
            CONSTRAINT fk_moderation_email_outbox_log
                FOREIGN KEY (moderation_log_ID) REFERENCES moderation_logs (ID) ON DELETE CASCADE,
            CONSTRAINT fk_moderation_email_outbox_user
                FOREIGN KEY (user_ID) REFERENCES users (ID) ON DELETE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await verifySchema(connection);
    await connection.execute('INSERT INTO schema_migrations (migration_id) VALUES (?)', [MIGRATION_ID]);
    return {
        applied: true,
        verified: true,
        alters: ['users.email', 'users.email_verified_at'],
        creates: [OUTBOX_TABLE]
    };
}

if (!APPLY) {
    console.log(JSON.stringify({
        migration: MIGRATION_ID,
        dryRun: true,
        alters: ['users.email', 'users.email_verified_at'],
        creates: [OUTBOX_TABLE]
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
