import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
    buildBenchmarkList,
    aggregateCoverageIndex,
    PIE_MIN_ITEM_BASIS_POINTS,
    PIE_TOTAL_BASIS_POINTS,
    decoratePieEntries,
    getRankingWorkspace,
    loadBenchmarkConditions,
    MIN_COMPARABLE_MODELS,
    loadModels,
    loadPersonalPie,
    loadPublicPie,
    normalizedResultScore,
    resolveRankingContext,
    savePersonalPie,
    selectScopedDimensions,
    scoreModels,
    serializeRankingContextValues
} from '../ranking-service.js';

test('benchmark ranks use public weight only and preserve ties across pages', () => {
    const conditions = [
        { ID: 2, conditionID: 2, benchmarkID: 2, name: 'Zulu', conditionName: 'default', scoreCount: 10, isPrimaryCondition: true },
        { ID: 1, conditionID: 1, benchmarkID: 1, name: 'Alpha', conditionName: 'default', scoreCount: 10, isPrimaryCondition: true },
        { ID: 3, conditionID: 3, benchmarkID: 3, name: 'Beta', conditionName: 'default', scoreCount: 10, isPrimaryCondition: true }
    ];
    const rows = buildBenchmarkList(conditions,
        [{ conditionID: 1, weightBasisPoints: 5000 }, { conditionID: 2, weightBasisPoints: 5000 }],
        [{ conditionID: 2, weightBasisPoints: 9000 }, { conditionID: 1, weightBasisPoints: 1000 }]);
    assert.deepEqual(rows.map(row => row.conditionID), [1, 2, 3]);
    assert.deepEqual(rows.map(row => row.rank), [1, 1, 3]);
});

test('zero-weight benchmarks put broader model evidence first without changing public-weight ranks', () => {
    const conditions = [
        { conditionID: 1, benchmarkID: 1, name: 'Alpha', conditionName: 'default', scoredModelCount: 3, scoreCount: 3, isPrimaryCondition: true },
        { conditionID: 2, benchmarkID: 2, name: 'Beta', conditionName: 'default', scoredModelCount: 40, scoreCount: 40, isPrimaryCondition: true },
        { conditionID: 3, benchmarkID: 3, name: 'Gamma', conditionName: 'default', scoredModelCount: 2, scoreCount: 2, isPrimaryCondition: true }
    ];
    const rows = buildBenchmarkList(conditions, [{ conditionID: 3, weightBasisPoints: 1000 }], []);
    assert.deepEqual(rows.map(row => row.conditionID), [3, 2, 1]);
    assert.deepEqual(rows.map(row => row.rank), [1, 2, 2]);
});

test('zero-current-weight discovery follows total site allocation and keeps positive-weight ties unchanged', () => {
    const conditions = [1, 2, 3, 4, 5].map(conditionID => ({ conditionID, benchmarkID: conditionID,
        name: `Benchmark ${conditionID}`, scoreCount: 10, isPrimaryCondition: true }));
    const rows = buildBenchmarkList(conditions, [{ conditionID: 1, weightBasisPoints: 5000 },
        { conditionID: 2, weightBasisPoints: 5000 }], [], [], [], [], new Map([[2, 100000], [4, 6000], [5, 6000], [3, 2000]]));
    assert.deepEqual(rows.map(row => row.conditionID), [1, 2, 4, 5, 3]);
    assert.deepEqual(rows.map(row => row.rank), [1, 1, 3, 3, 3]);
});

test('model coverage partitions retain adopted scores, fallback shares, and unresolved graph weight', () => {
    const models = [{ ID: 1, name: 'A', results: new Map([['12', { normalizedScore: 80 }], ['20', { normalizedScore: 0 }]]) }];
    const entries = [{ conditionID: 10, weightBasisPoints: 6000 }, { conditionID: 20, weightBasisPoints: 2000 },
        { conditionID: -30, weightBasisPoints: 2000 }];
    const familyComposition = [{ primaryConditionID: 10, families: [
        { primaryConditionID: 10, familyID: 1, entries: [{ conditionID: 12 }], weightBasisPoints: 2500 },
        { primaryConditionID: 10, familyID: 2, entries: [{ conditionID: 13 }], weightBasisPoints: 7500 }
    ] }];
    const [model] = scoreModels(models, entries, 10000, { fallbackScope: 'public', familyComposition });
    assert.deepEqual(model.coverageEntries, [
        { conditionID: 10, weightBasisPoints: 6000, coveredWeightBasisPoints: 1500, coverage: 25, normalizedScore: 80 },
        { conditionID: 20, weightBasisPoints: 2000, coveredWeightBasisPoints: 2000, coverage: 100, normalizedScore: 0 },
        { conditionID: -30, weightBasisPoints: 2000, coveredWeightBasisPoints: 0, coverage: 0, normalizedScore: null }
    ]);
    assert.equal(model.coverageFraction, .35);
    assert.equal(aggregateCoverageIndex([model, model]), .7);
    const [tiny] = scoreModels(models, [{ conditionID: 20, weightBasisPoints: .1 },
        { conditionID: -30, weightBasisPoints: 9999.9 }], 10000);
    assert.equal(tiny.coverage, 0);
    assert.equal(aggregateCoverageIndex([tiny]), .00001);
});

test('zero-weight conditions rotate benchmark families before listing another variant', () => {
    const conditions = [
        { conditionID: 1, benchmarkID: 10, name: 'Benchmark A', conditionName: 'first', scoredModelCount: 30, scoreCount: 30, isPrimaryCondition: true },
        { conditionID: 2, benchmarkID: 10, name: 'Benchmark A', conditionName: 'second', scoredModelCount: 29, scoreCount: 29, isPrimaryCondition: false },
        { conditionID: 3, benchmarkID: 20, name: 'Benchmark B', conditionName: 'default', scoredModelCount: 20, scoreCount: 20, isPrimaryCondition: true }
    ];
    const rows = buildBenchmarkList(conditions, [], []);
    assert.deepEqual(rows.map(row => row.conditionID), [1, 3, 2]);
    assert.deepEqual(rows.map(row => row.rank), [1, 1, 1]);
});

test('public weight exceptions precede coverage folding', () => {
    const conditions = [
        { conditionID: 1, benchmarkID: 10, name: 'A', conditionName: 'main', scoreCount: 100, isPrimaryCondition: true },
        { conditionID: 2, benchmarkID: 10, name: 'A', conditionName: 'small', scoreCount: 20, isPrimaryCondition: false },
        { conditionID: 3, benchmarkID: 10, name: 'A', conditionName: 'normal', scoreCount: 21, isPrimaryCondition: false },
        { conditionID: 4, benchmarkID: 20, name: 'B', conditionName: 'only', scoreCount: 1, isPrimaryCondition: true }
    ];
    const rows = buildBenchmarkList(conditions, [{ conditionID: 2, weightBasisPoints: 1000 }], []);
    assert.deepEqual(rows.map(row => row.conditionID), [2, 1, 4, 3]);
    assert.deepEqual(rows.map(row => row.lowCoverage), [true, false, false, false]);
    assert.equal(rows.find(row => row.conditionID === 2).rank, 1);
});

const source = fs.readFileSync(new URL('../ranking-service.js', import.meta.url), 'utf8');

