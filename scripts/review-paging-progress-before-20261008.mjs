import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { recoveryCycleScenario } from './review-snapshot-capacity-20261008.mjs';

const root = 'artifacts/review-20261008';
const prefix = `${root}/paging-progress-before-${Date.now()}-${randomUUID().slice(0, 8)}`;
await mkdir(root, { recursive: true });
const sources = [];
for (const path of ['ranking-pagination.js', 'server.js', 'public/js/home-workspace.js',
    'public/js/workspace/contracts.js', 'public/js/workspace/benchmark-fallback-catalogue.js']) {
    const bytes = await readFile(path);
    sources.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), text: bytes.toString('utf8') });
}
await writeFile(`${prefix}-sources.json`, JSON.stringify(sources, null, 2), { flag: 'wx' });
const runs = [];
for (let repetition = 1; repetition <= 2; repetition++) {
    for (const [owners, list] of [[12, 'public'], [13, 'public'], [24, 'public'], [13, 'benchmarks']]) {
        const result = await recoveryCycleScenario(owners, list, 3);
        if (owners === 12) assert.equal(result.totalRefreshes, 0);
        else {
            assert.equal(result.totalRefreshes, owners * 3);
            assert.ok(result.records.every(row => new Set(row.loadedCounts).size === 1));
        }
        runs.push({ repetition, ...result });
    }
}
const report = { timestamp: new Date().toISOString(), node: process.version, platform: process.platform,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
    target: 'Offline synthetic owners, exact exported pager and current frontend loader bodies; no production reads/writes',
    expected: 'Each further load extends the viewed prefix, even after capacity eviction',
    actual: 'More than twelve interleaved owners remain on the initial page after three load/refresh rounds',
    limitation: 'Deterministic fair-owner scheduling is a control-flow reproduction, not measured production traffic', runs };
await writeFile(`${prefix}-results.json`, JSON.stringify(report, null, 2), { flag: 'wx' });
await writeFile(`${prefix}-brief.md`, `# Paging Progress Reproduction\n\n`
    + `- Expected: ${report.expected}.\n- Actual: ${report.actual}.\n`
    + `- Environment: Node ${report.node}, ${report.platform}, commit ${report.commit}, dirty workspace retained.\n`
    + '- Reproduced twice for 13/24 owners and model/benchmark lists; 12-owner control progresses.\n'
    + `- Evidence: ${prefix}-results.json and immutable source capture.\n`
    + `- Boundary: ${report.limitation}. No production data was changed.\n`
    + '- Next hypothesis: initial full refresh discards the continuation frontier; recover from one consistent new calculation with explicit depths.\n', { flag: 'wx' });
console.log(JSON.stringify({ prefix, reproduced: true, repetitions: 2,
    scenarios: runs.map(row => ({ repetition: row.repetition, owners: row.ownerCount, list: row.list,
        refreshes: row.totalRefreshes, loadedCounts: row.records[0].loadedCounts })) }));
