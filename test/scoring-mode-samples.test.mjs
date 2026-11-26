import { pairedModels } from './helpers/fallback-pairs.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { comparisonOptions, groupComparisonModels } from '../model-comparison.js';
import { scoreComparison } from '../ranking-service.js';

const model = (ID, modelID, parameters, scores) => ({ ID, modelID, modelName: `Model ${modelID}`,
    name: `Model ${modelID} configuration ${ID}`, condition: { parameters },
    results: new Map(Object.entries(scores).map(([key, normalizedScore]) => [key, { normalizedScore }])) });
const weights = (...values) => values.map(([conditionID, weightBasisPoints]) => ({ conditionID, weightBasisPoints }));
function sampleIdentity(row) {
    return { ID: row.ID, comparable: row.comparable, members: row.members,
        coverage: row.coverage, resultCount: row.resultCount, missingWeight: row.missingWeight,
        fallbackUsageCount: row.fallbackUsageCount, fallbackResolutions: row.fallbackResolutions,
        comparisonScores: row.comparisonScores,
        calculationScores: row.calculationScores.map(({ effectiveWeight, contribution, ...sample }) => sample) };
}
function bothModes(models, entries, input = { mode: 'best', keys: ['model'] }, rules = {}, fields = []) {
    const options = comparisonOptions(models, input, fields);
    const before = structuredClone(models);
    const range = scoreComparison(models, entries, 10000, { ...rules, scoreMode: 'range' }, options);
    const available = scoreComparison(models, entries, 10000, { ...rules, scoreMode: 'available' }, options);
    assert.deepEqual(range.map(sampleIdentity), available.map(sampleIdentity), 'Score mode must not change evidence or eligibility');
    assert.deepEqual(models, before, 'Scoring must not mutate source observations');
    return { range, available };
}

test('partially covered fair comparisons use the same evidence in range and available modes', () => {
    const models = [model(1, 1, { harness: 'same' }, { 10: 40 }), model(2, 2, { harness: 'same' }, { 10: 80 })];
    const { range, available } = bothModes(models, weights([10, 5000], [11, 5000]), { mode: 'matched', keys: ['model'] });
    assert.deepEqual(range.map(row => [row.lower, row.upper, row.comparable]), [[20, 70, true], [40, 90, true]]);
    assert.deepEqual(available.map(row => [row.lower, row.upper, row.comparable]), [[40, 40, true], [80, 80, true]]);
    assert.deepEqual(available.map(row => row.availableInference.observedScore), [40, 80]);
    assert.ok(available.every(row => row.inferredScores.length === 1 && row.inferredScores[0].estimationMethod === 'treemap-weighted'));
});

test('per-benchmark matched cohorts do not change when missing results are estimated', () => {
    const models = [model(1, 1, { harness: 'same' }, { 10: 80, 11: 50 }),
        model(2, 2, { harness: 'same' }, { 10: 60 }), model(3, 3, { harness: 'same' }, { 11: 70 })];
    const { range, available } = bothModes(models, weights([10, 4000], [11, 6000]), { mode: 'matched', keys: ['model'] });
    assert.deepEqual(range.map(row => [row.lower, row.upper]), [[62, 62], [24, 84], [42, 82]]);
    assert.deepEqual(available.map(row => row.lower), [62, 60, 70]);
    assert.ok(available.slice(1).every(row => row.inferredScores.length === 1 && row.inferredScores[0].estimationMethod === 'treemap-weighted'));
    assert.deepEqual(available.slice(1).map(row => row.availableInference.method), ['calibrated-fallback', 'calibrated-fallback']);
    assert.deepEqual(available.slice(1).map(row => row.availableInference.unresolvedFraction), [0, 0]);
    assert.ok(range.every(row => row.comparable));
});

test('best-per-benchmark selection, ties, negative scores and overflow use identical configurations', () => {
    const models = [model(1, 1, { harness: 'a' }, { 10: 120, 11: -10 }),
        model(2, 1, { harness: 'b' }, { 10: 120, 11: -20 }), model(3, 2, {}, { 10: 0 })];
    const { range } = bothModes(models, weights([10, 4000], [11, 3000], [12, 3000]));
    assert.deepEqual(range[0].calculationScores.map(row => row.memberIDs), [[1, 2], [1]]);
    assert.equal(range[1].comparable, true, 'A recorded zero is evidence, not a missing result');
});

test('zero-evidence models are noncomparable in both modes, including scores on unweighted benchmarks', () => {
    const models = [model(1, 1, {}, {}), model(2, 2, {}, { 11: 90 }), model(3, 3, {}, { 10: 0 })];
    const { range, available } = bothModes(models, weights([10, 10000], [11, 0]));
    for (const rows of [range, available]) {
        assert.deepEqual(rows.map(row => [row.lower, row.upper, row.comparable]), [[null, null, false], [null, null, false], [0, 0, true]]);
    }
});

