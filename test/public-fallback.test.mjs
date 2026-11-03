import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadPublicPie, getRankingWorkspace, scoreModels } from '../ranking-service.js';

const weight = (pie, condition, points) => ({ pie_ID: pie, context_ID: 10,
    benchmark_condition_ID: condition, weight_basis_points: points });
const chainRows = (pie, primary, IDs) => {
    const chainHash = createHash('sha256').update(JSON.stringify([primary, ...IDs])).digest('hex');
    const familyID = parseInt(chainHash.slice(0, 10), 16);
    return IDs.map((ID, index) => ({ pie_ID: pie, family_ID: familyID,
        primary_benchmark_condition_ID: primary, chain_hash: chainHash, position: index + 1,
        fallback_benchmark_condition_ID: ID }));
};
const noFallback = (pie, primary) => ({ pie_ID: pie, primary_benchmark_condition_ID: primary,
    selected_family_ID: null, family_ID: null, chain_hash: null, position: null, fallback_benchmark_condition_ID: null });
function database(weights, rules) {
    return { async execute(sql, params) {
        if (sql.includes('FROM ranking_contexts rc')) {
            assert.match(sql, /WHERE rc.category_ID = \? AND c.is_active = 1 AND c.owner_user_ID IS NULL/);
            assert.doesNotMatch(sql, /WITH RECURSIVE|parent_ID/);
            assert.deepEqual(params, [1]);
            return [[{ ID: 10, category_ID: 1, context_values: '{}' }], []];
        }
        if (sql.includes('FROM personal_pies')) {
            assert.deepEqual(params, [10]);
            assert.match(sql, /users.deleted_at IS NULL/);
            assert.match(sql, /users.banned_at IS NULL/);
            return [weights.map(row => ({ ...row, is_recent: 1, is_fallback_recent: 1 })), []];
        }
        if (sql.includes('FROM personal_pie_score_rules')) {
            assert.deepEqual(params, [...new Set(weights.filter(row => row.benchmark_condition_ID !== null).map(row => row.pie_ID))]);
            return [rules, []];
        }
        throw Error('Unexpected query: ' + sql);
    } };
}
const load = (weights, rules, IDs = [1, 2, 3, 4]) => loadPublicPie(database(weights, rules),
    { categoryID: 1, dimensions: [], contextValues: {} }, new Map(IDs.map(ID => [ID, {}])));
const modelWith = entries => ({ ID: 1, modelID: 1, name: 'Fixture model',
    results: new Map(entries.map(([ID, normalizedScore]) => [String(ID), { normalizedScore, sampleCount: 1 }])) });
const publicScore = (pie, model, scoreMode = 'range') => scoreModels([model], pie.scoringEntries, pie.participantCount * 10000,
    { familyComposition: pie.familyComposition, fallbackScope: 'public', scoreMode })[0];

test('public scoring keeps complete ordered families separate, including the no-fallback share', async () => {
    const pie = await load([
        weight(1, 1, 6000), weight(1, 4, 4000), weight(2, 1, 2000), weight(2, 4, 8000),
        weight(3, 1, 2000), weight(3, 4, 8000), weight(4, 4, 10000)
    ], [...chainRows(1, 1, [2, 3]), ...chainRows(2, 1, [3, 2]), noFallback(3, 1)]);
    const result = publicScore(pie, modelWith([[2, 80], [3, 20], [4, 40]]));
    assert.equal(Object.hasOwn(pie, 'composition'), false);
    assert.deepEqual([result.lower, result.upper, result.coverage], [43, 48, 95]);
    assert.equal(result.fallbackCoverage, 20);
    assert.equal(result.fallbackUsageCount, 1);
    assert.equal(result.resultCount, 3);
    assert.deepEqual(pie.familyComposition[0].families.map(f => [f.entries.map(e => e.conditionID), f.weightBasisPoints]),
        [[[2, 3], 6000], [[3, 2], 2000], [[], 2000]]);
});

test('direct zero, negative and overflow scores override every public family without duplicate weight', async () => {
    const pie = await load([weight(1, 1, 10000), weight(2, 1, 10000)],
        chainRows(1, 1, [2]));
    for (const score of [0, -50, 150]) {
        const result = publicScore(pie, modelWith([[1, score], [2, 90]]));
        assert.deepEqual([result.lower, result.upper, result.coverage], [score, score, 100]);
        assert.equal(result.fallbackUsageCount, 0);
        assert.equal(result.calculationScores.reduce((sum, row) => sum + row.effectiveWeight, 0), 100);
    }
});

