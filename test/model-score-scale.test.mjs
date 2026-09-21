import assert from 'node:assert/strict';
import test from 'node:test';
import { modelScoreScale } from '../public/js/workspace/model-list.js';
import { scoreModels } from '../ranking-service.js';

test('model chart scale includes 0-100 even when empty or all scores are inside it', () => {
    for (const rows of [[], [{ lower: 40, upper: 60 }], [{ lower: 0, upper: 100 }]]) {
        const scale = modelScoreScale(rows);
        assert.equal(scale.min, 0);
        assert.equal(scale.max, 100);
        assert.equal(scale.position(40), 40);
    }
});

test('one scale covers all lower and upper endpoints, not just ranked lower scores', () => {
    const rows = [{ lower: 120, upper: 150 }, { lower: -50, upper: 80 }, { lower: 30, upper: 200 }];
    const before = structuredClone(rows);
    const scale = modelScoreScale(rows);
    assert.equal(scale.min, -50);
    assert.equal(scale.max, 200);
    assert.equal(scale.zero, 20);
    assert.equal(scale.position(-50), 0);
    assert.equal(scale.position(200), 100);
    assert.equal(scale.position(100), 60);
    assert.deepEqual(rows, before);
});

test('negative-only and positive-overflow lists retain their opposite default endpoint', () => {
    assert.equal(modelScoreScale([{ lower: -100, upper: -20 }]).max, 100);
    assert.equal(modelScoreScale([{ lower: 120, upper: 180 }]).min, 0);
    assert.throws(() => modelScoreScale([{ lower: -Infinity, upper: 100 }]));
    assert.throws(() => modelScoreScale([{ lower: 20, upper: 10 }]));
    assert.throws(() => modelScoreScale([{ lower: NaN, upper: 100 }]));
});

test('missing benchmark scores still contribute 0-100 without clipping known scores', () => {
    const models = [-50, 150].map((value, i) => ({ ID: i + 1, modelID: i + 1, name: `Model ${i}`,
        results: new Map([['1', { normalizedScore: value, sampleCount: 1 }]]) }));
    const ranked = scoreModels(models, [{ conditionID: 1, weightBasisPoints: 5000 }, { conditionID: 2, weightBasisPoints: 5000 }], 10000);
    assert.deepEqual(ranked.map(row => [row.lower, row.upper]), [[-25, 25], [75, 125]]);
    const scale = modelScoreScale(ranked);
    assert.equal(scale.min, -25);
    assert.equal(scale.max, 125);
});
