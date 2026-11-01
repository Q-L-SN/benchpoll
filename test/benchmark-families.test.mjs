import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { familyKey, resolveFamilyScore, groupSmallFamilies } from '../public/js/shared/benchmark-families.js';
import { parseFamilyRows, ensureBenchmarkFamily } from '../benchmark-family-service.js';
import { scoreModels, buildBenchmarkList, savePersonalPie } from '../ranking-service.js';
import { convertWeightedRules } from '../scripts/migrate-ordered-benchmark-families.mjs';
import { createRankingPager } from '../ranking-pagination.js';
import { benchmarks, familyEntries, createFixtureState, workspace } from '../scripts/frontend/fixtures.mjs';
import { validateWorkspacePayload } from '../public/js/workspace/contracts.js';

const model = scores => ({ ID: 1, modelID: 1, name: 'Fixture', results: new Map(scores.map(([ID, value]) => [String(ID), { normalizedScore: value }])) });
const rule = (primary, IDs) => ({ primaryConditionID: primary, mode: 'ordered', entries: IDs.map(conditionID => ({ conditionID })) });
const family = (IDs, weightBasisPoints, familyID = 1) => ({ primaryConditionID: 1, familyID: IDs.length ? familyID : null,
    entries: IDs.map(conditionID => ({ conditionID })), weightBasisPoints });

test('family identity includes condition IDs and exact order, not labels or percentages', () => {
    assert.equal(familyKey(1, [{ conditionID: 2 }, { conditionID: 3 }]), '[1,2,3]');
    assert.notEqual(familyKey(1, [{ conditionID: 2 }, { conditionID: 3 }]), familyKey(1, [{ conditionID: 3 }, { conditionID: 2 }]));
    assert.equal(familyKey(1), '[1]');
    for (const entries of [[{ conditionID: 1 }], [{ conditionID: 2 }, { conditionID: 2 }], [{ conditionID: '2' }]]) assert.throws(() => familyKey(1, entries));
});

test('first present wins, even when another fallback is higher', () => {
    const scores = model([[2, 20], [3, 90]]);
    assert.equal(resolveFamilyScore(scores, 1, rule(1, [2, 3]).entries).normalizedScore, 20);
    assert.equal(resolveFamilyScore(scores, 1, rule(1, [3, 2]).entries).normalizedScore, 90);
    assert.equal(resolveFamilyScore(scores, 1, rule(1, [4, 3]).entries).conditionID, 3);
});

test('zero, negative, and overflow are actual scores and stop the chain', () => {
    for (const value of [0, -35, 140]) {
        const resolved = resolveFamilyScore(model([[1, value], [2, 95]]), 1, [{ conditionID: 2 }]);
        assert.equal(resolved.normalizedScore, value);
        assert.deepEqual(resolved.attemptedConditionIDs, [1]);
    }
    assert.throws(() => resolveFamilyScore(model([[1, NaN]]), 1));
});

test('chains do not recursively follow another entrance configuration', () => {
    const [scored] = scoreModels([model([[3, 100]])], [{ conditionID: 1, weightBasisPoints: 10000 }], 10000,
        { fallbackRules: [rule(1, [2]), rule(2, [3])] });
    assert.equal(scored.lower, 0); assert.equal(scored.upper, 100); assert.equal(scored.coverage, 0);
    assert.deepEqual(scored.fallbackResolutions[0].attemptedConditionIDs, [1, 2]);
});

test('no artificial fallback-length limit; late alternatives are resolved', () => {
    const IDs = Array.from({ length: 2000 }, (_, index) => index + 2);
    const [scored] = scoreModels([model([[2001, 60]])], [{ conditionID: 1, weightBasisPoints: 10000 }], 10000, { fallbackRules: [rule(1, IDs)] });
    assert.equal(scored.lower, 60); assert.equal(scored.coverage, 100);
});

test('long-chain storage batches SQL parameters and preserves the global position order', async () => {
    const entries = Array.from({ length: 23000 }, (_, index) => ({ conditionID: index + 2 }));
    const chainHash = createHash('sha256').update(familyKey(1, entries)).digest('hex');
    const stored = [];
    let batches = 0;
    const connection = { execute: async (sql, values) => {
        if (sql.startsWith('INSERT INTO benchmark_families')) return [{ insertId: 19 }];
        if (sql.startsWith('INSERT INTO benchmark_family_members')) {
            assert.ok(values.length <= 3000);
            batches++;
            for (let index = 0; index < values.length; index += 3) stored.push({
                family_ID: values[index], primary_benchmark_condition_ID: 1, chain_hash: chainHash,
                position: values[index + 1], fallback_benchmark_condition_ID: values[index + 2]
            });
            return [{ affectedRows: values.length / 3 }];
        }
        assert.match(sql, /ORDER BY m.position FOR UPDATE/);
        return [stored];
    } };
    assert.equal(await ensureBenchmarkFamily(connection, 1, entries), 19);
    assert.equal(batches, 23);
    assert.deepEqual(parseFamilyRows(stored)[0].entries, entries);
});

