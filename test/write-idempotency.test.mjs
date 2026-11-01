import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { canonicalWritePayload, createRetryableWrite } from '../public/js/shared/write-intent.js';
import { readWriteIdentity, claimWriteIntent, completeWriteIntent } from '../write-idempotency.js';
import { createWriteRouteHarness, runWriteReplayProbe } from '../scripts/review-write-replay-20261008.mjs';

const digest = async value => createHash('sha256').update(value).digest('hex');
function memoryStorage() {
    const values = new Map();
    return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key) };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('canonical write fingerprints sort object keys but preserve arrays and wire JSON semantics', () => {
    assert.equal(canonicalWritePayload({ z: 2, a: { c: 3, b: 1 } }), canonicalWritePayload({ a: { b: 1, c: 3 }, z: 2 }));
    assert.notEqual(canonicalWritePayload({ values: [1, 2] }), canonicalWritePayload({ values: [2, 1] }));
    assert.equal(canonicalWritePayload({ value: undefined, values: [undefined, NaN] }), '{"values":[null,null]}');
});

for (let repetition = 1; repetition <= 2; repetition++) {
    for (const route of ['submit_contribution', 'send_admin_message']) test(`${route} returns original committed result on retry (${repetition})`, async () => {
        const result = await runWriteReplayProbe({ route });
        assert.equal(result.recordCount, 1);
        assert.equal(result.emailEnqueues, 0);
        assert.equal(result.emailKicks, 0);
        assert.equal(canonicalWritePayload(result.responses[0].body), canonicalWritePayload(result.responses[1].body));
    });
    test(`browser retries a lost response with the same identity, then starts a distinct intent (${repetition})`, async () => {
        const storage = memoryStorage(), calls = [];
        const write = createRetryableWrite(async (_path, body, options) => {
            calls.push({ body, key: options.headers['Idempotency-Key'], requireJSON: options.requireJSON });
            if (calls.length === 1) throw new TypeError('Response lost');
            return null;
        }, { storage, digest });
        const payload = { type: 'feedback', details: 'Private feedback', expectedUserID: '1' };
        await assert.rejects(write('/api/submit_contribution', payload), /Response lost/);
        assert.equal(storage.values.size, 1);
        assert.equal(JSON.stringify([...storage.values]).includes('Private feedback'), false);
        await write('/api/submit_contribution', payload);
        assert.equal(calls[0].key, calls[1].key);
        assert.equal(storage.values.size, 0);
        await write('/api/submit_contribution', payload);
        assert.notEqual(calls[1].key, calls[2].key);
        assert.ok(calls.every(call => call.requireJSON));
    });
    test(`an unresolved identity survives page helper recreation (${repetition})`, async () => {
        const storage = memoryStorage(), calls = [];
        const request = async (_path, _body, options) => { calls.push(options.headers['Idempotency-Key']); throw Error('Unconfirmed'); };
        const body = { expectedUserID: '1', details: 'Same input after reload' };
        await assert.rejects(createRetryableWrite(request, { storage, digest })('/api/submit_contribution', body));
        await assert.rejects(createRetryableWrite(request, { storage, digest })('/api/submit_contribution', body));
        assert.equal(calls[0], calls[1]);
    });
    test(`changed content, route or actor starts a different identity (${repetition})`, async () => {
        const calls = [], storage = memoryStorage();
        const write = createRetryableWrite(async (_path, _body, options) => { calls.push(options.headers['Idempotency-Key']); throw Error('Unconfirmed'); }, { storage, digest });
        for (const [path, body] of [['/api/a', { expectedUserID: '1', value: 1 }], ['/api/a', { expectedUserID: '1', value: 2 }],
            ['/api/a', { expectedUserID: '2', value: 1 }], ['/api/b', { expectedUserID: '1', value: 1 }]]) {
            await assert.rejects(write(path, body));
        }
        assert.equal(new Set(calls).size, 4);
    });
}

test('the payload is snapshotted before an asynchronous digest', async () => {
    const barrier = deferred(), body = { nested: { value: 'Original' } };
    let sent;
    const write = createRetryableWrite(async (_path, payload) => { sent = payload; }, {
        storage: null, digest: async () => { await barrier.promise; return 'fingerprint'; }
    });
    const pending = write('/api/test', body);
    body.nested.value = 'Changed'; barrier.resolve(); await pending;
    assert.equal(sent.nested.value, 'Original');
});

test('identical concurrent deliveries share an unresolved browser identity', async () => {
    const barrier = deferred(), calls = [];
    const write = createRetryableWrite(async (_path, _body, options) => {
        calls.push(options.headers['Idempotency-Key']); if (calls.length === 2) barrier.resolve(); await barrier.promise;
    }, { storage: memoryStorage(), digest });
    await Promise.all([write('/api/test', { value: 1 }), write('/api/test', { value: 1 })]);
    assert.equal(calls[0], calls[1]);
});

