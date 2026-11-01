import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { validateWorkspacePayload } from '../public/js/workspace/contracts.js';

const root = resolve('artifacts/review-20261008/guest-preview-lifecycle-20261008/deployment');
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const results = [];
async function request(path, body, check) {
    const started = performance.now();
    const response = await fetch('https://benchpoll.com' + path, {
        ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(60000)
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, path);
    const value = body ? validateWorkspacePayload(JSON.parse(bytes.toString('utf8')), { initialMode: body.initialMode }) : bytes;
    const detail = await check(value, response);
    results.push({ path, status: response.status, milliseconds: Math.round(performance.now() - started), ...detail });
    return value;
}
for (const file of manifest.files) {
    await request('/' + file.path.replace(/^public\//, '') + '?v=workspace-ui-20261008', null, bytes => {
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        assert.equal(sha256, file.after);
        return { sha256, installedBytesMatched: true };
    });
}
await request('/Intelligence', null, bytes => {
    assert.match(bytes.toString('utf8'), /BenchPoll/); return { pagePresent: true };
});
const comparison = { mode: 'best', keys: ['model'], filters: [] };
const base = await request('/api/get_weighted_workspace', { contextValues: {}, scoreMode: 'range', initialMode: 'public', comparison }, payload => {
    assert.equal(payload.authenticated, false); assert.equal(payload.userID, null);
    return { benchmarks: payload.benchmarks.length, publicModels: payload.modelLeaderboards.public.length, businessParserAccepted: true };
});
const benchmark = base.benchmarks.find(row => !row.isFamily && row.scoreCount > 0);
assert.ok(benchmark, 'A scored real benchmark is required for the anonymous preview.');
const previewPersonalPie = { entries: [{ conditionID: benchmark.ID, weightBasisPoints: 10000 }], fallbackRules: [] };
for (const scoreMode of ['range', 'available']) {
    await request('/api/get_weighted_workspace', { categoryID: base.context.categoryID, contextValues: base.context.contextValues,
        scoreMode, initialMode: 'personal', comparison, previewPersonalPie }, payload => {
        assert.equal(payload.authenticated, false); assert.equal(payload.userID, null);
        assert.equal(payload.personalPie.isDraft, true); assert.equal(payload.personalPie.entries.length, 1);
        assert.equal(payload.personalPie.entries[0].conditionID, benchmark.ID);
        assert.equal(payload.personalPie.entries[0].weightBasisPoints, 10000);
        return { scoreMode, conditionID: benchmark.ID, draft: true, personalModels: payload.modelLeaderboards.personal.length,
            businessParserAccepted: true };
    });
}
const output = join(root, `public-${Date.now()}.json`);
await writeFile(output, JSON.stringify({ passed: true, release: manifest.release, results,
    scope: 'Live anonymous pages, installed asset bytes and read-only guest-preview APIs. No authentication, persistent weights, account mutation, browser rendering or latency SLA is claimed.' }, null, 2), { flag: 'wx' });
console.log(output);
