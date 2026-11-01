import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMtebConsolidationPlan, canonicalMtebCondition } from '../mteb-condition-consolidation.js';

const base = {
    benchmark_ID: 1,
    benchmark_name: 'MTEB task: arguana',
    score_direction: 'higher',
    target_value: null,
    uses_percentage_scale: 1,
    score_min: null,
    score_max: null,
    deleted_at: null,
    resultCount: 1
};
const metric = 'task=Retrieval; dataset=MTEB ArguAna; dataset_id=arguana; config=default; split=test; revision=None; metric=mrr_at_100';

test('MTEB canonicalization ignores clause order and a redundant score-scale label', () => {
    const first = { ...base, ID: 1, name: `MTEB ${metric}; score scale 0-100` };
    const second = { ...base, ID: 2, name: 'dataset=MTEB ArguAna; dataset_id=arguana; task=Retrieval; config=default; split=test; revision=None; metric=mrr_at_100' };
    assert.equal(canonicalMtebCondition(first), canonicalMtebCondition(second));
    const plan = buildMtebConsolidationPlan([first, second]);
    assert.deepEqual(plan.merges, [{ sourceID: 2, targetID: 1, benchmarkID: 1, resultCount: 1 }]);
});

test('hashed MTEB conditions need a complete, unanimous original name', () => {
    const source = { ...base, ID: 3, name: `MTEB ${metric}; score scale 0-100 [abcdef123456]`, resultCount: 2 };
    assert.equal(canonicalMtebCondition(source), null);
    const originals = new Map([[3, [`MTEB ${metric}; score scale 0-100`, `MTEB ${metric}; score scale 0-100`]]]);
    assert.equal(canonicalMtebCondition(source, originals), canonicalMtebCondition({ ...base, name: metric }));
    originals.get(3)[1] = `MTEB ${metric}; metric=ndcg_at_10`;
    assert.equal(canonicalMtebCondition(source, originals), null);
});

test('different metrics, splits, scales and benchmarks remain separate', () => {
    const first = { ...base, ID: 1, name: metric };
    const variants = [
        { ...base, ID: 2, name: metric.replace('mrr_at_100', 'ndcg_at_10') },
        { ...base, ID: 3, name: metric.replace('split=test', 'split=dev') },
        { ...base, ID: 4, name: metric, score_max: 100, uses_percentage_scale: 0 },
        { ...base, ID: 5, name: metric, benchmark_ID: 2 }
    ];
    assert.deepEqual(buildMtebConsolidationPlan([first, ...variants]).merges, []);
});

test('a referenced condition survives a merge, but two referenced conditions are left alone', () => {
    const first = { ...base, ID: 1, name: metric };
    const second = { ...base, ID: 2, name: `MTEB ${metric}; score scale 0-100` };
    assert.deepEqual(buildMtebConsolidationPlan([first, second], new Map(), new Set([2])).merges,
        [{ sourceID: 1, targetID: 2, benchmarkID: 1, resultCount: 1 }]);
    assert.equal(buildMtebConsolidationPlan([first, second], new Map(), new Set([1, 2])).protectedGroups, 1);
});
