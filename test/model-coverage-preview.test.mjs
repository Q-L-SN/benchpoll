import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModelCoverageEntries, modelCoverageContext } from '../public/js/workspace/model-coverage-preview.js';

const entry = (conditionID, benchmarkID, weightBasisPoints, name = `Benchmark ${benchmarkID}`) =>
    ({ conditionID, benchmarkID, weightBasisPoints, name });
const adopted = (conditionID, weightBasisPoints, coveredWeightBasisPoints, normalizedScore) =>
    ({ conditionID, weightBasisPoints, coveredWeightBasisPoints, normalizedScore,
        coverage: coveredWeightBasisPoints / weightBasisPoints * 100 });

test('expanded benchmark blocks merge actual adopted scores by covered weight, including partial fallback coverage', () => {
    const entries = [entry(11, 1, 2000), entry(12, 1, 3000), entry(21, 2, 4000), entry(-5, null, 1000)];
    const coverage = [adopted(11, 2000, 2000, 60), adopted(12, 3000, 1500, 90), adopted(21, 4000, 4000, 0)];
    const before = structuredClone({ entries, coverage });
    const blocks = buildModelCoverageEntries(entries, coverage);
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].weightBasisPoints, 5000);
    assert.equal(blocks[0].coveredWeightBasisPoints, 3500);
    assert.equal(blocks[0].coverage, 70);
    assert.equal(blocks[0].adoptedNormalizedScore, (60 * 2000 + 90 * 1500) / 3500);
    assert.equal(blocks[1].adoptedNormalizedScore, 0, 'a measured zero is covered');
    assert.equal(blocks[1].coverage, 100);
    assert.equal(blocks[2].isUnresolved, true);
    assert.equal(blocks[2].adoptedNormalizedScore, null);
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

test('uncovered blocks never receive inferred or arbitrary raw score values', () => {
    const [block] = buildModelCoverageEntries([{ ...entry(11, 1, 10000), normalizedScore: 88,
        inferredScores: [{ normalizedScore: 76 }] }], [adopted(11, 10000, 0, null)]);
    assert.equal(block.adoptedNormalizedScore, null);
    assert.equal(block.coverage, 0);
    assert.equal(buildModelCoverageEntries([entry(11, 1, 10000)], undefined), null);
});

test('malformed adopted summaries cannot produce fabricated coverage', () => {
    const entries = [entry(11, 1, 10000)], valid = adopted(11, 10000, 10000, 80);
    for (const coverage of [[valid, valid], [{ ...valid, coveredWeightBasisPoints: 10001 }],
        [{ ...valid, normalizedScore: NaN }], [{ ...valid, coveredWeightBasisPoints: 0 }],
        [{ ...valid, weightBasisPoints: 0 }]]) {
        assert.throws(() => buildModelCoverageEntries(entries, coverage), /Invalid adopted model coverage/);
    }
});

test('preview context changes for account, ranking, scene, version, algorithm and comparison changes', () => {
    const state = { authenticated: true, userID: 1, categoryID: 2, selectedContextValues: { scene: 7 }, mode: 'personal',
        scoreMode: 'available', loadSequence: 1, rankingVersion: 2, rankingPagination: { snapshotID: 'one' },
        comparison: { keys: ['model'] }, estimationAlgorithm: 'rational', availableInferenceVersion: 1,
        loading: false, comparisonPending: false, personalRankingDirty: false };
    const initial = modelCoverageContext(state);
    for (const patch of [{ userID: 2 }, { mode: 'public' }, { categoryID: 3 }, { selectedContextValues: { scene: 9 } },
        { loadSequence: 2 }, { rankingVersion: 3 }, { rankingPagination: { snapshotID: 'two' } },
        { comparison: { keys: ['field:1'] } }, { estimationAlgorithm: 'other' }, { personalRankingDirty: true }]) {
        assert.notEqual(modelCoverageContext({ ...state, ...patch }), initial);
    }
});
