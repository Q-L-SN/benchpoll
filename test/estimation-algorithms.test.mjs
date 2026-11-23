import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrationModel as model, pairedModels } from './helpers/fallback-pairs.mjs';
import { availableResultInference, storedAvailableResultInference } from '../public/js/shared/available-score.js';
import { ESTIMATION_ALGORITHMS, normalizeEstimationAlgorithm } from '../public/js/shared/estimation-algorithms.js';
import { readEstimationPreference, writeEstimationPreference } from '../public/js/workspace/preferences.js';
import { scoreModels, scoreComparison, getRankingWorkspace } from '../ranking-service.js';
import { comparisonOptions } from '../model-comparison.js';
import { createFixtureState, weightedEntries, workspace } from '../scripts/frontend/fixtures.mjs';
import { createRankingPager } from '../ranking-pagination.js';
import { validateWorkspacePayload, validateRankingPagePayload } from '../public/js/workspace/contracts.js';

const weight = (conditionID, weightBasisPoints, estimationSourceIDs = []) => ({ conditionID, weightBasisPoints, estimationSourceIDs });
const compare = (models, entries, scoreMode = 'available', mode = 'best', rules = {}) => scoreComparison(
    models, entries, 10000, { scoreMode, ...rules }, comparisonOptions(models, { mode, keys: ['model'] }));

test('paired-test estimates and measured points retain their original weights', () => {
    const estimates = [{ normalizedScore: 70, weightFraction: .25 }];
    const partial = availableResultInference(80, .3, estimates, null, 5);
    assert.equal(partial.observedContribution, 24);
    assert.equal(partial.inferredContribution, 17.5);
    assert.ok(Math.abs(partial.unresolvedFraction - .45) < 1e-12);
    assert.equal(partial.unresolvedContribution, 0);
    assert.equal(partial.totalScore, 41.5);
    const inferredOnly = availableResultInference(0, 0, estimates, null, 5);
    assert.equal(inferredOnly.totalScore, 17.5);
    assert.equal(inferredOnly.coverageFraction, 0);
    const empty = availableResultInference(0, 0, []);
    assert.equal(empty.totalScore, 0);
    assert.equal(empty.unresolvedFraction, 1);
    assert.equal(empty.sourceCount, 0);
    assert.deepEqual(storedAvailableResultInference(80, .3, estimates, null, 5, { method: partial.method }), partial);
});

test('automatic estimates choose the lowest held-out error, then paired count, then stable version ID', () => {
    const subject = model(1, { 2: 70, 3: 80, 4: 90, 5: 30, 9: -20, 999: 95 });
    const peers = Array.from({ length: 7 }, (_, index) => {
        const primary = 57 + index;
        return model(101 + index, { 1: primary, ...(index < 5 ? { 2: primary + 10 } : {}),
            3: primary + 20, 4: primary + 30 + index % 2, 5: primary - 30, 999: primary + 35 });
    });
    const entriesFor = IDs => [weight(1, 4000, IDs), weight(9, 4000), weight(12, 2000)];
    for (const IDs of [[4, 5, 2, 3], [3, 2, 5, 4]]) {
        const [row] = compare([subject, ...peers], entriesFor(IDs));
        const [estimate] = row.inferredScores;
        assert.deepEqual([row.lower, row.coverage, row.fallbackCoverage], [16, 40, 40]);
        assert.deepEqual([estimate.sourceConditionID, estimate.sourceScore, estimate.referenceCount, estimate.validationError], [3, 80, 7, 0]);
        assert.equal(estimate.selection, 'automatic');
        assert.deepEqual(estimate.familyConditionIDs, [1, 3]);
        assert.equal(estimate.originalWeight, 40);
        assert.equal(estimate.effectiveWeight, 40);
        assert.equal(estimate.contribution, 24);
        assert.equal(row.calculationScores[0].contribution, -8);
    }
    const [row] = compare([subject, ...peers], entriesFor([4, 2]));
    assert.equal(row.inferredScores[0].sourceConditionID, 2);
    assert.equal(row.inferredScores[0].referenceCount, 5);
});

test('each contribution to a repeated version keeps the eligible sources of its scene', () => {
    const models = [model(1, { 2: 70, 9: 80 }), ...pairedModels(1, 2, 70, -10)];
    const entries = [weight(1, 2500, [2]), weight(1, 2500), weight(9, 2000), weight(9, 1000), weight(-3, 2000)];
    const [row] = compare(models, entries);
    assert.deepEqual([row.lower, row.coverage, row.fallbackCoverage], [39, 30, 25]);
    assert.ok(Math.abs(row.availableInference.unresolvedFraction - .45) < 1e-12);
    assert.deepEqual(row.coverageEntries.map(item => [item.conditionID, item.weightBasisPoints, item.coveredWeightBasisPoints]),
        [[1, 5000, 0], [9, 3000, 3000], [-3, 2000, 0]]);
    assert.deepEqual(row.calculationScores.map(item => [item.conditionID, item.effectiveWeight, item.contribution]), [[9, 30, 24]]);
    assert.deepEqual(row.inferredScores.map(item => [item.sourceConditionID, item.effectiveWeight, item.contribution]), [[2, 25, 15]]);
    const [range] = compare(models, entries, 'range');
    assert.deepEqual([range.lower, range.upper, range.coverage], [24, 94, 30]);
    assert.deepEqual(range.inferredScores, []);
    assert.equal(range.availableInference, null);
});

