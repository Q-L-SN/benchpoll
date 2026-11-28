import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { modelScoreScale } from '../public/js/workspace/model-list.js';
import { scoreModels } from '../ranking-service.js';

test('horizontal score bars do not render standalone zero-reference lines', async () => {
    for (const path of ['public/js/workspace/model-list.js', 'public/css/ui/workspace.css', 'public/css/site-palette.css']) {
        const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
        assert.doesNotMatch(source, /bp-score-zero/, path);
    }
});

test('model chart scale defaults to 0–100 without a positive leader or negative scores', () => {
    for (const rows of [[], [{ lower: 0 }]]) {
        const scale = modelScoreScale(rows);
        assert.equal(scale.min, 0);
        assert.equal(scale.max, 100);
        assert.equal(scale.position(40), 40);
    }
});

test('one scale covers all ranked scores, including scores outside 0–100', () => {
    const rows = [{ lower: 150 }, { lower: 30 }, { lower: -50 }];
    const before = structuredClone(rows);
    const scale = modelScoreScale(rows);
    assert.equal(scale.min, -50);
    assert.equal(scale.max, 150);
    assert.equal(scale.zero, 25);
    assert.equal(scale.position(-50), 0);
    assert.equal(scale.position(150), 100);
    assert.equal(scale.position(100), 75);
    assert.deepEqual(rows, before);
});

test('negative-only and positive-overflow lists retain their opposite default endpoint', () => {
    assert.equal(modelScoreScale([{ lower: -100, upper: -20 }]).max, 100);
    assert.equal(modelScoreScale([{ lower: 120, upper: 180 }]).min, 0);
    assert.throws(() => modelScoreScale([{ lower: -Infinity, upper: 100 }]));
    assert.throws(() => modelScoreScale([{ lower: NaN, upper: 100 }]));
});

test('scores without an eligible estimate use the measured weight at its actual scale', () => {
    const models = [-50, 150].map((value, i) => ({ ID: i + 1, modelID: i + 1, name: `Model ${i}`,
        results: new Map([['1', { normalizedScore: value, sampleCount: 1 }]]) }));
    const ranked = scoreModels(models, [{ conditionID: 1, weightBasisPoints: 5000 }, { conditionID: 2, weightBasisPoints: 5000 }], 10000,
        { scoreMode: 'available' }).sort((left, right) => right.lower - left.lower);
    assert.deepEqual(ranked.map(row => [row.lower, row.upper]), [[75, 75], [-25, -25]]);
    const scale = modelScoreScale(ranked);
    assert.equal(scale.min, -25);
    assert.equal(scale.max, 75);
});

test('first-place bar scaling changes only display coordinates', () => {
    const rows = [{ lower: 60, upper: 60, comparable: true }, { lower: -20, upper: -20, comparable: true }];
    const before = structuredClone(rows);
    const scale = modelScoreScale(rows, { min: -20, max: 100 });
    assert.equal(scale.min, -20);
    assert.equal(scale.max, 60);
    assert.equal(scale.barStart, -20);
    assert.equal(scale.position(rows[0].lower), 100);
    assert.deepEqual(rows, before);
});
