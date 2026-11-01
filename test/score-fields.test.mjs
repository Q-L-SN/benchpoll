import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalNumber, compareCanonicalNumbers, normalizeFieldDefinition, normalizeScoreFields, normalizeValueFilters, matchesValueFilters, comparisonValueEligible } from '../public/js/shared/score-fields.js';
import { normalizeScoreFieldRequests, resolveScoreFields, normalizeFieldContribution } from '../score-field-service.js';
import { comparisonOptions, groupComparisonModels } from '../model-comparison.js';
import { loadModels } from '../ranking-service.js';
import { scoreValueKey } from '../score-aggregation.js';

const definition = (type, extra = {}) => ({ ID: 1, name: 'Harness', type, allowEmpty: false, excludeMissing: true, excludeEmpty: false,
    options: type === 'enum' ? [{ ID: 11, label: 'A', excluded: false }, { ID: 12, label: 'Unknown', excluded: true }] : [], ...extra });
test('numbers canonicalize decimals and exponents without treating zero as empty', () => {
    for (const value of ['1', '1.0', '+1e0', '0.1e1']) assert.equal(canonicalNumber(value), '1e0');
    assert.equal(canonicalNumber('-0.00'), '0');
    assert.equal(canonicalNumber('-0.125'), '-125e-3');
    assert.equal(canonicalNumber('9007199254740993'), '9007199254740993e0');
    assert.notEqual(canonicalNumber('9007199254740993'), canonicalNumber('9007199254740992'));
    for (const value of ['', ' ', 'NaN', 'Infinity', '-Infinity', '0x10', '1e309', [], true, null]) assert.throws(() => canonicalNumber(value));
});
test('definition types and comparison policies are validated independently of score submission', () => {
    assert.equal(normalizeFieldDefinition(definition('number')).excludeMissing, true);
    assert.throws(() => normalizeFieldDefinition(definition('presence', { allowEmpty: true })));
    assert.throws(() => normalizeFieldDefinition(definition('text', { excludeEmpty: true })));
    assert.throws(() => normalizeFieldDefinition(definition('enum', { options: [{ label: 'A', excluded: false }, { label: 'a', excluded: false }] })));
    assert.throws(() => normalizeFieldDefinition(definition('text', { name: 'Model' })));
});
test('absence, presence, empty, zero and explicit option values remain distinct', () => {
    assert.deepEqual(normalizeScoreFields([], [definition('presence')]), []);
    assert.deepEqual(normalizeScoreFields([{ fieldID: 1, value: null }], [definition('presence')]), [{ fieldID: 1, value: null }]);
    assert.throws(() => normalizeScoreFields([{ fieldID: 1, value: 'yes' }], [definition('presence')]));
    assert.throws(() => normalizeScoreFields([{ fieldID: 1, value: null }], [definition('number')]));
    assert.deepEqual(normalizeScoreFields([{ fieldID: 1, value: 0 }], [definition('number')]), [{ fieldID: 1, value: '0' }]);
    assert.throws(() => normalizeScoreFields([{ fieldID: 1, value: 99 }], [definition('enum')]));
    assert.throws(() => normalizeScoreFields([{ fieldID: 1, value: 'a' }, { fieldID: 1, value: 'b' }], [definition('text')]));
    assert.notEqual(scoreValueKey(1, 2, 80), scoreValueKey(1, 2, 80, [{ fieldID: 1, value: null }]));
});
test('filters distinguish missing from empty, and support exact model and numeric equality', () => {
    const fields = [definition('number', { allowEmpty: true })], keys = ['model', 'field:1'];
    const filters = normalizeValueFilters([{ key: 'model', operator: 'eq', value: 3 }, { key: 'field:1', operator: 'eq', value: '1.0' }], keys, fields);
    assert.equal(matchesValueFilters({ model: 3, 'field:1': '1e0' }, filters), true);
    assert.equal(matchesValueFilters({ model: 4, 'field:1': '1e0' }, filters), false);
    assert.equal(matchesValueFilters({}, [{ key: 'field:1', operator: 'present' }]), false);
    assert.equal(matchesValueFilters({ 'field:1': null }, [{ key: 'field:1', operator: 'absent' }]), false);
    assert.equal(matchesValueFilters({ 'field:1': null }, [{ key: 'field:1', operator: 'present' }]), true);
    assert.throws(() => normalizeValueFilters([{ key: 'field:1', operator: 'eq', value: '' }], keys, fields));
    assert.throws(() => normalizeValueFilters([{ key: 'field:1', operator: 'empty' }], keys, fields));
});
test('numeric limits compare exact decimal values and allow a lower and upper bound together', () => {
    const fields = [definition('number', { allowEmpty: true })], keys = ['model', 'field:1'];
    const filters = normalizeValueFilters([
        { key: 'field:1', operator: 'gt', value: '9007199254740992' },
        { key: 'field:1', operator: 'lt', value: '9007199254740994' }
    ], keys, fields);
    assert.equal(compareCanonicalNumbers('9007199254740993', '9007199254740992'), 1);
    assert.equal(compareCanonicalNumbers('0.001', '0.01'), -1);
    assert.equal(compareCanonicalNumbers('0.1', '0.01'), 1);
    assert.equal(compareCanonicalNumbers('1e-3', '9e-4'), 1);
    assert.equal(compareCanonicalNumbers('-0.001', '-0.01'), 1);
    assert.equal(compareCanonicalNumbers('-0.125', '-0.12'), -1);
    assert.equal(matchesValueFilters({ 'field:1': canonicalNumber('9007199254740993') }, filters), true);
    assert.equal(matchesValueFilters({ 'field:1': canonicalNumber('9007199254740992') }, filters), false);
    assert.equal(matchesValueFilters({ 'field:1': canonicalNumber('9007199254740994') }, filters), false);
    assert.equal(matchesValueFilters({ 'field:1': null }, filters), false);
    assert.equal(matchesValueFilters({}, filters), false);
    assert.throws(() => normalizeValueFilters([{ key: 'model', operator: 'gt', value: 1 }], keys, fields));
    assert.throws(() => normalizeValueFilters([{ key: 'field:1', operator: 'gt', value: 'NaN' }], keys, fields));
    assert.throws(() => normalizeValueFilters([{ key: 'field:1', operator: 'gt', value: 1 }, { key: 'field:1', operator: 'gt', value: 2 }], keys, fields));
    assert.throws(() => normalizeValueFilters([{ key: 'field:1', operator: 'eq', value: 1 }, { key: 'field:1', operator: 'lt', value: 2 }], keys, fields));
    assert.throws(() => normalizeValueFilters([{ key: 'field:1', operator: 'present' }, { key: 'field:1', operator: 'absent' }], keys, fields));
    assert.throws(() => normalizeValueFilters([{ key: 'field:1', operator: 'gt', value: 1 }], keys, [definition('text')]));
});
test('comparison exclusion does not change whether a value can be recorded', () => {
    const field = definition('enum', { allowEmpty: true, excludeEmpty: true });
    assert.deepEqual(normalizeScoreFields([{ fieldID: 1, value: 12 }], [field]), [{ fieldID: 1, value: 12 }]);
    assert.equal(comparisonValueEligible(field, {}), false);
    assert.equal(comparisonValueEligible(field, { 'field:1': null }), false);
    assert.equal(comparisonValueEligible(field, { 'field:1': 12 }), false);
    assert.equal(comparisonValueEligible(field, { 'field:1': 11 }), true);
    assert.equal(comparisonValueEligible(definition('presence'), { 'field:1': null }), true);
});
const model = (ID, modelID, parameters, score) => ({ ID, modelID, modelName: `Model ${modelID}`, name: `Model ${modelID}`,
    condition: { parameters }, results: new Map([['1', { normalizedScore: score }]]) });
