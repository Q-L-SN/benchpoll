import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { scoreEvidenceKey, scoreValueKey } from '../score-aggregation.js';
import { loadModels } from '../ranking-service.js';
import { upgradeScoreContent } from '../scripts/migrate-remove-score-providers.mjs';

function contract() {
    const text = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    const sandbox = vm.createContext({ URL, crypto, structuredClone });
    vm.runInContext(text.slice(text.indexOf('function normalizeString('), text.indexOf('function parseModerationContent('))
        + '\nthis.api = { buildContributionContent, normalizeStoredModerationContent };', sandbox);
    return sandbox.api;
}
const request = (source = {}) => ({ type: 'benchmark_result', reviewerNotes: 'Review only', results: [{ clientRef: 'score', modelID: 1,
    modelConditionID: 2, benchmarkID: 3, benchmarkConditionID: 4, rawScore: 55,
    source: { type: 'other', url: 'https://example.com/report', title: '', ...source } }] });

test('scores require a source URL and reject removed provider fields and applications', () => {
    const api = contract();
    const content = api.buildContributionContent(request());
    assert.equal(content.schemaVersion, 8);
    assert.deepEqual(Object.keys(content.results[0].source).sort(), ['title', 'type', 'url']);
    assert.equal(api.normalizeStoredModerationContent(content).results[0].source.url, 'https://example.com/report');
    for (const source of [{ url: '' }, { providerID: 1 }, { providerRef: null }]) {
        assert.throws(() => api.buildContributionContent(request(source)));
    }
    assert.throws(() => api.buildContributionContent({ type: 'new_provider', name: 'Lab' }));
    assert.throws(() => api.normalizeStoredModerationContent({ ...content, schemaVersion: 7 }));
});

test('deduplication uses exact numeric values within condition pairs without rounding', () => {
    assert.equal(scoreValueKey(2, 3, '80.0'), scoreValueKey(2, 3, 80));
    assert.equal(scoreValueKey(2, 3, -0), scoreValueKey(2, 3, 0));
    assert.notEqual(scoreValueKey(2, 3, 80.12), scoreValueKey(2, 3, 80.14));
    assert.notEqual(scoreValueKey(2, 3, 80), scoreValueKey(2, 4, 80));
    assert.notEqual(scoreValueKey(2, 3, 80), scoreValueKey(4, 3, 80));
    assert.equal(scoreEvidenceKey(2, 3, 'https://example.com/a#table', '80.0'), scoreEvidenceKey(2, 3, 'https://example.com/a', 80));
    assert.notEqual(scoreEvidenceKey(2, 3, 'https://example.com/a', 80), scoreEvidenceKey(2, 3, 'https://example.com/b', 80));
});

const base = { model_ID: 1, model_name: 'Model', vendor_name: 'Lab', vendor_slug: 'lab', logo_key: null,
    model_condition_ID: 2, model_condition_name: 'default', parameters: {}, condition_key: 'default', model_condition_is_default: 1,
    benchmark_condition_ID: 3, uses_percentage_scale: 1, score_min: null, score_max: null,
    score_direction: 'higher', target_value: null };
async function aggregate(values, overrides = {}) {
    const [model] = await loadModels({ async execute() { return [values.map((raw_score, i) => ({ ...base, ...overrides,
        result_ID: i + 1, raw_score, source_url: `https://example.com/report-${i}` })), []]; } });
    return model.results.get('3');
}

test('different URLs and repeated values cannot skew the median', async () => {
    assert.deepEqual(await aggregate([80, '80.0', 80, 82, 84]), { normalizedScore: 82, sampleCount: 3 });
    assert.deepEqual(await aggregate([20, 80, 80, 80]), { normalizedScore: 50, sampleCount: 2 });
    assert.deepEqual(await aggregate([80, 80]), { normalizedScore: 80, sampleCount: 1 });
    assert.deepEqual(await aggregate([80.12, 80.14]), { normalizedScore: 80.13, sampleCount: 2 });
});

test('deduplicate raw values first, then normalize each and take median including target-based scoring', async () => {
    assert.deepEqual(await aggregate([0, 5, 10, 10], { uses_percentage_scale: 0,
        score_min: 0, score_max: 10, score_direction: 'closer_to_target', target_value: 5 }),
    { normalizedScore: 0, sampleCount: 3 });
    assert.deepEqual(await aggregate([20, 20, 80], { score_direction: 'lower' }), { normalizedScore: 50, sampleCount: 2 });
    const unbounded = await aggregate([-10, -10, 110], { uses_percentage_scale: 0, score_min: 0, score_max: 100 });
    assert.equal(unbounded.sampleCount, 2);
    assert.ok(Math.abs(unbounded.normalizedScore - 50) < 1e-10);
});

test('migration removes provider metadata without mutating original evidence or reviewer notes', () => {
    const original = { ...request({ providerID: 7, providerRef: null }), schemaVersion: 7 };
    const migrated = upgradeScoreContent(original);
    assert.equal(migrated.schemaVersion, 8);
    assert.equal(migrated.results[0].source.url, original.results[0].source.url);
    assert.equal(migrated.results[0].rawScore, 55);
    assert.equal(migrated.reviewerNotes, 'Review only');
    assert.equal(original.results[0].source.providerID, 7);
    assert.ok(!('providerID' in migrated.results[0].source));
    assert.equal(upgradeScoreContent(migrated), null);
    assert.throws(() => upgradeScoreContent({ ...original, schemaVersion: 6 }));
});

test('score correction and merge snapshots migrate together, preserving identities and change history', () => {
    const result = request({ providerID: 7, providerRef: null }).results[0];
    for (const operation of ['update', 'delete', 'merge']) {
        const original = { type: 'entity_change', schemaVersion: 7, targetKind: 'result', targetID: 42, operation,
            before: { result }, after: operation === 'update' ? { result: { ...result, rawScore: 90 } }
                : operation === 'merge' ? { destinationBefore: { result }, destinationID: 43 } : null,
            changes: [{ path: 'result.rawScore', before: 55, after: 90 }], reviewNotes: 'Keep note' };
        const next = upgradeScoreContent(original);
        assert.equal(next.targetID, 42);
        assert.ok(!('providerID' in next.before.result.source));
        assert.equal(next.reviewNotes, 'Keep note');
        assert.deepEqual(next.changes, original.changes);
        if (operation === 'update') assert.ok(!('providerID' in next.after.result.source));
        if (operation === 'merge') assert.ok(!('providerID' in next.after.destinationBefore.result.source));
    }
});
