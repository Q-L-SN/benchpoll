import test from 'node:test';
import assert from 'node:assert/strict';
import { createVersionEstimationPlanner } from '../public/js/shared/version-estimation-policy.js';

const condition = (conditionID, benchmarkID, extra = {}) => ({ conditionID, benchmarkID, ...extra });
const plan = createVersionEstimationPlanner([
    condition(3, 10), condition(2, 10), condition(1, 10), condition(4, 20),
    condition(5, 10, { excludedFromRanking: true }), condition(6, 10, { conditionName: 'AA' })
]);
const weights = [1, 2, 4, -1].map(conditionID => ({ conditionID, weightBasisPoints: 2500 }));
const sourceIDs = (...votes) => plan(weights, ...votes).map(entry => entry.estimationSourceIDs);

test('only other eligible versions of the same benchmark can supply a missing score', () => {
    assert.deepEqual(sourceIDs(), [[2, 3], [1, 3], [], []]);
});

test('the community blocks net opposition while a personal vote affects only that user’s source eligibility', () => {
    const publicVotes = [{ conditionID: 2, supportCount: 1, opposeCount: 2 },
        { conditionID: 3, supportCount: 1, opposeCount: 1 }];
    assert.deepEqual(sourceIDs(publicVotes), [[3], [1, 3], [], []]);
    const own = [{ conditionID: 2, vote: 'support' }, { conditionID: 3, vote: 'oppose' }];
    assert.deepEqual(sourceIDs(publicVotes, own), [[2], [1], [], []]);
    assert.deepEqual(sourceIDs(publicVotes), [[3], [1, 3], [], []]);
    assert.deepEqual(plan(weights, publicVotes, own).map(({ conditionID, weightBasisPoints }) => ({ conditionID, weightBasisPoints })), weights);
});
