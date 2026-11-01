import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const argument = process.argv.find(value => value.startsWith('--deployment='))?.slice(13); assert.ok(argument);
const root = resolve(argument), manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const { validateWorkspacePayload } = await import(pathToFileURL(join(root, 'stage/public/js/workspace/contracts.js')).href);
const results = [];
async function request(path, body, check, { status = 200, headers = {} } = {}) {
    const started = performance.now();
    const response = await fetch('https://benchpoll.com' + path, { credentials: 'omit', signal: AbortSignal.timeout(60000),
        ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) } : {}) });
    const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(response.status, status, path);
    const value = body ? JSON.parse(bytes.toString('utf8')) : bytes;
    results.push({ path, status: response.status, milliseconds: Math.round(performance.now() - started), ...await check(value, response) });
    return value;
}
for (const file of manifest.files) await request('/' + file.path.replace(/^public\//, '') + '?v=' + manifest.release, null, bytes => {
    const sha256 = createHash('sha256').update(bytes).digest('hex'); assert.equal(sha256, file.after);
    return { sha256, installedBytesMatched: true };
});
await request('/Intelligence', null, bytes => { assert.match(bytes.toString('utf8'), /BenchPoll/); return { pagePresent: true }; });
const comparison = { mode: 'best', keys: ['model'], filters: [] };
const base = await request('/api/get_weighted_workspace', { contextValues: {}, scoreMode: 'range', initialMode: 'public', comparison }, raw => {
    const payload = validateWorkspacePayload(raw, { initialMode: 'public' }); assert.equal(payload.authenticated, false); assert.equal(payload.userID, null);
    return { benchmarks: payload.benchmarks.length, publicModels: payload.modelLeaderboards.public.length, businessParserAccepted: true };
});
const benchmark = base.benchmarks.find(row => !row.isFamily && row.scoreCount > 0); assert.ok(benchmark);
const previewPersonalPie = { entries: [{ conditionID: benchmark.ID, weightBasisPoints: 10000 }], fallbackRules: [] };
for (const scoreMode of ['range', 'available']) await request('/api/get_weighted_workspace', { categoryID: base.context.categoryID,
    contextValues: base.context.contextValues, scoreMode, initialMode: 'personal', comparison, previewPersonalPie }, raw => {
    const payload = validateWorkspacePayload(raw, { initialMode: 'personal' }); assert.equal(payload.authenticated, false); assert.equal(payload.userID, null);
    assert.equal(payload.personalPie.isDraft, true); assert.equal(payload.personalPie.entries.length, 1);
    assert.equal(payload.personalPie.entries[0].conditionID, benchmark.ID); assert.equal(payload.personalPie.entries[0].weightBasisPoints, 10000);
    return { scoreMode, conditionID: benchmark.ID, draft: true, personalModels: payload.modelLeaderboards.personal.length, businessParserAccepted: true };
});
await request('/api/save_personal_pie', { expectedUserID: '1', categoryID: base.context.categoryID,
    contextValues: base.context.contextValues, expectedRevision: 0, ...previewPersonalPie }, value => {
    assert.equal(value.error, 'authentication_required'); return { anonymousWriteRejected: true };
}, { status: 401, headers: { 'Idempotency-Key': randomUUID() } });
const output = join(root, 'public-' + Date.now() + '.json');
await writeFile(output, JSON.stringify({ passed: true, release: manifest.release, results, authenticated: false,
    productionBusinessDataWritten: false, scope: 'Exact frontend hashes, live anonymous homepage, read-only public/guest preview APIs and rejected anonymous save. No real OAuth, authenticated mutation, browser UI or latency SLA claim.' }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ passed: true, requests: results.length, output }));
