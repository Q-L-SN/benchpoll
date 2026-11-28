import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModelCoverageEntries, modelCoverageContext } from '../public/js/workspace/model-coverage-preview.js';

const entry = (conditionID, benchmarkID, weightBasisPoints, name = `Benchmark ${benchmarkID}`) =>
    ({ conditionID, benchmarkID, weightBasisPoints, name });
const adopted = (conditionID, weightBasisPoints, coveredWeightBasisPoints, normalizedScore) =>
    ({ conditionID, weightBasisPoints, coveredWeightBasisPoints, normalizedScore,
        coverage: coveredWeightBasisPoints / weightBasisPoints * 100 });

test('expanded benchmark blocks retain their full weights when only partially measured', () => {
    const entries = [entry(11, 1, 2000), entry(12, 1, 3000), entry(21, 2, 4000), entry(-5, null, 1000)];
    const coverage = [adopted(11, 2000, 2000, 60), adopted(12, 3000, 1500, 90), adopted(21, 4000, 4000, 0)];
    const before = structuredClone({ entries, coverage });
    const blocks = buildModelCoverageEntries(entries, coverage);
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].weightBasisPoints, 5000);
    assert.equal(blocks[0].coveredWeightBasisPoints, 3500);
    assert.equal(blocks[0].coverage, 70);
    assert.equal(blocks[0].adoptedNormalizedScore, (60 * 2000 + 90 * 1500) / 3500);
    assert.equal(blocks[0].availableNormalizedScore, blocks[0].adoptedNormalizedScore);
    assert.equal(blocks[1].adoptedNormalizedScore, 0, 'a measured zero is covered');
    assert.equal(blocks[1].unresolvedWeightBasisPoints, 0);
    assert.equal(blocks[1].coverage, 100);
    assert.equal(blocks[2].isUnresolved, true);
    assert.equal(blocks[2].adoptedNormalizedScore, null);
    assert.equal(blocks[2].availableNormalizedScore, null);
    assert.equal(blocks[2].coverage, 0);
    assert.deepEqual({ entries, coverage }, before, 'presentation never rewrites the ranking inputs');
});

test('repeated references share one adopted condition without double counting its coverage', () => {
    const blocks = buildModelCoverageEntries([entry(11, 1, 600), entry(11, 1, 400)],
        [adopted(11, 1000, 250, 44.5)]);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].coveredWeightBasisPoints, 250);
    assert.equal(blocks[0].coverage, 25);
    assert.equal(blocks[0].adoptedNormalizedScore, 44.5);
});

test('a display primary version does not replace the ranking selected version or its adopted fallback score', () => {
    const entries = [{ ...entry(11, 1, 10000), normalizedScore: 99, samples: [99, 99, 99] }];
    const versions = [{ benchmarkID: 1, name: 'Merged test', primaryConditionID: 19,
        versions: [{ conditionID: 19, name: 'Merged test', conditionName: 'Unselected version', medianNormalizedScore: 5 }] }];
    const [block] = buildModelCoverageEntries(entries, [adopted(11, 10000, 10000, 68.5)], versions);
    assert.equal(block.conditionID, 19, 'use the normal expanded view identity and geometry');
    assert.equal(block.adoptedNormalizedScore, 68.5, 'only the adopted score DTO supplies the value');
});

test('uncovered blocks use only estimates from this ranking', () => {
    const [block] = buildModelCoverageEntries([{ ...entry(11, 1, 10000), normalizedScore: 88,
        inferredScores: [{ normalizedScore: 76 }] }], [adopted(11, 10000, 0, null)]);
    assert.equal(block.adoptedNormalizedScore, null);
    assert.equal(block.estimatedNormalizedScore, null);
    assert.equal(block.coverage, 0);
    assert.equal(block.availableNormalizedScore, null);
    assert.equal(block.unresolvedWeightBasisPoints, 10000);
    assert.equal(buildModelCoverageEntries([entry(11, 1, 10000)], undefined), null);
});

test('estimated blocks combine scoped target estimates, including supported zeros and unresolved shares', () => {
    const entries = [entry(11, 1, 1000), entry(11, 1, 1000), entry(12, 1, 2000), entry(21, 2, 6000)];
    const coverage = [adopted(11, 2000, 0, null), adopted(12, 2000, 0, null), adopted(21, 6000, 0, null)];
    const estimates = [{ conditionID: 11, normalizedScore: 0, originalWeight: 5 },
        { conditionID: 11, selection: 'automatic', normalizedScore: 40, weightBasisPoints: 1500,
            sources: [{ sourceConditionID: 91, normalizedScore: 30, weightFraction: .5 },
                { sourceConditionID: 92, normalizedScore: 50, weightFraction: .5 }] },
        { conditionID: 12, normalizedScore: 60, weightBasisPoints: 1000 },
        { conditionID: 21, sourceConditionID: 91, sourceScore: 35, normalizedScore: 0, weightBasisPoints: 6000 }];
    const blocks = buildModelCoverageEntries(entries, coverage, [], estimates);
    assert.deepEqual(blocks.map(b => [b.benchmarkID, b.coverage, b.adoptedNormalizedScore, b.estimatedNormalizedScore]),
        [[2, 0, null, 0], [1, 0, null, 40]]);
    assert.deepEqual(blocks.map(b => [b.estimatedWeightBasisPoints, b.unresolvedWeightBasisPoints, b.availableNormalizedScore]),
        [[6000, 0, 0], [3000, 1000, 40]]);
});

test('merged benchmarks combine measured, estimated, and unresolved slices at their original weights', () => {
    const entries = [entry(11, 1, 4000), entry(12, 1, 2000), entry(13, 1, 4000)];
    const coverage = [adopted(11, 4000, 4000, 80), adopted(12, 2000, 0, null), adopted(13, 4000, 0, null)];
    const [block] = buildModelCoverageEntries(entries, coverage, [], [{ conditionID: 12, normalizedScore: 70, weightBasisPoints: 2000 }]);
    assert.equal(block.coverage, 40);
    assert.equal(block.availableNormalizedScore, 460 / 6);
    assert.equal(block.unresolvedWeightBasisPoints, 4000);
});

test('malformed adopted summaries cannot produce fabricated coverage', () => {
    const entries = [entry(11, 1, 10000)], valid = adopted(11, 10000, 10000, 80);
    for (const coverage of [[valid, valid], [{ ...valid, coveredWeightBasisPoints: 10001 }],
        [{ ...valid, normalizedScore: NaN }], [{ ...valid, coveredWeightBasisPoints: 0 }],
        [{ ...valid, weightBasisPoints: 0 }]]) {
        assert.throws(() => buildModelCoverageEntries(entries, coverage), /Invalid adopted model coverage/);
    }
});

test('preview context changes for account, ranking, scene and comparison changes', () => {
    const state = { authenticated: true, userID: 1, categoryID: 2, selectedContextValues: { scene: 7 }, mode: 'personal',
        loadSequence: 1, rankingVersion: 2, rankingPagination: { snapshotID: 'one' },
        comparison: { keys: ['model'] },
        loading: false, comparisonPending: false, personalRankingDirty: false };
    const initial = modelCoverageContext(state);
    for (const patch of [{ userID: 2 }, { mode: 'public' }, { categoryID: 3 }, { selectedContextValues: { scene: 9 } },
        { loadSequence: 2 }, { rankingVersion: 3 }, { rankingPagination: { snapshotID: 'two' } },
        { comparison: { keys: ['field:1'] } }, { personalRankingDirty: true }]) {
        assert.notEqual(modelCoverageContext({ ...state, ...patch }), initial);
    }
});
