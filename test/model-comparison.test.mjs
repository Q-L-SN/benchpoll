import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeModelParameters, modelParameterLabel, parameterRowsToObject } from '../public/js/shared/model-parameters.js';
import { comparisonOptions, groupComparisonModels } from '../model-comparison.js';
import { scoreComparison } from '../ranking-service.js';

const model = (ID, modelID, parameters, scores = { 10: 50 }) => ({ ID, modelID, modelName: `Model ${modelID}`,
    name: `Model ${modelID} / ${ID}`, condition: { ID, parameters },
    results: new Map(Object.entries(scores).map(([key, normalizedScore]) => [key, { normalizedScore }])) });
const weights = [{ conditionID: 10, weightBasisPoints: 10000 }];
const group = (models, keys, mode = 'best', entries = weights) => groupComparisonModels(models, comparisonOptions(models, { keys, mode }), entries);

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

test('default selection is empty and ignores no keys', () => {
    const models = [model(1, 1, { effort: 'high', harness: 'a' }), model(2, 1, { effort: 'low', harness: 'b' })];
    const options = comparisonOptions(models);
    assert.deepEqual(options.keys, []);
    assert.equal(groupComparisonModels(models, options, weights).length, 2);
    assert.throws(() => comparisonOptions(models, { mode: 'best', keys: ['unknown'] }));
    assert.throws(() => comparisonOptions(models, { mode: 'best', keys: ['model', 'model'] }));
});

test('ignore mode takes best normalized per-benchmark configuration, not best total', () => {
    const models = [model(1, 1, { effort: 'high' }, { 10: 90, 11: -20 }), model(2, 1, { effort: 'low' }, { 10: 30, 11: 120 })];
    const [combined] = group(models, ['effort']);
    assert.equal(combined.results.get('10').normalizedScore, 90);
    assert.equal(combined.results.get('11').normalizedScore, 120);
    assert.deepEqual(combined.comparisonScores.map(score => score.memberIDs), [[1], [2]]);
    assert.equal(combined.members.length, 2);
});

test('checking model in best mode merges models but preserves unselected harness', () => {
    const models = [model(1, 1, { harness: 'a' }, { 10: 10 }), model(2, 2, { harness: 'a' }, { 10: 80 }), model(3, 2, { harness: 'b' }, { 10: 30 })];
    const grouped = group(models, ['model']);
    assert.equal(grouped.length, 2);
    assert.deepEqual(grouped.map(item => item.results.get('10').normalizedScore), [80, 30]);
    assert.equal(group(models, ['model', 'harness']).length, 1);
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

test('matching uses global intersection rather than incompatible pairwise overlaps', () => {
    const models = [model(1, 1, { harness: 'a' }), model(2, 1, { harness: 'b' }), model(3, 2, { harness: 'b' }),
        model(4, 2, { harness: 'c' }), model(5, 3, { harness: 'a' }), model(6, 3, { harness: 'c' })];
    assert.ok(group(models, ['model'], 'matched').every(item => !item.comparable));
});

test('matched configurations have equal weight and missing weighted benchmarks invalidate totals', () => {
    const models = [model(1, 1, { harness: 'a' }, { 10: 20 }), model(2, 1, { harness: 'b' }, { 10: 100 }),
        model(3, 2, { harness: 'a' }, { 10: 40 }), model(4, 2, { harness: 'b' }, { 10: 60 })];
    assert.deepEqual(group(models, ['model'], 'matched').map(item => item.results.get('10').normalizedScore), [60, 50]);
    assert.ok(group(models, ['model'], 'matched', [...weights, { conditionID: 11, weightBasisPoints: 1 }]).every(item => !item.comparable));
    assert.ok(group(models, ['model'], 'matched', []).every(item => !item.comparable));
    assert.ok(group(models, ['model'], 'matched', [...weights, { conditionID: 11, weightBasisPoints: 0 }]).every(item => item.comparable));
});

test('unconfigured or missing fields never establish matching conditions', () => {
    assert.ok(group([model(1, 1, null), model(2, 2, null)], ['model'], 'matched').every(item => !item.comparable));
    const models = [model(1, 1, { effort: 'high' }), model(2, 2, { effort: 'high' }), model(3, 3, {})];
    assert.ok(group(models, ['model'], 'matched').every(item => !item.comparable));
    assert.equal(group([model(1, 1, null), model(2, 1, null, { 10: 80 })], [])[0].results.get('10').normalizedScore, 80);
});

test('matched totals are null without matching evidence and do not use fallback', () => {
    const models = [model(1, 1, { harness: 'a' }, { 20: 70 }), model(2, 2, { harness: 'a' }, { 20: 90 })];
    const rules = { fallbackRules: [{ primaryConditionID: 10, mode: 'fallback_if_missing', entries: [{ conditionID: 20, weightBasisPoints: 10000 }] }] };
    const best = scoreComparison(models, weights, 10000, rules, comparisonOptions(models));
    assert.deepEqual(best.map(item => item.lower), [70, 90]);
    const matched = scoreComparison(models, weights, 10000, rules, comparisonOptions(models, { keys: ['model'], mode: 'matched' }));
    assert.ok(matched.every(item => item.lower === null && item.upper === null && item.fallbackUsageCount === 0));
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
