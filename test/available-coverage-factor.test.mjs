import test from 'node:test';
import assert from 'node:assert/strict';
import { availableResultInference, PAIRWISE_RATIONAL_COVERAGE_FACTOR_METHOD, AVAILABLE_INFERENCE_VERSION, rankingReadBody } from '../public/js/shared/available-score.js';
import { coverageMultiplier, RATIONAL_COVERAGE_A } from '../public/js/shared/coverage-penalty.js';
import { scoreModels, scoreComparison } from '../ranking-service.js';
import { comparisonOptions } from '../model-comparison.js';
import { rankModels } from '../ranking-pagination.js';
import { validateWorkspacePayload } from '../public/js/workspace/contracts.js';
import { createFixtureState, weightedEntries, workspace } from '../scripts/frontend/fixtures.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) <= Math.max(1e-9, Math.abs(expected) * 1e-14), `${actual} != ${expected}`);
const infer = (score, coverage, estimates = [], sources = 0) => availableResultInference(score, coverage, estimates, null, sources);
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

test('factor applies after combining measured and predicted scores, not to each score independently', () => {
    const result = infer(80, .5, [{ normalizedScore: 40, weightFraction: .5 }], 2);
    assert.equal(result.unpenalizedScore, 60);
    close(result.totalScore, 50);
    assert.equal(result.observedContribution, 40);
    assert.equal(result.inferredContribution, 20);
    const entries = [...weights.map(entry => ({ ...entry, weightBasisPoints: 2500 })), { conditionID: 3, weightBasisPoints: 5000 }];
    const [row] = score([model(1, { 1: 100, 2: -80 })], entries);
    assert.equal(row.availableInference.unpenalizedScore, 10);
    assert.equal(row.lower, 8.33);
    assert.deepEqual(row.calculationScores.map(item => item.contribution), [50, -40]);
});

test('weighted coverage, real zero and zero-weight versions retain their exact meaning', () => {
    const entries = [{ conditionID: 1, weightBasisPoints: 9000 }, { conditionID: 2, weightBasisPoints: 1000 },
        { conditionID: 3, weightBasisPoints: 0 }];
    const rows = score([model(1, { 1: 80, 3: 100 }), model(2, { 2: 80 }), model(3, { 1: 0 })], entries);
    assert.deepEqual(rows.map(row => row.coverage), [90, 10, 90]);
    close(rows[0].availableInference.coverageFactor, 45 / 46);
    close(rows[1].availableInference.coverageFactor, 5 / 14);
    assert.equal(rows[2].lower, 0);
    assert.deepEqual(rows.map(row => row.resultCount), [1, 1, 1]);
});

test('the rational factor uses exact coverage rather than the rounded displayed percentage', () => {
    const coverage = .123456789;
    const [row] = score([model(1, { 1: 80 })], [{ conditionID: 1, weightBasisPoints: coverage * 10000 },
        { conditionID: 2, weightBasisPoints: (1 - coverage) * 10000 }]);
    close(row.availableInference.coverageFraction, coverage);
    close(row.availableInference.coverageFactor, 5 * coverage / (1 + 4 * coverage));
    assert.notEqual(row.availableInference.coverageFactor, coverageMultiplier(row.coverage / 100));
});

test('real fallback and fractional Public configurations count as coverage before applying the factor', () => {
    const models = [model(1, { 3: 25 }), model(2, { 1: 50, 2: 60, 3: 50 }), model(3, { 1: 75, 2: 80, 3: 75 }),
        model(4, { 1: 62, 2: 70, 3: 62 })];
    const rule = { primaryConditionID: 1, familyID: 10, mode: 'ordered', entries: [{ conditionID: 3 }] };
    const [personal] = score(models, weights, { fallbackRules: [rule] });
    assert.equal(personal.coverage, 50);
    close(personal.availableInference.coverageFactor, 5 / 6);
    assert.equal(personal.calculationScores[0].fallbackFor, 1);
    const [shared] = score(models, weights, { fallbackScope: 'public', familyComposition: [
        { primaryConditionID: 1, families: [{ ...rule, weightBasisPoints: 6000 },
            { primaryConditionID: 1, familyID: null, entries: [], weightBasisPoints: 4000 }] },
        { primaryConditionID: 2, families: [{ primaryConditionID: 2, familyID: null, entries: [], weightBasisPoints: 10000 }] }
    ] });
    assert.equal(shared.coverage, 30);
    close(shared.availableInference.coverageFactor, 15 / 22);
    close(shared.availableInference.inferredFraction, .7);
    assert.equal(shared.inferredScores.length, 2);
});

