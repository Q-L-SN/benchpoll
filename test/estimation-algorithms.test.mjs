import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrationModel as model, pairedModels } from './helpers/fallback-pairs.mjs';
import { availableResultInference, storedAvailableResultInference } from '../public/js/shared/available-score.js';
import { ESTIMATION_ALGORITHMS, normalizeEstimationAlgorithm } from '../public/js/shared/estimation-algorithms.js';
import { TREEMAP_ESTIMATION_METHOD } from '../public/js/shared/fallback-inference.js';
import { readEstimationPreference, writeEstimationPreference } from '../public/js/workspace/preferences.js';
import { scoreModels, scoreComparison, getRankingWorkspace } from '../ranking-service.js';
import { comparisonOptions, groupComparisonModels } from '../model-comparison.js';
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

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('a joint fit uses partially observed reference rows and retains the target weight', () => {
    const subject = model(1, { 2: 80, 3: 70, 4: 90, 9: -20 });
    // These two sets of peers overlap on the target but never measured both sources.
    const peersB = [76, 78, 79, 81, 82, 84].map((value, i) => model(10 + i, { 1: value - 15, 2: value }));
    const peersC = [3, 5, 5, 5, 8].map((offset, i) => model(20 + i, { 1: 68 + i + offset, 3: 68 + i }));
    const joint = 69.30700591100324; // Independent NumPy reference, seven EM steps.
    for (const IDs of [[2, 4, 3], [3, 2, 4]]) {
        const [row] = compare([subject, ...peersB, ...peersC], [weight(1, 4000, IDs), weight(9, 4000), weight(12, 2000)]);
        assert.equal(row.inferredScores.length, 2);
        const [estimate, treemap] = row.inferredScores;
        assert.deepEqual([row.lower, row.coverage, row.fallbackCoverage], [24.65, 40, 40]);
        assert.equal(estimate.selection, 'automatic');
        assert.equal(estimate.estimationMethod, 'joint-versions');
        assert.deepEqual(estimate.sources, [
            { sourceConditionID: 2, sourceScore: 80, referenceCount: 6 },
            { sourceConditionID: 3, sourceScore: 70, referenceCount: 5 }
        ]);
        close(estimate.normalizedScore, joint);
        assert.equal(estimate.originalWeight, 40);
        assert.equal(estimate.effectiveWeight, 40);
        close(estimate.contribution, joint * .4);
        assert.equal(row.calculationScores[0].contribution, -8);
        assert.deepEqual([treemap.conditionID, treemap.estimationMethod, treemap.originalWeight], [12, TREEMAP_ESTIMATION_METHOD, 20]);
        close(treemap.normalizedScore, (joint - 20) / 2);
        assert.equal(row.availableInference.unresolvedFraction, 0);
        assert.equal(row.availableInference.unresolvedContribution, 0);
    }
});

test('multiple measured versions enter one conditional prediction on the target scale', () => {
    const subject = model(1, { 2: 30, 3: 8 });
    const peers = [[29, 10, 2], [49, 30, 2], [11, 10, 8], [31, 30, 8]]
        .map(([a, b, c], i) => model(10 + i, { 1: a, 2: b, 3: c }));
    const predict = ids => compare([subject, ...peers], [weight(1, 10000, ids)])[0].inferredScores[0].normalizedScore;
    close(predict([2]), 39.80376623789036);
    close(predict([3]), 27.210506061909342);
    close(predict([2, 3]), 35.689694477030926);
});

test('small samples and out-of-range inputs use the same smooth point estimator', () => {
    const subject = model(1, { 2: 5.5 });
    for (const [count, expected] of [[1, 5.226949122423698], [4, 7.831230672599654], [5, 8.129347457120016]]) {
        const peers = Array.from({ length: count }, (_, i) => model(10 + i, { 1: i + 3, 2: i }));
        const [row] = compare([subject, ...peers], [weight(1, 10000, [2])]);
        close(row.inferredScores[0].normalizedScore, expected);
        assert.equal(row.inferredScores[0].sources[0].referenceCount, count);
    }
});

