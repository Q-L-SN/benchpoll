import test from 'node:test';
import assert from 'node:assert/strict';
import { actualScoreFallbackPath } from '../public/js/workspace/model-score-fallback.js';

test('source evidence uses only the actual attempted fallback prefix', () => {
    const score = { fallbackFor: 1, conditionID: 3, familyConditionIDs: [1, 2, 3, 4, 5] };
    assert.deepEqual(actualScoreFallbackPath(score), [1, 2, 3]);
    assert.deepEqual(score.familyConditionIDs, [1, 2, 3, 4, 5]);
    assert.deepEqual(actualScoreFallbackPath({ ...score, conditionID: 2 }), [1, 2]);
    assert.deepEqual(actualScoreFallbackPath({ ...score, fallbackFor: null, conditionID: 1 }), [1]);
});

test('unknown or inconsistent source paths fail instead of fabricating a chain', () => {
    for (const score of [
        { fallbackFor: 1, conditionID: 2, familyConditionIDs: [3, 2] },
        { fallbackFor: 1, conditionID: 2, familyConditionIDs: [1, 3] },
        { fallbackFor: 1, conditionID: 2, familyConditionIDs: [1, 2, 2] },
        { fallbackFor: 1, conditionID: 2, familyConditionIDs: [1, '2'] }
    ]) assert.throws(() => actualScoreFallbackPath(score), TypeError);
});
