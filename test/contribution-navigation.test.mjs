import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = (await readFile(new URL('../public/js/shared/contribution-navigation.js', import.meta.url), 'utf8'))
    .replace(/^export /gm, '');
const prefix = 'benchpoll:contribution-entry:';
const lifetime = 30 * 60 * 1000;

function storage() {
    const data = new Map();
    const calls = { access: 0, reads: 0, writes: 0, removes: 0 };
    return { data, calls, denied: false,
        get length() { return data.size; }, key(index) { return [...data.keys()][index] ?? null; },
        getItem(key) { calls.reads++; return data.get(key) ?? null; },
        setItem(key, value) { calls.writes++; data.set(key, value); },
        removeItem(key) { calls.removes++; data.delete(key); }
    };
}

function fixture(local = storage()) {
    let now = 1000000, navigationType = 'navigate';
    const session = storage(), listeners = new Map();
    const context = vm.createContext({ URL, URLSearchParams,
        Date: class extends Date { static now() { return now; } },
        performance: { getEntriesByType: () => [{ type: navigationType }] },
        document: { addEventListener(type, handler) {
            const handlers = listeners.get(type) ?? []; handlers.push(handler); listeners.set(type, handlers);
        } },
        history: { state: null, replaceState(state, _title, path) {
            this.state = state; context.location = new URL(path, context.location); context.window.location = context.location;
        } },
        window: { crypto: { randomUUID }, location: new URL('https://benchpoll.test/Intelligence') }
    });
    const getLocal = () => {
        local.calls.access++;
        if (local.denied) throw new Error('Synthetic storage denied');
        return local;
    };
    Object.defineProperty(context, 'localStorage', { get: getLocal });
    Object.defineProperty(context.window, 'localStorage', { get: getLocal });
    context.sessionStorage = session; context.location = context.window.location;
    vm.runInContext(source, context);
    return { context, local, session, listeners,
        build: (mode, values) => context.buildContributionURL(mode, values),
        activate: url => context.activateContributionURL(url),
        advance(ms) { now += ms; }, now: () => now,
        read(url, type = 'navigate') {
            navigationType = type; context.location = new URL(url, context.location); context.window.location = context.location;
            return context.readContributionEntry();
        },
        fire(type, url, options = {}) {
            const link = { href: new URL(url, context.location).href, matches: selector => selector === 'a[href]',
                hasAttribute: name => name === 'download' && options.download === true };
            const event = { type, button: 0, isTrusted: true, defaultPrevented: false, ...options,
                composedPath: () => [{ matches: () => false }, link],
                preventDefault() { this.defaultPrevented = true; } };
            for (const handler of listeners.get(type) ?? []) handler(event);
            return event;
        }
    };
}

