import assert from 'node:assert/strict';
import test from 'node:test';
import { comparisonOptions } from '../model-comparison.js';
import { scoreComparison, scoreModels } from '../ranking-service.js';
import { createVersionEstimationPlanner } from '../public/js/shared/version-estimation-policy.js';
import { PEER_MEDIAN_METHOD, SUPPORTED_WEIGHT_POLICY, TREEMAP_ESTIMATION_METHOD } from '../public/js/shared/fallback-inference.js';
import { calibrationModel as model, pairedModels } from './helpers/fallback-pairs.mjs';

const version = (conditionID, benchmarkID) => ({ conditionID, benchmarkID, name: `Benchmark ${benchmarkID}`, conditionName: `Version ${conditionID}` });
const weight = (conditionID, weightBasisPoints) => ({ conditionID, weightBasisPoints });
const pair = (targetConditionID, sourceConditionID, supportCount, opposeCount) => ({ targetConditionID, sourceConditionID, supportCount, opposeCount });
const near = (value, expected) => assert.ok(Math.abs(value - expected) < 1e-9, `${value} != ${expected}`);

test('treemap estimates follow unselected versions to the target scale and blend by allocation and support', () => {
    const versions = [version(1, 1), version(2, 2), version(3, 2), version(4, 3), version(5, 3), version(6, 4)];
    const entries = [weight(1, 4000), weight(2, 2000), weight(4, 3000), weight(6, 1000)];
    const votes = [pair(1, 2, 2, 0), pair(1, 4, 3, 1)];
    const plan = createVersionEstimationPlanner(versions, votes);
    const models = [model(10, { 3: 90, 5: 60 }), model(11, { 1: 40, 2: 30 }), model(12, { 2: 30, 3: 90 }),
        model(13, { 1: 80, 4: 50 }), model(14, { 4: 50, 5: 60 }), model(15, { 6: 25 }), model(16, { 6: 70 })];
    const rank = (personalVotes = []) => scoreComparison(models, plan(entries, votes, personalVotes), 10000,
        { scoreMode: 'available', treemapPolicy: plan.treemap(entries, votes, personalVotes) }, comparisonOptions(models));
    const rows = rank();
    const estimate = rows[0].inferredScores.find(score => score.conditionID === 1);
    assert.equal(estimate.estimationMethod, TREEMAP_ESTIMATION_METHOD);
    assert.equal(estimate.originalWeight, 40);
    assert.equal(rows[0].coverage, 0);
    assert.deepEqual(estimate.sources.map(source => [source.sourceConditionID, source.sourceScore, source.normalizedScore,
        source.calibrationPaths[0].map(step => [step.targetConditionID, step.referenceCount, step.supportRate])]),
    [[3, 90, 40, [[2, 1, 1], [1, 1, 1]]], [5, 60, 80, [[4, 1, 1], [1, 1, .75]]]]);
    near(estimate.sources[0].weightFraction, 8 / 17);
    near(estimate.sources[1].weightFraction, 9 / 17);
    near(estimate.normalizedScore, (8 * 40 + 9 * 80) / 17);

    const peerMedians = rows.slice(-2).map(row => row.inferredScores.find(score => score.conditionID === 1));
    assert.ok(peerMedians.every(score => score.estimationMethod === PEER_MEDIAN_METHOD && score.referenceCount === 5));
    for (const score of peerMedians) near(score.normalizedScore, estimate.normalizedScore);

    const vetoed = rank([{ targetConditionID: 1, sourceConditionID: 3, vote: 'oppose' }])[0].inferredScores.find(score => score.conditionID === 1);
    assert.equal(vetoed.estimationMethod, TREEMAP_ESTIMATION_METHOD);
    assert.deepEqual(vetoed.sources.map(source => source.sourceConditionID), [5]);
    near(vetoed.normalizedScore, 80);
});

