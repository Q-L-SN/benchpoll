import test from 'node:test';
import assert from 'node:assert/strict';
import { availableResultInference, storedAvailableResultInference } from '../public/js/shared/available-score.js';
import { ESTIMATION_ALGORITHMS, normalizeEstimationAlgorithm } from '../public/js/shared/estimation-algorithms.js';
import { readEstimationPreference, writeEstimationPreference } from '../public/js/workspace/preferences.js';
import { scoreModels, scoreComparison, getRankingWorkspace } from '../ranking-service.js';
import { comparisonOptions } from '../model-comparison.js';
import { createFixtureState, workspace } from '../scripts/frontend/fixtures.mjs';
import { createRankingPager } from '../ranking-pagination.js';
import { validateWorkspacePayload, validateRankingPagePayload } from '../public/js/workspace/contracts.js';

const choices = ESTIMATION_ALGORITHMS.map(item => item.ID), alternatives = choices.slice(1);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const model = (ID, values) => ({ ID, modelID: ID, name: `Model ${ID}`, modelName: `Model ${ID}`,
    condition: { parameters: {}, scoreFields: [] },
    results: new Map(Object.entries(values).map(([key, normalizedScore]) => [key, { normalizedScore }])) });
const entries = [{ conditionID: 1, weightBasisPoints: 5000 }, { conditionID: 2, weightBasisPoints: 5000 }];

test('experimental corrections keep measured contributions fixed and midpoint shrinkage can raise or lower estimates', () => {
    for (const prediction of [40, 90]) {
        const totals = {};
        for (const algorithm of choices) {
            const trace = availableResultInference(80, .5, [{ normalizedScore: prediction, weightFraction: .5 }], null, 3, algorithm);
            totals[algorithm] = trace.totalScore;
            close(trace.observedContribution, 40);
            assert.deepEqual(storedAvailableResultInference(80, .5, [{ normalizedScore: prediction, weightFraction: .5 }], null, 3,
                { method: trace.method }), trace);
        }
        close(totals.current, (40 + prediction / 2) * 5 / 6);
        close(totals['missing-raw'], 40 + prediction / 2);
        close(totals['missing-rational'], 40 + prediction / 2 * 5 / 6);
        close(totals['missing-linear'], 40 + prediction / 4);
        close(totals['missing-sqrt'], 40 + prediction / 2 * Math.sqrt(.5));
        close(totals['missing-midpoint'], 40 + prediction / 4 + 12.5);
        assert.equal(totals['missing-midpoint'] > totals['missing-raw'], prediction < 50);
    }
});

test('all missing-only choices stay inside Score range, including negative measurements and unresolved weight', () => {
    for (const algorithm of alternatives) for (const observed of [-200, -1, 0, 70, 150]) {
        for (const coverage of [.00001, .1, .5, .99, 1]) for (const prediction of [0, 50, 100]) {
            const fraction = (1 - coverage) / 2;
            const trace = availableResultInference(observed, coverage,
                fraction ? [{ normalizedScore: prediction, weightFraction: fraction }] : [], null, 2, algorithm);
            close(trace.observedContribution, observed * coverage);
            close(trace.unresolvedContribution, fraction * 50);
            assert.ok(trace.totalScore >= observed * coverage - 1e-9);
            assert.ok(trace.totalScore <= observed * coverage + (1 - coverage) * 100 + 1e-9);
        }
    }
});

test('square-root attenuation multiplies only the missing contribution by the square root of measured coverage', () => {
    const trace = availableResultInference(80, .5, [{ normalizedScore: 60, weightFraction: .5 }], null, 3, 'missing-sqrt');
    close(trace.observedContribution, 40);
    close(trace.missingFactor, Math.sqrt(.5));
    close(trace.totalScore, 40 + 30 * Math.sqrt(.5));
    assert.notEqual(trace.totalScore, 70 * Math.sqrt(.5));
});