test('rendering/deduplicating prefill URLs never reads, writes or cleans browser storage', () => {
    const f = fixture(); f.local.denied = true;
    assert.equal(f.build('feedback'), '/contribute/feedback');
    const first = f.build('feedback', { details: 'Synthetic request', unknown: 'ignored' });
    assert.match(first, /^\/contribute\/feedback#entry=[0-9a-f-]{36}$/);
    assert.equal(f.build('feedback', { details: 'Synthetic request' }), first);
    f.build('new_model', { modelName: 'Synthetic model' });
    assert.deepEqual(f.local.calls, { access: 0, reads: 0, writes: 0, removes: 0 });
    assert.equal(f.session.calls.writes, 0);
    for (const handlers of f.listeners.values()) assert.equal(handlers.length, 1);
});

test('only the activated URL is persisted, with expiry measured from activation rather than render', () => {
    const f = fixture();
    const chosen = f.build('new_benchmark', { benchmarkName: 'Synthetic benchmark' });
    f.build('feedback', { details: 'Unselected request' });
    f.advance(2 * lifetime);
    assert.equal(f.activate(chosen), chosen);
    assert.equal(f.local.data.size, 1);
    const record = JSON.parse([...f.local.data.values()][0]);
    assert.equal(record.expiresAt, f.now() + lifetime);
    f.advance(10); f.activate(chosen);
    assert.equal(f.local.data.size, 1);
    assert.equal(JSON.parse([...f.local.data.values()][0]).expiresAt, f.now() + lifetime);
});

test('primary, keyboard-generated, modified, new-tab and middle-click activations keep native defaults', () => {
    for (const [type, options] of [
        ['click', {}], ['click', { detail: 0 }], ['click', { ctrlKey: true }], ['click', { metaKey: true }],
        ['click', { shiftKey: true }], ['auxclick', { button: 1 }], ['contextmenu', { button: 2 }]
    ]) {
        const f = fixture(), url = f.build('feedback', { details: 'Synthetic activation' });
        const event = f.fire(type, url, options);
        assert.equal(f.local.calls.writes, 1);
        assert.equal(event.defaultPrevented, false);
        assert.equal(f.session.calls.writes, 0);
    }
});

test('passive interactions, canceled/download links, unrelated origins and wrong paths never persist', () => {
    const f = fixture(), url = f.build('feedback', { details: 'Synthetic request' });
    for (const type of ['focusin', 'pointerdown', 'mousedown', 'mouseover', 'keydown']) f.fire(type, url);
    f.fire('click', url, { defaultPrevented: true });
    f.fire('click', url, { isTrusted: false });
    f.fire('click', url, { download: true });
    f.fire('click', url, { button: 2 });
    f.fire('auxclick', url, { button: 2 });
    f.fire('click', 'https://external.test' + url);
    f.fire('click', url.replace('/feedback', '/models/new'));
    f.fire('click', '/contribute/feedback#entry=unknown');
    assert.equal(f.local.calls.access, 0);
    assert.equal(f.local.calls.writes, 0);
});

test('cleanup is delayed until activation and touches only expired/malformed handoffs', () => {
    const f = fixture();
    f.local.data.set(prefix + 'expired', JSON.stringify({ expiresAt: f.now() - 1 }));
    f.local.data.set(prefix + 'malformed', 'not-json');
    f.local.data.set(prefix + 'missing-expiry', '{}');
    f.local.data.set(prefix + 'live', JSON.stringify({ expiresAt: f.now() + lifetime }));
    f.local.data.set('unrelated-preference', 'unchanged');
    const url = f.build('feedback', { details: 'Synthetic request' });
    assert.equal(f.local.calls.removes, 0); assert.equal(f.local.calls.reads, 0);
    f.activate(url);
    assert.equal(f.local.calls.removes, 3);
    assert.equal(f.local.data.has(prefix + 'live'), true);
    assert.equal(f.local.data.has('unrelated-preference'), true);
});

test('prefill survives noopener/new-tab reads, route precedence, reload and back/forward', () => {
    const f = fixture();
    const url = f.build('edit_benchmark', { targetBenchmarkID: '42', targetConditionID: '7', mode: 'feedback' });
    f.activate(url);
    const secondTab = fixture(f.local);
    const first = secondTab.read(url);
    assert.equal(first.error, null);
    assert.equal(first.params.get('mode'), 'edit_benchmark');
    assert.equal(first.params.get('targetBenchmarkID'), '42');
    assert.equal(first.params.get('targetConditionID'), '7');
    assert.equal(secondTab.context.location.hash, '');
    assert.equal(secondTab.session.calls.writes, 1);
    for (const type of ['reload', 'back_forward']) {
        const restored = secondTab.read('/contribute/benchmarks/42/edit', type);
        assert.equal(restored.error, null); assert.equal(restored.params.get('targetConditionID'), '7');
    }
    assert.equal(fixture(f.local).read(url).error, null, 'Another tab may open the same requested link');
});

test('expired or mismatched prefill is rejected without writing a form session', () => {
    const f = fixture(), url = f.build('edit_model', { targetModelID: '42', modelName: 'Synthetic model' });
    f.activate(url); f.advance(lifetime);
    assert.match(f.read(url).error, /expired/); assert.equal(f.session.calls.writes, 0);
    f.activate(url);
    assert.match(f.read(url.replace('/42/', '/43/')).error, /expired/);
    assert.equal(f.session.calls.writes, 0);
});

test('denied/quota-limited storage does not throw during rendering or default navigation', () => {
    for (const failure of ['denied', 'quota']) {
        const f = fixture(), url = f.build('feedback', { details: 'Synthetic request' });
        if (failure === 'denied') f.local.denied = true;
        else f.local.setItem = () => { throw new Error('Synthetic quota exceeded'); };
        assert.equal(f.activate(url), url);
        assert.equal(f.fire('click', url).defaultPrevented, false);
        assert.ok(f.read(url).error);
        assert.equal(f.session.calls.writes, 0);
    }
});

test('legacy query handoffs still sanitize into a requested per-tab form session', () => {
    const f = fixture();
    const result = f.read('/contribute?mode=feedback&details=Synthetic&unknown=ignored');
    assert.equal(result.error, null); assert.equal(result.params.get('details'), 'Synthetic');
    assert.equal(result.params.has('unknown'), false);
    assert.equal(f.local.calls.writes, 0); assert.equal(f.session.calls.writes, 1);
    assert.equal(f.context.location.pathname, '/contribute/feedback');
    assert.equal(f.context.location.search, '');
});
