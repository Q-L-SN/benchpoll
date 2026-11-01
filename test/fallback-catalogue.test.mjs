import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRankingPager } from '../ranking-pagination.js';
import { createFixtureState, workspace, familyEntries } from '../scripts/frontend/fixtures.mjs';
import { validateRankingPagePayload, validateWorkspacePayload } from '../public/js/workspace/contracts.js';

const rule = (IDs, ID) => ({ primaryConditionID: 1, familyID: ID, mode: 'ordered',
    entries: familyEntries(IDs.map(conditionID => ({ conditionID }))) });
function fixture() {
    const pairs = Array.from({ length: 7 }, (_, i) => i + 2).flatMap(a =>
        Array.from({ length: 7 }, (_, i) => i + 2).filter(b => b !== a).map(b => [a, b]));
    return workspace(createFixtureState({ rankingStress: true, families: pairs.map((pair, index) => rule(pair, index + 10)) }), {});
}

test('configuration rows never consume the ordinary first page or secondary group counts', () => {
    const data = fixture();
    // fixture() is already paginated. Build a fresh catalogue from known configurations.
    const families = Array.from({ length: 40 }, (_, index) => ({ ...data.benchmarks[0],
        isFamily: true, familyID: index + 10, familyKey: `[1,${index + 100}]`,
        publicWeightBasisPoints: 0, publicWeight: 0,
        familyEntries: [{ ...data.benchmarks[1], conditionID: index + 100 }] }));
    const ordinary = Array.from({ length: 70 }, (_, index) => ({ ...data.benchmarks[0],
        ID: index + 1, conditionID: index + 1, rank: index + 1, name: `Benchmark ${index + 1}` }));
    const pager = createRankingPager();
    const first = pager.create({ ...data, benchmarks: [...families, ...ordinary] });
    assert.equal(first.benchmarks.length, 40);
    assert.ok(first.benchmarks.every(row => !row.isFamily));
    assert.deepEqual(first.benchmarks.map(row => row.ID), ordinary.slice(0, 40).map(row => row.ID));
    assert.equal(first.rankingPagination.benchmarks.primary.total, 70);
    assert.equal(first.benchmarks[0].fallbackConfigCount, 40);
    const request = { snapshotID: first.rankingPagination.snapshotID, list: 'fallbacks', conditionID: 1 };
    const loaded = [];
    let offset = 0;
    do {
        const page = pager.getPage({ ...request, offset });
        assert.equal(page.items.length, 5);
        assert.equal(page.featuredFallbackConfigurations.length, 0);
        loaded.push(...page.items);
        offset = page.nextOffset;
        if (!page.hasMore) break;
    } while (true);
    assert.equal(new Set(loaded.map(row => row.familyKey)).size, 40);
});

test('configuration pages are entrance scoped, popular first and deterministically ordered on ties', () => {
    const data = workspace(createFixtureState(), {});
    const main = data.benchmarks[0];
    const family = (IDs, ID, weight) => ({ ...main, isFamily: true, familyID: ID,
        familyKey: JSON.stringify([1, ...IDs]), familyEntries: familyEntries(IDs.map(conditionID => ({ conditionID }))),
        publicWeightBasisPoints: weight, publicWeight: weight / 100 });
    const pager = createRankingPager();
    const first = pager.create({ ...data, benchmarks: [...data.benchmarks, family([3], 12, 80), family([2], 11, 10), family([4], 13, 80)] });
    const request = { snapshotID: first.rankingPagination.snapshotID, list: 'fallbacks', conditionID: 1 };
    const response = pager.getPage(request);
    assert.deepEqual(response.items.map(row => row.familyID), [12, 13, 11]);
    assert.equal(validateRankingPagePayload(response, { ...request, offset: 0 }), response);
    assert.equal(pager.getPage({ ...request, conditionID: 2 }).total, 0);
    assert.throws(() => pager.getPage({ ...request, conditionID: 999999 }), error => error.status === 404);
    for (const value of [undefined, '1', -1, 0, 1.1]) assert.throws(() => pager.getPage({ ...request, conditionID: value }), error => error.status === 400);
    for (const extra of [{ group: 'primary' }, { query: 'model' }, { pinPersonal: true }]) {
        assert.throws(() => pager.getPage({ ...request, ...extra }), error => error.status === 400);
    }
    assert.throws(() => pager.getPage({ snapshotID: request.snapshotID, list: 'public', conditionID: 1 }), error => error.status === 400);
    assert.throws(() => validateRankingPagePayload({ ...response, conditionID: 2 }, { ...request, offset: 0 }));
    assert.throws(() => validateRankingPagePayload({ ...response, items: [response.items[0], response.items[0], response.items[1]] }, { ...request, offset: 0 }));
});

test('workspace contract rejects old flat configuration lists and missing disclosure counts', () => {
    const data = workspace(createFixtureState(), {});
    assert.equal(validateWorkspacePayload(data), data);
    const missing = structuredClone(data); delete missing.benchmarks[0].fallbackConfigCount;
    assert.throws(() => validateWorkspacePayload(missing), /fallbackConfigCount/);
    const flat = structuredClone(data);
    Object.assign(flat.benchmarks[0], { isFamily: true, familyID: 10, familyKey: '[1,2]', familyEntries: familyEntries([{ conditionID: 2 }]) });
    assert.throws(() => validateWorkspacePayload(flat), /only unfolded conditions/);
});

test('row activation cannot add to a pie or fallback; only the explicit add control performs mutation', async () => {
    const source = await readFile(new URL('../public/js/home-workspace.js', import.meta.url), 'utf8');
    const activation = source.slice(source.indexOf('const activate = event => {'), source.indexOf("row.addEventListener('click', activate)"));
    assert.doesNotMatch(activation, /addObjectToPersonalPie|addObjectToFallbackChain/);
    const explicitAdd = source.slice(source.indexOf("add.className = 'bp-benchmark-add'"), source.indexOf('actionCell.append(add)'));
    assert.match(explicitAdd, /addObjectToFallbackChain\(object\)/);
    assert.match(explicitAdd, /addObjectToPersonalPie\(object\)/);
    assert.match(explicitAdd, /event\.stopPropagation\(\)/);
    assert.doesNotMatch(source, /fallbackPicker\.open\(object/);
    assert.doesNotMatch(source, /benchmarkFallbackCatalogue\.create|Direct add \(not recommended\)/);
});
