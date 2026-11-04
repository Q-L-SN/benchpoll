import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(new EnvHttpProxyAgent());
const receipt = JSON.parse(await readFile(process.argv[2], 'utf8'));
const origin = 'https://benchpoll.com';
const checks = [];
async function post(path, body, status = 200) {
    const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const value = await response.json();
    assert.equal(response.status, status, path + ': ' + JSON.stringify(value).slice(0, 300));
    checks.push({ path, status, ...body });
    return value;
}
const catalog = await post('/api/get_contribution_catalog', {});
const archivedBenchmarks = new Set(receipt.benchmarks.map(row => row.ID));
const archivedConditions = new Set(receipt.versions.map(row => row.ID));
assert.ok(catalog.benchmarks.every(row => !archivedBenchmarks.has(row.ID)));
assert.ok(catalog.benchmarks.flatMap(row => row.conditions).every(row => !archivedConditions.has(row.ID)));
for (const row of receipt.createdDefaults) {
    const benchmark = catalog.benchmarks.find(item => item.ID === row.benchmarkID);
    assert.equal(benchmark.conditions.length, 1);
    const version = benchmark.conditions[0];
    assert.equal(version.ID, row.ID);
    assert.equal(version.name, 'default');
    assert.equal(version.scoreCount, 0);
    assert.ok(version.isDefault && version.isPrimary);
    const scores = await post('/api/get_benchmark_scores', { benchmarkID: row.benchmarkID, conditionID: row.ID });
    assert.equal(scores.scores.length, 0);
    assert.equal(scores.displayRestriction, null);
}
for (const conditionID of [2255, 22181, 25715, receipt.versions.find(row => archivedBenchmarks.has(row.benchmarkID)).ID]) {
    await post('/api/get_benchmark_information', { conditionID }, 404);
}
const remainingParents = [...new Set(receipt.versions.filter(row => !archivedBenchmarks.has(row.benchmarkID)).map(row => row.benchmarkID))];
for (const benchmarkID of remainingParents) {
    const benchmark = catalog.benchmarks.find(row => row.ID === benchmarkID);
    assert.ok(benchmark && benchmark.conditions.length);
    assert.equal(benchmark.conditions.filter(row => row.isPrimary).length, 1);
    const selected = benchmark.conditions.find(row => row.isPrimary);
    const scores = await post('/api/get_benchmark_scores', { benchmarkID, conditionID: selected.ID });
    assert.ok(scores.conditions.every(row => !archivedConditions.has(row.ID)));
}
const topics = await post('/api/get_topics', {});
const intelligence = topics.topics.find(topic => topic.name === 'Intelligence');
const workspace = await post('/api/get_weighted_workspace', { categoryID: intelligence.ID, contextValues: {}, scoreMode: 'range', initialMode: 'public' });
assert.ok(workspace && Array.isArray(workspace.versionComposition));
const report = { verifiedAt: new Date().toISOString(), passed: true, archivedBenchmarksAbsent: receipt.benchmarks.length,
    archivedVersionsAbsent: receipt.versions.length, retainedParents: remainingParents.length, checks };
await writeFile(process.argv[3], JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: true, requests: checks.length, retainedParents: remainingParents.length }));
