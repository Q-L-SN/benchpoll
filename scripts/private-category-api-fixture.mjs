#!/usr/bin/env node
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { randomBytes, createHmac } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';

dotenv.config({ path: '/home/ubuntu/benchpoll/.env', quiet: true });
const path = '/home/ubuntu/private-category-api-fixture.json';
const db = await mysql.createConnection({ socketPath: '/var/run/mysqld/mysqld.sock', user: 'root', database: 'benchmarks' });
const userIDs = ['81000220261002', '81000320261002'];
try {
    if (process.argv.includes('--cleanup')) {
        const fixture = JSON.parse(await readFile(path, 'utf8'));
        await db.beginTransaction();
        for (const item of fixture.accounts) {
            const [[user]] = await db.execute('SELECT name FROM users WHERE ID=?', [item.userID]);
            assert.equal(user?.name, 'Private category browser test');
            await db.execute('DELETE FROM sessions WHERE session_id=?', [item.sessionID]);
            await db.execute('DELETE FROM users WHERE ID=?', [item.userID]);
        }
        await db.execute('DELETE FROM categories WHERE ID=? AND name=? AND is_active=0',
            [fixture.retiredCategoryID, 'Retired browser test category']);
        await db.commit();
        await unlink(path);
        console.log('Private-category browser fixtures and sessions removed.');
    } else {
        assert.ok(process.env.SESSION_SECRET?.length >= 32);
        const fixture = { accounts: [] };
        await db.beginTransaction();
        for (const userID of userIDs) {
            await db.execute(`INSERT INTO users (ID,name,profile_picture_URL,followers_count)
                VALUES (?,'Private category browser test','/assets/favicon-32x32.png',0)`, [userID]);
            const sessionID = randomBytes(24).toString('base64url');
            const expires = new Date(Date.now() + 3600000);
            const data = { userID, cookie: { originalMaxAge: 3600000, expires, secure: true, httpOnly: true, path: '/', sameSite: 'lax' } };
            await db.execute('INSERT INTO sessions (session_id,expires,data) VALUES (?,?,?)',
                [sessionID, Math.floor(expires.getTime() / 1000), JSON.stringify(data)]);
            const signature = createHmac('sha256', process.env.SESSION_SECRET).update(sessionID).digest('base64').replace(/=+$/, '');
            fixture.accounts.push({ userID, sessionID, cookies: [{ name: 'sid', value: `s:${sessionID}.${signature}`,
                domain: 'benchpoll.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }] });
        }
        const [category] = await db.execute(`INSERT INTO categories (parent_ID,name,position,is_active)
            VALUES (NULL,'Retired browser test category',999,0)`);
        fixture.retiredCategoryID = Number(category.insertId);
        const [context] = await db.execute(`INSERT INTO ranking_contexts (category_ID,context_values,context_hash)
            VALUES (?, '{}', SHA2('{}',256))`, [category.insertId]);
        const [pie] = await db.execute(`INSERT INTO personal_pies (user_ID,context_ID,revision,updated_at)
            VALUES (?,?,9,'2026-09-03 00:00:00')`, [userIDs[0], context.insertId]);
        const [[condition]] = await db.query(`SELECT c.ID FROM benchmark_conditions c JOIN benchmark_results r
            ON r.benchmark_condition_ID=c.ID WHERE c.deleted_at IS NULL AND r.status='accepted' ORDER BY c.ID LIMIT 1`);
        await db.execute('INSERT INTO personal_pie_weights (pie_ID,benchmark_condition_ID,weight_basis_points) VALUES (?,?,10000)',
            [pie.insertId, condition.ID]);
        fixture.retiredPieID = Number(pie.insertId);
        await writeFile(path, JSON.stringify(fixture), { mode: 0o600 });
        await db.commit();
        console.log('Temporary browser accounts created; session cookies stored in an owner-only file.');
    }
} catch (error) { await db.rollback(); throw error; }
finally { await db.end(); }
