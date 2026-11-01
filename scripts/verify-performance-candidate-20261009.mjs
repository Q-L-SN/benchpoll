import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

async function verifyCandidate(files, conditionIDs) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const { createHash } = await import('node:crypto');
    const { default: assert } = await import('node:assert/strict');
    const root = '/home/ubuntu/benchpoll';
    const stage = await fs.mkdtemp('/tmp/benchpoll-performance-');
    for (const filename of await fs.readdir(root)) {
        if (filename.endsWith('.js') && !files[filename]) await fs.symlink(path.join(root, filename), path.join(stage, filename));
    }
    for (const filename of ['public', 'node_modules', 'package.json']) await fs.symlink(path.join(root, filename), path.join(stage, filename));
    for (const [filename, base64] of Object.entries(files)) await fs.writeFile(path.join(stage, filename), Buffer.from(base64, 'base64'));
    process.chdir(root);
    await import(path.join(root, 'node_modules/dotenv/config.js'));
    const mysql = await import(path.join(root, 'node_modules/mysql2/promise.js'));
    const baseline = await import(path.join(root, 'ranking-service.js'));
    const candidate = await import(path.join(stage, 'ranking-service.js'));
    const { createRankingReadCache } = await import(path.join(stage, 'ranking-read-cache.js'));
    const { createRankingPager } = await import(path.join(stage, 'ranking-pagination.js'));
    const connection = await mysql.default.createConnection({ socketPath: '/var/run/mysqld/mysqld.sock',
        user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', timezone: 'Z' });
    const queries = [];
    const db = { getConnection: async () => new Proxy(connection, { get(target, key) {
        if (['commit', 'rollback', 'release'].includes(key)) return async () => {};
        if (key === 'query' || key === 'execute') return async (sql, ...args) => {
            if (/^(SET TRANSACTION|START TRANSACTION)/.test(sql)) return [];
            if (sql.includes('FROM ranking_cache_revisions')) return [[{ epoch: 'readonly-rehearsal', data_revision: 1, catalogue_revision: 1, ready: 1 }]];
            const start = performance.now();
            try { return await target[key](sql, ...args); }
            finally { queries.push({ sql: sql.replace(/\s+/g, ' ').trim().slice(0, 120), ms: Math.round(performance.now() - start) }); }
        };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } }) };
    const cache = createRankingReadCache();
    const report = { stage, businessWrites: 0, sameReadOnlySnapshot: true, cases: [] };
    const clean = value => { const clone = structuredClone(value); delete clone.serverTime; return clone; };
    try {
        await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
        report.counts = (await connection.query('SELECT COUNT(*) AS results, MAX(ID) AS lastID FROM benchmark_results'))[0][0];
        const scenarios = [
            { size: 0, comparison: { mode: 'best', keys: ['model'] } },
            { size: 10, comparison: { mode: 'best', keys: ['model'] } },
            { size: 100, comparison: { mode: 'best', keys: ['model'] } },
            { size: 10, comparison: { mode: 'best', keys: [] } },
            { size: 10, comparison: { mode: 'matched', keys: ['model'] } },
            { size: 10, comparison: { mode: 'best', keys: ['model'] }, fallback: true }
        ];
        for (const scenario of scenarios) for (const scoreMode of ['range', 'available']) {
            const options = { comparison: scenario.comparison, scoreMode,
                ...(scenario.size ? { previewPersonalPie: {
                    entries: conditionIDs.slice(0, scenario.size).map(conditionID => ({ conditionID, weightBasisPoints: 10000 / scenario.size })),
                    fallbackRules: scenario.fallback ? [{ primaryConditionID: conditionIDs[0], mode: 'ordered',
                        entries: [{ conditionID: conditionIDs[10] }, { kind: 'other_versions' }, { conditionID: conditionIDs[11] }] }] : []
                } } : {}) };
            let start = performance.now();
            const previous = await baseline.getRankingWorkspace(db, options), beforeMs = Math.round(performance.now() - start);
            for (const repeat of [1, 2]) {
                queries.length = 0; start = performance.now();
                const next = await candidate.getRankingWorkspace(db, { ...options, rankingCache: cache });
                const computeMs = Math.round(performance.now() - start);
                const payload = createRankingPager().create(next, { initialMode: scenario.size ? 'personal' : 'public' });
                const responseBytes = Buffer.byteLength(JSON.stringify(payload));
                assert.deepEqual(clean(next), clean(previous), 'Metadata, ranking or evidence changed');
                const wireStart = performance.now();
                const wire = await candidate.getRankingWorkspace(db, { ...options, rankingCache: cache, jsonMemberMetadata: true });
                const wireComputeMs = Math.round(performance.now() - wireStart);
                assert.deepEqual(JSON.parse(JSON.stringify(clean(wire))), JSON.parse(JSON.stringify(clean(previous))),
                    'Wire metadata, ranking or evidence changed');
                report.cases.push({ ...scenario, scoreMode, repeat, beforeMs, computeMs,
                    wireComputeMs, wireIdentical: true,
                    totalMs: Math.round(performance.now() - start), responseBytes, identical: true,
                    digest: createHash('sha256').update(JSON.stringify(clean(next))).digest('hex'), queries: [...queries] });
                // Returned UI evidence must not be able to poison the shared calculation material.
                for (const row of next.modelLeaderboards.public) {
                    row.condition.parameters = null;
                    if (row.members[0]) row.members[0].name = 'mutation isolation probe';
                    if (row.comparisonScores[0]) row.comparisonScores[0].memberIDs.length = 0;
                }
                for (const row of wire.modelLeaderboards.public) {
                    row.condition.parameters = null;
                    if (row.members[0]) row.members[0].name = 'wire mutation isolation probe';
                    if (row.calculationScores[0]) row.calculationScores[0].memberIDs.length = 0;
                    if (row.availableInference) row.availableInference.percentile = -1;
                }
            }
        }
        report.passed = true; report.cache = cache.stats;
        console.log(JSON.stringify(report));
    } finally { await connection.rollback(); await connection.end(); }
}

const files = {};
for (const filename of ['ranking-service.js', 'ranking-pagination.js', 'ranking-read-cache.js']) files[filename] = (await readFile(filename)).toString('base64');
const before = JSON.parse(await readFile('artifacts/performance-20261009/before-origin.json', 'utf8'));
const options = ['-i', 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20'];
const input = `await (${verifyCandidate.toString()})(${JSON.stringify(files)},${JSON.stringify(before.conditionIDs)});`;
const raw = execFileSync('C:/Windows/System32/OpenSSH/ssh.exe', [...options, 'ubuntu@18.226.222.18', 'node --input-type=module'],
    { input, encoding: 'utf8', windowsHide: true, timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
const report = JSON.parse(raw); assert.equal(report.passed, true);
await writeFile(resolve('artifacts/performance-20261009/candidate-equivalence.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ stage: report.stage, passed: report.passed, counts: report.counts, cache: report.cache,
    cases: report.cases.map(({ size, scoreMode, repeat, beforeMs, computeMs, identical, comparison }) =>
        ({ size, scoreMode, repeat, beforeMs, computeMs, identical, comparison })) }, null, 2));