test('public scoring without a matching community composition uses only the original benchmark', () => {
    const weights = [{ conditionID: 1, weightBasisPoints: 10000 }];
    for (const composition of [{}, { familyComposition: [] }, { familyComposition: [{ primaryConditionID: 3,
        families: [{ primaryConditionID: 3, familyID: 9, entries: [{ conditionID: 2 }], weightBasisPoints: 10000 }] }] }]) {
        for (const scoreMode of ['range', 'available']) {
            const options = { ...composition, fallbackScope: 'public', scoreMode };
            for (const score of [0, -20, 80, 150]) {
                const [result] = scoreModels([modelWith([[1, score], [2, 95]])], weights, 10000, options);
                assert.deepEqual([result.lower, result.upper, result.coverage], [score, score, 100]);
                assert.equal(result.fallbackUsageCount, 0);
                assert.equal(result.fallbackCoverage, 0);
                assert.deepEqual(result.calculationScores.map(row => [row.conditionID, row.familyConditionIDs]), [[1, [1]]]);
            }
            const [missing] = scoreModels([modelWith([[2, 95]])], weights, 10000, options);
            assert.deepEqual([missing.lower, missing.upper, missing.coverage], scoreMode === 'range' ? [0, 100, 0] : [null, null, 0]);
            assert.equal(missing.missingWeight, 100);
            assert.deepEqual(missing.calculationScores, []);
            assert.deepEqual(missing.fallbackResolutions, []);
            assert.deepEqual(missing.inferredScores, []);
        }
    }
});

test('no-fallback holders do not inherit another family when their entrance is missing', async () => {
    const pie = await load([weight(1, 1, 10000), weight(2, 1, 10000)], [...chainRows(1, 1, [2]), noFallback(2, 1)]);
    const result = publicScore(pie, modelWith([[2, 80]]));
    assert.deepEqual([result.lower, result.upper, result.coverage], [40, 90, 50]);
    const available = publicScore(pie, modelWith([[2, 80]]), 'available');
    assert.equal(available.lower, 66.67);
    assert.equal(available.availableInference.unresolvedFraction, .5);
    assert.deepEqual(available.inferredScores, []);
    assert.deepEqual([publicScore(pie, modelWith([])).lower, publicScore(pie, modelWith([])).upper], [0, 100]);
});

test('public aggregate equals the average of personal family totals with heterogeneous entrance allocations', async () => {
    const pie = await load([weight(1, 1, 6000), weight(1, 4, 4000), weight(2, 1, 2000), weight(2, 4, 8000)],
        [...chainRows(1, 1, [2, 3]), noFallback(2, 1)]);
    const model = modelWith([[2, -20], [3, 99], [4, 140]]);
    const first = scoreModels([model], [{ conditionID: 1, weightBasisPoints: 6000 }, { conditionID: 4, weightBasisPoints: 4000 }], 10000,
        { familyComposition: pie.familyComposition,
            fallbackRules: [{ primaryConditionID: 1, mode: 'ordered', entries: [{ conditionID: 2 }, { conditionID: 3 }] }] })[0];
    const second = scoreModels([model], [{ conditionID: 1, weightBasisPoints: 2000 }, { conditionID: 4, weightBasisPoints: 8000 }], 10000,
        { familyComposition: pie.familyComposition, fallbackRules: [{ primaryConditionID: 1, mode: 'ordered', entries: [] }] })[0];
    const combined = publicScore(pie, model);
    for (const key of ['lower', 'upper', 'coverage']) assert.equal(combined[key], (first[key] + second[key]) / 2);
});

test('the same globally identified chain from several pies becomes one family share', async () => {
    const pie = await load([weight(1, 1, 10000), weight(2, 1, 10000)],
        [...chainRows(1, 1, [2, 3]), ...chainRows(2, 1, [2, 3])]);
    assert.equal(pie.familyComposition[0].families.length, 1);
    assert.equal(pie.familyComposition[0].families[0].weightBasisPoints, 10000);
});

