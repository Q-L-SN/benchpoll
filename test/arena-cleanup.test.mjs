import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { cleanupArenaImportConnection, publishArenaBatch } from '../arena-sync.js';
import { ArenaSyncConflictError, persistArenaSyncConflicts } from '../arena-sync-conflicts.js';
import { destroyTransactionConnection, isTransactionConnectionDiscarded } from '../db-transaction.js';

const batch = () => ({ snapshot: { revision: 'a'.repeat(40), expectedConfigs: ['text'] },
    sourceModifiedAt: '2026-10-01T00:00:00.000Z', contentHash: 'b'.repeat(64),
    plan: { entries: [{}] }, feedDates: new Map([['text/overall', '2026-10-01']]) });
const conflict = { rowKey: 'a'.repeat(64), resultID: 1, incomingHash: 'b'.repeat(64),
    incomingRow: { model_name: 'Synthetic' }, config: 'text', category: 'overall' };
const failure = (message, code = 'TEST_FAILURE') => Object.assign(new Error(message), { code });
const drain = () => new Promise(resolve => setImmediate(resolve));

class Store {
    constructor() {
        this.durable = { batches: [], currentID: null, feeds: {}, scores: [{ score: 1300, status: 'accepted' }], conflicts: [] };
        this.events = [];
    }
    connect(name, faults = {}) { return new Connection(this, name, faults); }
}

