import assert from 'node:assert/strict';
import test from 'node:test';
import { createRankingPager, RANKING_PAGE_SIZE } from '../ranking-pagination.js';
import { deferRankingMetadata } from '../ranking-read-cache.js';
import { validateModelLocatePayload } from '../public/js/workspace/model-focus.js';

const identity = ID => JSON.stringify([['field:20', true, 'high'], ['model', true, ID]]);
function workspace(count = 120) {
    const models = Array.from({ length: count }, (_, index) => ({
        ID: 10001 + index, modelID: index + 1, comparisonIdentity: identity(index + 1), name: `Model ${index + 1}`,
        comparable: true, lower: count - index, upper: count - index, coverage: 100, missingWeight: 0,
        availableInference: null, inferredScores: [], calculationScores: [{ conditionID: 1,
            normalizedScore: count - index, effectiveWeight: 100, contribution: count - index,
            fallbackFor: null, memberIDs: [10001 + index], memberWeights: [{ ID: 10001 + index, weight: 1 }],
            memberEvidence: [{ ID: 10001 + index, hash: 'a'.repeat(64) }] }]
    }));
    return { scoreMode: 'range', benchmarks: [], personalPie: { entries: [] },
        modelLeaderboards: { public: models, personal: models } };
}

test('locating a deep exact comparison returns one bounded page without changing continuous progress', () => {
    const pager = createRankingPager();
    const first = pager.create(workspace(), { userID: '7' });
    const before = structuredClone(first.rankingPagination);
    const args = { snapshotID: first.rankingPagination.snapshotID, userID: '7', list: 'public', targetModel: identity(112) };
    const result = pager.locateModel(args);
    assert.equal(result.found, true);
    assert.equal(result.targetOffset, 111);
    assert.equal(result.offset, 100);
    assert.equal(result.page.items.length, 20);
    assert.equal(result.page.items[11].comparisonIdentity, args.targetModel);
    validateModelLocatePayload(result, { ...args, scoreMode: 'range', total: 120 });
    assert.deepEqual(first.rankingPagination, before);
    assert.equal(first.modelLeaderboards.public.length, RANKING_PAGE_SIZE.public);
    const next = pager.getPage({ ...args, offset: 25 });
    assert.equal(next.items[0].rank, 26);
    assert.equal(next.nextOffset, 50);
    assert.equal(result.page.items[0].rank, 101);
});

test('locate materializes evidence for only the target page, not an intervening prefix', () => {
    let copied = 0;
    const data = workspace(10000);
    for (const model of data.modelLeaderboards.public) {
        const scores = model.calculationScores;
        deferRankingMetadata(model, 'calculationScores', () => { copied++; return scores; });
    }
    const pager = createRankingPager();
    const first = pager.create(data);
    assert.equal(copied, 0);
    const result = pager.locateModel({ snapshotID: first.rankingPagination.snapshotID, targetModel: identity(9002) });
    assert.equal(copied, 0);
    assert.equal(result.offset, 9000);
    assert.equal(result.page.items.length, 25);
    JSON.stringify(result);
    assert.equal(copied, 25);
    assert.equal(first.rankingPagination.public.nextOffset, 25);
});

test('numeric fallback uses the base model ID and rejects ambiguous variants', () => {
    const pager = createRankingPager(), data = workspace();
    data.modelLeaderboards.public[105] = { ...data.modelLeaderboards.public[105], modelID: 1,
        comparisonIdentity: JSON.stringify([['field:20', true, 'low'], ['model', true, 1]]) };
    const first = pager.create(data);
    const snapshotID = first.rankingPagination.snapshotID;
    const ambiguous = pager.locateModel({ snapshotID, targetModel: '1' });
    assert.deepEqual(ambiguous, { snapshotID, list: 'public', targetModel: '1', found: false,
        targetOffset: null, offset: null, page: null });
    const exact = pager.locateModel({ snapshotID, targetModel: identity(1) });
    assert.equal(exact.targetOffset, 0);
    assert.equal(pager.locateModel({ snapshotID, targetModel: 112 }).targetOffset, 111);
    assert.equal(pager.locateModel({ snapshotID, targetModel: 10112 }).found, false);
});

test('stale comparison identity never falls back to the same base model or display name', () => {
    const pager = createRankingPager();
    const first = pager.create(workspace());
    const snapshotID = first.rankingPagination.snapshotID;
    for (const targetModel of [JSON.stringify([['model', true, 1]]), 'Model 1', identity(9999)]) {
        const result = pager.locateModel({ snapshotID, targetModel });
        assert.equal(result.found, false);
        assert.equal(result.page, null);
    }
});

test('the locator validates input and enforces the same snapshot ownership and expiry as paging', () => {
    let time = 0;
    const pager = createRankingPager({ now: () => time });
    const first = pager.create(workspace(), { userID: '7' });
    const args = { snapshotID: first.rankingPagination.snapshotID, userID: '7', targetModel: identity(90) };
    for (const targetModel of [null, {}, [], 0, -1, '', '0', '01', '1.2', '1e3', '9'.repeat(40), 'a'.repeat(4097)]) {
        assert.throws(() => pager.locateModel({ ...args, targetModel }), error => error.status === 400);
    }
    for (const list of ['benchmarks', '__proto__', ['public'], null]) {
        assert.throws(() => pager.locateModel({ ...args, list }), error => error.status === 400);
    }
    assert.throws(() => pager.locateModel({ ...args, snapshotID: 'bad' }), error => error.status === 400);
    assert.throws(() => pager.locateModel({ ...args, userID: '8' }), error => error.status === 403);
    assert.throws(() => pager.locateModel({ ...args, userID: null }), error => error.status === 403);
    time = 15 * 60 * 1000 - 1;
    assert.throws(() => pager.locateModel({ ...args, userID: '8' }), error => error.status === 403);
    time++;
    assert.throws(() => pager.locateModel(args), error => error.status === 410);
});

test('authorized locate renews an active snapshot and does not read the other leaderboard', () => {
    let time = 0;
    const pager = createRankingPager({ now: () => time }), data = workspace();
    data.modelLeaderboards.personal = [];
    const first = pager.create(data, { userID: '7' });
    const args = { snapshotID: first.rankingPagination.snapshotID, userID: '7', targetModel: identity(90) };
    time = 14 * 60 * 1000;
    assert.equal(pager.locateModel(args).found, true);
    time += 14 * 60 * 1000;
    assert.equal(pager.locateModel({ ...args, list: 'personal' }).found, false);
    assert.equal(pager.locateModel(args).page.items.length, 25);
});

test('personal target pages remain owner-bound and independent of the public page', () => {
    const pager = createRankingPager(), data = workspace();
    data.modelLeaderboards.public = [];
    const first = pager.create(data, { userID: '7', initialMode: 'personal' });
    const args = { snapshotID: first.rankingPagination.snapshotID, userID: '7', list: 'personal', targetModel: identity(90) };
    const result = pager.locateModel(args);
    assert.equal(result.targetOffset, 89);
    assert.equal(result.offset, 75);
    assert.equal(result.page.items[14].comparisonIdentity, identity(90));
    assert.equal(first.rankingPagination.personal.nextOffset, 25);
    assert.equal(first.rankingPagination.public.nextOffset, 0);
    assert.throws(() => pager.locateModel({ ...args, userID: '8' }), error => error.status === 403);
    assert.throws(() => pager.locateModel({ ...args, userID: null }), error => error.status === 403);
});
