import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreComparison, scoreModels } from '../ranking-service.js';
import { comparisonOptions } from '../model-comparison.js';
import { createFixtureState, familyEntries, weightedEntries, workspace } from '../scripts/frontend/fixtures.mjs';
import { validateWorkspacePayload } from '../public/js/workspace/contracts.js';
import { rankingReadBody } from '../public/js/shared/available-score.js';
import { calibrationModel as model, pairedModels } from './helpers/fallback-pairs.mjs';

const weights = [{ conditionID: 1, weightBasisPoints: 2000 }, { conditionID: 3, weightBasisPoints: 8000 }];
const rule = { primaryConditionID: 1, familyID: 10, mode: 'ordered', entries: [{ conditionID: 2 }, { conditionID: 4 }] };
function rank(subject, peers, options = {}, entries = weights) {
    const models = [subject, ...peers];
    return scoreComparison(models, entries, 10000, { scoreMode: 'available', fallbackRules: [rule], ...options },
        comparisonOptions(models, { mode: 'best', keys: ['model'], filters: [{ key: 'model', operator: 'eq', value: subject.modelID }] }))[0];
}

test('a later direct result replaces the calibrated estimate and closes only its part of the range', () => {
    const peers = pairedModels(1, 2, 85, -10);
    const earlier = model(1, { 2: 85, 3: 80 }), later = model(1, { 1: 75, 2: 85, 3: 80 });
    const before = rank(earlier, peers), after = rank(later, peers);
    assert.deepEqual([before.lower, before.coverage, before.fallbackCoverage], [79, 80, 20]);
    assert.deepEqual([after.lower, after.coverage, after.fallbackCoverage], [79, 100, 0]);
    assert.deepEqual(before.inferredScores.map(s => [s.conditionID, s.sourceConditionID, s.sourceScore, s.normalizedScore, s.referenceCount, s.estimationMethod]),
        [[1, 2, 85, 75, 5, 'joint-versions']]);
    assert.deepEqual(before.calculationScores.map(s => s.conditionID), [3]);
    assert.deepEqual(after.inferredScores, []);
    const range = rank(earlier, peers, { scoreMode: 'range' });
    assert.deepEqual([range.lower, range.upper, range.coverage, range.inferredScores], [64, 84, 80, []]);
    const complete = rank(later, peers, { scoreMode: 'range' });
    assert.deepEqual([complete.lower, complete.upper], [79, 79]);
    const only = rank(model(1, { 2: 85 }), peers, {}, [{ conditionID: 1, weightBasisPoints: 10000 }]);
    assert.deepEqual([only.lower, only.comparable, only.coverage, only.resultCount], [75, true, 0, 1]);
});

test('only in-chain sources are considered, in order, and each one estimates the primary directly', () => {
    const peers = pairedModels(1, 4, 85, -10);
    const subject = model(1, { 2: 85, 4: 85, 3: 80, 999: 120 });
    const row = rank(subject, peers);
    assert.deepEqual(row.fallbackResolutions[0].attemptedConditionIDs, [1, 2, 4]);
    assert.equal(row.inferredScores[0].sourceConditionID, 4);
    assert.equal(row.lower, 79);
    peers.forEach((p, i) => p.results.set('2', { normalizedScore: 91 + (i - 2) * 2 }));
    subject.results.set('2', { normalizedScore: 91 });
    assert.equal(rank(subject, peers).inferredScores[0].sourceConditionID, 2);
    assert.deepEqual(rank(subject, peers, { fallbackRules: [] }).inferredScores.map(score => [score.estimationMethod, score.normalizedScore]),
        [['treemap-weighted', 80]]);
    const outside = rank(model(1, { 999: 120 }), peers);
    assert.equal(outside.comparable, false);
    assert.deepEqual(outside.inferredScores, []);
    const nextChain = { primaryConditionID: 2, mode: 'ordered', entries: [{ conditionID: 4 }] };
    assert.deepEqual(rank(model(1, { 4: 85 }), peers, { fallbackRules: [{ ...rule, entries: [{ conditionID: 2 }] }, nextChain] }).inferredScores, []);
    assert.deepEqual(rank(subject, peers, { excludedConditionIDs: new Set([1]) }).inferredScores, []);
});