test('measured fallback contributions keep their original weights; only predicted scores are bounded', () => {
    const models = [model(1, { 3: -20 })];
    const reference = { estimate: () => ({ percentile: null, sourceCount: 2 }),
        predict: () => ({ normalizedScore: 180, percentile: .8, sourceCount: 2, referenceCount: 3 }) };
    const rules = { fallbackRules: [{ primaryConditionID: 1, mode: 'ordered', entries: [{ conditionID: 3 }] }], percentileReference: reference };
    for (const estimationAlgorithm of alternatives) {
        const [score] = scoreModels(models, entries, 10000, { ...rules, estimationAlgorithm, scoreMode: 'available' });
        assert.equal(score.coverage, 50); assert.equal(score.fallbackCoverage, 50);
        assert.equal(score.calculationScores[0].contribution, -10);
        assert.equal(score.calculationScores[0].effectiveWeight, 50);
        assert.equal(score.inferredScores[0].normalizedScore, 100);
        assert.equal(score.inferredScores[0].rawNormalizedScore, 180);
        assert.ok(score.lower >= -10 && score.lower <= 40);
    }
});

test('full coverage, zero observed scores, range mode and evidence eligibility do not change with the selector', () => {
    const models = [model(1, { 1: 80, 2: 100 }), model(2, { 1: 0, 2: 0 }), model(3, { 3: 100 })];
    const baseline = scoreModels(models, entries, 10000, { scoreMode: 'range' });
    for (const estimationAlgorithm of choices) {
        assert.deepEqual(scoreModels(models, entries, 10000, { scoreMode: 'range', estimationAlgorithm }), baseline);
        const scores = scoreComparison(models, entries, 10000, { scoreMode: 'available', estimationAlgorithm },
            comparisonOptions(models, { mode: 'best', keys: ['model'] }));
        assert.deepEqual(scores.map(row => row.lower), [90, 0, null]);
        assert.equal(scores[2].comparable, false);
    }
});

test('matched comparisons honor the selected method and do not fall back to the default', () => {
    const models = [model(1, { 1: 80 }), model(2, { 1: 60 })];
    for (const estimationAlgorithm of alternatives) {
        const scores = scoreComparison(models, entries, 10000, { scoreMode: 'available', estimationAlgorithm },
            comparisonOptions(models, { mode: 'matched', keys: ['model'] }));
        assert.ok(scores.every(row => row.availableInference.algorithm === estimationAlgorithm));
        assert.deepEqual(scores.map(row => row.availableInference.observedContribution), [40, 30]);
    }
});

test('every method provides auditable traces through initial and subsequent ranking pages', () => {
    const state = createFixtureState({ rankingStress: true });
    for (const estimationAlgorithm of choices) {
        const raw = workspace(state, { categoryID: 1, scoreMode: 'available', estimationAlgorithm }, { paginate: false });
        const pager = createRankingPager(), first = pager.create(raw, { userID: state.userID, initialMode: 'public' });
        validateWorkspacePayload(first);
        const second = pager.getPage({ snapshotID: first.rankingPagination.snapshotID, userID: state.userID,
            list: 'public', offset: first.rankingPagination.public.nextOffset });
        validateRankingPagePayload(second, { list: 'public', scoreMode: 'available', offset: first.rankingPagination.public.nextOffset });
        assert.ok(second.items.length > 0);
        if (estimationAlgorithm !== 'current') {
            const corrupt = structuredClone(first);
            corrupt.modelLeaderboards.public[0].availableInference.observedContribution++;
            assert.throws(() => validateWorkspacePayload(corrupt), /missing-score estimate/);
        }
    }
});

test('invalid choices fail before database access and unavailable storage safely uses the current algorithm', async () => {
    for (const estimationAlgorithm of [null, '', 'mean-percentile', 'typo', {}, 1]) {
        assert.throws(() => normalizeEstimationAlgorithm(estimationAlgorithm));
        await assert.rejects(getRankingWorkspace({ getConnection() { throw new Error('Database must not be read'); } }, { estimationAlgorithm }),
            error => error.status === 400 && error.body.error === 'invalid_estimation_algorithm');
    }
    const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
    assert.equal(readEstimationPreference(storage), 'current');
    assert.equal(writeEstimationPreference('missing-midpoint', storage), true);
    assert.equal(readEstimationPreference(storage), 'missing-midpoint');
    assert.equal(readEstimationPreference({ getItem() { throw new Error('Storage denied'); } }), 'current');
    assert.equal(writeEstimationPreference('missing-raw', { setItem() { throw new Error('Storage denied'); } }), false);
});
