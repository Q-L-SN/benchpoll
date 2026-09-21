import { frontendSource } from './helpers/frontend-source.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function read(path) {
    return fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function between(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
    assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
    return source.slice(start, end);
}

const server = read('server.js');
const ranking = read('ranking-service.js');
const contributionClient = frontendSource('public/js/contribute.js');
const strictSchema = read('scripts/migrate-strict-benchmark-schema.mjs');
const migration = read('scripts/migrate-context-free-results.mjs');

test('benchmark result storage has no ranking-context identity', () => {
    const applyResult = between(
        server,
        'async function applyBenchmarkResult(',
        'async function applyModerationContent('
    );
    const loadModels = between(
        ranking,
        'export async function loadModels(',
        'export async function getRankingWorkspace('
    );

    assert.doesNotMatch(strictSchema, /ranking_context_ID/);
    assert.doesNotMatch(applyResult, /ranking_context_ID|materializeContributionContext/);
    assert.doesNotMatch(loadModels, /ranking_context_ID|ranking_contexts|contextIDs/);
    assert.match(loadModels, /resultKey\(row\.benchmark_condition_ID\)/);
});

test('score submissions reject legacy context instead of silently translating it', () => {
    const normalizeBatch = between(
        server,
        'function normalizeBenchmarkResultBatch(',
        'function splitCategoryPath('
    );
    const scoreForm = between(
        contributionClient,
        'function resultsStep(',
        'function categoryDetailsStep('
    );
    const scorePayload = between(
        contributionClient,
        'function resultsPayload(',
        'function submissionPayload('
    );

    assert.match(normalizeBatch, /assertAllowedRecordKeys\(body, \['type', 'reviewerNotes', 'results'\]\)/);
    assert.doesNotMatch(normalizeBatch, /contextValues|categoryID|rankingContext/);
    assert.doesNotMatch(scoreForm, /Category and context|start-context-selection/);
    assert.doesNotMatch(scorePayload, /\bcontext\s*:/);
});

test('context-free migration removes schema and moderation-log remnants', () => {
    assert.match(migration, /021_context_free_results/);
    assert.match(migration, /020_result_medians/);
    assert.match(migration, /DROP FOREIGN KEY/);
    assert.match(migration, /DROP INDEX/);
    assert.match(migration, /DROP COLUMN/);
    assert.match(migration, /content\.type === 'benchmark_result'/);
    assert.match(migration, /content\.targetKind === 'result'/);
    assert.match(migration, /verifyPostconditions/);
});

test('result change requests use the context-free schema version', () => {
    const entityChange = between(
        server,
        'function normalizeEntityChange(',
        'function buildContributionContent('
    );
    assert.match(entityChange, /schemaVersion: contributionSchemaVersion\('entity_change', targetKind\)/);
});
