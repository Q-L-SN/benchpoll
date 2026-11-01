import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import session from 'express-session';
import mysqlStoreFactory from 'express-mysql-session';
import { createDeadlinePool, databaseDeadlineOptions } from '../db-deadlines.js';
import { startTransactionConnection, commitTransactionConnection, releaseTransactionConnection,
    isTransactionConnectionDiscarded } from '../db-transaction.js';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function fixture(overrides = {}, options = {}) {
    const events = [], result = [[{ ID: '9007199254740993' }], [{ name: 'ID' }]];
    const connection = {
        async query(...args) { events.push(['query', ...args]); return result; },
        async execute(...args) { events.push(['execute', ...args]); return result; },
        async beginTransaction() { events.push(['begin']); },
        async commit() { events.push(['commit']); }, async rollback() { events.push(['rollback']); },
        release() { events.push(['release']); }, destroy() { events.push(['destroy']); }, ...overrides
    };
    const raw = new EventEmitter();
    raw.getConnection = async () => { events.push(['acquire']); return connection; };
    raw.escape = value => String(value);
    const pool = createDeadlinePool(raw, { acquireTimeoutMs: 10, queryTimeoutMs: 20, pendingLimit: 2, ...options });
    return { connection, pool, raw, events, result };
}

for (let repetition = 1; repetition <= 2; repetition++) {
    for (const phase of ['begin', 'snapshot SET', 'snapshot START', 'commit']) test(`${phase} deadline discards uncertain connection (${repetition})`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const work = deferred(), events = [];
        const connection = { beginTransaction: () => work.promise, commit: () => work.promise,
            query: sql => phase === 'snapshot START' && sql.startsWith('SET') ? Promise.resolve() : work.promise,
            release: () => events.push('release'), destroy: () => events.push('destroy') };
        const pending = phase === 'commit' ? commitTransactionConnection(connection, 'TEST')
            : startTransactionConnection(connection, 'TEST', { readOnlySnapshot: phase.startsWith('snapshot') });
        const rejection = assert.rejects(pending, error => error.code === 'DATABASE_OPERATION_TIMEOUT'
            && error.status === 503 && error.body.outcomeUnknown === true && !error.body.retryable);
        await flush(); t.mock.timers.tick(5000); await rejection;
        releaseTransactionConnection(connection, 'TEST');
        assert.equal(isTransactionConnectionDiscarded(connection), true);
        assert.deepEqual(events, ['destroy']);
        work.reject(new Error('late driver rejection')); await flush();
    });
    for (const method of ['query', 'execute']) for (const scope of ['pool', 'lease']) {
        test(`${scope} ${method} timeout destroys before release (${repetition})`, async t => {
            t.mock.timers.enable({ apis: ['setTimeout'] });
            const work = deferred(), { pool, events } = fixture({ [method]: () => work.promise });
            const connection = scope === 'lease' ? await pool.getConnection() : pool;
            const rejected = assert.rejects(connection[method]('SELECT 1'), error => error.code === 'DATABASE_OPERATION_TIMEOUT');
            await flush(); t.mock.timers.tick(20); await rejected;
            if (scope === 'lease') {
                connection.release();
                await assert.rejects(connection[method]('SELECT 2'), error => error.code === 'DATABASE_CONNECTION_DISCARDED');
            }
            assert.deepEqual(events, [['acquire'], ['destroy']]);
            work.resolve([[], []]); await flush();
            assert.equal(events.length, 2);
        });
    }
}

test('late snapshot SET acknowledgement cannot start a new transaction on the discarded connection', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const work = deferred(), calls = [];
    const connection = { query: sql => { calls.push(sql); return work.promise; }, destroy() {} };
    const rejected = assert.rejects(startTransactionConnection(connection, 'TEST', { readOnlySnapshot: true }));
    await flush(); t.mock.timers.tick(5000); await rejected;
    work.resolve([[], []]); await flush();
    assert.deepEqual(calls, ['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ']);
});

for (const method of ['query', 'execute']) test(`${method} preserves exact SQL, options, parameters and mysql2 result shape`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { pool, events, result } = fixture();
    const sql = { sql: 'SELECT ? AS ID', timeout: 5 }, values = ['9007199254740993'];
    assert.equal(await pool[method](sql, values), result);
    assert.deepEqual(events, [['acquire'], [method, sql, values], ['release']]);
    t.mock.timers.tick(60000); await flush(); assert.equal(events.length, 3);
});