test('value restrictions run before maxima and ignored fields do not exclude configurations', () => {
    const models = [model(1, 10, { 'field:1': 11 }, 60), model(2, 10, { 'field:1': 12 }, 99), model(3, 20, {}, 90)];
    const fields = [definition('enum')];
    const options = comparisonOptions(models, { mode: 'best', keys: ['model'], filters: [{ key: 'field:1', operator: 'eq', value: 11 }] }, fields);
    const result = groupComparisonModels(models, options, [{ conditionID: 1, weightBasisPoints: 10000 }]);
    assert.equal(result.length, 1); assert.equal(result[0].results.get('1').normalizedScore, 60);
    const ignored = groupComparisonModels(models, comparisonOptions(models, { mode: 'best', keys: ['model'] }, fields), []);
    assert.deepEqual(ignored.map(item => item.results.get('1').normalizedScore), [99, 90]);
});
test('ignoring one sparse field does not require unrelated fields on every score', () => {
    const fields = [definition('text', { name: 'Agent harness' }), definition('text', { ID: 2, name: 'Thinking effort' })];
    const models = [model(1, 10, { 'field:1': 'A' }, 60), model(2, 10, { 'field:1': 'B' }, 95),
        model(3, 20, { 'field:2': 'high' }, 70)];
    const options = comparisonOptions(models, { mode: 'best', keys: ['model'] }, fields);
    const groups = groupComparisonModels(models, options, [{ conditionID: 1, weightBasisPoints: 10000 }]);
    assert.deepEqual(groups.map(group => [group.modelID, group.results.get('1').normalizedScore]), [[10, 95], [20, 70]]);
});
test('numeric ranges filter configurations before leaderboard grouping', () => {
    const models = [model(1, 10, { 'field:1': canonicalNumber(5000) }, 60),
        model(2, 20, { 'field:1': canonicalNumber(10000) }, 90),
        model(3, 30, {}, 100)];
    const options = comparisonOptions(models, { mode: 'best', keys: ['model'], filters: [
        { key: 'field:1', operator: 'gt', value: 6000 },
        { key: 'field:1', operator: 'lt', value: 12000 }
    ] }, [definition('number')]);
    const result = groupComparisonModels(models, options, [{ conditionID: 1, weightBasisPoints: 10000 }]);
    assert.deepEqual(result.map(item => item.modelID), [20]);
    assert.equal(result[0].results.get('1').normalizedScore, 90);
});
test('global unobserved fields never invalidate normal rankings', () => {
    const models = [model(1, 10, {}, 60), model(2, 20, {}, 80)];
    const result = groupComparisonModels(models, comparisonOptions(models, null, [definition('number')]), []);
    assert.equal(result.length, 2);
    const filtered = comparisonOptions(models, { mode: 'best', keys: ['model'], filters: [{ key: 'model', operator: 'eq', value: 10 }] }, [definition('number')]);
    assert.equal(groupComparisonModels(models, filtered, []).length, 1);
    const ignoringModel = comparisonOptions(models, { mode: 'best', keys: [] }, [definition('number')]);
    assert.equal(groupComparisonModels(models, ignoringModel, []).length, 1);
});
test('matched comparisons enforce explicit control eligibility, missing never matches empty', () => {
    const fields = [definition('text', { allowEmpty: true })];
    const models = [model(1, 10, { 'field:1': 'A' }, 60), model(2, 20, { 'field:1': 'A' }, 70), model(3, 30, {}, 100)];
    const options = comparisonOptions(models, { mode: 'matched', keys: ['model'] }, fields);
    const result = groupComparisonModels(models, options, [{ conditionID: 1, weightBasisPoints: 10000 }]);
    assert.deepEqual(result.filter(item => item.comparable).map(item => item.modelID), [10, 20]);
    assert.equal(result.find(item => item.modelID === 30).results.size, 0);
    assert.throws(() => comparisonOptions(models, { mode: 'matched', keys: [] }, fields));
});
test('different score configurations are deduplicated and aggregated independently', async () => {
    const field = definition('text');
    const rows = [
        ['A', 40], ['A', 40], ['A', 80], ['B', 40], ['B', 100]
    ].map(([value, score], index) => ({ result_ID: index + 1, model_ID: 1, model_name: 'M', score_fields: [{ fieldID: 1, value }],
        benchmark_condition_ID: 1, raw_score: score, uses_percentage_scale: 1, score_direction: 'higher', score_min: null, score_max: null, target_value: null }));
    const models = await loadModels({ execute: async () => [rows] }, [field]);
    assert.equal(models.length, 2);
    assert.deepEqual(models.map(item => item.results.get('1').normalizedScore), [60, 70]);
});
test('matched comparisons can explicitly permit the missing state for a selected field', () => {
    const fields = [definition('presence', { excludeMissing: false })];
    const models = [model(1, 10, {}, 60), model(2, 10, { 'field:1': null }, 80)];
    const result = groupComparisonModels(models, comparisonOptions(models, { mode: 'matched', keys: ['field:1'] }, fields), [{ conditionID: 1, weightBasisPoints: 10000 }]);
    assert.equal(result.length, 2);
    assert.ok(result.every(item => item.comparable));
    assert.match(result[0].name, /Not recorded/);
});
test('pending field references remain drafts, rejection or ownership mismatch prevents use', async () => {
    const content = { type: 'score_field', operation: 'create', definition: definition('text') };
    const database = (status, user = '5') => ({ async execute(sql) {
        if (sql.includes('FROM score_fields') || sql.includes('FROM score_field_options')) return [[]];
        if (sql.includes('moderation_logs')) return [[{ status, user_id: user, content }]];
        throw Error(sql);
    } });
    const input = [{ fieldRequestID: 99, value: 'A' }];
    await resolveScoreFields(database('pending'), input, '5');
    await assert.rejects(resolveScoreFields(database('pending'), input, '5', { apply: true }), error => error.body.error === 'referenced_contribution_pending');
    await assert.rejects(resolveScoreFields(database('rejected'), input, '5'));
    await assert.rejects(resolveScoreFields(database('pending', '6'), input, '5'));
    assert.throws(() => normalizeScoreFieldRequests([{ fieldID: 1, fieldRequestID: 2, value: null }]));
    assert.throws(() => normalizeScoreFieldRequests([{ fieldID: 1, fieldRequestID: 'invalid', value: null }]));
});
test('pending enum options resolve by stable slots rather than mutable labels', async () => {
    const content = { type: 'score_field', operation: 'create', definition: definition('enum') };
    const pending = { async execute(sql) {
        if (sql.includes('moderation_logs')) return [[{ status: 'pending', user_id: 5, content }]];
        return [[]];
    } };
    const input = [{ fieldRequestID: 99, optionIndex: 0 }];
    assert.deepEqual(await resolveScoreFields(pending, input, 5), [{ fieldID: 99, value: 1 }]);
    const approved = { async execute(sql) {
        if (sql.includes('moderation_logs')) return [[{ status: 'approved', user_id: 5, content }]];
        if (sql.includes('SELECT ID FROM score_fields')) return [[{ ID: 7 }]];
        if (sql.includes('FROM score_fields')) return [[{ ID: 7, name: 'Harness', type: 'enum', allowEmpty: 0, excludeMissing: 1, excludeEmpty: 0, revision: 1, requestID: 99 }]];
        if (sql.includes('FROM score_field_options')) return [[{ ID: 30, fieldID: 7, label: 'Renamed by reviewer', excluded: 0, revision: 1, requestID: 99, pendingIndex: 0 }]];
        throw Error(sql);
    } };
    assert.deepEqual(await resolveScoreFields(approved, input, 5, { apply: true }), [{ fieldID: 7, value: 30 }]);
});
function fieldReferenceDatabase({ type = 'text', fieldRequestStatus = 'approved' } = {}) {
    const field = definition(type, { ID: 7, requestID: fieldRequestStatus === 'approved' ? 99 : null });
    const fieldContent = { type: 'score_field', operation: 'create', definition: definition(type) };
    return { async execute(sql, params) {
        if (sql.includes('moderation_logs')) {
            const optionRequest = params[0] === 100;
            return [[{ status: optionRequest ? 'pending' : fieldRequestStatus, user_id: 5,
                content: optionRequest
                    ? { type: 'score_field_option', operation: 'create', fieldID: 7, label: 'New', excluded: false }
                    : fieldContent }]];
        }
        if (sql.includes('SELECT ID FROM score_fields')) return [[{ ID: 7 }]];
        if (sql.includes('FROM score_fields')) return [[field]];
        if (sql.includes('FROM score_field_options')) return [field.options.map(option => ({ ...option, fieldID: 7, revision: 1 }))];
        throw Error(sql);
    } };
}

