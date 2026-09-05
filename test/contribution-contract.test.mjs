import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const serverSource = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

test('application-level request rate limiting is disabled', () => {
    assert.doesNotMatch(serverSource, /express-rate-limit|RATE_LIMIT_WINDOW_MINUTES|RATE_LIMIT_MAX_REQUESTS|app\.use\(limiter\)/);
});

function sourceBetween(startMarker, endMarker) {
    const start = serverSource.indexOf(startMarker);
    const end = serverSource.indexOf(endMarker, start);
    assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
    assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
    return serverSource.slice(start, end);
}

function loadContract() {
    const sandbox = vm.createContext({ URL, crypto, structuredClone });
    const source = sourceBetween('function normalizeString(', 'function parseModerationContent(');
    vm.runInContext(`${source}\nthis.contract = { buildContributionContent };`, sandbox);
    return sandbox.contract;
}

function benchmarkCondition(overrides = {}) {
    return {
        clientRef: 'condition-default',
        name: 'default',
        scoreDirection: 'higher',
        targetValue: null,
        usesPercentageScale: false,
        scoreMin: 0,
        scoreMax: 100,
        isDefault: true,
        ...overrides
    };
}

function newBenchmark(overrides = {}) {
    return {
        type: 'new_benchmark',
        benchmarks: [{
            clientRef: 'benchmark-one',
            existingBenchmarkID: null,
            existingBenchmarkRef: null,
            name: 'StrictBench',
            introductionURL: '',
            tags: ['Benchmark', 'Reasoning', 'benchmark'],
            reviewerNotes: '',
            conditions: [benchmarkCondition()],
            ...overrides
        }]
    };
}

function benchmarkResult(overrides = {}) {
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
                url: 'https://example.com/results',
                title: 'Official results'
            }
        }],
        ...overrides
    };
}

test('new benchmark keeps multiple tags and explicit custom normalization anchors', () => {
    const content = loadContract().buildContributionContent(newBenchmark());
    assert.equal(content.schemaVersion, 5);
    assert.equal(content.type, 'new_benchmark');
    assert.deepEqual(Array.from(content.benchmarks[0].tags), ['Benchmark', 'Reasoning']);
    assert.equal(content.benchmarks[0].conditions[0].scoreMin, 0);
    assert.equal(content.benchmarks[0].conditions[0].scoreMax, 100);
    assert.equal(content.benchmarks[0].conditions[0].usesPercentageScale, false);
});

test('condition default identity comes only from the literal default name', () => {
    const contract = loadContract();
    const withoutDefault = contract.buildContributionContent(newBenchmark({
        conditions: [benchmarkCondition({
            clientRef: 'condition-private',
            name: 'private set',
            isDefault: false
        })]
    }));
    assert.equal(withoutDefault.benchmarks[0].conditions[0].isDefault, false);

    assert.throws(() => contract.buildContributionContent(newBenchmark({
        conditions: [benchmarkCondition({ name: 'with tools', isDefault: true })]
    })), error => error?.body?.error === 'benchmark_condition_default_mismatch');
    assert.throws(() => contract.buildContributionContent(newBenchmark({
        conditions: [benchmarkCondition({ name: 'default', isDefault: false })]
    })), error => error?.body?.error === 'benchmark_condition_default_mismatch');
});

test('percentage scale is explicit and cannot persist a score range', () => {
    const contract = loadContract();
    const content = contract.buildContributionContent(newBenchmark({
        conditions: [benchmarkCondition({
            usesPercentageScale: true,
            scoreMin: null,
            scoreMax: null
        })]
    }));
    assert.equal(content.benchmarks[0].conditions[0].scoreMin, null);
    assert.equal(content.benchmarks[0].conditions[0].scoreMax, null);

    assert.throws(() => contract.buildContributionContent(newBenchmark({
        conditions: [benchmarkCondition({
            usesPercentageScale: true,
            scoreMin: 0,
            scoreMax: 100
        })]
    })), error => error?.body?.error === 'percentage_score_range_must_be_empty');

    assert.throws(() => contract.buildContributionContent(newBenchmark({
        conditions: [benchmarkCondition({ usesPercentageScale: undefined })]
    })), error => error?.body?.error === 'boolean_required');
});

