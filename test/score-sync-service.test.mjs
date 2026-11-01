import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { validateScoreSyncRegistration, scoreSyncOutcome, registerScoreSync } from '../score-sync-service.js';
import { isTransactionConnectionDiscarded } from '../db-transaction.js';

const registration = { sourceKey: 'arena_official', intervalSeconds: 21600, operator: 'github:167495513', enabled: true };
test('only installed trusted adapters can be registered, never user URLs or scripts', () => {
    assert.deepEqual(validateScoreSyncRegistration(registration), registration);
    for (const sourceKey of ['https://example.com', '/tmp/script.js', 'toString', 'unknown']) {
        assert.throws(() => validateScoreSyncRegistration({ ...registration, sourceKey }), /Unregistered/);
    }
    for (const intervalSeconds of [0, 3599, 604801, 1.2]) assert.throws(() => validateScoreSyncRegistration({ ...registration, intervalSeconds }));
    assert.throws(() => validateScoreSyncRegistration({ ...registration, operator: '' }));
});
test('independent failures are partial failures, not successful silent skips', () => {
    assert.equal(scoreSyncOutcome([{ status: 'succeeded' }, { status: 'failed' }]), 'partial');
    assert.equal(scoreSyncOutcome([{ status: 'failed' }]), 'failed');
    assert.equal(scoreSyncOutcome([{ status: 'succeeded' }]), 'succeeded');
    assert.throws(() => scoreSyncOutcome([]));
    assert.throws(() => scoreSyncOutcome([{ status: 'skipped' }]));
});
test('registry changes and their operator audit commit together', async () => {
    const events = [];
    const connection = {
        async beginTransaction() { events.push('begin'); }, async commit() { events.push('commit'); }, async rollback() { events.push('rollback'); },
        async execute(sql, values) {
            events.push(sql);
            if (sql.startsWith('SELECT ID')) return [[{ ID: 1 }]];
            if (sql.startsWith('INSERT INTO score_sync_registry_events')) assert.deepEqual(JSON.parse(values[2]), registration);
            return [{ affectedRows: 1 }];
        }
    };
    assert.equal((await registerScoreSync(connection, registration)).ID, 1);
    assert.equal(events.at(-1), 'commit');
    connection.execute = async () => { throw new Error('Audit unavailable'); };
    await assert.rejects(registerScoreSync(connection, registration), /Audit unavailable/);
    assert.equal(events.at(-1), 'rollback');
});

function transactionFixture(faults = {}) {
    const state = { durable: { jobs: [], audits: [] }, pending: null, events: [] };
    const connection = {
        async beginTransaction() {
            state.events.push('begin'); state.pending = structuredClone(state.durable);
            if (faults.beginError) throw faults.beginError;
        },
        async execute(sql, values) {
            if (sql.startsWith('INSERT INTO score_sync_jobs')) {
                state.events.push('job'); state.pending.jobs.push({ ID: 1, sourceKey: values[0] });
            } else if (sql.startsWith('SELECT ID')) {
                state.events.push('select'); return [[{ ID: 1 }]];
            } else if (sql.startsWith('INSERT INTO score_sync_registry_events')) {
                state.events.push('audit');
                if (faults.operationError) throw faults.operationError;
                state.pending.audits.push({ jobID: values[0], operator: values[1], configuration: JSON.parse(values[2]) });
            } else assert.fail(`Unexpected SQL: ${sql}`);
            return [{ affectedRows: 1 }];
        },
        async commit() {
            state.events.push('commit');
            if (!faults.commitError || faults.commitApplied) { state.durable = state.pending; state.pending = null; }
            if (faults.commitError) throw faults.commitError;
        },
        async rollback() {
            state.events.push('rollback');
            if (faults.rollbackError) throw faults.rollbackError;
            if (faults.rollbackHang) return new Promise(() => {});
            state.pending = null;
        },
        destroy() {
            state.events.push('destroy'); state.pending = null;
            if (faults.destroyError) throw faults.destroyError;
        },
        release() { assert.fail('registration must not release the caller-owned connection'); },
        end() { assert.fail('registration must not end the caller-owned connection'); }
    };
    return { state, connection };
}

const operationError = message => Object.assign(new Error(message), {
    code: 'ER_TEST_OPERATION', status: 409, body: { error: 'registration_conflict' }
});

test('successful registration commits jobs and audit together without releasing the caller lease', async () => {
    const { connection, state } = transactionFixture();
    assert.deepEqual(await registerScoreSync(connection, registration), { ID: 1, ...registration });
    assert.deepEqual(state.events, ['begin', 'job', 'select', 'audit', 'commit']);
    assert.equal(state.durable.jobs.length, 1); assert.equal(state.durable.audits.length, 1);
    assert.deepEqual(state.durable.audits[0].configuration, registration);
    assert.equal(isTransactionConnectionDiscarded(connection), false);
});