class Connection {
    constructor(store, name, faults) {
        Object.assign(this, { store, name, faults, transaction: null, destroyed: false, ended: false });
    }
    get state() { return this.transaction ?? this.store.durable; }
    event(action) { this.store.events.push(`${this.name}:${action}`); }
    usable() { assert.equal(this.destroyed || this.ended, false, 'discarded connections must never receive commands'); }
    async execute(sql, parameters) {
        this.usable();
        if (sql.startsWith('INSERT INTO arena_sync_batches')) {
            this.event('create-batch');
            const ID = this.state.batches.length + 1;
            this.state.batches.push({ ID, status: 'running', source_revision: parameters[0], source_modified_at: parameters[1],
                snapshot_hash: parameters[2], summary: JSON.parse(parameters[3]) });
            return [{ insertId: ID, affectedRows: 1 }];
        }
        if (sql.startsWith('UPDATE arena_sync_batches')) {
            const failed = sql.includes("status='failed'");
            this.event(failed ? 'failure-marker' : 'success-marker');
            if (failed && this.faults.markerError) throw this.faults.markerError;
            if (failed && this.faults.markerHang) return new Promise(() => {});
            assert.match(sql, /status='running'/);
            const row = this.state.batches.find(row => row.ID === parameters[1]);
            if (!row || row.status !== 'running' || failed && this.faults.markerNoop) return [{ affectedRows: 0 }];
            if (failed) {
                assert.equal(this.transaction, null, 'failure markers must be durable autocommit writes');
                row.status = 'failed'; row.error_message = parameters[0];
            } else { row.status = 'succeeded'; row.summary = JSON.parse(parameters[0]); }
            return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('SELECT status FROM arena_sync_batches')) {
            this.event('batch-status');
            return [[...this.state.batches.filter(row => row.ID === parameters[0])]];
        }
        if (sql.startsWith('INSERT INTO arena_sync_feed_state')) {
            this.state.feeds[parameters[0]] = parameters[1];
            return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('INSERT INTO arena_sync_state')) {
            this.state.currentID = parameters[0];
            return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('INSERT INTO arena_sync_conflicts')) {
            this.event('conflict');
            if (this.faults.conflictError) throw this.faults.conflictError;
            this.state.conflicts.push({ row_key: parameters[0], result_ID: parameters[1] });
            return [{ affectedRows: 1 }];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
    }
    async query(sql, parameters = []) {
        this.usable();
        if (sql.includes('RELEASE_LOCK')) {
            this.event('release-lock');
            if (this.faults.releaseError) throw this.faults.releaseError;
            if (this.faults.releaseHang) return new Promise(() => {});
            return [[{ released: 1 }]];
        }
        assert.match(sql, /JOIN arena_sync_batches/);
        const IDs = sql.includes('arena_sync_feed_state') ? parameters[0].map(config => this.state.feeds[config]) : [this.state.currentID];
        return [[...this.state.batches.filter(row => IDs.includes(row.ID))]];
    }
    async beginTransaction() {
        this.usable(); this.event('begin');
        assert.equal(this.transaction, null, 'transactions must never nest');
        this.transaction = structuredClone(this.store.durable);
        if (this.faults.beginError) throw this.faults.beginError;
    }
    async commit() {
        this.usable(); this.event('commit');
        if (!this.faults.commitError || this.faults.commitApplied) {
            this.store.durable = this.transaction; this.transaction = null;
        }
        if (this.faults.commitError) throw this.faults.commitError;
    }
    async rollback() {
        this.usable(); this.event('rollback');
        const rollbackError = this.faults.rollbackErrors?.shift() ?? this.faults.rollbackError;
        if (rollbackError) throw rollbackError;
        if (this.faults.rollbackHang) return new Promise(() => {});
        this.transaction = null;
    }
    destroy() { this.event('destroy'); this.destroyed = true; this.transaction = null; }
    async end() {
        this.usable(); this.event('end');
        if (this.faults.endError) throw this.faults.endError;
        if (this.faults.endHang) return new Promise(() => {});
        this.ended = true; this.transaction = null;
    }
}

const failedWork = (connection, error) => async () => {
    connection.state.scores[0].status = 'superseded';
    throw error;
};

test('a confirmed rollback precedes the durable failure marker without borrowing another lease', async () => {
    const store = new Store(), connection = store.connect('publication'), original = failure('writer failed');
    await assert.rejects(publishArenaBatch(connection, batch(), failedWork(connection, original), {
        recoveryConnectionFactory() { assert.fail('a clean original lease needs no nested borrow'); }
    }), error => error === original);
    assert.equal(store.durable.batches[0].status, 'failed');
    assert.equal(store.durable.batches[0].error_message, original.message);
    assert.equal(store.durable.scores[0].status, 'accepted');
    assert.equal(store.durable.currentID, null);
    assert.deepEqual(store.durable.feeds, {});
    assert.ok(store.events.indexOf('publication:rollback') < store.events.indexOf('publication:failure-marker'));
});

test('rollback failure destroys the old lease before borrowing and durably logs on the clean recovery lease', async () => {
    const store = new Store(), original = failure('writer failed'), rollbackError = failure('rollback failed');
    const connection = store.connect('publication', { rollbackError });
    let recovery;
    await assert.rejects(publishArenaBatch(connection, batch(), failedWork(connection, original), {
        recoveryConnectionFactory() {
            assert.ok(isTransactionConnectionDiscarded(connection));
            assert.equal(connection.destroyed, true, 'a one-slot lease is freed before recovery acquisition');
            recovery = store.connect('recovery'); return recovery;
        }
    }), error => error instanceof AggregateError && error.cause === original
        && error.errors[0] === original && error.errors[1] === rollbackError);
    assert.equal(store.durable.batches[0].status, 'failed');
    assert.equal(store.durable.scores[0].status, 'accepted');
    assert.equal(store.durable.currentID, null);
    assert.deepEqual(store.durable.feeds, {});
    assert.equal(recovery.destroyed, true);
    assert.equal(store.events.filter(event => event === 'publication:failure-marker').length, 0);
    assert.ok(store.events.indexOf('publication:destroy') < store.events.indexOf('recovery:failure-marker'));
});

test('uncertain rollback without a recovery factory never touches the discarded lease', async () => {
    const store = new Store(), original = failure('writer failed');
    const connection = store.connect('publication', { rollbackError: failure('rollback failed') });
    await assert.rejects(publishArenaBatch(connection, batch(), failedWork(connection, original)),
        error => error.cause === original && error.errors.some(error => /clean connection factory/.test(error.message)));
    assert.equal(store.durable.batches[0].status, 'running');
    assert.equal(store.events.some(event => event.endsWith('failure-marker')), false);
});

test('a recovery factory cannot return the original discarded lease', async () => {
    const store = new Store(), original = failure('writer failed');
    const connection = store.connect('publication', { rollbackError: failure('rollback failed') });
    await assert.rejects(publishArenaBatch(connection, batch(), failedWork(connection, original), {
        recoveryConnectionFactory: () => connection
    }), error => error.cause === original && error.errors.some(error => /did not receive a clean connection/.test(error.message)));
    assert.equal(store.events.some(event => event.endsWith('failure-marker')), false);
    assert.equal(store.events.filter(event => event === 'publication:destroy').length, 1);
});

test('begin acknowledgement failure is owned, discarded and recovered without executing score work', async () => {
    const store = new Store(), original = failure('begin acknowledgement lost');
    const connection = store.connect('publication', { beginError: original });
    await assert.rejects(publishArenaBatch(connection, batch(), async () => { assert.fail('begin failed'); }, {
        recoveryConnectionFactory: () => store.connect('recovery')
    }), error => error === original);
    assert.ok(isTransactionConnectionDiscarded(connection));
    assert.equal(store.events.includes('publication:rollback'), false);
    assert.equal(store.durable.batches[0].status, 'failed');
    assert.equal(store.durable.scores[0].status, 'accepted');
});

test('commit failure and commit-ack loss both reject, but an already succeeded batch is never overwritten', async () => {
    for (const commitApplied of [false, true]) {
        const store = new Store(), original = failure('commit acknowledgement lost');
        const connection = store.connect('publication', { commitError: original, commitApplied });
        await assert.rejects(publishArenaBatch(connection, batch(), async () => {
            connection.state.scores[0].status = 'superseded';
            connection.state.scores.push({ score: 1400, status: 'accepted' });
            return { insertedResults: 1 };
        }, { recoveryConnectionFactory: () => store.connect('recovery') }), error => error === original);
        assert.ok(isTransactionConnectionDiscarded(connection));
        assert.equal(store.events.includes('publication:rollback'), false);
        assert.equal(store.durable.batches[0].status, commitApplied ? 'succeeded' : 'failed');
        assert.equal(store.durable.currentID, commitApplied ? 1 : null);
        assert.deepEqual(store.durable.feeds, commitApplied ? { text: 1 } : {});
        assert.deepEqual(store.durable.scores.filter(row => row.status === 'accepted').map(row => row.score), [commitApplied ? 1400 : 1300]);
        if (commitApplied) assert.equal(store.durable.batches[0].error_message, undefined);
    }
});

test('recovery only logs its batch and cannot persist stale conflicts after losing the advisory lock', async () => {
    const store = new Store(), original = new ArenaSyncConflictError([conflict]);
    const connection = store.connect('publication', { rollbackError: failure('rollback failed') });
    await assert.rejects(publishArenaBatch(connection, batch(), failedWork(connection, original), {
        recoveryConnectionFactory: () => store.connect('recovery')
    }), error => error.cause === original);
    assert.equal(store.durable.batches[0].status, 'failed');
    assert.deepEqual(store.durable.conflicts, []);
    assert.equal(store.events.some(event => event.endsWith(':conflict')), false);
});

test('factory or recovery-write failures preserve the publication and rollback causes', async () => {
    for (const stage of ['factory', 'marker']) {
        const store = new Store(), original = failure('writer failed'), rollbackError = failure('rollback failed');
        const recoveryError = failure(`${stage} unavailable`);
        const connection = store.connect('publication', { rollbackError });
        let recovery;
        await assert.rejects(publishArenaBatch(connection, batch(), failedWork(connection, original), {
            recoveryConnectionFactory() {
                assert.ok(isTransactionConnectionDiscarded(connection));
                if (stage === 'factory') throw recoveryError;
                recovery = store.connect('recovery', { markerError: recoveryError }); return recovery;
            }
        }), error => error.cause === original
            && error.errors[0] === original && error.errors[1] === rollbackError && error.errors[2] === recoveryError);
        assert.equal(store.durable.batches[0].status, 'running');
        assert.equal(store.durable.scores[0].status, 'accepted');
        if (recovery) assert.equal(recovery.destroyed, true);
    }
});

test('a failure marker that was not written cannot make recovery appear successful', async () => {
    const store = new Store(), original = failure('writer failed');
    const connection = store.connect('publication', { markerNoop: true });
    await assert.rejects(publishArenaBatch(connection, batch(), failedWork(connection, original)),
        error => error.cause === original && error.errors.some(error => /failure marker was not written/.test(error.message)));
    assert.equal(store.durable.batches[0].status, 'running');
});

test('conflict persistence preserves the insertion cause alongside its rollback failure', async () => {
    const store = new Store(), original = failure('conflict write failed'), rollbackError = failure('conflict rollback failed');
    const connection = store.connect('conflicts', { conflictError: original, rollbackError });
    await assert.rejects(persistArenaSyncConflicts(connection, [conflict], 'a'.repeat(40)),
        error => error instanceof AggregateError && error.cause === original
            && error.errors[0] === original && error.errors[1] === rollbackError);
    assert.ok(isTransactionConnectionDiscarded(connection));
    assert.deepEqual(store.durable.conflicts, []);
});

test('publication retains nested conflict-persistence causes while its failure marker stays durable', async () => {
    const store = new Store(), original = new ArenaSyncConflictError([conflict]);
    const conflictError = failure('conflict write failed'), rollbackError = failure('conflict rollback failed');
    const connection = store.connect('publication', { conflictError, rollbackErrors: [null, rollbackError] });
    await assert.rejects(publishArenaBatch(connection, batch(), failedWork(connection, original)), error => {
        assert.equal(error.cause, original); assert.equal(error.errors[0], original);
        const queueError = error.errors[1];
        assert.ok(queueError instanceof AggregateError);
        assert.equal(queueError.cause, conflictError);
        assert.deepEqual(queueError.errors, [conflictError, rollbackError]);
        return true;
    });
    assert.ok(isTransactionConnectionDiscarded(connection));
    assert.equal(store.durable.batches[0].status, 'failed');
    assert.equal(store.durable.scores[0].status, 'accepted');
    assert.deepEqual(store.durable.conflicts, []);
});

test('conflict begin and commit failures discard the lease without masking their original error', async () => {
    for (const stage of ['begin', 'commit']) {
        const store = new Store(), original = failure(`${stage} failed`);
        const connection = store.connect('conflicts', { [`${stage}Error`]: original });
        await assert.rejects(persistArenaSyncConflicts(connection, [conflict], 'a'.repeat(40)), error => error === original);
        assert.ok(isTransactionConnectionDiscarded(connection));
        assert.equal(store.events.includes('conflicts:rollback'), false);
        assert.deepEqual(store.durable.conflicts, []);
    }
});

test('rollback timeout discards before recovery and preserves the publication cause', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const store = new Store(), original = failure('writer failed');
    const connection = store.connect('publication', { rollbackHang: true });
    const pending = assert.rejects(publishArenaBatch(connection, batch(), failedWork(connection, original), {
        recoveryConnectionFactory() {
            assert.ok(isTransactionConnectionDiscarded(connection)); return store.connect('recovery');
        }
    }), error => error.cause === original && error.errors.some(error => /rollback could not be confirmed/.test(error.message)));
    await drain(); context.mock.timers.tick(5000); await pending;
    assert.equal(store.durable.batches[0].status, 'failed');
    assert.equal(store.durable.scores[0].status, 'accepted');
});

