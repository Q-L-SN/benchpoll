import test from 'node:test';
import assert from 'node:assert/strict';
import { communityVersionComposition, expandCommunityVersions, groupBenchmarkRows } from '../public/js/shared/benchmark-version-choice.js';
import { loadPublicPie, normalizePreviewPersonalPie, scoreModels, validateBenchmarkVersionChoices } from '../ranking-service.js';
import { createRankingPager } from '../ranking-pagination.js';
import { migrateCommunityVersions } from '../scripts/migrate-community-versions-20261103.mjs';

const conditions = [
    { ID: 1, conditionID: 1, benchmarkID: 10, name: 'Reasoning', conditionName: 'Original', scoreCount: 12, isPrimaryCondition: true, lowCoverage: false },
    { ID: 2, conditionID: 2, benchmarkID: 10, name: 'Reasoning', conditionName: 'Extended', scoreCount: 25, isPrimaryCondition: false, lowCoverage: false },
    { ID: 3, conditionID: 3, benchmarkID: 20, name: 'Code', conditionName: 'Default', scoreCount: 30, isPrimaryCondition: true, lowCoverage: false }
];
const entry = (conditionID, weightBasisPoints = 10000, follows = false) => ({ conditionID, weightBasisPoints,
    ...(follows ? { followCommunityVersion: true } : {}) });
const pie = (...entries) => ({ entries });

test('shared version validation rejects conflicting abstentions while preserving explicit multi-version mixes', () => {
    const catalogue = new Map(conditions.map(condition => [condition.conditionID, condition]));
    for (const entries of [[entry(1, 5000, true), entry(2, 5000)], [entry(1, 5000), entry(2, 5000, true)]]) {
        assert.throws(() => validateBenchmarkVersionChoices(entries, catalogue, 409),
            error => error.status === 409 && error.body?.error === 'pie_benchmark_version_conflict');
    }
    for (const entries of [[entry(1, 5000), entry(2, 5000)], [entry(1, 5000, true), entry(3, 5000)], [entry(-9), entry(1)]]) {
        assert.doesNotThrow(() => validateBenchmarkVersionChoices(entries, catalogue));
    }
});

test('abstention changes neither version denominator nor selection count, even with large weights', () => {
    const voters = new Map([[1, pie(entry(1, 2000))], [2, pie(entry(2, 6000))]]);
    const initial = communityVersionComposition(voters, conditions);
    for (let ID = 3; ID < 80; ID++) voters.set(ID, pie(entry(1, 10000, true)));
    assert.deepEqual(communityVersionComposition(voters, conditions), initial);
    assert.equal(initial[0].configuredPieCount, 2);
    assert.deepEqual(initial[0].versions.map(version => [version.conditionID, version.selectionBasisPoints]), [[2, 7500], [1, 2500]]);
});

test('equal version shares sort by approved score count, without giving the primary version priority', () => {
    const group = communityVersionComposition(new Map([[1, pie(entry(1))], [2, pie(entry(2))]]), conditions)[0];
    assert.deepEqual(group.versions.map(version => version.conditionID), [2, 1]);
});

test('cold start uses the primary version without inventing a 100 percent vote', () => {
    const composition = communityVersionComposition(new Map([[1, pie(entry(1, 10000, true))]]), conditions);
    const group = composition[0];
    assert.equal(group.isDefault, true); assert.equal(group.configuredPieCount, 0);
    assert.ok(group.versions.every(version => version.selectionBasisPoints === 0));
    assert.deepEqual(expandCommunityVersions([entry(1, 10000, true)], composition), [entry(1)]);
});

test('community mixture preserves missing weight and explicit versions remain unchanged', () => {
    const composition = communityVersionComposition(new Map([[1, pie(entry(1, 2500))], [2, pie(entry(2, 7500))]]), conditions);
    const inherited = expandCommunityVersions([entry(1, 10000, true)], composition);
    const model = { ID: 1, modelID: 1, name: 'Model', results: new Map([['2', { normalizedScore: 80 }]]) };
    const result = scoreModels([model], inherited, 10000)[0];
    assert.deepEqual([result.lower, result.upper, result.coverage], [60, 85, 75]);
    assert.deepEqual(expandCommunityVersions([entry(1)], composition), [entry(1)]);
});

test('an explicit zero score is retained when mixing versions', () => {
    const composition = communityVersionComposition(new Map([[1, pie(entry(1))], [2, pie(entry(2))]]), conditions);
    const model = { ID: 1, results: new Map([['1', { normalizedScore: 0 }], ['2', { normalizedScore: 80 }]]) };
    const score = scoreModels([model], expandCommunityVersions([entry(1, 10000, true)], composition), 10000)[0];
    assert.deepEqual([score.lower, score.upper, score.coverage], [40, 40, 100]);
});

test('fallback requires an explicitly chosen version, including explicit No fallback', () => {
    const entries = [entry(1, 10000, true)];
    assert.deepEqual(normalizePreviewPersonalPie({ entries, fallbackRules: [] }), { entries, fallbackRules: [] });
    for (const members of [[], [{ conditionID: 3 }]]) assert.throws(() => normalizePreviewPersonalPie({ entries,
        fallbackRules: [{ primaryConditionID: 1, mode: 'ordered', entries: members }] }),
    error => error.body?.error === 'fallback_requires_explicit_version');
    assert.equal(normalizePreviewPersonalPie({ entries: [entry(1)], fallbackRules: [] }).fallbackRules.length, 0);
});

