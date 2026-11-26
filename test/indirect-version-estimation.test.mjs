import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreComparison, scoreModels } from '../ranking-service.js';
import { comparisonOptions } from '../model-comparison.js';
import { createVersionEstimationPlanner } from '../public/js/shared/version-estimation-policy.js';
import { expandTopicReferences, publicReferenceWeights } from '../topic-reference-service.js';
import { calibrationModel as model } from './helpers/fallback-pairs.mjs';
import { createFixtureState, secondaryBenchmark, workspace } from '../scripts/frontend/fixtures.mjs';
import { createRankingPager } from '../ranking-pagination.js';
import { validateRankingPagePayload, validateWorkspacePayload } from '../public/js/workspace/contracts.js';

const allocation = (conditionID, weightBasisPoints = 10000) => ({ conditionID, weightBasisPoints });
const catalogue = [
    ...[10, 20, 30, 40, 50].map(conditionID => ({ conditionID, benchmarkID: 1 })),
    { conditionID: 60, benchmarkID: 2 }, { conditionID: 70, benchmarkID: 1, excludedFromRanking: true }
];
const plan = createVersionEstimationPlanner(catalogue);
const weights = (publicVotes = [], ownVotes = []) => plan([allocation(10)], publicVotes, ownVotes);
const options = { scoreMode: 'available' };
const subject = model(1, { 50: 70 });
const peers = [model(2, { 50: 70, 40: 80 }), model(3, { 40: 80, 30: 60 }),
    model(4, { 30: 60, 20: 90 }), model(5, { 20: 90, 10: 100 })];
const path = (...pairs) => pairs.map(([targetConditionID, referenceCount]) => ({ targetConditionID, referenceCount }));
const rowFor = (runs, entries = weights(), rules = {}) => scoreComparison(runs, entries, 10000,
    { ...options, ...rules }, comparisonOptions(runs, { mode: 'best', keys: ['model'], filters: [{ key: 'model', operator: 'eq', value: 1 }] }))[0];

test('one through four distinct same-setting peers can calibrate a direct source', () => {
    for (const count of [1, 2, 3, 4]) {
        const refs = Array.from({ length: count }, (_, i) => model(i + 2, { 10: 42, 50: 70 }));
        const row = rowFor([subject, ...refs]);
        assert.equal(row.lower, 42);
        assert.deepEqual(row.inferredScores[0].sources, [{ sourceConditionID: 50, sourceScore: 70, referenceCount: count }]);
    }
});

test('a measured source traverses four independent scale conversions at its original weight', () => {
    const entries = weights().map(entry => ({ ...entry, weightBasisPoints: 2500 }));
    entries.push({ ...allocation(99, 7500), estimationSourceIDs: [] });
    const row = rowFor([model(1, { 50: 70, 99: 20 }), ...peers], entries);
    assert.deepEqual([row.lower, row.coverage, row.resultCount, row.fallbackCoverage], [40, 75, 2, 25]);
    const [score] = row.inferredScores;
    assert.deepEqual([score.normalizedScore, score.originalWeight, score.contribution], [100, 25, 25]);
    assert.deepEqual(score.sources, [{ sourceConditionID: 50, sourceScore: 70, referenceCount: 1,
        calibrationPaths: [path([40, 1], [30, 1], [20, 1], [10, 1])] }]);
    assert.deepEqual(row.calculationScores.map(s => s.conditionID), [99]);
    const zero = rowFor([subject, ...peers.slice(0, -1), model(5, { 20: 90, 10: 0 })]);
    assert.deepEqual([zero.lower, zero.comparable, zero.inferredScores[0].normalizedScore, zero.coverage], [0, true, 0, 0]);
    const measured = rowFor([model(1, { 10: 0, 50: 70 }), ...peers]);
    assert.deepEqual([measured.lower, measured.coverage, measured.inferredScores], [0, 100, []]);
    const direct = rowFor([subject, ...peers, model(6, { 50: 70, 10: -5 })]);
    assert.equal(direct.lower, -5);
    assert.equal(direct.inferredScores[0].sources[0].calibrationPaths, undefined);
    const range = rowFor([subject, ...peers], entries, { scoreMode: 'range' });
    assert.deepEqual(range.inferredScores, []);
});

