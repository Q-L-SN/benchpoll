import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';

const stage = resolve(process.argv[2] || '.');
if (!/^\/home\/ubuntu\/benchpoll\/scripts\/topics-taxonomy-20261026\/topics-taxonomy-20261026-\d+$/.test(stage)) throw new Error('Unsafe score verification stage');
if (process.env.BENCHPOLL_DB_USER !== 'root') throw new Error('Use the operational read account');
const { getBenchmarkScores } = await import(join(stage, 'candidate/benchmark-scores.js'));
const pool = mysql.createPool({ user: 'root', password: process.env.DB_PASSWORD,
    socketPath: process.env.BENCHPOLL_DB_SOCKET || '/var/run/mysqld/mysqld.sock', database: 'benchmarks',
    connectionLimit: 1, supportBigNumbers: true, bigNumberStrings: true });
const report = { passed: false, readOnly: true, pages: [] };
try {
    const [[condition]] = await pool.query(`SELECT r.benchmark_ID AS benchmarkID, r.benchmark_condition_ID AS conditionID, COUNT(*) AS count
        FROM benchmark_results r JOIN benchmark_conditions c ON c.ID = r.benchmark_condition_ID
        JOIN benchmarks b ON b.ID = c.benchmark_ID
        WHERE r.status = 'accepted' AND c.is_primary = 1 AND c.deleted_at IS NULL AND b.is_active = 1
        GROUP BY r.benchmark_ID, r.benchmark_condition_ID ORDER BY count DESC LIMIT 1`);
    assert.ok(condition && Number(condition.count) > 100);
    const seen = new Set(); let cursor, previous;
    for (let index = 0; index < 3; index++) {
        const started = performance.now();
        const page = await getBenchmarkScores(pool, { benchmarkID: Number(condition.benchmarkID),
            conditionID: Number(condition.conditionID), ...(cursor ? { beforeID: cursor } : {}) });
        assert.equal(page.scores.length, 50);
        for (const row of page.scores) {
            assert.equal(seen.has(row.ID), false);
            if (previous) assert.ok(previous.rawScore > row.rawScore || previous.rawScore === row.rawScore && previous.ID > row.ID);
            seen.add(row.ID); previous = row;
        }
        report.pages.push({ rows: page.scores.length, first: page.scores[0].rawScore,
            last: page.scores.at(-1).rawScore, elapsedMS: Math.round(performance.now() - started) });
        cursor = page.nextBeforeID;
    }
    const [[decimal]] = await pool.query(`SELECT CAST('999999999999.123456' AS DECIMAL(18,6)) = CAST(? AS DECIMAL(18,6)) AS exact,
        CAST('999999999999.123455' AS DECIMAL(18,6)) < CAST(? AS DECIMAL(18,6)) AS lower`,
    ['999999999999.123456', '999999999999.123456']);
    assert.equal(Number(decimal.exact), 1); assert.equal(Number(decimal.lower), 1);
    report.verifiedScores = seen.size; report.decimalBoundaryExact = true; report.passed = true;
} catch (error) { report.failure = error.stack; throw error; }
finally { await pool.end(); await writeFile(join(stage, 'benchmark-order.json'), JSON.stringify(report, null, 2), { mode: 0o600 }); }
console.log(JSON.stringify(report));
