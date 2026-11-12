import assert from 'node:assert/strict';
import test from 'node:test';

import { createRankingPager, rankModels, RANKING_PAGE_SIZE } from '../ranking-pagination.js';
import { deferRankingMetadata } from '../ranking-read-cache.js';

function workspace() {
    const benchmarks = Array.from({ length: 55 }, (_, index) => ({
        ID: index + 1,
        conditionID: index + 1,
        conditionName: index === 53 ? 'rare condition' : 'default',
        name: index === 53 ? 'Needle benchmark' : `Benchmark ${index + 1}`,
        rank: index + 1,
        lowCoverage: false,
        isPrimaryCondition: true,
        scoreCount: 1,
        publicWeightBasisPoints: 55 - index
    }));
    const models = Array.from({ length: 38 }, (_, index) => ({
        ID: index + 1,
        name: `Model ${index + 1}`,
        comparable: true,
        lower: 100 - index,
        upper: 110 - index,
        coverage: 100
    }));
    return {
        scoreMode: 'range',
        benchmarks,
        personalPie: { fallbackRules: [], entries: [
            { conditionID: 54, weightBasisPoints: 7000 },
            { conditionID: 53, weightBasisPoints: 3000 }
        ] },
        modelLeaderboards: { personal: models, public: models }
    };
}

test('the first response contains only the highest-ranked page and keeps global model bounds', () => {
    const pager = createRankingPager();
    const first = pager.create(workspace(), { userID: 7 });
    assert.equal(first.benchmarks.length, RANKING_PAGE_SIZE.benchmarks);
    assert.equal(first.rankingPagination.benchmarks.lowCoverage.total, 0);
    assert.deepEqual(first.benchmarks.map(row => row.rank), Array.from({ length: 40 }, (_, i) => i + 1));
    assert.equal(first.modelLeaderboards.public.length, RANKING_PAGE_SIZE.public);
    assert.equal(first.modelLeaderboards.personal.length, 0);
    assert.deepEqual(first.modelLeaderboards.public.map(row => row.rank), Array.from({ length: 25 }, (_, i) => i + 1));
    assert.deepEqual(first.rankingPagination.modelScales.public, { min: 0, max: 110 });
    const second = pager.getPage({ snapshotID: first.rankingPagination.snapshotID,
        userID: 7, list: 'public', offset: 25 });
    assert.equal(second.items[0].rank, 26);
    assert.equal(second.items.at(-1).rank, 38);
    assert.equal(second.hasMore, false);
});

test('ranking and paging defer evidence until each selected page is serialized', () => {
    let copied = 0;
    const data = workspace();
    for (const model of data.modelLeaderboards.public) deferRankingMetadata(model, 'calculationScores',
        () => { copied++; return [{ conditionID: model.ID }]; });
    const pager = createRankingPager();
    const first = pager.create(data, { userID: 7 });
    assert.equal(copied, 0);
    JSON.stringify(first);
    assert.equal(copied, 25);
    JSON.stringify(first);
    assert.equal(copied, 25);
    assert.equal(Object.hasOwn(Object.getOwnPropertyDescriptor(data.modelLeaderboards.public[0], 'calculationScores'), 'get'), true);
    const next = pager.getPage({ snapshotID: first.rankingPagination.snapshotID, userID: 7, list: 'public', offset: 25 });
    assert.equal(copied, 25);
    JSON.stringify(next);
    assert.equal(copied, 38);
});

test('search and personal pinning run against the full snapshot, not loaded rows', () => {
    const pager = createRankingPager();
    const first = pager.create(workspace(), { userID: 7 });
    const id = first.rankingPagination.snapshotID;
    const search = pager.getPage({ snapshotID: id, userID: 7,
        list: 'benchmarks', group: 'primary', offset: 0, query: 'needle' });
    assert.deepEqual(search.items.map(row => row.ID), [54]);
    assert.equal(search.total, 1);
    const pinned = pager.getPage({ snapshotID: id, userID: 7,
        list: 'benchmarks', group: 'primary', offset: 0, pinPersonal: true });
    assert.deepEqual(pinned.items.slice(0, 3).map(row => row.ID), [54, 53, 1]);
    assert.equal(pinned.items[0].rank, 54);
    const next = pager.getPage({ snapshotID: id, userID: 7,
        list: 'benchmarks', group: 'primary', offset: 40, pinPersonal: true });
    assert.equal(new Set([...pinned.items, ...next.items].map(row => row.ID)).size, 55);
});

test('search ignores obsolete tag metadata and accepts benchmarks without tags', () => {
    const data = workspace();
    data.benchmarks[0].tags = ['unfindablelabelqzx'];
    const pager = createRankingPager();
    const first = pager.create(data);
    const result = pager.getPage({ snapshotID: first.rankingPagination.snapshotID,
        list: 'benchmarks', group: 'primary', query: 'unfindablelabelqzx' });
    assert.equal(result.total, 0);
    const byName = pager.getPage({ snapshotID: first.rankingPagination.snapshotID,
        list: 'benchmarks', group: 'primary', query: 'needle' });
    assert.equal(byName.items[0].name, 'Needle benchmark');
});

