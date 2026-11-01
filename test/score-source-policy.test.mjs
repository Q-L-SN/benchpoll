import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { assertManualScoreAllowed, assertScoreSourcePolicy,
    recordSyncedScoreEdit, recordSyncedScoreDeletion } from '../score-source-policy.js';
import { currentScoreSQL } from '../score-aggregation.js';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const managed = { ID: 7, benchmark_ID: 6, score_source: 'arena_official', uses_percentage_scale: 0 };
const isPolicyError = name => error => error?.status === 409 && error.body?.error === name;

test('static scores remain writable; missing policies and new manual scores for synced conditions fail explicitly', () => {
    assert.doesNotThrow(() => assertManualScoreAllowed({ ...managed, score_source: null }));
    assert.throws(() => assertManualScoreAllowed({ ID: 7 }), /no valid score source policy/);
    assert.throws(() => assertManualScoreAllowed(managed), isPolicyError('dynamic_scores_are_synced'));
    assert.throws(() => assertManualScoreAllowed({ ...managed, score_source: 'other_source' }), isPolicyError('dynamic_scores_are_synced'));
});

test('only editing a currently tracked score in the same condition permits a synced correction', async () => {
    const queries = [];
    const connection = { async execute(sql, parameters) {
        assert.match(sql, /arena_import_rows.*JOIN benchmark_results/s);
        assert.match(sql, /WHERE a.result_ID=\? FOR UPDATE/);
        queries.push(parameters);
        return [parameters[0] === 10 ? [{ result_ID: 10, benchmark_condition_ID: 7 }] : []];
    } };
    await assert.rejects(assertScoreSourcePolicy(connection, managed), isPolicyError('dynamic_scores_are_synced'));
    await assert.rejects(assertScoreSourcePolicy(connection, managed, { editingResultID: 99 }), isPolicyError('dynamic_scores_are_synced'));
    await assertScoreSourcePolicy(connection, managed, { editingResultID: 10 });
    await assert.rejects(assertScoreSourcePolicy(connection, { ...managed, ID: 8, score_source: null },
        { editingResultID: 10 }), isPolicyError('dynamic_score_condition_immutable'));
    assert.deepEqual(queries, [[99], [10], [10]]);
});

test('reviewed edits move source tracking to the replacement row; deletions leave a suppression marker', async () => {
    const tracked = { result_ID: 10, manual_override: 'none' };
    const connection = { async execute(sql, parameters) {
        if (sql.includes("manual_override='edit'")) {
            assert.deepEqual(parameters, [11, 10]);
            tracked.result_ID = parameters[0];
            tracked.manual_override = 'edit';
        } else {
            assert.match(sql, /manual_override='delete'/);
            assert.deepEqual(parameters, [11]);
            tracked.manual_override = 'delete';
        }
        return [{ affectedRows: 1 }];
    } };
    await recordSyncedScoreEdit(connection, 10, 11);
    assert.deepEqual(tracked, { result_ID: 11, manual_override: 'edit' });
    await recordSyncedScoreDeletion(connection, 11);
    assert.deepEqual(tracked, { result_ID: 11, manual_override: 'delete' });
});

test('submission validation and moderation application both enforce managed-source policy', async () => {
    const start = source.indexOf('async function validateModelResultForSubmission(');
    const end = source.indexOf('async function loadContributionReferenceSource(', start);
    const sandbox = vm.createContext({ assertScoreSourcePolicy, selectableBenchmarkConditionSQL: () => '1' });
    vm.runInContext(`${source.slice(start, end)}\nthis.validate = validateModelResultForSubmission;`, sandbox);
    const connection = { async execute(sql, parameters) {
        if (sql.startsWith('SELECT ID, is_active FROM models')) return [[{ ID: 4, is_active: 1 }]];
        if (sql.startsWith('SELECT ID, is_active FROM benchmarks')) return [[{ ID: 6, is_active: 1 }]];
        if (sql.includes('FROM benchmark_conditions JOIN benchmarks')) {
            assert.match(sql, /benchmark_conditions.score_source/);
            return [[{ ...managed, selectable: 1, benchmarkActive: 1 }]];
        }
        if (sql.includes('FROM arena_import_rows')) return [parameters[0] === 10 ? [{ benchmark_condition_ID: 7 }] : []];
        throw new Error(`Unexpected SQL: ${sql}`);
    } };
    const content = { type: 'benchmark_result', results: [{ modelID: 4, benchmarkID: 6, benchmarkConditionID: 7, rawScore: 1200 }] };
    await assert.rejects(sandbox.validate(connection, content), isPolicyError('dynamic_scores_are_synced'));
    await sandbox.validate(connection, content, { editingResultID: 10 });

    const persistence = vm.createContext({ assertScoreSourcePolicy, recordSyncedScoreEdit, currentScoreSQL,
        materializeResultReferences: async (_connection, result) => result,
        resolveResultBenchmarkCondition: async () => managed });
    const insertStart = source.indexOf('async function applyBenchmarkResult(');
    const insertEnd = source.indexOf('async function applyModerationContent(', insertStart);
    vm.runInContext(`${source.slice(insertStart, insertEnd)}\nthis.apply = applyBenchmarkResult;`, persistence);
    await assert.rejects(persistence.apply(connection, content, {}), isPolicyError('dynamic_scores_are_synced'));
    assert.match(source, /validateModelResultForSubmission\(connection, resultContent, \{ editingResultID: content.targetID \}\)/);
    assert.match(source, /recordSyncedScoreDeletion\(connection, content.targetID, \{ required: syncedCorrection \}\)/);
});

test('a synced edit or deletion cannot silently lose its source tracking', async () => {
    const connection = { execute: async () => [{ affectedRows: 0 }] };
    await assert.rejects(recordSyncedScoreEdit(connection, 10, 11, { required: true }), /lost its source tracking/);
    await assert.rejects(recordSyncedScoreDeletion(connection, 10, { required: true }), /lost its source tracking/);
    await recordSyncedScoreEdit(connection, 10, 11);
    await recordSyncedScoreDeletion(connection, 10);
});