test('all sixteen recorded eligible versions affect a fit with incomplete reference rows', () => {
    const ids = Array.from({ length: 16 }, (_, j) => j + 2);
    const subject = model(1, Object.fromEntries(ids.map((id, j) => [id, 57 + 2 * j])));
    const peers = Array.from({ length: 20 }, (_, m) => model(10 + m, {
        1: 40 + 2 * m, ...Object.fromEntries(ids.flatMap((id, j) =>
            (m + j) % 6 ? [[id, 50 + j + (m % 5) * (j + 1) + m / 3]] : []))
    }));
    const [full] = compare([subject, ...peers], [weight(1, 10000, ids)]);
    assert.equal(full.inferredScores[0].sources.length, 16);
    close(full.inferredScores[0].normalizedScore, 74.81356814769251);
    const [reduced] = compare([subject, ...peers], [weight(1, 10000, ids.slice(0, -1))]);
    close(reduced.inferredScores[0].normalizedScore, 74.77667524642226);
});

test('estimated target points stay signed and may exceed 100', () => {
    for (const points of [-40, 0, 140]) {
        const models = [model(1, { 2: 10 }), model(2, { 1: points, 2: 10 })];
        const [row] = compare(models, [weight(1, 10000, [2])]);
        assert.equal(row.inferredScores[0].normalizedScore, points);
        assert.equal(row.lower, points);
        assert.equal(row.coverage, 0);
        assert.equal(row.comparable, true);
    }
});

test('best performance fits each measured run before choosing a target estimate', () => {
    const x = { harness: 'X' }, y = { harness: 'Y' };
    const subjects = [model(1, { 2: 30, 3: 8 }, x), model(2, { 2: 50 }, y, { modelID: 1 })];
    const peers = [[29, 10, 2], [49, 30, 2], [11, 10, 8], [31, 30, 8]].map(([a, b, c], i) =>
        model(10 + i, { 1: a, 2: b, 3: c }, x));
    peers.push(model(99, { 1: 20, 2: 50 }, y));
    const [best] = compare([...subjects, ...peers], [weight(1, 10000, [2, 3])]);
    close(best.inferredScores[0].normalizedScore, 35.689694477030926);
    assert.deepEqual(best.inferredScores[0].sources.map(s => s.sourceScore), [30, 8]);
});

test('a projection without its raw measurements supplies no reference evidence', () => {
    const entries = [weight(1, 10000, [2])];
    const raw = [model(1, { 2: 75 }), ...pairedModels(1, 2, 75, -10)];
    for (const mode of ['best', 'matched']) {
        const groups = groupComparisonModels(raw, comparisonOptions(raw, { mode, keys: ['model'] }), entries, { includeReferenceVersions: true });
        const [row] = scoreModels(groups, entries, 10000, { scoreMode: 'available' });
        assert.deepEqual(row.inferredScores, []);
        assert.equal(row.availableInference.unresolvedFraction, 1);
    }
});