test('family composition uses entrance weight; absent entrance and empty pies are not in its denominator', async () => {
    const pie = await load([
        weight(1, 1, 6000), weight(1, 4, 4000), weight(2, 1, 2000), weight(2, 4, 8000),
        weight(3, 4, 10000), weight(4, null, null)
    ], chainRows(1, 1, [2]));
    assert.equal(pie.participantCount, 3);
    const families = pie.familyComposition.find(group => group.primaryConditionID === 1).families;
    assert.deepEqual(families.map(f => [f.entries.length, f.weightBasisPoints]), [[1, 10000]]);
    assert.ok(Math.abs(families[0].overallWeightBasisPoints - 8000 / 3) < 1e-6);
});

test('explicit fallback choices use their own fourteen-day window across matching contexts within one topic', async () => {
    const rows = [
        { ...weight(3, 1, 10000), is_recent: 1, is_fallback_recent: 1 },
        { ...weight(2, 1, 10000), is_recent: 1, is_fallback_recent: 1 },
        { ...weight(1, 1, 10000), is_recent: 0, is_fallback_recent: 1 },
        ...[4, 5, 6, 7].map(pie => ({ ...weight(pie, 1, 10000), context_ID: 11, is_recent: 1, is_fallback_recent: 1 }))
    ];
    const connection = { async execute(sql, params) {
        if (sql.includes('FROM ranking_contexts rc')) {
            assert.match(sql, /WHERE rc.category_ID = \? AND c.is_active = 1 AND c.owner_user_ID IS NULL/);
            assert.doesNotMatch(sql, /WITH RECURSIVE|parent_ID/);
            assert.deepEqual(params, [1]);
            return [[
                { ID: 10, category_ID: 1, context_values: '{"web":"any"}' },
                { ID: 11, category_ID: 1, context_values: '{"web":"allowed"}' }
            ], []];
        }
        if (sql.includes('FROM personal_pies')) {
            assert.deepEqual(params, [10, 11]);
            return [rows, []];
        }
        if (sql.includes('FROM personal_pie_score_rules')) { assert.ok(params.includes(1)); return [chainRows(1, 1, [2]), []]; }
        throw Error('Unexpected query: ' + sql);
    } };
    const dimensions = [{ key: 'web', options: [{ key: 'any', isNeutral: true }, { key: 'allowed', isNeutral: false }] }];
    const pie = await loadPublicPie(connection, { categoryID: 1, dimensions, contextValues: { web: 'any' } }, new Map([[1, {}], [2, {}]]));
    assert.equal(pie.participantCount, 7);
    const configured = pie.familyComposition[0].families.find(f => f.entries.length);
    assert.equal(configured.weightBasisPoints, 10000);
    assert.equal(pie.familyComposition[0].configuredPieCount, 1);
    assert.ok(Math.abs(pie.scoringEntries.reduce((sum, entry) => sum + entry.weightBasisPoints, 0) - 70000) < 1e-6);
    assert.deepEqual(pie.contextIDs, [10, 11]);
    assert.equal(Object.hasOwn(pie, 'composition'), false);
});

test('fractional sub-percent public shares and an unlimited number of families remain exact', async () => {
    const weights = [], rules = [];
    for (let i = 0; i < 130; i++) {
        weights.push(weight(i + 1, 1, i ? 10000 : 100));
        if (!i) weights.push(weight(1, 999, 9900));
        rules.push(...chainRows(i + 1, 1, [i + 2]));
    }
    const pie = await load(weights, rules, [1, 999, ...Array.from({ length: 130 }, (_, i) => i + 2)]);
    const families = pie.familyComposition.find(group => group.primaryConditionID === 1).families;
    assert.equal(families.length, 130);
    const small = families.find(f => f.entries[0].conditionID === 2).weightBasisPoints;
    assert.ok(small > 0 && small < 100 && !Number.isInteger(small));
    assert.ok(Math.abs(families.reduce((sum, f) => sum + f.weightBasisPoints, 0) - 10000) < 1e-6);
    assert.equal(publicScore(pie, modelWith(Array.from({ length: 130 }, (_, i) => [i + 2, 80]))).lower, 79.39);
});

test('flat families can reference other entrance conditions without recursive cross-family substitution', async () => {
    const pie = await load([weight(1, 1, 5000), weight(1, 2, 5000)],
        [...chainRows(1, 1, [2]), ...chainRows(1, 2, [1])]);
    const result = publicScore(pie, modelWith([[3, 100]]));
    assert.deepEqual([result.lower, result.upper, result.coverage, result.fallbackUsageCount], [0, 100, 0, 0]);
});

