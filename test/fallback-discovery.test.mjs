import test from 'node:test';
import assert from 'node:assert/strict';
import { createRankingPager } from '../ranking-pagination.js';
import { createSearchIndex, dominantSearchMatch } from '../public/js/shared/search.js';
import { createFixtureState, workspace, familyEntries } from '../scripts/frontend/fixtures.mjs';
import { validateWorkspacePayload, validateRankingPagePayload } from '../public/js/workspace/contracts.js';

function data() { return workspace(createFixtureState(), {}, { paginate: false }); }
function configuration(base, conditionID, weight) {
    return { ...base, isFamily: true, familyID: conditionID, familyKey: JSON.stringify([base.conditionID, conditionID]),
        familyEntries: [{ ...base, ID: conditionID, conditionID, conditionKey: 'variant', conditionName: 'Variant',
            isDefaultCondition: false, name: `Alternative ${conditionID}` }],
        publicWeightBasisPoints: weight, publicWeight: weight / 100 };
}

test('featured configurations use whole-public-pie weight, are capped at eight, and never consume five-item pages', () => {
    const original = data();
    const entrance = original.benchmarks[0];
    const configurations = [99, 0, 100, 120, 140, 160, 180, 200, 220, 240, 260, 280]
        .map((weight, i) => configuration(entrance, 100 + i, weight));
    const pager = createRankingPager();
    const first = pager.create({ ...original, benchmarks: [...original.benchmarks, ...configurations] });
    const featured = first.benchmarks[0].featuredFallbackConfigurations;
    assert.equal(featured.length, 8);
    assert.deepEqual(featured.map(row => row.publicWeightBasisPoints), [280, 260, 240, 220, 200, 180, 160, 140]);
    assert.equal(first.benchmarks[0].fallbackConfigCount, 12);
    assert.equal(validateWorkspacePayload(first), first);
    const request = { snapshotID: first.rankingPagination.snapshotID, list: 'fallbacks', conditionID: 1, offset: 0 };
    const page = pager.getPage(request);
    assert.deepEqual(page.items.map(row => row.publicWeightBasisPoints), [120, 100, 99, 0]);
    assert.equal(page.total, 4);
    assert.deepEqual(page.featuredFallbackConfigurations, featured);
    assert.equal(validateRankingPagePayload(page, request), page);
    assert.equal(new Set([...featured, ...page.items].map(row => row.familyKey)).size, 12);
});

test('exactly 1% is featured and 0.99% is not, independent of the entrance share', () => {
    const original = data();
    const configurations = [configuration(original.benchmarks[0], 201, 100), configuration(original.benchmarks[0], 202, 99)];
    const first = createRankingPager().create({ ...original, benchmarks: [...original.benchmarks, ...configurations] });
    assert.deepEqual(first.benchmarks[0].featuredFallbackConfigurations.map(row => row.familyID), [201]);
});

test('featured metadata is revalidated when a configuration loses its last reference', () => {
    const original = data();
    const pager = createRankingPager();
    const first = pager.create({ ...original, benchmarks: [...original.benchmarks,
        configuration(original.benchmarks[0], 201, 400), configuration(original.benchmarks[0], 202, 200)] });
    pager.retainReferencedFamilies([202]);
    const request = { snapshotID: first.rankingPagination.snapshotID, list: 'fallbacks', conditionID: 1, offset: 0 };
    const page = pager.getPage(request);
    assert.equal(page.fallbackConfigCount, 1);
    assert.deepEqual(page.featuredFallbackConfigurations.map(row => row.familyID), [202]);
    assert.deepEqual(page.items, []);
});

test('contracts reject missing search flags, duplicate featured rows, wrong thresholds and oversized fallback pages', () => {
    const original = data();
    const pager = createRankingPager();
    const first = pager.create({ ...original, benchmarks: [...original.benchmarks,
        configuration(original.benchmarks[0], 201, 100), ...[202, 203, 204, 205, 206, 207].map(ID => configuration(original.benchmarks[0], ID, 0))] });
    for (const mutate of [row => { delete row.searchPromoted; }, row => { delete row.featuredFallbackConfigurations; },
        row => row.featuredFallbackConfigurations.push(row.featuredFallbackConfigurations[0]),
        row => { row.featuredFallbackConfigurations[0].publicWeightBasisPoints = 99; }]) {
        const broken = structuredClone(first); mutate(broken.benchmarks[0]);
        assert.throws(() => validateWorkspacePayload(broken), /Invalid workspace response/);
    }
    const request = { snapshotID: first.rankingPagination.snapshotID, list: 'fallbacks', conditionID: 1, offset: 0 };
    const page = pager.getPage(request);
    const extra = pager.getPage({ ...request, offset: page.nextOffset }).items[0];
    assert.throws(() => validateRankingPagePayload({ ...page, items: [...page.items, extra], nextOffset: 6, hasMore: false }, request));
    assert.throws(() => validateRankingPagePayload({ ...page, items: [page.featuredFallbackConfigurations[0], ...page.items.slice(1)] }, request));
});

