import { pairedModels } from './helpers/fallback-pairs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { familyKey, resolveFallbackChain, groupSmallFamilies } from '../public/js/shared/benchmark-families.js';
import { parseFamilyRows, ensureBenchmarkFamily } from '../benchmark-family-service.js';
import { scoreModels, buildBenchmarkList, normalizePreviewPersonalPie } from '../ranking-service.js';
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

test('the first calibratable backup wins and direct scores bypass calibration', () => {
    const scores = model([[2, 20], [3, 90]]);
    const predict = (ID, score) => ({ sourceConditionID: ID, normalizedScore: score - 5 });
    assert.equal(resolveFallbackChain(scores, [1, 2, 3], predict).prediction.normalizedScore, 15);
    assert.equal(resolveFallbackChain(scores, [1, 3, 2], predict).prediction.normalizedScore, 85);
    assert.equal(resolveFallbackChain(scores, [1, 4, 3], predict).attemptedCount, 3);
});

test('zero, negative, and overflow are actual scores and stop the chain', () => {
    for (const value of [0, -35, 140]) {
        const resolved = resolveFallbackChain(model([[1, value], [2, 95]]), [1, 2], () => assert.fail('direct score wins'));
        assert.equal(resolved.normalizedScore, value);
        assert.equal(resolved.attemptedCount, 1);
    }
    assert.throws(() => resolveFallbackChain(model([[1, NaN]]), [1]));
});

test('chains do not recursively follow another entrance configuration', () => {
    const [scored] = scoreModels([model([[3, 100]])], [{ conditionID: 1, weightBasisPoints: 10000 }], 10000,
        { fallbackRules: [rule(1, [2]), rule(2, [3])] });
    assert.equal(scored.lower, 0); assert.equal(scored.upper, 100); assert.equal(scored.coverage, 0);
    assert.deepEqual(scored.fallbackResolutions[0].attemptedConditionIDs, [1, 2]);
});

test('no artificial fallback-length limit; late alternatives are resolved', () => {
    const IDs = Array.from({ length: 2000 }, (_, index) => index + 2);
    const [scored] = scoreModels([model([[2001, 60]]), ...pairedModels(1, 2001, 60, -5, null)], [{ conditionID: 1, weightBasisPoints: 10000 }], 10000, { scoreMode: 'available', fallbackRules: [rule(1, IDs)] });
    assert.equal(scored.lower, 55); assert.equal(scored.coverage, 0);
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

test('both modes preserve the missing primary, and only the supported backup supplies a point estimate', () => {
    const entries = [{ conditionID: 1, weightBasisPoints: 7000 }, { conditionID: 4, weightBasisPoints: 3000 }];
    const models = [model([[2, 80], [3, 99]]), ...pairedModels(1, 2, 80, -5, null)];
    const rules = { fallbackRules: [rule(1, [2, 3])] };
    const [range] = scoreModels(models, entries, 10000, rules);
    const [available] = scoreModels(models, entries, 10000, { ...rules, scoreMode: 'available' });
    assert.deepEqual([range.lower, range.upper, range.coverage], [0, 100, 0]);
    assert.equal(available.lower, 52.5);
    assert.deepEqual(available.inferredScores.map(row => [row.conditionID, row.sourceConditionID, row.originalWeight]), [[1, 2, 70]]);
    assert.deepEqual(available.calculationScores, []);
});

test('public chains and no-fallback holders retain independent fractions', () => {
    const families = [family([2, 3], 6000), family([3, 2], 2000, 2), family([], 2000)];
    const models = [model([[2, 80], [3, 50]]), ...pairedModels(1, 2, 80, -5, null)];
    const [result] = scoreModels(models, [{ conditionID: 1, weightBasisPoints: 10000 }], 10000,
        { scoreMode: 'available', fallbackScope: 'public', familyComposition: [{ primaryConditionID: 1, families }] });
    assert.equal(result.coverage, 0);
    assert.equal(result.fallbackCoverage, 80);
    assert.deepEqual(result.inferredScores.map(s => [s.sourceConditionID, s.originalWeight]), [[2, 60], [2, 20]]);
    assert.ok(Math.abs(result.availableInference.unresolvedFraction - .2) < 1e-9);
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

test('legacy fallback payloads leave preview weights intact', () => {
    const entries = [{ conditionID: 1, weightBasisPoints: 10000 }];
    for (const fallbackRules of [[{ ...rule(1, [2]), mode: 'fallback_if_missing' }], [{ ...rule(1, [2]), entries: [{ conditionID: 2, weightBasisPoints: 10000 }] }], [rule(1, [2]), rule(1, [3])], [rule(1, [1])]]) {
        assert.deepEqual(normalizePreviewPersonalPie({ entries, fallbackRules }), { entries });
    }
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
