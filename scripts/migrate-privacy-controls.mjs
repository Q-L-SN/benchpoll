import 'dotenv/config';
import mysql from 'mysql2/promise';

const migration = '20261017_privacy_controls';
const definitions = {
    user_legal_acceptances: `
        user_ID BIGINT UNSIGNED NOT NULL,
        terms_version VARCHAR(32) NOT NULL,
        privacy_version VARCHAR(32) NOT NULL,
        terms_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        privacy_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        eligible_age TINYINT UNSIGNED NOT NULL,
        accepted_at DATETIME(3) NOT NULL,
        PRIMARY KEY (user_ID, terms_version, privacy_version),
        FOREIGN KEY (user_ID) REFERENCES users (ID) ON DELETE CASCADE`,
    user_privacy_preferences: `
        user_ID BIGINT UNSIGNED NOT NULL,
        private_category_research TINYINT UNSIGNED NOT NULL DEFAULT 0,
        research_version VARCHAR(32) NOT NULL,
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (user_ID),
        FOREIGN KEY (user_ID) REFERENCES users (ID) ON DELETE CASCADE`,
    privacy_preference_events: `
        ID BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_ID BIGINT UNSIGNED NOT NULL,
        research_version VARCHAR(32) NOT NULL,
        enabled TINYINT UNSIGNED NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (ID), KEY privacy_preference_user (user_ID, created_at),
        FOREIGN KEY (user_ID) REFERENCES users (ID) ON DELETE CASCADE`,
    privacy_requests: `
        reference CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        user_ID BIGINT UNSIGNED NULL,
        email VARCHAR(320) NOT NULL,
        request_type ENUM('access', 'correction', 'erasure', 'objection', 'other') NOT NULL,
        message TEXT NOT NULL,
        status ENUM('open', 'in_review', 'closed') NOT NULL DEFAULT 'open',
        resolution TEXT NOT NULL,
        handled_by BIGINT UNSIGNED NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        due_at DATETIME(3) NOT NULL,
        PRIMARY KEY (reference), KEY privacy_request_page (created_at, reference),
        KEY privacy_request_status (status, due_at),
        FOREIGN KEY (user_ID) REFERENCES users (ID) ON DELETE SET NULL,
        FOREIGN KEY (handled_by) REFERENCES users (ID) ON DELETE SET NULL`
};

const apply = process.argv.includes('--apply');
const verify = process.argv.includes('--verify');
if (!apply && !verify) {
    console.log(JSON.stringify({ migration, dryRun: true, creates: Object.keys(definitions),
        destructive: false, defaults: 'No existing user is treated as having accepted or opted in.' }, null, 2));
} else {
    const password = process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD;
    if (!password) throw new Error('Database credentials are unavailable.');
    const connection = await mysql.createConnection({
        ...(process.env.BENCHPOLL_DB_SOCKET ? { socketPath: process.env.BENCHPOLL_DB_SOCKET } : {
            host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306) }),
        user: process.env.BENCHPOLL_DB_USER || 'root', password,
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', charset: 'utf8mb4'
    });
    try {
        await connection.query('SET SESSION lock_wait_timeout = 10');
        await connection.query('SET SESSION innodb_lock_wait_timeout = 10');
        const [[lock]] = await connection.execute('SELECT GET_LOCK(?, 20) AS acquired', [migration]);
        if (Number(lock.acquired) !== 1) throw new Error('Could not acquire privacy migration lock.');
        try {
            if (apply) {
                for (const [table, columns] of Object.entries(definitions)) {
                    await connection.query(`CREATE TABLE IF NOT EXISTS ${table} (${columns})
                        ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
                }
            }
            for (const [table, definition] of Object.entries(definitions)) {
                const [columns] = await connection.execute(`SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
                    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table]);
                const names = new Set(columns.map(row => row.name));
                const expected = [...definition.matchAll(/^\s+([a-z][a-z_]*|ID|user_ID)\s+(?:BIGINT|VARCHAR|CHAR|TINYINT|DATETIME|ENUM|TEXT)/gm)].map(match => match[1]);
                if (!expected.length || expected.some(name => !names.has(name))) throw new Error(`${table} schema verification failed.`);
            }
            if (apply) {
                await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
                    migration_id VARCHAR(128) NOT NULL PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
                await connection.execute('INSERT IGNORE INTO schema_migrations (migration_id) VALUES (?)', [migration]);
            }
            console.log(JSON.stringify({ migration, applied: apply, verified: true, tables: Object.keys(definitions) }, null, 2));
        } finally { await connection.execute('SELECT RELEASE_LOCK(?)', [migration]); }
    } finally { await connection.end(); }
}
