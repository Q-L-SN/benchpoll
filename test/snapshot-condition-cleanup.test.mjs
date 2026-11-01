import test from 'node:test';
import assert from 'node:assert/strict';
import { stripConditionSnapshots, planSnapshotCleanup } from '../snapshot-condition-cleanup.js';
test('snapshot labels and dates disappear without removing real metrics or benchmark windows', () => {
    for (const name of ['snapshot=2026-09-23;metric=index', 'snapshot20260919;metric=index', 'profile_snapshot_date=2026-07-21;metric=index']) {
        assert.equal(stripConditionSnapshots(name), 'metric=index');
    }
    assert.equal(stripConditionSnapshots('2026-04-08 snapshot;metric=index'), 'metric=index');
    assert.equal(stripConditionSnapshots('Live leaderboard snapshot Sep19 2026;metric=Elo'), 'Live leaderboard;metric=Elo');
    assert.equal(stripConditionSnapshots('Snapshot20260919 native payload; v4.3 constituent'), 'native payload;v4.3 constituent');
    assert.equal(stripConditionSnapshots('LiveCodeBench;2026-07-01 to 2026-09-01'), 'LiveCodeBench;2026-07-01 to 2026-09-01');
    assert.equal(stripConditionSnapshots('pass@1; parallel test-time compute'), 'pass@1; parallel test-time compute');
    assert.equal(stripConditionSnapshots('snapshot=2026-09-23'), 'default');
});
const condition = (ID, name, overrides = {}) => ({ ID, benchmark_ID: 1, name, condition_key: `c${ID}`,
    score_direction: 'higher', target_value: null, uses_percentage_scale: 1, score_min: null, score_max: null,
    is_default: 0, deleted_at: null, score_count: 10, ...overrides });
test('equal snapshot-free labels merge only within the same benchmark and normalization contract', () => {
    const plan = planSnapshotCleanup([condition(1, 'snapshot=2026-09-19;metric=accuracy'),
        condition(2, 'snapshot=2026-09-23;metric=accuracy', { score_count: 20 }),
        condition(3, 'snapshot=2026-09-23;metric=accuracy', { benchmark_ID: 2 }),
        condition(4, 'snapshot=2026-09-23;metric=accuracy', { score_direction: 'lower' })]);
    assert.deepEqual(plan.merges, [{ sourceID: 1, targetID: 2, resultCount: 10 }]);
    assert.equal(plan.updates.length, 3);
});
test('referenced IDs are preserved and conflicting referenced groups do not silently lose pies', () => {
    const rows = [condition(1, 'snapshot=2026-09-19;metric=accuracy'), condition(2, 'metric=accuracy', { score_count: 100 })];
    assert.equal(planSnapshotCleanup(rows, new Set([1])).merges[0].targetID, 1);
    const plan = planSnapshotCleanup(rows, new Set([1, 2]));
    assert.equal(plan.merges.length, 0); assert.equal(plan.blocked.length, 1); assert.equal(plan.updates[0].name, 'metric=accuracy');
});
test('snapshot-only conditions become literal defaults without colliding with a different-range default', () => {
    const plan = planSnapshotCleanup([condition(1, 'default', { is_default: 1, condition_key: 'default' }),
        condition(2, 'snapshot=2026-09-19'), condition(3, 'snapshot=2026-09-20', { uses_percentage_scale: 0, score_min: 0, score_max: 1 })]);
    assert.equal(plan.merges[0].targetID, 1);
    assert.equal(plan.updates.length, 1); assert.equal(plan.updates[0].isDefault, false);
    assert.match(plan.updates[0].name, /^Standard/);
});
