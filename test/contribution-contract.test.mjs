import { normalizeScoreFieldRequests, normalizeFieldContribution } from '../score-field-service.js';
import { assertPrimaryCondition } from '../benchmark-primary-condition.js';
import { normalizeModelParameters, modelParameterLabel, parameterRowsToObject } from '../public/js/shared/model-parameters.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { normalizeDiscussionReport } from '../discussion-service.js';

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
    const sandbox = vm.createContext({ assertPrimaryCondition, normalizeScoreFieldRequests, normalizeFieldContribution, normalizeModelParameters, modelParameterLabel, parameterRowsToObject, URL, crypto, structuredClone, normalizeDiscussionReport });
    const source = sourceBetween('function normalizeString(', 'function parseModerationContent(');
    vm.runInContext(`${source}\nthis.contract = { buildContributionContent, normalizeStoredModerationContent };`, sandbox);
    const endpoint = sourceBetween("API.post('/submit_contribution'", 'function pendingCatalogReference(');
    const prefix = endpoint.slice(endpoint.indexOf('=> {') + 4, endpoint.indexOf('const connection = await db.getConnection();'));
    vm.runInContext(`this.contract.buildRequest = body => { const req = { body }; ${prefix}\nreturn content; };`, sandbox);
    return sandbox.contract;
}

test('discussion reports round-trip through the native moderation contract', () => {
    const contract = loadContract();
    const content = contract.buildContributionContent({ type: 'discussion_report', postID: 5, reason: 'spam', details: 'Repeated promotional messages.' });
    const stored = contract.normalizeStoredModerationContent(structuredClone(content));
    assert.equal(stored.postID, 5);
    assert.equal(stored.type, 'discussion_report');
    assert.equal(stored.schemaVersion, 1);
    assert.equal(stored.details, content.details);
});

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
        isPrimary: true,
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
            scoreFields: [],
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

function contextTemplate(overrides = {}) {
    return {
        type: 'new_category',
        requestKind: 'context',
        clientRef: 'context-budget',
        name: 'Budget',
        parentPath: 'topics/54/intelligence',
        parentCategoryID: 54,
        parentCategoryRef: null,
        pageURL: 'https://benchpoll.com/topics/54/intelligence',
        details: 'Keep this topic-specific budget setting and reviewer notes.',
        contextOrder: [{ clientRef: 'new-budget', dimensionID: null, dimensionRef: null, isNew: true }],
        options: [
            { key: 'any', name: 'Any', isDefault: true, isNeutral: true },
            { key: 'limited', name: 'Limited', isDefault: false, isNeutral: false }
        ],
        ...overrides
    };
}

for (let repetition = 1; repetition <= 2; repetition++) {
    test(`account metadata is removed before the real strict contribution parser (run ${repetition})`, () => {
        const contract = loadContract();
        for (const payload of [
            { type: 'feedback', details: 'A useful contribution to review.', pageURL: '' },
            { type: 'report_issue', issueType: 'correct_or_add_info', targetName: 'Bench', details: 'Correct the published explanation.', pageURL: '', sourceURL: '' },
            newBenchmark(), benchmarkResult(),
            { type: 'discussion_report', postID: 5, reason: 'spam', details: 'Repeated promotional messages.' }
        ]) {
            const body = { ...payload, expectedUserID: '7' };
            const before = structuredClone(body);
            assert.equal(contract.buildRequest(body).type, contract.buildContributionContent(payload).type);
            assert.deepEqual(body, before, 'Separating metadata must not mutate the incoming body');
            assert.equal(JSON.stringify(contract.buildRequest(body)).includes('expectedUserID'), false);
        }
        assert.throws(() => contract.buildRequest({ type: 'feedback', details: 'Unknown business fields still fail.', expectedUserID: '7', unexpected: true }),
            error => error.body.error === 'unknown_submission_field' && error.body.field === 'unexpected');
    });
}

