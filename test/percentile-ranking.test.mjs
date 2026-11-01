import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreDistribution, scorePercentile, percentileScore, createPercentileReference } from '../public/js/shared/available-score.js';
import { scoreComparison } from '../ranking-service.js';
import { comparisonOptions } from '../model-comparison.js';
import { validateWorkspacePayload } from '../public/js/workspace/contracts.js';
import { createFixtureState, weightedEntries, workspace } from '../scripts/frontend/fixtures.mjs';

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

test('all other recorded versions affect inference, even outside the weighted mix', () => {
    const models = [model(1, { 1: 80, 3: 10, 4: 10 }), model(2, { 1: 40, 2: 20, 3: 20, 4: 20 }),
        model(3, { 1: 60, 2: 40, 3: 30, 4: 30 }), model(4, { 1: 70, 2: 80, 3: 40, 4: 40 })];
    const rows = score(models), actual = rows[0];
    const archived = createPercentileReference(models);
    close(archived.estimate(models[0]).percentile, 1 / 3);
    close(percentileScore(archived.distributions.get('2'), 1 / 3), 100 / 3);
    assert.equal(actual.availableInference.percentile, null);
    assert.equal(actual.availableInference.method, 'pairwise-anchored-rational-coverage-factor');
    assert.equal(actual.availableInference.sourceCount, 3);
    assert.notEqual(actual.inferredScores[0].normalizedScore, 100 / 3);
    assert.equal(actual.lower, 45.94);
    assert.equal(actual.coverage, 50);
    assert.equal(actual.missingWeight, 50);
    assert.equal(actual.resultCount, 1);
    assert.equal(actual.calculationScores.length, 1);
    assert.deepEqual(actual.comparisonScores.map(item => item.conditionID), [1]);
    assert.equal(actual.inferredScores[0].conditionID, 2);
    const withoutOther = models.map(item => ({ ...item, results: new Map([...item.results].filter(([key]) => ['1', '2'].includes(key))) }));
    assert.equal(score(withoutOther)[0].lower, 66.67);
});

test('model value filters retain peers and field filters still restrict source configurations', () => {
    const models = [model(1, { 1: 80, 3: 10 }), model(2, { 1: 40, 2: 20, 3: 20 }), model(3, { 1: 60, 2: 30, 3: 30 })];
    const all = score(models)[0];
    const filtered = score(models, { filters: [{ key: 'model', operator: 'eq', value: 1 }] });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].lower, all.lower);
    assert.equal(filtered[0].availableInference.sourceCount, all.availableInference.sourceCount);
    const fields = [{ ID: 1, name: 'Harness', type: 'enum', allowEmpty: false, excludeMissing: true, excludeEmpty: false,
        options: [{ ID: 11, label: 'A', excluded: false }, { ID: 12, label: 'B', excluded: false }] }];
    const configurations = [model(1, { 1: 80, 3: 10 }, { 'field:1': 11 }),
        model(2, { 1: 40, 2: 20, 3: 20 }, { 'field:1': 11 }), model(3, { 1: 60, 2: 30, 3: 30 }, { 'field:1': 11 }),
        model(4, { 1: 100, 2: 500, 3: 0 }, { 'field:1': 12 })];
    const options = comparisonOptions(configurations, { mode: 'best', keys: ['model'],
        filters: [{ key: 'field:1', operator: 'eq', value: 11 }, { key: 'model', operator: 'eq', value: 1 }] }, fields);
    const [limited] = scoreComparison(configurations, entries, 10000, { scoreMode: 'available', availableInferenceVersion: 1 }, options);
    assert.equal(limited.lower, all.lower);
    assert.equal(limited.inferredScores[0].referenceCount, 2);
});

test('shared-test estimates include unweighted benchmarks without changing the weighted matched cohort', () => {
    const models = [model(1, { 1: 80, 3: 10, 4: 10 }, { harness: 'same' }),
        model(2, { 1: 40, 2: 20, 3: 20, 4: 20 }, { harness: 'same' }),
        model(3, { 1: 60, 2: 40, 3: 30, 4: 30 }, { harness: 'same' }),
        model(4, { 1: 70, 2: 80, 3: 40, 4: 40 }, { harness: 'same' })];
    const options = comparisonOptions(models, { mode: 'matched', keys: ['model'] });
    const available = scoreComparison(models, entries, 10000, { scoreMode: 'available', availableInferenceVersion: 1 }, options);
    const range = scoreComparison(models, entries, 10000, { scoreMode: 'range' }, options);
    assert.equal(available[0].lower, 45.94);
    assert.equal(available[0].availableInference.sourceCount, 3);
    assert.deepEqual(available.map(row => row.comparable), range.map(row => row.comparable));
    assert.deepEqual(available.map(row => row.comparisonScores), range.map(row => row.comparisonScores));
});

