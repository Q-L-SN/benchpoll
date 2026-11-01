import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupCases, cleanupFailures, runCleanupProbe } from '../scripts/review-transaction-cleanup-20261008.mjs';
import { startTransactionConnection, commitTransactionConnection, rollbackTransactionConnection,
    releaseTransactionConnection, destroyTransactionConnection, isTransactionConnectionDiscarded } from '../db-transaction.js';
import { createPrivateCategory } from '../private-category-service.js';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as transactionCleanup from '../db-transaction.js';
import { createWriteRouteHarness } from '../scripts/review-write-replay-20261008.mjs';

for (const scenario of cleanupCases) for (const failure of cleanupFailures) for (let repetition = 1; repetition <= 2; repetition++) {
    test(`${scenario}: ${failure} preserves the original error and discards the lease (${repetition})`, async () => {
        const result = await runCleanupProbe({ scenario, failure });
        assert.equal(result.passed, true, JSON.stringify(result));
        assert.equal(result.destroyed, 1);
    });
}

function fixture(overrides = {}) {
    const events = [];
    const connection = {
        async beginTransaction() { events.push('begin'); },
        async query(sql) { events.push(sql); },
        async commit() { events.push('commit'); },
        async rollback() { events.push('rollback'); },
        release() { events.push('release'); },
        destroy() { events.push('destroy'); },
        ...overrides
    };
    return { events, connection };
}

async function quiet(work) {
    const logger = console.error;
    console.error = () => {};
    try { return await work(); } finally { console.error = logger; }
}

test('successful write and snapshot transactions retain their SQL lifecycle', async () => {
    for (const readOnlySnapshot of [false, true]) {
        const { events, connection } = fixture();
        await startTransactionConnection(connection, 'TEST', { readOnlySnapshot });
        await commitTransactionConnection(connection, 'TEST');
        releaseTransactionConnection(connection, 'TEST');
        assert.deepEqual(events, readOnlySnapshot
            ? ['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY', 'commit', 'release']
            : ['begin', 'commit', 'release']);
        assert.equal(isTransactionConnectionDiscarded(connection), false);
    }
});

test('ordinary operation failure rolls back before returning the clean lease', async () => {
    const { events, connection } = fixture();
    assert.equal(await rollbackTransactionConnection(connection, 'TEST', new Error('work')), true);
    releaseTransactionConnection(connection, 'TEST');
    assert.deepEqual(events, ['rollback', 'release']);
});

for (const phase of ['begin', 'snapshot SET', 'snapshot START', 'commit']) test(`${phase} failure discards the lease before any cleanup can replace it`, async () => {
    const original = new Error('operation');
    const { events, connection } = fixture({
        async beginTransaction() { throw original; },
        async query(sql) { if (sql.includes(phase === 'snapshot SET' ? 'SET TRANSACTION' : 'START TRANSACTION')) throw original; },
        async commit() { throw original; }
    });
    await assert.rejects(phase === 'commit' ? commitTransactionConnection(connection, 'TEST')
        : startTransactionConnection(connection, 'TEST', { readOnlySnapshot: phase.startsWith('snapshot') }), error => error === original);
    assert.equal(await rollbackTransactionConnection(connection, 'TEST', original), false);
    releaseTransactionConnection(connection, 'TEST');
    destroyTransactionConnection(connection, 'TEST');
    assert.deepEqual(events, ['destroy']);
});

for (const original of [Object.assign(new Error('fatal'), { fatal: true }),
    Object.assign(new Error('query timeout'), { code: 'PROTOCOL_SEQUENCE_TIMEOUT' }),
    Object.assign(new Error('abort'), { name: 'AbortError' }),
    Object.assign(new Error('timeout'), { name: 'TimeoutError' })]) test(`unusable ${original.message} connections never queue a rollback`, async () => {
    const { events, connection } = fixture();
    assert.equal(await rollbackTransactionConnection(connection, 'TEST', original), false);
    releaseTransactionConnection(connection, 'TEST');
    assert.deepEqual(events, ['destroy']);
});