test('drafts reject two references resolving to the same approved field', async () => {
    const assignments = [{ fieldID: 7, value: 'A' }, { fieldRequestID: 99, value: 'B' }];
    for (const input of [assignments, [...assignments].reverse()]) {
        await assert.rejects(resolveScoreFields(fieldReferenceDatabase(), input, 5),
            error => error.body?.error === 'duplicate_score_field');
    }
});

test('unresolved enum values cannot bypass duplicate field validation in a draft', async () => {
    for (const deferredValue of [{ newOption: 'New' }, { optionRequestID: 100 }]) {
        const assignments = [{ fieldID: 7, ...deferredValue }, { fieldRequestID: 99, value: 11 }];
        for (const input of [assignments, [...assignments].reverse()]) {
            await assert.rejects(resolveScoreFields(fieldReferenceDatabase({ type: 'enum' }), input, 5),
                error => error.body?.error === 'duplicate_score_field');
        }
    }
});

test('pending request IDs remain separate from equally numbered approved field IDs', async () => {
    const assignments = [{ fieldID: 7, value: 'A' }, { fieldRequestID: 7, value: 'B' }];
    const result = await resolveScoreFields(fieldReferenceDatabase({ fieldRequestStatus: 'pending' }), assignments, 5);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map(item => item.value), ['A', 'B']);
});

test('field proposals preserve required defaults and reject invalid operation payloads', () => {
    const values = definition('number'); delete values.ID;
    const body = { type: 'score_field', operation: 'create', definition: values, notes: '' };
    assert.equal(normalizeFieldContribution(body).definition.excludeMissing, true);
    assert.throws(() => normalizeFieldContribution({ ...body, operation: 'delete', targetID: 1, revision: 1 }));
    assert.throws(() => normalizeFieldContribution({ ...body, definition: { ...values, min: 0 } }));
});
