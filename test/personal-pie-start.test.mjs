import test from 'node:test';
import assert from 'node:assert/strict';
import { publicWeightStart } from '../public/js/workspace/personal-pie-start.js';

const limits = { totalBasisPoints: 10000, maxPieItems: 100 };
const version = (conditionID, benchmarkID = conditionID) => ({ conditionID, benchmarkID, name: `Benchmark ${benchmarkID}` });

test('starting from public weights merges versions and follows community without creating version votes', () => {
    const composition = [{ benchmarkID: 1, primaryConditionID: 2, versions: [version(1, 1), version(2, 1)] },
        { benchmarkID: 3, primaryConditionID: 3, versions: [version(3)] }];
    const result = publicWeightStart([{ ...version(1, 1), weightBasisPoints: 2500 },
        { ...version(2, 1), weightBasisPoints: 3500 }, { ...version(3), weightBasisPoints: 4000 }], composition, limits);
    assert.deepEqual(result.entries.map(({ conditionID, weightBasisPoints, followCommunityVersion }) =>
        ({ conditionID, weightBasisPoints, followCommunityVersion })), [
        { conditionID: 2, weightBasisPoints: 6000, followCommunityVersion: true },
        { conditionID: 3, weightBasisPoints: 4000, followCommunityVersion: true }
    ]);
    assert.equal(result.note, '');
});

test('topic references keep their identity and never acquire a version choice', () => {
    const reference = { conditionID: -51, type: 'topic', referenceContextID: 51, name: 'Research / General', weightBasisPoints: 7000 };
    const result = publicWeightStart([reference, { ...version(1), weightBasisPoints: 3000 }], null, limits);
    assert.deepEqual(result.entries[0], { ...reference, weight: 70 });
    assert.equal(result.entries.some(entry => entry.followCommunityVersion), false);
});

test('public fractions and small weights become legal personal weights totaling exactly 100%', () => {
    const result = publicWeightStart([19.5, 180.7, 3300.3, 6499.5].map((weightBasisPoints, i) => ({ ...version(i + 1), weightBasisPoints })), null, limits);
    assert.equal(result.entries.length, 4);
    assert.equal(result.entries.reduce((sum, entry) => sum + entry.weightBasisPoints, 0), 10000);
    assert.ok(result.entries.every(entry => Number.isSafeInteger(entry.weightBasisPoints) && entry.weightBasisPoints >= 100));
    assert.match(result.note, /1% minimum/);
});

test('overlarge public compositions explain the cap and retain the largest weights', () => {
    const result = publicWeightStart([4000, 3000, 2000, 1000].map((weightBasisPoints, i) => ({ ...version(i + 1), weightBasisPoints })), null,
        { ...limits, maxPieItems: 2 });
    assert.deepEqual(result.entries.map(entry => entry.conditionID), [1, 2]);
    assert.equal(result.entries.reduce((sum, entry) => sum + entry.weightBasisPoints, 0), 10000);
    assert.match(result.note, /2 largest weights/);
});

test('restricted or zero-weight evidence cannot enter a copied personal composition', () => {
    const result = publicWeightStart([{ ...version(1), excludedFromRanking: true, weightBasisPoints: 3000 },
        { ...version(2), weightBasisPoints: 0 }, { ...version(3), weightBasisPoints: 7000 }], null, limits);
    assert.deepEqual(result.entries.map(entry => [entry.conditionID, entry.weightBasisPoints]), [[3, 10000]]);
    assert.deepEqual(publicWeightStart([], null, limits), { entries: [], note: '' });
});
