import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { topicSlug } from '../../public/js/shared/topics.js';
import { validateWorkspacePayload } from '../../public/js/workspace/contracts.js';

const spec = JSON.parse(await readFile(new URL('../../ops/topic-taxonomy-20261026.json', import.meta.url), 'utf8'));
const origin = process.argv[2] || 'https://benchpoll.com';
const output = resolve(process.env.TOPIC_TAXONOMY_OUTPUT || 'D:/Codex-artifacts/website1/topic-taxonomy-20261026/public-api');
await mkdir(output, { recursive: true });
const report = { origin, passed: false, topics: 0, workspaces: [], scorePages: [] };
async function post(path, body) {
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            response = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
            break;
        } catch (error) { if (attempt === 2) throw error; await delay(1000); }
    }
    assert.equal(response.status, 200, path);
    return response.json();
}
try {
    const catalogue = await post('/api/get_topics', {}), byID = new Map(catalogue.topics.map(topic => [topic.ID, topic]));
    for (const node of spec.categories) {
        const topic = byID.get(node.ID);
        assert.ok(topic, 'Missing official topic: ' + node.ID);
        assert.equal(topic.name, node.name); assert.equal(topic.slug, topicSlug(node.name));
        assert.equal(topic.url, '/' + topic.slug); assert.equal(topic.isPrivate, false);
    }
    for (const retired of spec.retiredCategories) assert.equal(byID.has(retired.ID), false);
    assert.equal(catalogue.topics[0].ID, 54); report.topics = spec.categories.length;
    const inspectionIDs = new Set([54, 180, 176, 167, 231, 199,
        ...spec.categories.filter(topic => Object.hasOwn(spec.dimensions, topic.key)).map(topic => topic.ID)]);
    let intelligence;
    for (const node of spec.categories.filter(topic => inspectionIDs.has(topic.ID))) {
        const workspace = validateWorkspacePayload(await post('/api/get_weighted_workspace', { categoryID: node.ID,
            contextValues: {}, initialMode: 'public', scoreMode: 'available', availableInferenceVersion: 4,
            comparison: { mode: 'best', keys: ['model'], filters: [] } }));
        assert.equal(workspace.context.categoryID, node.ID);
        assert.equal(workspace.context.lineage.at(-1).name, node.name);
        const expected = spec.dimensions[node.key] ?? [];
        assert.deepEqual(workspace.context.dimensions.map(dimension => [dimension.key, dimension.name,
            dimension.options.map(option => [option.key, option.name])]), expected.map(dimension =>
            [dimension.key, dimension.name, [spec.neutralOption, ...dimension.options].map(option => [option.key, option.name])]));
        assert.ok(Object.values(workspace.context.contextValues).every(value => value === 'any'));
        if (node.ID === 167) assert.equal(workspace.context.ID, 1094);
        if (node.ID === 231) assert.equal(workspace.context.ID, 1093);
        report.workspaces.push({ ID: node.ID, name: node.name, dimensions: expected.map(dimension => dimension.key) });
        if (node.ID === 54) intelligence = workspace;
    }
    const candidate = intelligence.benchmarks.toSorted((a, b) => b.scoreCount - a.scoreCount).find(row => row.scoreCount > 100);
    assert.ok(candidate, 'Need a multi-page benchmark for global ordering verification');
    const scores = [], seen = new Set(); let cursor;
    for (let page = 0; page < 3; page++) {
        const payload = await post('/api/get_benchmark_scores', { benchmarkID: candidate.benchmarkID,
            conditionID: candidate.conditionID, ...(cursor ? { beforeID: cursor } : {}) });
        for (const score of payload.scores) {
            assert.equal(seen.has(score.ID), false, 'Duplicate score across pages');
            const previous = scores.at(-1);
            if (previous) assert.ok(previous.rawScore > score.rawScore || previous.rawScore === score.rawScore && previous.ID > score.ID,
                'Score order changed within or across pages');
            seen.add(score.ID); scores.push(score);
        }
        report.scorePages.push({ rows: payload.scores.length, first: payload.scores[0]?.rawScore, last: payload.scores.at(-1)?.rawScore });
        cursor = payload.nextBeforeID;
        if (cursor === null) break;
    }
    assert.ok(scores.length > 50); report.sortedScores = scores.length;
    report.passed = true;
} catch (error) { report.failure = error.stack; throw error; }
finally { await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report));
