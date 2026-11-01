import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = resolve(arg('root')), output = arg('output');
if (!output || !process.env.BENCHPOLL_DB_NAME) throw new Error('Explicit read-only profile options required');
const { default: mysql } = await import(pathToFileURL(resolve(root, 'node_modules/mysql2/promise.js')));
const ranking = await import(pathToFileURL(resolve(root, 'ranking-service.js')));
const { createRankingReadCache } = await import(pathToFileURL(resolve(root, 'ranking-read-cache.js')));
const { createRankingPager } = await import(pathToFileURL(resolve(root, 'ranking-pagination.js')));
const { validateWorkspacePayload } = await import(pathToFileURL(resolve(root, 'public/js/workspace/contracts.js')));
const pool = mysql.createPool({ socketPath: process.env.BENCHPOLL_DB_SOCKET, user: process.env.BENCHPOLL_DB_USER,
    database: process.env.BENCHPOLL_DB_NAME, connectionLimit: 1 });
const report = { createdAt: new Date().toISOString(), businessWrites: 0,
    sourceHash: createHash('sha256').update(await readFile(resolve(root, 'ranking-service.js'))).digest('hex'), cases: [] };
const measured = workspace => workspace.modelLeaderboards.personal.map(row => ({ ID: row.ID, comparable: row.comparable,
    coverage: row.coverage, resultCount: row.resultCount, fallbackResolutions: row.fallbackResolutions,
    scores: row.calculationScores.map(({ contribution, effectiveWeight, ...real }) => real), comparisonScores: row.comparisonScores }));
try {
    const c = await pool.getConnection();
    let versions;
    try { versions = await ranking.loadBenchmarkConditions(c); } finally { c.release(); }
    const IDs = versions.sort((a, b) => b.scoredModelCount - a.scoredModelCount || a.conditionID - b.conditionID)
        .slice(0, 100).map(v => v.conditionID);
    const cache = createRankingReadCache(), pager = createRankingPager();
    let evidence = null;
    for (const size of [10, 100]) {
        evidence = null;
        for (const mode of ['range', 'available']) for (const version of mode === 'range' ? [2] : [1, 2]) {
            for (let repeat = 0; repeat < 2; repeat++) {
                const start = performance.now();
                const workspace = await ranking.getRankingWorkspace(pool, { rankingCache: cache, scoreMode: mode,
                    availableInferenceVersion: version, jsonMemberMetadata: true,
                    comparison: { mode: 'best', keys: ['model'] }, previewPersonalPie: { entries: IDs.slice(0, size)
                        .map(conditionID => ({ conditionID, weightBasisPoints: 10000 / size })), fallbackRules: [] } });
                const computeMs = performance.now() - start, samples = measured(workspace);
                if (evidence) assert.deepEqual(samples, evidence, 'Inference must not change real evidence'); else evidence = samples;
                const response = pager.create(workspace, { initialMode: 'personal' });
                validateWorkspacePayload(response, { initialMode: 'personal' });
                const serialized = JSON.stringify(response);
                report.cases.push({ size, mode, version, repeat, computeMs, totalMs: performance.now() - start,
                    models: workspace.modelLeaderboards.personal.length, responseBytes: Buffer.byteLength(serialized),
                    estimateCount: workspace.modelLeaderboards.personal.reduce((sum, row) => sum + row.inferredScores.length, 0) });
            }
        }
    }
    report.memoryMB = process.memoryUsage().heapUsed / 1024 / 1024;
    await writeFile(output, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(report));
} finally { await pool.end(); }
