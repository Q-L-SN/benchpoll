import { pairedModels } from './helpers/fallback-pairs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { storedAvailableResultInference, PAIRWISE_RATIONAL_COVERAGE_FACTOR_METHOD, AVAILABLE_INFERENCE_VERSION,
    rankingReadBody } from '../public/js/shared/available-score.js';
import { coverageMultiplier, RATIONAL_COVERAGE_A } from '../public/js/shared/coverage-penalty.js';
import { scoreModels, scoreComparison } from '../ranking-service.js';
import { comparisonOptions } from '../model-comparison.js';
import { rankModels } from '../ranking-pagination.js';
import { validateWorkspacePayload } from '../public/js/workspace/contracts.js';
import { createFixtureState, weightedEntries, workspace } from '../scripts/frontend/fixtures.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) <= Math.max(1e-9, Math.abs(expected) * 1e-14), `${actual} != ${expected}`);
const infer = (score, coverage, estimates = [], sources = 0) => storedAvailableResultInference(score, coverage, estimates, null, sources,
    { method: PAIRWISE_RATIONAL_COVERAGE_FACTOR_METHOD });
const model = (ID, values) => ({ ID, modelID: ID, name: `M${ID}`, modelName: `M${ID}`,
    condition: { parameters: { harness: 'same' }, scoreFields: [] },
    results: new Map(Object.entries(values).map(([key, normalizedScore]) => [key, { normalizedScore }])) });
const weights = [1, 2].map(conditionID => ({ conditionID, weightBasisPoints: 5000 }));
const score = (models, entries = weights, rules = {}, mode = 'best') => scoreComparison(models, entries, 10000,
    { scoreMode: 'available', ...rules }, comparisonOptions(models, { mode, keys: ['model'] }));

test('nonnegative totals use the rational measured-coverage factor, with no flat deduction', () => {
    for (const value of [0, 20, 80, 100, 150]) for (const coverage of [.000001, .01, .1, .25, .5, .9, 1]) {
        const result = infer(value, coverage);
        close(result.coverageFactor, 5 * coverage / (1 + 4 * coverage));
        close(result.appliedFactor, coverageMultiplier(coverage));
        close(result.totalScore, value * coverageMultiplier(coverage));
        assert.equal(result.unpenalizedScore, value);
        assert.equal(Object.hasOwn(result, 'coveragePenalty'), false);
    }
    close(infer(80, .25).totalScore, 50);
});

test('negative totals move down by the same relative shortfall instead of toward zero', () => {
    for (const value of [-200, -80, -20, -.001]) {
        let previous = -Infinity;
        for (const coverage of [.000001, .01, .1, .25, .5, .9, 1]) {
            const result = infer(value, coverage);
            close(result.coverageFactor, coverageMultiplier(coverage));
            close(result.appliedFactor, 2 - coverageMultiplier(coverage));
            close(result.totalScore, value * (2 - coverageMultiplier(coverage)));
            assert.ok(result.totalScore >= previous && result.totalScore <= value);
            previous = result.totalScore;
        }
    }
    close(infer(-20, .25).totalScore, -27.5);
});

test('rational a=5 is increasing and concave and preserves full coverage', () => {
    assert.equal(RATIONAL_COVERAGE_A, 5);
    close(infer(100, .3).coverageFactor, 15 / 22);
    close(infer(100, .5).coverageFactor, 5 / 6);
    assert.equal(infer(100, 1).coverageFactor, 1);
    let previous = 0;
    for (let step = 1; step <= 1000; step++) {
        const coverage = step / 1000, value = infer(100, coverage).coverageFactor;
        assert.ok(value > previous && value >= coverage); previous = value;
        if (step > 1 && step < 1000) assert.ok(value + 1e-12 >=
            (infer(100, coverage - .001).coverageFactor + infer(100, coverage + .001).coverageFactor) / 2);
    }
});

test('factor preserves score order at fixed coverage and is continuous across zero', () => {
    for (const coverage of [.01, .25, .5, 1]) {
        const values = [-100, -20, -.001, 0, .001, 20, 100].map(value => infer(value, coverage).totalScore);
        assert.ok(values.every((value, index) => !index || value > values[index - 1]));
        assert.equal(infer(0, coverage).totalScore, 0);
    }
});