test('invalid abstention flags and topic-version choices fail before database access', () => {
    for (const value of [null, 1, 'true']) assert.throws(() => normalizePreviewPersonalPie({
        entries: [{ ...entry(1), followCommunityVersion: value }], fallbackRules: [] }), error => error.status === 400);
    assert.throws(() => normalizePreviewPersonalPie({ entries: [entry(-1, 10000, true)], fallbackRules: [] }), error => error.status === 400);
});

function database(weights, rules = []) {
    return { async execute(sql, params) {
        if (sql.includes('FROM personal_pies')) {
            return [weights.filter(row => params.includes(row.context_ID)).map(row => ({ is_recent: 1, is_fallback_recent: 1, ...row }))];
        }
        if (sql.includes('FROM personal_pie_score_rules')) return [rules.filter(row => params.includes(row.pie_ID))];
        throw new Error('Unexpected fixture query');
    } };
}
const row = (pieID, contextID, conditionID, weight, follows = false) => ({ pie_ID: pieID, context_ID: contextID,
    benchmark_condition_ID: conditionID, weight_basis_points: weight, follow_community_version: Number(follows) });
const none = (pieID, primary) => ({ pie_ID: pieID, primary_benchmark_condition_ID: primary, selected_family_ID: null,
    family_ID: null, position: null, fallback_benchmark_condition_ID: null, selection_source: 'selected' });

test('version and fallback electorates are independent and scoped to the selected scene', async () => {
    const weights = [row(1, 10, 1, 10000), row(2, 10, 2, 10000), row(3, 10, 1, 10000, true), row(4, 11, 2, 10000)];
    const db = database(weights, [none(1, 1), none(4, 2)]);
    const byID = new Map(conditions.map(condition => [condition.conditionID, condition]));
    const first = await loadPublicPie(db, { ID: 10, categoryID: 1, sceneID: 10 }, byID);
    assert.equal(first.participantCount, 3);
    assert.deepEqual(first.entries, [entry(1, 10000, true)]);
    assert.deepEqual(first.versionComposition[0].versions.map(version => [version.conditionID, version.selectionBasisPoints]), [[2, 5000], [1, 5000]]);
    assert.equal(first.communityComposition.find(group => group.primaryConditionID === 1).configuredPieCount, 1);
    assert.equal(first.communityComposition.find(group => group.primaryConditionID === 2).isDefault, true);
    assert.equal(first.communityComposition.find(group => group.primaryConditionID === 2).configuredPieCount, 0);
    assert.equal(first.scoringEntries.reduce((sum, item) => sum + item.weightBasisPoints, 0), 30000);
    const second = await loadPublicPie(db, { ID: 11, categoryID: 1, sceneID: 11 }, byID);
    assert.deepEqual(second.versionComposition[0].versions.map(version => [version.conditionID, version.selectionBasisPoints]), [[2, 10000], [1, 0]]);
});

test('sparse public weights still top up to ten while old version choices expire independently', async () => {
    const weights = [row(1, 10, 1, 10000, true), { ...row(2, 10, 2, 10000), is_recent: 0, is_fallback_recent: 0 }];
    const result = await loadPublicPie(database(weights), { ID: 10, categoryID: 1, sceneID: 10 }, new Map(conditions.map(item => [item.conditionID, item])));
    assert.equal(result.participantCount, 2); assert.equal(result.versionComposition[0].configuredPieCount, 0);
    assert.equal(result.scoringEntries.length, 1); assert.equal(result.scoringEntries[0].conditionID, 1);
});

test('grouped benchmark search retains full benchmark weights and pagination counts', () => {
    const rows = conditions.map(version => ({ ...version, publicWeightBasisPoints: version.conditionID === 1 ? 7000 : version.conditionID === 3 ? 3000 : 0,
        personalWeightBasisPoints: version.conditionID === 2 ? 10000 : null }));
    assert.equal(groupBenchmarkRows(rows).length, 2);
    const pager = createRankingPager();
    const result = pager.create({ benchmarks: rows, versionComposition: [], personalPie: { entries: [entry(2)] },
        modelLeaderboards: { personal: [], public: [] }, scoreMode: 'range' }, { query: 'Extended' });
    assert.equal(result.benchmarks.length, 1);
    assert.equal(result.benchmarks[0].publicWeightBasisPoints, 7000);
    assert.equal(result.benchmarks[0].personalWeightBasisPoints, 10000);
    assert.equal(result.rankingPagination.benchmarkGrouping, 'flat');
});

test('the additive migration keeps legacy choices explicit and can be retried without rewriting weights', async () => {
    let exists = false; const writes = [];
    const connection = { async execute(sql) {
        if (sql.includes('information_schema.COLUMNS')) return [exists ? [{ type: 'tinyint(1)', defaultValue: '0', nullable: 'NO' }] : []];
        if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
        if (sql.includes('RELEASE_LOCK')) return [[]];
        writes.push(sql); exists = true; return [[]];
    } };
    assert.equal((await migrateCommunityVersions(connection)).missing, true);
    assert.equal(writes.length, 0);
    assert.equal((await migrateCommunityVersions(connection, { apply: true })).changed, true);
    assert.equal((await migrateCommunityVersions(connection, { apply: true })).changed, false);
    assert.equal(writes.length, 1); assert.match(writes[0], /DEFAULT 0, ALGORITHM=INSTANT/);
});
