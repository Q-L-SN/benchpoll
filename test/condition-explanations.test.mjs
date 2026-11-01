import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { assertPrimaryCondition } from '../benchmark-primary-condition.js';
import { upgradeConditionExplanations, migrateConditionExplanations } from '../scripts/migrate-condition-explanations.mjs';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
function between(start, end) {
    const first = server.indexOf(start);
    const last = server.indexOf(end, first);
    assert.ok(first >= 0 && last > first);
    return server.slice(first, last);
}
function contract() {
    const sandbox = vm.createContext({ assertPrimaryCondition, crypto, URL, structuredClone });
    vm.runInContext(`${between('function normalizeString(', 'function parseModerationContent(')}
        ${between('function canonicalChangeValue(', 'function entityChildSetChanges(')}
        ${between('async function insertSubmittedBenchmarkCondition(', 'async function applyBenchmarkBatch(')}
        this.contract = { buildContributionContent, normalizeStoredModerationContent, normalizeCanonicalEntityChangeContent,
            describeEntityChanges, assertBenchmarkConditionNameLengths, insertSubmittedBenchmarkCondition };`, sandbox);
    return sandbox.contract;
}
function condition(overrides = {}) {
    return { clientRef: 'one', name: 'default', differenceExplanation: '', scoreDirection: 'higher',
        targetValue: null, usesPercentageScale: true, scoreMin: null, scoreMax: null,
        isDefault: true, isPrimary: true, ...overrides };
}
function newBenchmark(entry = condition()) {
    return { type: 'new_benchmark', benchmarks: [{ clientRef: 'bench', existingBenchmarkID: null,
        existingBenchmarkRef: null, name: 'DifferenceBench', introductionURL: '', reviewerNotes: '',
        conditions: [entry] }] };
}
function change(entry) {
    const { clientRef, ...fields } = entry;
    assert.equal(clientRef, 'one');
    return { type: 'entity_change', targetKind: 'benchmark', targetID: 20, operation: 'update', reviewNotes: '',
        proposed: { name: 'DifferenceBench', introductionURL: '', notes: '', conditions: [fields] } };
}

test('new condition explanation round-trips through submission and moderation', () => {
    const api = contract();
    const content = api.buildContributionContent(newBenchmark(condition({ differenceExplanation: '  Uses the private split.\nDoes not include the public tasks.  ' })));
    const stored = api.normalizeStoredModerationContent(structuredClone(content));
    assert.equal(stored.benchmarks[0].conditions[0].differenceExplanation, 'Uses the private split.\nDoes not include the public tasks.');
    assert.equal(stored.benchmarks[0].conditions[0].scoreMin, null);
});

test('the optional explanation is empty when omitted and malformed values are rejected', () => {
    const api = contract();
    const entry = condition();
    delete entry.differenceExplanation;
    assert.equal(api.buildContributionContent(newBenchmark(entry)).benchmarks[0].conditions[0].differenceExplanation, '');
    for (const value of [42, {}, [], 'x'.repeat(10001)]) {
        assert.throws(() => api.buildContributionContent(newBenchmark(condition({ differenceExplanation: value }))));
    }
    assert.equal(api.buildContributionContent(newBenchmark(condition({ differenceExplanation: 'x'.repeat(10000) }))).benchmarks[0].conditions[0].differenceExplanation.length, 10000);
});

test('new names allow exactly 60 characters and reject longer names rather than truncating', () => {
    const api = contract();
    for (const text of ['x', '\u6d4b']) {
        assert.equal(api.buildContributionContent(newBenchmark(condition({ name: text.repeat(60), isDefault: false }))).benchmarks[0].conditions[0].name, text.repeat(60));
        assert.throws(() => api.buildContributionContent(newBenchmark(condition({ name: text.repeat(61), isDefault: false }))),
            error => error.body.error === 'benchmark_condition_name_too_long');
    }
});

test('unchanged existing long names do not block explanation-only changes', () => {
    const api = contract();
    const content = api.buildContributionContent(change(condition({ ID: 7, name: 'x'.repeat(192), isDefault: false,
        differenceExplanation: 'Uses the full dataset, not the development subset.' })));
    const before = structuredClone(content.after);
    before.conditions[0].differenceExplanation = '';
    const stored = { ...content, before, changes: api.describeEntityChanges(before, content.after) };
    const normalized = api.normalizeStoredModerationContent(stored);
    assert.equal(normalized.after.conditions[0].name, 'x'.repeat(192));
    assert.equal(normalized.after.conditions[0].ID, 7);
    assert.deepEqual(Array.from(normalized.changes, item => item.field), ['conditions[7].differenceExplanation']);
    const renamed = structuredClone(stored);
    renamed.after.conditions[0].name = 'y'.repeat(61);
    renamed.changes = api.describeEntityChanges(before, renamed.after);
    assert.throws(() => api.normalizeCanonicalEntityChangeContent(renamed, { trustedBefore: before }),
        error => error.body.error === 'benchmark_condition_name_too_long');
});

