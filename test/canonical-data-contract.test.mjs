import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import {
    PIE_TOTAL_BASIS_POINTS,
    loadPublicPie,
    scoreModels
} from '../ranking-service.js';

const serverSource = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

function sourceBetween(startMarker, endMarker) {
    const start = serverSource.indexOf(startMarker);
    const end = serverSource.indexOf(endMarker, start);
    assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
    assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
    return serverSource.slice(start, end);
}

function loadSubmissionContract() {
    const sandbox = vm.createContext({ URL, crypto, structuredClone });
    const source = sourceBetween('function normalizeString(', 'function parseModerationContent(');
    vm.runInContext(`${source}\nthis.contract = { buildContributionContent };`, sandbox);
    return sandbox.contract;
}

function loadPersistenceContract(overrides = {}) {
    const sandbox = vm.createContext({
        JSON,
        Number,
        Set,
        slugifyIdentifier(value, fallback) {
            const slug = String(value)
                .trim()
                .toLocaleLowerCase('en-US')
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '');
            return slug || fallback;
        },
        async resolveApprovedEntityReference() {
            throw new Error('Unexpected pending reference');
        },
        async materializeResultReferences(_connection, result) {
            return result;
        },
        async resolveResultBenchmarkCondition(_connection, result) {
            return {
                ID: result.benchmarkConditionID,
                benchmark_ID: result.benchmarkID,
                name: 'default',
                uses_percentage_scale: 1,
                score_min: null,
                score_max: null,
                score_direction: 'higher',
                target_value: null
            };
        },
        async loadResultModel(_connection, result) {
            return result.modelID;
        },
        async loadResultModelCondition(_connection, result, modelID) {
            return {
                ID: result.modelConditionID,
                model_ID: modelID,
                name: 'default'
            };
        },
        ...overrides
    });
    const benchmarkPersistence = sourceBetween(
        'async function insertSubmittedBenchmarkCondition(',
        'async function insertSubmittedModelCondition('
    );
    const snapshots = sourceBetween(
        'function benchmarkConditionSnapshot(',
        'async function resolveResultBenchmarkCondition('
    );
    const resultPersistence = sourceBetween(
        'async function applyBenchmarkResult(',
        'async function applyModerationContent('
    );
    vm.runInContext(`
        ${benchmarkPersistence}
        ${snapshots}
        ${resultPersistence}
        this.persistence = { applyBenchmarkBatch, applyBenchmarkResult };
    `, sandbox);
    return sandbox.persistence;
}

function loadResultConditionResolver() {
    const sandbox = vm.createContext({ Boolean, Number });
    const source = sourceBetween(
        'async function resolveResultBenchmarkCondition(',
        'async function loadResultModel('
    );
    vm.runInContext(`${source}\nthis.resolveResultBenchmarkCondition = resolveResultBenchmarkCondition;`, sandbox);
    return sandbox.resolveResultBenchmarkCondition;
}

function benchmarkCondition(overrides = {}) {
    return {
        clientRef: 'condition-default',
        name: 'default',
        scoreDirection: 'higher',
        targetValue: null,
        usesPercentageScale: true,
        isDefault: true,
        ...overrides
    };
}

function newBenchmarkSubmission() {
    return {
        type: 'new_benchmark',
        benchmarks: [{
            clientRef: 'benchmark-one',
            existingBenchmarkID: null,
            existingBenchmarkRef: null,
            name: 'CanonicalBench',
            introductionURL: 'https://example.com/canonical-bench',
            tags: ['Benchmark', 'Reasoning', 'benchmark'],
            reviewerNotes: '',
            conditions: [
                benchmarkCondition(),
                benchmarkCondition({
                    clientRef: 'condition-unbounded',
                    name: 'custom range',
                    usesPercentageScale: false,
                    scoreMin: -20,
                    scoreMax: 80,
                    isDefault: false
                })
            ]
        }]
    };
}

function benchmarkResultSubmission() {
    return {
        type: 'benchmark_result',
        reviewerNotes: '',
        results: [{
            clientRef: 'result-one',
            modelID: 4,
            modelRef: null,
            modelConditionID: 5,
            modelConditionRef: null,
            benchmarkID: 6,
            benchmarkRef: null,
            benchmarkConditionID: 7,
            benchmarkConditionRef: null,
            rawScore: 82.5,
            source: {
                type: 'vendor_official',
                url: 'https://example.com/results/one',
                title: 'Official result one'
            }
        }, {
            clientRef: 'result-two',
            modelID: 8,
            modelRef: null,
            modelConditionID: 9,
            modelConditionRef: null,
            benchmarkID: 10,
            benchmarkRef: null,
            benchmarkConditionID: 11,
            benchmarkConditionRef: null,
            rawScore: 71,
            source: {
                type: 'third_party_lab',
                url: 'https://example.com/results/two',
                title: 'Independent result two'
            }
        }]
    };
}

