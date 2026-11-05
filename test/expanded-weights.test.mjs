import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeBenchmarkWeights, compositionPercentages, UNRESOLVED_WEIGHT_ID } from '../public/js/workspace/expanded-weights.js';
import { expandTopicReferences } from '../topic-reference-service.js';

test('expanded display merges versions and direct/reference contributions without changing input weights', () => {
    const entries = [{ conditionID: 10, benchmarkID: 1, name: 'Reasoning', weightBasisPoints: 2500 },
        { conditionID: 11, benchmarkID: 1, name: 'Reasoning', weightBasisPoints: 3500 },
        { conditionID: 20, benchmarkID: 2, name: 'Coding', weightBasisPoints: 4000 }];
    const snapshot = structuredClone(entries);
    const result = mergeBenchmarkWeights(entries, [{ benchmarkID: 1, name: 'Reasoning', primaryConditionID: 11,
        versions: [{ conditionID: 10, scoreCount: 6 }, { conditionID: 11, scoreCount: 8 }] }]);
    assert.deepEqual(result.map(item => [item.conditionID, item.weightBasisPoints]), [[11, 6000], [20, 4000]]);
    assert.equal(result[0].scoreCount, 14);
    assert.deepEqual(entries, snapshot);
});

test('displayed composition percentages sum to exactly 100 even for recurring fractions', () => {
    const shares = compositionPercentages([1, 1, 1].map(weightBasisPoints => ({ weightBasisPoints })));
    assert.deepEqual(shares, ['33.34%', '33.33%', '33.33%']);
    assert.equal(shares.reduce((sum, value) => sum + Math.round(parseFloat(value) * 100), 0), 10000);
});

test('unavailable reference weights remain a separate unresolved share instead of increasing known benchmarks', () => {
    const result = mergeBenchmarkWeights([{ conditionID: -2, weightBasisPoints: 1500 },
        { conditionID: -3, weightBasisPoints: 2500 }, { conditionID: 20, benchmarkID: 2, name: 'Coding', weightBasisPoints: 6000 }]);
    assert.deepEqual(result.map(item => [item.conditionID, item.weightBasisPoints]), [[20, 6000], [UNRESOLVED_WEIGHT_ID, 4000]]);
    assert.equal(result[1].isUnresolved, true);
});

test('selected reference composition keeps its own full percentages after nested expansion', async () => {
    const e = (conditionID, weightBasisPoints) => ({ conditionID, weightBasisPoints });
    const nodes = new Map([[2, { contextID: 2, entries: [e(10, 2500), e(11, 7500)] }],
        [3, { contextID: 3, entries: [e(-2, 2000), e(10, 8000)] }]]);
    const result = await expandTopicReferences({ contextID: 1, entries: [e(-3, 1000), e(-2, 4000), e(10, 5000)] },
        { loadTarget: async id => nodes.get(id) });
    const composition = result.referenceCompositions.find(item => item.referenceContextID === 3);
    assert.deepEqual(composition.entries, [e(10, 8500), e(11, 1500)]);
    for (const item of result.referenceCompositions) assert.equal(item.entries.reduce((sum, entry) => sum + entry.weightBasisPoints, 0), 10000);
    assert.deepEqual(result.entries, [e(10, 6850), e(11, 3150)]);
});
