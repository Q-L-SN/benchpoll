import test from 'node:test';
import assert from 'node:assert/strict';
import { createPairwiseReference } from '../pairwise-score.js';
import { createPercentileReference, percentileScore } from '../public/js/shared/available-score.js';

const model = (ID, values) => ({ ID, modelID: ID, comparisonIdentity: String(ID),
    results: new Map(Object.entries(values).map(([key, normalizedScore]) => [key, { normalizedScore }])) });
const close = (left, right) => assert.ok(Math.abs(left - right) < 1e-7, `${left} != ${right}`);

test('common-test bridges prevent a weak-population winner from inheriting the strongest target score', () => {
    const models = [model(1, { 1: 95 }), model(2, { 1: 90, 3: 20, 2: 10 }),
        model(3, { 3: 80, 2: 70 }), model(4, { 2: 60 }), model(5, { 2: 90 })];
    const before = structuredClone(models), old = createPercentileReference(models);
    assert.equal(percentileScore(old.distributions.get('2'), old.estimate(models[0]).percentile), 90);
    const reference = createPairwiseReference(models), prediction = reference.predict(models[0], 2);
    assert.ok(reference.diagnostics.converged);
    assert.ok(prediction.normalizedScore < 60, JSON.stringify(prediction));
    assert.equal(prediction.sourceCount, 1); assert.equal(prediction.referenceCount, 4);
    assert.deepEqual(models, before);
});

test('unconnected populations and singleton target evidence do not invent estimates', () => {
    const models = [model(1, { 1: 90 }), model(2, { 1: 80 }), model(3, { 2: 60 }), model(4, { 2: 50 }), model(5, { 3: 40 })];
    const reference = createPairwiseReference(models);
    assert.equal(reference.predict(models[0], 2), null);
    assert.equal(reference.predict(models[0], 3), null);
    assert.equal(reference.estimate(models[4]).sourceCount, 0);
});

test('ties calibrate to the observed score and original scores remain unchanged', () => {
    const models = [model(1, { 1: 20 }), model(2, { 1: 20, 2: 70 }), model(3, { 1: 20, 2: 70 })];
    const reference = createPairwiseReference(models), prediction = reference.predict(models[0], 2);
    assert.equal(prediction.normalizedScore, 70); assert.equal(prediction.percentile, .5);
    assert.equal(reference.diagnostics.relativeResidual, 0);
});

test('source order, unrelated populations and duplicated source configurations do not alter a subject', () => {
    const models = [model(1, { 1: 75 }), model(2, { 1: 65, 2: 55 }), model(3, { 1: 90, 2: 80 }),
        model(4, { 1: 77, 2: 67 })];
    const expected = createPairwiseReference(models).predict(models[0], 2).normalizedScore;
    const shuffled = models.slice().reverse().map(m => ({ ...m, results: new Map([...m.results].reverse()) }));
    close(createPairwiseReference(shuffled).predict(shuffled.find(m => m.ID === 1), 2).normalizedScore, expected);
    const extra = [...models, model(8, { 8: 30 }), model(9, { 8: 20 })];
    close(createPairwiseReference(extra).predict(models[0], 2).normalizedScore, expected);
    assert.throws(() => createPairwiseReference([...models, models[0]]), /Duplicate comparison identity/);
});

test('a restricted composite is estimated from its own observations, not broader reference-group scores', () => {
    const peers = [model(1, { 1: 90, 2: 95 }), model(2, { 1: 60, 2: 70 }), model(3, { 1: 30, 2: 40 }),
        model(4, { 1: 45, 2: 55 })];
    const restricted = model(1, { 1: 20 });
    const prediction = createPairwiseReference(peers).predict(restricted, 2);
    assert.ok(prediction.normalizedScore <= 70);
    assert.equal(prediction.referenceCount, 3);
});

test('non-percent bounds and extremely large finite scores stay finite', () => {
    const models = [model(1, { 1: -1e308 }), model(2, { 1: 0, 2: -1e308 }), model(3, { 1: 1e308, 2: 1e308 })];
    assert.ok(Number.isFinite(createPairwiseReference(models).predict(models[0], 2).normalizedScore));
    models[2].results.set('2', { normalizedScore: -1e308 });
    const prediction = createPairwiseReference(models).predict(models[0], 2);
    assert.ok(Number.isFinite(prediction.normalizedScore));
    assert.ok(prediction.percentile >= 0 && prediction.percentile <= 1);
    assert.throws(() => createPairwiseReference([model(1, { 1: NaN })]), TypeError);
});

test('isolated high or low anchors have limited influence without suppressing estimates', () => {
    for (const values of [[2, 4, 6, 8, 99], [1, 92, 94, 96, 98], [2, 4, 6, 98, 99]]) {
        const models = [model(1, { 1: 100 }), ...values.map((value, i) =>
            model(i + 2, { 1: i * 20, 2: value }))];
        const before = structuredClone(models);
        const reference = createPairwiseReference(models);
        const predictions = [reference.predict(models[0], 2), reference.predict({ ...models[0], results: new Map([[1, { normalizedScore: 0 }]]) }, 2)];
        assert.ok(predictions.every(prediction => Number.isFinite(prediction?.normalizedScore)), JSON.stringify({ values, predictions }));
        if (values[0] === 1) assert.ok(predictions[1].normalizedScore > 80, JSON.stringify(predictions));
        else assert.ok(predictions[0].normalizedScore < 20, JSON.stringify(predictions));
        assert.equal(predictions[0].referenceCount, values.length);
        assert.deepEqual(models, before);
    }
});

test('supported high scores and broadly separated distributions are not suppressed', () => {
    const models = [model(1, { 1: 100 }), model(2, { 1: 70, 2: 90 }),
        model(3, { 1: 80, 2: 94 }), model(4, { 1: 90, 2: 98 })];
    const prediction = createPairwiseReference(models).predict(models[0], 2);
    assert.ok(prediction.normalizedScore >= 90);
    const pair = [model(1, { 1: 100 }), model(2, { 1: 50, 2: 1 }), model(3, { 1: 90, 2: 99 })];
    assert.ok(Number.isFinite(createPairwiseReference(pair).predict(pair[0], 2).normalizedScore));
    const broad = [model(1, { 1: 100 }), ...[0, 30, 60, 90].map((value, i) => model(i + 2, { 1: i * 20, 2: value }))];
    assert.equal(createPairwiseReference(broad).predict(broad[0], 2).normalizedScore, 90);
});