test('ranking context serialization is canonical and deterministic', () => {
    const first = serializeRankingContextValues({ web: 'allowed', scope: 'any' });
    const second = serializeRankingContextValues({ scope: 'any', web: 'allowed' });
    assert.deepEqual(first, second);
    assert.equal(first.serialized, '{"scope":"any","web":"allowed"}');
    assert.match(first.contextHash, /^[a-f0-9]{64}$/);
});

test('read-only personal previews reject invalid weights and fallback cycles before touching the database', async () => {
    const db = { getConnection() { throw new Error('Preview validation reached the database'); } };
    const base = { categoryID: 1, previewPersonalPie: { entries: [{ conditionID: 1, weightBasisPoints: 10000 }], fallbackRules: [] } };
    await assert.rejects(getRankingWorkspace(db, {
        ...base, previewPersonalPie: { entries: [{ conditionID: 1, weightBasisPoints: 9900 }], fallbackRules: [] }
    }), error => error.body?.error === 'pie_total_must_equal_100_percent');
    await assert.rejects(getRankingWorkspace(db, {
        ...base, previewPersonalPie: { entries: [{ conditionID: 1, weightBasisPoints: 10000 }], fallbackRules: [{
            primaryConditionID: 1, mode: 'ordered', entries: [{ conditionID: 1 }]
        }] }
    }), error => error.body?.error === 'invalid_personal_pie_fallback_component');
    await assert.rejects(getRankingWorkspace(db, {
        ...base, previewPersonalPie: { ...base.previewPersonalPie, unexpected: true }
    }), error => error.body?.error === 'invalid_personal_pie_preview');
});

test('percentage scores use raw 0-100 values and still honor score direction', () => {
    assert.equal(normalizedResultScore({ rawScore: 72, usesPercentageScale: true, scoreDirection: 'higher' }), 72);
    assert.equal(normalizedResultScore({ rawScore: 72, usesPercentageScale: true, scoreDirection: 'lower' }), 28);
    assert.equal(normalizedResultScore({
        rawScore: 40,
        usesPercentageScale: true,
        scoreDirection: 'closer_to_target',
        targetValue: 50
    }), 80);
    assert.equal(normalizedResultScore({ rawScore: 101, usesPercentageScale: true, scoreDirection: 'higher' }), null);
});

test('custom normalization requires two anchors and linearly extrapolates outside them', () => {
    assert.equal(normalizedResultScore({
        rawScore: 42,
        usesPercentageScale: false,
        scoreMin: null,
        scoreMax: null,
        scoreDirection: 'higher'
    }), null);
    assert.equal(normalizedResultScore({
        rawScore: 3,
        usesPercentageScale: false,
        scoreMin: 1,
        scoreMax: 5,
        scoreDirection: 'higher'
    }), 50);
    assert.equal(normalizedResultScore({
        rawScore: 3,
        usesPercentageScale: false,
        scoreMin: 1,
        scoreMax: 5,
        scoreDirection: 'lower'
    }), 50);
    assert.equal(normalizedResultScore({
        rawScore: 4,
        usesPercentageScale: false,
        scoreMin: 0,
        scoreMax: 10,
        scoreDirection: 'closer_to_target',
        targetValue: 5
    }), 80);
    assert.equal(normalizedResultScore({
        rawScore: -1,
        usesPercentageScale: false,
        scoreMin: 0,
        scoreMax: 10,
        scoreDirection: 'higher'
    }), -10);
    assert.equal(normalizedResultScore({
        rawScore: 12,
        usesPercentageScale: false,
        scoreMin: 0,
        scoreMax: 10,
        scoreDirection: 'lower'
    }), -20);
    assert.equal(normalizedResultScore({
        rawScore: 0,
        usesPercentageScale: false,
        scoreMin: null,
        scoreMax: 100,
        scoreDirection: 'higher'
    }), null);
    assert.equal(normalizedResultScore({
        rawScore: 15,
        usesPercentageScale: false,
        scoreMin: 0,
        scoreMax: 10,
        scoreDirection: 'closer_to_target',
        targetValue: 5
    }), -100);
});

test('model scoring exposes an uncertainty interval for missing results', () => {
    const models = [{
        ID: 7,
        modelID: 3,
        name: 'Example model',
        vendor: 'Example lab',
        vendorSlug: 'example',
        logoKey: '',
        introductionURL: '',
        condition: { ID: 7, name: 'default' },
        results: new Map([['21', {
            normalizedScore: 80,
            sampleCount: 1
        }]])
    }];
    const scored = scoreModels(models, [
        { contextID: 10, conditionID: 21, weightBasisPoints: 5000 },
        { contextID: 10, conditionID: 22, weightBasisPoints: 5000 }
    ], PIE_TOTAL_BASIS_POINTS);
    assert.equal(scored.length, 1);
    assert.equal(scored[0].lower, 40);
    assert.equal(scored[0].upper, 90);
    assert.equal(scored[0].coverage, 50);
    assert.equal(scored[0].resultCount, 1);
});

test('available-results mode excludes unresolved weights from inference but still penalizes missing coverage', () => {
    const model = { ID: 7, modelID: 3, name: 'Partial evidence', results: new Map([
        ['21', { normalizedScore: 120 }], ['22', { normalizedScore: -20 }]
    ]) };
    const entries = [
        { conditionID: 21, weightBasisPoints: 4000 },
        { conditionID: 22, weightBasisPoints: 3000 },
        { conditionID: 23, weightBasisPoints: 3000 }
    ];
    const [scored] = scoreModels([model], entries, 10000, { scoreMode: 'available' });
    assert.equal(scored.lower, 55.26);
    assert.equal(scored.upper, 55.26);
    assert.equal(scored.availableInference.unpenalizedScore, 60);
    assert.equal(scored.availableInference.coverageFactor, 3.5 / 3.8);
    assert.equal(scored.availableInference.observedScore, 60);
    assert.equal(scored.availableInference.sourceCount, 0);
    assert.deepEqual(scored.inferredScores, []);
    assert.equal(scored.coverage, 70);
    assert.equal(scored.resultCount, 2);
    assert.deepEqual(scoreModels([model], entries, 10000)[0].lower, 42);
    assert.throws(() => scoreModels([model], entries, 10000, { scoreMode: 'unknown' }), error => error.body?.error === 'invalid_score_mode');
});

test('available-results mode retains 1/3 and 2/3 observed weights when the missing distributions are empty', () => {
    const entries = [1000, 2000, 3000, 4000].map((weightBasisPoints, index) => ({
        conditionID: index + 1, weightBasisPoints
    }));
    const model = { ID: 1, modelID: 1, name: 'Example', results: new Map([
        ['2', { normalizedScore: 60 }], ['4', { normalizedScore: 90 }]
    ]) };
    const [score] = scoreModels([model], entries, 10000, { scoreMode: 'available' });
    assert.equal(score.coverage, 60);
    assert.equal(score.lower, 70.59);
    assert.equal(score.upper, 70.59);
    assert.equal(score.availableInference.observedScore, 80);
    assert.deepEqual(score.inferredScores, []);
    score.calculationScores.forEach((row, index) => assert.ok(Math.abs(row.effectiveWeight - (index + 1) * 100 / 3) < 1e-9));
});

