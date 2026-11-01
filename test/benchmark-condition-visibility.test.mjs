import assert from 'node:assert/strict';
import test from 'node:test';
import { conditionCoverage, selectableBenchmarkConditionSQL } from '../benchmark-condition-visibility.js';

test('condition visibility depends only on explicit deletion, not score history', () => {
    assert.equal(selectableBenchmarkConditionSQL('c'), 'c.deleted_at IS NULL');
    assert.equal(selectableBenchmarkConditionSQL(), 'benchmark_conditions.deleted_at IS NULL');
    assert.throws(() => selectableBenchmarkConditionSQL('c; DROP TABLE benchmarks'), TypeError);
});

test('coverage folding compares siblings only and includes the exact 20% boundary', () => {
    const rows = [{ ID: 1, benchmarkID: 10, scoreCount: 100 }, { ID: 2, benchmarkID: 10, scoreCount: 20 },
        { ID: 3, benchmarkID: 10, scoreCount: 21 }, { ID: 4, benchmarkID: 20, scoreCount: 1 },
        { ID: 5, benchmarkID: 30, scoreCount: 0 }, { ID: 6, benchmarkID: 10, scoreCount: 0 }];
    assert.deepEqual(conditionCoverage(rows).map(row => row.lowCoverage), [false, true, false, false, false, true]);
    assert.ok(rows.every(row => !('lowCoverage' in row)), 'Catalog inputs must not be mutated');
    for (const scoreCount of [-1, .5, NaN, '1', null]) assert.throws(() => conditionCoverage([{ benchmarkID: 1, scoreCount }]));
    assert.throws(() => conditionCoverage([{ scoreCount: 1 }]), /identity/);
    assert.deepEqual(conditionCoverage([{ scoreCount: 100 }, { scoreCount: 20 }], 'pending:1:new').map(row => row.lowCoverage), [false, true]);
});