test('rollback timeout is bounded and a late rollback rejection is handled', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let rejectRollback;
    const { events, connection } = fixture({ rollback: () => new Promise((_, reject) => { rejectRollback = reject; }) });
    await quiet(async () => {
        const pending = rollbackTransactionConnection(connection, 'TEST', new Error('original'));
        t.mock.timers.tick(5000);
        assert.equal(await pending, false);
        rejectRollback(new Error('late failure'));
        await Promise.resolve();
    });
    releaseTransactionConnection(connection, 'TEST');
    assert.deepEqual(events, ['destroy']);
});

test('destroy and logging failures cannot defeat the discarded marker', async () => {
    const connection = { async rollback() { throw new Error('rollback'); },
        destroy() { throw new Error('destroy'); }, release() { assert.fail('Discarded lease cannot be released'); } };
    const logger = console.error;
    console.error = () => { throw new Error('logger'); };
    try {
        assert.equal(await rollbackTransactionConnection(connection, 'TEST', new Error('original')), false);
        assert.equal(isTransactionConnectionDiscarded(connection), true);
        releaseTransactionConnection(connection, 'TEST');
        destroyTransactionConnection(connection, 'TEST');
    } finally { console.error = logger; }
});

test('release failure after a confirmed commit does not turn success into a retryable error', async () => {
    const { events, connection } = fixture({ release() { events.push('release'); throw new Error('release'); } });
    await commitTransactionConnection(connection, 'TEST');
    await quiet(() => releaseTransactionConnection(connection, 'TEST'));
    assert.deepEqual(events, ['commit', 'release', 'destroy']);
});

test('duplicate-name translation survives failed rollback and preserves its public status', async () => {
    const duplicate = Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
    const { connection, events } = fixture({ async execute() { throw duplicate; },
        async rollback() { throw new Error('rollback'); } });
    await quiet(() => assert.rejects(createPrivateCategory({ getConnection: async () => connection }, '1', {
        name: 'Mine', description: 'My personal benchmark comparison.' }),
        error => error.status === 409 && error.body.error === 'private_category_name_exists'));
    assert.deepEqual(events, ['begin', 'destroy']);
});

test('a throwing native release listener cannot destroy a lease transferred to another borrower', async () => {
    const pool = new EventEmitter(), core = { _pool: pool };
    let transferred = false, destroys = 0;
    pool.on('release', released => {
        assert.equal(released, core); transferred = true; throw new Error('listener');
    });
    const connection = { connection: core, release: () => pool.emit('release', core), destroy: () => { destroys++; } };
    await quiet(() => releaseTransactionConnection(connection, 'TEST'));
    assert.equal(transferred, true); assert.equal(destroys, 0);
    assert.equal(isTransactionConnectionDiscarded(connection), true);
    destroyTransactionConnection(connection, 'TEST'); releaseTransactionConnection(connection, 'TEST');
    assert.equal(destroys, 0); assert.equal(pool.listenerCount('release'), 1);
});

test('actual moderation rollback wrapper bounds a hanging rollback and discards without failure-audit reuse', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
    const { events, connection } = fixture({ rollback: () => new Promise(() => {}) });
    const context = vm.createContext({ ...transactionCleanup, connection, console });
    const from = source.indexOf('async function rollbackModerationConnection(');
    vm.runInContext(source.slice(from, source.indexOf('async function persistFailedModerationAction(', from)), context);
    await quiet(async () => {
        const pending = vm.runInContext("rollbackModerationConnection(connection, 'TEST', new Error('original'))", context);
        t.mock.timers.tick(5000);
        assert.equal(await pending, false);
    });
    releaseTransactionConnection(connection, 'TEST');
    assert.deepEqual(events, ['destroy']);
});

for (const route of ['submit_contribution', 'send_admin_message']) test(`actual ${route} retains committed success when release alone fails`, async () => {
    const harness = await createWriteRouteHarness({ route, releaseFailure: true });
    const body = route === 'submit_contribution' ? { type: 'feedback', details: 'Isolated feedback intent.', pageURL: '' }
        : { body: 'Isolated reviewer message intent.' };
    const response = await quiet(() => harness.invoke({ ...body, expectedUserID: '1' }, '2535c09f-f7ac-4f02-8f79-45ffda82fefe'));
    assert.equal(response.status, route === 'submit_contribution' ? 204 : 200);
    assert.equal(harness.summary().recordCount, 1);
});
