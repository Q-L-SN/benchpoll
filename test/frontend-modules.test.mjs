import assert from 'node:assert/strict';
import test from 'node:test';
import { distributeToTarget, clonePersonalPieSnapshot, benchmarkConditionLabel } from '../public/js/workspace/weights.js';
import { validateWorkspacePayload, validateRankingPagePayload, validateApprovedModelResultsPayload } from '../public/js/workspace/contracts.js';
import { createWorkspaceState } from '../public/js/workspace/state.js';
import { modelRankingEmptyMessage } from '../public/js/workspace/model-list.js';
import { createWorkspaceChannel } from '../public/js/shared/workspace-channel.js';
import { escapeHTML, finiteOrNull, entityLocator, evaluationDisplayScoreBounds, evaluationStoredTargetValue, rankedMatches } from '../public/js/contribution/fields.js';
import { createFixtureState, workspace, approvedResults } from '../scripts/frontend/fixtures.mjs';

test('redistribution conserves exact total, minimum weight, identity and source data', () => {
    for (const count of [1, 2, 3, 7, 12, 99, 100]) {
        const entries = Array.from({ length: count }, (_, i) => ({ conditionID: i + 1, weightBasisPoints: 100 + (i * 197 % 9500) }));
        const before = structuredClone(entries);
        const next = distributeToTarget(entries, 10000);
        assert.equal(next.reduce((sum, entry) => sum + entry.weightBasisPoints, 0), 10000);
        assert.ok(next.every(entry => Number.isInteger(entry.weightBasisPoints) && entry.weightBasisPoints >= 100 && entry.weight === entry.weightBasisPoints / 100));
        assert.deepEqual(next.map(entry => entry.conditionID), entries.map(entry => entry.conditionID));
        assert.deepEqual(entries, before);
    }
    assert.deepEqual(distributeToTarget([], 10000), []);
    assert.deepEqual(distributeToTarget([{}, {}, {}].map((entry, i) => ({ ...entry, ID: i, weightBasisPoints: 100 })), 10000).map(entry => entry.weightBasisPoints), [3334, 3333, 3333]);
});

test('undo snapshots and separate workspace instances do not share mutable data', () => {
    const original = { entries: [{ conditionID: 1, weightBasisPoints: 10000 }], fallbackRules: [{ primaryConditionID: 1, entries: [{ conditionID: 2, weightBasisPoints: 10000 }] }] };
    const snapshot = clonePersonalPieSnapshot(original);
    snapshot.entries[0].weightBasisPoints = 100;
    snapshot.fallbackRules[0].entries[0].conditionID = 3;
    assert.equal(original.entries[0].weightBasisPoints, 10000);
    assert.equal(original.fallbackRules[0].entries[0].conditionID, 2);
    const first = createWorkspaceState(), second = createWorkspaceState();
    first.personalEntries.push({ conditionID: 1 });
    first.pieOrderByObjectID.set(1, 0);
    assert.equal(second.personalEntries.length, 0);
    assert.equal(second.pieOrderByObjectID.size, 0);
});

test('model ranking empty messages distinguish missing weights from filtered results', () => {
    const state = createWorkspaceState();
    state.comparison = { mode: 'best', keys: ['field:1'], filters: [] };
    assert.equal(modelRankingEmptyMessage(state), 'No public weights for this topic or scene yet.');
    state.publicEntries = [{ conditionID: 1, weightBasisPoints: 10000 }];
    assert.equal(modelRankingEmptyMessage(state), 'No models match these settings. Try combining run settings or removing a filter.');
    state.mode = 'personal';
    assert.equal(modelRankingEmptyMessage(state), 'Add evaluation items to Personal Weights to calculate a model ranking.');
    state.personalEntries = [{ conditionID: 1, weightBasisPoints: 10000 }];
    assert.equal(modelRankingEmptyMessage(state), 'No models match these settings. Try combining run settings or removing a filter.');
    state.comparison = { mode: 'best', keys: [], filters: [] };
    assert.equal(modelRankingEmptyMessage(state), 'No measured results match these weights yet. Add another evaluation item or contribute scores.');
});

test('workspace contract rejects missing arrays, mixed identities, and invalid fallback allocations', () => {
    const valid = workspace(createFixtureState(), {});
    assert.equal(validateWorkspacePayload(valid), valid);
    for (const mutate of [
        payload => { delete payload.authenticated; },
        payload => { delete payload.userID; },
        payload => { payload.userID = 9007199254740992; },
        payload => { payload.userID = '01'; },
        payload => { payload.authenticated = false; },
        payload => { delete payload.personalPie.entries; },
        payload => { payload.benchmarks[0].conditionName = 'changed'; },
        payload => { delete payload.benchmarks[0].scoreCount; },
        payload => { payload.benchmarks[0].lowCoverage = 'false'; },
        payload => { payload.context.dimensions = [{ key: 'invalid', name: 'Invalid', options: null }]; },
        payload => { payload.personalPie.fallbackRules = [{ primaryConditionID: 1, mode: 'fallback_if_missing', entries: [{ ...payload.benchmarks[1], weightBasisPoints: 9999 }] }]; },
        payload => { payload.personalPie.fallbackRules = [{ primaryConditionID: 1, mode: 'fallback_if_missing', entries: [{ ...payload.benchmarks[0], weightBasisPoints: 10000 }] }]; },
        payload => { payload.modelLeaderboards.public[0].rank = undefined; },
        payload => { payload.scoreMode = 'unknown'; },
        payload => { payload.rankingPagination.benchmarks.primary.nextOffset += 1; },
        payload => { delete payload.rankingPagination.benchmarks.lowCoverage; },
        payload => { delete payload.benchmarks[0].isPrimaryCondition; }
    ]) {
        const payload = structuredClone(valid); mutate(payload);
        assert.throws(() => validateWorkspacePayload(payload), error => error.code === 'invalid_workspace_response' && error.status === 422);
    }
});

