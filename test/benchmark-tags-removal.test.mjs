import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { assertPrimaryCondition } from '../benchmark-primary-condition.js';
import { queryAdminDataExplorer, queryAdminDataRecord } from '../moderation-admin.js';
import { rankingCacheTriggers, RANKING_DATA_TABLES } from '../ranking-cache-schema.js';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const importer = fs.readFileSync(new URL('../scripts/import-arena-latest.mjs', import.meta.url), 'utf8');

function between(start, end) {
    const first = server.indexOf(start);
    const last = server.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `Missing source markers: ${start}, ${end}`);
    return server.slice(first, last);
}

function contract(overrides = {}) {
    const sandbox = vm.createContext({ assertPrimaryCondition, crypto, URL, structuredClone, ...overrides });
    vm.runInContext(`${between('function normalizeString(', 'function parseModerationContent(')}
        ${between('function parseModerationContent(', 'function entityChangeLockClause(')}
        ${between('function canonicalChangeValue(', 'function entityChildSetChanges(')}
        ${between('function validateEditedContributionClientRefs(', 'function referencedContributionEntry(')}
        ${between('function assertEntityChangeIsCurrent(', 'function assertSingleConditionMutation(')}
        ${between('function assertSingleConditionMutation(', 'async function applyModelChange(')}
        ${between('async function insertSubmittedBenchmarkCondition(', 'async function applyModelBatch(')}
        ${between('function pendingCatalogReference(', "API.post('/get_contribution_catalog'")}
        this.api = { buildContributionContent, normalizeStoredModerationContent, describeEntityChanges,
            prepareEditedModerationContent, applyBenchmarkBatch, applyBenchmarkChange, mergePendingContributionCatalog };`, sandbox);
    return sandbox.api;
}

const condition = { clientRef: 'default', name: 'default', scoreDirection: 'higher', targetValue: null,
    usesPercentageScale: true, scoreMin: null, scoreMax: null, isDefault: true, isPrimary: true };

function newBenchmark() {
    return { type: 'new_benchmark', benchmarks: [{ clientRef: 'bench', existingBenchmarkID: null,
        existingBenchmarkRef: null, name: 'Example', introductionURL: '', reviewerNotes: '',
        conditions: [condition] }] };
}

function changeRequest() {
    const { clientRef, ...fields } = condition;
    assert.equal(clientRef, 'default');
    return { type: 'entity_change', targetKind: 'benchmark', targetID: 7, operation: 'update', reviewNotes: '',
        proposed: { name: 'Updated', introductionURL: '', notes: '', conditions: [{ ...fields, ID: 3 }] } };
}

function legacyChange(api, { tagOnly = false } = {}) {
    const content = api.buildContributionContent(changeRequest());
    const before = structuredClone(content.after);
    before.name = tagOnly ? content.after.name : 'Original';
    before.tags = ['old'];
    content.after.tags = ['new'];
    content.before = before;
    content.changes = api.describeEntityChanges(before, content.after);
    return content;
}

test('new benchmark submissions and change proposals reject tag fields', () => {
    const api = contract();
    const fresh = newBenchmark();
    assert.equal(Object.hasOwn(api.buildContributionContent(fresh).benchmarks[0], 'tags'), false);
    fresh.benchmarks[0].tags = ['old'];
    assert.throws(() => api.buildContributionContent(fresh),
        error => error.body.error === 'unknown_benchmark_field' && error.body.field === 'tags');
    const change = changeRequest();
    change.proposed.tags = [];
    assert.throws(() => api.buildContributionContent(change),
        error => error.body.error === 'unknown_change_proposal_field' && error.body.field === 'tags');
});

test('historical submissions retain tags but pending catalogues do not expose them', async () => {
    const api = contract();
    const saved = { ...newBenchmark(), schemaVersion: 6 };
    saved.benchmarks[0].tags = ['Historical'];
    const before = JSON.stringify(saved);
    const normalized = api.normalizeStoredModerationContent(saved);
    assert.deepEqual(Array.from(normalized.benchmarks[0].tags), ['Historical']);
    assert.equal(JSON.stringify(saved), before);
    const catalog = { benchmarks: [], models: [], vendors: [], categories: [], rankingDimensions: [] };
    await api.mergePendingContributionCatalog({}, catalog, [{ ID: 9, content: saved }], 1);
    assert.equal(catalog.benchmarks.length, 1);
    assert.equal(Object.hasOwn(catalog, 'knownTags'), false);
    assert.equal(Object.hasOwn(catalog.benchmarks[0], 'tags'), false);
    assert.equal(catalog.benchmarks[0].conditions[0].name, 'default');
});