test('ordered fallback resolves the whole entrance and leaves exhausted chains missing in both modes', () => {
    const entries = [{ conditionID: 21, weightBasisPoints: 10000 }];
    const fallbackRules = [{ primaryConditionID: 21, mode: 'ordered', entries: [{ conditionID: 22 }, { conditionID: 23 }] }];
    const models = [
        { ID: 1, modelID: 1, name: 'First wins', results: new Map([['22', { normalizedScore: 80 }], ['23', { normalizedScore: 99 }]]) },
        { ID: 2, modelID: 2, name: 'Missing', results: new Map() }
    ];
    const available = scoreModels(models, entries, 10000, { fallbackRules, scoreMode: 'available' });
    assert.deepEqual(available.map(row => [row.lower, row.upper, row.coverage]), [[80, 80, 100], [null, null, 0]]);
    const range = scoreModels(models, entries, 10000, { fallbackRules });
    assert.deepEqual(range.map(row => [row.lower, row.upper, row.coverage]), [[80, 80, 100], [0, 100, 0]]);
    assert.equal(range[0].fallbackUsageCount, 1);
    assert.equal(range[1].fallbackUsageCount, 0);
    assert.deepEqual(range[1].fallbackResolutions[0].attemptedConditionIDs, [21, 22, 23]);
});

test('a direct entrance including zero always wins over its ordered fallback', () => {
    const model = { ID: 1, modelID: 1, name: 'Direct', results: new Map([['21', { normalizedScore: 0 }], ['22', { normalizedScore: 99 }]]) };
    const [result] = scoreModels([model], [{ conditionID: 21, weightBasisPoints: 10000 }], 10000, {
        fallbackRules: [{ primaryConditionID: 21, mode: 'ordered', entries: [{ conditionID: 22 }] }]
    });
    assert.deepEqual([result.lower, result.upper, result.coverage, result.fallbackUsageCount], [0, 0, 100, 0]);
    assert.deepEqual(result.fallbackResolutions, []);
});

test('fallback does not recursively use another entrance family', () => {
    const [result] = scoreModels([{ ID: 1, modelID: 1, name: 'Flat', results: new Map([['23', { normalizedScore: 100 }]]) }],
        [{ conditionID: 21, weightBasisPoints: 10000 }], 10000, {
            fallbackRules: [
                { primaryConditionID: 21, mode: 'ordered', entries: [{ conditionID: 22 }] },
                { primaryConditionID: 22, mode: 'ordered', entries: [{ conditionID: 23 }] }
            ]
        });
    assert.deepEqual([result.lower, result.upper, result.coverage, result.fallbackUsageCount], [0, 100, 0, 0]);
});

test('model results use the median of every accepted normalized score globally', async () => {
    const baseRow = {
        source_url: 'https://example.com/results',
        model_ID: 3,
        model_name: 'Median Model',
        introductionURL: null,
        vendor_name: 'Example Lab',
        vendor_slug: 'example-lab',
        logo_key: null,
        score_fields: [],
        benchmark_condition_ID: 21,
        uses_percentage_scale: 1,
        score_min: null,
        score_max: null,
        score_direction: 'higher',
        target_value: null
    };
    const connection = {
        async execute(sql) {
            if (sql.includes('FROM models JOIN')) return [[baseRow], []];
            if (sql.includes('FROM benchmark_conditions WHERE')) return [[baseRow], []];
            return [[
                { ...baseRow, result_ID: 101, raw_score: 20 },
                { ...baseRow, result_ID: 102, raw_score: 80 }
            ], []];
        }
    };
    const [model] = await loadModels(connection, []);
    assert.deepEqual(model.results.get('21'), {
        normalizedScore: 50,
        sampleCount: 2, evidenceHash: model.results.get('21').evidenceHash
    });
    assert.match(model.results.get('21').evidenceHash, /^[a-f0-9]{64}$/);
});

test('median aggregation happens after normalization for closer-to-target scores', async () => {
    const baseRow = {
        source_url: 'https://example.com/results',
        model_ID: 3,
        model_name: 'Target Model',
        introductionURL: null,
        vendor_name: 'Example Lab',
        vendor_slug: 'example-lab',
        logo_key: null,
        score_fields: [],
        benchmark_condition_ID: 22,
        uses_percentage_scale: 0,
        score_min: 0,
        score_max: 100,
        score_direction: 'closer_to_target',
        target_value: 50
    };
    const connection = {
        async execute(sql) {
            if (sql.includes('FROM models JOIN')) return [[baseRow], []];
            if (sql.includes('FROM benchmark_conditions WHERE')) return [[baseRow], []];
            return [[
                { ...baseRow, result_ID: 201, raw_score: 0 },
                { ...baseRow, result_ID: 202, raw_score: 50 },
                { ...baseRow, result_ID: 203, raw_score: 100 }
            ], []];
        }
    };
    const [model] = await loadModels(connection, []);
    assert.deepEqual(model.results.get('22'), {
        normalizedScore: 0,
        sampleCount: 3, evidenceHash: model.results.get('22').evidenceHash
    });
    assert.match(model.results.get('22').evidenceHash, /^[a-f0-9]{64}$/);
});

test('benchmark conditions preserve explicit anchors without exposing obsolete tags', async () => {
    const connection = {
        async execute(sql) {
            assert.doesNotMatch(sql, /benchmark_tags|benchmark_tag_links/);
            return [[{
                condition_ID: 21,
                benchmark_ID: 8,
                condition_key: 'default',
                condition_name: 'default',
                uses_percentage_scale: 0,
                score_min: 0,
                score_max: 100,
                score_direction: 'higher',
                target_value: null,
                is_default: 1,
                name: 'No fixed range benchmark',
                introduction_url: null,
                scored_model_count: 0,
                approved_score_count: 0,
                tags: 'benchmark\nreasoning'
            }], []];
        }
    };
    const conditions = await loadBenchmarkConditions(connection);
    assert.equal(conditions.length, 1);
    assert.equal(conditions[0].scoreMin, 0);
    assert.equal(conditions[0].scoreMax, 100);
    assert.equal(Object.hasOwn(conditions[0], 'tags'), false);
    assert.equal(Object.hasOwn(conditions[0], 'type'), false);
    assert.equal(conditions[0].scoredModelCount, 0);
});

test('pie candidates include sparse siblings of benchmarks with comparable conditions', async () => {
    let query;
    let parameters;
    const connection = {
        async execute(sql, values) {
            query = sql;
            parameters = values;
            return [[], []];
        }
    };
    await loadBenchmarkConditions(connection, { includeConditionIDs: [21, 22, 21] });
    assert.match(query, /WITH model_coverage AS/);
    assert.match(query, /COUNT\(\*\) AS approved_score_count/);
    assert.match(query, /COUNT\(DISTINCT benchmark_results\.model_ID\) AS scored_model_count/);
    assert.match(query, /JOIN models ON models\.ID = benchmark_results\.model_ID AND models\.is_active = 1/);
    assert.match(query, /benchmark_results\.status = 'accepted'/);
    assert.match(query, /personal_pie_weights\.benchmark_condition_ID = candidate_conditions\.ID/);
    assert.match(query, /benchmark_family_members\.benchmark_condition_ID = candidate_conditions\.ID/);
    assert.match(query, /benchmark_families\.primary_benchmark_condition_ID = candidate_conditions\.ID/);
    assert.match(query, /candidate_conditions\.ID IN \(\?, \?\)/);
    assert.match(query, /JOIN eligible_benchmarks ON eligible_benchmarks\.benchmark_ID = benchmark_conditions\.benchmark_ID/);
    assert.deepEqual(parameters, [MIN_COMPARABLE_MODELS, 21, 22]);
    await assert.rejects(
        loadBenchmarkConditions(connection, { includeConditionIDs: [0] }),
        error => error?.status === 400 && error?.body?.error === 'invalid_pie_condition_ids'
    );
});