test('an unordered hop vote governs direct and topic-reference scoring in either endpoint order', async () => {
    const oppose = (targetConditionID, sourceConditionID) => ({ targetConditionID, sourceConditionID, opposeCount: 1, supportCount: 0 });
    const veto = oppose(30, 40);
    for (const votes of [[veto], [oppose(40, 30)], [oppose(10, 40)], [oppose(10, 50)]]) {
        const row = rowFor([subject, ...peers], weights(votes));
        assert.deepEqual([row.lower, row.inferredScores, row.availableInference.unresolvedFraction], [null, [], 1]);
    }
    const onlyReversed = [{ targetConditionID: 40, sourceConditionID: 30, vote: 'support' }];
    for (const [personalVotes, score] of [[[], null], [onlyReversed, 100]]) {
        const planned = weights([veto], personalVotes);
        assert.equal(rowFor([subject, ...peers], planned).lower, score);
        const local = publicReferenceWeights({ participantCount: 2, scoringEntries: planned })[0];
        const expanded = await expandTopicReferences({ contextID: 1, entries: [local, allocation(-2, 5000)] },
            { loadTarget: async () => ({ contextID: 2, entries: planned }) });
        const scored = rowFor([subject, ...peers], expanded.scoringEntries);
        assert.equal(scored.lower, score);
        assert.equal(scored.inferredScores.reduce((sum, row) => sum + row.originalWeight, 0), score === null ? 0 : 100);
    }
});

test('missing anchors, unrelated versions, excluded nodes, mismatched settings, and disconnected cycles stay unresolved', () => {
    const scenarios = [
        [model(1, {}), ...peers],
        [subject, model(2, { 50: 70, 60: 80 }), model(3, { 60: 80, 10: 100 })],
        [subject, model(2, { 50: 70, 70: 80 }), model(3, { 70: 80, 10: 100 })],
        [subject, model(2, { 50: 70, 20: 80 }), model(3, { 20: 80, 10: 100 }, { tool: 'on' })],
        [subject, model(2, { 50: 70, 30: 80, 40: 90 }), model(3, { 20: 90, 10: 100 })]
    ];
    for (const runs of scenarios) {
        const row = rowFor(runs);
        assert.deepEqual([row.inferredScores, row.availableInference.unresolvedContribution, row.fallbackCoverage], [[], 0, 0]);
    }
    const excluded = rowFor([subject, ...peers], weights(), { excludedConditionIDs: new Set([30]) });
    assert.deepEqual(excluded.inferredScores, []);
});

test('cross-benchmark sources are tried after all viable sibling routes', () => {
    const nominated = createVersionEstimationPlanner(catalogue, [{ targetConditionID: 10, sourceConditionID: 60 }]);
    const runs = [model(1, { 50: 70, 60: 30 }), ...peers, model(6, { 10: 77, 60: 30 })];
    const [scoring] = nominated([allocation(10)]);
    const sibling = rowFor(runs, [scoring]);
    assert.equal(sibling.lower, 100);
    assert.equal(sibling.inferredScores[0].sources[0].sourceConditionID, 50);

    const veto = [{ targetConditionID: 40, sourceConditionID: 30, opposeCount: 2, supportCount: 0 }];
    const fallback = rowFor(runs, nominated([allocation(10)], veto));
    assert.equal(fallback.lower, 77);
    assert.deepEqual(fallback.inferredScores[0].sources, [{ sourceConditionID: 60, sourceScore: 30, referenceCount: 1 }]);
    assert.equal(rowFor(runs, weights(veto)).lower, null);
});

test('a nominated source must validate separately for each direction of public scoring', () => {
    const nominated = createVersionEstimationPlanner(catalogue, [{ targetConditionID: 10, sourceConditionID: 60 }]);
    const runs = [model(1, { 60: 55 }), model(2, { 10: 55 }), ...[
        [10, 80], [20, 80], [35, 30], [50, 50], [65, 55], [80, 70], [90, 80]
    ].map(([target, source], index) => model(index + 3, { 10: target, 60: source }))];
    const score = (conditionID, modelID, validateExternal) => scoreModels(runs, nominated([allocation(conditionID)]), 10000,
        { ...options, validateExternal }).find(row => row.modelID === modelID);
    assert.equal(score(10, 1, false).inferredScores[0].sources[0].sourceConditionID, 60);
    assert.deepEqual(score(10, 1, true).inferredScores, []);
    assert.equal(score(60, 2, true).inferredScores[0].sources[0].sourceConditionID, 10);
});