test('finite extremes and tiny positive coverage never produce division overflow or invalid JSON', () => {
    for (const value of [-Number.MAX_VALUE, -1e308, Number.MAX_VALUE, 1e308, Number.MIN_VALUE]) {
        for (const coverage of [Number.MIN_VALUE, 1e-200, .25, 1]) {
            const result = infer(value, coverage);
            assert.ok(Number.isFinite(result.totalScore));
            assert.ok(result.totalScore <= value);
            assert.ok(result.appliedFactor > 0 && result.appliedFactor <= 2);
            assert.equal(JSON.parse(JSON.stringify(result)).totalScore, result.totalScore);
        }
    }
    assert.equal(infer(-Number.MAX_VALUE, .25).totalScore, -Number.MAX_VALUE);
    close(infer(-1e308, .25).totalScore, -1e308 * 1.375);
    for (const coverage of [0, -.1, 1.1, NaN, Infinity]) assert.throws(() => infer(80, coverage), TypeError);
});

test('archived factors adjust the combined score while new totals retain original weights', () => {
    const result = infer(80, .5, [{ normalizedScore: 40, weightFraction: .5 }], 2);
    assert.equal(result.unpenalizedScore, 60);
    close(result.totalScore, 50);
    assert.equal(result.observedContribution, 40);
    assert.equal(result.inferredContribution, 20);
    const entries = [...weights.map(entry => ({ ...entry, weightBasisPoints: 2500 })), { conditionID: 3, weightBasisPoints: 5000 }];
    const [row] = score([model(1, { 1: 100, 2: -80 })], entries);
    assert.equal(row.availableInference.unpenalizedScore, 5);
    assert.equal(row.lower, 5);
    assert.deepEqual(row.calculationScores.map(item => item.contribution), [25, -20]);
});

test('weighted coverage, real zero and zero-weight versions retain their exact meaning', () => {
    const entries = [{ conditionID: 1, weightBasisPoints: 9000 }, { conditionID: 2, weightBasisPoints: 1000 },
        { conditionID: 3, weightBasisPoints: 0 }];
    const rows = score([model(1, { 1: 80, 3: 100 }), model(2, { 2: 80 }), model(3, { 1: 0 })], entries);
    assert.deepEqual(rows.map(row => row.coverage), [90, 10, 90]);
    assert.deepEqual(rows.map(row => row.lower), [72, 8, 0]);
    assert.deepEqual(rows.map(row => row.resultCount), [1, 1, 1]);
});

test('point totals use exact weights independently of displayed coverage rounding', () => {
    const coverage = .123456789;
    const [row] = score([model(1, { 1: 80 })], [{ conditionID: 1, weightBasisPoints: coverage * 10000 },
        { conditionID: 2, weightBasisPoints: (1 - coverage) * 10000 }]);
    close(row.availableInference.coverageFraction, coverage);
    close(row.availableInference.totalScore, 80 * coverage);
    assert.notEqual(row.availableInference.totalScore, 80 * row.coverage / 100);
});

test('calibrated public shares support the point score while direct coverage stays separate', () => {
    const models = [model(1, { 3: 75 }), ...pairedModels(1, 3, 75, -5, { harness: 'same' })];
    const rule = { primaryConditionID: 1, familyID: 10, mode: 'ordered', entries: [{ conditionID: 3 }] };
    const [personal] = score(models, weights, { fallbackRules: [rule] });
    assert.equal(personal.coverage, 0);
    close(personal.availableInference.totalScore, 35);
    assert.equal(personal.inferredScores[0].normalizedScore, 70);
    const [shared] = score(models, weights, { fallbackScope: 'public', familyComposition: [
        { primaryConditionID: 1, families: [{ ...rule, weightBasisPoints: 6000 },
            { primaryConditionID: 1, familyID: null, entries: [], weightBasisPoints: 4000 }] }
    ] });
    assert.equal(shared.coverage, 0);
    close(shared.availableInference.totalScore, 21);
    close(shared.availableInference.inferredFraction, .3);
    assert.equal(shared.inferredScores.length, 1);
});

test('fully covered totals and Score range remain unchanged; no weighted evidence stays incomparable', () => {
    const models = [model(1, { 1: -20, 2: -40 }), model(2, { 1: 80, 2: 100 })];
    assert.deepEqual(score(models).map(row => row.lower), [-30, 90]);
    assert.ok(score(models).every(row => row.availableInference.unresolvedFraction === 0));
    assert.deepEqual(score(models, weights, { scoreMode: 'range' }).map(row => row.lower), [-30, 90]);
    const [missing] = score([model(1, { 3: 100 }), model(2, { 1: 80, 2: 90, 3: 80 })]);
    assert.equal(missing.comparable, false);
    assert.equal(missing.lower, null);
    assert.equal(missing.availableInference.totalScore, 0);
    assert.equal(missing.availableInference.unresolvedFraction, 1);
});

