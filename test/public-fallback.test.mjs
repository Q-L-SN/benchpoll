import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPublicPie, getRankingWorkspace, scoreModels } from '../ranking-service.js';
import { validateWorkspacePayload } from '../public/js/workspace/contracts.js';
import { createFixtureState, workspace, weightedEntries } from '../scripts/frontend/fixtures.mjs';

const weight = (pie, condition, points) => ({ pie_ID: pie, context_ID: 10,
    benchmark_condition_ID: condition, weight_basis_points: points });
const component = (pie, primary, condition, points) => ({ pie_ID: pie,
    primary_benchmark_condition_ID: primary, mode: 'fallback_if_missing',
    fallback_benchmark_condition_ID: condition, weight_basis_points: points });

function database(weights, rules) {
    return { async execute(sql, params) {
        if (sql.includes('WITH RECURSIVE category_scope')) {
            return [[{ ID: 10, category_ID: 1, context_values: '{}' }], []];
        }
        if (sql.includes('FROM personal_pies')) {
            assert.deepEqual(params, [10]);
            assert.match(sql, /users.deleted_at IS NULL/);
            assert.match(sql, /users.banned_at IS NULL/);
            return [weights, []];
        }
        if (sql.includes('FROM personal_pie_score_rules')) {
            assert.deepEqual(params, [...new Set(weights.filter(row => row.benchmark_condition_ID !== null).map(row => row.pie_ID))]);
            return [rules, []];
        }
        throw Error(`Unexpected query: ${sql}`);
    } };
}
const load = (weights, rules, IDs = [1, 2, 3, 4]) => loadPublicPie(database(weights, rules),
    { categoryID: 1, dimensions: [], contextValues: {} }, new Map(IDs.map(ID => [ID, {}])));

const modelWith = entries => ({ ID: 1, modelID: 1, name: 'Fixture model',
    results: new Map(entries.map(([ID, normalizedScore]) => [String(ID), { normalizedScore, sampleCount: 1 }])) });
const publicScore = (pie, model) => scoreModels([model], pie.scoringEntries, pie.participantCount * 10000,
    { fallbackRules: pie.fallbackRules, fallbackScope: 'public' })[0];

test('public scores use exactly the displayed fallback proportions, without inflating configured users', async () => {
    const pie = await load([
        weight(1, 1, 6000), weight(1, 4, 4000),
        weight(2, 1, 2000), weight(2, 4, 8000),
        weight(3, 1, 2000), weight(3, 4, 8000), weight(4, 4, 10000)
    ], [component(1, 1, 2, 5000), component(1, 1, 3, 5000), component(2, 1, 2, 10000)]);
    const result = publicScore(pie, modelWith([[2, 80], [4, 40]]));
    // Primary weight = 25%; its mix is B 50%, missing C 30%, unconfigured 20%.
    assert.equal(result.lower, 40);
    assert.equal(result.upper, 52.5);
    assert.equal(result.coverage, 87.5);
    assert.equal(result.fallbackCoverage, 12.5);
    assert.equal(result.fallbackUsageCount, 1);
    assert.equal(result.fallbackResolutions[0].unconfiguredWeightBasisPoints, 2000);
    assert.equal(result.resultCount, 2);
});

test('public direct scores including zero and out-of-range values override fallback', async () => {
    const pie = await load([weight(1, 1, 10000)], [component(1, 1, 2, 10000)]);
    for (const score of [0, -50, 150]) {
        const result = publicScore(pie, modelWith([[1, score], [2, 90]]));
        assert.equal(result.lower, score);
        assert.equal(result.upper, score);
        assert.equal(result.fallbackUsageCount, 0);
        assert.equal(result.coverage, 100);
    }
    const missing = publicScore(pie, modelWith([]));
    assert.equal(missing.lower, 0);
    assert.equal(missing.upper, 100);
    assert.equal(missing.coverage, 0);
});

