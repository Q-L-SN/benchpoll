import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCleanupPlan } from '../ops/cleanup-aa-and-withdrawn-20261029.mjs';

const fixture = () => ({
    conditions: [{ condition_ID: 1, benchmarkName: 'AA-Example' }, { condition_ID: 2, benchmarkName: 'Independent' },
        { condition_ID: 3, benchmarkName: 'Independent' }], pies: [{ ID: 7 }],
    weights: [{ pie_ID: 7, benchmark_condition_ID: 1, weight_basis_points: 1793 },
        { pie_ID: 7, benchmark_condition_ID: 2, weight_basis_points: 4000 },
        { pie_ID: 7, benchmark_condition_ID: 3, weight_basis_points: 4207 }],
    rules: [], members: [], proposals: [{ ID: 5, status: 'open', withdrawn_at: '2026-10-20', moderation_log_ID: null, topic_ID: null }]
});
test('cleanup removes only AA sectors and redistributes to an exact 10000 total', () => {
    const plan = buildCleanupPlan(fixture());
    assert.deepEqual(plan.changes[0].removed.map(row => row.benchmark_condition_ID), [1]);
    assert.equal(plan.changes[0].retained.reduce((sum, row) => sum + row.weight, 0), 10000);
    assert.deepEqual(plan.changes[0].retained.map(row => row.weight), [4874, 5126]);
    assert.equal(plan.withdrawn.length, 1);
});
test('cleanup refuses unexpected invalid pie, retained AA fallback, or reviewed withdrawal', () => {
    const broken = fixture(); broken.weights[0].weight_basis_points--;
    assert.throws(() => buildCleanupPlan(broken), /Invalid existing pie total/);
    const chain = fixture(); chain.rules = [{ pie_ID: 7, primary_benchmark_condition_ID: 2, family_ID: 9 }];
    chain.members = [{ family_ID: 9, benchmark_condition_ID: 1 }];
    assert.throws(() => buildCleanupPlan(chain), /separate review/);
    const review = fixture(); review.proposals[0].status = 'pending';
    assert.throws(() => buildCleanupPlan(review), /linked to review/);
});