test('approval of a historical benchmark creates conditions without touching tag tables', async () => {
    const api = contract();
    const saved = { ...newBenchmark(), schemaVersion: 6 };
    saved.benchmarks[0].tags = ['Historical'];
    const content = api.normalizeStoredModerationContent(saved);
    const calls = [];
    const connection = { async execute(sql) {
        calls.push(sql);
        if (/SELECT ID FROM benchmarks WHERE name/.test(sql)) return [[]];
        if (/INSERT INTO benchmarks/.test(sql)) return [{ insertId: 7 }];
        if (/INSERT INTO benchmark_conditions/.test(sql)) return [{ affectedRows: 1 }];
        throw new Error(`Unexpected SQL: ${sql}`);
    } };
    await api.applyBenchmarkBatch(connection, content);
    assert.equal(calls.length, 3);
    assert.ok(calls.every(sql => !/benchmark_tags|benchmark_tag_links/.test(sql)));
    assert.deepEqual(Array.from(content.benchmarks[0].tags), ['Historical']);
});

test('moderator edits preserve historical tags without allowing tag changes or new tags', () => {
    const api = contract();
    const original = legacyChange(api);
    const normalized = api.normalizeStoredModerationContent(original);
    assert.deepEqual(Array.from(normalized.changes, item => item.field), ['name', 'tags']);
    const edited = structuredClone(original);
    delete edited.before.tags;
    delete edited.after.tags;
    edited.after.notes = 'Reviewer note';
    const result = api.prepareEditedModerationContent(original, edited, 5, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(Array.from(result.before.tags), ['old']);
    assert.deepEqual(Array.from(result.after.tags), ['new']);
    assert.deepEqual(Array.from(result.moderation.originalContent.before.tags), ['old']);
    assert.equal(result.after.notes, 'Reviewer note');
    const tampered = structuredClone(original);
    tampered.after.tags = ['tampered'];
    assert.throws(() => api.prepareEditedModerationContent(original, tampered, 5, '2026-01-01T00:00:00.000Z'),
        error => error.body.error === 'legacy_benchmark_tags_immutable');

    const fresh = api.buildContributionContent(newBenchmark());
    const added = structuredClone(fresh);
    added.benchmarks[0].tags = ['new'];
    assert.throws(() => api.prepareEditedModerationContent(fresh, added, 5, '2026-01-01T00:00:00.000Z'),
        error => error.body.error === 'legacy_benchmark_tags_immutable');

    const historical = structuredClone(fresh);
    historical.benchmarks[0].tags = ['Historical'];
    const historicalEdit = structuredClone(historical);
    delete historicalEdit.benchmarks[0].tags;
    historicalEdit.benchmarks[0].reviewerNotes = 'Updated';
    const saved = api.prepareEditedModerationContent(historical, historicalEdit, 5, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(Array.from(saved.benchmarks[0].tags), ['Historical']);
    assert.deepEqual(Array.from(saved.moderation.originalContent.benchmarks[0].tags), ['Historical']);
});

test('legacy benchmark changes ignore historical tags for staleness and never write links', async () => {
    let current;
    const api = contract({
        loadBenchmarkChangeTarget: async () => structuredClone(current),
        validateEntityChangeProposal: async (_connection, content) => ({
            conditionKeys: new Map(content.after.conditions.map(item => [item.ID, 'default']))
        })
    });
    const content = api.normalizeStoredModerationContent(legacyChange(api));
    current = structuredClone(content.before);
    delete current.tags;
    const statements = [];
    const connection = { async execute(sql) { statements.push(sql); return [{ affectedRows: 1 }]; } };
    await api.applyBenchmarkChange(connection, content);
    assert.ok(statements.some(sql => /UPDATE benchmarks/.test(sql)));
    assert.ok(statements.every(sql => !/benchmark_tags|benchmark_tag_links/.test(sql)));

    current.name = 'Changed since submission';
    await assert.rejects(api.applyBenchmarkChange(connection, content),
        error => error.body.error === 'change_target_modified_since_submission');

    const tagOnly = api.normalizeStoredModerationContent(legacyChange(api, { tagOnly: true }));
    current = structuredClone(tagOnly.before);
    delete current.tags;
    const count = statements.length;
    await assert.rejects(api.applyBenchmarkChange(connection, tagOnly),
        error => error.body.error === 'benchmark_tag_change_removed');
    assert.equal(statements.length, count);
});

test('admin explorer rejects the obsolete entity without accessing the database', async () => {
    const connection = { async execute() { throw new Error('Unexpected database access'); } };
    for (const read of [queryAdminDataExplorer, queryAdminDataRecord]) {
        await assert.rejects(read(connection, { entity: 'benchmark_tags', id: 1 }),
            error => error.body.error === 'invalid_explorer_entity');
    }
});

test('ranking cache and Arena import have no tag-table dependency', () => {
    assert.ok(RANKING_DATA_TABLES.every(table => !table.startsWith('benchmark_tag')));
    assert.ok(rankingCacheTriggers.every(trigger => !trigger.table.startsWith('benchmark_tag')));
    assert.doesNotMatch(importer, /benchmark_tags|benchmark_tag_links/);
    assert.match(importer, /score_fields/);
    assert.match(importer, /score_source='arena_official'/);
});