test('fully covered totals and Score range remain unchanged; no weighted evidence stays incomparable', () => {
    const models = [model(1, { 1: -20, 2: -40 }), model(2, { 1: 80, 2: 100 })];
    assert.deepEqual(score(models).map(row => row.lower), [-30, 90]);
    assert.ok(score(models).every(row => row.availableInference.appliedFactor === 1));
    assert.deepEqual(score(models, weights, { scoreMode: 'range' }).map(row => row.lower), [-30, 90]);
    const [missing] = score([model(1, { 3: 100 }), model(2, { 1: 80, 2: 90, 3: 80 })]);
    assert.equal(missing.comparable, false);
    assert.equal(missing.lower, null);
    assert.equal(missing.availableInference, null);
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

test('new default ranks supported models above high but sparse results and never rewards sparse negative scores', () => {
    const entries = [{ conditionID: 1, weightBasisPoints: 1000 }, { conditionID: 2, weightBasisPoints: 9000 }];
    const models = [model(1, { 1: 88 }), model(2, { 1: 80, 2: 80 })];
    assert.deepEqual(rankModels(score(models, entries)).map(row => row.modelID), [2, 1]);
    const negatives = score([model(1, { 1: -20 }), model(2, { 1: -20, 2: -20 })], entries);
    assert.deepEqual(rankModels(negatives).map(row => row.modelID), [2, 1]);
});

test('all legacy read versions and matched comparisons calculate only rational totals', () => {
    const models = [model(1, { 1: 80 }), model(2, { 1: 60 })];
    for (const mode of ['best', 'matched']) {
        for (const version of [1, 2, 3, 4, 5, 6, 7]) {
            const rows = score(models, weights, { availableInferenceVersion: version }, mode);
            assert.deepEqual(rows.map(row => row.lower), [66.67, 50]);
            assert.ok(rows.every(row => row.availableInference.method === PAIRWISE_RATIONAL_COVERAGE_FACTOR_METHOD));
        }
    }
    assert.equal(AVAILABLE_INFERENCE_VERSION, 7);
    assert.equal(rankingReadBody('/api/get_weighted_workspace', {}).availableInferenceVersion, 7);
    for (const version of [1, 2, 3, 4, 5, 6]) assert.equal(rankingReadBody('/api/get_weighted_workspace', { availableInferenceVersion: version }).availableInferenceVersion, 7);
});

test('rounding preserves finite extreme totals instead of overflowing them while forming a ranking', () => {
    const [row] = score([model(1, { 1: -1e308 })]);
    assert.ok(Number.isFinite(row.lower));
    close(row.lower, -1e308 * (2 - 5 / 6));
    assert.equal(JSON.parse(JSON.stringify(row)).lower, row.lower);
});

test('validation checks factors, raw contribution trace and adjusted total for either score sign', () => {
    for (const value of [80, -20]) {
        const payload = workspace(createFixtureState({ comparisonModels: [model(1, { 1: value }), model(2, { 1: 60, 2: 70 })],
            personalEntries: weightedEntries(weights), publicWeights: weights }), { scoreMode: 'available', initialMode: 'personal' });
        assert.equal(validateWorkspacePayload(payload), payload);
        for (const mutation of [row => { row.availableInference.coverageFactor = 1; },
            row => { row.availableInference.appliedFactor = 1; }, row => { delete row.availableInference.coverageFactor; },
            row => { row.availableInference.unpenalizedScore++; }, row => { row.availableInference.totalScore++; },
            row => { row.calculationScores[0].contribution++; }]) {
            const changed = structuredClone(payload);
            mutation(changed.modelLeaderboards.personal.find(row => row.missingWeight > 0));
            assert.throws(() => validateWorkspacePayload(changed), /Invalid workspace response/);
        }
    }
});
