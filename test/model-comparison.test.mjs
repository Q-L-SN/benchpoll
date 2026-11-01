import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeModelParameters, modelParameterLabel, parameterRowsToObject } from '../public/js/shared/model-parameters.js';
import { comparisonOptions, groupComparisonModels } from '../model-comparison.js';
import { scoreComparison } from '../ranking-service.js';
import { quickComparisonFields } from '../public/js/workspace/comparison-settings.js';

const model = (ID, modelID, parameters, scores = { 10: 50 }) => ({ ID, modelID, modelName: `Model ${modelID}`,
    name: `Model ${modelID} / ${ID}`, condition: { ID, parameters },
    results: new Map(Object.entries(scores).map(([key, normalizedScore]) => [key, { normalizedScore }])) });
const weights = [{ conditionID: 10, weightBasisPoints: 10000 }];
const group = (models, keys, mode = 'best', entries = weights) => groupComparisonModels(models, comparisonOptions(models, { keys, mode }), entries);

const harnessField = { ID: 1, name: 'Harness', type: 'enum', allowEmpty: true, excludeMissing: true,
    excludeEmpty: true, options: [{ ID: 11, label: 'A', excluded: false }, { ID: 12, label: 'Excluded', excluded: true }] };

test('fair eligibility is scoped to each weighted benchmark, not the global field union', () => {
    const models = [model(1, 1, {}), model(2, 2, {}), model(3, 3, { 'field:1': 11 }, { 20: 90 })];
    const options = comparisonOptions(models, { mode: 'matched', keys: ['model'] }, [harnessField]);
    const grouped = groupComparisonModels(models, options, [...weights, { conditionID: 20, weightBasisPoints: 10000 }]);
    assert.deepEqual(grouped.slice(0, 2).map(item => item.results.get('10').normalizedScore), [50, 50]);
    assert.equal(grouped[2].results.size, 0);
    assert.deepEqual(scoreComparison(models, weights, 10000, { scoreMode: 'range' }, options).slice(0, 2).map(item => item.lower), [50, 50]);
});

test('matched mode honors missing, empty and excluded-option policies for selected fields', () => {
    const models = [model(1, 1, {}), model(2, 2, { 'field:1': null }),
        model(3, 3, { 'field:1': 12 }), model(4, 4, { 'field:1': 11 }), model(5, 5, { 'field:1': 11 })];
    const options = comparisonOptions(models, { mode: 'matched', keys: ['model', 'field:1'] }, [harnessField]);
    assert.deepEqual(groupComparisonModels(models, options, weights).map(item => item.modelID), [4, 5]);
    const best = comparisonOptions(models, { mode: 'best', keys: ['model', 'field:1'] }, [harnessField]);
    assert.deepEqual(groupComparisonModels(models, best, weights).map(item => item.modelID), [1, 2, 4, 5]);
    const ignored = comparisonOptions(models, { mode: 'best', keys: ['model'] }, [harnessField]);
    assert.equal(groupComparisonModels(models, ignored, weights).length, 5);
});

