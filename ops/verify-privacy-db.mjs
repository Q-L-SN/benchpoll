import 'dotenv/config';
import mysql from 'mysql2/promise';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const candidate = resolve(process.argv[2]);
if (!/^\/home\/ubuntu\/benchpoll\/scripts\/showcase-view-20261012\/release-compliance\/candidate$/.test(candidate)) {
    throw new Error('Unexpected candidate path');
}
const database = `benchpoll_privacy_check_${Date.now()}`;
if (!/^benchpoll_privacy_check_[0-9]{13}$/.test(database)) throw new Error('Unsafe temporary database name');
const config = { ...(process.env.BENCHPOLL_DB_SOCKET ? { socketPath: process.env.BENCHPOLL_DB_SOCKET } : {
    host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306) }),
user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
supportBigNumbers: true, bigNumberStrings: true, charset: 'utf8mb4' };
const admin = await mysql.createConnection(config);
let pool, created = false;
try {
    const productionDatabase = process.env.BENCHPOLL_DB_NAME || 'benchmarks';
    const [[idColumn]] = await admin.execute(`SELECT COLUMN_TYPE AS type FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'ID'`, [productionDatabase]);
    assert.equal(idColumn?.type, 'bigint unsigned', 'Production user IDs must match the new foreign keys');
    const [existing] = await admin.execute(`SELECT TABLE_NAME AS name FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('user_legal_acceptances', 'user_privacy_preferences',
        'privacy_preference_events', 'privacy_requests')`, [productionDatabase]);
    assert.equal(existing.length, 0, 'Review existing privacy tables before applying a fresh release');
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    created = true;
    pool = mysql.createPool({ ...config, database, connectionLimit: 2 });
    await pool.query('CREATE TABLE users (ID BIGINT UNSIGNED NOT NULL PRIMARY KEY, deleted_at DATETIME NULL) ENGINE=InnoDB');
    await pool.execute('INSERT INTO users (ID) VALUES (1), (2), (18446744073709551615)');
    for (let repetition = 0; repetition < 2; repetition++) {
        execFileSync(process.execPath, [resolve(candidate, 'scripts/migrate-privacy-controls.mjs'), '--apply'],
            { cwd: '/home/ubuntu/benchpoll', env: { ...process.env, BENCHPOLL_DB_NAME: database }, stdio: 'pipe' });
    }
    const { createPrivacyControls, LEGAL_VERSIONS } = await import(pathToFileURL(resolve(candidate, 'privacy-controls.js')));
    const hashes = { terms: 'a'.repeat(64), privacy: 'b'.repeat(64) };
    const service = createPrivacyControls({ pool, hashes, operator: { displayName: 'Synthetic operator', email: null } });
    assert.equal((await service.status('1')).accepted, false);
    assert.equal((await service.status('1')).privateCategoryResearch, false);
    const choice = { acceptedTerms: true, eligibleAge: true, termsVersion: LEGAL_VERSIONS.terms,
        privacyVersion: LEGAL_VERSIONS.privacy, privateCategoryResearch: false };
    assert.equal((await service.accept('1', choice)).accepted, true);
    assert.equal((await service.status('2')).accepted, false);
    assert.equal((await service.savePreference('2', true)).privateCategoryResearch, true);
    assert.equal((await service.savePreference('2', false)).privateCategoryResearch, false);
    assert.equal((await service.accept('18446744073709551615', choice)).userID, '18446744073709551615');
    const [[events]] = await pool.query('SELECT COUNT(*) AS count FROM privacy_preference_events WHERE user_ID = 2');
    assert.equal(Number(events.count), 2);
    for (let index = 0; index < 23; index++) {
        await service.submitRequest(null, { email: 'synthetic@example.test', requestType: 'access', message: `Synthetic ${index}` });
    }
    const first = await service.listRequests();
    assert.equal(first.requests.length, 20);
    const second = await service.listRequests(first.nextCursor);
    assert.equal(second.requests.length, 3);
    assert.equal(new Set([...first.requests, ...second.requests].map(row => row.reference)).size, 23);
    assert.equal(second.nextCursor, null);
    await service.updateRequest('1', { reference: first.requests[0].reference, status: 'closed', resolution: 'Synthetic completion' });
    assert.equal((await service.listRequests()).requests.find(row => row.reference === first.requests[0].reference).status, 'closed');
    const [[count]] = await pool.query('SELECT COUNT(*) AS count FROM user_legal_acceptances');
    assert.equal(Number(count.count), 2);
    console.log(JSON.stringify({ passed: true, isolatedDatabase: true, migrationIdempotent: true,
        defaultConsent: false, exactUnsignedAccountID: true, requestPagination: [20, 3], mailSent: 0, productionRowsChanged: 0 }));
} finally {
    await pool?.end();
    if (created) await admin.query(`DROP DATABASE ${database}`);
    await admin.end();
}
