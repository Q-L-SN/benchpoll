import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCuratedConditionMergePlan } from '../curated-condition-merges.js';

function condition(ID, changes = {}) {
    return { ID, benchmark_ID: 1, benchmark_name: 'Example Benchmark', name: `condition ${ID}`,
        deleted_at: null, is_default: 0, score_direction: 'higher', target_value: null,
        uses_percentage_scale: 1, score_min: null, score_max: null, resultCount: 2, ...changes };
}

const spec = { groups: [{ targetID: 1, sourceIDs: [2], reason: 'Same official accuracy metric and scale.' }] };

test('curated merge plans preserve the exact reviewed target and source IDs', () => {
    const plan = buildCuratedConditionMergePlan(spec, [condition(1), condition(2)]);
    assert.deepEqual(plan.merges, [{ sourceID: 2, targetID: 1, resultCount: 2 }]);
    assert.equal(plan.groups[0].targetName, 'condition 1');
});

test('curated merges reject distinct benchmarks and score scales', () => {
    assert.throws(() => buildCuratedConditionMergePlan(spec,
        [condition(1), condition(2, { benchmark_ID: 9 })]), /different benchmarks/);
    assert.throws(() => buildCuratedConditionMergePlan(spec,
        [condition(1), condition(2, { score_direction: 'lower' })]), /different score scales/);
    assert.throws(() => buildCuratedConditionMergePlan(spec,
        [condition(1), condition(2, { score_max: 100, score_min: 0, uses_percentage_scale: 0 })]), /different score scales/);
});

test('curated merges retain default and referenced conditions', () => {
    assert.throws(() => buildCuratedConditionMergePlan(spec,
        [condition(1), condition(2, { is_default: 1 })]), /Default condition/);
    assert.throws(() => buildCuratedConditionMergePlan(spec,
        [condition(1), condition(2)], new Set([2])), /live pie or discussion references/);
});

test('curated plans carry explicit per-score additions without inferring them', () => {
    const plan = buildCuratedConditionMergePlan({ groups: [{ ...spec.groups[0],
        sourceFieldAdditions: [{ fieldID: 27, value: 'MaxSim' }] }] }, [condition(1), condition(2)]);
    assert.deepEqual(plan.groups[0].sourceFieldAdditions, [{ fieldID: 27, value: 'MaxSim' }]);
    assert.throws(() => buildCuratedConditionMergePlan({ groups: [{ ...spec.groups[0],
        sourceFieldAdditions: [{ fieldID: 27, value: 'MaxSim' }, { fieldID: 27, value: 'Other' }] }] },
    [condition(1), condition(2)]), /repeated source field additions/);
});

test('curated plans rename only explicitly reviewed target names', () => {
    const plan = buildCuratedConditionMergePlan({ groups: [{ ...spec.groups[0], targetName: 'Accuracy' }] },
        [condition(1), condition(2)]);
    assert.deepEqual(plan.renames, [{ ID: 1, name: 'Accuracy' }]);
    assert.deepEqual(buildCuratedConditionMergePlan(spec, [condition(1), condition(2)]).renames, []);
});

test('curated score-scale corrections must be explicit and bounded', () => {
    const plan = buildCuratedConditionMergePlan({ groups: [{ ...spec.groups[0],
        targetScale: { usesPercentageScale: false, scoreMin: 0, scoreMax: 10 } }] },
    [condition(1), condition(2)]);
    assert.deepEqual(plan.scaleUpdates, [{ ID: 1, usesPercentageScale: false, scoreMin: 0, scoreMax: 10 }]);
    assert.throws(() => buildCuratedConditionMergePlan({ groups: [{ ...spec.groups[0],
        targetScale: { usesPercentageScale: false, scoreMin: 10, scoreMax: 0 } }] },
    [condition(1), condition(2)]), /Invalid reviewed target scale/);
});

test('curated merges reject missing, reused and deleted conditions', () => {
    assert.throws(() => buildCuratedConditionMergePlan(spec, [condition(1)]), /missing source/);
    assert.throws(() => buildCuratedConditionMergePlan(spec,
        [condition(1), condition(2, { deleted_at: '2026-09-28 00:00:00' })]), /Deleted or missing source/);
    assert.throws(() => buildCuratedConditionMergePlan({ groups: [
        spec.groups[0], { targetID: 2, sourceIDs: [3], reason: 'Same metric.' }
    ] }, [condition(1), condition(2), condition(3)]), /multiple groups/);
});