test('invalid registration fails before touching the caller-owned connection', async () => {
    const { connection, state } = transactionFixture();
    for (const invalid of [{ ...registration, sourceKey: 'unknown' }, { ...registration, intervalSeconds: 0 },
        { ...registration, operator: '' }]) await assert.rejects(registerScoreSync(connection, invalid));
    assert.deepEqual(state.events, []);
    assert.equal(isTransactionConnectionDiscarded(connection), false);
});

test('begin acknowledgement failure is owned and preserves its original error even if destruction fails', async () => {
    const original = operationError('begin acknowledgement lost');
    const { connection, state } = transactionFixture({ beginError: original, destroyError: Error('destroy failed') });
    await assert.rejects(registerScoreSync(connection, registration), error => error === original);
    assert.equal(original.code, 'ER_TEST_OPERATION'); assert.equal(original.status, 409);
    assert.deepEqual(state.events, ['begin', 'destroy']);
    assert.ok(isTransactionConnectionDiscarded(connection));
    assert.deepEqual(state.durable, { jobs: [], audits: [] });
});

test('an audit error rolls back registration and retains the original operation error identity', async () => {
    const original = operationError('audit unavailable');
    const { connection, state } = transactionFixture({ operationError: original });
    await assert.rejects(registerScoreSync(connection, registration), error => error === original);
    assert.deepEqual(state.events, ['begin', 'job', 'select', 'audit', 'rollback']);
    assert.deepEqual(state.durable, { jobs: [], audits: [] });
    assert.equal(state.pending, null);
    assert.equal(isTransactionConnectionDiscarded(connection), false);
});

test('rollback and destruction failures cannot replace the original status, code or error object', async () => {
    const original = operationError('audit conflict'), body = original.body;
    const { connection, state } = transactionFixture({ operationError: original,
        rollbackError: Error('rollback failed'), destroyError: Error('destroy failed') });
    await assert.rejects(registerScoreSync(connection, registration), error => {
        assert.equal(error, original); assert.equal(error.code, 'ER_TEST_OPERATION');
        assert.equal(error.status, 409); assert.equal(error.body, body);
        return true;
    });
    assert.deepEqual(state.events, ['begin', 'job', 'select', 'audit', 'rollback', 'destroy']);
    assert.ok(isTransactionConnectionDiscarded(connection));
    assert.deepEqual(state.durable, { jobs: [], audits: [] });
});

test('rollback timeout is bounded to five seconds and rethrows the original operation error', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const original = operationError('audit conflict');
    const { connection, state } = transactionFixture({ operationError: original, rollbackHang: true });
    let settled = false;
    const pending = assert.rejects(registerScoreSync(connection, registration), error => {
        settled = true; return error === original && error.code === 'ER_TEST_OPERATION' && error.status === 409;
    });
    await new Promise(resolve => setImmediate(resolve));
    context.mock.timers.tick(4999);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false); assert.equal(isTransactionConnectionDiscarded(connection), false);
    context.mock.timers.tick(1); await pending;
    assert.ok(isTransactionConnectionDiscarded(connection));
    assert.deepEqual(state.events, ['begin', 'job', 'select', 'audit', 'rollback', 'destroy']);
    assert.deepEqual(state.durable, { jobs: [], audits: [] });
});

test('fatal operation failures discard the caller lease without attempting rollback', async () => {
    const original = Object.assign(operationError('connection lost'), { fatal: true });
    const { connection, state } = transactionFixture({ operationError: original });
    await assert.rejects(registerScoreSync(connection, registration), error => error === original);
    assert.deepEqual(state.events, ['begin', 'job', 'select', 'audit', 'destroy']);
    assert.ok(isTransactionConnectionDiscarded(connection));
});

test('commit failure and acknowledgement loss both discard and reject without rollback or false success', async () => {
    for (const commitApplied of [false, true]) {
        const original = operationError('commit acknowledgement lost');
        const { connection, state } = transactionFixture({ commitError: original, commitApplied });
        await assert.rejects(registerScoreSync(connection, registration), error => error === original);
        assert.deepEqual(state.events, ['begin', 'job', 'select', 'audit', 'commit', 'destroy']);
        assert.ok(isTransactionConnectionDiscarded(connection));
        assert.equal(state.durable.jobs.length, commitApplied ? 1 : 0);
        assert.equal(state.durable.audits.length, commitApplied ? 1 : 0);
        assert.equal(state.pending, null);
    }
});

test('worker registration is operator-only and runtime uses no user-provided shell command', () => {
    const registrationScript = fs.readFileSync(new URL('../scripts/register-score-sync.mjs', import.meta.url), 'utf8');
    const runner = fs.readFileSync(new URL('../scripts/run-score-sync.mjs', import.meta.url), 'utf8');
    assert.match(registrationScript, /process.getuid\(\) !== 0/);
    assert.match(runner, /spawnSync\(process.execPath/);
    assert.doesNotMatch(runner, /shell:\s*true|eval\(|officialSyncURL/);
    assert.match(runner, /GET_LOCK/);
    assert.match(runner, /process.exitCode = 1/);
});
