import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { savePersonalPie as candidate } from '../ranking-service.js';

const [baselineFilename, output] = process.argv.slice(2);
assert.ok(baselineFilename && output, 'Usage: baseline-module output.json');
const { savePersonalPie: baseline } = await import(new URL(baselineFilename, import.meta.url));
const samples = JSON.parse(await readFile(new URL('../artifacts/ranking-speed-20261006/before.json', import.meta.url), 'utf8'));
const connection = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || '/var/run/mysqld/mysqld.sock',
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', timezone: 'Z' });
const report = { createdAt: new Date().toISOString(), writes: false,
    scope: 'Real production comparison pre-validation; authorization deliberately denied before any mutation', cases: [] };
try {
    for (const size of [10, 100]) for (const repeat of [1, 2]) {
        const timings = {};
        for (const [name, save] of [['before', baseline], ['after', candidate]]) {
            const queries = [];
            const db = { getConnection: async () => new Proxy(connection, { get(target, key) {
                if (key === 'release') return () => {};
                if (key === 'commit') return () => { throw new Error('A read-only validation probe must not commit'); };
                if (['query', 'execute'].includes(key)) return async (sql, ...args) => {
                    // Stop at authorization instead of touching a real user's pie.
                    if (/^\s*SELECT ID\s+FROM users\s+WHERE ID = \?/i.test(sql)) return [[], []];
                    assert.match(sql.trim(), /^(?:SELECT|WITH)\s/i, 'Mutation SQL is forbidden in this probe');
                    const start = performance.now();
                    try { return await target[key](sql, ...args); }
                    finally { queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), ms: Math.round(performance.now() - start) }); }
                };
                const value = target[key];
                return typeof value === 'function' ? value.bind(target) : value;
            } }) };
            const start = performance.now();
            await assert.rejects(save(db, { userID: '1', categoryID: samples.categoryID,
                expectedRevision: 0, comparison: { mode: 'best', keys: ['model'] },
                entries: samples.conditionIDs.slice(0, size).map(conditionID => ({ conditionID, weightBasisPoints: 10000 / size })),
                fallbackRules: [] }), error => error.body?.error === 'account_unavailable');
            timings[name] = { ms: Math.round(performance.now() - start), queries };
            assert.equal(queries.some(query => query.sql.includes('benchmark_results')), name === 'before');
        }
        const result = { size, repeat, ...timings };
        report.cases.push(result);
        console.log(JSON.stringify({ size, repeat, beforeMs: timings.before.ms, afterMs: timings.after.ms }));
    }
    report.passed = true;
} finally {
    await connection.rollback(); await connection.end();
    await writeFile(output, JSON.stringify(report, null, 2));
}
