import assert from 'node:assert/strict';
import test from 'node:test';
import { groupComparisonModels } from '../model-comparison.js';
import { matchingScoreConfigurations } from '../public/js/workspace/model-scores.js';

const fields = [
    { ID: 20, name: 'Reasoning effort', type: 'enum', excludeMissing: false, excludeEmpty: false,
        options: [{ ID: 1 }, { ID: 2 }, { ID: 3, excluded: true }] },
    { ID: 21, name: 'Harness', type: 'text', excludeMissing: false, excludeEmpty: false, options: [] },
    { ID: 22, name: 'Temperature', type: 'number', excludeMissing: true, excludeEmpty: true, options: [] },
    { ID: 23, name: 'Tools', type: 'presence', excludeMissing: false, excludeEmpty: false, options: [] }
];
const assignments = [
    [[20, 1], [21, 'Codex'], [22, '7e-1'], [23, null]],
    [[20, 1], [21, 'Other'], [22, '1e0']],
    [[20, 2], [21, 'Codex'], [22, '5e-1']],
    [[20, 3], [21, 'Codex']],
    [[20, null], [21, 'Codex']],
    [[21, 'Codex']],
    [[20, 1], [21, null]]
];
const index = [71, 72].flatMap(modelID => assignments.map((values, offset) => ({
    modelID, modelName: `Model ${modelID}`, scoreFields: values.map(([fieldID, value]) => ({ fieldID, value })),
    ID: modelID * 100 + offset
})));
const models = index.map(item => ({ ...item, name: item.modelName,
    condition: { scoreFields: item.scoreFields,
        parameters: Object.fromEntries(item.scoreFields.map(field => [`field:${field.fieldID}`, field.value])) },
    results: new Map() }));
const identity = item => JSON.stringify([item.modelID, item.scoreFields ?? item.condition.scoreFields]);

test('All scores uses the ranking group projection and filters for every comparison mode', () => {
    const scenarios = [
        { mode: 'best', keys: ['model'], filters: [] },
        { mode: 'best', keys: ['field:20', 'model'], filters: [] },
        { mode: 'best', keys: ['field:20', 'field:21', 'model'], filters: [] },
        { mode: 'best', keys: ['field:20'], filters: [] },
        { mode: 'best', keys: [], filters: [] },
        { mode: 'matched', keys: ['model', 'field:20'], filters: [] },
        { mode: 'matched', keys: ['field:22'], filters: [] },
        { mode: 'best', keys: ['model'], filters: [{ key: 'field:21', operator: 'eq', value: 'Codex' }] },
        { mode: 'best', keys: ['field:20'], filters: [{ key: 'field:23', operator: 'present' }] },
        { mode: 'best', keys: ['model'], filters: [{ key: 'field:20', operator: 'absent' }] },
        { mode: 'best', keys: ['model'], filters: [{ key: 'field:22', operator: 'gt', value: '6e-1' },
            { key: 'field:22', operator: 'lt', value: '2e0' }] }
    ];
    for (const scenario of scenarios) {
        const comparison = { ...scenario, fields };
        const groups = groupComparisonModels(models, comparison, []);
        assert.ok(groups.length, JSON.stringify(scenario));
        for (const group of groups) {
            const IDs = new Set(group.members.map(member => member.modelID));
            const actual = matchingScoreConfigurations(index.filter(item => IDs.has(item.modelID)), group, comparison).map(identity).sort();
            const expected = group.members.map(identity).sort();
            assert.deepEqual(actual, expected, `${JSON.stringify(scenario)} ${group.comparisonIdentity}`);
        }
    }
});

test('missing, empty and excluded parameter values do not leak between groups', () => {
    const comparison = { mode: 'best', keys: ['model', 'field:20'], fields, filters: [] };
    const groups = groupComparisonModels(models, comparison, []);
    const result = (present, value) => {
        const group = groups.find(item => item.comparisonIdentity === JSON.stringify([
            ['model', true, 71], ['field:20', present, value]
        ]));
        return matchingScoreConfigurations(index.filter(item => item.modelID === 71), group, comparison);
    };
    assert.deepEqual(result(false, null).map(item => item.ID), [7105]);
    assert.deepEqual(result(true, null).map(item => item.ID), [7104]);
    assert.deepEqual(result(true, 1).map(item => item.ID), [7100, 7101, 7106]);
    assert.equal(groups.some(item => item.comparisonIdentity.includes('["field:20",true,3]')), false);
});

test('ungrouped models derive their projection from their own recorded assignments', () => {
    const model = models[0];
    const comparison = { mode: 'best', keys: ['model', 'field:20', 'field:21'], fields, filters: [] };
    assert.deepEqual(matchingScoreConfigurations(index, model, comparison).map(item => item.ID), [7100]);
    assert.equal(index.length, 14, 'Filtering does not mutate the cached index');
});
