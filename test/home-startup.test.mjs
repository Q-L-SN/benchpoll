import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { startHomeReads } from '../public/js/home-startup.js';
import { FEATURED_TOPIC_ID, topicURL } from '../public/js/shared/topics.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const topicPath = topicURL(FEATURED_TOPIC_ID, 'Language models');
const body = { categoryID: FEATURED_TOPIC_ID, contextValues: {}, comparison: { mode: 'best', keys: ['model'], filters: [] },
    scoreMode: 'available', initialMode: 'public', benchmarkQuery: '', pinPersonal: false };
test('named scene startup waits for resolved scene identity instead of speculating on the default', async () => {
    const requests = [];
    const target = { location: { pathname: '/intelligence/real-time' }, addEventListener() {},
        document: { querySelector: () => ({ content: String(FEATURED_TOPIC_ID), dataset: { guest: 'true' } }) } };
    const reads = startHomeReads(target, { settings: () => ({ basic: body.comparison }),
        preferences: () => ({ scoreMode: 'available', mode: 'public' }), fetch: async (url, options) => {
            requests.push({ url, body: options.body && JSON.parse(options.body) });
            if (url === '/api/get_user_profile') return new Response(null, { status: 204 });
            return Response.json({ currentCategoryID: FEATURED_TOPIC_ID, contextValues: { scene: '20' } });
        } });
    try {
        await tick(); await tick();
        const workspaces = requests.filter(item => item.url === '/api/get_weighted_workspace');
        assert.equal(workspaces.length, 1);
        assert.deepEqual(workspaces[0].body.contextValues, { scene: '20' });
        assert.equal(reads.take('/api/get_weighted_workspace', body), null);
        assert.ok(await reads.take('/api/get_weighted_workspace', { ...body, contextValues: { scene: '20' } }));
    } finally { reads.stop(); }
});
function fixture(extra = {}) {
    const { bootstrap, location, ...options } = extra;
    const calls = [], listeners = new Map();
    const target = { location: { pathname: topicPath, ...location }, document: { querySelector: () => bootstrap },
        addEventListener: (name, callback) => listeners.set(name, callback) };
    const reads = startHomeReads(target, { fetch: async (url, options) => {
        calls.push({ url, options });
        if (url === '/api/get_user_profile') return new Response(null, { status: 204 });
        return new Response(JSON.stringify(url.startsWith('/api/get_page') ? { currentCategoryID: FEATURED_TOPIC_ID }
            : { ok: true }),
        { headers: { 'Content-Type': 'application/json' } });
    }, settings: () => ({ experimental: false, basic: body.comparison }), ...options });
    return { reads, calls, listeners, target };
}

test('initial scoring switch puts the selected Estimated score choice before Score range', () => {
    const html = readFileSync(new URL('../private/home.html', import.meta.url), 'utf8');
    const controls = html.match(/<div class="bp-scoring-switch"[^>]*>[\s\S]*?<\/div>/)?.[0];
    assert.ok(controls);
    assert.match(controls, /data-mode="available"/);
    const choices = [...controls.matchAll(/<button\b[^>]*data-score-mode="([^"]+)"[^>]*aria-pressed="([^"]+)"[^>]*>[\s\S]*?<span>([^<]+)<\/span><\/button>/g)]
        .map(([, mode, pressed, label]) => ({ mode, pressed, label }));
    assert.deepEqual(choices, [
        { mode: 'available', pressed: 'true', label: 'Estimated score' },
        { mode: 'range', pressed: 'false', label: 'Score range' }
    ]);
});

