import assert from 'node:assert/strict';
import test from 'node:test';
import {
    cleanBenchmarkConditionName, needsOriginalConditionName, buildBenchmarkConditionCleanupPlan
} from '../benchmark-condition-cleanup.js';

const condition = (ID, name, overrides = {}) => ({ ID, benchmark_ID: 1, name, resultCount: 1,
    score_direction: 'higher', target_value: null, uses_percentage_scale: 0,
    score_min: '0.000000', score_max: '16.000000', is_default: 0, deleted_at: null, ...overrides });

test('cleanup removes run provenance but retains the metric, target and evaluation protocol', () => {
    const original = 'v8-benchv0.1;native snapshot=2026-06-29T17:53:03+00:00;run=abcdef1234567890;env=v8-cve-2024-8194;experiment=v8-nudged;seed=2;AutoNudge=True;harness=codex;turn_budget=300;status=succeeded;metric=capability_flags_count';
    const truncated = `${original.slice(0, 176)} [2274c76d9fda]`;
    assert.equal(needsOriginalConditionName(truncated), true);
    assert.equal(cleanBenchmarkConditionName(truncated), null);
    assert.equal(cleanBenchmarkConditionName(truncated, original),
        'v8-benchv0.1; env=v8-cve-2024-8194; AutoNudge=True; harness=codex; turn_budget=300; metric=capability_flags_count');
    const truncatedMidToken = `${original.slice(0, original.indexOf('seed=2') + 3)} [2274c76d9fda]`;
    assert.equal(cleanBenchmarkConditionName(truncatedMidToken, original),
        'v8-benchv0.1; env=v8-cve-2024-8194; AutoNudge=True; harness=codex; turn_budget=300; metric=capability_flags_count');
    assert.equal(cleanBenchmarkConditionName(truncatedMidToken, original.replace('seed=2', 'mode=2')), null);
    assert.equal(cleanBenchmarkConditionName('metric=recall_at_1; score scale 0-1 [02a85ecb279c]',
        'metric=recall_at_1; score scale 0-100'), null);
    assert.equal(cleanBenchmarkConditionName('[p:ebf0510f7dbf] published JSON; domain=economics; metric=MAP@1; harness=INF-X'),
        'published JSON; domain=economics; metric=MAP@1; harness=INF-X');
    assert.equal(cleanBenchmarkConditionName('release=2025_12_23;subtask=tablereformat'), null);
    assert.equal(cleanBenchmarkConditionName('v8-benchv0.1; native snapshot=2026-06-29; run=abc; env=v8-cve-1; experiment=gpt-x-run-1; metric=accuracy'),
        'v8-benchv0.1; env=v8-cve-1; metric=accuracy');
    assert.equal(cleanBenchmarkConditionName('CodeAgentBench; export=2026-06-18; run=abc; updated=2026-06-16; agent=OpenCode; metric=Pass@3'),
        'CodeAgentBench; agent=OpenCode; metric=Pass@3');
    assert.equal(cleanBenchmarkConditionName('CodeAgentBench;export=2026;run=abc;agent=OpenCode;metric=Pass@3 [aabbccddeeff]',
        'CodeAgentBench;export=2026;run=abc;agent=OpenCode;metric=Pass@3'),
        'CodeAgentBench; agent=OpenCode; metric=Pass@3');
    assert.equal(cleanBenchmarkConditionName('text-to-image; 95% CI -16/+14; metric=win rate percent'),
        'text-to-image; metric=win rate percent');
    assert.equal(cleanBenchmarkConditionName('Launch image; bold means best or overlaps95%CI, not exact tie; metric=accuracy'),
        'Launch image; metric=accuracy');
    assert.equal(cleanBenchmarkConditionName('single-shot; one run; CI not numerically specified; metric=pass rate'),
        'single-shot; metric=pass rate');
    assert.equal(cleanBenchmarkConditionName('MathVision; metric=with_CI; CI=with'), null);
    assert.equal(cleanBenchmarkConditionName('DecisionEval; confidence threshold=>=0.7; metric=coverage'), null);
});

test('cleanup merges only equivalent scales and leaves referenced conditions alone', () => {
    const rows = [
        condition(1, 'suite;run=abc;metric=accuracy', { resultCount: 2 }),
        condition(2, 'suite;run=def;metric=accuracy', { resultCount: 3 }),
        condition(3, 'suite;run=ghi;metric=accuracy', { score_max: '100.000000' }),
        condition(4, 'suite;run=jkl;metric=other'),
        condition(5, 'suite;run=mno;metric=other', { resultCount: 5 }),
        condition(6, 'suite;run=pqr;metric=protected'),
        condition(7, 'suite;run=stu;metric=protected')
    ];
    const plan = buildBenchmarkConditionCleanupPlan(rows, new Map(), new Set([7]));
    assert.deepEqual(plan.merges, [{ sourceID: 4, targetID: 5, benchmarkID: 1, resultCount: 1 }]);
    assert.deepEqual(plan.renames, [{ ID: 5, name: 'suite; metric=other' }]);
    assert.equal(plan.skipped.incompatibleScoreScale, 3);
    assert.equal(plan.skipped.referenced, 2);
});

test('truncated conditions require complete matching source names and never infer missing text', () => {
    const rows = [condition(1, 'v8-benchv0.1;native snapshot=2026-06-29;run=abc;metric=acc [abcdef123456]', { resultCount: 2 })];
    assert.equal(buildBenchmarkConditionCleanupPlan(rows, new Map(), new Set()).skipped.missingOriginal, 1);
    const originalNames = new Map([[1, [
        'v8-benchv0.1;native snapshot=2026-06-29;run=abc;metric=acc',
        'v8-benchv0.1;native snapshot=2026-06-29;run=abc;metric=other'
    ]]]);
    assert.equal(buildBenchmarkConditionCleanupPlan(rows, originalNames, new Set()).skipped.divergentOriginal, 1);
});
