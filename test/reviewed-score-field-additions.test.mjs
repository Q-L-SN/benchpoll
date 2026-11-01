import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewedFieldAdditions, reviewedResultFieldAdditions, combinedReviewedFieldAdditions,
    extendReviewedScoreFields } from '../scripts/reviewed-score-field-additions.mjs';

const catalog = [
    { ID: 8, name: 'Generation mode', type: 'text', allowEmpty: false },
    { ID: 12, name: 'Max output tokens', type: 'number', allowEmpty: false }
];
const plan = { groups: [{ targetID: 10, sourceIDs: [11, 12], sourceFieldAdditions: [] }] };

test('reviewed additions apply to retained targets as well as removed conditions', () => {
    const map = reviewedFieldAdditions({ expectedFieldNames: { 8: 'Generation mode' },
        conditionFieldAdditions: [
            { conditionID: 10, entries: [{ fieldID: 8, value: 'single prompt' }] },
            { conditionID: 11, entries: [{ fieldID: 8, value: 'multi-scene' }] }
        ] }, plan, catalog);
    assert.equal(map.get(10)[0].value, 'single prompt');
    assert.equal(map.get(11)[0].value, 'multi-scene');
});

test('unreviewed conditions, duplicate declarations and changed field identities fail', () => {
    assert.throws(() => reviewedFieldAdditions({ conditionFieldAdditions: [
        { conditionID: 99, entries: [{ fieldID: 8, value: 'single prompt' }] }
    ] }, plan, catalog), /unreviewed/);
    assert.throws(() => reviewedFieldAdditions({ conditionFieldAdditions: [
        { conditionID: 10, entries: [{ fieldID: 8, value: 'a' }] },
        { conditionID: 10, entries: [{ fieldID: 8, value: 'a' }] }
    ] }, plan, catalog), /Duplicate/);
    assert.throws(() => reviewedFieldAdditions({ expectedFieldNames: { 8: 'Other field' } }, plan, catalog), /expected name/);
});

test('numeric values are compared canonically and existing equivalent values are not rewritten', () => {
    assert.equal(extendReviewedScoreFields([{ fieldID: 12, value: '8192e1' }],
        [{ fieldID: 12, value: 81920 }], catalog, 1), null);
});

test('adding a reviewed configuration never overrides a conflicting existing value', () => {
    assert.throws(() => extendReviewedScoreFields([{ fieldID: 8, value: 'single prompt' }],
        [{ fieldID: 8, value: 'multi-scene' }], catalog, 123), /Conflicting.*123/);
});

test('unrelated existing assignments survive a new field addition', () => {
    assert.deepEqual(extendReviewedScoreFields([{ fieldID: 12, value: '8192e1' }],
        [{ fieldID: 8, value: 'single prompt' }], catalog, 1), [
        { fieldID: 8, value: 'single prompt' }, { fieldID: 12, value: '8192e1' }
    ]);
});

test('result-specific declarations preserve their precise result and condition scope', () => {
    const additions = reviewedResultFieldAdditions({ resultFieldAdditions: [
        { resultID: 101, conditionID: 10, entries: [{ fieldID: 8, value: 'internal run' }] },
        { resultID: 102, conditionID: 10, entries: [{ fieldID: 8, value: 'provider self-report' }] }
    ] }, plan, catalog);
    assert.equal(additions.get(101).conditionID, 10);
    assert.equal(additions.get(101).entries[0].value, 'internal run');
    assert.equal(additions.get(102).entries[0].value, 'provider self-report');
    assert.equal(additions.has(103), false);
});

test('result-specific declarations reject duplicates, empty entries and unreviewed conditions', () => {
    const item = { resultID: 101, conditionID: 10, entries: [{ fieldID: 8, value: 'a' }] };
    for (const entries of [[item, item], [{ ...item, conditionID: 99 }],
        [{ ...item, resultID: 0 }], [{ ...item, entries: [] }]]) {
        assert.throws(() => reviewedResultFieldAdditions({ resultFieldAdditions: entries }, plan, catalog), /declaration/);
    }
    assert.throws(() => reviewedResultFieldAdditions({ resultFieldAdditions: {} }, plan, catalog), /array/);
});

test('combining reviewed scopes permits identical values but rejects contradictory settings', () => {
    assert.deepEqual(combinedReviewedFieldAdditions([{ fieldID: 12, value: '8192e1' }],
        [{ fieldID: 12, value: 81920 }, { fieldID: 8, value: 'a' }], catalog), [
        { fieldID: 8, value: 'a' }, { fieldID: 12, value: '8192e1' }
    ]);
    assert.deepEqual(combinedReviewedFieldAdditions(undefined, undefined, catalog), []);
    assert.throws(() => combinedReviewedFieldAdditions([{ fieldID: 8, value: 'a' }],
        [{ fieldID: 8, value: 'b' }], catalog), /Conflicting/);
});