test('each contribution to a repeated version keeps the eligible sources of its scene', () => {
    const models = [model(1, { 2: 70, 9: 80 }), ...pairedModels(1, 2, 70, -10)];
    const entries = [weight(1, 2500, [2]), weight(1, 2500), weight(9, 2000), weight(9, 1000), weight(-3, 2000)];
    const [row] = compare(models, entries);
    assert.deepEqual([row.lower, row.coverage, row.fallbackCoverage], [70.91, 30, 25]);
    assert.equal(row.availableInference.unresolvedFraction, 0);
    assert.deepEqual(row.coverageEntries.map(item => [item.conditionID, item.weightBasisPoints, item.coveredWeightBasisPoints]),
        [[1, 5000, 0], [9, 3000, 3000], [-3, 2000, 0]]);
    assert.deepEqual(row.calculationScores.map(item => [item.conditionID, item.effectiveWeight, item.contribution]), [[9, 30, 24]]);
    assert.deepEqual(row.inferredScores.map(item => [item.conditionID, item.sources?.[0].sourceConditionID, item.effectiveWeight]),
        [[1, 2, 25], [1, undefined, 25], [-3, undefined, 20]]);
    close(row.inferredScores[0].contribution, 15);
    for (const estimate of row.inferredScores.slice(1)) {
        assert.equal(estimate.estimationMethod, TREEMAP_ESTIMATION_METHOD);
        close(estimate.normalizedScore, 39 / .55);
    }
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
    assert.deepEqual(estimated.inferredScores.map(row => [row.conditionID, row.estimationMethod]), [[2, 'joint-versions'], [1, TREEMAP_ESTIMATION_METHOD]]);
    assert.deepEqual([estimated.lower, estimated.coverage, estimated.availableInference.unresolvedFraction], [75, 0, 0]);
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
    assert.deepEqual([row.lower, row.coverage, estimate.sources[0].sourceScore, estimate.sources[0].referenceCount], [57.5, 0, 55, 5]);
});

test('ranking pages validate original contributions, estimates and fully unresolved rows', () => {
    const models = [model(1, { 901: 70 }), model(2, { 3: 90 }), ...pairedModels(1, 901, 70, -10)];
    const weights = [weight(1, 8000), weight(2, 2000)];
    const state = createFixtureState({ estimationSources: true, secondaryBenchmark: true, comparisonModels: models,
        personalEntries: weightedEntries(weights), publicWeights: weights });
    const raw = workspace(state, { categoryID: 1, scoreMode: 'available' }, { paginate: false });
    const pager = createRankingPager(), first = pager.create(raw, { userID: state.userID, initialMode: 'public' });
    validateWorkspacePayload(first);
    const rows = first.modelLeaderboards.public;
    assert.equal(rows.find(row => row.ID === 1).inferredScores[0].sources[0].sourceConditionID, 901);
    assert.deepEqual(rows.find(row => row.ID === 1).inferredScores.slice(1).map(score => [score.conditionID, score.estimationMethod]),
        [[2, TREEMAP_ESTIMATION_METHOD]]);
    const unresolved = rows.find(row => row.ID === 2);
    assert.deepEqual([unresolved.rank, unresolved.lower, unresolved.availableInference.totalScore], [null, null, 0]);
    const corrupt = structuredClone(first);
    corrupt.modelLeaderboards.public.find(row => row.ID === 2).availableInference.unresolvedContribution = 50;
    assert.throws(() => validateWorkspacePayload(corrupt), /missing-score estimate/);
    for (const mutate of [score => { score.sources = []; }, score => { score.sources[0].weightFraction = .5; },
        score => { score.sources[0].sourceConditionID = score.conditionID; }, score => { score.sources[0].referenceCount = 0; },
        score => { score.sources[0].validationError = 6; }, score => { score.sources[0].sourceScore = null; },
        score => { score.estimationMethod = 'other'; }, score => { score.normalizedScore += 1; }, score => { score.sources.push({ ...score.sources[0] }); },
        score => {
            score.sources[0].weightFraction = .6;
            score.sources.push({ ...score.sources[0], sourceConditionID: 902, weightFraction: .4 });
        }]) {
        const broken = structuredClone(first);
        mutate(broken.modelLeaderboards.public.find(row => row.ID === 1).inferredScores[0]);
        assert.throws(() => validateWorkspacePayload(broken), /inferredScores/);
    }
    const wrongTreemap = structuredClone(first);
    const invalid = wrongTreemap.modelLeaderboards.public.find(row => row.ID === 1);
    const treemapEstimate = invalid.inferredScores[1];
    treemapEstimate.normalizedScore += 10;
    treemapEstimate.contribution += 2;
    for (const key of ['inferredContribution', 'unpenalizedScore', 'totalScore']) invalid.availableInference[key] += 2;
    invalid.lower += 2;
    invalid.upper += 2;
    assert.throws(() => validateWorkspacePayload(wrongTreemap), /weighted treemap evidence/);

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
