import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = await readFile(process.env.BENCHPOLL_STATIC_BASELINE || new URL('../server.js', import.meta.url), 'utf8');
const first = Math.min(...['app.use(session(', 'app.use(express.static('].map(marker => {
    const index = source.indexOf(marker);
    assert.ok(index >= 0, 'Actual server registration must exist: ' + marker);
    return index;
}));
const last = source.indexOf("app.use('/api', API)", first);
assert.ok(last > first, 'Read the actual middleware registrations, not a reconstructed order');
const registrations = source.slice(first, last);
const assets = [
    { path: '/js/shared/account-identity.js', revalidate: true },
    { path: '/css/ui/tokens.css', revalidate: true },
    { path: '/favicon.ico', revalidate: false },
    { path: '/vendor/fontawesome/webfonts/fa-solid-900.woff2', revalidate: false }
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(run) {
    const app = express();
    const store = new session.MemoryStore();
    const originalGet = store.get.bind(store), originalSet = store.set.bind(store);
    let mode = 'normal', reads = 0, writes = 0;
    store.get = (ID, callback) => {
        reads++;
        if (mode === 'pending') return;
        if (mode === 'error') return queueMicrotask(() => callback(new Error('Synthetic session-store failure')));
        originalGet(ID, callback);
    };
    store.set = (ID, value, callback) => { writes++; originalSet(ID, value, callback); };
    runInNewContext(registrations, {
        app, express, session, cookieParser, sessionStore: store,
        sessionSecret: 'isolated-session-fixture', sessionMaxAgeMs: 60000,
        currentDir: root.replace(/[\\/]$/, '')
    });
    app.get('/fixture-login', (req, res) => {
        req.session.userID = '7'; res.json({ authenticated: true });
    });
    app.post('/api/fixture', (req, res) => res.json({ userID: req.session.userID, body: req.body, cookie: req.cookies.fixture }));
    app.get('/fixture-private', (req, res) => res.json({ userID: req.session.userID }));
    app.use((req, res) => res.status(404).json({ missing: true, userID: req.session.userID }));
    app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
    const server = createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
        const seeded = await fetch(origin + '/fixture-login');
        assert.equal(seeded.status, 200); await seeded.json();
        const cookie = seeded.headers.get('set-cookie')?.split(';')[0];
        assert.ok(cookie?.startsWith('sid='), 'Use an actual express-session signed cookie');
        const before = { reads, writes };
        await run({ origin, cookie, mode(value) { mode = value; }, counts() { return { reads, writes }; }, before });
    } finally {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}

for (const asset of assets) for (const mode of ['error', 'pending', 'normal']) {
    test(`public asset ${asset.path} is independent of ${mode} session lookup, twice`, async () => {
        const expected = hash(await readFile(new URL('../public' + asset.path, import.meta.url)));
        for (let repetition = 0; repetition < 2; repetition++) await fixture(async context => {
            context.mode(mode);
            const response = await fetch(context.origin + asset.path, { headers: { Cookie: context.cookie }, signal: AbortSignal.timeout(800) });
            assert.equal(response.status, 200, 'A public asset cannot depend on successful session storage');
            assert.equal(hash(new Uint8Array(await response.arrayBuffer())), expected);
            assert.deepEqual(context.counts(), context.before, 'Public assets must not read/write the account session');
            assert.equal(response.headers.get('set-cookie'), null);
            if (asset.revalidate) {
                assert.equal(response.headers.get('cache-control'), 'no-cache, max-age=0, must-revalidate');
                assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
                assert.equal(response.headers.get('cloudflare-cdn-cache-control'), 'no-store');
            }
        });
    });
}

test('API and private-page session identity remain intact, twice', async () => {
    for (let repetition = 0; repetition < 2; repetition++) await fixture(async context => {
        const response = await fetch(context.origin + '/api/fixture', { method: 'POST', headers: {
            'Content-Type': 'application/json', Cookie: context.cookie + '; fixture=preserved'
        }, body: JSON.stringify({ expectedUserID: '7', value: 'body-parsing-preserved' }) });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { userID: '7', body: { expectedUserID: '7', value: 'body-parsing-preserved' }, cookie: 'preserved' });
        const page = await fetch(context.origin + '/fixture-private', { headers: { Cookie: context.cookie } });
        assert.equal(page.status, 200); assert.deepEqual(await page.json(), { userID: '7' });
        assert.equal(context.counts().reads - context.before.reads, 2);
    });
});

test('missing static paths still pass through session-aware routing, twice', async () => {
    for (let repetition = 0; repetition < 2; repetition++) await fixture(async context => {
        const response = await fetch(context.origin + '/js/nonexistent-static-fixture.js', { headers: { Cookie: context.cookie } });
        assert.equal(response.status, 404); assert.deepEqual(await response.json(), { missing: true, userID: '7' });
        assert.equal(context.counts().reads - context.before.reads, 1);
    });
});

test('API session-store failure is not bypassed, twice', async () => {
    for (let repetition = 0; repetition < 2; repetition++) await fixture(async context => {
        context.mode('error');
        const response = await fetch(context.origin + '/api/fixture', { method: 'POST', headers: { Cookie: context.cookie } });
        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), { error: 'Synthetic session-store failure' });
        assert.equal(context.counts().reads - context.before.reads, 1);
    });
});

test('pending API session lookup remains pending rather than becoming anonymous, twice', async () => {
    for (let repetition = 0; repetition < 2; repetition++) await fixture(async context => {
        context.mode('pending');
        await assert.rejects(fetch(context.origin + '/api/fixture', { method: 'POST',
            headers: { Cookie: context.cookie }, signal: AbortSignal.timeout(150) }), error => error.name === 'TimeoutError');
        assert.equal(context.counts().reads - context.before.reads, 1);
    });
});