function normalizedSQL(sql) {
    return String(sql).replace(/\s+/g, ' ').trim();
}

test('canonical benchmark submission persists conditions, multiple tags, and explicit custom anchors', async () => {
    const content = loadSubmissionContract().buildContributionContent(newBenchmarkSubmission());
    assert.equal(content.type, 'new_benchmark');
    assert.deepEqual(Array.from(content.benchmarks[0].tags), ['Benchmark', 'Reasoning']);
    assert.equal(content.benchmarks[0].conditions[0].usesPercentageScale, true);
    assert.equal(content.benchmarks[0].conditions[0].scoreMin, null);
    assert.equal(content.benchmarks[0].conditions[0].scoreMax, null);
    assert.equal(content.benchmarks[0].conditions[1].scoreMin, -20);
    assert.equal(content.benchmarks[0].conditions[1].scoreMax, 80);

    const calls = [];
    let nextTagID = 100;
    const connection = {
        async execute(sql, params = []) {
            const statement = normalizedSQL(sql);
            calls.push({ statement, params: structuredClone(params) });
            if (statement.startsWith('SELECT ID FROM benchmarks WHERE name =')) {
                return [[], []];
            }
            if (statement.startsWith('INSERT INTO benchmarks ')) {
                return [{ insertId: 41 }, []];
            }
            if (statement.startsWith('SELECT ID, name, is_active FROM benchmark_tags')) {
                return [[], []];
            }
            if (statement.startsWith('INSERT INTO benchmark_tags ')) {
                nextTagID += 1;
                return [{ insertId: nextTagID }, []];
            }
            if (statement.startsWith('SELECT 1 FROM benchmark_tag_links')) {
                return [[], []];
            }
            if (statement.startsWith('INSERT INTO benchmark_tag_links ')
                || statement.startsWith('INSERT INTO benchmark_conditions ')) {
                return [{ affectedRows: 1 }, []];
            }
            throw new Error(`Unexpected SQL: ${statement}`);
        }
    };

    await loadPersistenceContract().applyBenchmarkBatch(connection, content);

    const benchmarkInsert = calls.find(call => call.statement.startsWith('INSERT INTO benchmarks '));
    assert.deepEqual(benchmarkInsert.params, [
        'CanonicalBench',
        'https://example.com/canonical-bench'
    ]);
    const conditionInserts = calls.filter(call => (
        call.statement.startsWith('INSERT INTO benchmark_conditions ')
    ));
    assert.equal(conditionInserts.length, 2);
    assert.deepEqual(conditionInserts[0].params.slice(5, 8), [1, null, null]);
    assert.deepEqual(conditionInserts[1].params.slice(5, 8), [0, -20, 80]);
    assert.equal(calls.filter(call => (
        call.statement.startsWith('INSERT INTO benchmark_tag_links ')
    )).length, 2);
    assert.ok(calls.every(call => !/\bobjects\b|evaluation_profiles|evaluation_results/.test(call.statement)));
});

