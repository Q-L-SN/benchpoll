import assert from 'node:assert/strict';
import test from 'node:test';
import {
    applyCleanup, assertLegacyBenchmarkCleanupCompatible, loadSummary,
    normalizedRemainingWeights, parseCleanupOptions
} from '../scripts/delete-benchmarks-before-id.mjs';

function cleanupConnection({ tables = [], migrateDuringTransaction = false, metadataError = null, benchmarkCount = 1 } = {}) {
    const calls = [];
    let inTransaction = false;
    return {
        calls,
        async execute(sql, params = []) {
            calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
            if (sql.includes('information_schema.TABLES')) {
                if (metadataError) throw metadataError;
                const current = migrateDuringTransaction && inTransaction ? ['personal_pie_topic_weights'] : tables;
                return [current.map(name => ({ name }))];
            }
            if (sql.includes('AS benchmarkCount')) return [[{
                benchmarkCount, conditionCount: benchmarkCount, resultCount: 0, weightCount: 0
            }]];
            if (sql.includes('AS affectedPieCount')) return [[{
                affectedPieCount: 0, emptyPieCount: null, normalizedPieCount: null
            }]];
            throw new Error('Unexpected cleanup data access: ' + sql);
        },
        async beginTransaction() { calls.push({ sql: 'BEGIN' }); inTransaction = true; },
        async commit() { calls.push({ sql: 'COMMIT' }); inTransaction = false; },
        async rollback() { calls.push({ sql: 'ROLLBACK' }); inTransaction = false; }
    };
}

for (const table of ['topic_scenes', 'personal_pie_topic_weights', 'topic_reference_lock']) {
    for (const [mode, run] of [['dry run', loadSummary], ['apply', applyCleanup]]) {
        test(`${mode} refuses even an empty ${table} before summary, backup or writes`, async () => {
            const connection = cleanupConnection({ tables: [table] });
            await assert.rejects(run(connection, 100), error => {
                assert.equal(error.code, 'UNSUPPORTED_TOPIC_REFERENCE_CLEANUP');
                assert.ok(error.message.includes(table));
                assert.match(error.message, /No benchmarks or weights were changed/);
                return true;
            });
            assert.equal(connection.calls.length, 1);
            assert.match(connection.calls[0].sql, /^SELECT .* information_schema\.TABLES /);
        });
    }
}

test('metadata errors fail closed before starting cleanup', async () => {
    const error = new Error('Metadata access denied');
    const connection = cleanupConnection({ metadataError: error });
    await assert.rejects(applyCleanup(connection, 100), candidate => candidate === error);
    assert.equal(connection.calls.length, 1);
});

test('a new schema appearing before the transaction is rejected and rolled back before data access', async () => {
    const connection = cleanupConnection({ migrateDuringTransaction: true });
    await assert.rejects(applyCleanup(connection, 100), { code: 'UNSUPPORTED_TOPIC_REFERENCE_CLEANUP' });
    const begin = connection.calls.findIndex(call => call.sql === 'BEGIN');
    assert.ok(begin > 0);
    assert.equal(connection.calls[begin + 1].sql.includes('information_schema.TABLES'), true);
    assert.deepEqual(connection.calls.slice(begin + 2), [{ sql: 'ROLLBACK' }]);
    assert.equal(connection.calls.some(call => /^(DELETE|UPDATE|INSERT|COMMIT)\b/.test(call.sql)), false);
});

test('the legacy schema keeps its dry-run counts and zero-work behavior', async () => {
    const connection = cleanupConnection({ benchmarkCount: 0 });
    await assertLegacyBenchmarkCleanupCompatible(connection);
    const summary = await loadSummary(connection, 100);
    assert.deepEqual(summary, {
        benchmarkCount: 0, conditionCount: 0, resultCount: 0, weightCount: 0,
        affectedPieCount: 0, emptyPieCount: 0, normalizedPieCount: 0
    });
    assert.deepEqual(await applyCleanup(connection, 100), { ...summary, deletedBenchmarks: 0, backupPath: null });
    assert.equal(connection.calls.some(call => call.sql === 'BEGIN'), false);
});

test('legacy weight normalization still uses exact largest remainders with stable ties', () => {
    const weights = normalizedRemainingWeights([3, 1, 2].map(ID => ({
        benchmark_condition_ID: ID, weight_basis_points: 2000
    })));
    assert.deepEqual(weights.map(row => [row.conditionID, row.weightBasisPoints]), [[3, 3333], [1, 3334], [2, 3333]]);
    assert.equal(weights.reduce((total, row) => total + row.weightBasisPoints, 0), 10000);
    assert.deepEqual(normalizedRemainingWeights([]), []);
    assert.throws(() => normalizedRemainingWeights([{ benchmark_condition_ID: 1, weight_basis_points: 0 }]), /invalid source total/);
});

test('CLI still requires a positive ID and the matching destructive confirmation', () => {
    for (const value of ['', '0', '-1', '1.5', 'NaN', '9007199254740992']) {
        assert.throws(() => parseCleanupOptions([`--before-id=${value}`]), /positive integer/);
    }
    assert.deepEqual(parseCleanupOptions(['--before-id=100']), { apply: false, beforeID: 100 });
    assert.throws(() => parseCleanupOptions(['--before-id=100', '--apply']), /--confirm=/);
    assert.throws(() => parseCleanupOptions(['--before-id=100', '--apply', '--confirm=delete-benchmarks-before-99']), /--confirm=/);
    assert.deepEqual(parseCleanupOptions(['--before-id=100', '--apply', '--confirm=delete-benchmarks-before-100']), {
        apply: true, beforeID: 100
    });
});
