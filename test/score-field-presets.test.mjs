import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptRunAssignments, adaptRunComparison, pinnedScoreFields, runFieldIcon, sortScoreFields } from '../public/js/shared/score-field-presets.js';
import { normalizeScoreFields } from '../public/js/shared/score-fields.js';
import { quickComparisonFields } from '../public/js/workspace/comparison-settings.js';
import { runConfigurationFields } from '../model-run-configuration.js';
import { comparisonOptions } from '../model-comparison.js';

const fields = [
    { ID: 1, name: 'Harness', type: 'enum', allowEmpty: false, options: [{ ID: 100, label: 'Claude Code' }] },
    { ID: 20, name: 'Effort', type: 'enum', allowEmpty: false, options: [{ ID: 3, label: 'high' }, { ID: 101, label: 'HD' }],
        legacyFields: [{ ID: 9, name: 'Image quality preset', type: 'text' }] },
    { ID: 2, name: 'Harness version', type: 'text', allowEmpty: false, options: [] },
    { ID: 33, name: 'Temperature', type: 'number', allowEmpty: false, options: [] }
];
test('Effort and Harness are the first optional pinned score fields with dedicated icons', () => {
    assert.deepEqual(sortScoreFields(fields).slice(0, 2).map(field => field.ID), [20, 1]);
    assert.deepEqual(pinnedScoreFields(fields).map(field => field.ID), [20, 1]);
    assert.equal(runFieldIcon(fields[1]), 'fa-brain'); assert.equal(runFieldIcon(fields[0]), 'fa-puzzle-piece');
    assert.deepEqual(quickComparisonFields(fields, ['field:20', 'field:1']), { reasoning: 'field:20', harness: 'field:1' });
});
test('pending or secondary alias definitions cannot replace the canonical pinned fields', () => {
    const pending = [fields[0], fields[1]].map(field => ({ ...field, ID: null, requestID: 999, pending: true }));
    const legacyAliases = [{ ...fields[0], ID: 80, name: 'Agent harness' }, { ...fields[1], ID: 81, name: 'Reasoning effort' }];
    assert.deepEqual(pinnedScoreFields([...pending, ...legacyAliases, ...fields]).map(field => field.ID), [20, 1]);
    assert.deepEqual(pinnedScoreFields(pending), []);
});
test('approved legacy labels and duplicate equal quality/effort values adapt without changing other fields', () => {
    const input = [{ fieldID: 9, value: 'high' }, { fieldID: 20, value: 3 }, { fieldID: 1, value: 'claude code' }, { fieldID: 2, value: '2.1.0' }];
    const result = adaptRunAssignments(input, fields);
    assert.deepEqual(result, [{ fieldID: 20, value: 3 }, { fieldID: 1, value: 100 }, { fieldID: 2, value: '2.1.0' }]);
    assert.equal(input[0].fieldID, 9); assert.equal(input[2].value, 'claude code');
    assert.deepEqual(normalizeScoreFields(result, fields).map(item => item.fieldID), [1, 2, 20]);
    assert.deepEqual(adaptRunAssignments([{ fieldID: 9, value: 'HD' }], fields), [{ fieldID: 20, value: 101 }]);
});
test('unknown presets, ordinary duplicate fields and conflicting legacy values are not silently accepted', () => {
    assert.throws(() => normalizeScoreFields(adaptRunAssignments([{ fieldID: 1, value: 'Unknown' }], fields), fields));
    assert.throws(() => normalizeScoreFields(adaptRunAssignments([{ fieldID: 20, value: 3 }, { fieldID: 20, value: 3 }], fields), fields));
    assert.throws(() => adaptRunAssignments([{ fieldID: 20, value: 3 }, { fieldID: 9, value: 'HD' }], fields));
    assert.throws(() => normalizeScoreFields(adaptRunAssignments([null, { fieldID: 1, value: 'Claude Code' }], fields), fields));
});
test('only identical legacy proposals or references collapse; distinct pending values never disappear', () => {
    for (const [left, right] of [[{ newOption: 'Custom A' }, { newOption: 'Custom B' }],
        [{ optionRequestID: 91 }, { optionRequestID: 92 }], [{ value: 3 }, { value: 3, newOption: 'extra' }]]) {
        assert.throws(() => adaptRunAssignments([{ fieldID: 9, ...left }, { fieldID: 20, ...right }], fields));
    }
    assert.deepEqual(adaptRunAssignments([{ fieldID: 9, newOption: 'Custom A' }, { fieldID: 20, newOption: 'Custom A' }], fields),
        [{ fieldID: 20, newOption: 'Custom A' }]);
});
test('saved legacy comparisons keep their meaning and arbitrary duplicates remain visible to validation', () => {
    const result = adaptRunComparison({ mode: 'best', keys: ['model', 'field:9', 'field:20'],
        filters: [{ key: 'field:9', operator: 'eq', value: 'high' }, { key: 'field:20', operator: 'eq', value: 3 }, { key: 'field:1', operator: 'eq', value: 'Claude Code' }] }, fields);
    assert.deepEqual(result.keys, ['model', 'field:20']);
    assert.deepEqual(result.filters, [{ key: 'field:20', operator: 'eq', value: 3 }, { key: 'field:1', operator: 'eq', value: 100 }]);
    assert.deepEqual(adaptRunComparison({ keys: ['model', 'model'], filters: [{ key: 'model', operator: 'eq', value: 1 }, { key: 'model', operator: 'eq', value: 1 }] }, fields),
        { keys: ['model', 'model'], filters: [{ key: 'model', operator: 'eq', value: 1 }, { key: 'model', operator: 'eq', value: 1 }] });
});
test('model-name import assignments support the canonical enum names', () => {
    assert.deepEqual(runConfigurationFields({ reasoningEffort: 'high', agentHarness: 'Claude Code' }, fields), [{ fieldID: 1, value: 100 }, { fieldID: 20, value: 3 }]);
});
test('malformed comparisons remain validation errors instead of adapter exceptions', () => {
    for (const input of [[], { mode: 'best', keys: { map: 'bad' } },
        ...[null, 'bad', [], 7].map(filter => ({ mode: 'best', keys: ['model'], filters: [filter] }))]) {
        assert.doesNotThrow(() => adaptRunComparison(input, fields));
        assert.throws(() => comparisonOptions([], input, fields), error => error.status === 400 && typeof error.body.error === 'string');
    }
});
