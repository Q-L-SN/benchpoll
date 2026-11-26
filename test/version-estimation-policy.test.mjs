import test from 'node:test';
import assert from 'node:assert/strict';
import { createVersionEstimationPlanner } from '../public/js/shared/version-estimation-policy.js';

const condition = (conditionID, benchmarkID, extra = {}) => ({ conditionID, benchmarkID, ...extra });
const catalogue = [
    condition(3, 10), condition(2, 10), condition(1, 10), condition(4, 20),
    condition(5, 10, { excludedFromRanking: true }), condition(6, 10, { conditionName: 'AA' })
];
const plan = createVersionEstimationPlanner(catalogue);
const weights = [1, 2, 3, 4, -1].map(conditionID => ({ conditionID, weightBasisPoints: 2000 }));
const sourceIDs = (...votes) => plan(weights, ...votes).map(entry => entry.estimationSourceIDs);

test('without votes all other eligible versions of the same benchmark can supply a missing score', () => {
    assert.deepEqual(sourceIDs(), [[2, 3], [1, 3], [1, 2], [], []]);
});

test('community majorities and personal overrides apply in both directions of their pair', () => {
    const publicVotes = [{ targetConditionID: 1, sourceConditionID: 2, supportCount: 1, opposeCount: 2 },
        { targetConditionID: 1, sourceConditionID: 3, supportCount: 1, opposeCount: 1 }];
    assert.deepEqual(sourceIDs(publicVotes), [[3], [3], [1, 2], [], []]);
    const own = [{ targetConditionID: 2, sourceConditionID: 1, vote: 'support' },
        { targetConditionID: 2, sourceConditionID: 3, vote: 'oppose' }];
    assert.deepEqual(sourceIDs(publicVotes, own), [[2, 3], [1], [1], [], []]);
    assert.deepEqual(sourceIDs(publicVotes), [[3], [3], [1, 2], [], []]);
    const [first] = plan(weights, publicVotes, own);
    assert.deepEqual(first.blockedEstimationPairs, ['2:3']);
    assert.deepEqual(plan(weights, publicVotes, own).map(({ conditionID, weightBasisPoints }) => ({ conditionID, weightBasisPoints })), weights);
});

test('nominated sources are symmetric, distinct from siblings, and ordered by condition ID', () => {
    const pair = (targetConditionID, sourceConditionID) => ({ targetConditionID, sourceConditionID });
    const nominated = createVersionEstimationPlanner(catalogue, [pair(4, 3), pair(1, 4), pair(4, 1),
        pair(4, 5), pair(4, 6), pair(4, 99), pair(2, 3)]);
    const externalIDs = (...votes) => nominated(weights, ...votes).map(entry => entry.externalSourceIDs ?? []);
    assert.deepEqual(externalIDs(), [[4], [], [4], [1, 3], []]);
    assert.deepEqual(nominated(weights).map(entry => entry.estimationSourceIDs), sourceIDs());
    const community = [{ ...pair(1, 4), supportCount: 1, opposeCount: 2 }, { ...pair(2, 4), supportCount: 2, opposeCount: 0 }];
    assert.deepEqual(externalIDs(community), [[], [], [4], [3], []]);
    const personal = [{ ...pair(4, 1), vote: 'support' }, { ...pair(4, 3), vote: 'oppose' }];
    assert.deepEqual(externalIDs(community, personal), [[4], [], [], [1], []]);
});
