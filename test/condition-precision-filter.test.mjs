import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyScorePair, classifyConditionPair, filterConditionPairs } from '../condition-precision-filter.js';

test('trailing zeros do not add decimal places', () => {
    assert.equal(classifyScorePair('78.1000', '78.1'), 'merge');
    assert.equal(classifyScorePair('78.0000', '78'), 'ignore');
    assert.equal(classifyScorePair('0.0100', '0.01'), 'merge');
});

test('integer scores at most 100 are ignored, not merged', () => {
    assert.equal(classifyScorePair('0', '100'), 'ignore');
    assert.equal(classifyScorePair('-2', '95'), 'ignore');
    assert.equal(classifyScorePair('101', '101'), 'report');
});

test('decimal scores follow both sides of the 3-percent boundary', () => {
    assert.equal(classifyScorePair('3.0', '3.1'), 'report');
    assert.equal(classifyScorePair('3.1', '-4.5'), 'merge');
    assert.equal(classifyScorePair('3.1', '2.99'), 'report');
    assert.equal(classifyScorePair('0.01', '-2.99'), 'merge');
    assert.equal(classifyScorePair('0.1', '0.12'), 'report');
    assert.equal(classifyScorePair('0.00', '0.01'), 'report');
    assert.equal(classifyScorePair('2.99', '2.99'), 'merge');
    assert.equal(classifyScorePair('3.00', '3.00'), 'ignore');
});

test('a qualifying score witness takes precedence over weak evidence', () => {
    const samples = [
        { modelID: 1, score: '78.000000' }, { modelID: 1, score: '78' },
        { modelID: 2, score: '78.100000' }, { modelID: 2, score: '78.1' }
    ];
    assert.deepEqual(classifyConditionPair({ conditionIDs: [1, 2],
        exact: [[0, 1], [2, 3]], rounding: [] }, samples), {
        verdict: 'merge', counts: { ignore: 1, merge: 1, report: 0 },
        mergeEvidence: { kind: 'exact', modelID: 2, scores: ['78.100000', '78.1'], sampleIDs: [2, 3] },
        reportEvidence: null
    });
});

test('pair filter counts semantic and scale conflicts without treating them as equivalence', () => {
    const report = {
        conditions: [{ ID: 1 }, { ID: 2 }],
        samples: [{ modelID: 1, score: '41.2' }, { modelID: 1, score: '41.2' }],
        pairs: [{ conditionIDs: [1, 2], benchmarkName: 'Example', exact: [[0, 1]],
            rounding: [], sameScale: false, semanticDifferences: [{ key: 'metric', left: 'a', right: 'b' }] }]
    };
    const result = filterConditionPairs(report);
    assert.deepEqual(result.summary, { total: 1, ignore: 0, merge: 1, report: 0,
        mergeWithExplicitSemanticDifference: 1, mergeWithDifferentScale: 1 });
});
