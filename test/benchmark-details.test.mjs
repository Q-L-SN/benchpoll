import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { getBenchmarkInformation, markBenchmarkScoresUpdated } from '../benchmark-details.js';

test('public information validates a single live condition and returns text separately from notes', async () => {
    const connection = { async execute(sql, values) {
        assert.match(sql, /c.deleted_at IS NULL AND b.is_active=1/);
        assert.match(sql, /b.description/);
        assert.match(sql, /c.difference_explanation/);
        assert.match(sql, /c.is_primary AS isPrimaryCondition/);
        assert.doesNotMatch(sql, /b.notes/);
        assert.deepEqual(values, [10]);
        return [[{ benchmarkID: 2, conditionID: 10, name: 'Bench', conditionName: 'default',
            description: 'Public introduction', isPrimaryCondition: 1, differenceExplanation: 'Uses the held-out split rather than the training split.', requestOfficialSync: 1, scoresUpdatedAt: null }]];
    } };
    const information = await getBenchmarkInformation(connection, { conditionID: 10 });
    assert.equal(information.description, 'Public introduction');
    assert.equal(information.differenceExplanation, 'Uses the held-out split rather than the training split.');
    assert.equal(information.requestOfficialSync, true);
    assert.equal(information.isPrimaryCondition, true);
    for (const body of [{}, { conditionID: 0 }, { conditionID: 1.2 }, { conditionID: 10, source: 'anything' }]) {
        await assert.rejects(getBenchmarkInformation(connection, body), error => error.body.error === 'benchmark_condition_required');
    }
    await assert.rejects(getBenchmarkInformation({ async execute() { return [[]]; } }, { conditionID: 10 }),
        error => error.status === 404);
});

test('score timestamps update distinct valid benchmark IDs and a no-op does not touch them', async () => {
    const calls = [];
    const connection = { async query(sql, values) { calls.push({ sql, values }); } };
    await markBenchmarkScoresUpdated(connection, []);
    assert.equal(calls.length, 0);
    await markBenchmarkScoresUpdated(connection, [2, 2, 3]);
    assert.deepEqual(calls[0].values, [[2, 3]]);
    await assert.rejects(markBenchmarkScoresUpdated(connection, [0]), /Invalid score-update benchmark IDs/);
});

test('AA information keeps navigable identity but redacts descriptions and score metadata', async () => {
    for (const identity of [
        { name: 'AA-Intelligence', conditionName: 'Overall', conditionKey: 'default' },
        { name: 'Independent benchmark', conditionName: 'Third-party run', conditionKey: 'aa-standard' },
        { name: 'Independent benchmark', conditionName: 'Artificial Analysis harness', conditionKey: 'custom' }
    ]) {
        const connection = { async execute() { return [[{ ...identity, benchmarkID: 2, conditionID: 10,
            description: 'Restricted introduction', differenceExplanation: 'Restricted version details',
            introductionURL: 'https://example.org/benchmark', scoreSource: 'Restricted source',
            scoresUpdatedAt: '2026-10-31T00:00:00Z', isPrimaryCondition: 1, requestOfficialSync: 1 }]]; } };
        const information = await getBenchmarkInformation(connection, { conditionID: 10 });
        assert.equal(information.displayRestriction, 'artificial_analysis');
        assert.equal(information.name, identity.name);
        assert.equal(information.conditionName, identity.conditionName);
        assert.equal(information.introductionURL, 'https://example.org/benchmark');
        assert.equal(information.description, '');
        assert.equal(information.differenceExplanation, '');
        assert.equal(information.scoreSource, null);
        assert.equal(information.scoresUpdatedAt, null);
        assert.equal(information.requestOfficialSync, false);
        assert.equal(Object.hasOwn(information, 'conditionKey'), false);
        assert.doesNotMatch(JSON.stringify(information), /Restricted/);
    }
});

test('a secondary version is explicitly identified rather than inferred from its name', async () => {
    const connection = { async execute() {
        return [[{ benchmarkID: 2, conditionID: 11, name: 'Bench', conditionName: 'overall',
            isPrimaryCondition: 0, differenceExplanation: 'Tests the extended dataset.' }]];
    } };
    const information = await getBenchmarkInformation(connection, { conditionID: 11 });
    assert.equal(information.isPrimaryCondition, false);
});

test('a renamed audited AA variant is restricted even without AA in either display name', async () => {
    const information = await getBenchmarkInformation({ async execute() {
        return [[{ benchmarkID: 1428, conditionID: 2255, name: 'Tau3-Banking', conditionName: 'Banking',
            conditionKey: 'crawl-151562e6b464d951cfafd948', description: 'Hidden details', isPrimaryCondition: 0 }]];
    } }, { conditionID: 2255 });
    assert.equal(information.displayRestriction, 'artificial_analysis');
    assert.equal(information.description, '');
});

test('approved corrections never advance the score-publication timestamp', () => {
    const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    const apply = source.slice(source.indexOf('async function applyBenchmarkResult('), source.indexOf('async function applyModerationContent('));
    assert.match(apply, /if \(metadata.editingResultID\) \{\s*await recordSyncedScoreEdit[\s\S]*?\} else \{\s*await markBenchmarkScoresUpdated/);
    const change = source.slice(source.indexOf('async function applyBenchmarkChange('), source.indexOf('async function applyModelChange('));
    assert.doesNotMatch(change, /scores_updated_at|markBenchmarkScoresUpdated/);
});

test('forms have no category tree or dormant tree-selection plumbing', () => {
    const source = fs.readFileSync(new URL('../public/js/contribute.js', import.meta.url), 'utf8');
    const html = fs.readFileSync(new URL('../private/contribute.html', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /contribution-tree|tree-mode-note|contribution-template-picker/);
    assert.doesNotMatch(source, /renderCategoryTree|categorySelectionActive|beginParentSelection|draft\.category/);
    for (const field of ['description', 'requestOfficialSync', 'officialSyncURL', 'officialSyncInstructions']) {
        assert.match(source, new RegExp('data-field="' + field + '"'));
    }
});