test('quick effort and harness comparisons retain every missing-value run in both scoring modes', () => {
    const fields = [
        { ID: 1, name: 'Agent harness', type: 'text', allowEmpty: true, excludeMissing: true, excludeEmpty: true, options: [] },
        { ID: 2, name: 'Reasoning effort', type: 'text', allowEmpty: true, excludeMissing: true, excludeEmpty: true, options: [] }
    ];
    const models = [
        model(1, 1, { 'field:1': 'A', 'field:2': 'high' }, { 10: 90, 11: 20 }),
        model(2, 1, { 'field:1': 'A', 'field:2': 'high' }, { 10: 70, 11: 80 }),
        model(3, 1, { 'field:2': 'high' }, { 10: 85 }),
        model(4, 1, { 'field:1': 'A' }, { 10: 60 }),
        model(5, 2, null, { 10: 65 }),
        model(6, 1, {}, { 10: 30 }),
        model(7, 1, { 'field:1': null, 'field:2': null }, { 10: 75 }),
        model(8, 1, { 'field:1': 'Not recorded', 'field:2': 'high' }, { 10: 55 })
    ];
    const quick = quickComparisonFields(fields, comparisonOptions(models, null, fields).availableKeys);
    const entries = [{ conditionID: 10, weightBasisPoints: 5000 }, { conditionID: 11, weightBasisPoints: 5000 }];
    for (const [keys, count] of [
        [['model'], 2], [['model', quick.reasoning], 4], [['model', quick.harness], 5],
        [['model', quick.reasoning, quick.harness], 7]
    ]) {
        const options = comparisonOptions(models, { mode: 'best', keys }, fields);
        for (const scoreMode of ['range', 'available']) {
            const ranked = scoreComparison(models, entries, 10000, { scoreMode }, options);
            assert.equal(ranked.length, count);
            assert.ok(ranked.every(entry => entry.comparable));
            assert.deepEqual(ranked.flatMap(entry => entry.members.map(member => member.ID)).sort((a, b) => a - b),
                models.map(entry => entry.ID));
            const unknownModel = ranked.find(entry => entry.modelID === 2);
            assert.equal(unknownModel.calculationScores[0].normalizedScore, 65);
            assert.equal(unknownModel.coverage, 50);
        }
    }
    const separate = groupComparisonModels(models,
        comparisonOptions(models, { mode: 'best', keys: ['model', quick.reasoning, quick.harness] }, fields), entries);
    assert.equal(new Set(separate.map(entry => entry.comparisonIdentity)).size, 7);
    assert.deepEqual(separate.find(entry => entry.members.length === 2).comparisonScores.map(score => score.memberIDs), [[1], [2]]);
    assert.equal(separate.find(entry => entry.members[0].ID === 5).name,
        'Agent harness=Not recorded / Reasoning effort=Not recorded / Model 2');
    const limit = comparisonOptions(models, { mode: 'best', keys: ['model', quick.harness],
        filters: [{ key: quick.harness, operator: 'eq', value: 'A' }] }, fields);
    assert.deepEqual(groupComparisonModels(models, limit, entries).flatMap(entry => entry.members.map(member => member.ID)), [1, 2, 4]);
});

test('parameters canonicalize keys and retain values without inferring types', () => {
    assert.deepEqual(normalizeModelParameters({ 'Thinking effort': ' high ', harness: 'V2' }), { harness: 'V2', thinking_effort: 'high' });
    assert.equal(modelParameterLabel({}), 'default');
    assert.equal(modelParameterLabel(null, 81), 'Unconfigured #81');
    assert.throws(() => normalizeModelParameters({ model: 'GPT' }), /invalid_model_parameter_key/);
    assert.throws(() => normalizeModelParameters({ budget: 100 }), /invalid_model_parameter_value/);
    assert.throws(() => normalizeModelParameters({ budget: '' }), /invalid_model_parameter_value/);
    assert.throws(() => normalizeModelParameters(undefined), /model_parameters_required/);
    assert.throws(() => parameterRowsToObject([{ key: 'Thinking effort', value: 'high' }, { key: 'thinking_effort', value: 'low' }]), /duplicate_model_parameter_key/);
    assert.throws(() => normalizeModelParameters(JSON.parse('{"__proto__":"x"}')), /invalid_model_parameter_key/);
});

test('default compares model only and ignores optional score fields', () => {
    const models = [model(1, 1, { effort: 'high', harness: 'a' }), model(2, 1, { effort: 'low', harness: 'b' })];
    const options = comparisonOptions(models);
    assert.deepEqual(options.keys, ['model']);
    assert.equal(groupComparisonModels(models, options, weights).length, 1);
    assert.throws(() => comparisonOptions(models, { mode: 'best', keys: ['unknown'] }));
    assert.throws(() => comparisonOptions(models, { mode: 'best', keys: ['model', 'model'] }));
});

test('ignore mode takes best normalized per-benchmark configuration, not best total', () => {
    const models = [model(1, 1, { effort: 'high' }, { 10: 90, 11: -20 }), model(2, 1, { effort: 'low' }, { 10: 30, 11: 120 })];
    const [combined] = group(models, ['model']);
    assert.equal(combined.results.get('10').normalizedScore, 90);
    assert.equal(combined.results.get('11').normalizedScore, 120);
    assert.deepEqual(combined.comparisonScores.map(score => score.memberIDs), [[1], [2]]);
    assert.equal(combined.members.length, 2);
});

test('best aggregation visits recorded scores and retains all tied winning configurations', () => {
    const models = [
        model(1, 1, { effort: 'high' }, { 11: 30, 10: 90 }),
        model(2, 1, { effort: 'low' }, { 10: 90, 11: 80 }),
        model(3, 1, { effort: 'medium' }, { 10: 70 })
    ];
    const [combined] = group(models, ['model']);
    assert.deepEqual(combined.comparisonScores.map(score => [score.conditionID, score.normalizedScore, score.memberIDs]), [
        [10, 90, [1, 2]], [11, 80, [2]]
    ]);
    assert.equal(combined.results.get('10').normalizedScore, 90);
    assert.equal(combined.results.get('11').normalizedScore, 80);
});