test('every benchmark condition is a distinct weight object with a separate display label', async () => {
    const connection = {
        async execute() {
            return [[
                {
                    condition_ID: 21,
                    benchmark_ID: 8,
                    condition_key: 'default',
                    condition_name: 'default',
                    uses_percentage_scale: 1,
                    score_min: null,
                    score_max: null,
                    score_direction: 'higher',
                    target_value: null,
                    is_default: 1,
                    name: 'SWE-bench Verified',
                    introduction_url: null,
                    scored_model_count: 3,
                    approved_score_count: 5,
                    tags: 'benchmark'
                },
                {
                    condition_ID: 22,
                    benchmark_ID: 8,
                    condition_key: 'agentic',
                    condition_name: 'Agentic tools',
                    uses_percentage_scale: 1,
                    score_min: null,
                    score_max: null,
                    score_direction: 'higher',
                    target_value: null,
                    is_default: 0,
                    name: 'SWE-bench Verified',
                    introduction_url: null,
                    scored_model_count: 1,
                    approved_score_count: 1,
                    tags: 'benchmark'
                }
            ], []];
        }
    };
    const conditions = await loadBenchmarkConditions(connection);
    assert.deepEqual(conditions.map(condition => condition.conditionID), [21, 22]);
    assert.deepEqual(conditions.map(condition => condition.name), [
        'SWE-bench Verified',
        'SWE-bench Verified'
    ]);
    assert.deepEqual(conditions.map(condition => condition.conditionName), ['default', 'Agentic tools']);
    assert.deepEqual(conditions.map(condition => condition.isDefaultCondition), [true, false]);
    assert.deepEqual(conditions.map(condition => condition.scoreCount), [5, 1]);
    assert.equal(conditions.some(condition => condition.name.includes('·')), false);
});

test('a first non-default condition remains a labeled weight object', async () => {
    const connection = {
        async execute() {
            return [[{
                condition_ID: 23,
                benchmark_ID: 9,
                condition_key: 'with-tools',
                condition_name: 'with tools',
                uses_percentage_scale: 1,
                score_min: null,
                score_max: null,
                score_direction: 'higher',
                target_value: null,
                is_default: 0,
                name: 'Agent Arena',
                introduction_url: null,
                scored_model_count: 3,
                approved_score_count: 4,
                tags: 'arena'
            }], []];
        }
    };
    const [condition] = await loadBenchmarkConditions(connection);
    assert.equal(condition.conditionName, 'with tools');
    assert.equal(condition.isDefaultCondition, false);
});

test('stored pie entries retain benchmark-condition identity for display', () => {
    const conditions = new Map([
        [21, {
            conditionID: 21,
            benchmarkID: 8,
            name: 'SWE-bench Verified',
            conditionKey: 'default',
            conditionName: 'default',
            isDefaultCondition: true,
            type: 'benchmark'
        }],
        [22, {
            conditionID: 22,
            benchmarkID: 8,
            name: 'SWE-bench Verified',
            conditionKey: 'agentic',
            conditionName: 'Agentic tools',
            isDefaultCondition: false,
            type: 'benchmark'
        }]
    ]);
    const entries = decoratePieEntries([
        { conditionID: 21, weightBasisPoints: 4000 },
        { conditionID: 22, weightBasisPoints: 6000 }
    ], conditions);

    assert.deepEqual(entries.map(entry => ({
        conditionID: entry.conditionID,
        conditionKey: entry.conditionKey,
        conditionName: entry.conditionName,
        isDefaultCondition: entry.isDefaultCondition
    })), [
        {
            conditionID: 22,
            conditionKey: 'agentic',
            conditionName: 'Agentic tools',
            isDefaultCondition: false
        },
        {
            conditionID: 21,
            conditionKey: 'default',
            conditionName: 'default',
            isDefaultCondition: true
        }
    ]);
});

test('benchmark conditions reject a row-order default flag on a non-default name', async () => {
    const connection = {
        async execute() {
            return [[{
                condition_ID: 24,
                benchmark_ID: 9,
                condition_key: 'with-tools',
                condition_name: 'with tools',
                uses_percentage_scale: 1,
                score_min: null,
                score_max: null,
                score_direction: 'higher',
                target_value: null,
                is_default: 1,
                name: 'Agent Arena',
                introduction_url: null,
                tags: 'arena'
            }], []];
        }
    };
    await assert.rejects(
        loadBenchmarkConditions(connection),
        error => error?.status === 409
            && error?.body?.error === 'benchmark_condition_default_invariant_failed'
    );
});

test('benchmark condition invariants reject percentage rows with stored bounds', async () => {
    const connection = {
        async execute() {
            return [[{
                condition_ID: 21,
                benchmark_ID: 8,
                condition_key: 'default',
                condition_name: 'default',
                uses_percentage_scale: 1,
                score_min: 0,
                score_max: 100,
                score_direction: 'higher',
                target_value: null,
                is_default: 1,
                name: 'Invalid benchmark',
                introduction_url: null,
                tags: null
            }], []];
        }
    };
    await assert.rejects(
        loadBenchmarkConditions(connection),
        error => error?.status === 409
            && error?.body?.error === 'benchmark_condition_score_invariant_failed'
    );
});

test('benchmark condition invariants reject custom rows without both normalization anchors', async () => {
    const connection = {
        async execute() {
            return [[{
                condition_ID: 22,
                benchmark_ID: 9,
                condition_key: 'default',
                condition_name: 'default',
                uses_percentage_scale: 0,
                score_min: null,
                score_max: 100,
                score_direction: 'higher',
                target_value: null,
                is_default: 1,
                name: 'Incomplete normalization benchmark',
                introduction_url: null,
                tags: null
            }], []];
        }
    };
    await assert.rejects(
        loadBenchmarkConditions(connection),
        error => error?.status === 409
            && error?.body?.error === 'benchmark_condition_score_invariant_failed'
    );
});

const recentRows = rows => rows.map(row => ({ ...row, is_recent: 1, is_fallback_recent: 1 }));

function topicContextRows(sql, params, rows) {
    assert.match(sql, /WHERE rc.category_ID = \? AND c.is_active = 1 AND c.owner_user_ID IS NULL/);
    assert.doesNotMatch(sql, /WITH RECURSIVE|parent_ID|source_category_ID/);
    assert.equal(params.length, 1);
    return [rows.filter(row => row.category_ID === params[0] && row.is_active !== 0 && row.owner_user_ID == null), []];
}

const webDimensions = [{ key: 'web', options: [{ key: 'any', isNeutral: true },
    { key: 'allowed', isNeutral: false }, { key: 'disallowed', isNeutral: false }] }];