test('recovery acquisition is bounded and a late connection is discarded without receiving writes', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const store = new Store(), original = failure('writer failed');
    const connection = store.connect('publication', { rollbackError: failure('rollback failed') });
    let resolveRecovery;
    const pending = assert.rejects(publishArenaBatch(connection, batch(), failedWork(connection, original), {
        recoveryConnectionFactory: () => new Promise(resolve => { resolveRecovery = resolve; })
    }), error => error.cause === original && error.errors.some(error => /recovery timed out/.test(error.message)));
    await drain(); context.mock.timers.tick(5000); await pending;
    const late = store.connect('late'); resolveRecovery(late); await drain();
    assert.ok(isTransactionConnectionDiscarded(late));
    assert.equal(store.durable.batches[0].status, 'running');
    assert.deepEqual(store.events.filter(event => event.startsWith('late:')), ['late:destroy']);
});

test('recovery marker writes are bounded and their lease is discarded on timeout', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const store = new Store(), original = failure('writer failed');
    const connection = store.connect('publication', { rollbackError: failure('rollback failed') });
    const recovery = store.connect('recovery', { markerHang: true });
    const pending = assert.rejects(publishArenaBatch(connection, batch(), failedWork(connection, original), {
        recoveryConnectionFactory: () => recovery
    }), error => error.cause === original && error.errors.some(error => /recovery timed out/.test(error.message)));
    await drain(); context.mock.timers.tick(5000); await pending;
    assert.ok(isTransactionConnectionDiscarded(recovery));
    assert.equal(store.durable.batches[0].status, 'running');
});