for (const code of ['ER_DUP_ENTRY', 'PROTOCOL_SEQUENCE_TIMEOUT', 'ER_LOCK_DEADLOCK']) {
    test(`driver ${code} retains original identity and discards only unusable lease`, async () => {
        const failure = Object.assign(new Error('driver failure'), { code });
        const { pool, events } = fixture({ execute: async () => { throw failure; } });
        await assert.rejects(pool.execute('isolated SQL'), error => error === failure);
        assert.deepEqual(events, [['acquire'], [code === 'PROTOCOL_SEQUENCE_TIMEOUT' ? 'destroy' : 'release']]);
    });
}

for (const errno of [1792, 1290, 1836]) test(`automatic pool read-only error ${errno} retains mysql2 disposal policy`, async () => {
    const failure = Object.assign(new Error('read-only driver error'), { errno });
    const { pool, events } = fixture({ execute: async () => { throw failure; } });
    await assert.rejects(pool.execute('isolated SQL'), error => error === failure);
    assert.deepEqual(events, [['acquire'], ['destroy']]);
});

test('a released wrapper cannot run SQL or destroy the next borrower of the same core connection', async () => {
    const { pool, events } = fixture();
    const old = await pool.getConnection(); old.release();
    const current = await pool.getConnection(); old.destroy(); old.release();
    await assert.rejects(old.execute('must not run'), error => error.code === 'DATABASE_CONNECTION_DISCARDED');
    await current.execute('SELECT 1'); current.release();
    assert.deepEqual(events, [['acquire'], ['release'], ['acquire'], ['execute', 'SELECT 1'], ['release']]);
});

test('premature release discards in-flight work instead of transferring an unfinished lease', async () => {
    const { pool, events } = fixture();
    const connection = await pool.getConnection();
    const rejected = assert.rejects(connection.execute('must not run'), error => error.code === 'DATABASE_CONNECTION_DISCARDED');
    connection.release(); await rejected;
    assert.deepEqual(events, [['acquire'], ['destroy']]);
});

for (const outcome of ['resolve', 'reject']) test(`acquisition timeout handles late ${outcome} without leaks or late SQL`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const work = deferred(), { pool, raw, connection, events } = fixture();
    raw.getConnection = () => work.promise;
    const rejected = assert.rejects(pool.execute('must not run'), error => error.code === 'DATABASE_ACQUIRE_TIMEOUT'
        && error.status === 503 && error.body.error === 'database_busy');
    await flush(); t.mock.timers.tick(10); await rejected;
    work[outcome](outcome === 'resolve' ? connection : new Error('late acquire failure')); await flush();
    assert.deepEqual(events, outcome === 'resolve' ? [['release']] : []);
});

test('timed-out native acquisitions remain counted until their queued callbacks settle', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const work = [deferred(), deferred()], { pool, raw, connection, events } = fixture();
    let calls = 0; raw.getConnection = () => work[calls++].promise;
    const first = assert.rejects(pool.getConnection()), second = assert.rejects(pool.getConnection());
    await assert.rejects(pool.getConnection(), error => error.body.error === 'database_busy');
    await flush(); assert.equal(calls, 2);
    t.mock.timers.tick(10); await first; await second;
    await assert.rejects(pool.getConnection()); assert.equal(calls, 2);
    work[0].resolve(connection); work[1].resolve(connection); await flush();
    raw.getConnection = async () => connection;
    const next = await pool.getConnection(); next.release();
    assert.deepEqual(events, [['release'], ['release'], ['release']]);
});

test('acquisition errors preserve original identity and immediately free queue capacity', async () => {
    const failure = new Error('acquisition'), { raw, pool } = fixture({}, { pendingLimit: 1 });
    raw.getConnection = async () => { throw failure; };
    await assert.rejects(pool.getConnection(), error => error === failure);
    await assert.rejects(pool.getConnection(), error => error === failure);
});

test('native event listener transfer is not destroyed by the old deadline wrapper', async () => {
    const raw = new EventEmitter(), core = { _pool: raw }, events = [];
    raw.getConnection = async () => ({ connection: core,
        release: () => raw.emit('release', core), destroy: () => events.push('destroy') });
    const original = console.error; console.error = () => {};
    try {
        raw.on('release', () => { events.push('transferred'); throw new Error('listener'); });
        const connection = await createDeadlinePool(raw).getConnection();
        connection.release(); connection.destroy();
        assert.deepEqual(events, ['transferred']); assert.equal(raw.listenerCount('release'), 1);
    } finally { console.error = original; }
});