test('peer medians deduplicate models, exclude the ranked model and include earlier version estimates', () => {
    const entries = [{ ...weight(1, 6000), estimationSourceIDs: [2] }, weight(3, 4000)];
    const models = [model(1, { 3: 100 }), model(2, { 1: 90 }, {}, { modelID: 1 }), model(3, { 1: 20, 2: 40 }),
        model(4, { 1: 50 }), model(5, { 1: 50 }, {}, { modelID: 4 }), model(6, { 2: 40 }), model(7, { 3: 80 }), model(8, { 99: 90 })];
    const rank = input => scoreModels(input, entries, 10000, { scoreMode: 'available' });
    const rows = rank(models);
    const estimated = rows.find(row => row.ID === 1);
    const median = estimated.inferredScores.find(score => score.conditionID === 1);
    assert.equal(median.estimationMethod, PEER_MEDIAN_METHOD);
    assert.equal(median.referenceCount, 3);
    near(median.normalizedScore, 20);
    near(estimated.lower, 52);
    const noEvidence = rows.find(row => row.ID === 8);
    assert.deepEqual([noEvidence.lower, noEvidence.inferredScores], [null, []]);
    assert.deepEqual(rank([...models].reverse()).find(row => row.ID === 1).inferredScores, estimated.inferredScores);
});

test('nominated versions outside the treemap can connect weighted benchmarks', () => {
    const versions = [version(1, 1), version(2, 2), version(3, 3), version(4, 3)];
    const entries = [weight(1, 5000), weight(2, 5000)];
    const votes = [pair(1, 3, 1, 0), pair(2, 4, 1, 0)];
    const plan = createVersionEstimationPlanner(versions, votes);
    const models = [model(10, { 2: 80 }), model(11, { 4: 70 }), model(12, { 1: 25, 3: 60 }),
        model(13, { 3: 60, 4: 70 }), model(14, { 4: 70, 2: 80 })];
    const rows = scoreComparison(models, plan(entries, votes), 10000, { scoreMode: 'available',
        treemapPolicy: plan.treemap(entries, votes) }, comparisonOptions(models));
    const viaBridge = rows[0].inferredScores[0];
    assert.equal(viaBridge.estimationMethod, TREEMAP_ESTIMATION_METHOD);
    assert.equal(viaBridge.normalizedScore, 25);
    assert.deepEqual(viaBridge.sources[0].calibrationPaths[0].map(step => step.targetConditionID), [4, 3, 1]);
    const onlyOutside = rows[1].inferredScores.find(score => score.conditionID === 1);
    assert.equal(onlyOutside.estimationMethod, PEER_MEDIAN_METHOD);
});

test('a nomination still needs paired data and public external validation at every step', () => {
    const versions = [version(1, 1), version(2, 2), version(3, 2)];
    const entries = [weight(1, 6000), weight(2, 4000)];
    const votes = [pair(1, 2, 1, 0)];
    const plan = createVersionEstimationPlanner(versions, votes);
    const rules = { scoreMode: 'available', treemapPolicy: plan.treemap(entries, votes) };
    const subject = model(1, { 3: 70 });
    const siblingPeers = pairedModels(2, 3, 70, -10);
    const externalPeers = pairedModels(1, 2, 60, 10).map(peer => ({ ...peer, ID: peer.ID + 100, modelID: peer.modelID + 100 }));
    const getScore = (peers, validateExternal, mode = 'best') => {
        const models = [subject, ...siblingPeers, ...peers];
        return scoreComparison(models, plan(entries, votes), 10000, { ...rules, validateExternal },
            comparisonOptions(models, { mode, keys: ['model'] }))[0];
    };
    assert.equal(getScore([], false).availableInference.weightPolicy, SUPPORTED_WEIGHT_POLICY);
    assert.equal(getScore([], false).inferredScores.some(score => score.conditionID === 1), false);
    assert.equal(getScore(externalPeers, true).inferredScores.find(score => score.conditionID === 1).estimationMethod, TREEMAP_ESTIMATION_METHOD);
    assert.equal(getScore(externalPeers, true, 'matched').inferredScores.find(score => score.conditionID === 1).estimationMethod, TREEMAP_ESTIMATION_METHOD);
    assert.equal(getScore(externalPeers.slice(0, 1), true).inferredScores.find(score => score.conditionID === 1).estimationMethod, PEER_MEDIAN_METHOD);
});