test('startup reads real preferences for both boot paths and reuses the matching scoring request', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    try {
        for (const bootstrap of [undefined, { content: String(FEATURED_TOPIC_ID), dataset: { guest: 'true' } }]) {
            for (const [stored, scoreMode] of [
                [null, 'available'], ['{', 'available'], ['{}', 'available'],
                ['{"scoreMode":"invalid"}', 'available'],
                ['{"scoreMode":"available"}', 'available'], ['{"scoreMode":"range"}', 'range']
            ]) {
                let preferenceReads = 0;
                Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
                    getItem(key) {
                        assert.equal(key, 'benchpoll-workspace-preferences-v1');
                        preferenceReads++;
                        return stored;
                    }
                } });
                const { reads, calls } = fixture({ bootstrap });
                try {
                    await tick(); await tick();
                    assert.equal(preferenceReads, 1);
                    const rankings = calls.filter(call => call.url === '/api/get_weighted_workspace');
                    assert.equal(rankings.length, 1);
                    assert.equal(JSON.parse(rankings[0].options.body).scoreMode, scoreMode);
                    assert.equal(reads.take('/api/get_weighted_workspace', {
                        ...body, scoreMode: scoreMode === 'available' ? 'range' : 'available'
                    }), null);
                    assert.ok(await reads.take('/api/get_weighted_workspace', { ...body, scoreMode }));
                } finally { reads.stop(); }
            }
        }
    } finally {
        if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor);
        else delete globalThis.sessionStorage;
    }
});

test('both startup paths always request v5 without reading a retired local coverage preference', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    try {
        let readsFromStorage = 0;
        Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() {
            readsFromStorage++;
            throw new Error('Storage is blocked or contains a retired power preference');
        } });
        for (const bootstrap of [undefined, { content: String(FEATURED_TOPIC_ID), dataset: { guest: 'true' } }]) {
            const { reads, calls } = fixture({ bootstrap });
            try {
                await tick(); await tick();
                const request = JSON.parse(calls.find(call => call.url === '/api/get_weighted_workspace').options.body);
                assert.equal(request.availableInferenceVersion, 7);
                assert.ok(await reads.take('/api/get_weighted_workspace', { ...body, availableInferenceVersion: 4 }));
            } finally { reads.stop(); }
        }
        assert.equal(readsFromStorage, 0);
    } finally {
        if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
        else delete globalThis.localStorage;
    }
});

test('startup overlaps only read operations and reuses one exact request without changing parameters', async () => {
    const { reads, calls } = fixture();
    try {
        await tick(); await tick();
        assert.equal(calls.length, 3);
        assert.ok(calls.every(call => /^\/api\/get_/.test(call.url)));
        assert.equal(reads.take('/api/save_personal_pie', body), null);
        assert.equal(reads.take('/api/get_weighted_workspace', { ...body, scoreMode: 'range' }), null);
        assert.equal(reads.take('/api/get_weighted_workspace', body, { headers: { Authorization: 'another account' } }), null);
        const response = await reads.take('/api/get_weighted_workspace', Object.fromEntries(Object.entries(body).reverse()));
        assert.equal((await response.json()).ok, true);
        assert.equal(reads.take('/api/get_weighted_workspace', body), null);
    } finally { reads.stop(); }
});

test('both startup boot paths capture Home intent before URL cleanup and reuse the exact normal request', async () => {
    for (const bootstrap of [undefined, { content: String(FEATURED_TOPIC_ID), dataset: { guest: 'true' } }]) {
        for (const mode of ['public', 'personal']) {
            const targetModel = JSON.stringify([['field:20', true, 201], ['field:30', true, 301], ['model', true, 42]]);
            const location = { href: `https://benchpoll.test${topicPath}?focusModel=${encodeURIComponent(targetModel)}&scoreMode=range&mode=${mode}&compareReasoning=1&compareHarness=1` };
            let settingsReads = 0;
            const { reads, calls, target } = fixture({ bootstrap, location,
                settings() { settingsReads++; return { basic: { mode: 'best', keys: ['model', 'field:1'], filters: [] } }; },
                preferences: () => ({ mode: mode === 'public' ? 'personal' : 'public', scoreMode: 'available' }) });
            try {
                target.location.href = `https://benchpoll.test${topicPath}`;
                await tick(); await tick();
                const rankings = calls.filter(call => call.url === '/api/get_weighted_workspace');
                assert.equal(rankings.length, 1);
                assert.equal(settingsReads, 0, 'A Home comparison must not read saved comparison controls');
                const request = { ...body, scoreMode: 'range', initialMode: mode,
                    comparison: { mode: 'best', keys: ['field:20', 'field:30', 'model'], filters: [] },
                    homeComparison: { reasoning: true, harness: true } };
                const actual = JSON.parse(rankings[0].options.body);
                delete actual.availableInferenceVersion;
                assert.deepEqual(actual, request);
                assert.equal(reads.take('/api/get_weighted_workspace', body), null);
                assert.ok(await reads.take('/api/get_weighted_workspace', request));
                assert.equal(reads.take('/api/get_weighted_workspace', request), null);
            } finally { reads.stop(); }
        }
    }
});