test('secondary groups load independently and primary conditions stay visible even with low coverage', () => {
    const data = workspace();
    const sparse = data.benchmarks.splice(52, 1)[0];
    sparse.lowCoverage = true;
    sparse.isPrimaryCondition = false;
    data.benchmarks.push(sparse);
    const other = data.benchmarks.splice(10, 1)[0];
    other.isPrimaryCondition = false;
    data.benchmarks.push(other);
    data.benchmarks[0].lowCoverage = true;
    const pager = createRankingPager();
    const first = pager.create(data, { userID: 7, pinPersonal: true, groupVersions: true });
    assert.equal(first.rankingPagination.benchmarks.lowCoverage.total, 1);
    assert.equal(first.rankingPagination.benchmarks.other.total, 1);
    assert.equal(first.rankingPagination.benchmarks.other.nextOffset, 0);
    assert.ok(first.benchmarks.some(row => row.ID === 1));
    assert.equal(first.benchmarks[0].conditionID, 54);
    const last = pager.getPage({ snapshotID: first.rankingPagination.snapshotID,
        userID: 7, list: 'benchmarks', group: 'lowCoverage', offset: 0, pinPersonal: true, groupVersions: true });
    assert.deepEqual(last.groupTotals, { primary: 53, other: 1, lowCoverage: 1 });
    assert.equal(last.items.at(-1).conditionID, sparse.conditionID);
    const search = pager.getPage({ snapshotID: first.rankingPagination.snapshotID,
        userID: 7, list: 'benchmarks', group: 'lowCoverage', query: sparse.name });
    assert.equal(search.total, 0);
    assert.equal(search.groupTotals.lowCoverage, 0);
    const promoted = pager.getPage({ snapshotID: first.rankingPagination.snapshotID,
        userID: 7, list: 'benchmarks', group: 'primary', query: sparse.name });
    assert.deepEqual(promoted.items.map(row => row.conditionID), [sparse.conditionID]);
    assert.equal(promoted.items[0].searchPromoted, true);
    const secondary = pager.getPage({ snapshotID: first.rankingPagination.snapshotID,
        userID: 7, list: 'benchmarks', group: 'other', groupVersions: true });
    assert.deepEqual(secondary.items.map(row => row.ID), [other.ID]);
    assert.throws(() => pager.getPage({ snapshotID: first.rankingPagination.snapshotID,
        userID: 7, list: 'benchmarks', group: 'unknown' }), error => error.status === 400);
});

test('ranking snapshots reject missing coverage markers instead of silently sorting them', () => {
    const data = workspace();
    delete data.benchmarks[0].lowCoverage;
    assert.throws(() => createRankingPager().create(data),
        error => error.status === 500 && error.body.error === 'benchmark_condition_flags_missing');
});

test('equal model scores keep the same rank across a page boundary', () => {
    const data = workspace();
    data.modelLeaderboards.public[25].lower = data.modelLeaderboards.public[24].lower;
    data.modelLeaderboards.public[25].upper = data.modelLeaderboards.public[24].upper;
    const pager = createRankingPager();
    const first = pager.create(data);
    const second = pager.getPage({ snapshotID: first.rankingPagination.snapshotID,
        list: 'public', offset: 25 });
    assert.equal(first.modelLeaderboards.public.at(-1).rank, 25);
    assert.equal(second.items[0].rank, 25);
    assert.equal(second.items[1].rank, 27);
});

test('snapshot is isolated by user and expires explicitly', () => {
    let time = 1000;
    const pager = createRankingPager({ now: () => time });
    const first = pager.create(workspace(), { userID: 7 });
    const args = { snapshotID: first.rankingPagination.snapshotID, list: 'benchmarks', group: 'primary', offset: 40 };
    assert.throws(() => pager.getPage({ ...args, userID: 8 }), error => error.status === 403);
    time += 15 * 60 * 1000;
    assert.throws(() => pager.getPage({ ...args, userID: 7 }), error => error.status === 410);
});

test('paging an active snapshot protects it from capacity eviction by another user', () => {
    const pager = createRankingPager();
    const snapshots = Array.from({ length: 12 }, (_, index) => ({
        userID: index + 1,
        snapshotID: pager.create(workspace(), { userID: index + 1 }).rankingPagination.snapshotID
    }));
    const active = { ...snapshots[0], list: 'public', offset: 25 };
    assert.equal(pager.getPage(active).items[0].rank, 26);
    pager.create(workspace(), { userID: 13 });
    assert.equal(pager.getPage(active).items.at(-1).rank, 38);
    assert.throws(() => pager.getPage({ ...snapshots[1], list: 'public', offset: 25 }),
        error => error.status === 410 && error.body.error === 'ranking_snapshot_expired');
});

