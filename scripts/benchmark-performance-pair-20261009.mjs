import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

async function compare(stage, conditionIDs) {
    const { default: assert } = await import('node:assert/strict');
    const root = '/home/ubuntu/benchpoll';
    process.chdir(root);
    await import(root + '/node_modules/dotenv/config.js');
    const mysql = await import(root + '/node_modules/mysql2/promise.js');
    const previous = await import(root + '/ranking-service.js');
    const next = await import(stage + '/ranking-service.js');
    const previousCache = (await import(root + '/ranking-read-cache.js')).createRankingReadCache();
    const nextCache = (await import(stage + '/ranking-read-cache.js')).createRankingReadCache();
    const connection = await mysql.default.createConnection({ socketPath: '/var/run/mysqld/mysqld.sock',
        user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', timezone: 'Z' });
    const db = { getConnection: async () => new Proxy(connection, { get(target, key) {
        if (['commit', 'rollback', 'release'].includes(key)) return async () => {};
        if (key === 'query' || key === 'execute') return (sql, ...args) => /^(SET TRANSACTION|START TRANSACTION)/.test(sql)
            ? [] : target[key](sql, ...args);
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } }) };
    const run = async (version, options) => {
        const start = performance.now();
        const value = await (version === 'previous' ? previous : next).getRankingWorkspace(db, {
            ...options, rankingCache: version === 'previous' ? previousCache : nextCache,
            jsonMemberMetadata: version === 'next' });
        return { value, ms: performance.now() - start };
    };
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const report = { businessWrites: 0, sameReadOnlySnapshot: true, cases: [] };
    try {
        await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
        for (const version of ['previous', 'next']) await run(version, { scoreMode: 'available' });
        for (const size of [10, 100]) for (const scoreMode of ['range', 'available']) {
            const options = { scoreMode, comparison: { mode: 'best', keys: ['model'] }, previewPersonalPie: {
                entries: conditionIDs.slice(0, size).map(conditionID => ({ conditionID, weightBasisPoints: 10000 / size })), fallbackRules: [] } };
            const previousMs = [], nextMs = [];
            for (let repeat = 0; repeat < 6; repeat++) {
                const measured = {};
                for (const version of repeat % 2 ? ['next', 'previous'] : ['previous', 'next']) measured[version] = await run(version, options);
                for (const item of Object.values(measured)) delete item.value.serverTime;
                assert.deepEqual(JSON.parse(JSON.stringify(measured.next.value)), JSON.parse(JSON.stringify(measured.previous.value)));
                if (repeat > 0) { previousMs.push(measured.previous.ms); nextMs.push(measured.next.ms); }
            }
            report.cases.push({ size, scoreMode, previousMs, nextMs,
                previousMedian: median(previousMs), nextMedian: median(nextMs), speedup: median(previousMs) / median(nextMs), identical: true });
        }
        report.passed = true;
        console.log(JSON.stringify(report));
    } finally { await connection.rollback(); await connection.end(); }
}

const stage = JSON.parse(await readFile('artifacts/performance-20261009/candidate-equivalence.json', 'utf8')).stage;
const conditions = JSON.parse(await readFile('artifacts/performance-20261009/before-origin.json', 'utf8')).conditionIDs;
const ssh = ['-i', 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20',
    'ubuntu@18.226.222.18', 'node --input-type=module'];
const report = JSON.parse(execFileSync('C:/Windows/System32/OpenSSH/ssh.exe', ssh,
    { input: `await (${compare.toString()})(${JSON.stringify(stage)},${JSON.stringify(conditions)});`,
        encoding: 'utf8', windowsHide: true, timeout: 240000, maxBuffer: 8 * 1024 * 1024 }));
assert.equal(report.passed, true);
await writeFile('artifacts/performance-20261009/paired-compute.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