test('checking a field in best mode preserves it and ignores unchecked fields', () => {
    const models = [model(1, 1, { harness: 'a' }, { 10: 10 }), model(2, 2, { harness: 'a' }, { 10: 80 }), model(3, 2, { harness: 'b' }, { 10: 30 })];
    const grouped = group(models, ['model']);
    assert.equal(grouped.length, 2);
    assert.deepEqual(grouped.map(item => item.results.get('10').normalizedScore), [10, 80]);
    assert.equal(group(models, ['model', 'harness']).length, 3);
    assert.equal(group(models, ['harness']).length, 2);
});

test('matched mode requires an explicitly selected comparison key even with no models', () => {
    for (const models of [[], [model(1, 1, {})]]) {
        assert.throws(() => comparisonOptions(models, { mode: 'matched', keys: [] }), error => error.status === 400 && error.body.error === 'comparison_key_required');
    }
});

test('model key can be ignored to compare harnesses with model held fixed', () => {
    const models = [model(1, 1, { harness: 'a' }, { 10: 60 }), model(2, 1, { harness: 'b' }, { 10: 70 }),
        model(3, 2, { harness: 'a' }, { 10: 100 })];
    const groups = group(models, ['harness'], 'matched');
    assert.deepEqual(groups.map(item => item.results.get('10').normalizedScore), [60, 70]);
    assert.ok(groups.every(item => item.comparable));
});

test('matching requires complete tuples, not independent per-key overlaps', () => {
    const models = [model(1, 1, { effort: 'high', harness: 'a' }), model(2, 1, { effort: 'low', harness: 'b' }),
        model(3, 2, { effort: 'high', harness: 'b' }), model(4, 2, { effort: 'low', harness: 'a' })];
    assert.ok(group(models, ['model'], 'matched').every(item => !item.comparable && item.results.size === 0));
});

test('matching chooses one strict cohort rather than combining incompatible pairwise overlaps', () => {
    const models = [model(1, 1, { harness: 'a' }), model(2, 1, { harness: 'b' }), model(3, 2, { harness: 'b' }),
        model(4, 2, { harness: 'c' }), model(5, 3, { harness: 'a' }), model(6, 3, { harness: 'c' })];
    const groups = group(models, ['model'], 'matched');
    assert.deepEqual(groups.map(item => item.comparable), [true, true, false]);
    assert.deepEqual(groups.slice(0, 2).map(item => item.comparisonScores[0].memberIDs), [[2], [3]]);
    assert.equal(groups[2].results.size, 0);
});

test('matched configurations have equal weight and missing benchmarks do not invalidate observed evidence', () => {
    const models = [model(1, 1, { harness: 'a' }, { 10: 20 }), model(2, 1, { harness: 'b' }, { 10: 100 }),
        model(3, 2, { harness: 'a' }, { 10: 40 }), model(4, 2, { harness: 'b' }, { 10: 60 })];
    assert.deepEqual(group(models, ['model'], 'matched').map(item => item.results.get('10').normalizedScore), [60, 50]);
    assert.ok(group(models, ['model'], 'matched', [...weights, { conditionID: 11, weightBasisPoints: 1 }]).every(item => item.comparable));
    assert.ok(group(models, ['model'], 'matched', []).every(item => !item.comparable));
    assert.ok(group(models, ['model'], 'matched', [...weights, { conditionID: 11, weightBasisPoints: 0 }]).every(item => item.comparable));
});

test('unconfigured or missing fields never establish matching conditions', () => {
    assert.ok(group([model(1, 1, null), model(2, 2, null)], ['model'], 'matched').every(item => !item.comparable));
    const models = [model(1, 1, { effort: 'high' }), model(2, 2, { effort: 'high' }), model(3, 3, {})];
    assert.deepEqual(group(models, ['model'], 'matched').map(item => item.comparable), [true, true, false]);
    assert.equal(group([model(1, 1, null), model(2, 1, null, { 10: 80 })], [])[0].results.get('10').normalizedScore, 80);
});

