import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { familyKey, resolvedFamilyConditionIDs, resolveFamilyScore } from '../public/js/shared/benchmark-families.js';
import { parseFamilyRows, ensureBenchmarkFamily } from '../benchmark-family-service.js';
import { scoreModels, savePersonalPie } from '../ranking-service.js';
import { createEditHistory } from '../public/js/workspace/edit-history.js';

const auto = () => ({ kind: 'other_versions' });
const models = scores => [{ ID: 1, modelID: 1, name: 'Model', results: new Map(scores.map(([ID, normalizedScore]) => [String(ID), { normalizedScore }])) }];

test('only explicit concrete versions can identify, resolve, or persist a family', async () => {
    const db = { getConnection() { assert.fail('Invalid groups must fail before database access'); } };
    for (const entries of [[auto()], [{ ...auto(), versions: [{ conditionID: 2 }] }], [{ ...auto(), conditionID: 2 }]]) {
        assert.throws(() => familyKey(1, entries), TypeError);
        assert.throws(() => resolvedFamilyConditionIDs(1, entries), TypeError);
        await assert.rejects(savePersonalPie(db, { categoryID: 1, userID: '1', expectedRevision: 0,
            entries: [{ conditionID: 1, weightBasisPoints: 10000 }], fallbackRules: [{ primaryConditionID: 1, mode: 'ordered', entries }] }), error => error.status === 400);
    }
});

test('newly scored versions cannot silently join an existing chain', () => {
    const entries = [{ conditionID: 3 }, { conditionID: 2 }];
    const model = models([[4, 100], [2, 95], [3, 0]])[0];
    assert.deepEqual(resolvedFamilyConditionIDs(1, entries), [1, 3, 2]);
    assert.equal(resolveFamilyScore(model, 1, entries).normalizedScore, 0);
    model.results.delete('3');
    assert.equal(resolveFamilyScore(model, 1, entries).normalizedScore, 95);
    model.results.delete('2');
    assert.equal(resolveFamilyScore(model, 1, entries).normalizedScore, null);
});

test('personal and public scoring preserve the exact ordered concrete chain in both modes', () => {
    const rule = { primaryConditionID: 1, entries: [{ conditionID: 3 }, { conditionID: 2 }], mode: 'ordered' };
    for (const scoreMode of ['range', 'available']) {
        const weights = [{ conditionID: 1, weightBasisPoints: 10000 }];
        for (const rules of [{ fallbackRules: [rule] }, { fallbackScope: 'public',
            familyComposition: [{ primaryConditionID: 1, families: [{ ...rule, familyID: 7, weightBasisPoints: 10000 }] }] }]) {
            const result = scoreModels(models([[2, 99], [3, 35]]), weights, 10000, { ...rules, scoreMode })[0];
            assert.equal(result.lower, 35);
            assert.deepEqual(result.fallbackResolutions[0].attemptedConditionIDs, [1, 3]);
            assert.deepEqual(result.calculationScores[0].familyConditionIDs, [1, 3, 2]);
        }
    }
});

test('concrete family storage round trips, while obsolete NULL members fail closed', async () => {
    const entries = [{ conditionID: 3 }, { conditionID: 2 }];
    const chainHash = createHash('sha256').update(familyKey(1, entries)).digest('hex');
    const rows = [];
    const db = { execute: async (sql, values) => {
        if (sql.startsWith('INSERT INTO benchmark_families')) return [{ insertId: 9 }];
        if (sql.startsWith('INSERT INTO benchmark_family_members')) {
            assert.deepEqual(values, [9, 1, 3, 9, 2, 2]);
            for (let index = 0; index < values.length; index += 3) rows.push({ family_ID: 9, primary_benchmark_condition_ID: 1,
                chain_hash: chainHash, position: values[index + 1], fallback_benchmark_condition_ID: values[index + 2] });
            return [{ affectedRows: 2 }];
        }
        return [rows];
    } };
    assert.equal(await ensureBenchmarkFamily(db, 1, entries), 9);
    assert.deepEqual(parseFamilyRows(rows)[0].entries, entries);
    rows[0].fallback_benchmark_condition_ID = null;
    assert.throws(() => parseFamilyRows(rows), error => error.body.error === 'benchmark_family_invariant_failed');
});

test('multiple undo and redo steps preserve explicit none versus community', () => {
    const history = createEditHistory();
    const states = [[], [{ primaryConditionID: 1, mode: 'ordered', entries: [] }],
        [{ primaryConditionID: 1, mode: 'ordered', entries: [{ conditionID: 2 }] }]].map(fallbackRules => ({ entries: [], fallbackRules }));
    history.record(states[0]); history.record(states[1]);
    assert.deepEqual(history.undo(states[2]), states[1]);
    assert.deepEqual(history.undo(states[1]), states[0]);
    assert.deepEqual(history.redo(states[0]), states[1]);
    assert.deepEqual(history.redo(states[1]), states[2]);
    history.undo(states[2]); history.record(states[1]);
    assert.equal(history.canRedo, false);
});
