import assert from 'node:assert/strict';
import test from 'node:test';
import { postJSON, postWriteJSON } from '../public/js/shared/http.js';
import { createComparisonProfileStore } from '../public/js/workspace/comparison-profiles.js';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const response = (value, status = 200) => ({ status, ok: status >= 200 && status < 300,
    headers: new Headers({ 'Content-Type': 'application/json' }), json: async () => value });
const timeout = error => error.name === 'TimeoutError' && error.code === 'request_timeout';
const configuration = { mode: 'matched', keys: ['model'], filters: [] };

for (let repetition = 1; repetition <= 2; repetition++) {
    for (const phase of ['fetch', 'body']) for (const late of ['resolve', 'reject']) {
        test(`${phase} deadline settles despite ignored abort and late ${late} (${repetition})`, async t => {
            t.mock.timers.enable({ apis: ['setTimeout'] });
            const work = deferred();
            let signal;
            t.mock.method(globalThis, 'fetch', (_url, options) => {
                signal = options.signal;
                return phase === 'fetch' ? work.promise : Promise.resolve({ ...response(null), json: () => work.promise });
            });
            const pending = postJSON('/read', {}, { timeoutMs: 10, requireJSON: true });
            const rejected = assert.rejects(pending, timeout);
            await flush();
            assert.equal(signal.aborted, false);
            t.mock.timers.tick(10);
            await rejected;
            assert.equal(signal.aborted, true);
            assert.ok(timeout(signal.reason));
            if (late === 'reject') work.reject(new Error('Late transport failure'));
            else work.resolve(phase === 'fetch' ? response({ late: true }) : { late: true });
            await flush();
            await assert.rejects(pending, timeout);
        });
    }
}

test('external cancellation retains its reason and cleans up the deadline', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const owner = new AbortController(), work = deferred(), failure = new Error('Navigation cancelled');
    const remove = t.mock.method(owner.signal, 'removeEventListener');
    let signal;
    t.mock.method(globalThis, 'fetch', (_url, options) => { signal = options.signal; return work.promise; });
    const pending = postJSON('/read', {}, { timeoutMs: 10, signal: owner.signal });
    const rejected = assert.rejects(pending, error => error === failure);
    owner.abort(failure);
    await rejected;
    assert.equal(signal.reason, failure);
    assert.equal(remove.mock.callCount(), 1);
    t.mock.timers.tick(100);
    assert.equal(signal.reason, failure);
    work.resolve(response({ late: true }));
    await flush();
});

test('successful response removes both cancellation hooks without changing request or JSON', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const owner = new AbortController(), value = { exact: ['a', -2, null] };
    const remove = t.mock.method(owner.signal, 'removeEventListener');
    let request;
    t.mock.method(globalThis, 'fetch', async (url, options) => { request = { url, options }; return response(value); });
    assert.equal(await postJSON('/read', { ID: '7' }, { timeoutMs: 10, signal: owner.signal,
        requireJSON: true, headers: { 'X-Request': 'test' } }), value);
    assert.equal(request.url, '/read');
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.body, '{"ID":"7"}');
    assert.deepEqual(request.options.headers, { 'Content-Type': 'application/json', 'X-Request': 'test' });
    assert.equal(remove.mock.callCount(), 1);
    t.mock.timers.tick(100);
    owner.abort(new Error('After completion'));
    assert.equal(request.options.signal.aborted, false);
});

for (const invalid of [null, 0, -1, 1.5, NaN, Infinity, 2147483648, '10']) {
    test(`invalid deadline ${String(invalid)} is rejected before a fetch`, async t => {
        const fetch = t.mock.method(globalThis, 'fetch', async () => response({}));
        await assert.rejects(postJSON('/read', {}, { timeoutMs: invalid }), TypeError);
        assert.equal(fetch.mock.callCount(), 0);
    });
}

test('HTTP rejection retains status and server payload and cancels the timer', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const payload = { error: 'database_busy', retryable: true };
    let signal;
    t.mock.method(globalThis, 'fetch', async (_url, options) => { signal = options.signal; return response(payload, 503); });
    await assert.rejects(postJSON('/read', {}, { timeoutMs: 10, requireJSON: true }),
        error => error.status === 503 && error.payload === payload && error.message === 'database_busy');
    t.mock.timers.tick(100);
    assert.equal(signal.aborted, false);
});

test('invalid JSON content type still rejects immediately; 204 remains null', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let status = 200;
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status,
        headers: new Headers({ 'Content-Type': 'text/html' }), json: () => assert.fail('Must not parse HTML or 204') }));
    await assert.rejects(postJSON('/read', {}, { timeoutMs: 10, requireJSON: true }), /could not be confirmed/);
    status = 204;
    assert.equal(await postJSON('/read', {}, { timeoutMs: 10, requireJSON: true }), null);
    t.mock.timers.tick(100);
});

test('ordinary requests do not acquire an implicit deadline and forward a supplied signal', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const work = deferred(), owner = new AbortController();
    let captured, settled = false;
    t.mock.method(globalThis, 'fetch', (_url, options) => { captured = options; return work.promise; });
    const pending = postJSON('/ordinary', {}).then(value => { settled = true; return value; });
    t.mock.timers.tick(3600000);
    await flush();
    assert.equal(settled, false);
    assert.equal(Object.hasOwn(captured, 'signal'), false);
    work.resolve(response({ confirmed: true }));
    assert.deepEqual(await pending, { confirmed: true });
    await postJSON('/ordinary', {}, { signal: owner.signal });
    assert.equal(captured.signal, owner.signal);
});

test('write transport retains the unconfirmed identity on an ordinary network failure', async t => {
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        requests.push({ url, ...options });
        if (requests.length === 1) throw new TypeError('Unconfirmed network failure');
        return response({ confirmed: true });
    });
    const body = { expectedUserID: '7', note: 'Deadline regression' };
    await assert.rejects(postWriteJSON('/isolated-write', body), /Unconfirmed/);
    assert.deepEqual(await postWriteJSON('/isolated-write', body), { confirmed: true });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].headers['Idempotency-Key'], requests[1].headers['Idempotency-Key']);
    assert.match(requests[0].headers['Idempotency-Key'], /^[a-f0-9-]{36}$/);
    assert.ok(requests.every(request => !Object.hasOwn(request, 'signal')));
    assert.equal(requests[0].body, requests[1].body);
});

test('profile deadline leaves the prior account, configuration and storage intact, then retry restores current account', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const data = new Map(), work = deferred();
    const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
    let loads = 0, signal;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        loads++;
        if (loads === 2) { signal = options.signal; return work.promise; }
        return response({ authenticated: true, userID: loads === 1 ? '7' : '8', last: configuration, profiles: [] });
    });
    const store = createComparisonProfileStore({ request: postJSON, storage: () => storage });
    await store.load();
    const previous = store.snapshot();
    const pending = store.load(), rejected = assert.rejects(pending, timeout);
    t.mock.timers.tick(9999);
    await flush();
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    await rejected;
    assert.equal(signal.aborted, true);
    assert.equal(store.accountID(), '7');
    assert.deepEqual(store.snapshot(), previous);
    assert.equal(data.size, 0);
    await store.load();
    work.resolve(response({ authenticated: true, userID: '9', last: null, profiles: [] }));
    await flush();
    assert.equal(store.accountID(), '8');
    assert.deepEqual(store.snapshot().last, configuration);
    assert.equal(data.size, 0);
});
