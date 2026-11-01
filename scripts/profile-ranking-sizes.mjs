import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initPool, pool } from '../db.js';
import { getRankingWorkspace, loadBenchmarkConditions } from '../ranking-service.js';
import { createRankingPager } from '../ranking-pagination.js';

const [operation, filename] = process.argv.slice(2);
assert.ok(['record', 'compare'].includes(operation) && filename, 'Usage: record|compare report.json');
initPool(process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD);
try {
    const [categories] = await pool.execute("SELECT ID FROM categories WHERE name = 'Intelligence' AND is_active = 1 AND owner_user_ID IS NULL");
    assert.equal(categories.length, 1);
    const [counts] = await pool.query('SELECT COUNT(*) AS results, MAX(ID) AS lastID FROM benchmark_results');
    const baseline = operation === 'compare' ? JSON.parse(await readFile(filename, 'utf8')) : null;
    const selected = baseline?.conditionIDs ?? (await loadBenchmarkConditions(pool)).sort((a, b) => b.scoreCount - a.scoreCount || a.ID - b.ID).slice(0, 100).map(row => row.ID);
    assert.equal(selected.length, 100);
    const report = { createdAt: new Date().toISOString(), counts, categoryID: Number(categories[0].ID), conditionIDs: selected, cases: [] };
    if (baseline) assert.deepEqual(counts, baseline.counts, 'Score data changed since the baseline');
    for (const size of [10, 100]) for (const repeat of [1, 2]) {
        const queries = [];
        const db = { getConnection: async () => {
            const connection = await pool.getConnection();
            return new Proxy(connection, { get(target, key) {
                const value = target[key];
                if (key === 'query' || key === 'execute') return async (...args) => {
                    const start = performance.now();
                    try { return await value.apply(target, args); }
                    finally { queries.push({ sql: args[0].replace(/\s+/g, ' ').trim(), ms: Math.round(performance.now() - start) }); }
                };
                return typeof value === 'function' ? value.bind(target) : value;
            } });
        } };
        const started = performance.now();
        const workspace = await getRankingWorkspace(db, { categoryID: report.categoryID, comparison: { mode: 'best', keys: ['model'] },
            previewPersonalPie: { entries: selected.slice(0, size).map(conditionID => ({ conditionID, weightBasisPoints: 10000 / size })), fallbackRules: [] } });
        const computeMs = Math.round(performance.now() - started);
        const payload = createRankingPager().create(workspace, { initialMode: 'personal', userID: null, query: '', pinPersonal: false });
        delete payload.serverTime;
        delete payload.rankingPagination.snapshotID;
        const serialized = JSON.stringify(payload);
        const digest = createHash('sha256').update(serialized).digest('hex');
        const item = { size, repeat, ms: Math.round(performance.now() - started), computeMs, responseBytes: Buffer.byteLength(serialized), digest,
            models: workspace.modelLeaderboards.personal.length, comparableModels: workspace.modelLeaderboards.personal.filter(row => row.comparable).length,
            comparisonConfigurations: workspace.modelLeaderboards.personal.reduce((total, row) => total + row.members.length, 0),
            heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024), queries };
        if (baseline) {
            const previous = baseline.cases.find(row => row.size === size && row.repeat === repeat);
            assert.equal(digest, previous.digest, 'Ranking, evidence or ordering changed');
            item.beforeMs = previous.ms;
        }
        report.cases.push(item);
        console.log(JSON.stringify({ ...item, queries: queries.map(row => ({ ...row, sql: row.sql.slice(0, 140) })) }));
    }
    const output = baseline ? filename.replace(/\.json$/, '-after.json') : filename;
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2));
} finally { await pool.end(); }