test('ranking page contract rejects pages that cannot be safely appended', () => {
    const first = workspace(createFixtureState(), {});
    const valid = { items: [], total: 8, nextOffset: 8, hasMore: false, group: 'primary', grouping: 'versions',
        groupTotals: { primary: 8, other: 2, lowCoverage: 1 } };
    assert.equal(validateRankingPagePayload(valid, { list: 'benchmarks', group: 'primary', offset: 8, grouping: 'versions' }), valid);
    assert.throws(() => validateRankingPagePayload({ ...valid, hasMore: true },
        { list: 'benchmarks', group: 'primary', offset: 8, grouping: 'versions' }), error => error.code === 'invalid_workspace_response');
    assert.throws(() => validateRankingPagePayload({ items: first.modelLeaderboards.public.slice(0, 1),
        total: 8, nextOffset: 2, hasMore: true }, { list: 'public', offset: 0 }),
    error => error.code === 'invalid_workspace_response');
});

test('approved score contract requires real sample counts, numeric scores and safe optional sources', () => {
    const valid = approvedResults({ modelID: 301, scoreFields: [] });
    assert.equal(validateApprovedModelResultsPayload(valid), valid);
    for (const mutate of [
        payload => { payload.scoreGroups[0].sampleCount = 7; },
        payload => { payload.scoreGroups[0].samples[0].rawScore = '88'; },
        payload => { payload.scoreGroups[0].samples[0].sourceURL = 'javascript:alert(1)'; },
        payload => { payload.scoreGroups[0].samples[0].sourceURL = 'not a URL'; },
        payload => { payload.scoreGroups[0].samples[0].sourceURL = {}; },
        payload => { delete payload.scoreGroups[0].distinctScoreCount; },
        payload => { payload.scoreGroups[0].distinctScoreCount = 3; }
    ]) {
        const payload = structuredClone(valid); mutate(payload);
        assert.throws(() => validateApprovedModelResultsPayload(payload), error => error.code === 'invalid_model_scores_response');
    }
});

test('approved score evidence remains readable when a stored score has no source link', () => {
    for (const sourceURL of ['', null]) {
        const payload = approvedResults({ modelID: 301, scoreFields: [] });
        payload.scoreGroups[0].samples[0].sourceURL = sourceURL;
        assert.equal(validateApprovedModelResultsPayload(payload), payload);
    }
});

test('workspace channel replays initial context once and waits for pending save', async () => {
    const channel = createWorkspaceChannel();
    channel.publish({ categoryID: 1 });
    const contexts = [];
    const stop = channel.subscribe(value => { contexts.push(value.categoryID); value.categoryID = 99; });
    let finish;
    channel.beforeChange(() => new Promise(resolve => { finish = resolve; }));
    let completed = false;
    const pending = channel.prepareChange().then(allowed => { completed = true; return allowed; });
    await Promise.resolve();
    assert.equal(completed, false);
    finish(false);
    assert.equal(await pending, false);
    assert.deepEqual(contexts, [1]);
    stop();
    channel.publish({ categoryID: 2 });
    assert.deepEqual(contexts, [1]);
    channel.beforeChange(async () => true);
    assert.equal(await channel.prepareChange(), true);
});

test('contribution helpers retain pending identities, open score ranges, escaping and search order', () => {
    assert.equal(escapeHTML('<script a="x">&'), '&lt;script a=&quot;x&quot;&gt;&amp;');
    assert.equal(finiteOrNull(''), null);
    assert.equal(finiteOrNull('0'), 0);
    assert.equal(finiteOrNull('Infinity'), null);
    assert.deepEqual(entityLocator({ reference: 'pending:1' }, 'ID', 'ref'), { ID: null, ref: 'pending:1' });
    assert.deepEqual(evaluationDisplayScoreBounds({ usesPercentageScale: true }), { min: 0, max: 100 });
    assert.deepEqual(evaluationDisplayScoreBounds({ usesPercentageScale: false, scoreMin: '0', scoreMax: '' }), { min: 0, max: null });
    assert.equal(evaluationStoredTargetValue({ scoreDirection: 'closer_to_target', targetValue: '0' }), 0);
    assert.deepEqual(rankedMatches(['Other code', 'Code generation', 'Code'], '  CODE ', item => item), ['Code', 'Code generation', 'Other code']);
    assert.equal(benchmarkConditionLabel({ conditionName: ' DEFAULT ' }), '');
    assert.equal(benchmarkConditionLabel({ conditionName: 'pass@1' }), 'pass@1');
});
