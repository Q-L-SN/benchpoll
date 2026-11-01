import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreComparison, scoreModels } from '../ranking-service.js';
import { comparisonOptions } from '../model-comparison.js';
import { availableResultInference, rankingReadBody } from '../public/js/shared/available-score.js';
import { validateWorkspacePayload } from '../public/js/workspace/contracts.js';
import { createFixtureState, weightedEntries, workspace } from '../scripts/frontend/fixtures.mjs';

const model = (ID, values, parameters = {}) => ({ ID, modelID: ID, name: `M${ID}`, modelName: `M${ID}`,
    condition: { parameters, scoreFields: [] }, results: new Map(Object.entries(values).map(([key, normalizedScore]) => [key, { normalizedScore }])) });
const weights = [1, 2].map(conditionID => ({ conditionID, weightBasisPoints: 5000 }));
const population = () => [model(1, { 1: 95 }), model(2, { 1: 90, 3: 20, 2: 10 }),
    model(3, { 3: 80, 2: 70 }), model(4, { 2: 60 }), model(5, { 2: 90 })];
const score = (models, input = {}, rules = {}) => scoreComparison(models, weights, 10000,
    { scoreMode: 'available', ...rules }, comparisonOptions(models, { mode: 'best', keys: ['model'], ...input }));

test('new totals and stale client requests both use rational common-test estimates', () => {
    const models = population(), before = structuredClone(models), [current] = score(models);
    const [legacy] = score(models, {}, { availableInferenceVersion: 1 });
    assert.equal(current.availableInference.method, 'pairwise-anchored-rational-coverage-factor');
    assert.deepEqual(current.availableInference, legacy.availableInference);
    assert.deepEqual(current.inferredScores, legacy.inferredScores);
    assert.ok(current.inferredScores[0].normalizedScore < 60);
    assert.deepEqual(current.calculationScores, legacy.calculationScores);
    assert.deepEqual(current.comparisonScores, legacy.comparisonScores);
    assert.equal(current.coverage, 50);
    assert.equal(current.missingWeight, 50);
    assert.equal(current.resultCount, 1);
    assert.deepEqual(models, before);
});

test('model limits preserve peers; run-setting limits do not bypass the selected evidence', () => {
    const models = population(), all = score(models)[0];
    const [limited] = score(models, { filters: [{ key: 'model', operator: 'eq', value: 1 }] });
    assert.equal(limited.lower, all.lower);
    assert.equal(limited.inferredScores[0].referenceCount, 4);
    const disconnected = models.map((m, i) => ({ ...m, condition: { parameters: { harness: i ? 'B' : 'A' }, scoreFields: [] } }));
    const [own] = score(disconnected, { filters: [{ key: 'harness', operator: 'eq', value: 'A' }] });
    assert.deepEqual(own.inferredScores, []);
    assert.equal(own.availableInference.unresolvedFraction, .5);
});

test('real fallback precedes prediction and public missing shares remain separate', () => {
    const models = [model(1, { 3: 25 }), model(2, { 1: 50, 2: 60, 3: 50 }), model(3, { 1: 75, 2: 80, 3: 75 }),
        model(4, { 1: 62, 2: 70, 3: 62 })];
    const rule = { primaryConditionID: 1, familyID: 10, mode: 'ordered', entries: [{ conditionID: 3 }] };
    const [personal] = score(models, {}, { fallbackRules: [rule] });
    assert.equal(personal.calculationScores[0].fallbackFor, 1);
    assert.equal(personal.calculationScores[0].normalizedScore, 25);
    assert.equal(personal.inferredScores[0].conditionID, 2);
    const [shared] = score(models, {}, { fallbackScope: 'public', familyComposition: [
        { primaryConditionID: 1, families: [{ ...rule, weightBasisPoints: 6000 },
            { primaryConditionID: 1, familyID: null, entries: [], weightBasisPoints: 4000 }] },
        { primaryConditionID: 2, families: [{ primaryConditionID: 2, familyID: null, entries: [], weightBasisPoints: 10000 }] }
    ] });
    assert.equal(shared.coverage, 30);
    assert.equal(shared.resultCount, 1);
    assert.equal(shared.inferredScores.length, 2);
    assert.ok(Math.abs(shared.availableInference.inferredFraction - .7) < 1e-9);
    assert.ok(Math.abs([...shared.calculationScores, ...shared.inferredScores].reduce((s, v) => s + v.effectiveWeight, 0) - 100) < 1e-9);
});

test('an isolated measured score remains real while missing peer scores are estimated conservatively', () => {
    const models = [model(1, { 1: 100 }), ...[2, 4, 6, 8, 99].map((value, i) =>
        model(i + 2, { 1: i * 20, 2: value }))];
    const before = structuredClone(models), rows = score(models);
    const predicted = rows.find(row => row.modelID === 1);
    const measured = rows.find(row => row.modelID === 6);
    assert.ok(predicted.inferredScores[0].normalizedScore < 20);
    assert.equal(measured.calculationScores.find(result => result.conditionID === 2).normalizedScore, 99);
    assert.equal(measured.inferredScores.length, 0);
    assert.deepEqual(models, before);
});

test('new traces accept target-specific percentiles, not fabricated observations or invalid evidence', () => {
    const payload = workspace(createFixtureState({ comparisonModels: population(), personalEntries: weightedEntries(weights),
        publicWeights: weights }), { scoreMode: 'available', initialMode: 'personal' });
    assert.equal(validateWorkspacePayload(payload), payload);
    for (const mutate of [row => { row.inferredScores[0].referenceCount = 1; },
        row => { row.inferredScores[0].sourceCount = 0; }, row => { row.inferredScores[0].percentile = 2; },
        row => { row.coverage = 100; }, row => { row.availableInference.percentile = .5; },
        row => { row.availableInference.method = 'fake'; }, row => { row.inferredScores[0].contribution++; }]) {
        const changed = structuredClone(payload);
        mutate(changed.modelLeaderboards.personal.find(row => row.inferredScores.length));
        assert.throws(() => validateWorkspacePayload(changed), /Invalid workspace response/);
    }
});

test('v7 normalization affects reads only; unsupported versions and invalid totals fail closed', () => {
    const body = { scoreMode: 'available' };
    assert.deepEqual(rankingReadBody('/api/get_weighted_workspace', body), { ...body, availableInferenceVersion: 7 });
    assert.deepEqual(rankingReadBody('/api/get_weighted_workspace', { availableInferenceVersion: 1 }), { availableInferenceVersion: 7 });
    assert.deepEqual(rankingReadBody('/api/get_weighted_workspace', { availableInferenceVersion: 6 }), { availableInferenceVersion: 7 });
    assert.equal(rankingReadBody('/api/save_personal_pie', body), body);
    assert.deepEqual(body, { scoreMode: 'available' });
    assert.throws(() => scoreModels([], weights, 10000, { availableInferenceVersion: 8 }), error => error.status === 400);
    const expected = availableResultInference(80, .5, [{ normalizedScore: 40, weightFraction: .5 }], null, 2);
    assert.equal(expected.totalScore, 50);
    assert.throws(() => availableResultInference(80, .5, [{ normalizedScore: 40, weightFraction: .6 }], null, 2), /exceed/);
});
