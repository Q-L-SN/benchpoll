import mysql from 'mysql2/promise';
import assert from 'node:assert/strict';
import { migratePrimaryBenchmarkConditions } from './migrate-primary-benchmark-conditions.mjs';

const db = await mysql.createConnection({ socketPath: '/var/run/mysqld/mysqld.sock', user: 'root', database: 'benchmarks' });
const rehearsal = 'benchpoll_primary_rehearsal_20261002';
let created = false;
try {
    await db.query(`CREATE DATABASE ${rehearsal}`);
    created = true;
    for (const table of ['benchmarks', 'benchmark_conditions', 'moderation_logs']) {
        await db.query(`CREATE TABLE ${rehearsal}.${table} LIKE benchmarks.${table}`);
        const [columns] = await db.query(`SELECT COLUMN_NAME FROM information_schema.columns
            WHERE table_schema = 'benchmarks' AND table_name = ? AND GENERATION_EXPRESSION = '' ORDER BY ORDINAL_POSITION`, [table]);
        const names = columns.map(column => '`' + column.COLUMN_NAME + '`').join(',');
        await db.query(`INSERT INTO ${rehearsal}.${table} (${names}) SELECT ${names} FROM benchmarks.${table}`);
    }
    await db.query(`CREATE TABLE ${rehearsal}.benchmark_results AS SELECT ID, benchmark_ID, benchmark_condition_ID,
        model_ID, status FROM benchmarks.benchmark_results`);
    await db.query(`USE ${rehearsal}`);
    const first = await migratePrimaryBenchmarkConditions(db);
    const [[benchmarkCount]] = await db.query('SELECT COUNT(*) count FROM benchmarks');
    assert.ok(first.initialized <= Number(benchmarkCount.count));
    const again = await migratePrimaryBenchmarkConditions(db);
    assert.equal(again.initialized, 0);
    assert.equal(again.upgradedLogIDs.length, 0);
    const [[before]] = await db.query('SELECT COUNT(*) count FROM benchmarks.benchmark_results');
    const [[after]] = await db.query('SELECT COUNT(*) count FROM benchmark_results');
    assert.equal(Number(after.count), Number(before.count));
    console.log(JSON.stringify({ initialized: first.initialized, upgradedLogs: first.upgradedLogIDs.length,
        idempotent: true, scoreCount: after.count }));
} finally {
    await db.query('USE benchmarks');
    if (created) await db.query(`DROP DATABASE ${rehearsal}`);
    await db.end();
}