test('both score modes use the same family result; unavailable references do not invent missing scores', () => {
    const entries = [{ conditionID: 1, weightBasisPoints: 7000 }, { conditionID: 4, weightBasisPoints: 3000 }];
    const scores = model([[2, 80], [3, 99]]);
    const [range] = scoreModels([scores], entries, 10000, { fallbackRules: [rule(1, [2, 3])] });
    const [available] = scoreModels([scores], entries, 10000, { fallbackRules: [rule(1, [2, 3])], scoreMode: 'available' });
    assert.deepEqual([range.lower, range.upper, range.coverage], [56, 86, 70]);
    const expected = Number((80 * 5 * .7 / (1 + 4 * .7)).toFixed(2));
    assert.deepEqual([available.lower, available.upper, available.coverage], [expected, expected, 70]);
    assert.equal(available.availableInference.observedScore, 80);
    assert.ok(Math.abs(available.availableInference.unresolvedFraction - .3) < 1e-9);
    assert.deepEqual(available.inferredScores, []);
    assert.equal(range.calculationScores[0].conditionID, 2);
    assert.equal(available.calculationScores[0].conditionID, 2);
    assert.equal(range.calculationScores[0].fallbackFor, 1);
    assert.deepEqual(range.calculationScores[0].familyConditionIDs, [1, 2, 3]);
});

test('public families remain separate and no-fallback holders retain missing weight', () => {
    const families = [family([2, 3], 6000), family([3, 2], 2000, 2), family([], 2000)];
    const options = { fallbackScope: 'public', familyComposition: [{ primaryConditionID: 1, families }] };
    const [result] = scoreModels([model([[2, 80], [3, 50]])], [{ conditionID: 1, weightBasisPoints: 10000 }], 10000, options);
    assert.deepEqual([result.lower, result.upper, result.coverage], [58, 78, 80]);
    assert.deepEqual(result.calculationScores.map(score => [score.conditionID, score.weightBasisPoints]), [[2, 6000], [3, 2000]]);
    const [available] = scoreModels([model([[2, 80], [3, 50]])], [{ conditionID: 1, weightBasisPoints: 10000 }], 10000, { ...options, scoreMode: 'available' });
    assert.equal(available.lower, Number((72.5 * 5 * .8 / (1 + 4 * .8)).toFixed(2)));
    assert.equal(available.availableInference.observedScore, 72.5);
    assert.deepEqual(available.inferredScores, []);
});

test('public direct score occupies the entrance once, not once plus its family weight', () => {
    const [result] = scoreModels([model([[1, 0], [2, 80]])], [{ conditionID: 1, weightBasisPoints: 10000 }], 10000,
        { fallbackScope: 'public', familyComposition: [{ primaryConditionID: 1, families: [family([2], 6000), family([], 4000)] }] });
    assert.equal(result.lower, 0); assert.equal(result.coverage, 100); assert.equal(result.fallbackUsageCount, 0);
    assert.equal(result.calculationScores.reduce((sum, score) => sum + score.weightBasisPoints, 0), 10000);
});

test('small-share grouping uses strictly less than 3% and changes no scoring data', () => {
    const families = [family([2], 9300), family([3], 300, 2), family([4], 200, 3), family([], 200)];
    const before = structuredClone(families);
    const grouped = groupSmallFamilies(families);
    assert.equal(grouped.visible.length, 2); assert.equal(grouped.other.length, 2); assert.equal(grouped.otherWeightBasisPoints, 400);
    assert.deepEqual(families, before);
    assert.throws(() => groupSmallFamilies([family([], 9000)]));
});