test('unauthorized snapshot reads do not renew its expiry or eviction priority', () => {
    const pager = createRankingPager();
    const snapshots = Array.from({ length: 12 }, (_, index) => ({
        userID: index + 1,
        snapshotID: pager.create(workspace(), { userID: index + 1 }).rankingPagination.snapshotID
    }));
    assert.throws(() => pager.getPage({ ...snapshots[0], userID: 99, list: 'public' }),
        error => error.status === 403);
    pager.create(workspace(), { userID: 13 });
    assert.throws(() => pager.getPage({ ...snapshots[0], list: 'public' }), error => error.status === 410);
    assert.equal(pager.getPage({ ...snapshots[1], list: 'public' }).items[0].rank, 1);
});

test('model ordering is deterministic for tied scores and coverage', () => {
    const rows = rankModels([
        { ID: 8, name: 'Same', comparable: true, lower: 50, coverage: 70 },
        { ID: 2, name: 'Same', comparable: true, lower: 50, coverage: 70 },
        { ID: 3, name: 'Incomparable', comparable: false, lower: null, coverage: 0 }
    ]);
    assert.deepEqual(rows.map(row => row.ID), [2, 8, 3]);
    assert.deepEqual(rows.map(row => row.rank), [1, 1, null]);
});

test('zero-weight default pages preserve site-wide order across page boundaries without overriding search', () => {
    const data = workspace();
    data.benchmarks.forEach(row => { row.publicWeightBasisPoints = 0; row.globalWeightBasisPoints = row.ID * 100; });
    data.benchmarks[0].publicWeightBasisPoints = 10000;
    const pager = createRankingPager(), first = pager.create(data), snapshotID = first.rankingPagination.snapshotID;
    const second = pager.getPage({ snapshotID, list: 'benchmarks', group: 'primary', offset: 40 });
    assert.deepEqual([...first.benchmarks, ...second.items].map(row => row.ID),
        [1, ...Array.from({ length: 54 }, (_, index) => 55 - index)]);
    const search = pager.getPage({ snapshotID, list: 'benchmarks', group: 'primary', query: 'needle' });
    assert.deepEqual(search.items.map(row => row.ID), [54]);
});

test('grouped zero-weight benchmarks use the sum of all version allocations', () => {
    const data = workspace(); data.versionComposition = [];
    data.benchmarks = data.benchmarks.slice(0, 3).map((row, index) => ({ ...row,
        benchmarkID: index < 2 ? 10 : 20, isPrimaryCondition: index !== 1,
        publicWeightBasisPoints: 0, globalWeightBasisPoints: index === 2 ? 1100 : 600,
        personalWeightBasisPoints: null }));
    const first = createRankingPager().create(data);
    assert.deepEqual(first.benchmarks.map(row => row.benchmarkID), [10, 20]);
    assert.deepEqual(first.benchmarks.map(row => row.globalWeightBasisPoints), [1200, 1100]);
});

test('positive grouped weights keep their previous condition-ID tie order', () => {
    const data = workspace(); data.versionComposition = [];
    data.benchmarks = data.benchmarks.slice(0, 2).map((row, index) => ({ ...row, benchmarkID: index + 1,
        publicWeightBasisPoints: 5000, globalWeightBasisPoints: index * 100000, scoreCount: index + 1,
        personalWeightBasisPoints: null }));
    assert.deepEqual(createRankingPager().create(data).benchmarks.map(row => row.conditionID), [1, 2]);
});

test('snapshot authorization includes every referenced topic and lifecycle invalidation expires cached reads', () => {
    const data = workspace(); data.context = { categoryID: 3 };
    data.benchmarks.push({ conditionID: -99, type: 'topic', referenceContextID: 99, categoryID: 8,
        publicWeightBasisPoints: 0, scoreCount: 0, isPrimaryCondition: true, lowCoverage: false });
    const pager = createRankingPager(), first = pager.create(data, { userID: 7 }), snapshotID = first.rankingPagination.snapshotID;
    const IDs = pager.getSnapshotTopicIDs({ snapshotID, userID: 7 });
    assert.deepEqual(IDs, [3, 8]); IDs.push(20);
    assert.deepEqual(pager.getSnapshotTopicIDs({ snapshotID, userID: 7 }), [3, 8]);
    assert.throws(() => pager.getSnapshotTopicIDs({ snapshotID, userID: 8 }), error => error.status === 403);
    pager.invalidate();
    assert.throws(() => pager.getPage({ snapshotID, userID: 7, list: 'public' }), error => error.status === 410);
    assert.throws(() => pager.getSnapshotTopicIDs({ snapshotID, userID: 7 }), error => error.status === 410);
});