test('custom normalization requires both bounds and never invents a missing value', () => {
    const contract = loadContract();
    assert.throws(() => contract.buildContributionContent(newBenchmark({
        conditions: [benchmarkCondition({ scoreMax: null })]
    })), error => error?.body?.error === 'score_range_required');
    assert.throws(() => contract.buildContributionContent(newBenchmark({
        conditions: [benchmarkCondition({ scoreMin: null })]
    })), error => error?.body?.error === 'score_range_required');
    assert.throws(() => contract.buildContributionContent(newBenchmark({
        conditions: [benchmarkCondition({ scoreMin: null, scoreMax: null })]
    })), error => error?.body?.error === 'score_range_required');
    assert.throws(() => contract.buildContributionContent(newBenchmark({
        conditions: [benchmarkCondition({ scoreMin: 5, scoreMax: 5 })]
    })), error => error?.body?.error === 'invalid_score_range');
});

test('changing normalization anchors does not reject accepted custom scores outside them', () => {
    const guard = sourceBetween(
        'async function assertBenchmarkConditionSetCanChange(',
        'async function assertModelConditionSetCanChange('
    );
    assert.doesNotMatch(guard, /raw_score\s*[<>]|rangeClauses|range_conflicts_with_results/);
    assert.match(guard, /benchmark_condition_in_use/);
});

test('closer-to-target conditions require a valid target in their declared scale', () => {
    const contract = loadContract();
    assert.throws(() => contract.buildContributionContent(newBenchmark({
        conditions: [benchmarkCondition({
            scoreDirection: 'closer_to_target',
            targetValue: null,
            usesPercentageScale: true,
            scoreMin: null,
            scoreMax: null
        })]
    })), error => error?.body?.error === 'invalid_score_target');
    const content = contract.buildContributionContent(newBenchmark({
        conditions: [benchmarkCondition({
            scoreDirection: 'closer_to_target',
            targetValue: 50,
            usesPercentageScale: true,
            scoreMin: null,
            scoreMax: null
        })]
    }));
    assert.equal(content.benchmarks[0].conditions[0].targetValue, 50);
});

test('old evaluation and profile payload fields are rejected instead of translated', () => {
    const contract = loadContract();
    assert.throws(() => contract.buildContributionContent({
        type: 'new_evaluation',
        evaluations: []
    }), error => error?.status === 400);
    assert.throws(() => contract.buildContributionContent(newBenchmark({
        profiles: [],
        conditions: undefined
    })), error => error?.body?.error === 'unknown_benchmark_field' && error?.body?.field === 'profiles');
    assert.throws(() => contract.buildContributionContent(newBenchmark({
        objectType: 'benchmark'
    })), error => error?.body?.error === 'unknown_benchmark_field' && error?.body?.field === 'objectType');
});

test('new models use only model conditions and canonical introduction URL', () => {
    const contract = loadContract();
    const content = contract.buildContributionContent({
        type: 'new_model',
        models: [{
            clientRef: 'model-one',
            existingModelID: null,
            existingModelRef: null,
            name: 'Model One',
            introductionURL: 'https://example.com/model',
            reviewerNotes: '',
            vendor: {
                existingVendorID: null,
                existingVendorRef: null,
                name: 'Example Lab',
                logoKey: ''
            },
            conditions: [{ clientRef: 'model-condition-default', name: 'default', isDefault: true }]
        }]
    });
    assert.equal(content.models[0].introductionURL, 'https://example.com/model');
    assert.deepEqual(JSON.parse(JSON.stringify(content.models[0].conditions)), [{
        clientRef: 'model-condition-default',
        name: 'default',
        isDefault: true
    }]);
    assert.throws(() => contract.buildContributionContent({
        type: 'new_model',
        models: [{
            clientRef: 'model-one',
            name: 'Model One',
            vendor: { name: 'Example Lab' },
            configurations: []
        }]
    }), error => error?.body?.error === 'unknown_model_field' && error?.body?.field === 'configurations');

    const modelWithoutDefault = contract.buildContributionContent({
        type: 'new_model',
        models: [{
            clientRef: 'model-two',
            existingModelID: null,
            existingModelRef: null,
            name: 'Model Two',
            introductionURL: '',
            reviewerNotes: '',
            vendor: {
                existingVendorID: null,
                existingVendorRef: null,
                name: 'Example Lab Two',
                logoKey: ''
            },
            conditions: [{ clientRef: 'model-condition-high', name: 'high reasoning', isDefault: false }]
        }]
    });
    assert.equal(modelWithoutDefault.models[0].conditions[0].isDefault, false);
    assert.throws(() => contract.buildContributionContent({
        type: 'new_model',
        models: [{
            clientRef: 'model-three',
            existingModelID: null,
            existingModelRef: null,
            name: 'Model Three',
            introductionURL: '',
            reviewerNotes: '',
            vendor: {
                existingVendorID: null,
                existingVendorRef: null,
                name: 'Example Lab Three',
                logoKey: ''
            },
            conditions: [{ clientRef: 'model-condition-wrong', name: 'high reasoning', isDefault: true }]
        }]
    }), error => error?.body?.error === 'model_condition_default_mismatch');
});

