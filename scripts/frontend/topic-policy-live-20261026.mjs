import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { topicSlug } from '../../public/js/shared/topics.js';
import { validateWorkspacePayload } from '../../public/js/workspace/contracts.js';

const origin = process.argv[2] || 'https://benchpoll.com';
const output = resolve(process.env.TOPIC_POLICY_OUTPUT || 'D:/Codex-artifacts/website1/topic-identity-coverage-20261026/public-policy');
await mkdir(output, { recursive: true });
const report = { origin, redirects: [], passed: false };
async function read(path, options = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try { return await fetch(origin + path, { ...options, signal: AbortSignal.timeout(45000) }); }
        catch (error) { if (attempt === 2) throw error; await delay(750 * (attempt + 1)); }
    }
}
async function post(path, body) {
    const response = await read(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, path); return response.json();
}
try {
    const catalogue = await post('/api/get_topics', {});
    for (const topic of catalogue.topics) {
        assert.equal(topic.isPrivate, false); assert.equal(topic.slug, topicSlug(topic.name));
        assert.equal(topic.url, '/' + topic.slug);
    }
    report.canonicalTopics = catalogue.topics.length;
    for (const [ID, name, slug] of [[199, 'Security', 'security'], [189, 'Media', 'media']]) {
        const topic = catalogue.topics.find(topic => topic.ID === ID);
        assert.equal(topic.name, name); assert.equal(topic.slug, slug);
        const query = '?probe=topic-policy';
        for (const old of [slug + '-benchmarks', name + '/']) {
            const response = await read('/' + old + query, { redirect: 'manual' });
            assert.equal(response.status, 302);
            const location = new URL(response.headers.get('location'), origin);
            assert.equal(location.pathname, '/' + slug); assert.equal(location.search, query);
            report.redirects.push({ from: old, to: location.pathname, queryPreserved: true });
        }
        const response = await read('/' + slug);
        assert.equal(response.status, 200);
        assert.match(await response.text(), new RegExp('name="benchpoll-startup-category" content="' + ID + '"'));
    }
    const comparison = { mode: 'best', keys: ['model'], filters: [] };
    const workspace = validateWorkspacePayload(await post('/api/get_weighted_workspace', { categoryID: 54, contextValues: {},
        scoreMode: 'available', initialMode: 'public', availableInferenceVersion: 4, comparison,
        homeComparison: { reasoning: false, harness: false } }));
    const rows = workspace.modelLeaderboards.public;
    const scored = rows.filter(row => row.availableInference);
    assert.ok(scored.length > 0);
    for (const row of scored) {
        const inference = row.availableInference, factor = inference.coverageFraction ** .35;
        assert.ok(Math.abs(inference.coverageFactor - factor) < 1e-9);
        const adjusted = inference.unpenalizedScore * (inference.unpenalizedScore < 0 ? 2 - factor : factor);
        assert.ok(Math.abs(row.lower - adjusted) <= .011);
    }
    const preview = await post('/api/get_topic_preview', { categoryID: 54, scoreMode: 'available', reasoning: false, harness: false });
    let parity = 0;
    for (const model of preview.models) {
        const row = rows.find(row => row.modelID === model.modelID);
        if (!row) continue;
        assert.equal(model.lower, row.lower); assert.equal(model.upper, row.upper); parity++;
    }
    assert.ok(parity > 0);
    report.validatedCoverageRows = scored.length; report.previewWorkspaceParity = parity;
    report.passed = true;
} catch (error) { report.failure = error.stack; throw error; }
finally { await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report));
