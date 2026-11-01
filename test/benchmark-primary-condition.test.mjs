import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPrimaryCondition, chooseInitialPrimaryCondition } from '../benchmark-primary-condition.js';
import { benchmarkConditionGroup } from '../public/js/shared/benchmark-condition-groups.js';
import { upgradeBenchmarkModerationContent, repairHistoricalBenchmarkDefaultFlags } from '../scripts/migrate-primary-benchmark-conditions.mjs';

test('a benchmark has exactly one explicit primary, separate from default naming', () => {
    assert.doesNotThrow(() => assertPrimaryCondition([{ name: 'overall', isPrimary: true }, { name: 'default', isPrimary: false }]));
    for (const conditions of [[], [{ isPrimary: false }], [{ isPrimary: true }, { isPrimary: true }], [{}], [{ isPrimary: 1 }]]) {
        assert.throws(() => assertPrimaryCondition(conditions), error => error.body.error === 'benchmark_requires_one_primary_condition');
    }
    assert.doesNotThrow(() => assertPrimaryCondition([{ isPrimary: false }], { appended: true }));
    assert.throws(() => assertPrimaryCondition([{ isPrimary: true }], { appended: true }),
        error => error.body.error === 'use_change_form_to_set_primary_condition');
});

test('initial selection prefers an explicit overall condition, then default, then evidence', () => {
    const conditions = [
        { ID: 3, name: 'subset', scoreCount: 100, scoredModelCount: 20 },
        { ID: 2, name: 'default', scoreCount: 10, scoredModelCount: 3 },
        { ID: 1, name: 'Overall', scoreCount: 5, scoredModelCount: 2 }
    ];
    assert.equal(chooseInitialPrimaryCondition(conditions).ID, 1);
    assert.equal(chooseInitialPrimaryCondition(conditions.slice(0, 2)).ID, 2);
    assert.equal(chooseInitialPrimaryCondition([conditions[0], { ID: 4, name: 'alternative', scoreCount: 50, scoredModelCount: 21 }]).ID, 4);
    assert.equal(conditions[0].ID, 3);
});

test('primary always stays visible; other and lower coverage are disjoint', () => {
    assert.equal(benchmarkConditionGroup({ isPrimaryCondition: true, lowCoverage: true }), 'primary');
    assert.equal(benchmarkConditionGroup({ isPrimaryCondition: false, lowCoverage: false }), 'other');
    assert.equal(benchmarkConditionGroup({ isPrimaryCondition: false, lowCoverage: true }), 'lowCoverage');
    assert.throws(() => benchmarkConditionGroup({ lowCoverage: true }));
});

test('historical requests are explicitly upgraded, not accepted through a runtime fallback', () => {
    const original = { schemaVersion: 5, type: 'new_benchmark', benchmarks: [{ existingBenchmarkID: null,
        existingBenchmarkRef: null, conditions: [{ name: 'subset' }, { name: 'overall' }] }] };
    const migrated = upgradeBenchmarkModerationContent(original, new Map(), () => []);
    assert.equal(migrated.schemaVersion, 6);
    assert.deepEqual(migrated.benchmarks[0].conditions.map(condition => condition.isPrimary), [false, true]);
    assert.equal(original.benchmarks[0].conditions[1].isPrimary, undefined);
    assert.equal(upgradeBenchmarkModerationContent(migrated, new Map(), () => []), null);
    const change = { schemaVersion: 5, type: 'entity_change', targetKind: 'benchmark', targetID: 10,
        before: { conditions: [{ ID: 1, name: 'default' }, { ID: 2, name: 'overall' }] },
        after: { conditions: [{ ID: 1, name: 'default' }, { ID: 2, name: 'renamed overall' }] }, changes: [] };
    const changed = upgradeBenchmarkModerationContent(change, new Map([[10, 2]]), () => [{ field: 'name' }]);
    assert.deepEqual(changed.before.conditions.map(condition => condition.isPrimary), [false, true]);
    assert.deepEqual(changed.after.conditions.map(condition => condition.isPrimary), [false, true]);
});

test('historical first-condition defaults are repaired without renaming conditions or changing primary selection', () => {
    const content = { schemaVersion: 6, type: 'new_benchmark', benchmarks: [{
        conditions: [{ name: 'private set', isDefault: true, isPrimary: true },
            { name: 'default', isDefault: false, isPrimary: false }]
    }] };
    const repaired = repairHistoricalBenchmarkDefaultFlags(content, () => []);
    assert.deepEqual(repaired.benchmarks[0].conditions, [
        { name: 'private set', isDefault: false, isPrimary: true },
        { name: 'default', isDefault: true, isPrimary: false }
    ]);
    assert.equal(content.benchmarks[0].conditions[0].isDefault, true);
    assert.equal(repairHistoricalBenchmarkDefaultFlags(repaired, () => []), null);
    const change = { type: 'entity_change', targetKind: 'benchmark', before: { conditions: [
        { ID: 1, name: 'overall', isDefault: true, isPrimary: true }
    ] }, after: { conditions: [{ ID: 1, name: 'renamed', isDefault: true, isPrimary: true }] }, changes: [] };
    const repairedChange = repairHistoricalBenchmarkDefaultFlags(change, () => [{ field: 'conditions' }]);
    assert.equal(repairedChange.before.conditions[0].isDefault, false);
    assert.equal(repairedChange.after.conditions[0].ID, 1);
    assert.deepEqual(repairedChange.changes, [{ field: 'conditions' }]);
});
