import assert from 'node:assert/strict';
import test from 'node:test';
import { auditConditionScoreOverlap } from '../condition-score-overlap.js';
import { planConditionOverlapMerges, scoreEvidenceDigest, semanticDifferences } from '../condition-overlap-merge-plan.js';

function fixture(values) {
    const conditions = values.map((_, index) => ({ ID: index + 1, name: `Label ${index + 1}`,
        benchmark_ID: 1, benchmark_name: 'Example', is_default: 0,
        score_direction: 'higher', target_value: null, uses_percentage_scale: 1, score_min: null, score_max: null }));
    const snapshot = { version: 1, fields: [], options: [], conditions, results: values.flatMap((rows, index) =>
        rows.map(([modelID, rawScore], j) => ({ ID: index * 100 + j + 1, conditionID: index + 1,
            modelID, modelName: `Model ${modelID}`, rawScore: String(rawScore), fields: [], sourceURL: '' }))) };
    const review = [{ benchmarkName: 'Example', reason: 'Same protocol',
        conditions: conditions.map(({ ID, name }) => ({ ID, name })) }];
    return { snapshot, review, report: auditConditionScoreOverlap(snapshot) };
}

test('merges the smaller sample set into the larger and preserves all sample identities', () => {
    const f = fixture([[[1, 10], [2, 20]], [[1, 10], [2, 20], [3, 30]]]);
    const plan = planConditionOverlapMerges(f.report, f.review);
    assert.deepEqual(plan.groups[0].sourceIDs, [1]);
    assert.equal(plan.groups[0].targetID, 2);
    assert.equal(plan.steps[0].coverage, 1);
});

test('single matches and below-75-percent overlap do not merge', () => {
    const f = fixture([[[1, 10], [2, 20], [3, 30]], [[1, 10], [2, 20], [4, 40]]]);
    assert.equal(planConditionOverlapMerges(f.report, f.review).groups.length, 0);
});

test('recomputes union evidence rather than following a stale transitive graph', () => {
    const f = fixture([
        [[1, 10], [2, 20], [3, 30], [4, 40]],
        [[1, 10], [2, 20], [3, 30], [5, 50]],
        [[1, 10], [2, 20], [5, 50], [4, 41]]
    ]);
    const plan = planConditionOverlapMerges(f.report, f.review);
    assert.equal(plan.steps.length, 1);
    assert.deepEqual(plan.groups[0].sourceIDs, [2]);
    assert.ok(plan.blocked.length);
});

test('refuses stale review, cross-benchmark groups, conflicting scales and referenced source', () => {
    const f = fixture([[[1, 10], [2, 20]], [[1, 10], [2, 20], [3, 30]]]);
    assert.equal(planConditionOverlapMerges(f.report, f.review, new Set([1])).groups.length, 0);
    f.review[0].conditions[0].name = 'Renamed';
    assert.throws(() => planConditionOverlapMerges(f.report, f.review), /Stale/);
    f.review[0].conditions[0].name = 'Label 1';
    f.report.conditions[0].score_direction = 'lower';
    assert.equal(planConditionOverlapMerges(f.report, f.review).groups.length, 0);
    f.report.conditions[0].benchmark_ID = 2;
    assert.throws(() => planConditionOverlapMerges(f.report, f.review), /different benchmarks/);
});

test('numeric coincidence does not authorize unreviewed semantic groups', () => {
    const f = fixture([[[1, 0], [2, 0]], [[1, 0], [2, 0]]]);
    assert.equal(planConditionOverlapMerges(f.report, []).groups.length, 0);
    assert.deepEqual(semanticDifferences({ name: 'metric=recall@1; data=A' },
        { name: 'metric=precision@1; data=A' }), [{ key: 'metric', left: 'recall@1', right: 'precision@1' }]);
});

test('evidence fingerprint notices edits with unchanged row counts', () => {
    const f = fixture([[[1, 10], [2, 20]], [[1, 10], [2, 20]]]);
    const original = scoreEvidenceDigest(f.snapshot.results);
    assert.equal(original, scoreEvidenceDigest([...f.snapshot.results].reverse()));
    f.snapshot.results[0].rawScore = '11';
    assert.notEqual(original, scoreEvidenceDigest(f.snapshot.results));
});