test('new category submissions preserve their final reviewer notes', () => {
    const content = loadContract().buildContributionContent({
        type: 'new_category',
        requestKind: 'category',
        clientRef: 'category-reliability',
        name: 'Reliability',
        parentPath: 'AI Evaluation',
        parentCategoryID: 1,
        parentCategoryRef: null,
        pageURL: 'https://benchpoll.com/',
        details: 'Place this next to the existing safety category.',
        contextOrder: [],
        options: []
    });

    assert.equal(content.details, 'Place this next to the existing safety category.');
});

test('every benchmark result carries its own required source URL', () => {
    const contract = loadContract();
    const content = contract.buildContributionContent(benchmarkResult());
    assert.equal(content.type, 'benchmark_result');
    assert.equal(content.results[0].rawScore, 82.5);
    assert.equal(content.results[0].source.url, 'https://example.com/results');

    const missingSource = benchmarkResult();
    delete missingSource.results[0].source;
    assert.throws(
        () => contract.buildContributionContent(missingSource),
        error => error?.body?.error === 'result_source_required'
    );

    assert.throws(() => contract.buildContributionContent(benchmarkResult({
        sourceURL: 'https://example.com/shared'
    })), error => error?.body?.error === 'unknown_submission_field' && error?.body?.field === 'sourceURL');
});

test('benchmark results are global evidence and reject ranking context fields', () => {
    const contract = loadContract();
    const content = contract.buildContributionContent(benchmarkResult());
    assert.equal(content.schemaVersion, 6);
    assert.equal(Object.hasOwn(content, 'context'), false);

    const oldContext = benchmarkResult({
        context: {
            categoryID: 3,
            contextValues: { web: 'allowed' }
        }
    });
    assert.throws(
        () => contract.buildContributionContent(oldContext),
        error => error?.body?.error === 'unknown_submission_field' && error?.body?.field === 'context'
    );
});

test('duplicate result identity in one batch is rejected', () => {
    const contract = loadContract();
    const request = benchmarkResult();
    request.results.push({ ...structuredClone(request.results[0]), clientRef: 'result-two' });
    assert.throws(
        () => contract.buildContributionContent(request),
        error => error?.body?.error === 'duplicate_result_identity'
    );
});

test('runtime SQL uses strict benchmark tables and stores a source on each result row', () => {
    assert.match(serverSource, /INSERT INTO benchmark_results[\s\S]*source_url, source_type, source_title/);
    const resultInsert = sourceBetween('async function applyBenchmarkResult(', 'async function applyModerationContent(');
    assert.doesNotMatch(resultInsert, /ranking_context_ID|materializeContributionContext/);
    assert.match(serverSource, /INSERT INTO benchmark_conditions/);
    assert.match(serverSource, /INSERT INTO benchmark_tag_links/);
    assert.match(serverSource, /INSERT INTO model_conditions/);
    assert.doesNotMatch(serverSource, /\bFROM objects\b|\bINTO objects\b|evaluation_profiles|evaluation_results|model_configurations|category_templates|\bvotes\b/);
});

test('submission endpoint requires a verified email and senior review uses the same contribution path', () => {
    const endpoint = sourceBetween("API.post('/submit_contribution'", 'function pendingCatalogReference(');
    assert.match(endpoint, /SELECT email FROM users WHERE ID = \? LIMIT 1/);
    assert.match(endpoint, /verified_email_required/);
    assert.match(endpoint, /if \(req\.user\.isSenior\)/);
    assert.match(endpoint, /await applyModerationContent\(workingConnection, content/);
});