test('public aggregates support fractional shares and more components than a single personal rule', async () => {
    const weights = [], rules = [];
    for (let i = 0; i < 13; i++) {
        weights.push(weight(i + 1, 1, 10000));
        rules.push(component(i + 1, 1, i + 2, 10000));
    }
    const pie = await load(weights, rules, Array.from({ length: 14 }, (_, i) => i + 1));
    const result = publicScore(pie, modelWith(Array.from({ length: 13 }, (_, i) => [i + 2, 80])));
    assert.equal(result.lower, 80);
    assert.equal(result.upper, 80);
    assert.equal(result.coverage, 100);
    assert.equal(result.resultCount, 13);
    assert.throws(() => scoreModels([modelWith([])], pie.scoringEntries, 130000, { fallbackRules: pie.fallbackRules }));
});

test('public aggregation equals the mean of individual scores with heterogeneous fallback allocations', async () => {
    const pie = await load([weight(1, 1, 6000), weight(1, 4, 4000), weight(2, 1, 2000), weight(2, 4, 8000)],
        [component(1, 1, 2, 10000)]);
    const model = modelWith([[2, -20], [4, 140]]);
    const first = scoreModels([model], [{ conditionID: 1, weightBasisPoints: 6000 }, { conditionID: 4, weightBasisPoints: 4000 }], 10000,
        { fallbackRules: [{ primaryConditionID: 1, mode: 'fallback_if_missing', entries: [{ conditionID: 2, weightBasisPoints: 10000 }] }] })[0];
    const second = scoreModels([model], [{ conditionID: 1, weightBasisPoints: 2000 }, { conditionID: 4, weightBasisPoints: 8000 }], 10000)[0];
    const combined = publicScore(pie, model);
    assert.equal(combined.lower, (first.lower + second.lower) / 2);
    assert.equal(combined.upper, (first.upper + second.upper) / 2);
    assert.equal(combined.coverage, (first.coverage + second.coverage) / 2);
});

test('public repeated primaries across contexts count a fallback only once and never recurse', () => {
    const entries = [{ conditionID: 1, contextID: 10, weightBasisPoints: 10000 },
        { conditionID: 1, contextID: 11, weightBasisPoints: 10000 }];
    const rules = [{ primaryConditionID: 1, mode: 'fallback_if_missing', unconfiguredWeightBasisPoints: 0,
        entries: [{ conditionID: 2, weightBasisPoints: 10000 }] },
    { primaryConditionID: 2, mode: 'fallback_if_missing', unconfiguredWeightBasisPoints: 0,
        entries: [{ conditionID: 1, weightBasisPoints: 10000 }] }];
    const [missing] = scoreModels([modelWith([[3, 100]])], entries, 20000, { fallbackRules: rules, fallbackScope: 'public' });
    assert.equal(missing.lower, 0);
    assert.equal(missing.upper, 100);
    assert.equal(missing.fallbackUsageCount, 1);
    const [known] = scoreModels([modelWith([[2, 80]])], entries, 20000, { fallbackRules: rules, fallbackScope: 'public' });
    assert.equal(known.lower, 80);
    assert.equal(known.upper, 80);
    assert.equal(known.fallbackUsageCount, 1);
});

test('malformed public aggregates fail instead of silently renormalizing or ignoring residuals', () => {
    const rule = { primaryConditionID: 1, mode: 'fallback_if_missing', unconfiguredWeightBasisPoints: 2000,
        entries: [{ conditionID: 2, weightBasisPoints: 8000 }] };
    for (const invalid of [{ ...rule, unconfiguredWeightBasisPoints: undefined }, { ...rule, unconfiguredWeightBasisPoints: -1 },
        { ...rule, unconfiguredWeightBasisPoints: 0 }, { ...rule, entries: [{ conditionID: 2, weightBasisPoints: NaN }] }]) {
        assert.throws(() => scoreModels([modelWith([])], [{ conditionID: 1, weightBasisPoints: 10000 }], 10000,
            { fallbackRules: [invalid], fallbackScope: 'public' }));
    }
});