test('shortest chains win, then the strongest weakest link, then a stable version ID', () => {
    const edges = [model(2, { 50: 70, 20: 60 }), model(3, { 20: 60, 10: 10 }),
        model(4, { 50: 70, 30: 80 }), model(5, { 50: 70, 30: 80 }),
        model(6, { 30: 80, 10: 90 }), model(7, { 30: 80, 10: 90 })];
    const chosen = rowFor([subject, ...edges]).inferredScores[0];
    assert.deepEqual(chosen.sources[0].calibrationPaths, [path([30, 2], [10, 2])]);
    assert.equal(chosen.normalizedScore, 90);
    const tied = [edges[0], edges[1], edges[3], edges[5]];
    for (const refs of [tied, [...tied].reverse()]) assert.equal(rowFor([subject, ...refs]).lower, 10);
    assert.equal(rowFor([subject, ...edges, model(21, { 50: 70, 10: 5 })]).lower, 5);
});

test('held-out model identity is excluded even from an interior hop and a cached path is rechecked', () => {
    const rows = [subject, model(7, { 50: 70 }), model(2, { 50: 70, 40: 80 }),
        model(3, { 40: 80, 30: 60 }, {}, { modelID: 7 }), model(4, { 30: 60, 10: 100 })];
    const result = scoreModels(rows, weights(), 10000, options);
    assert.equal(result[0].lower, 100);
    assert.deepEqual(result[1].inferredScores, []);
    const alternate = scoreModels([...rows, model(5, { 40: 80, 20: 60 }), model(6, { 20: 60, 10: 50 })], weights(), 10000, options);
    assert.equal(alternate[1].lower, 50);
});

test('matched runs use their own conversion paths and retain equal control weights', () => {
    const a = { setting: 'a' }, b = { setting: 'b' };
    const runs = [model(1, { 50: 10 }, a), model(2, { 50: 20 }, b, { modelID: 1 })];
    // Each comparison group measures the source in both control settings.
    for (const [id, sa, sb] of [[11, { 50: 10, 10: 20 }, { 50: 20, 30: 30 }], [21, { 50: 10 }, { 50: 20 }]]) {
        runs.push(model(id, sa, a), model(id + 1, sb, b, { modelID: id }));
    }
    runs.push(model(40, { 30: 30, 10: 80 }, b));
    const compared = scoreComparison(runs, weights(), 10000, options, comparisonOptions(runs, { mode: 'matched', keys: ['model'] }));
    const row = compared.find(m => m.modelID === 1);
    assert.deepEqual([row.lower, row.coverage, row.inferredScores[0].sources[0].sourceScore], [50, 0, 15]);
    assert.deepEqual(row.inferredScores[0].sources[0].calibrationPaths, [path([10, 1]), path([30, 1], [10, 1])]);
    const incomplete = runs.slice(0, -1);
    const others = scoreComparison(incomplete, weights(), 10000, options, comparisonOptions(incomplete, { mode: 'matched', keys: ['model'] }));
    assert.deepEqual(others.find(m => m.modelID === 1).inferredScores, []);
});

test('workspace and paginated ranks preserve the measured source and validate every calibration step', () => {
    const state = createFixtureState({ estimationSources: true, secondaryBenchmark: true,
        additionalBenchmarkVersions: [{ ...secondaryBenchmark, ID: 902, conditionID: 902, conditionKey: 'diagnostic', conditionName: 'Diagnostic' }],
        publicWeights: [allocation(1)], comparisonModels: [model(1, { 902: 50 }), model(2, { 902: 50, 901: 80 }), model(3, { 901: 80, 1: 75 })] });
    const raw = workspace(state, { categoryID: 1, scoreMode: 'available' }, { paginate: false });
    const pager = createRankingPager(), initial = pager.create(raw, { userID: state.userID, initialMode: 'public' });
    validateWorkspacePayload(initial);
    const response = pager.getPage({ snapshotID: initial.rankingPagination.snapshotID, userID: state.userID, list: 'public', offset: 0 });
    const expected = { list: 'public', scoreMode: 'available', offset: 0 };
    validateRankingPagePayload(response, expected);
    const source = rows => rows.find(row => row.modelID === 1).inferredScores[0].sources[0];
    assert.deepEqual(source(response.items), { sourceConditionID: 902, sourceScore: 50, referenceCount: 1,
        calibrationPaths: [path([901, 1], [1, 1])] });
    for (const invalid of [[], [path([1, 1])], [path([901, 1], [902, 1], [1, 1])], [path([901, 1], [3, 1])],
        [path([901, 0], [1, 1])], [path([901, 2], [1, 3])], [path([901, 1], [1, 1]), path([901, 1], [1, 1])]]) {
        const broken = structuredClone(response);
        source(broken.items).calibrationPaths = invalid;
        assert.throws(() => validateRankingPagePayload(broken, expected), /inferredScores/);
    }
});
