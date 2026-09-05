import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
    PIE_MIN_ITEM_BASIS_POINTS,
    PIE_TOTAL_BASIS_POINTS,
    decoratePieEntries,
    loadBenchmarkConditions,
    loadModels,
    loadPersonalPie,
    loadPublicPie,
    normalizedResultScore,
    savePersonalPie,
    scoreModels,
    serializeRankingContextValues
} from '../ranking-service.js';

const source = fs.readFileSync(new URL('../ranking-service.js', import.meta.url), 'utf8');

test('ranking context serialization is canonical and deterministic', () => {
    const first = serializeRankingContextValues({ web: 'allowed', scope: 'any' });
    const second = serializeRankingContextValues({ scope: 'any', web: 'allowed' });
    assert.deepEqual(first, second);
    assert.equal(first.serialized, '{"scope":"any","web":"allowed"}');
    assert.match(first.contextHash, /^[a-f0-9]{64}$/);
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

test('a direct primary score always wins over its OR fallback', () => {
    const models = [{
        ID: 7,
        modelID: 3,
        name: 'Example model',
        vendor: 'Example lab',
        vendorSlug: 'example',
        logoKey: '',
        introductionURL: '',
        condition: { ID: 7, name: 'default' },
        results: new Map([
            ['21', { normalizedScore: 34, sampleCount: 1 }],
            ['22', { normalizedScore: 96, sampleCount: 1 }]
        ])
    }];
    const [scored] = scoreModels(models, [
        { conditionID: 21, weightBasisPoints: 10000 }
    ], PIE_TOTAL_BASIS_POINTS, {
        fallbackRules: [{
            primaryConditionID: 21,
            mode: 'fallback_if_missing',
            entries: [{ conditionID: 22, weightBasisPoints: 10000 }]
        }]
    });
    assert.equal(scored.lower, 34);
    assert.equal(scored.upper, 34);
    assert.equal(scored.coverage, 100);
    assert.equal(scored.fallbackUsageCount, 0);
    assert.deepEqual(scored.fallbackResolutions, []);
});

test('an OR fallback preserves uncertainty for missing components', () => {
    const models = [{
        ID: 7,
        modelID: 3,
        name: 'Example model',
        vendor: 'Example lab',
        vendorSlug: 'example',
        logoKey: '',
        introductionURL: '',
        condition: { ID: 7, name: 'default' },
        results: new Map([['22', { normalizedScore: 80, sampleCount: 1 }]])
    }];
    const [scored] = scoreModels(models, [
        { conditionID: 21, weightBasisPoints: 10000 }
    ], PIE_TOTAL_BASIS_POINTS, {
        fallbackRules: [{
            primaryConditionID: 21,
            mode: 'fallback_if_missing',
            entries: [
                { conditionID: 22, weightBasisPoints: 7000 },
                { conditionID: 23, weightBasisPoints: 3000 }
            ]
        }]
    });
    assert.equal(scored.lower, 56);
    assert.equal(scored.upper, 86);
    assert.equal(scored.coverage, 70);
    assert.equal(scored.resultCount, 1);
    assert.equal(scored.fallbackUsageCount, 1);
    assert.equal(scored.fallbackCoverage, 70);
    assert.deepEqual(scored.fallbackResolutions[0].components.map(component => component.status), [
        'direct',
        'missing'
    ]);
});

test('OR fallbacks resolve direct scores only and never recurse', () => {
    const models = [{
        ID: 7,
        modelID: 3,
        name: 'Example model',
        vendor: 'Example lab',
        vendorSlug: 'example',
        logoKey: '',
        introductionURL: '',
        condition: { ID: 7, name: 'default' },
        results: new Map([['23', { normalizedScore: 100, sampleCount: 1 }]])
    }];
    const [scored] = scoreModels(models, [
        { conditionID: 21, weightBasisPoints: 10000 }
    ], PIE_TOTAL_BASIS_POINTS, {
        fallbackRules: [
            {
                primaryConditionID: 21,
                mode: 'fallback_if_missing',
                entries: [{ conditionID: 22, weightBasisPoints: 10000 }]
            },
            {
                primaryConditionID: 22,
                mode: 'fallback_if_missing',
                entries: [{ conditionID: 23, weightBasisPoints: 10000 }]
            }
        ]
    });
    assert.equal(scored.lower, 0);
    assert.equal(scored.upper, 100);
    assert.equal(scored.coverage, 0);
    assert.equal(scored.resultCount, 0);
    assert.equal(scored.fallbackUsageCount, 1);
});

test('model results use the median of every accepted normalized score globally', async () => {
    const baseRow = {
        model_ID: 3,
        model_name: 'Median Model',
        introductionURL: null,
        vendor_name: 'Example Lab',
        vendor_slug: 'example-lab',
        logo_key: null,
        model_condition_ID: 7,
        model_condition_name: 'default',
        condition_key: 'default',
        model_condition_is_default: 1,
        benchmark_condition_ID: 21,
        uses_percentage_scale: 1,
        score_min: null,
        score_max: null,
        score_direction: 'higher',
        target_value: null
    };
    const connection = {
        async execute() {
            return [[
                { ...baseRow, result_ID: 101, raw_score: 20 },
                { ...baseRow, result_ID: 102, raw_score: 80 }
            ], []];
        }
    };
    const [model] = await loadModels(connection);
    assert.deepEqual(model.results.get('21'), {
        normalizedScore: 50,
        sampleCount: 2
    });
});

test('median aggregation happens after normalization for closer-to-target scores', async () => {
    const baseRow = {
        model_ID: 3,
        model_name: 'Target Model',
        introductionURL: null,
        vendor_name: 'Example Lab',
        vendor_slug: 'example-lab',
        logo_key: null,
        model_condition_ID: 7,
        model_condition_name: 'default',
        condition_key: 'default',
        model_condition_is_default: 1,
        benchmark_condition_ID: 22,
        uses_percentage_scale: 0,
        score_min: 0,
        score_max: 100,
        score_direction: 'closer_to_target',
        target_value: 50
    };
    const connection = {
        async execute() {
            return [[
                { ...baseRow, result_ID: 201, raw_score: 0 },
                { ...baseRow, result_ID: 202, raw_score: 50 },
                { ...baseRow, result_ID: 203, raw_score: 100 }
            ], []];
        }
    };
    const [model] = await loadModels(connection);
    assert.deepEqual(model.results.get('22'), {
        normalizedScore: 0,
        sampleCount: 3
    });
});

test('benchmark conditions preserve explicit anchors and multiple tags', async () => {
    const connection = {
        async execute() {
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
                tags: 'benchmark\nreasoning'
            }], []];
        }
    };
    const conditions = await loadBenchmarkConditions(connection);
    assert.equal(conditions.length, 1);
    assert.equal(conditions[0].scoreMin, 0);
    assert.equal(conditions[0].scoreMax, 100);
    assert.deepEqual(conditions[0].tags, ['benchmark', 'reasoning']);
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

test('public pie averages every user pie in the selected subtree by participant count', async () => {
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
    const context = { categoryID: 1, dimensions: [], contextValues: {} };
    const conditions = new Map([[21, {}], [22, {}]]);
    const result = await loadPublicPie(connection, context, conditions);
    assert.equal(result.participantCount, 2);
    assert.deepEqual(result.entries, [
        { conditionID: 21, weightBasisPoints: 4000 },
        { conditionID: 22, weightBasisPoints: 6000 }
    ]);
    assert.deepEqual(result.contextIDs, [10, 11]);
    assert.deepEqual(result.scoringEntries, [
        { contextID: 10, conditionID: 21, weightBasisPoints: 6000 },
        { contextID: 10, conditionID: 22, weightBasisPoints: 4000 },
        { contextID: 11, conditionID: 21, weightBasisPoints: 2000 },
        { contextID: 11, conditionID: 22, weightBasisPoints: 8000 }
    ]);
});

test('public pie weights contexts by valid personal-pie count, with absent benchmarks contributing zero', async () => {
    const connection = {
        async execute(sql) {
            if (sql.includes('WITH RECURSIVE category_scope')) {
                return [[
                    { ID: 10, category_ID: 1, context_values: '{}' },
                    { ID: 11, category_ID: 2, context_values: '{"web":"allowed"}' }
                ], []];
            }
            if (sql.includes('FROM personal_pies')) {
                return [[
                    { pie_ID: 1, context_ID: 10, benchmark_condition_ID: 21, weight_basis_points: 10000 },
                    { pie_ID: 2, context_ID: 10, benchmark_condition_ID: 21, weight_basis_points: 10000 },
                    { pie_ID: 3, context_ID: 11, benchmark_condition_ID: 22, weight_basis_points: 10000 }
                ], []];
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        }
    };
    const result = await loadPublicPie(
        connection,
        { categoryID: 1, dimensions: [], contextValues: {} },
        new Map([[21, {}], [22, {}]])
    );
    assert.equal(result.participantCount, 3);
    assert.deepEqual(result.entries, [
        { conditionID: 21, weightBasisPoints: 6667 },
        { conditionID: 22, weightBasisPoints: 3333 }
    ]);
});

test('empty personal pies are excluded rather than counted or treated as corrupt partial pies', async () => {
    const connection = {
        async execute(sql) {
            if (sql.includes('WITH RECURSIVE category_scope')) {
                return [[{ ID: 10, category_ID: 1, context_values: '{}' }], []];
            }
            if (sql.includes('FROM personal_pies')) {
                return [[
                    { pie_ID: 1, context_ID: 10, benchmark_condition_ID: null, weight_basis_points: null },
                    { pie_ID: 2, context_ID: 10, benchmark_condition_ID: 21, weight_basis_points: 10000 }
                ], []];
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        }
    };
    const result = await loadPublicPie(
        connection,
        { categoryID: 1, dimensions: [], contextValues: {} },
        new Map([[21, {}]])
    );
    assert.equal(result.participantCount, 1);
    assert.deepEqual(result.entries, [{ conditionID: 21, weightBasisPoints: 10000 }]);
});

test('public pie traverses only active categories and applies no age-based sample amplification', async () => {
    const connection = {
        async execute(sql) {
            if (sql.includes('WITH RECURSIVE category_scope')) {
                assert.match(sql, /WHERE ID = \?\s+AND is_active = 1/);
                assert.match(sql, /child\.is_active = 1/);
                return [[{ ID: 10, category_ID: 1, context_values: '{}' }], []];
            }
            if (sql.includes('FROM personal_pies')) {
                assert.doesNotMatch(sql, /created_at|updated_at|DATEDIFF|TIMESTAMPDIFF|INTERVAL/i);
                return [[{
                    pie_ID: 1,
                    context_ID: 10,
                    benchmark_condition_ID: 21,
                    weight_basis_points: 10000
                }], []];
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        }
    };
    const result = await loadPublicPie(
        connection,
        { categoryID: 1, dimensions: [], contextValues: {} },
        new Map([[21, {}]])
    );
    assert.equal(result.participantCount, 1);
    assert.match(source, /WHERE parent_ID IS NULL AND is_active = 1/);
    assert.match(source, /WHERE ID = \? AND is_active = 1/);
    assert.match(source, /WHERE parent_ID = \? AND is_active = 1/);
});

test('neutral contexts include every child option while a specific context excludes its siblings', async () => {
    const contextRows = [
        { ID: 10, category_ID: 2, context_values: '{"web":"any"}' },
        { ID: 11, category_ID: 2, context_values: '{"web":"allowed"}' },
        { ID: 12, category_ID: 2, context_values: '{"web":"disallowed"}' }
    ];
    const pieRows = [
        { pie_ID: 1, context_ID: 10, benchmark_condition_ID: 21, weight_basis_points: 10000 },
        { pie_ID: 2, context_ID: 11, benchmark_condition_ID: 22, weight_basis_points: 10000 },
        { pie_ID: 3, context_ID: 12, benchmark_condition_ID: 23, weight_basis_points: 10000 }
    ];
    const connection = {
        async execute(sql, params) {
            if (sql.includes('WITH RECURSIVE category_scope')) {
                return [contextRows, []];
            }
            if (sql.includes('FROM personal_pies')) {
                const contextIDs = new Set(params.map(Number));
                return [pieRows.filter(row => contextIDs.has(row.context_ID)), []];
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
    const conditions = new Map([[21, {}], [22, {}], [23, {}]]);
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
    assert.deepEqual(specific.entries, [{ conditionID: 22, weightBasisPoints: 10000 }]);
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

test('stored personal OR fallbacks preserve condition identity and exact weights', async () => {
    const connection = {
        async execute(sql) {
            if (sql.includes('FROM personal_pies')) {
                return [[{ ID: 7, revision: 3, updated_at: '2026-09-01T00:00:00.000Z' }], []];
            }
            if (sql.includes('FROM personal_pie_weights')) {
                return [[{ benchmark_condition_ID: 21, weight_basis_points: 10000 }], []];
            }
            if (sql.includes('FROM personal_pie_score_rules')) {
                return [[
                    {
                        primary_benchmark_condition_ID: 21,
                        mode: 'fallback_if_missing',
                        fallback_benchmark_condition_ID: 22,
                        weight_basis_points: 6500
                    },
                    {
                        primary_benchmark_condition_ID: 21,
                        mode: 'fallback_if_missing',
                        fallback_benchmark_condition_ID: 23,
                        weight_basis_points: 3500
                    }
                ], []];
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        }
    };
    const pie = await loadPersonalPie(connection, 10, 99);
    assert.deepEqual(pie.fallbackRules, [{
        primaryConditionID: 21,
        mode: 'fallback_if_missing',
        entries: [
            { conditionID: 22, weightBasisPoints: 6500 },
            { conditionID: 23, weightBasisPoints: 3500 }
        ]
    }]);
});

test('stored personal OR fallback cycles fail explicitly before scoring', async () => {
    const connection = {
        async execute(sql) {
            if (sql.includes('FROM personal_pies')) {
                return [[{ ID: 7, revision: 3, updated_at: '2026-09-01T00:00:00.000Z' }], []];
            }
            if (sql.includes('FROM personal_pie_weights')) {
                return [[
                    { benchmark_condition_ID: 21, weight_basis_points: 5000 },
                    { benchmark_condition_ID: 22, weight_basis_points: 5000 }
                ], []];
            }
            if (sql.includes('FROM personal_pie_score_rules')) {
                return [[
                    {
                        primary_benchmark_condition_ID: 21,
                        mode: 'fallback_if_missing',
                        fallback_benchmark_condition_ID: 22,
                        weight_basis_points: 10000
                    },
                    {
                        primary_benchmark_condition_ID: 22,
                        mode: 'fallback_if_missing',
                        fallback_benchmark_condition_ID: 21,
                        weight_basis_points: 10000
                    }
                ], []];
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        }
    };

    await assert.rejects(
        () => loadPersonalPie(connection, 10, 99),
        error => error?.status === 409
            && error?.body?.error === 'personal_pie_fallback_cycle_invalid'
            && error?.body?.pieID === 7
    );
});

test('public pie rejects stored pies that are neither empty nor exactly 100 percent', async () => {
    const connection = {
        async execute(sql) {
            if (sql.includes('WITH RECURSIVE category_scope')) {
                return [[{ ID: 10, category_ID: 1, context_values: '{}' }], []];
            }
            return [[{
                pie_ID: 1,
                context_ID: 10,
                benchmark_condition_ID: 21,
                weight_basis_points: 9900
            }], []];
        }
    };
    await assert.rejects(
        loadPublicPie(connection, { categoryID: 1, dimensions: [], contextValues: {} }, new Map([[21, {}]])),
        error => error?.status === 409 && error?.body?.error === 'personal_pie_total_invalid'
    );
});

test('public pie rejects out-of-range stored weights before aggregation', async () => {
    const connection = {
        async execute(sql) {
            if (sql.includes('WITH RECURSIVE category_scope')) {
                return [[{ ID: 10, category_ID: 1, context_values: '{}' }], []];
            }
            return [[
                { pie_ID: 1, context_ID: 10, benchmark_condition_ID: 21, weight_basis_points: 50 },
                { pie_ID: 1, context_ID: 10, benchmark_condition_ID: 22, weight_basis_points: 9950 }
            ], []];
        }
    };
    await assert.rejects(
        loadPublicPie(
            connection,
            { categoryID: 1, dimensions: [], contextValues: {} },
            new Map([[21, {}], [22, {}]])
        ),
        error => error?.status === 409 && error?.body?.error === 'personal_pie_weight_invalid'
    );
});

test('public pie rejects duplicate condition rows instead of silently combining them', async () => {
    const connection = {
        async execute(sql) {
            if (sql.includes('WITH RECURSIVE category_scope')) {
                return [[{ ID: 10, category_ID: 1, context_values: '{}' }], []];
            }
            return [[
                { pie_ID: 1, context_ID: 10, benchmark_condition_ID: 21, weight_basis_points: 5000 },
                { pie_ID: 1, context_ID: 10, benchmark_condition_ID: 21, weight_basis_points: 5000 }
            ], []];
        }
    };
    await assert.rejects(
        loadPublicPie(
            connection,
            { categoryID: 1, dimensions: [], contextValues: {} },
            new Map([[21, {}]])
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

test('personal pie OR fallback requests are explicit, normalized, and acyclic before database access', async () => {
    let connected = false;
    const db = { async getConnection() { connected = true; throw new Error('should not connect'); } };
    const base = {
        userID: 1,
        categoryID: 1,
        expectedRevision: 0,
        contextValues: {},
        entries: [
            { conditionID: 21, weightBasisPoints: 5000 },
            { conditionID: 22, weightBasisPoints: 5000 }
        ]
    };
    await assert.rejects(
        savePersonalPie(db, base),
        error => error?.status === 400 && error?.body?.error === 'invalid_personal_pie_fallback_rules'
    );
    await assert.rejects(
        savePersonalPie(db, {
            ...base,
            fallbackRules: [{
                primaryConditionID: 21,
                mode: 'fallback_if_missing',
                entries: [{ conditionID: 23, weightBasisPoints: 9900 }]
            }]
        }),
        error => error?.status === 400 && error?.body?.error === 'pie_fallback_total_must_equal_100_percent'
    );
    await assert.rejects(
        savePersonalPie(db, {
            ...base,
            fallbackRules: [
                {
                    primaryConditionID: 21,
                    mode: 'fallback_if_missing',
                    entries: [{ conditionID: 22, weightBasisPoints: 10000 }]
                },
                {
                    primaryConditionID: 22,
                    mode: 'fallback_if_missing',
                    entries: [{ conditionID: 21, weightBasisPoints: 10000 }]
                }
            ]
        }),
        error => error?.status === 400 && error?.body?.error === 'pie_fallback_cycle_not_allowed'
    );
    assert.equal(connected, false);
});

test('ranking runtime contains only canonical benchmark and context storage names', () => {
    assert.match(source, /benchmark_results/);
    assert.match(source, /FROM benchmark_conditions/);
    assert.match(source, /ranking_contexts\.context_values/);
    assert.doesNotMatch(source, /\bobjects\b|evaluation_profiles|evaluation_results|model_configurations|template_values|template_hash|\bvotes\b/);
});