test('workspace snapshot errors roll back and release the pooled connection', async () => {
    const events = [];
    const failure = new Error('read failed');
    const db = { async getConnection() { return {
        async query(sql) { events.push(sql); },
        async execute() { throw failure; },
        async commit() { events.push('commit'); },
        async rollback() { events.push('rollback'); },
        release() { events.push('release'); }
    }; } };
    await assert.rejects(getRankingWorkspace(db), error => error === failure);
    assert.deepEqual(events, ['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
        'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY', 'rollback', 'release']);
});

test('public fallback is weighted by primary allocation, including holders without rules', async () => {
    const result = await load([
        weight(1, 1, 6000), weight(1, 4, 4000),
        weight(2, 1, 2000), weight(2, 4, 8000),
        weight(3, 1, 2000), weight(3, 4, 8000),
        weight(4, 4, 10000), weight(5, null, null)
    ], [component(1, 1, 2, 5000), component(1, 1, 3, 5000), component(2, 1, 2, 10000)]);
    assert.equal(result.participantCount, 4);
    assert.deepEqual(result.fallbackRules, [{ primaryConditionID: 1, mode: 'fallback_if_missing',
        unconfiguredWeightBasisPoints: 2000,
        entries: [{ conditionID: 2, weightBasisPoints: 5000 }, { conditionID: 3, weightBasisPoints: 3000 }] }]);
});

test('public union can exceed private component limit and preserve sub-percent shares', async () => {
    const weights = [], rules = [];
    for (let i = 0; i < 13; i++) {
        weights.push(weight(i + 1, 1, i === 0 ? 100 : 10000));
        if (i === 0) weights.push(weight(1, 99, 9900));
        rules.push(component(i + 1, 1, i + 2, 10000));
    }
    const result = await load(weights, rules, [1, 99, ...rules.map(row => row.fallback_benchmark_condition_ID)]);
    const rule = result.fallbackRules[0];
    assert.equal(rule.entries.length, 13);
    assert.equal(rule.unconfiguredWeightBasisPoints, 0);
    const small = rule.entries.find(entry => entry.conditionID === 2).weightBasisPoints;
    assert.ok(small > 0 && small < 100 && !Number.isInteger(small));
    assert.ok(Math.abs(rule.entries.reduce((sum, entry) => sum + entry.weightBasisPoints, 0) - 10000) < 1e-6);
});

test('no configured fallback and empty pies produce an explicit empty rules array', async () => {
    assert.deepEqual((await load([weight(1, 1, 10000)], [])).fallbackRules, []);
    assert.deepEqual((await load([weight(1, null, null)], [])).fallbackRules, []);
});

test('invalid stored public-source rules fail instead of being skipped or renormalized', async () => {
    const weights = [weight(1, 1, 5000), weight(1, 2, 5000)];
    for (const [rules, code] of [
        [[component(1, 1, 3, 6000)], 'personal_pie_fallback_total_invalid'],
        [[component(1, 1, 3, 5000), component(1, 1, 3, 5000)], 'personal_pie_fallback_component_duplicate'],
        [[component(1, 1, 2, 10000), component(1, 2, 1, 10000)], 'personal_pie_fallback_cycle_invalid'],
        [[component(1, 1, 99, 10000)], 'personal_pie_fallback_condition_not_available']
    ]) await assert.rejects(load(weights, rules), error => error.body?.error === code);
});

test('client accepts public residuals but preserves strict personal fallback validation', () => {
    const rule = { primaryConditionID: 1, mode: 'fallback_if_missing', unconfiguredWeightBasisPoints: 2499.5,
        entries: weightedEntries([{ conditionID: 2, weightBasisPoints: 7500.5 }]) };
    const payload = workspace(createFixtureState({ publicFallbackRules: [rule] }), {});
    assert.equal(validateWorkspacePayload(payload), payload);
    const broken = structuredClone(payload);
    broken.publicPie.fallbackRules[0].unconfiguredWeightBasisPoints = 0;
    assert.throws(() => validateWorkspacePayload(broken), /configured and unconfigured/);
    payload.personalPie.fallbackRules = [rule];
    assert.throws(() => validateWorkspacePayload(payload), /invalid condition or weight/);
});
