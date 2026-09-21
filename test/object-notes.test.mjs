import { normalizeModelParameters, modelParameterLabel } from '../public/js/shared/model-parameters.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
function between(start, end) {
    const from = server.indexOf(start);
    const to = server.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    return server.slice(from, to);
}
function contract() {
    const context = vm.createContext({ URL, crypto, structuredClone, normalizeModelParameters, modelParameterLabel });
    vm.runInContext(between('function normalizeString(', 'function parseModerationContent(')
        + between('function canonicalChangeValue(', 'function entityChildSetChanges(')
        + '\nthis.api = { buildContributionContent, normalizeStoredModerationContent, describeEntityChanges };', context);
    return context.api;
}
const condition = { ID: 11, name: 'default', isDefault: true, usesPercentageScale: true,
    scoreDirection: 'higher', scoreMin: null, scoreMax: null, targetValue: null };
const result = { clientRef: 'score-a', modelID: 1, modelRef: null, modelConditionID: 2, modelConditionRef: null,
    benchmarkID: 3, benchmarkRef: null, benchmarkConditionID: 11, benchmarkConditionRef: null,
    rawScore: 72, source: { type: 'other', url: 'https://example.com/results', title: '' } };

test('a shared score note becomes an independently editable stored note on each score', () => {
    const api = contract();
    const normalized = api.buildContributionContent({ type: 'benchmark_result', reviewerNotes: 'Shared note', results: [
        result, { ...result, clientRef: 'score-b', modelConditionID: 4 }
    ] });
    assert.equal(normalized.results[0].notes, 'Shared note');
    assert.equal(normalized.results[1].notes, 'Shared note');
    assert.equal(Object.hasOwn(normalized, 'reviewerNotes'), false);
    normalized.results[1].notes = 'Specific note';
    const stored = api.normalizeStoredModerationContent(structuredClone(normalized));
    assert.equal(stored.results[0].notes, 'Shared note');
    assert.equal(stored.results[1].notes, 'Specific note');
    stored.results[0].notes = '';
    assert.equal(api.normalizeStoredModerationContent(stored).results[0].notes, '');
});

for (const kind of ['benchmark', 'model', 'result']) {
    test(`${kind}: notes-only changes survive normalization, diff and review`, () => {
        const api = contract();
        const proposed = kind === 'benchmark'
            ? { name: 'Benchmark', introductionURL: '', notes: 'New note', tags: [], conditions: [condition] }
            : kind === 'model'
                ? { name: 'Model', introductionURL: '', notes: 'New note', vendor: { existingVendorID: 1, existingVendorRef: null },
                    conditions: [{ ID: 2, name: 'default', isDefault: true, parameters: {} }] }
                : { results: [{ ...result, notes: 'New note' }] };
        const submission = api.buildContributionContent({ type: 'entity_change', targetKind: kind,
            targetID: 1, operation: 'update', reviewNotes: '', proposed });
        submission.before = structuredClone(submission.after);
        (kind === 'result' ? submission.before.result : submission.before).notes = 'Original note';
        submission.changes = api.describeEntityChanges(submission.before, submission.after);
        assert.equal(submission.changes.length, 1);
        assert.equal(submission.changes[0].field, kind === 'result' ? 'result.notes' : 'notes');
        const stored = api.normalizeStoredModerationContent(submission);
        assert.equal((kind === 'result' ? stored.after.result : stored.after).notes, 'New note');
    });
}

test('structured merge submissions are rejected, while text merge requests remain plain feedback', () => {
    const api = contract();
    assert.throws(() => api.buildContributionContent({ type: 'entity_change', targetKind: 'benchmark',
        targetID: 1, operation: 'merge', reviewNotes: 'Duplicate', proposed: { destinationID: 2 } }),
    error => error?.body?.error === 'invalid_change_operation');
    const feedback = api.buildContributionContent({ type: 'feedback', details: 'Merge benchmark #1 into #2: duplicate.', pageURL: '' });
    assert.equal(feedback.type, 'feedback');
    assert.doesNotMatch(server, /get_merge_candidates|applyObjectMerge|normalizeMergeDestination/);
});

test('change targets read database notes for benchmarks, models and scores', async () => {
    const context = vm.createContext({ entityChangeLockClause: () => '', parseJSONColumn: value => typeof value === 'string' ? JSON.parse(value) : value });
    vm.runInContext(between('async function loadBenchmarkChangeTarget(', 'async function loadEntityChangeTarget(')
        + '\nthis.api = { loadBenchmarkChangeTarget, loadModelChangeTarget, loadResultChangeTarget };', context);
    const queries = [];
    const connection = { async execute(sql) {
        queries.push(sql);
        if (/FROM benchmark_conditions/.test(sql)) return [[{ ...condition, ID: 11 }]];
        if (/FROM model_conditions/.test(sql)) return [[{ ID: 2, name: 'default', isDefault: 1, parameters: {} }]];
        if (/FROM benchmark_tag_links/.test(sql)) return [[]];
        return [[{ ID: 1, vendorID: 1, name: 'Name', introductionURL: '', notes: 'Stored note',
            modelID: 1, modelConditionID: 2, benchmarkID: 3, benchmarkConditionID: 11, rawScore: 72,
            sourceType: 'other', sourceURL: 'https://example.com/results', sourceTitle: '' }]];
    } };
    assert.equal((await context.api.loadBenchmarkChangeTarget(connection, 1)).notes, 'Stored note');
    assert.equal((await context.api.loadModelChangeTarget(connection, 1)).notes, 'Stored note');
    assert.equal((await context.api.loadResultChangeTarget(connection, 1)).result.notes, 'Stored note');
    assert.equal(queries.filter(sql => /notes/.test(sql)).length, 3);
});