test('historical submitted long names remain readable but fresh and reviewer-renamed names are limited', () => {
    const api = contract();
    const historic = { ...newBenchmark(condition({ name: 'x'.repeat(192), isDefault: false })), schemaVersion: 6 };
    const normalized = api.normalizeStoredModerationContent(historic);
    assert.equal(normalized.benchmarks[0].conditions[0].name, 'x'.repeat(192));
    const edited = newBenchmark(condition({ name: 'y'.repeat(61), isDefault: false }));
    assert.throws(() => api.buildContributionContent(edited, { originalBenchmarks: normalized.benchmarks }),
        error => error.body.error === 'benchmark_condition_name_too_long');
});

test('claiming a persisted condition ID cannot bypass the trusted original name limit', () => {
    const api = contract();
    assert.throws(() => api.assertBenchmarkConditionNameLengths([{ ID: 99, name: 'x'.repeat(61) }], [{ ID: 7, name: 'x'.repeat(61) }]),
        error => error.body.error === 'benchmark_condition_name_too_long');
    assert.throws(() => api.buildContributionContent(change(condition({ ID: null, name: 'x'.repeat(61), isDefault: false }))),
        error => error.body.error === 'benchmark_condition_name_too_long');
});

test('approval inserts the explanation as a parameter, not into SQL text', async () => {
    const api = contract();
    const explanation = "Private split; not the public split. 'quotes' <script>";
    const content = api.buildContributionContent(newBenchmark(condition({ differenceExplanation: explanation })));
    const calls = [];
    await api.insertSubmittedBenchmarkCondition({ async execute(sql, values) { calls.push({ sql, values }); } }, 20,
        content.benchmarks[0].conditions[0], true);
    assert.match(calls[0].sql, /name, difference_explanation/);
    assert.equal(calls[0].values[3], explanation);
    assert.equal(calls[0].values.length, 11);
    assert.ok(!calls[0].sql.includes(explanation));
});

test('migration explicitly upgrades historical snapshots and nested original content without changing names', () => {
    const api = contract();
    const old = { type: 'entity_change', targetKind: 'benchmark', schemaVersion: 6,
        before: { conditions: [{ ID: 7, name: 'x'.repeat(192) }] },
        after: { conditions: [{ ID: 7, name: 'x'.repeat(192) }, { ID: null, name: 'new' }] }, changes: [],
        moderation: { originalContent: { type: 'new_benchmark', benchmarks: [{ conditions: [{ name: 'default' }] }] } } };
    const migrated = upgradeConditionExplanations(old, api.describeEntityChanges);
    assert.equal(migrated.before.conditions[0].name, 'x'.repeat(192));
    assert.equal(migrated.after.conditions[1].differenceExplanation, '');
    assert.equal(migrated.changes[0].after.differenceExplanation, '');
    assert.equal(migrated.moderation.originalContent.benchmarks[0].conditions[0].differenceExplanation, '');
    assert.equal(old.after.conditions[1].differenceExplanation, undefined);
    assert.equal(upgradeConditionExplanations(migrated, api.describeEntityChanges), null);
    assert.throws(() => upgradeConditionExplanations({ type: 'new_benchmark', benchmarks: [{ conditions: [
        { name: 'default', differenceExplanation: 42 } ] }] }, api.describeEntityChanges), /Invalid stored condition explanation/);
});

test('database migration keeps the existing name column and every old condition value', async () => {
    const statements = [];
    const columns = [{ Field: 'name', Type: 'varchar(192)', Null: 'NO' }];
    const rows = [{ ID: 7, name: 'x'.repeat(192), updated_at: 'original', score_min: null }];
    const db = { async query(sql) {
        statements.push(sql);
        if (sql === 'SHOW COLUMNS FROM benchmark_conditions') return [columns];
        if (sql === 'SELECT * FROM benchmark_conditions ORDER BY ID') return [rows];
        if (sql.startsWith('SELECT ID, content FROM moderation_logs')) return [[]];
        if (sql === 'ALTER TABLE benchmark_conditions ADD COLUMN difference_explanation TEXT NULL') return [];
        throw new Error(sql);
    }, async beginTransaction() {}, async commit() {}, async rollback() {} };
    const dry = await migrateConditionExplanations(db);
    assert.equal(dry.preservedLongNames, 1);
    assert.ok(!statements.some(sql => sql.startsWith('ALTER')));
    const applied = await migrateConditionExplanations(db, { apply: true });
    assert.equal(applied.oldConditionRowsUnchanged, true);
    assert.ok(statements.includes('ALTER TABLE benchmark_conditions ADD COLUMN difference_explanation TEXT NULL'));
    assert.ok(!statements.some(sql => /UPDATE benchmark_conditions|MODIFY.*name/.test(sql)));
});