test('real fallback is resolved before estimation and estimates never fill another chain', () => {
    const models = [model(1, { 3: 25 }), model(2, { 1: 50, 2: 60, 3: 50 }), model(3, { 1: 75, 2: 80, 3: 75 }),
        model(4, { 1: 62, 2: 70, 3: 62 })];
    const rules = { fallbackRules: [{ primaryConditionID: 1, mode: 'ordered', entries: [{ conditionID: 3 }] }] };
    const result = score(models, {}, rules)[0];
    assert.equal(result.calculationScores[0].normalizedScore, 25);
    assert.equal(result.calculationScores[0].fallbackFor, 1);
    assert.equal(result.inferredScores[0].conditionID, 2);
    assert.equal(result.coverage, 50);
    assert.equal(result.fallbackUsageCount, 1);
    assert.equal(result.availableInference.unpenalizedScore, 42.5);
    assert.equal(result.lower, 35.42);
});

test('missing public configurations are estimated independently and remain unmeasured', () => {
    const models = [model(1, { 3: 25 }), model(2, { 1: 50, 2: 60, 3: 50 }), model(3, { 1: 75, 2: 80, 3: 75 }),
        model(4, { 1: 62, 2: 70, 3: 62 })];
    const familyComposition = [
        { primaryConditionID: 1, families: [
            { primaryConditionID: 1, familyID: 10, entries: [{ conditionID: 3 }], weightBasisPoints: 6000 },
            { primaryConditionID: 1, familyID: null, entries: [], weightBasisPoints: 4000 }] },
        { primaryConditionID: 2, families: [{ primaryConditionID: 2, familyID: null, entries: [], weightBasisPoints: 10000 }] }
    ];
    const result = score(models, {}, { fallbackScope: 'public', familyComposition })[0];
    assert.equal(result.coverage, 30);
    assert.equal(result.inferredScores.length, 2);
    close(result.availableInference.unpenalizedScore, 47.5);
    assert.equal(result.lower, 32.39);
    close(result.availableInference.inferredFraction, .7);
    close([...result.calculationScores, ...result.inferredScores].reduce((sum, value) => sum + value.effectiveWeight, 0), 100);
});

test('singleton reference sources cannot create an invented percentile; no target distribution stays unresolved', () => {
    const models = [model(1, { 1: 80, 3: 100 })];
    const result = score(models)[0];
    assert.equal(result.availableInference.unpenalizedScore, 80);
    assert.equal(result.lower, 66.67);
    assert.equal(result.availableInference.percentile, null);
    assert.equal(result.availableInference.sourceCount, 0);
    assert.equal(result.availableInference.unresolvedFraction, .5);
    assert.deepEqual(result.inferredScores, []);
    assert.equal(createPercentileReference(models).estimate(models[0]).sourceCount, 0);
});

test('an entry without real weighted evidence stays incomparable, even if other scores could estimate a total', () => {
    const result = score([model(1, { 3: 100 }), model(2, { 1: 80, 2: 90, 3: 80 })])[0];
    assert.equal(result.comparable, false);
    assert.equal(result.lower, null);
    assert.equal(result.availableInference, null);
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

test('estimated traces are validated and cannot be presented as real observations', () => {
    const models = [model(1, { 1: 80, 3: 10 }), model(2, { 1: 40, 2: 20, 3: 20 }), model(3, { 1: 60, 2: 30, 3: 30 })];
    const payload = workspace(createFixtureState({ comparisonModels: models,
        personalEntries: weightedEntries(entries), publicWeights: entries }), { scoreMode: 'available', initialMode: 'personal', availableInferenceVersion: 1 });
    assert.equal(validateWorkspacePayload(payload), payload);
    for (const mutation of [row => { row.inferredScores[0].contribution += 1; }, row => { row.coverage = 100; },
        row => { row.inferredScores[0].referenceCount = 0; }, row => { row.availableInference.percentile = .5; }]) {
        const changed = structuredClone(payload); mutation(changed.modelLeaderboards.personal.find(row => row.inferredScores.length));
        assert.throws(() => validateWorkspacePayload(changed), /Invalid workspace response/);
    }
});
