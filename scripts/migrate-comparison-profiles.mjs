#!/usr/bin/env node

import 'dotenv/config';
import mysql from 'mysql2/promise';

const apply = process.argv.includes('--apply');
if (process.argv.slice(2).some(arg => arg !== '--apply')) throw Error('Usage: node scripts/migrate-comparison-profiles.mjs [--apply]');
const db = await mysql.createConnection({
    host: process.env.BENCHPOLL_DB_HOST || 'localhost',
    socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
    port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
    user: process.env.BENCHPOLL_DB_USER || 'root',
    password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', charset: 'utf8mb4'
});
let locked = false;
try {
    const [[row]] = await db.query("SELECT GET_LOCK('benchpoll_comparison_profiles_migration', 10) AS locked");
    if (Number(row.locked) !== 1) throw Error('Could not acquire comparison-profile migration lock');
    locked = true;
    const [migration] = await db.execute("SELECT migration_id FROM schema_migrations WHERE migration_id = '030_comparison_profiles'");
    const [tables] = await db.execute("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_comparison_profiles'");
    if (Boolean(migration.length) !== Boolean(tables.length)) throw Error('Comparison-profile schema and migration marker disagree');
    console.log(JSON.stringify({ applied: Boolean(migration.length), pending: !migration.length, dryRun: !apply }));
    if (apply && !migration.length) {
        await db.query(`CREATE TABLE user_comparison_profiles (
            user_ID BIGINT UNSIGNED NOT NULL,
            profile_key VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
            name VARCHAR(80) NOT NULL,
            comparison JSON NOT NULL,
            updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
            PRIMARY KEY (user_ID, profile_key),
            CONSTRAINT fk_comparison_profile_user FOREIGN KEY (user_ID) REFERENCES users(ID) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
        await db.execute("INSERT INTO schema_migrations (migration_id) VALUES ('030_comparison_profiles')");
        console.log(JSON.stringify({ applied: true }));
    }
} finally {
    if (locked) await db.query("SELECT RELEASE_LOCK('benchpoll_comparison_profiles_migration')");
    await db.end();
}
