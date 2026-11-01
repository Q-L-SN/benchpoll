import test from 'node:test';
import assert from 'node:assert/strict';
import { auditCrossBenchmarkScores, benchmarkNameSimilarity } from '../cross-benchmark-score-audit.js';

function fixture(names, scores = names.map(() => '78.1000')) {
    return { version: 2, snapshotTime: '2026-09-29', fields: [], options: [],
        conditions: names.map((name, i) => ({ ID: i + 1, benchmark_ID: i + 1,
            benchmark_name: name, name: 'default', uses_percentage_scale: 1,
            score_direction: 'higher', target_value: null, score_min: null, score_max: null })),
        results: scores.map((rawScore, i) => ({ ID: i + 1, conditionID: i + 1, modelID: 1,
            modelName: 'Model', fields: [], rawScore, sourceURL: `https://example.com/${i}` })) };
}

test('name thresholds are strict above 70, inclusive 30 through 60, and exclude the gap', () => {
    assert.equal(benchmarkNameSimilarity('abcdefghij', 'abcdefghXY').band, 'high');
    assert.equal(benchmarkNameSimilarity('abcdefghij', 'abcdefgXYZ').band, null);
    assert.equal(benchmarkNameSimilarity('abcdefghij', 'abcdefWXYZ').band, 'medium');
    assert.equal(benchmarkNameSimilarity('abcdefghij', 'abcUVWXYZQ').band, 'medium');
    assert.equal(benchmarkNameSimilarity('abcdefghij', 'abTUVWXYZQ').band, null);
    assert.equal(benchmarkNameSimilarity('', '').band, null);
    assert.equal(benchmarkNameSimilarity('SWE-bench', 'swe BENCH').similarity, 1);
    assert.notEqual(benchmarkNameSimilarity('ARC-AGI-1', 'ARC-AGI-3').similarity, 1);
});

test('cross-name scoring preserves effective decimal rules and source evidence', () => {
    const report = auditCrossBenchmarkScores(fixture(['ExampleBench', 'Example Bench'], ['78.1000', '78.1']));
    assert.equal(report.summary.highPassWithoutDetectedConflict, 1);
    assert.equal(report.pairs[0].precision.verdict, 'merge');
    assert.deepEqual(report.pairs[0].benchmarkIDs, [1, 2]);
    assert.deepEqual(report.samples.map(s => s.resultIDs), [[1], [2]]);
    assert.equal(auditCrossBenchmarkScores(fixture(['ExampleBench', 'Example Bench'], ['78.0000', '78'])).pairs.length, 0);
    assert.equal(auditCrossBenchmarkScores(fixture(['ExampleBench', 'Example Bench'], ['0.81', '0.8100'])).summary.numericalPassPairs, 1);
});

test('medium similarity passes are separately reported and conflicts stay visible', () => {
    const data = fixture(['abcdefghij', 'abcdefWXYZ']);
    let report = auditCrossBenchmarkScores(data);
    assert.equal(report.summary.mediumPassWithoutDetectedConflict, 1);
    data.conditions[0].name = 'metric=recall';
    data.conditions[1].name = 'metric=precision';
    report = auditCrossBenchmarkScores(data);
    assert.equal(report.summary.mediumPassWithoutDetectedConflict, 0);
    assert.equal(report.summary.numericalPassWithDetectedConflict, 1);
    assert.equal(report.pairs[0].semanticDifferences[0].key, 'metric');
    data.conditions[1].name = 'metric=recall';
    data.conditions[1].score_direction = 'lower';
    assert.equal(auditCrossBenchmarkScores(data).pairs[0].sameScale, false);
});

test('matching models and recorded configurations remain required across benchmarks', () => {
    const data = fixture(['ExampleBench', 'Example Bench']);
    data.results[1].modelID = 2;
    assert.equal(auditCrossBenchmarkScores(data).pairs.length, 0);
    data.results[1].modelID = 1;
    data.fields = [{ ID: 1, name: 'Harness', type: 'text' }];
    data.results[1].fields = [{ fieldID: 1, value: 'different' }];
    assert.equal(auditCrossBenchmarkScores(data).pairs.length, 0);
});

test('similarity is pairwise, evidence indices survive multiple audits, and input is unchanged', () => {
    const data = fixture(['abcdefghij', 'abcdefghXY', 'abcdefWXXY']);
    const original = structuredClone(data);
    const report = auditCrossBenchmarkScores(data);
    assert.equal(report.pairs.length, 3);
    assert.equal(report.pairs.find(p => p.benchmarkIDs.join() === '1,3').nameBand, 'medium');
    assert.equal(report.samples.length, 3);
    for (const p of report.pairs) for (const [a, b] of p.exact) {
        assert.deepEqual([report.samples[a].conditionID, report.samples[b].conditionID].sort(), p.conditionIDs);
    }
    assert.deepEqual(data, original);
});

test('same-benchmark conditions never leak into cross-benchmark results', () => {
    const data = fixture(['ExampleBench', 'Example Bench', 'ExampleBench']);
    data.conditions[2].benchmark_ID = 1;
    const report = auditCrossBenchmarkScores(data);
    assert.equal(report.pairs.length, 2);
    assert.ok(report.pairs.every(p => p.benchmarkIDs[0] !== p.benchmarkIDs[1]));
});