test('an estimate only uses a recorded source, and a direct measured zero takes precedence', () => {
    const subject = model(1, { 3: 85, 999: 95 });
    const peers = pairedModels(1, 2, 75, -10);
    for (const peer of peers) peer.results.set('3', { normalizedScore: peer.results.get('2').normalizedScore + 10 });
    const entry = [weight(1, 5000, [2]), weight(2, 5000, [3])];
    const rules = { fallbackRules: [{ primaryConditionID: 1, mode: 'ordered', entries: [{ conditionID: 3 }] }] };
    const [estimated] = compare([subject, ...peers], entry, 'available', 'best', rules);
    assert.deepEqual(estimated.inferredScores.map(row => row.conditionID), [2]);
    assert.deepEqual([estimated.lower, estimated.coverage, estimated.availableInference.unresolvedFraction], [37.5, 0, .5]);
    subject.results.set('1', { normalizedScore: 0 });
    const [recorded] = compare([subject, ...peers], entry, 'available', 'best', rules);
    assert.deepEqual([recorded.lower, recorded.coverage, recorded.calculationScores[0].normalizedScore], [37.5, 50, 0]);
});

test('matched comparisons use measured siblings under the same matching controls', () => {
    const models = [model(1, { 2: 70 }, { harness: 'A' }), model(2, { 2: 90 }, { harness: 'B' }),
        ...pairedModels(1, 2, 70, -10, { harness: 'A' })];
    const entries = [weight(1, 10000, [2])];
    const [estimated, unmatched] = compare(models, entries, 'available', 'matched');
    assert.deepEqual([estimated.lower, estimated.comparable, estimated.coverage], [60, true, 0]);
    assert.deepEqual([unmatched.lower, unmatched.comparable, unmatched.availableInference.totalScore], [null, false, 0]);
    assert.equal(unmatched.availableInference.unresolvedFraction, 1);
    assert.equal(unmatched.resultCount, 0);
    assert.deepEqual(unmatched.inferredScores, []);
    const [range] = compare(models, entries, 'range', 'matched');
    assert.deepEqual([range.lower, range.comparable, range.availableInference], [null, false, null]);
});

test('matched scores calibrate measured runs before averaging their estimates', () => {
    const settingsA = { harness: 'A' }, settingsB = { harness: 'B' };
    const models = [model(1, { 2: 30 }, settingsA), model(2, { 2: 80 }, settingsB, { modelID: 1 }),
        ...pairedModels(1, 2, 30, -5, settingsA),
        ...pairedModels(1, 2, 80, 10, settingsB).map(peer => ({ ...peer, ID: peer.ID + 100 }))];
    const [row] = compare(models, [weight(1, 10000, [2])], 'available', 'matched');
    const [estimate] = row.inferredScores;
    assert.deepEqual([row.lower, row.coverage, estimate.sourceScore, estimate.referenceCount], [57.5, 0, 55, 5]);
});

test('ranking pages validate original contributions, estimates and fully unresolved rows', () => {
    const models = [model(1, { 901: 70 }), model(2, { 3: 90 }), ...pairedModels(1, 901, 70, -10)];
    const weights = [weight(1, 10000)];
    const state = createFixtureState({ estimationSources: true, secondaryBenchmark: true, comparisonModels: models,
        personalEntries: weightedEntries(weights), publicWeights: weights });
    const raw = workspace(state, { categoryID: 1, scoreMode: 'available' }, { paginate: false });
    const pager = createRankingPager(), first = pager.create(raw, { userID: state.userID, initialMode: 'public' });
    validateWorkspacePayload(first);
    const rows = first.modelLeaderboards.public;
    assert.equal(rows.find(row => row.ID === 1).inferredScores[0].sourceConditionID, 901);
    const unresolved = rows.find(row => row.ID === 2);
    assert.deepEqual([unresolved.rank, unresolved.lower, unresolved.availableInference.totalScore], [null, null, 0]);
    const corrupt = structuredClone(first);
    corrupt.modelLeaderboards.public.find(row => row.ID === 2).availableInference.unresolvedContribution = 50;
    assert.throws(() => validateWorkspacePayload(corrupt), /missing-score estimate/);

    const stress = workspace(createFixtureState({ rankingStress: true }), { categoryID: 1, scoreMode: 'available' }, { paginate: false });
    const initial = pager.create(stress, { userID: state.userID, initialMode: 'public' });
    const offset = initial.rankingPagination.public.nextOffset;
    const page = pager.getPage({ snapshotID: initial.rankingPagination.snapshotID, userID: state.userID, list: 'public', offset });
    validateRankingPagePayload(page, { list: 'public', scoreMode: 'available', offset });
    assert.ok(page.items.length > 0);
});

test('exactly one live method is available and retired requests fail before database access', async () => {
    assert.deepEqual(ESTIMATION_ALGORITHMS.map(item => [item.ID, item.label]), [['current', 'Version-based estimation']]);
    const rejected = ['missing-raw', 'missing-rational', 'missing-linear', 'missing-sqrt', 'missing-midpoint', null, '', 'mean-percentile', {}, 1];
    for (const estimationAlgorithm of rejected) {
        assert.throws(() => normalizeEstimationAlgorithm(estimationAlgorithm));
        await assert.rejects(getRankingWorkspace({ getConnection() { throw new Error('Database must not be read'); } }, { estimationAlgorithm }),
            error => error.status === 400 && error.body.error === 'invalid_estimation_algorithm');
    }
    assert.throws(() => scoreModels([], [weight(1, 10000)], 10000, { estimationAlgorithm: 'missing-midpoint' }),
        error => error.status === 400 && error.body.error === 'invalid_estimation_algorithm');
    assert.equal(readEstimationPreference({ getItem: () => 'missing-midpoint' }), 'current');
    const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
    assert.equal(writeEstimationPreference('current', storage), true);
    assert.equal(readEstimationPreference(storage), 'current');
});