test('caller cleanup skips lock release and end on a previously discarded lease', async () => {
    const store = new Store(), connection = store.connect('publication');
    destroyTransactionConnection(connection, 'Test discarded caller');
    await cleanupArenaImportConnection(connection, { lockName: 'arena-test', originalError: failure('writer failed') });
    assert.deepEqual(store.events, ['publication:destroy']);
});

test('caller cleanup always attempts end and preserves original, lock-release and end errors', async () => {
    const store = new Store(), original = failure('writer failed');
    const releaseError = failure('release failed'), endError = failure('end failed');
    const connection = store.connect('publication', { releaseError, endError });
    await assert.rejects(cleanupArenaImportConnection(connection, { lockName: 'arena-test', originalError: original }),
        error => error.cause === original && error.errors[0] === original
            && error.errors[1] === releaseError && error.errors[2] === endError);
    assert.deepEqual(store.events, ['publication:release-lock', 'publication:end', 'publication:destroy']);
});

test('caller cleanup on success closes normally, and cleanup-only failures still reject', async () => {
    const store = new Store(), connection = store.connect('publication');
    await cleanupArenaImportConnection(connection, { lockName: 'arena-test' });
    assert.deepEqual(store.events, ['publication:release-lock', 'publication:end']);
    const endError = failure('end failed'), failed = store.connect('failed', { endError });
    await assert.rejects(cleanupArenaImportConnection(failed), error => error === endError);
    assert.ok(isTransactionConnectionDiscarded(failed));
});

