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
    assert.deepEqual(before.inferredScores.map(s => [s.conditionID, s.sourceConditionID, s.sourceScore, s.normalizedScore, s.referenceCount, s.validationError]),
        [[1, 2, 85, 75, 5, 0]]);
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
    peers.forEach((p, i) => p.results.set('2', { normalizedScore: [85, 0, 2, 90, 97][i] }));
    const subject = model(1, { 2: 85, 4: 85, 3: 80, 999: 120 });
    const row = rank(subject, peers);
    assert.deepEqual(row.fallbackResolutions[0].attemptedConditionIDs, [1, 2, 4]);
    assert.equal(row.inferredScores[0].sourceConditionID, 4);
    assert.equal(row.lower, 79);
    peers.forEach((p, i) => p.results.set('2', { normalizedScore: 91 + (i - 2) * 2 }));
    subject.results.set('2', { normalizedScore: 91 });
    assert.equal(rank(subject, peers).inferredScores[0].sourceConditionID, 2);
    assert.deepEqual(rank(subject, peers, { fallbackRules: [] }).inferredScores, []);
    const outside = rank(model(1, { 999: 120 }), peers);
    assert.equal(outside.comparable, false);
    assert.deepEqual(outside.inferredScores, []);
    const nextChain = { primaryConditionID: 2, mode: 'ordered', entries: [{ conditionID: 4 }] };
    assert.deepEqual(rank(model(1, { 4: 85 }), peers, { fallbackRules: [{ ...rule, entries: [{ conditionID: 2 }] }, nextChain] }).inferredScores, []);
    assert.deepEqual(rank(subject, peers, { excludedConditionIDs: new Set([1]) }).inferredScores, []);
});

test('unreliable, extrapolated or cross-setting pairs and repeated runs of one model cannot fill a gap', () => {
    const subject = model(1, { 2: 85 });
    const peers = pairedModels(1, 2, 85, -10);
    const singleVendor = peers.map(p => ({ ...p, vendor: 'V' }));
    const noisy = peers.map((p, i) => model(p.ID, { 1: [40, 90, 45, 90, 85][i], 2: 85 }));
    for (const rejected of [peers.slice(1), pairedModels(1, 2, 95, -10), pairedModels(1, 2, 85, -10, { effort: 'high' }),
        peers.map(p => ({ ...p, modelID: 2 })), noisy]) {
        assert.deepEqual(rank(subject, rejected).inferredScores, []);
    }
    assert.equal(rank({ ...subject, vendor: 'Other' }, singleVendor).comparable, false);
    assert.equal(rank({ ...subject, vendor: 'V' }, singleVendor).lower, 41.67);
    const heldOut = peers.map((p, i) => model(p.ID, { 1: i < 3 ? 70 : 79, 2: 85 }, {}, { vendor: i < 3 ? 'V' : 'W' }));
    assert.deepEqual(rank(subject, heldOut).inferredScores, []);
    const split = peers.flatMap(p => [model(p.ID, { 1: 75 }, { effort: 'high' }),
        model(p.ID + 100, { 2: 85 }, {}, { modelID: p.modelID })]);
    assert.deepEqual(rank(subject, split).inferredScores, []);
});

test('off-chain measurements cannot move an accepted estimate, and tied source runs must agree', () => {
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
    assert.deepEqual(rank(subject, [tied, ...peers, ...other]).inferredScores, []);
});

test('selection share applies only to that chain, with the same paired models across scenes and both personal and public reads', () => {
    const subject = model(1, { 2: 85, 3: 80 }), peers = pairedModels(1, 2, 85, -10);
    const composition = [{ primaryConditionID: 1, families: [{ ...rule, weightBasisPoints: 6000 },
        { primaryConditionID: 1, familyID: null, entries: [], weightBasisPoints: 4000 }] }];
    for (const fallbackScope of ['personal', 'public']) {
        const row = rank(subject, peers, { fallbackScope, familyComposition: composition, fallbackRules: [] });
        assert.deepEqual(row.inferredScores.map(s => [s.normalizedScore, s.originalWeight]), [[75, 12]]);
        assert.equal(row.coverage, 80);
        assert.equal(row.fallbackCoverage, 12);
        assert.ok(Math.abs(row.availableInference.unresolvedFraction - .08) < 1e-12);
    }
});

test('workspace rejects invented fallback measurements or malformed calibration traces', () => {
    const state = createFixtureState({ comparisonModels: [model(1, { 2: 85, 3: 80 }), ...pairedModels(1, 2, 85, -10)],
        personalEntries: weightedEntries(weights), fallbackRules: [{ ...rule, entries: familyEntries(rule.entries) }], publicWeights: weights });
    const payload = workspace(state, { scoreMode: 'available', initialMode: 'personal' });
    assert.equal(validateWorkspacePayload(payload), payload);
    for (const change of [row => { row.inferredScores[0].sourceConditionID = 50; }, row => { row.inferredScores[0].referenceCount = 2; },
        row => { row.inferredScores[0].validationError = 10; }, row => { row.inferredScores[0].contribution++; },
        row => { row.calculationScores[0].fallbackFor = 1; }, row => { row.coverage = 100; }]) {
        const broken = structuredClone(payload);
        change(broken.modelLeaderboards.personal.find(row => row.modelID === 1));
        assert.throws(() => validateWorkspacePayload(broken), /Invalid workspace response/);
    }
});

test('current and stale requests select the calibrated formula, and invalid requests are rejected', () => {
    for (const version of [undefined, 1, 7, 8]) assert.equal(rankingReadBody('/api/get_weighted_workspace', { availableInferenceVersion: version }).availableInferenceVersion, 8);
    assert.throws(() => scoreModels([], weights, 10000, { availableInferenceVersion: 9 }), e => e.status === 400);
    const body = { value: 1 };
    assert.equal(rankingReadBody('/api/save_personal_pie', body), body);
});