test('stored chains reject gaps, duplicate IDs, changed order/hash and orphan members', () => {
    const rows = [2, 3].map((ID, index) => ({ family_ID: 1, primary_benchmark_condition_ID: 1,
        chain_hash: createHash('sha256').update('[1,2,3]').digest('hex'), position: index + 1, fallback_benchmark_condition_ID: ID }));
    assert.deepEqual(parseFamilyRows(rows)[0], { familyID: 1, primaryConditionID: 1, mode: 'ordered', entries: [{ conditionID: 2 }, { conditionID: 3 }] });
    for (const invalid of [[{ ...rows[0], position: 2 }], [rows[0], { ...rows[1], fallback_benchmark_condition_ID: 2 }],
        [rows[0]], [{ ...rows[0], fallback_benchmark_condition_ID: null }]]) assert.throws(() => parseFamilyRows(invalid));
});

test('old weighted requests are rejected before any database access', async () => {
    let touched = false;
    const db = { getConnection() { touched = true; throw new Error('Should not access DB'); } };
    const request = { userID: '1', categoryID: 1, expectedRevision: 0, entries: [{ conditionID: 1, weightBasisPoints: 10000 }] };
    for (const fallbackRules of [[{ ...rule(1, [2]), mode: 'fallback_if_missing' }], [{ ...rule(1, [2]), entries: [{ conditionID: 2, weightBasisPoints: 10000 }] }], [rule(1, [2]), rule(1, [3])], [rule(1, [1])]]) {
        await assert.rejects(savePersonalPie(db, { ...request, fallbackRules }), error => error.status === 400);
    }
    assert.equal(touched, false);
});

test('migration is exact for one 100% fallback and refuses implicit weighted conversion', () => {
    const rules = [{ pie_ID: 1, primary_benchmark_condition_ID: 1, mode: 'fallback_if_missing' }];
    const member = (ID, weight) => ({ pie_ID: 1, primary_benchmark_condition_ID: 1, fallback_benchmark_condition_ID: ID, weight_basis_points: weight });
    assert.deepEqual(convertWeightedRules(rules, [member(2, 10000)])[0].entries, [{ conditionID: 2 }]);
    assert.throws(() => convertWeightedRules(rules, [member(2, 6000), member(3, 4000)]));
    assert.deepEqual(convertWeightedRules(rules, [member(2, 6000), member(3, 4000)], { allowWeightedConversion: true })[0].entries, [{ conditionID: 2 }, { conditionID: 3 }]);
});

test('family rows show their own shares, remain searchable by alternatives, and never alter Pie entries', () => {
    const catalogue = [{ ...rule(1, [2, 3]), familyID: 12, entries: familyEntries(rule(1, [2, 3]).entries) }];
    const rows = buildBenchmarkList(benchmarks.map(row => ({ ...row, type: 'benchmark' })),
        [{ conditionID: 1, weightBasisPoints: 10000 }], [{ conditionID: 1, weightBasisPoints: 10000 }], catalogue,
        [{ primaryConditionID: 1, families: [{ ...catalogue[0], weightBasisPoints: 4000, overallWeightBasisPoints: 4000 }, { ...family([], 6000), overallWeightBasisPoints: 6000 }] }], catalogue);
    assert.equal(rows.filter(row => row.isFamily)[0].publicWeight, 40);
    assert.equal(rows.find(row => !row.isFamily && row.conditionID === 1).publicWeight, 100);
    const data = workspace(createFixtureState({ families: catalogue }), { categoryID: 1 });
    const pager = createRankingPager();
    const first = pager.create({ ...data, benchmarks: rows }, { userID: '1', query: 'code generation' });
    const entrance = first.benchmarks.find(row => row.conditionID === 1);
    assert.equal(entrance.fallbackConfigCount, 1);
    assert.equal(first.benchmarks.some(row => row.isFamily), false);
    const configurations = pager.getPage({ snapshotID: first.rankingPagination.snapshotID, userID: '1',
        list: 'fallbacks', conditionID: 1 });
    assert.deepEqual(entrance.featuredFallbackConfigurations.map(row => row.familyID), [12]);
    assert.deepEqual(configurations.featuredFallbackConfigurations.map(row => row.familyID), [12]);
    assert.deepEqual(configurations.items, []);
    assert.equal(first.personalPie.entries.length, data.personalPie.entries.length);
});

test('workspace validation accepts new compositions and rejects share loss and obsolete payloads', () => {
    const data = workspace(createFixtureState(), { categoryID: 1 });
    assert.equal(validateWorkspacePayload(data), data);
    const broken = structuredClone(data); broken.publicPie.familyComposition[0].families[0].weightBasisPoints = 9900;
    assert.throws(() => validateWorkspacePayload(broken));
    const legacy = structuredClone(data); delete legacy.publicPie.familyComposition; legacy.publicPie.fallbackRules = [];
    assert.throws(() => validateWorkspacePayload(legacy));
});