test('strict fair-comparison control matching is unchanged by score mode', () => {
    const models = [model(1, 1, { harness: 'a' }, { 10: 80 }), model(2, 2, { harness: 'b' }, { 10: 90 })];
    const { range } = bothModes(models, weights([10, 10000]), { mode: 'matched', keys: ['model'] });
    assert.ok(range.every(row => !row.comparable && row.calculationScores.length === 0));
});

test('ordered family evidence is identical between score modes for both personal and public', () => {
    const models = [model(1, 1, {}, { 10: 0, 20: 90 }), model(2, 2, {}, { 20: 120 }), model(3, 3, {}, {}), ...pairedModels(10, 20, 120, -50)];
    const entries = weights([10, 8000], [11, 2000]);
    const personal = { fallbackRules: [{ primaryConditionID: 10, mode: 'ordered', entries: [{ conditionID: 20 }, { conditionID: 30 }] }] };
    const publicRules = { fallbackScope: 'public', familyComposition: [
        { primaryConditionID: 10, families: [{ primaryConditionID: 10, familyID: 1, entries: [{ conditionID: 20 }, { conditionID: 30 }], weightBasisPoints: 10000 }] },
        { primaryConditionID: 11, families: [{ primaryConditionID: 11, familyID: null, entries: [], weightBasisPoints: 10000 }] }
    ] };
    for (const rules of [personal, publicRules]) {
        const { range, available } = bothModes(models, entries, undefined, rules);
        assert.equal(range[0].fallbackUsageCount, 0, 'A direct zero must beat fallback');
        assert.deepEqual([range[1].lower, range[1].upper], [0, 100]);
        assert.equal(available[1].lower, 68.83);
        assert.deepEqual(available[1].inferredScores.map(row => [row.conditionID, row.estimationMethod]),
            [[10, 'joint-versions'], [11, 'treemap-weighted']]);
        assert.ok(Math.abs(available[1].inferredScores[0].normalizedScore - 68.82647494604078) < 1e-9);
        assert.deepEqual(range[1].calculationScores, []);
    }
});

test('value restrictions preserve the same selected score-field configurations across modes', () => {
    const fields = [{ ID: 1, name: 'Harness', type: 'enum', allowEmpty: false, excludeMissing: true, excludeEmpty: false,
        options: [{ ID: 11, label: 'Agent A', excluded: false }, { ID: 12, label: 'Agent B', excluded: false }] }];
    const models = [model(1, 1, { 'field:1': 11 }, { 10: 60 }), model(2, 1, { 'field:1': 12 }, { 10: 90 }),
        model(3, 2, { 'field:1': 11 }, { 10: 40 }), model(4, 2, {}, { 10: 100 })];
    for (const mode of ['best', 'matched']) {
        const { range } = bothModes(models, weights([10, 5000], [11, 5000]),
            { mode, keys: ['model'], filters: [{ key: 'field:1', operator: 'eq', value: 11 }] }, {}, fields);
        assert.deepEqual(range.map(row => row.members.map(member => member.ID)), [[1], [3]]);
    }
});

test('fair groups are prepared within each pie scope and reused only between scoring denominators', () => {
    const models = [model(1, 1, { harness: 'a' }, { 10: 40, 12: 75 }),
        model(2, 2, { harness: 'a' }, { 10: 80, 12: 50 })];
    const options = comparisonOptions(models, { mode: 'matched', keys: ['model'] });
    for (const entries of [weights([10, 5000], [11, 5000]), weights([12, 3000], [13, 7000])]) {
        const prepared = groupComparisonModels(models, options, entries);
        const before = structuredClone(prepared);
        const range = scoreComparison(models, entries, 10000, { scoreMode: 'range' }, options, prepared);
        const available = scoreComparison(models, entries, 10000, { scoreMode: 'available' }, options, prepared);
        assert.deepEqual(range.map(sampleIdentity), available.map(sampleIdentity));
        assert.ok(range.every(row => row.comparable));
        assert.deepEqual(prepared, before);
    }
});

test('nonzero evidence stays eligible in both modes even when displayed coverage rounds to zero', () => {
    const models = [model(1, 1, { harness: 'a' }, { 10: 40 }), model(2, 2, { harness: 'a' }, { 10: 80 })];
    for (const mode of ['best', 'matched']) {
        const { range, available } = bothModes(models, weights([10, 0.00001], [11, 9999.99999]), { mode, keys: ['model'] });
        assert.ok(range.every(row => row.coverage === 0 && row.comparable));
        assert.deepEqual(available.map(row => row.lower), [40, 80]);
        assert.ok(available.every(row => row.comparable && row.availableInference.totalScore > 0));
    }
});