test('sparse, noisy and extrapolated paired data contribute while settings and model identities stay separate', () => {
    const subject = model(1, { 2: 85 });
    const peers = pairedModels(1, 2, 85, -10);
    const singleVendor = peers.map(p => ({ ...p, vendor: 'V' }));
    const noisy = peers.map((p, i) => model(p.ID, { 1: [40, 90, 45, 90, 85][i], 2: 85 }));
    for (const evidence of [peers.slice(1), pairedModels(1, 2, 95, -10), noisy, singleVendor]) {
        const row = rank({ ...subject, vendor: 'Other' }, evidence);
        assert.equal(row.inferredScores[0].referenceCount, evidence.length);
        assert.ok(Number.isFinite(row.lower));
    }
    const alongside = peers.map(p => ({ ...p, modelID: 2 }));
    assert.equal(rank(subject, alongside).inferredScores[0].referenceCount, 1);
    for (const excluded of [pairedModels(1, 2, 85, -10, { effort: 'high' }),
        peers.map(p => ({ ...p, modelID: subject.modelID })),
        peers.flatMap(p => [model(p.ID, { 1: 75 }, { effort: 'high' }),
            model(p.ID + 100, { 2: 85 }, {}, { modelID: p.modelID })])]) {
        // Use the raw subject because a best projection could take an actual A from another member.
        const [row] = scoreModels([subject, ...excluded], weights, 10000, { scoreMode: 'available', fallbackRules: [rule] });
        assert.deepEqual(row.inferredScores, []);
    }
});

test('off-chain scores have no influence and best performance compares separately estimated runs', () => {
    const subject = model(1, { 2: 85, 3: 80, 999: 90 });
    const peers = pairedModels(1, 2, 85, -10);
    const before = rank(subject, peers);
    for (const [n, peer] of peers.entries()) peer.results.set('999', { normalizedScore: n % 2 ? -120 : 300 });
    subject.results.get('999').normalizedScore = 0;
    const after = rank(subject, peers);
    assert.equal(after.lower, before.lower);
    assert.deepEqual(after.inferredScores, before.inferredScores);
    const tied = model(101, { 2: 85 }, { effort: 'high' }, { modelID: 1 });
    const other = pairedModels(1, 2, 85, 10, { effort: 'high' }).map(p => ({ ...p, ID: p.ID + 100, modelID: p.modelID + 100 }));
    assert.equal(rank(subject, [tied, ...peers, ...other]).inferredScores[0].normalizedScore, 95);
});

test('selection share applies only to that chain, with the same paired models across scenes and both personal and public reads', () => {
    const subject = model(1, { 2: 85, 3: 80 }), peers = pairedModels(1, 2, 85, -10);
    const composition = [{ primaryConditionID: 1, families: [{ ...rule, weightBasisPoints: 6000 },
        { primaryConditionID: 1, familyID: null, entries: [], weightBasisPoints: 4000 }] }];
    for (const fallbackScope of ['personal', 'public']) {
        const row = rank(subject, peers, { fallbackScope, familyComposition: composition, fallbackRules: [] });
        assert.deepEqual(row.inferredScores.map(s => [s.estimationMethod, s.originalWeight]), [['joint-versions', 12], ['treemap-weighted', 8]]);
        assert.equal(row.inferredScores[0].normalizedScore, 75);
        assert.ok(Math.abs(row.inferredScores[1].normalizedScore - 73 / .92) < 1e-9);
        assert.equal(row.coverage, 80);
        assert.equal(row.fallbackCoverage, 12);
        assert.equal(row.availableInference.unresolvedFraction, 0);
    }
});

test('workspace rejects invented fallback measurements or malformed calibration traces', () => {
    const state = createFixtureState({ comparisonModels: [model(1, { 2: 85, 3: 80 }), ...pairedModels(1, 2, 85, -10)],
        personalEntries: weightedEntries(weights), fallbackRules: [{ ...rule, entries: familyEntries(rule.entries) }], publicWeights: weights });
    const payload = workspace(state, { scoreMode: 'available', initialMode: 'personal' });
    assert.equal(validateWorkspacePayload(payload), payload);
    for (const change of [row => { row.inferredScores[0].sourceConditionID = 50; }, row => { row.inferredScores[0].sources[0].referenceCount = 0; },
        row => { row.inferredScores[0].estimationMethod = 'unknown'; }, row => { row.inferredScores[0].contribution++; },
        row => { row.calculationScores[0].fallbackFor = 1; }, row => { row.coverage = 100; }]) {
        const broken = structuredClone(payload);
        change(broken.modelLeaderboards.personal.find(row => row.modelID === 1));
        assert.throws(() => validateWorkspacePayload(broken), /Invalid workspace response/);
    }
});

test('current and stale requests select the calibrated formula, and invalid requests are rejected', () => {
    for (const version of [undefined, 1, 7, 8, 9, 10, 11, 12]) assert.equal(rankingReadBody('/api/get_weighted_workspace', { availableInferenceVersion: version }).availableInferenceVersion, 13);
    assert.throws(() => scoreModels([], weights, 10000, { availableInferenceVersion: 14 }), e => e.status === 400);
    const body = { value: 1 };
    assert.equal(rankingReadBody('/api/save_personal_pie', body), body);
});