test('caller cleanup timeout discards the lease and retains the original error', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    for (const stage of ['release', 'end']) {
        const store = new Store(), original = failure('writer failed');
        const connection = store.connect('publication', { [`${stage}Hang`]: true });
        const pending = assert.rejects(cleanupArenaImportConnection(connection, { lockName: 'arena-test', originalError: original }),
            error => error.cause === original && error.errors.some(error => /cleanup timed out/.test(error.message)));
        await drain(); context.mock.timers.tick(5000); await pending;
        assert.ok(isTransactionConnectionDiscarded(connection));
        assert.deepEqual(store.events, stage === 'release'
            ? ['publication:release-lock', 'publication:destroy']
            : ['publication:release-lock', 'publication:end', 'publication:destroy']);
    }
});

test('the actual CLI wires a dedicated recovery connection and preserves failure after destroying its old connection', () => {
    const scriptURL = new URL('../scripts/import-arena-latest.mjs', import.meta.url).href;
    const arenaURL = new URL('../arena-sync.js', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { readFile } from 'node:fs/promises';
        import { SourceTextModule, SyntheticModule } from 'node:vm';
        import * as path from 'node:path';
        const arena = await import(${JSON.stringify(arenaURL)});
        const original = Error('Synthetic writer failure'), rollback = Error('Synthetic rollback failure');
        const events = [], output = [], durable = { batch: null }, leases = [];
        const createConnection = async options => {
            assert.equal(options.connectTimeout, 5000);
            const recovery = leases.length === 1;
            if (recovery) assert.equal(leases[0].destroyed, true);
            const connection = {
                destroyed: false,
                async query(sql) {
                    assert.equal(this.destroyed, false);
                    if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
                    if (sql.includes('JOIN arena_sync_batches')) return [[]];
                    if (sql.includes('SELECT a.row_key')) throw original;
                    throw Error('Unexpected query or cleanup on discarded connection');
                },
                async execute(sql) {
                    assert.equal(this.destroyed, false);
                    if (sql.startsWith('INSERT INTO arena_sync_batches')) {
                        durable.batch = { ID: 1, status: 'running' }; return [{ insertId: 1 }];
                    }
                    if (sql.startsWith('UPDATE arena_sync_batches')) {
                        assert.equal(recovery, true); assert.match(sql, /status='running'/);
                        durable.batch.status = 'failed'; return [{ affectedRows: 1 }];
                    }
                    throw Error('Unexpected execute');
                },
                async beginTransaction() { events.push('begin'); },
                async rollback() { throw rollback; },
                destroy() { this.destroyed = true; events.push(recovery ? 'recovery-destroy' : 'publication-destroy'); },
                async end() { assert.fail('discarded standalone connections must not be ended again'); }
            };
            leases.push(connection); return connection;
        };
        const rows = [{ model_name: 'Synthetic', organization: 'openai', category: 'overall', rating: 1300,
            leaderboard_publish_date: '2026-10-01' }];
        const snapshot = { schemaVersion: arena.ARENA_SNAPSHOT_VERSION, source: arena.ARENA_DATASET_URL, license: 'CC-BY-4.0',
            revision: 'a'.repeat(40), sourceModifiedAt: '2026-10-01T00:00:00.000Z', fetchedAt: '2026-10-03T00:00:00.000Z',
            expectedConfigs: ['text'], configs: [{ config: 'text', rows,
                checksums: [{ filename: 'synthetic.parquet', sha256: 'b'.repeat(64), rows: 1, size: 1 }] }] };
        const modules = {
            'dotenv/config': {}, 'node:fs/promises': { readFile: async () => JSON.stringify(snapshot) }, 'node:path': path,
            'mysql2/promise': { default: { createConnection } }, '../arena-sync.js': arena,
            '../benchmark-primary-condition.js': { primaryFlagForNewCondition() {} },
            '../benchmark-details.js': { markBenchmarkScoresUpdated() {} },
            '../arena-sync-conflicts.js': { ArenaSyncConflictError: Error, findArenaSyncConflicts() {} },
            '../score-field-service.js': { loadScoreFieldCatalog() {} },
            '../model-run-configuration.js': { mergeRunConfigurationFields() {}, modelRunConfiguration() {}, runConfigurationFields() {} },
            '../arena-import-plan.js': Object.fromEntries(['arenaCanonicalModelName','arenaCondition','arenaModelKey','arenaRowHash',
                'arenaResultVendorSlug','arenaTrackedIdentities','arenaVendorName'].map(name => [name, () => {}]))
        };
        process.argv = ['node', 'import-arena-latest.mjs', 'synthetic.json', '--apply', '--backup-confirmed', '--schema-ready'];
        const module = new SourceTextModule(await readFile(new URL(${JSON.stringify(scriptURL)}), 'utf8'), {
            initializeImportMeta(meta) { meta.url = ${JSON.stringify(scriptURL)}; }
        });
        await module.link(specifier => {
            assert.ok(Object.hasOwn(modules, specifier), 'no unmocked IO modules are permitted');
            const exports = modules[specifier];
            return new SyntheticModule(Object.keys(exports), function () {
                for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
            });
        });
        const log = console.log; console.log = value => output.push(value);
        let observed;
        try { await module.evaluate(); } catch (error) { observed = error; }
        finally { console.log = log; }
        assert.ok(observed instanceof AggregateError);
        assert.equal(observed.cause, original);
        assert.equal(observed.errors[0], original); assert.equal(observed.errors[1], rollback);
        assert.equal(durable.batch.status, 'failed'); assert.equal(leases.length, 2);
        assert.deepEqual(output, []);
        assert.deepEqual(events, ['begin', 'publication-destroy', 'recovery-destroy']);
        console.log(JSON.stringify({ dedicatedRecovery: true, durableFailure: true, originalPreserved: true, successOutput: false }));
    `], { encoding: 'utf8', timeout: 15000,
        env: { ...process.env, BENCHPOLL_DB_USER: 'synthetic', BENCHPOLL_DB_PASSWORD: 'synthetic-test-secret', DB_PASSWORD: 'synthetic-test-secret' } });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.doesNotMatch(`${child.stdout}${child.stderr}`, /synthetic-test-secret/);
    assert.deepEqual(JSON.parse(child.stdout), { dedicatedRecovery: true, durableFailure: true, originalPreserved: true, successOutput: false });
});
