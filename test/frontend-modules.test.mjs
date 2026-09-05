import assert from 'node:assert/strict';
import test from 'node:test';
import { distributeToTarget, clonePersonalPieSnapshot, benchmarkConditionLabel } from '../public/js/workspace/weights.js';
import { validateWorkspacePayload, validateApprovedModelResultsPayload } from '../public/js/workspace/contracts.js';
import { createWorkspaceState } from '../public/js/workspace/state.js';
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

test('workspace contract rejects missing arrays, mixed identities, and invalid fallback allocations', () => {
    const valid = workspace(createFixtureState(), {});
    assert.equal(validateWorkspacePayload(valid), valid);
    for (const mutate of [
        payload => { delete payload.personalPie.entries; },
        payload => { payload.benchmarks[0].conditionName = 'changed'; },
        payload => { payload.context.dimensions[0].options = null; },
        payload => { payload.personalPie.fallbackRules = [{ primaryConditionID: 1, mode: 'fallback_if_missing', entries: [{ ...payload.benchmarks[1], weightBasisPoints: 9999 }] }]; },
        payload => { payload.personalPie.fallbackRules = [{ primaryConditionID: 1, mode: 'fallback_if_missing', entries: [{ ...payload.benchmarks[0], weightBasisPoints: 10000 }] }]; }
    ]) {
        const payload = structuredClone(valid); mutate(payload);
        assert.throws(() => validateWorkspacePayload(payload), error => error.code === 'invalid_workspace_response' && error.status === 422);
    }
});

test('approved score contract requires real sample counts, numeric scores and sources', () => {
    const valid = approvedResults({ modelConditionID: 201 });
    assert.equal(validateApprovedModelResultsPayload(valid), valid);
    for (const mutate of [
        payload => { payload.scoreGroups[0].sampleCount = 7; },
        payload => { payload.scoreGroups[0].samples[0].rawScore = '88'; },
        payload => { payload.scoreGroups[0].samples[0].sourceURL = ''; }
    ]) {
        const payload = structuredClone(valid); mutate(payload);
        assert.throws(() => validateApprovedModelResultsPayload(payload), error => error.code === 'invalid_model_scores_response');
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