test('canonical result persistence is context-free and keeps a source on every score row', async () => {
    const contract = loadSubmissionContract();
    const content = contract.buildContributionContent(benchmarkResultSubmission());
    assert.equal(content.schemaVersion, 6);
    assert.equal(Object.hasOwn(content, 'context'), false);

    const legacy = {
        ...benchmarkResultSubmission(),
        context: { categoryID: 3, contextValues: { web: 'allowed' } }
    };
    assert.throws(
        () => contract.buildContributionContent(legacy),
        error => error?.body?.error === 'unknown_submission_field'
            && error?.body?.field === 'context'
    );

    const calls = [];
    const connection = {
        async execute(sql, params = []) {
            const statement = normalizedSQL(sql);
            calls.push({ statement, params: structuredClone(params) });
            if (statement.startsWith('SELECT ID FROM benchmark_results ')) {
                return [[], []];
            }
            if (statement.startsWith('INSERT INTO benchmark_results ')) {
                return [{ insertId: calls.length }, []];
            }
            throw new Error(`Unexpected SQL: ${statement}`);
        }
    };
    const persistence = loadPersistenceContract();
    await persistence.applyBenchmarkResult(connection, content, {
        submittedBy: 12,
        moderationLogID: 34
    });
    await persistence.applyBenchmarkResult(connection, content, {
        submittedBy: 13,
        moderationLogID: 35
    });

    const inserts = calls.filter(call => call.statement.startsWith('INSERT INTO benchmark_results '));
    assert.equal(inserts.length, 4);
    assert.equal(calls.some(call => call.statement.startsWith('UPDATE benchmark_results ')), false);
    assert.equal(calls.some(call => call.statement.startsWith('SELECT ID FROM benchmark_results ')), false);
    assert.match(inserts[0].statement, /source_url, source_type, source_title/);
    assert.doesNotMatch(inserts[0].statement, /ranking_context_ID/);
    assert.equal(inserts[0].params[5], 'https://example.com/results/one');
    assert.equal(inserts[0].params[6], 'vendor_official');
    assert.equal(inserts[1].params[5], 'https://example.com/results/two');
    assert.equal(inserts[1].params[6], 'third_party_lab');
    assert.notEqual(inserts[0].params[5], inserts[1].params[5]);
    assert.equal(inserts[2].params[5], inserts[0].params[5]);
    assert.equal(inserts[3].params[5], inserts[1].params[5]);
    assert.ok(calls.every(call => !/evaluation_results|evaluation_profiles|model_configurations/.test(call.statement)));
});

test('custom scores may exceed normalization anchors while percentage scores remain bounded', async () => {
    const resolveCondition = loadResultConditionResolver();
    const customConnection = {
        async execute() {
            return [[{
                ID: 7,
                benchmark_ID: 6,
                uses_percentage_scale: 0,
                score_min: 0,
                score_max: 100
            }], []];
        }
    };
    const custom = await resolveCondition(customConnection, {
        benchmarkID: 6,
        benchmarkConditionID: 7,
        rawScore: 140
    });
    assert.equal(custom.ID, 7);

    const percentageConnection = {
        async execute() {
            return [[{
                ID: 8,
                benchmark_ID: 6,
                uses_percentage_scale: 1,
                score_min: null,
                score_max: null
            }], []];
        }
    };
    await assert.rejects(
        resolveCondition(percentageConnection, {
            benchmarkID: 6,
            benchmarkConditionID: 8,
            rawScore: 101
        }),
        error => error?.body?.error === 'score_out_of_range'
            && error?.body?.scoreMin === 0
            && error?.body?.scoreMax === 100
    );
});

test('public weights average participants across the subtree and drive model score intervals', async () => {
    const connection = {
        async execute(sql) {
            if (sql.includes('WITH RECURSIVE category_scope')) {
                return [[
                    { ID: 10, category_ID: 1, context_values: '{}' },
                    { ID: 11, category_ID: 2, context_values: '{}' }
                ], []];
            }
            if (sql.includes('FROM personal_pies')) {
                return [[
                    { pie_ID: 1, context_ID: 10, benchmark_condition_ID: 21, weight_basis_points: 6000 },
                    { pie_ID: 1, context_ID: 10, benchmark_condition_ID: 22, weight_basis_points: 4000 },
                    { pie_ID: 2, context_ID: 11, benchmark_condition_ID: 21, weight_basis_points: 2000 },
                    { pie_ID: 2, context_ID: 11, benchmark_condition_ID: 22, weight_basis_points: 8000 }
                ], []];
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        }
    };
    const publicPie = await loadPublicPie(
        connection,
        { categoryID: 1, dimensions: [], contextValues: {} },
        new Map([[21, {}], [22, {}]])
    );
    assert.equal(publicPie.participantCount, 2);
    assert.deepEqual(publicPie.entries, [
        { conditionID: 21, weightBasisPoints: 4000 },
        { conditionID: 22, weightBasisPoints: 6000 }
    ]);

    const models = [{
        ID: 31,
        modelID: 30,
        name: 'Interval Model',
        vendor: 'Example Lab',
        vendorSlug: 'example-lab',
        logoKey: '',
        introductionURL: '',
        condition: { ID: 31, name: 'default' },
        results: new Map([
            ['21', { normalizedScore: 80, sampleCount: 1 }],
            ['22', { normalizedScore: 50, sampleCount: 1 }]
        ])
    }];
    const scored = scoreModels(
        models,
        publicPie.scoringEntries,
        publicPie.participantCount * PIE_TOTAL_BASIS_POINTS
    );
    assert.equal(scored[0].lower, 62);
    assert.equal(scored[0].upper, 62);
    assert.equal(scored[0].coverage, 100);
    assert.equal(scored[0].resultCount, 2);
});
