#!/usr/bin/env node
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { pathToFileURL } from 'node:url';

export async function migratePrivateCategories(db) {
    const [[column]] = await db.query(`SELECT COUNT(*) count FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'categories' AND column_name = 'owner_user_ID'`);
    if (!Number(column.count)) {
        const [[user]] = await db.query(`SELECT COLUMN_TYPE type FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'ID'`);
        if (!/^(?:bigint|int)(?: unsigned)?$/.test(user.type)) throw new Error('Unexpected user ID type');
        await db.query(`ALTER TABLE categories ADD COLUMN owner_user_ID ${user.type} NULL,
            ADD CONSTRAINT fk_categories_owner FOREIGN KEY (owner_user_ID) REFERENCES users(ID) ON DELETE CASCADE,
            ADD UNIQUE KEY uq_private_category_owner_name (owner_user_ID, name),
            ADD CONSTRAINT chk_private_category_root CHECK (owner_user_ID IS NULL OR parent_ID IS NULL)`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const db = await mysql.createConnection(process.env.DB_SOCKET ? {
        socketPath: process.env.DB_SOCKET, user: 'root', database: 'benchmarks'
    } : { host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
    try { await migratePrivateCategories(db); console.log('Private category schema verified.'); }
    finally { await db.end(); }
}