test('no explicit choices produce a temporary singleton, not a fabricated no-fallback vote', async () => {
    const pie = await load([weight(1, 1, 10000)], []);
    assert.deepEqual(pie.familyComposition, [{ primaryConditionID: 1, configuredPieCount: 0, isDefault: true, families: [{
        primaryConditionID: 1, familyID: null, entries: [], weightBasisPoints: 10000, overallWeightBasisPoints: 10000
    }] }]);
    assert.deepEqual((await load([weight(1, null, null)], [])).familyComposition, []);
});

test('unconfigured holders inherit a mixed electorate without enlarging or diluting it', async () => {
    const weights = Array.from({ length: 100 }, (_, i) => weight(i + 1, 1, 10000));
    const rules = [...Array.from({ length: 6 }, (_, i) => chainRows(i + 1, 1, [2])).flat(),
        ...Array.from({ length: 3 }, (_, i) => chainRows(i + 7, 1, [3])).flat(), noFallback(10, 1)];
    const pie = await load(weights, rules);
    const group = pie.familyComposition[0];
    assert.equal(group.configuredPieCount, 10);
    assert.equal(group.isDefault, false);
    assert.deepEqual(group.families.map(f => [f.entries.map(e => e.conditionID), f.weightBasisPoints]),
        [[[2], 6000], [[3], 3000], [[], 1000]]);
    const model = modelWith([[2, 80], [3, 20]]);
    const inputs = [{ conditionID: 1, weightBasisPoints: 10000 }];
    for (const scoreMode of ['range', 'available']) {
        const options = { familyComposition: pie.familyComposition, scoreMode };
        const inherited = scoreModels([model], inputs, 10000, options)[0];
        assert.deepEqual([inherited.lower, inherited.upper, inherited.coverage], scoreMode === 'range' ? [54, 64, 90] : [58.7, 58.7, 90]);
        const own = scoreModels([model], inputs, 10000, { ...options,
            fallbackRules: [{ primaryConditionID: 1, mode: 'ordered', entries: [{ conditionID: 3 }] }] })[0];
        assert.deepEqual([own.lower, own.upper, own.coverage], [20, 20, 100]);
        const none = scoreModels([model], inputs, 10000, { ...options,
            fallbackRules: [{ primaryConditionID: 1, mode: 'ordered', entries: [] }] })[0];
        assert.deepEqual([none.lower, none.upper, none.coverage], scoreMode === 'range' ? [0, 100, 0] : [null, null, 0]);
        assert.equal(publicScore(pie, model, scoreMode).lower, inherited.lower);
    }
    assert.equal((await load(weights, [noFallback(10, 1)])).familyComposition[0].configuredPieCount, 1);
});

test('explicit none round-trips independently from absence and a broken family never becomes none', async () => {
    const pie = await load([weight(1, 1, 10000)], [noFallback(1, 1)]);
    assert.equal(pie.familyComposition[0].configuredPieCount, 1);
    assert.equal(pie.familyComposition[0].isDefault, false);
    await assert.rejects(load([weight(1, 1, 10000)], [{ ...noFallback(1, 1), selected_family_ID: 99 }]),
        error => error.body?.error === 'benchmark_family_invariant_failed');
});

test('malformed stored order, duplicated members and unavailable conditions fail explicitly', async () => {
    const valid = chainRows(1, 1, [2, 3]);
    for (const rows of [[{ ...valid[0], position: 2 }], [valid[0], { ...valid[1], fallback_benchmark_condition_ID: 2 }]]) {
        await assert.rejects(load([weight(1, 1, 10000)], rows), error => error.body?.error === 'benchmark_family_invariant_failed');
    }
    await assert.rejects(load([weight(1, 1, 10000)], chainRows(1, 1, [99])),
        error => error.body?.error === 'personal_pie_fallback_condition_not_available');
});

test('workspace snapshot errors roll back and release the pooled connection', async () => {
    const events = [], failure = new Error('read failed');
    const db = { async getConnection() { return {
        async query(sql) { events.push(sql); }, async execute() { throw failure; },
        async commit() { events.push('commit'); }, async rollback() { events.push('rollback'); }, release() { events.push('release'); }
    }; } };
    await assert.rejects(getRankingWorkspace(db), error => error === failure);
    assert.deepEqual(events, ['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
        'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY', 'rollback', 'release']);
});