test('new benchmark keeps explicit custom normalization anchors without tags', () => {
    const content = loadContract().buildContributionContent(newBenchmark());
    assert.equal(content.schemaVersion, 6);
    assert.equal(content.type, 'new_benchmark');
    assert.equal(Object.hasOwn(content.benchmarks[0], 'tags'), false);
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
        'async function validateEntityChangeProposal('
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

test('models store identity only and reject the removed model condition payload', () => {
    const contract = loadContract();
    const request = { type: 'new_model', models: [{
        clientRef: 'model-one', existingModelID: null, existingModelRef: null,
        name: 'Model One', introductionURL: 'https://example.com/model', reviewerNotes: '',
        vendor: { existingVendorID: null, existingVendorRef: null, name: 'Lab', logoKey: '' }
    }] };
    const content = contract.buildContributionContent(request);
    assert.equal(content.schemaVersion, 6);
    assert.equal(content.models[0].introductionURL, 'https://example.com/model');
    assert.equal(Object.hasOwn(content.models[0], 'conditions'), false);
    for (const property of ['conditions', 'configurations']) {
        const invalid = structuredClone(request);
        invalid.models[0][property] = [];
        assert.throws(() => contract.buildContributionContent(invalid),
            error => error.body.error === 'unknown_model_field' && error.body.field === property);
    }
});

test('legacy category creation is retired in favor of independent topics', () => {
    assert.throws(() => loadContract().buildContributionContent(contextTemplate({
        requestKind: 'category', contextOrder: [], options: []
    })), error => error?.status === 410
        && error?.body?.error === 'topic_hierarchy_removed'
        && error?.body?.url === '/#new-topic');
});

test('context-template submissions retain final notes and their topic through stored revalidation', () => {
    const contract = loadContract();
    const request = contextTemplate();
    const before = structuredClone(request);
    const content = contract.buildContributionContent(request);
    assert.deepEqual(request, before);
    assert.equal(content.requestKind, 'context');
    assert.equal(content.schemaVersion, 5);
    assert.equal(content.parentCategoryID, 54);
    assert.equal(content.details, request.details);
    assert.deepEqual(structuredClone(content.contextOrder), request.contextOrder);
    assert.deepEqual(structuredClone(content.options), request.options);
    const stored = contract.normalizeStoredModerationContent(structuredClone(content));
    assert.deepEqual(structuredClone(stored), structuredClone(content));
    assert.throws(() => contract.normalizeStoredModerationContent({ ...content, schemaVersion: 4 }),
        error => error?.status === 409 && error?.body?.error === 'stored_submission_schema_mismatch');
});

test('new context-template submissions return 410 without mutating their notes or account metadata', () => {
    const contract = loadContract();
    const request = { ...contextTemplate(), expectedUserID: '7' };
    const before = structuredClone(request);
    assert.throws(() => contract.buildRequest(request),
        error => error?.status === 410 && error?.body?.error === 'category_contribution_retired');
    assert.deepEqual(request, before);
});

test('historical context-template approval cannot recreate the retired combination structure', async () => {
    const sandbox = vm.createContext({});
    vm.runInContext(sourceBetween('async function applyModerationContent(', 'async function buildExecutedModerationSQLPreview(')
        + '\nthis.apply = applyModerationContent;', sandbox);
    const connection = new Proxy({}, { get() { throw new Error('Retired approval must not access the database'); } });
    await assert.rejects(sandbox.apply(connection, { type: 'new_category', requestKind: 'context' }),
        error => error?.status === 410 && error.body.error === 'category_contribution_retired');
    assert.doesNotMatch(serverSource, /function createCategoryFromSubmission|function migrateExistingContextsForDimension/);
});

test('context templates still require a topic, one new dimension and valid distinct options', () => {
    const contract = loadContract();
    assert.throws(() => contract.buildContributionContent(contextTemplate({ parentCategoryID: null })),
        error => error?.body?.error === 'category_parent_required');
    for (const contextOrder of [[], [
        ...contextTemplate().contextOrder,
        { clientRef: 'second-new', dimensionID: null, dimensionRef: null, isNew: true }
    ]]) {
        assert.throws(() => contract.buildContributionContent(contextTemplate({ contextOrder })),
            error => error?.body?.error === 'invalid_context_order');
    }
    const options = contextTemplate().options;
    for (const invalid of [
        options.slice(0, 1),
        [options[0], { ...options[1], key: options[0].key }],
        [options[0], { ...options[1], name: 'ANY' }],
        options.map(option => ({ ...option, isDefault: false })),
        options.map(option => ({ ...option, isDefault: true })),
        options.map(option => ({ ...option, isNeutral: false })),
        options.map(option => ({ ...option, isNeutral: true }))
    ]) {
        assert.throws(() => contract.buildContributionContent(contextTemplate({ options: invalid })),
            error => error?.body?.error === 'invalid_context_options');
    }
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
    assert.equal(content.schemaVersion, 9);
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
    assert.doesNotMatch(serverSource, /(?:FROM|JOIN|INTO|UPDATE) benchmark_(?:tags|tag_links)\b/);
    assert.doesNotMatch(serverSource, /model_conditions|model_condition_ID/);
    assert.match(serverSource, /score_fields/);
    assert.doesNotMatch(serverSource, /\bFROM objects\b|\bINTO objects\b|evaluation_profiles|evaluation_results|model_configurations|category_templates|\bvotes\b/);
});

test('submission endpoint requires a verified email and senior review uses the same contribution path', () => {
    const endpoint = sourceBetween("API.post('/submit_contribution'", 'function pendingCatalogReference(');
    assert.match(endpoint, /SELECT email FROM users WHERE ID = \? AND email_verified_at IS NOT NULL/);
    assert.match(endpoint, /AND deleted_at IS NULL/);
    assert.match(endpoint, /AND \(banned_at IS NULL OR \(banned_until IS NOT NULL AND banned_until <= NOW\(\)\)\)/);
    assert.match(endpoint, /LIMIT 1 FOR SHARE/);
    assert.match(endpoint, /verified_email_required/);
    assert.match(endpoint, /if \(req\.user\.isSenior\)/);
    assert.match(endpoint, /await applyModerationContent\(workingConnection, content/);
});