test('an older success cannot clear a newer unresolved intent', async () => {
    const first = deferred(), second = deferred(), storage = memoryStorage(), keys = [];
    const write = createRetryableWrite(async (_path, _body, options) => {
        keys.push(options.headers['Idempotency-Key']);
        const call = keys.length;
        if (call === 1) await first.promise;
        if (call === 2) await second.promise;
        if (call === 3) throw Error('New unresolved intent');
    }, { storage, digest });
    const a = write('/api/test', { value: 1 });
    const b = write('/api/test', { value: 1 });
    while (keys.length < 2) await new Promise(resolve => setImmediate(resolve));
    first.resolve(); await a;
    await assert.rejects(write('/api/test', { value: 1 }), /New unresolved/);
    const retained = [...storage.values.values()][0];
    second.resolve(); await b;
    assert.equal([...storage.values.values()][0], retained);
    assert.equal(retained, keys[2]);
    assert.notEqual(keys[0], keys[2]);
});

test('inaccessible storage retains an in-document identity for retries', async () => {
    const storage = { getItem() { throw Error('Blocked'); }, setItem() { throw Error('Blocked'); }, removeItem() { throw Error('Blocked'); } };
    const calls = [];
    const write = createRetryableWrite(async (_path, _body, options) => { calls.push(options.headers['Idempotency-Key']); throw Error('Lost'); }, { storage, digest });
    await assert.rejects(write('/api/test', {})); await assert.rejects(write('/api/test', {}));
    assert.equal(calls[0], calls[1]);
});

test('a confirmed reused-identity rejection retires corrupt retry metadata', async () => {
    const keys = [], storage = memoryStorage();
    const write = createRetryableWrite(async (_path, _body, options) => {
        keys.push(options.headers['Idempotency-Key']);
        if (keys.length === 1) throw Object.assign(Error('Reused'), { status: 409, payload: { error: 'write_identity_reused' } });
    }, { storage, digest });
    await assert.rejects(write('/api/test', {})); await write('/api/test', {});
    assert.notEqual(keys[0], keys[1]);
});

test('missing, malformed and duplicate header values fail instead of bypassing replay protection', () => {
    for (const key of [undefined, '', 'unsafe', [randomUUID(), randomUUID()]]) {
        assert.throws(() => readWriteIdentity({ headers: { 'idempotency-key': key } }), error => error.status === 400);
    }
    const key = randomUUID();
    assert.equal(readWriteIdentity({ get: () => key.toUpperCase() }), key);
});

for (const route of ['submit_contribution', 'send_admin_message']) {
    test(`${route} permits an explicit new intent with identical content`, async () => {
        const harness = await createWriteRouteHarness({ route });
        const body = route === 'submit_contribution'
            ? { type: 'feedback', details: 'Intentional repeat.', pageURL: '', expectedUserID: '1' }
            : { body: 'Intentional repeat.', expectedUserID: '1' };
        await harness.invoke(body, randomUUID()); await harness.invoke(body, randomUUID());
        assert.equal(harness.summary().recordCount, 2);
        assert.equal(harness.summary().emailEnqueues, 0);
        assert.equal(harness.summary().emailKicks, 0);
    });
    test(`${route} rejects a changed payload with an already-used identity`, async () => {
        const harness = await createWriteRouteHarness({ route }), key = randomUUID();
        const body = route === 'submit_contribution'
            ? { type: 'feedback', details: 'Original input.', pageURL: '', expectedUserID: '1' }
            : { body: 'Original input.', expectedUserID: '1' };
        await harness.invoke(body, key);
        await assert.rejects(harness.invoke({ ...body, ...(route === 'submit_contribution' ? { details: 'Changed input.' } : { body: 'Changed input.' }) }, key),
            error => error.body?.error === 'write_identity_reused');
        assert.equal(harness.summary().recordCount, 1);
        assert.equal(harness.summary().emailEnqueues, 0);
        assert.equal(harness.summary().emailKicks, 0);
    });
    test(`${route} cannot replay under a replacement document account`, async () => {
        const harness = await createWriteRouteHarness({ route }), key = randomUUID();
        const body = route === 'submit_contribution'
            ? { type: 'feedback', details: 'Original input.', pageURL: '', expectedUserID: '1' }
            : { body: 'Original input.', expectedUserID: '1' };
        await harness.invoke(body, key);
        await assert.rejects(harness.invoke({ ...body, expectedUserID: '2' }, key), error => error.body?.error === 'account_changed');
        assert.equal(harness.summary().recordCount, 1);
        assert.equal(harness.summary().emailEnqueues, 0);
        assert.equal(harness.summary().emailKicks, 0);
    });
}

test('atomic completion requires its original claim owner and supported response status', async () => {
    await assert.rejects(completeWriteIntent({}, { owner: null }, { status: 204 }), /Invalid write completion/);
    await assert.rejects(completeWriteIntent({}, { owner: 'owner' }, { status: 500 }), /Invalid write completion/);
    await assert.rejects(completeWriteIntent({ execute: async () => [{ affectedRows: 0 }] }, { owner: 'owner', actor: '1', key: randomUUID() }, { status: 204 }), /ownership/);
});

test('an incomplete durable request never reports success or starts fresh business work', async () => {
    const key = randomUUID(), payload = { value: 1 };
    const connection = { execute: async sql => sql.includes('INSERT') ? [{ affectedRows: 1 }]
        : [[{ action: 'submit_contribution', payload_hash: await digest(canonicalWritePayload(payload)), owner_token: randomUUID(), response_status: null }]] };
    await assert.rejects(claimWriteIntent(connection, { userID: '1', key, action: 'submit_contribution', payload }),
        error => error.body.error === 'write_identity_incomplete');
});
