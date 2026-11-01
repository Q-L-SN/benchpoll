import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultComparison, quickComparisonFields, readComparisonSettings, writeComparisonSettings } from '../public/js/workspace/comparison-settings.js';
import { comparisonDisplayParts } from '../public/js/shared/comparison-display.js';

const storage = () => {
    const values = new Map();
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};
const fields = [
    { ID: 2, name: 'Agent harness version', type: 'text' },
    { ID: 19, name: 'Reasoning budget tokens', type: 'number' },
    { ID: 20, name: 'Reasoning effort', type: 'enum', options: [{ ID: 201, label: 'high' }] },
    { ID: 23, name: 'Reported reasoning effort', type: 'text' },
    { ID: 1, name: 'Agent harness', type: 'text' }
];

test('new comparison settings default to best performance, Model only, experiment off', () => {
    assert.deepEqual(readComparisonSettings('1', storage()), { experimental: false, basic: defaultComparison() });
});
test('basic comparison cannot inherit advanced modes or value limits', () => {
    const target = storage();
    writeComparisonSettings({ experimental: false, basic: { mode: 'matched', keys: ['model', 'field:20'], filters: [{ key: 'model', operator: 'eq', value: 99 }] } }, '1', target);
    assert.deepEqual(readComparisonSettings('1', target), { experimental: false, basic: { mode: 'best', keys: ['model', 'field:20'], filters: [] } });
    writeComparisonSettings({ basic: { keys: ['field:1'] } }, '1', target);
    assert.deepEqual(readComparisonSettings('1', target).basic, defaultComparison());
});
test('experiment and basic selections are isolated between accounts and guest cannot opt in', () => {
    const target = storage();
    writeComparisonSettings({ experimental: true, basic: { keys: ['model', 'field:1'] } }, '1', target);
    assert.equal(readComparisonSettings('1', target).experimental, true);
    assert.equal(readComparisonSettings('2', target).experimental, false);
    writeComparisonSettings({ experimental: true, basic: { keys: ['model', 'field:20'] } }, null, target);
    assert.equal(readComparisonSettings(null, target).experimental, false);
    assert.deepEqual(readComparisonSettings(null, target).basic.keys, ['model', 'field:20']);
});
test('corrupt or unavailable storage recovers to standard comparison', () => {
    const broken = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
    assert.deepEqual(readComparisonSettings('1', broken), { experimental: false, basic: defaultComparison() });
    assert.equal(writeComparisonSettings({}, '1', broken), false);
});
test('quick comparison resolves only effort and harness names, never budgets or versions', () => {
    const keys = fields.map(field => `field:${field.ID}`);
    assert.deepEqual(quickComparisonFields(fields, keys), { reasoning: 'field:20', harness: 'field:1' });
    assert.deepEqual(quickComparisonFields(fields, ['field:2', 'field:19', 'field:23']), { reasoning: null, harness: null });
    assert.deepEqual(quickComparisonFields([{ ID: 7, name: 'thinking_effort' }, { ID: 8, name: 'Harness' }], ['field:7', 'field:8']), { reasoning: 'field:7', harness: 'field:8' });
});
test('display puts the canonical model first and shows compact icon-led values', () => {
    const model = { name: 'A long old label / reasoning_effort=high', modelID: 301,
        comparisonIdentity: JSON.stringify([['field:1', true, 'Agent X'], ['field:20', true, 201], ['model', true, 301]]) };
    const comparison = { keys: ['field:1', 'field:20', 'model'], fields, models: [{ ID: 301, name: 'Aster Pro' }] };
    const parts = comparisonDisplayParts(model, comparison);
    assert.deepEqual(parts.map(part => part.text), ['Aster Pro', 'Agent X', 'high']);
    assert.equal(parts[0].icon, undefined);
    assert.equal(parts[1].icon, 'fa-puzzle-piece');
    assert.equal(parts[2].icon, 'fa-brain');
    assert.equal(parts[2].title, 'Reasoning effort: high');
    assert.deepEqual(comparisonDisplayParts(model, { ...comparison, keys: ['field:20'] }).map(part => part.text), ['high']);
});
test('ungrouped configuration evidence uses structured assignments, not the raw label', () => {
    const model = { name: 'Legacy name with raw configuration', modelName: 'Aster Pro', modelID: 301,
        condition: { scoreFields: [{ fieldID: 20, value: 201 }] } };
    assert.deepEqual(comparisonDisplayParts(model, { keys: ['model', 'field:20', 'field:1'], fields }).map(part => part.text), ['Aster Pro', 'high', 'Not recorded']);
});
