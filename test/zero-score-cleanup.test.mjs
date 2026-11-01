import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createZeroScoreCleanupPlan, assertCleanupReferencesClear, deleteZeroScoreConditions } from '../scripts/delete-zero-score-conditions.mjs';

const benchmarks = [{ ID: 10, is_active: 1 }, { ID: 20, is_active: 1 }];
const condition = (ID, benchmarkID, name, scoreCount, primary = false, extra = {}) => ({
    ID, benchmark_ID: benchmarkID, name, scoreCount, scoredModelCount: Math.min(scoreCount, 3),
    is_primary: Number(primary), deleted_at: null, score_source: null, ...extra
});

test('archived or superseded evidence cannot keep a zero-current-score condition selectable', () => {
    const plan = createZeroScoreCleanupPlan(benchmarks, [
        condition(1, 10, 'default', 0, true, { allScores: 6, archivedScores: 5, supersededScores: 1 }),
        condition(2, 10, 'overall', 4), condition(3, 20, 'default', 0, true)
    ]);
    assert.deepEqual(plan.conditionIDs, [1, 3]);
    assert.deepEqual(plan.benchmarkIDs, [20]);
    assert.deepEqual(plan.primaryReplacements, [{ benchmarkID: 10, previousID: 1, conditionID: 2, name: 'overall' }]);
});

test('a scored primary stays primary and scored low-coverage conditions are not removed', () => {
    const plan = createZeroScoreCleanupPlan([benchmarks[0]], [
        condition(1, 10, 'default', 10, true), condition(2, 10, 'low coverage', 1), condition(3, 10, 'old', 0)
    ]);
    assert.deepEqual(plan.conditionIDs, [3]);
    assert.deepEqual(plan.primaryReplacements, []);
    assert.deepEqual(plan.benchmarkIDs, []);
});

test('replacement follows the current overall/default/coverage primary policy deterministically', () => {
    const plan = createZeroScoreCleanupPlan([benchmarks[0]], [
        condition(1, 10, 'old', 0, true), condition(2, 10, 'default', 20),
        condition(3, 10, 'Overall', 1), condition(4, 10, 'custom', 30)
    ]);
    assert.equal(plan.primaryReplacements[0].conditionID, 3);
    assert.deepEqual(createZeroScoreCleanupPlan([benchmarks[0]], [condition(1, 10, 'default', 0, true)]).benchmarkIDs, [10]);
    assert.deepEqual(createZeroScoreCleanupPlan([benchmarks[0]], []).benchmarkIDs, [10]);
});

test('the second run is a no-op after valid cleanup', () => {
    const plan = createZeroScoreCleanupPlan([benchmarks[0]], [condition(2, 10, 'overall', 4, true)]);
    assert.deepEqual(plan.conditionIDs, []);
    assert.deepEqual(plan.benchmarkIDs, []);
    assert.deepEqual(plan.primaryReplacements, []);
});

test('invalid snapshots and pre-existing primary errors fail instead of being silently repaired', () => {
    for (const rows of [
        [condition(1, 10, 'default', undefined, true)],
        [condition(1, 10, 'default', 1, true, { scoredModelCount: 0 })],
        [condition(1, 10, 'default', 1, true, { deleted_at: '2026-10-01' })],
        [condition(1, 10, 'default', 1)],
        [condition(1, 10, 'default', 1, true), condition(2, 10, 'other', 1, true)],
        [condition(1, 99, 'default', 1, true)]
    ]) assert.throws(() => createZeroScoreCleanupPlan([benchmarks[0]], rows), /Invalid|primary/);
    assert.throws(() => createZeroScoreCleanupPlan([{ ID: 10, is_active: 0 }], []), /open benchmarks/);
});

test('ordered-family, personal-weight and discussion references stop cleanup without partial repair', () => {
    assert.doesNotThrow(() => assertCleanupReferencesClear({ personalWeightReferences: 0, familyMemberReferences: 0 }));
    for (const name of ['personalWeightReferences', 'familyEntranceReferences', 'familyMemberReferences',
        'discussionConditionReferences', 'discussionBenchmarkReferences']) {
        assert.throws(() => assertCleanupReferencesClear({ [name]: 1 }), /repair these references explicitly/);
    }
});

test('registered sources are explicitly included in the plan for pre-apply refusal', () => {
    const plan = createZeroScoreCleanupPlan([benchmarks[0]], [condition(1, 10, 'default', 0, true, { score_source: 'arena' })]);
    assert.deepEqual(plan.synchronizedConditions, [1]);
});

test('applying without a reviewed digest or backup fails before starting a transaction', async () => {
    let touched = false;
    const db = { async beginTransaction() { touched = true; } };
    await assert.rejects(deleteZeroScoreConditions(db, { apply: true, backupDirectory: '/unused' }), /reviewed plan digest/);
    await assert.rejects(deleteZeroScoreConditions(db, { apply: true, expectedPlanDigest: 'a'.repeat(64) }), /backup directory/);
    assert.equal(touched, false);
});

test('cleanup uses current scoring and ordinary retired-key deletion without legacy component tables', async () => {
    const source = await fs.readFile(new URL('../scripts/delete-zero-score-conditions.mjs', import.meta.url), 'utf8');
    assert.match(source, /currentScoreSQL\('r'\)/);
    assert.match(source, /m\.is_active = 1/);
    assert.match(source, /CONCAT\('retired-', ID\), is_default = 0, is_primary = 0/);
    assert.doesNotMatch(source, /personal_pie_score_rule_components|DELETE FROM benchmark_results|DELETE FROM benchmark_conditions/);
    assert.match(source, /preservedAfter, preservedBefore/);
    assert.match(source, /Cleanup plan changed/);
    assert.match(source, /Unreviewed cleanup references/);
});