test('topic resolution finds official Intelligence independently of internal and public IDs', async () => {
    for (const [requested, ID, name, slug] of [[undefined, 54, 'Intelligence', 'intelligence'], [2, 2, 'Coding', 'coding']]) {
        const calls = [];
        const connection = { async execute(sql, params) {
            calls.push(params);
            if (sql.includes('LEFT JOIN topic_scenes')) return [[], []];
            if (sql.includes('FROM categories c LEFT JOIN users creator') && sql.endsWith('AND c.is_active = 1')) {
                assert.equal(sql.replace(/\s+/g, ' ').trim(), 'SELECT c.ID, c.name, c.slug, c.public_ID, c.private_ID, c.is_official, c.description, c.position, c.owner_user_ID, '
                    + "c.created_by_user_ID, p.public_id AS creator_public_id, COALESCE(NULLIF(p.display_name, ''), creator.name) AS creator_name, "
                    + 'COALESCE(p.avatar_data_url, creator.profile_picture_URL) AS creator_avatar '
                    + 'FROM categories c LEFT JOIN users creator ON creator.ID = c.created_by_user_ID AND creator.deleted_at IS NULL '
                    + `LEFT JOIN user_public_profiles p ON p.user_ID = creator.ID WHERE ${requested === undefined ? 'c.is_official = 1 AND c.name = ? AND c.owner_user_ID IS NULL' : 'c.ID = ?'} AND c.is_active = 1`);
                assert.deepEqual(params, [requested === undefined ? 'Intelligence' : ID]);
                return [[{ ID, public_ID: requested === undefined ? 3 : ID, is_official: Number(requested === undefined), name, slug, description: `Compare benchmarks for ${name}.`, position: 3, owner_user_ID: null, parent_ID: 999,
                    created_by_user_ID: '17', creator_name: 'Fixture curator', creator_avatar: '/assets/benchpoll-mark.svg' }], []];
            }
            if (sql.includes('FROM ranking_dimensions')) {
                assert.deepEqual(params, [ID]);
                return [[], []];
            }
            if (sql.includes('FROM ranking_contexts')) {
                assert.match(sql, /WHERE category_ID = \? AND context_hash = \?/);
                assert.deepEqual(params, [ID, serializeRankingContextValues({}).contextHash]);
                return [[{ ID: 100 + ID }], []];
            }
            throw new Error('Unexpected topic query: ' + sql);
        } };
        const context = await resolveRankingContext(connection, { categoryID: requested });
        assert.equal(context.categoryID, ID);
        assert.equal(context.categoryPath, String(requested === undefined ? 3 : ID));
        assert.equal(context.ID, 100 + ID);
        assert.deepEqual(context.lineage, [{ ID, name, position: 3 }]);
        assert.equal(context.isLeafCategory, true);
        assert.equal(context.isPrivate, false);
        assert.equal(context.description, `Compare benchmarks for ${name}.`);
        if (requested === undefined) { assert.equal(context.creator, null); assert.equal(context.isOfficial, true); }
        else assert.equal(context.creator.name, 'Fixture curator');
        assert.doesNotMatch(JSON.stringify(context), /owner_user_ID|created_by_user_ID|ownerUserID|creatorUserID/);
        assert.equal(calls.length, 3, 'No ancestor or child lookup is permitted');
    }
});

test('dimension selection excludes legacy parents, global defaults and other topics', () => {
    const rows = [
        { ID: 1, scope_category_ID: null, dimension_key: 'global', position: 0 },
        { ID: 11, scope_category_ID: 1, dimension_key: 'web', position: 1 },
        { ID: 12, scope_category_ID: 1, dimension_key: 'parentOnly', position: 0 },
        { ID: 21, scope_category_ID: 2, dimension_key: 'web', position: 2 },
        { ID: 22, scope_category_ID: 2, dimension_key: 'tools', position: 1 },
        { ID: 31, scope_category_ID: 3, dimension_key: 'web', position: 0 }
    ];
    const topic = { ID: 2, isLeaf: true, isPrivate: false, lineage: [{ ID: 1 }, { ID: 2 }] };
    assert.deepEqual(selectScopedDimensions(rows, topic).map(row => row.ID), [22, 21]);
    assert.deepEqual(selectScopedDimensions(rows, { ...topic, ID: 3 }).map(row => row.ID), [31]);
    assert.deepEqual(selectScopedDimensions(rows, { ...topic, isPrivate: true }), []);
});

test('resolved scenes keep their identity and reject invented dimension combinations', async () => {
    const connection = { async execute(sql, params) {
        if (sql.includes('FROM categories c LEFT JOIN users creator') && sql.endsWith('WHERE c.ID = ? AND c.is_active = 1')) return [[{
            ID: 2, public_ID: 2, name: 'Coding', slug: 'coding', description: 'Compare coding benchmarks.', position: 0, owner_user_ID: null, parent_ID: 1,
            created_by_user_ID: null, creator_name: null, creator_avatar: null }], []];
        if (sql.includes('LEFT JOIN topic_scenes')) {
            assert.equal(params[0], 2);
            return [[{ contextID: 10, category_ID: 2, scene_context_ID: 10, scene_number: 1, name: 'With web access',
                slug: 'with-web-access', description: 'Coding with access to the web.', position: 0, is_default: 1,
                is_active: 1, legacy_context_values: { web: 'allowed' }, category_name: 'Coding',
                category_slug: 'coding', public_ID: 2, owner_user_ID: null }], []];
        }
        throw new Error('Unexpected dimension query: ' + sql);
    } };
    const context = await resolveRankingContext(connection, { categoryID: 2, contextValues: { scene: '10' } });
    assert.deepEqual(context.contextValues, { scene: '10' });
    assert.equal(context.sceneID, 10);
    assert.deepEqual(context.dimensions, []);
    await assert.rejects(resolveRankingContext(connection, { categoryID: 2, contextValues: { parentOnly: 'allowed' } }),
        error => error.status === 404 && error.body?.error === 'topic_scene_not_found');
});

test('private topics resolve only for their owner and never load public dimensions', async () => {
    const connection = { async execute(sql, params) {
        if (sql.includes('LEFT JOIN topic_scenes')) return [[], []];
        if (sql.includes('FROM categories c LEFT JOIN users creator') && sql.endsWith('WHERE c.ID = ? AND c.is_active = 1')) {
            assert.deepEqual(params, [8]);
            return [[{ ID: 8, public_ID: 8, private_ID: 'fixtureTopic0008', name: 'My mix', slug: 'my-mix', description: 'My personal benchmark comparison.', position: 0,
                owner_user_ID: 7, parent_ID: 1, created_by_user_ID: 7, creator_name: 'Fixture owner', creator_avatar: null }], []];
        }
        if (sql.includes('FROM ranking_contexts')) {
            assert.deepEqual(params, [8, serializeRankingContextValues({}).contextHash]);
            return [[{ ID: 80 }], []];
        }
        throw new Error('Private topic reached a public lookup: ' + sql);
    } };
    const owned = await resolveRankingContext(connection, { categoryID: 8, userID: 7 });
    assert.equal(owned.isPrivate, true);
    assert.equal(owned.categoryPath, 'private/fixtureTopic0008');
    assert.deepEqual(owned.dimensions, []);
    for (const userID of [null, 6]) {
        await assert.rejects(resolveRankingContext(connection, { categoryID: 8, userID }),
            error => error.status === 404 && error.body?.error === 'category_not_found');
    }
    await assert.rejects(resolveRankingContext({ async execute(sql) {
        assert.match(sql, /WHERE c\.ID = \? AND c\.is_active = 1/);
        return [[], []];
    } }, { categoryID: 9 }), error => error.status === 404 && error.body?.error === 'category_not_found');
});