test('only a clear identity winner overrides the ordinary condition folding rules, and clearing search resets it', () => {
    const original = data();
    const versions = ['default', 'Quantum proof metric', 'Quantum reasoning subset', 'Mathematics subset']
        .map((name, i) => ({ ...original.benchmarks[0], ID: i + 301, conditionID: i + 301, conditionKey: i ? `version-${i}` : 'default',
            conditionName: name, isDefaultCondition: !i, isPrimaryCondition: !i, lowCoverage: i === 1,
            publicWeight: 0, publicWeightBasisPoints: 0, personalWeight: null }));
    const pager = createRankingPager();
    const first = pager.create({ ...original, personalPie: { ...original.personalPie, entries: [], fallbackRules: [] }, benchmarks: versions }, { groupVersions: true });
    const request = { snapshotID: first.rankingPagination.snapshotID, list: 'benchmarks', group: 'primary', groupVersions: true };
    assert.deepEqual(pager.getPage({ ...request, query: 'Quantum proof metric' }).items.map(row => row.conditionID), [302]);
    assert.equal(pager.getPage({ ...request, query: 'Quantum proof metric' }).items[0].searchPromoted, true);
    assert.equal(pager.getPage({ ...request, query: 'Quantum' }).items.length, 0, 'Close candidates stay folded');
    assert.deepEqual(pager.getPage(request).items.map(row => row.conditionID), [301]);
    assert.equal(pager.getPage(request).items[0].searchPromoted, false);
    assert.equal(pager.getPage({ ...request, group: 'lowCoverage' }).total, 1);
});

test('tag or fallback-member hits are not promoted as entrance identity hits', () => {
    const original = data();
    const index = createSearchIndex([{ name: 'Alpha', version: '', tag: 'Needle' }], row => [row.name, row.version, row.tag], { identityFieldCount: 2 });
    assert.equal(dominantSearchMatch(index.rank('Needle')), null, 'An empty identity field does not pull a tag into the identity');
    const entrance = { ...original.benchmarks[0], isPrimaryCondition: false, publicWeightBasisPoints: 0, publicWeight: 0, personalWeight: null };
    const family = { ...entrance, isFamily: true, familyID: 50, familyKey: '[1,2]', familyEntries: familyEntries([{ conditionID: 2 }]) };
    const first = createRankingPager().create({ ...original, personalPie: { ...original.personalPie, entries: [] },
        benchmarks: [entrance, family] }, { query: 'Advanced reasoning' });
    assert.equal(first.benchmarks.length, 0);
    assert.equal(first.rankingPagination.benchmarks.other.total, 1);
});

test('personal pinning cannot push a dominant search winner out of the first page', () => {
    const original = data();
    const versions = Array.from({ length: 51 }, (_, i) => ({ ...original.benchmarks[0], ID: i + 301, conditionID: i + 301,
        conditionName: i === 50 ? 'Precision metric alpha' : `Precision metric alpha supplementary laboratory variant ${i}`,
        conditionKey: `version-${i}`, isDefaultCondition: false, isPrimaryCondition: false, lowCoverage: false,
        publicWeightBasisPoints: 0, publicWeight: 0, personalWeight: i === 50 ? null : 2 }));
    const pager = createRankingPager();
    const first = pager.create({ ...original, benchmarks: versions, personalPie: { ...original.personalPie,
        entries: versions.slice(0, 50).map(row => ({ ...row, weightBasisPoints: 200 })) } },
    { query: 'Precision metric alpha', pinPersonal: true });
    assert.equal(first.benchmarks.length, 40);
    assert.equal(first.benchmarks[0].conditionID, 351);
    assert.equal(first.benchmarks[0].searchPromoted, true);
});

test('fuzzy matching can promote a unique near-exact spelling but never a vague short prefix or tied exact versions', () => {
    const values = ['Omniscience', 'Math reasoning', 'Coding'];
    const index = createSearchIndex(values, value => value);
    assert.equal(dominantSearchMatch(index.rank('Omniscince')), 'Omniscience');
    assert.equal(dominantSearchMatch(index.rank('Math')), null);
    assert.equal(dominantSearchMatch(createSearchIndex(['Alpha default', 'Alpha extended'], value => [value, 'Alpha'],
        { identityFieldCount: 2 }).rank('Alpha')), null);
    assert.equal(dominantSearchMatch(index.rank('nothing')), null);
});