test('invalid Home intent cannot change speculative workspace preferences', async () => {
    const { reads, calls } = fixture({ location: { href: `https://benchpoll.test${topicPath}?focusModel=42&mode=invalid&scoreMode=range` } });
    try {
        await tick(); await tick();
        const request = JSON.parse(calls.find(call => call.url === '/api/get_weighted_workspace').options.body);
        assert.equal(request.scoreMode, 'available');
        assert.equal(request.initialMode, 'public');
        assert.equal(request.homeComparison, undefined);
        assert.ok(await reads.take('/api/get_weighted_workspace', body));
    } finally { reads.stop(); }
});

test('retired experimental flags cannot prevent or alter basic ranking prefetch', async () => {
    const { reads, calls } = fixture({ settings: () => ({ experimental: true }) });
    try {
        await tick(); await tick(); assert.equal(calls.length, 3);
        assert.ok(reads.take('/api/get_weighted_workspace', body));
        assert.equal(calls.some(call => call.url === '/api/get_comparison_profiles'), false);
    }
    finally { reads.stop(); }
});

test('server-resolved anonymous categories start the ranking without waiting for navigation or profiles', async () => {
    const { reads, calls } = fixture({ bootstrap: { content: String(FEATURED_TOPIC_ID), dataset: { guest: 'true' } } });
    try {
        await tick(); await tick();
        assert.equal(calls[0].url, '/api/get_weighted_workspace');
        assert.equal(calls.filter(call => call.url === '/api/get_weighted_workspace').length, 1);
        assert.ok(await reads.take('/api/get_weighted_workspace', body));
    } finally { reads.stop(); }
});

test('account/storage changes expire unclaimed data; private categories never start speculative reads', async () => {
    const { reads, calls, listeners } = fixture();
    listeners.get('storage')();
    await tick(); await tick();
    assert.equal(calls.length, 2);
    assert.equal(reads.take('/api/get_comparison_profiles', {}), null);
    assert.ok(calls.every(call => call.options.signal.aborted));
    assert.equal(startHomeReads({ location: { pathname: '/personal/1' }, fetch() { throw new Error('private request'); } }), null);
});

test('consumer cancellation aborts its one claimed read', async () => {
    const { reads, calls } = fixture();
    const controller = new AbortController();
    try {
        await reads.take('/api/get_page' + topicPath, { treeOnly: true }, { signal: controller.signal });
        assert.equal(calls[0].url, '/api/get_page' + topicPath);
        controller.abort();
        assert.equal(calls[0].options.signal.aborted, true);
    } finally { reads.stop(); }
});

test('a failed speculative read retries as a normal read instead of failing startup', async () => {
    const calls = [];
    const { reads } = fixture({ fetch: async (url, options) => {
        calls.push({ url, options });
        if (url === '/api/get_user_profile' && calls.filter(call => call.url === url).length === 1) throw new TypeError('network failure');
        return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    } });
    try {
        await tick();
        assert.equal((await reads.take('/api/get_user_profile')).status, 200);
        assert.equal(calls.filter(call => call.url === '/api/get_user_profile').length, 2);
        assert.equal(reads.take('/api/get_user_profile'), null);
    } finally { reads.stop(); }
});

test('a cancelled claimed read is not retried', async () => {
    let calls = 0;
    const controller = new AbortController();
    const { reads } = fixture({ fetch: async (url, options) => {
        if (url !== '/api/get_user_profile') return new Response('{}');
        calls++;
        return new Promise((resolve, reject) => options.signal.addEventListener('abort',
            () => reject(options.signal.reason), { once: true }));
    } });
    try {
        const response = reads.take('/api/get_user_profile', undefined, { signal: controller.signal });
        await tick(); controller.abort();
        await assert.rejects(response, { name: 'AbortError' });
        assert.equal(calls, 1);
    } finally { reads.stop(); }
});