test('stale version requests retain all observations and pairwise predictions; lazy metadata remains valid', () => {
    const models = [model(1, { 1: 95 }), model(2, { 1: 90, 3: 20, 2: 10 }),
        model(3, { 3: 80, 2: 70 }), model(4, { 2: 60 }), model(5, { 2: 90 })];
    const before = structuredClone(models), legacy = score(models, weights, { availableInferenceVersion: 2 });
    const current = score(models);
    current.forEach((row, index) => {
        assert.deepEqual(row.calculationScores, legacy[index].calculationScores);
        assert.deepEqual(row.inferredScores, legacy[index].inferredScores);
        assert.deepEqual(row.comparisonScores, legacy[index].comparisonScores);
        assert.deepEqual(row.availableInference, legacy[index].availableInference);
    });
    assert.deepEqual(models, before);
    const eager = scoreModels(models, weights, 10000, { scoreMode: 'available' });
    const lazy = scoreModels(models, weights, 10000, { scoreMode: 'available', deferMetadata: true });
    assert.deepEqual(JSON.parse(JSON.stringify(lazy)), JSON.parse(JSON.stringify(eager)));
});

test('ranking uses the weighted total including actual negative results and zero-value gaps', () => {
    const entries = [{ conditionID: 1, weightBasisPoints: 1000 }, { conditionID: 2, weightBasisPoints: 9000 }];
    const models = [model(1, { 1: 88 }), model(2, { 1: 80, 2: 80 })];
    assert.deepEqual(rankModels(score(models, entries)).map(row => row.modelID), [2, 1]);
    const negatives = score([model(1, { 1: -20 }), model(2, { 1: -20, 2: -20 })], entries);
    assert.deepEqual(negatives.map(row => row.lower), [-2, -20]);
    assert.deepEqual(rankModels(negatives).map(row => row.modelID), [1, 2]);
});

test('all stale read versions and matched comparisons calculate original-weight totals', () => {
    const models = [model(1, { 1: 80 }), model(2, { 1: 60 })];
    for (const mode of ['best', 'matched']) {
        for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
            const rows = score(models, weights, { availableInferenceVersion: version }, mode);
            assert.deepEqual(rows.map(row => row.lower), [40, 30]);
            assert.ok(rows.every(row => row.availableInference.weightPolicy === 'original'));
        }
    }
    assert.equal(AVAILABLE_INFERENCE_VERSION, 10);
    assert.equal(rankingReadBody('/api/get_weighted_workspace', {}).availableInferenceVersion, 10);
    for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9]) assert.equal(rankingReadBody('/api/get_weighted_workspace', { availableInferenceVersion: version }).availableInferenceVersion, 10);
});

test('rounding preserves finite extreme totals instead of overflowing them while forming a ranking', () => {
    const [row] = score([model(1, { 1: -1e308 })]);
    assert.ok(Number.isFinite(row.lower));
    close(row.lower, -5e307);
    assert.equal(JSON.parse(JSON.stringify(row)).lower, row.lower);
});

test('validation checks original weights and sums for either score sign', () => {
    for (const value of [80, -20]) {
        const payload = workspace(createFixtureState({ comparisonModels: [model(1, { 1: value }), model(2, { 1: 60, 2: 70 })],
            personalEntries: weightedEntries(weights), publicWeights: weights }), { scoreMode: 'available', initialMode: 'personal' });
        assert.equal(validateWorkspacePayload(payload), payload);
        for (const mutation of [row => { row.availableInference.coverageFactor = 1; },
            row => { row.availableInference.unresolvedContribution = 50; }, row => { delete row.availableInference.weightPolicy; },
            row => { row.availableInference.unpenalizedScore++; }, row => { row.availableInference.totalScore++; },
            row => { row.calculationScores[0].contribution++; }]) {
            const changed = structuredClone(payload);
            mutation(changed.modelLeaderboards.personal.find(row => row.missingWeight > 0));
            assert.throws(() => validateWorkspacePayload(changed), /Invalid workspace response/);
        }
    }
});
