import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { initPool, pool } from '../db.js';
import { getRankingWorkspace } from '../ranking-service.js';

// Read-only database benchmark. The digest includes scores, evidence and ordering.
const [operation, file, category = '54'] = process.argv.slice(2);
if (!['record', 'compare'].includes(operation) || !file) {
    throw new Error('Usage: node scripts/profile-rankings.mjs record|compare report.json [categoryID]');
}
initPool(process.env.DB_PASSWORD);
try {
    const [[{ count }]] = await pool.query('SELECT COUNT(*) AS count FROM benchmark_results');
    const report = { count, cases: [] };
    const scenarios = [null, { mode: 'best', keys: ['model'] }, { mode: 'matched', keys: ['model'] }];
    for (const comparison of scenarios) {
        const queries = [];
        const db = { getConnection: async () => {
            const connection = await pool.getConnection();
            return new Proxy(connection, { get(target, key) {
                const value = target[key];
                if (key === 'query' || key === 'execute') return async (...args) => {
                    const start = performance.now();
                    try { return await value.apply(target, args); }
                    finally { queries.push({ sql: args[0].replace(/\s+/g, ' ').trim().slice(0,100), ms: Math.round(performance.now() - start) }); }
                };
                return typeof value === 'function' ? value.bind(target) : value;
            } });
        } };
        const start = performance.now();
        const workspace = await getRankingWorkspace(db, { categoryID: Number(category), comparison });
        const ms = Math.round(performance.now() - start);
        delete workspace.serverTime;
        const digest = createHash('sha256').update(JSON.stringify(workspace)).digest('hex');
        report.cases.push({ comparison, ms, digest, queries });
    }
    if (operation === 'record') await writeFile(file, JSON.stringify(report, null, 2));
    else {
        const baseline = JSON.parse(await readFile(file, 'utf8'));
        assert.equal(report.count, baseline.count, 'Database changed since baseline');
        report.cases.forEach((item, index) => {
            assert.equal(item.digest, baseline.cases[index].digest, 'Ranking/evidence output changed');
            item.beforeMs = baseline.cases[index].ms;
            item.speedup = (item.beforeMs / item.ms).toFixed(2);
        });
    }
    console.log(JSON.stringify(report, null, 2));
} finally { await pool.end(); }