test('private topics have no public contribution and perform no public aggregation reads', async () => {
    const result = await loadPublicPie({ execute() { throw new Error('Private public-aggregation query'); } },
        { categoryID: 8, isPrivate: true, dimensions: [], contextValues: {} }, new Map());
    assert.deepEqual(result, { entries: [], familyComposition: [], versionComposition: [], participantCount: 0,
        isFallback: false, scoringEntries: [], contextIDs: [] });
});

test('public pies isolate each topic even when legacy parents, private topics and inactive topics exist', async () => {
    const contexts = [
        { ID: 10, category_ID: 1, context_values: '{}', is_active: 1, owner_user_ID: null },
        { ID: 11, category_ID: 2, context_values: '{}', is_active: 1, owner_user_ID: null, parent_ID: 1 },
        { ID: 12, category_ID: 3, context_values: '{}', is_active: 1, owner_user_ID: 99, parent_ID: 1 },
        { ID: 13, category_ID: 4, context_values: '{}', is_active: 0, owner_user_ID: null, parent_ID: 1 }
    ];
    const queriedContexts = [];
    const connection = {
        async execute(sql, params) {
            if (sql.includes('FROM personal_pie_score_rules')) return [[], []];
            if (sql.includes('FROM ranking_contexts rc')) return topicContextRows(sql, params, contexts);
            if (sql.includes('FROM personal_pies')) {
                queriedContexts.push(params);
                return [recentRows([
                    { pie_ID: 1, context_ID: 10, benchmark_condition_ID: 21, weight_basis_points: 6000 },
                    { pie_ID: 1, context_ID: 10, benchmark_condition_ID: 22, weight_basis_points: 4000 },
                    { pie_ID: 2, context_ID: 11, benchmark_condition_ID: 21, weight_basis_points: 2000 },
                    { pie_ID: 2, context_ID: 11, benchmark_condition_ID: 22, weight_basis_points: 8000 },
                    { pie_ID: 3, context_ID: 12, benchmark_condition_ID: 99, weight_basis_points: 10000 },
                    { pie_ID: 4, context_ID: 13, benchmark_condition_ID: 99, weight_basis_points: 10000 }
                ].filter(row => params.includes(row.context_ID))), []];
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        }
    };
    const conditions = new Map([[21, { conditionID: 21, benchmarkID: 21, isPrimaryCondition: true, scoreCount: 1 }], [22, { conditionID: 22, benchmarkID: 22, isPrimaryCondition: true, scoreCount: 1 }]]);
    for (const [categoryID, contextID, shares] of [[1, 10, [6000, 4000]], [2, 11, [2000, 8000]]]) {
        const result = await loadPublicPie(connection, { categoryID, dimensions: [], contextValues: {} }, conditions);
        assert.equal(result.participantCount, 1);
        assert.deepEqual(result.entries, shares.map((weightBasisPoints, index) => ({ conditionID: 21 + index, weightBasisPoints, followCommunityVersion: true })));
        assert.deepEqual(result.contextIDs, [contextID]);
        assert.deepEqual(result.scoringEntries, result.entries.map(({ conditionID, weightBasisPoints }) => ({ contextID, conditionID, weightBasisPoints })));
        assert.equal(Object.hasOwn(result, 'composition'), false);
    }
    assert.deepEqual(queriedContexts, [[10], [11]]);
});

test('public pie weights contexts by valid personal-pie count, with absent benchmarks contributing zero', async () => {
    const connection = {
        async execute(sql, params) {
            if (sql.includes('FROM personal_pie_score_rules')) return [[], []];
            if (sql.includes('FROM ranking_contexts rc')) {
                return topicContextRows(sql, params, [
                    { ID: 10, category_ID: 1, context_values: '{"web":"any"}' },
                    { ID: 11, category_ID: 1, context_values: '{"web":"allowed"}' }
                ]);
            }
            if (sql.includes('FROM personal_pies')) {
                assert.deepEqual(params, [10, 11]);
                return [recentRows([
                    { pie_ID: 1, context_ID: 10, benchmark_condition_ID: 21, weight_basis_points: 10000 },
                    { pie_ID: 2, context_ID: 10, benchmark_condition_ID: 21, weight_basis_points: 10000 },
                    { pie_ID: 3, context_ID: 11, benchmark_condition_ID: 22, weight_basis_points: 10000 }
                ]), []];
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        }
    };
    const result = await loadPublicPie(
        connection,
        { categoryID: 1, dimensions: webDimensions, contextValues: { web: 'any' } },
        new Map([[21, { conditionID: 21, benchmarkID: 21, isPrimaryCondition: true, scoreCount: 1 }], [22, { conditionID: 22, benchmarkID: 22, isPrimaryCondition: true, scoreCount: 1 }]])
    );
    assert.equal(result.participantCount, 3);
    assert.deepEqual(result.entries, [
        { conditionID: 21, weightBasisPoints: 6667, followCommunityVersion: true },
        { conditionID: 22, weightBasisPoints: 3333, followCommunityVersion: true }
    ]);
});

test('empty personal pies are excluded rather than counted or treated as corrupt partial pies', async () => {
    const connection = {
        async execute(sql, params) {
            if (sql.includes('FROM personal_pie_score_rules')) return [[], []];
            if (sql.includes('FROM ranking_contexts rc')) {
                return topicContextRows(sql, params, [{ ID: 10, category_ID: 1, context_values: '{}' }]);
            }
            if (sql.includes('FROM personal_pies')) {
                return [recentRows([
                    { pie_ID: 1, context_ID: 10, benchmark_condition_ID: null, weight_basis_points: null },
                    { pie_ID: 2, context_ID: 10, benchmark_condition_ID: 21, weight_basis_points: 10000 }
                ]), []];
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        }
    };
    const result = await loadPublicPie(
        connection,
        { categoryID: 1, dimensions: [], contextValues: {} },
        new Map([[21, { conditionID: 21, benchmarkID: 21, isPrimaryCondition: true, scoreCount: 1 }]])
    );
    assert.equal(result.participantCount, 1);
    assert.deepEqual(result.entries, [{ conditionID: 21, weightBasisPoints: 10000, followCommunityVersion: true }]);
});

test('public pie queries only the active public topic and counts each recent pie once', async () => {
    const connection = {
        async execute(sql, params) {
            if (sql.includes('FROM personal_pie_score_rules')) return [[], []];
            if (sql.includes('FROM ranking_contexts rc')) {
                assert.deepEqual(params, [1]);
                return topicContextRows(sql, params, [{ ID: 10, category_ID: 1, context_values: '{}' }]);
            }
            if (sql.includes('FROM personal_pies')) {
                assert.match(sql, /updated_at >= NOW\(\) - INTERVAL 72 HOUR/);
                assert.match(sql, /updated_at >= NOW\(\) - INTERVAL 14 DAY/);
                return [recentRows([{
                    pie_ID: 1,
                    context_ID: 10,
                    benchmark_condition_ID: 21,
                    weight_basis_points: 10000
                }]), []];
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        }
    };
    const result = await loadPublicPie(
        connection,
        { categoryID: 1, dimensions: [], contextValues: {} },
        new Map([[21, { conditionID: 21, benchmarkID: 21, isPrimaryCondition: true, scoreCount: 1 }]])
    );
    assert.equal(result.participantCount, 1);
    assert.deepEqual(result.contextIDs, [10]);
    assert.deepEqual(result.entries, [{ conditionID: 21, weightBasisPoints: 10000, followCommunityVersion: true }]);
    assert.equal(Object.hasOwn(result, 'composition'), false);
});

test('neutral and specific context choices filter configurations only inside their topic', async () => {
    const contextRows = [
        { ID: 10, category_ID: 2, context_values: '{"web":"any"}' },
        { ID: 11, category_ID: 2, context_values: '{"web":"allowed"}' },
        { ID: 12, category_ID: 2, context_values: '{"web":"disallowed"}' },
        { ID: 13, category_ID: 3, context_values: '{"web":"allowed"}', parent_ID: 2 }
    ];
    const pieRows = [
        { pie_ID: 1, context_ID: 10, benchmark_condition_ID: 21, weight_basis_points: 10000 },
        { pie_ID: 2, context_ID: 11, benchmark_condition_ID: 22, weight_basis_points: 10000 },
        { pie_ID: 3, context_ID: 12, benchmark_condition_ID: 23, weight_basis_points: 10000 },
        { pie_ID: 4, context_ID: 13, benchmark_condition_ID: 99, weight_basis_points: 10000 }
    ];
    const connection = {
        async execute(sql, params) {
            if (sql.includes('FROM personal_pie_score_rules')) return [[], []];
            if (sql.includes('FROM ranking_contexts rc')) return topicContextRows(sql, params, contextRows);
            if (sql.includes('FROM personal_pies')) {
                const contextIDs = new Set(params.map(Number));
                return [recentRows(pieRows.filter(row => contextIDs.has(row.context_ID))), []];
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        }
    };
    const dimensions = [{
        key: 'web',
        options: [
            { key: 'any', isNeutral: true },
            { key: 'allowed', isNeutral: false },
            { key: 'disallowed', isNeutral: false }
        ]
    }];
    const conditions = new Map([[21, { conditionID: 21, benchmarkID: 21, isPrimaryCondition: true, scoreCount: 1 }], [22, { conditionID: 22, benchmarkID: 22, isPrimaryCondition: true, scoreCount: 1 }], [23, { conditionID: 23, benchmarkID: 23, isPrimaryCondition: true, scoreCount: 1 }]]);
    const neutral = await loadPublicPie(
        connection,
        { categoryID: 2, dimensions, contextValues: { web: 'any' } },
        conditions
    );
    assert.equal(neutral.participantCount, 3);
    assert.deepEqual(neutral.contextIDs, [10, 11, 12]);

    const specific = await loadPublicPie(
        connection,
        { categoryID: 2, dimensions, contextValues: { web: 'allowed' } },
        conditions
    );
    assert.equal(specific.participantCount, 1);
    assert.deepEqual(specific.contextIDs, [11]);
    assert.deepEqual(specific.entries, [{ conditionID: 22, weightBasisPoints: 10000, followCommunityVersion: true }]);
});

test('independent context choices match each dimension separately in public weights', async () => {
    const contextRows = [
        { ID: 10, category_ID: 2, context_values: '{"realtime":"any","output":"vector"}' },
        { ID: 11, category_ID: 2, context_values: '{"realtime":"yes","output":"vector"}' },
        { ID: 12, category_ID: 2, context_values: '{"realtime":"no","output":"bitmap"}' },
        { ID: 13, category_ID: 2, context_values: '{"realtime":"yes","output":"bitmap"}' }
    ];
    const connection = { async execute(sql, params) {
        if (sql.includes('FROM personal_pie_score_rules')) return [[], []];
        if (sql.includes('FROM ranking_contexts rc')) return topicContextRows(sql, params, contextRows);
        if (sql.includes('FROM personal_pies')) return [recentRows(params.map((id, index) => ({
            pie_ID: index + 1, context_ID: id, benchmark_condition_ID: 21, weight_basis_points: 10000
        }))), []];
        throw new Error(`Unexpected SQL: ${sql}`);
    } };
    const dimensions = [
        { key: 'realtime', options: [{ key: 'any', isNeutral: true }, { key: 'yes' }, { key: 'no' }] },
        { key: 'output', options: [{ key: 'any', isNeutral: true }, { key: 'vector' }, { key: 'bitmap' }] }
    ];
    const conditions = new Map([[21, { conditionID: 21, benchmarkID: 21, isPrimaryCondition: true, scoreCount: 1 }]]);
    const mixed = await loadPublicPie(connection,
        { categoryID: 2, dimensions, contextValues: { realtime: 'any', output: 'vector' } }, conditions);
    assert.deepEqual(mixed.contextIDs, [10, 11]);
    assert.equal(mixed.participantCount, 2);
    const otherMixed = await loadPublicPie(connection,
        { categoryID: 2, dimensions, contextValues: { realtime: 'yes', output: 'any' } }, conditions);
    assert.deepEqual(otherMixed.contextIDs, [11, 13]);
    assert.equal(otherMixed.participantCount, 2);
});

test('an empty stored personal pie remains editable but is not treated as a valid weighted pie', async () => {
    const connection = {
        async execute(sql) {
            if (sql.includes('FROM personal_pies')) {
                return [[{ ID: 7, revision: 3, updated_at: '2026-09-01T00:00:00.000Z' }], []];
            }
            if (sql.includes('FROM personal_pie_weights')) {
                return [[], []];
            }
            if (sql.includes('FROM personal_pie_score_rules')) {
                return [[], []];
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        }
    };
    const pie = await loadPersonalPie(connection, 10, 99);
    assert.equal(pie.revision, 3);
    assert.deepEqual(pie.entries, []);
    assert.deepEqual(pie.fallbackRules, []);
});

test('stored personal families preserve exact member order and immutable identity', async () => {
    const { createHash } = await import('node:crypto');
    const rows = [23, 22].map((ID, index) => ({ pie_ID: 7, family_ID: 12, primary_benchmark_condition_ID: 21,
        chain_hash: createHash('sha256').update('[21,23,22]').digest('hex'), position: index + 1, fallback_benchmark_condition_ID: ID }));
    const connection = { async execute(sql) {
        if (sql.includes('FROM personal_pies')) return [[{ ID: 7, revision: 3 }], []];
        if (sql.includes('FROM personal_pie_weights')) return [[{ benchmark_condition_ID: 21, weight_basis_points: 10000 }], []];
        if (sql.includes('FROM personal_pie_score_rules')) return [rows, []];
        throw new Error('Unexpected SQL: ' + sql);
    } };
    const pie = await loadPersonalPie(connection, 10, 99);
    assert.deepEqual(pie.fallbackRules, [{ familyID: 12, primaryConditionID: 21, mode: 'ordered', entries: [{ conditionID: 23 }, { conditionID: 22 }] }]);
    rows[1].position = 3;
    await assert.rejects(loadPersonalPie(connection, 10, 99), error => error.body?.error === 'benchmark_family_invariant_failed');
});

test('public pie rejects stored pies that are neither empty nor exactly 100 percent', async () => {
    const connection = {
        async execute(sql, params) {
            if (sql.includes('FROM ranking_contexts rc')) {
                return topicContextRows(sql, params, [{ ID: 10, category_ID: 1, context_values: '{}' }]);
            }
            return [recentRows([{
                pie_ID: 1,
                context_ID: 10,
                benchmark_condition_ID: 21,
                weight_basis_points: 9900
            }]), []];
        }
    };
    await assert.rejects(
        loadPublicPie(connection, { categoryID: 1, dimensions: [], contextValues: {} }, new Map([[21, { conditionID: 21, benchmarkID: 21, isPrimaryCondition: true, scoreCount: 1 }]])),
        error => error?.status === 409 && error?.body?.error === 'personal_pie_total_invalid'
    );
});

test('public pie rejects out-of-range stored weights before aggregation', async () => {
    const connection = {
        async execute(sql, params) {
            if (sql.includes('FROM ranking_contexts rc')) {
                return topicContextRows(sql, params, [{ ID: 10, category_ID: 1, context_values: '{}' }]);
            }
            return [recentRows([
                { pie_ID: 1, context_ID: 10, benchmark_condition_ID: 21, weight_basis_points: 50 },
                { pie_ID: 1, context_ID: 10, benchmark_condition_ID: 22, weight_basis_points: 9950 }
            ]), []];
        }
    };
    await assert.rejects(
        loadPublicPie(
            connection,
            { categoryID: 1, dimensions: [], contextValues: {} },
            new Map([[21, { conditionID: 21, benchmarkID: 21, isPrimaryCondition: true, scoreCount: 1 }], [22, { conditionID: 22, benchmarkID: 22, isPrimaryCondition: true, scoreCount: 1 }]])
        ),
        error => error?.status === 409 && error?.body?.error === 'personal_pie_weight_invalid'
    );
});

test('public pie rejects duplicate condition rows instead of silently combining them', async () => {
    const connection = {
        async execute(sql, params) {
            if (sql.includes('FROM ranking_contexts rc')) {
                return topicContextRows(sql, params, [{ ID: 10, category_ID: 1, context_values: '{}' }]);
            }
            return [recentRows([
                { pie_ID: 1, context_ID: 10, benchmark_condition_ID: 21, weight_basis_points: 5000 },
                { pie_ID: 1, context_ID: 10, benchmark_condition_ID: 21, weight_basis_points: 5000 }
            ]), []];
        }
    };
    await assert.rejects(
        loadPublicPie(
            connection,
            { categoryID: 1, dimensions: [], contextValues: {} },
            new Map([[21, { conditionID: 21, benchmarkID: 21, isPrimaryCondition: true, scoreCount: 1 }]])
        ),
        error => error?.status === 409 && error?.body?.error === 'personal_pie_condition_duplicate'
    );
});

test('personal pie request validation enforces the 100 percent invariant before database access', async () => {
    let connected = false;
    const db = { async getConnection() { connected = true; throw new Error('should not connect'); } };
    await assert.rejects(savePersonalPie(db, {
        userID: 1,
        categoryID: 1,
        expectedRevision: 0,
        contextValues: {},
        entries: [{ conditionID: 21, weightBasisPoints: PIE_TOTAL_BASIS_POINTS - PIE_MIN_ITEM_BASIS_POINTS }]
    }), error => error?.status === 400 && error?.body?.error === 'pie_total_must_equal_100_percent');
    assert.equal(connected, false);
});

test('personal pie save rejects an unscored condition before writing a new pie', async () => {
    const writes = [];
    let rolledBack = false;
    let released = false;
    let intent;
    const connection = {
        async beginTransaction() {},
        async commit() { writes.push('commit'); },
        async rollback() { rolledBack = true; },
        release() { released = true; },
        async execute(sql, params) {
            if (sql.includes('FROM topic_reference_lock')) return [[{ ID: 1 }], []];
            if (sql.includes('LEFT JOIN topic_scenes')) return [[], []];
            if (sql.includes('INSERT INTO write_requests')) {
                intent = { action: params[2], payload_hash: params[3], owner_token: params[4] };
                return [{ affectedRows: 1 }, []];
            }
            if (sql.includes('FROM write_requests')) return [[intent], []];
            if (/SELECT ID\s+FROM users/.test(sql)) return [[{ ID: 1 }], []];
            if (sql.includes('FROM categories c LEFT JOIN users creator') && sql.endsWith('WHERE c.ID = ? AND c.is_active = 1')) return [[{
                ID: 1, public_ID: 1, parent_ID: null, name: 'Root', slug: 'root', description: 'Compare root topic benchmarks.', position: 0,
                owner_user_ID: null, created_by_user_ID: null, creator_name: null, creator_avatar: null }], []];
            if (sql.includes('FROM ranking_dimensions')) {
                assert.deepEqual(params, [1]);
                return [[], []];
            }
            if (/FROM ranking_contexts/.test(sql)) return [[{ ID: 10 }], []];
            if (/FROM personal_pies/.test(sql)) return [[], []];
            if (/FROM benchmark_conditions\s+WHERE ID IN/.test(sql)) return [[{ ID: 21 }], []];
            if (/SELECT benchmark_conditions\.ID AS condition_ID/.test(sql)) return [[], []];
            writes.push(sql);
            throw new Error(`Unexpected query: ${sql}`);
        }
    };
    const db = { async getConnection() { return connection; } };
    await assert.rejects(savePersonalPie(db, {
        userID: 1,
        writeIdentity: 'bcdff5e0-8d89-47a7-8e15-1d87687d1b23',
        categoryID: 1,
        contextValues: {},
        expectedRevision: 0,
        entries: [{ conditionID: 21, weightBasisPoints: 10000 }],
        fallbackRules: []
    }), error => error?.status === 409
        && error?.body?.error === 'pie_benchmark_condition_not_comparable'
        && error?.body?.conditionID === 21);
    assert.deepEqual(writes, []);
    assert.equal(rolledBack, true);
    assert.equal(released, true);
});

test('personal family requests reject legacy weights, duplicates and self references before accessing the database', async () => {
    let connected = false;
    const db = { async getConnection() { connected = true; throw new Error('should not connect'); } };
    const base = { userID: 1, categoryID: 1, expectedRevision: 0, entries: [
        { conditionID: 21, weightBasisPoints: 5000 }, { conditionID: 22, weightBasisPoints: 5000 }
    ] };
    await assert.rejects(savePersonalPie(db, base), error => error.body?.error === 'invalid_personal_pie_fallback_rules');
    for (const entries of [[{ conditionID: 23, weightBasisPoints: 10000 }], [{ conditionID: 21 }],
        [{ conditionID: 23 }, { conditionID: 23 }]]) {
        await assert.rejects(savePersonalPie(db, { ...base, fallbackRules: [{ primaryConditionID: 21, mode: 'ordered', entries }] }),
            error => error.status === 400);
    }
    assert.equal(connected, false);
});

test('ranking runtime contains only canonical benchmark and context storage names', () => {
    assert.match(source, /benchmark_results/);
    assert.match(source, /FROM benchmark_conditions/);
    assert.match(source, /SELECT rc\.ID, rc\.category_ID, rc\.context_values\s+FROM ranking_contexts rc/);
    assert.doesNotMatch(source, /\bobjects\b|evaluation_profiles|evaluation_results|model_configurations|template_values|template_hash|\bvotes\b/);
});
