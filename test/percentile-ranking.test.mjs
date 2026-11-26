import { pairedModels } from './helpers/fallback-pairs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreDistribution, scorePercentile, percentileScore, createPercentileReference } from '../public/js/shared/available-score.js';
import { scoreComparison } from '../ranking-service.js';
import { comparisonOptions } from '../model-comparison.js';

const model = (ID, values, parameters = {}, modelID = ID) => ({ ID, modelID, name: `M${ID}`, modelName: `M${modelID}`,
    condition: { parameters, scoreFields: [] }, results: new Map(Object.entries(values).map(([key, normalizedScore]) => [key, { normalizedScore }])) });
const entries = [1, 2].map(conditionID => ({ conditionID, weightBasisPoints: 5000 }));
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const score = (models, options = {}, rules = {}) => scoreComparison(models, entries, 10000,
    { ...rules, scoreMode: 'available', availableInferenceVersion: 1 }, comparisonOptions(models, { mode: 'best', keys: ['model'], ...options }));

test('percentile ties use midranks, endpoints and interpolation are deterministic', () => {
    const distribution = scoreDistribution([-20, 0, 0, 100, 150]);
    assert.equal(scorePercentile(distribution, 0), .375);
    assert.equal(scorePercentile(distribution, -20), 0);
    assert.equal(scorePercentile(distribution, 150), 1);
    assert.equal(percentileScore(distribution, .375), 0);
    assert.equal(percentileScore(distribution, .625), 50);
    assert.equal(scorePercentile(scoreDistribution([5, 5, 5]), 5), .5);
    assert.equal(scorePercentile(scoreDistribution([5]), 5), null);
    assert.equal(percentileScore(scoreDistribution([]), .5), null);
    for (const value of [-1, 1.1, NaN, Infinity]) assert.throws(() => percentileScore(distribution, value), TypeError);
    assert.throws(() => scoreDistribution([0, NaN]), TypeError);
    close(percentileScore(scoreDistribution([-1e308, 1e308]), .5), 0);
});

test('changing scores outside the treemap cannot affect the estimate for a missing benchmark', () => {
    const models = [model(1, { 1: 80, 3: 10, 4: 10 }), model(2, { 1: 40, 2: 20, 3: 20, 4: 20 }),
        model(3, { 1: 60, 2: 40, 3: 30, 4: 30 }), model(4, { 1: 70, 2: 80, 3: 40, 4: 40 })];
    const actual = score(models)[0];
    const archived = createPercentileReference(models);
    close(archived.estimate(models[0]).percentile, 1 / 3);
    close(percentileScore(archived.distributions.get('2'), 1 / 3), 100 / 3);
    assert.equal(actual.lower, 80);
    assert.equal(actual.coverage, 50);
    assert.equal(actual.resultCount, 1);
    assert.deepEqual(actual.inferredScores.map(row => [row.conditionID, row.estimationMethod, row.normalizedScore]),
        [[2, 'treemap-weighted', 80]]);
    const onlyWeighted = models.map(item => ({ ...item, results: new Map([...item.results].filter(([key]) => ['1', '2'].includes(key))) }));
    const [scoped] = score(onlyWeighted);
    assert.deepEqual(scoped.availableInference, actual.availableInference);
    assert.deepEqual(scoped.inferredScores, actual.inferredScores);
});

test('displaying one model preserves eligible paired measurements under the selected harness', () => {
    const models = [model(1, { 1: 80, 3: 85 }, { harness: 'A' }), ...pairedModels(2, 3, 85, -10, { harness: 'A' }),
        ...pairedModels(2, 3, 85, 12, { harness: 'B' }).map(p => ({ ...p, ID: p.ID + 100, modelID: p.ID + 100 }))];
    const rules = { fallbackRules: [{ primaryConditionID: 2, mode: 'ordered', entries: [{ conditionID: 3 }] }] };
    const all = score(models, {}, rules)[0];
    const [filtered] = score(models, { filters: [{ key: 'model', operator: 'eq', value: 1 },
        { key: 'harness', operator: 'eq', value: 'A' }] }, rules);
    assert.equal(all.lower, 77.5);
    assert.deepEqual(filtered.inferredScores, all.inferredScores);
    assert.equal(filtered.inferredScores[0].referenceCount, 5);
});

test('an entry without real weighted evidence stays incomparable, even if other scores could estimate a total', () => {
    const result = score([model(1, { 3: 100 }), model(2, { 1: 80, 2: 90, 3: 80 })])[0];
    assert.equal(result.comparable, false);
    assert.equal(result.lower, null);
    assert.equal(result.availableInference.totalScore, 0);
    assert.equal(result.availableInference.unresolvedFraction, 1);
    assert.deepEqual(result.inferredScores, []);
});

test('full coverage, duplicate configuration projection and source immutability', () => {
    const models = [model(1, { 1: -20, 2: 120 }), model(2, { 1: -30, 2: 100 }, { harness: 'b' }, 1),
        model(3, { 1: 0, 2: 70 })];
    const before = structuredClone(models), result = score(models)[0];
    assert.equal(result.lower, 50);
    assert.equal(result.coverage, 100);
    assert.deepEqual(result.inferredScores, []);
    assert.equal(result.availableInference.inferredContribution, 0);
    assert.deepEqual(models, before);
});