test('actual express-mysql-session uses the deadline pool without changing persisted session values', async () => {
    const sessions = new Map(), { raw, pool, events } = fixture();
    raw.getConnection = async () => ({ async query(sql, params) {
        if (sql.startsWith('INSERT')) { sessions.set(params[4], { expires: params[5], data: params[6] }); return [{ affectedRows: 1 }, []]; }
        if (sql.startsWith('SELECT')) return [[sessions.get(params.at(-1))].filter(Boolean), []];
        if (sql.startsWith('DELETE')) sessions.delete(params.at(-1));
        return [{ affectedRows: 1 }, []];
    }, release() { events.push(['release']); }, destroy() { assert.fail('Normal session SQL must not be destroyed'); } });
    const MySQLStore = mysqlStoreFactory(session);
    const store = new MySQLStore({ createDatabaseTable: false, clearExpired: false }, pool);
    try {
        await store.onReady();
        const data = { userID: '9007199254740993', cookie: { expires: new Date(Date.now() + 100000) } };
        await store.set('isolated-session', data);
        assert.equal((await store.get('isolated-session')).userID, data.userID);
        await store.destroy('isolated-session');
        assert.equal(await store.get('isolated-session'), null);
        assert.equal(events.length, 4);
    } finally { await store.close(); }
});

test('pool passthrough methods retain native receivers', () => {
    const { pool, raw } = fixture();
    raw.escape = function(value) { assert.equal(this, raw); return `escaped:${value}`; };
    assert.equal(pool.escape('x'), 'escaped:x');
    assert.equal(pool instanceof EventEmitter, true);
});

test('database deadlines are bounded positive configuration, not silently disabled', () => {
    assert.deepEqual(databaseDeadlineOptions({}), { acquireTimeoutMs: 5000, queryTimeoutMs: 30000, pendingLimit: 100 });
    assert.deepEqual(databaseDeadlineOptions({ BENCHPOLL_DB_ACQUIRE_TIMEOUT_MS: '9', BENCHPOLL_DB_QUERY_TIMEOUT_MS: '40',
        BENCHPOLL_DB_PENDING_LIMIT: '3' }), { acquireTimeoutMs: 9, queryTimeoutMs: 40, pendingLimit: 3 });
    for (const value of ['0', '-1', 'Infinity', 'NaN', '1.2', '600001']) {
        assert.throws(() => databaseDeadlineOptions({ BENCHPOLL_DB_QUERY_TIMEOUT_MS: value }));
    }
    assert.throws(() => createDeadlinePool({}, { pendingLimit: 1001 }));
});

test('actual HTTP error middleware exposes only safe timeout status and cannot claim write success', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { pool, raw } = fixture(); raw.getConnection = () => new Promise(() => {});
    let failure;
    const pending = pool.getConnection().catch(error => { failure = error; });
    await flush(); t.mock.timers.tick(10); await pending;
    const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
    let middleware, status, body;
    const context = vm.createContext({ app: { use: handler => { middleware = handler; } }, console: { error() {} } });
    const start = source.indexOf('function databaseErrorResponse(');
    vm.runInContext(source.slice(start, source.indexOf('\nconst options = {', start)), context);
    const req = { errorFrom: 'API', method: 'POST', path: '/submit_contribution' };
    const res = { headersSent: false, set() { return this; }, status(value) { status = value; return this; }, json(value) { body = value; } };
    middleware(failure, req, res, () => assert.fail('Timeout must have a response'));
    assert.equal(status, 503); assert.equal(body, failure.body); assert.equal(body.error, 'database_busy');
    failure = { code: 'DATABASE_OPERATION_TIMEOUT', status: 503, fatal: true,
        body: { error: 'database_operation_timeout', outcomeUnknown: true }, sql: 'private SQL', sqlMessage: 'private details' };
    middleware(failure, req, res, () => assert.fail('Timeout must have a response'));
    assert.equal(status, 503); assert.deepEqual(body, failure.body);
    assert.equal(JSON.stringify(body).includes('private'), false); assert.equal(body.retryable, undefined);
    middleware({ code: 'PROTOCOL_SEQUENCE_TIMEOUT', sql: 'private SQL', sqlMessage: 'private details' }, req, res,
        () => assert.fail('Native timeout must have a response'));
    assert.equal(status, 503); assert.equal(body.error, 'database_operation_timeout'); assert.equal(body.outcomeUnknown, true);
    assert.equal(JSON.stringify(body).includes('private'), false); assert.equal(body.retryable, undefined);
});
