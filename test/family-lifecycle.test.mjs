import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { loadBenchmarkFamilies, loadReferencedBenchmarkFamilyIDs, pruneUnusedBenchmarkFamilies } from '../benchmark-family-service.js';
import { createRankingPager } from '../ranking-pagination.js';
import { familyEntries, createFixtureState, workspace } from '../scripts/frontend/fixtures.mjs';

const rule = (IDs, familyID) => ({ primaryConditionID: 1, familyID, mode: 'ordered',
    entries: familyEntries(IDs.map(conditionID => ({ conditionID }))) });

test('catalogue reads require a current rule, but integrity reads can include unused families', async () => {
    const db = { execute: async sql => {
        const usedOnly = sql.includes('WHERE EXISTS');
        if (usedOnly) assert.match(sql, /r\.family_ID = f\.ID/);
        return [[{ family_ID: 3, primary_benchmark_condition_ID: 1,
            chain_hash: createHash('sha256').update('[1,2]').digest('hex'),
            position: 1, fallback_benchmark_condition_ID: 2 }, ...usedOnly ? [] : [{
            family_ID: 4, primary_benchmark_condition_ID: 1,
            chain_hash: createHash('sha256').update('[1,3]').digest('hex'),
            position: 1, fallback_benchmark_condition_ID: 3 }]]];
    } };
    assert.deepEqual((await loadBenchmarkFamilies(db, { referencedOnly: true })).map(row => row.familyID), [3]);
    assert.deepEqual((await loadBenchmarkFamilies(db)).map(row => row.familyID), [3, 4]);
});

test('pagination reference refresh reads distinct current family IDs', async () => {
    const db = { execute: async sql => {
        assert.equal(sql, 'SELECT DISTINCT family_ID FROM personal_pie_score_rules WHERE family_ID IS NOT NULL');
        return [[{ family_ID: '17' }, { family_ID: '21' }]];
    } };
    assert.deepEqual(await loadReferencedBenchmarkFamilyIDs(db), [17, 21]);
});

test('cleanup deletes only unreferenced candidates and retains FK protections', async () => {
    let calls = 0;
    const db = { execute: async (sql, values) => {
        calls++;
        assert.match(sql, /^DELETE f FROM benchmark_families f/);
        assert.match(sql, /NOT EXISTS \(SELECT 1 FROM personal_pie_score_rules r WHERE r\.family_ID = f\.ID\)/);
        assert.doesNotMatch(sql, /FOREIGN_KEY_CHECKS/);
        assert.deepEqual(values, calls === 1 ? [3, 4] : []);
        if (calls === 1) assert.match(sql, /f\.ID IN \(\?, \?\)/);
        return [{ affectedRows: 1 }];
    } };
    assert.equal(await pruneUnusedBenchmarkFamilies(db, []), 0);
    assert.equal(calls, 0);
    assert.equal(await pruneUnusedBenchmarkFamilies(db, [3, 4, 3]), 1);
    assert.equal(await pruneUnusedBenchmarkFamilies(db), 1);
    for (const IDs of [[0], ['3'], {}, [1.1]]) await assert.rejects(pruneUnusedBenchmarkFamilies(db, IDs), TypeError);
    assert.equal(calls, 2);
});

test('removed family disappears from cached searches and page totals, while used and guest families survive', () => {
    const fixture = workspace(createFixtureState({ families: [rule([2], 10), rule([3], 11), rule([4], null)] }), {}, { paginate: false });
    const pager = createRankingPager();
    const initial = pager.create(fixture);
    const request = { snapshotID: initial.rankingPagination.snapshotID, list: 'benchmarks', group: 'primary' };
    const configurations = { snapshotID: request.snapshotID, list: 'fallbacks', conditionID: 1 };
    assert.equal(pager.getPage({ ...request, query: 'Advanced reasoning' }).items.some(row => row.conditionID === 1), true);
    const before = pager.getPage(request).total;
    pager.retainReferencedFamilies([11]);
    assert.equal(pager.getPage({ ...request, query: 'Advanced reasoning' }).items.some(row => row.conditionID === 1), false);
    const after = pager.getPage(request);
    assert.equal(after.total, before);
    assert.equal(after.items.find(row => row.conditionID === 1).fallbackConfigCount, 2);
    assert.deepEqual(pager.getPage(configurations).items.map(row => row.familyID), [11, null]);
    pager.retainReferencedFamilies([]);
    assert.deepEqual(pager.getPage(configurations).items.map(row => row.familyID), [null]);
});

test('save cleanup is in the weight transaction; public catalogue and stale search both check usage', async () => {
    const ranking = await readFile(new URL('../ranking-service.js', import.meta.url), 'utf8');
    const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
    const save = ranking.slice(ranking.indexOf('export async function savePersonalPie'));
    assert.match(save, /SELECT family_ID FROM personal_pie_score_rules[\s\S]*?FOR UPDATE/);
    assert.match(save, /pruneUnusedBenchmarkFamilies\(connection, previousFamilyIDs\);[\s\S]*?completeWriteIntent\(connection, intent,[\s\S]*?await commitTransactionConnection\(connection, 'SAVE PERSONAL PIE'\)/);
    assert.match(ranking, /loadBenchmarkFamilies\(db, \{ referencedOnly: true \}\)/);
    assert.match(server, /\['benchmarks', 'fallbacks'\]\.includes\(req\.body\.list\)[\s\S]*?retainReferencedFamilies\(await loadReferencedBenchmarkFamilyIDs\(db\)\)/);
});

test('removing a configuration invalidates fallback offsets but preserves ordinary version pagination', () => {
    const fixture = workspace(createFixtureState({ families: [rule([2], 10)] }), {}, { paginate: false });
    fixture.benchmarks.push(...Array.from({ length: 60 }, (_, index) => ({
        ...fixture.benchmarks[0], ID: index + 1000, conditionID: index + 1000, name: `Extra benchmark ${index}`
    })));
    const pager = createRankingPager();
    const initial = pager.create(fixture);
    const request = { snapshotID: initial.rankingPagination.snapshotID, list: 'benchmarks', group: 'primary' };
    assert.equal(pager.getPage({ ...request, offset: 40 }).items.length > 0, true);
    pager.retainReferencedFamilies([]);
    assert.throws(() => pager.getPage({ snapshotID: request.snapshotID, list: 'fallbacks', conditionID: 1, offset: 1 }), error => error.status === 410
        && error.body.error === 'ranking_snapshot_expired');
    assert.equal(pager.getPage({ ...request, offset: 40 }).items.length > 0, true);
    assert.equal(pager.getPage({ ...request, offset: 0 }).items.find(row => row.conditionID === 1).fallbackConfigCount, 0);
});
