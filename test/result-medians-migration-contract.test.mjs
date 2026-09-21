import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const migration = fs.readFileSync(
    new URL('../scripts/migrate-result-medians.mjs', import.meta.url),
    'utf8'
);
const strictSchema = fs.readFileSync(
    new URL('../scripts/migrate-strict-benchmark-schema.mjs', import.meta.url),
    'utf8'
);
const rankingService = fs.readFileSync(
    new URL('../ranking-service.js', import.meta.url),
    'utf8'
);
const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const integrityCheck = fs.readFileSync(
    new URL('../scripts/check-ranking-integrity.mjs', import.meta.url),
    'utf8'
);

test('result-median migration removes the one-accepted-result schema restriction', () => {
    assert.match(migration, /020_result_medians/);
    assert.match(migration, /DROP INDEX uq_benchmark_results_current_context/);
    assert.match(migration, /DROP COLUMN current_marker/);
    assert.doesNotMatch(strictSchema, /uq_benchmark_results_current_context|current_marker/);
    assert.doesNotMatch(integrityCheck, /accepted result identity duplicates/);
});

test('new score approval appends accepted evidence instead of replacing its peers', () => {
    const start = server.indexOf('async function applyBenchmarkResult(');
    const end = server.indexOf('async function applyModerationContent(', start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    const applyResult = server.slice(start, end);
    assert.match(applyResult, /INSERT INTO benchmark_results/);
    assert.match(applyResult, /score_evidence_already_exists/);
    assert.doesNotMatch(applyResult, /SET status = 'superseded'/);
    assert.doesNotMatch(applyResult, /multiple_accepted_results/);
});

test('ranking service groups accepted score samples and computes their median', () => {
    assert.match(rankingService, /medianOfFiniteNumbers\(samples\)/);
    assert.match(rankingService, /sampleCount: samples\.length/);
    assert.doesNotMatch(rankingService, /multiple_accepted_results/);
});