test('matched totals are null without matching evidence and do not use fallback', () => {
    const models = [model(1, 1, { harness: 'a' }, { 20: 70 }), model(2, 2, { harness: 'a' }, { 20: 90 })];
    const rules = { fallbackRules: [{ primaryConditionID: 10, mode: 'ordered', entries: [{ conditionID: 20 }] }] };
    const best = scoreComparison(models, weights, 10000, rules, comparisonOptions(models));
    assert.deepEqual(best.map(item => item.lower), [70, 90]);
    const matched = scoreComparison(models, weights, 10000, rules, comparisonOptions(models, { keys: ['model'], mode: 'matched' }));
    assert.ok(matched.every(item => item.lower === null && item.upper === null && item.fallbackUsageCount === 0));
});

test('matched comparison can use the same observed subset without inventing missing results', () => {
    const models = [model(1, 1, { harness: 'a' }, { 10: 40 }), model(2, 2, { harness: 'a' }, { 10: 80 })];
    const entries = [...weights, { conditionID: 11, weightBasisPoints: 10000 }];
    const options = comparisonOptions(models, { keys: ['model'], mode: 'matched' });
    const ranked = scoreComparison(models, entries, 20000, { scoreMode: 'available' }, options);
    assert.deepEqual(ranked.map(item => [item.lower, item.upper, item.coverage, item.comparable]), [
        [33.33, 33.33, 50, true], [66.67, 66.67, 50, true]
    ]);
    assert.ok(ranked.every(row => row.inferredScores.length === 0 && row.availableInference.unresolvedFraction === .5));
    const missing = scoreComparison([model(3, 3, { harness: 'a' }, {})], weights, 10000,
        { scoreMode: 'available' }, comparisonOptions([model(3, 3, { harness: 'a' }, {})]));
    assert.deepEqual([missing[0].lower, missing[0].upper, missing[0].comparable], [null, null, false]);
});

test('very small but nonzero public evidence is still comparable after rounded coverage reaches zero', () => {
    const models = [model(1, 1, {}, { 10: 100 })];
    const entries = [{ conditionID: 10, weightBasisPoints: 0.00001 }, { conditionID: 11, weightBasisPoints: 9999.99999 }];
    const [ranked] = scoreComparison(models, entries, 10000, { scoreMode: 'available' }, comparisonOptions(models));
    assert.equal(ranked.coverage, 0);
    assert.equal(ranked.lower, 0);
    assert.ok(ranked.availableInference.coverageFraction > 0 && ranked.availableInference.totalScore > 0);
    assert.equal(ranked.availableInference.observedScore, 100);
    assert.equal(ranked.comparable, true);
});

test('unavailable comparison keys fail explicitly and return the current key catalog', () => {
    const models = [model(1, 1, { runner: 'a' })];
    assert.throws(() => comparisonOptions(models, { mode: 'best', keys: ['harness'] }), error => {
        assert.equal(error.status, 400);
        assert.deepEqual(error.body, { error: 'comparison_keys_unavailable', availableKeys: ['model', 'runner'], unconfiguredCount: 0 });
        return true;
    });
});

test('unconfigured and missing comparison keys do not block eligible harness comparisons', () => {
    const models = [model(1, 1, { harness: 'a' }, { 10: 60 }), model(2, 1, { harness: 'b' }, { 10: 70 }),
        model(3, 2, null, { 10: 90 }), model(4, 3, { effort: 'high' }, { 10: 100 })];
    const groups = group(models, ['harness'], 'matched');
    assert.deepEqual(groups.slice(0, 2).map(item => item.results.get('10').normalizedScore), [60, 70]);
    assert.ok(groups.slice(0, 2).every(item => item.comparable));
    assert.ok(groups.slice(2).every(item => !item.comparable && item.results.size === 0));
});

test('unscored models and their extra parameter keys do not change matching evidence', () => {
    const models = [model(1, 1, { harness: 'a' }, { 10: 60 }), model(2, 1, { harness: 'b' }, { 10: 70 }),
        model(3, 3, { harness: 'a', temperature: '0.7' }, {}), model(4, 4, { harness: 'c' }, {})];
    const groups = group(models, ['harness'], 'matched');
    assert.deepEqual(groups.slice(0, 2).map(item => item.results.get('10').normalizedScore), [60, 70]);
    assert.equal(groups[2].comparable, false);
});

test('a missing control never matches an explicitly recorded control value', () => {
    const models = [model(1, 1, { harness: 'a' }), model(2, 1, { harness: 'b', temperature: '0.7' })];
    assert.ok(group(models, ['harness'], 'matched').every(item => !item.comparable));
});
