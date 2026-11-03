import assert from 'node:assert/strict';
import test from 'node:test';
import { createRankingPager } from '../ranking-pagination.js';
import { readHomeModelFocusIntent, consumeHomeModelFocusURL, withHomeFocusComparison,
    createHomeModelFocus, validateModelLocatePayload, loadModelFocusStyles } from '../public/js/workspace/model-focus.js';
import { normalizeModelFocusTarget, findModelFocusIndex, markModelFocusTarget,
    findRenderedModelFocus } from '../public/js/workspace/model-focus-target.js';
import { readComparisonSettings, writeComparisonSettings } from '../public/js/workspace/comparison-settings.js';
import { createModelListView } from '../public/js/workspace/model-list.js';

const identity = ID => JSON.stringify([['model', true, ID]]);
const intentFor = (target = identity(72), extra = '') => readHomeModelFocusIntent(
    `https://benchpoll.test/language-models?focusModel=${encodeURIComponent(target)}&scoreMode=range&mode=public${extra}`);
class Events {
    listeners = new Map();
    addEventListener(type, callback) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(callback);
    }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    emit(type, values = {}) { for (const callback of this.listeners.get(type) ?? []) callback({ type, ...values }); }
}
function harness({ target = identity(72), reduced = false, request, manualFrame = false, intent = intentFor(target), isPrivate = false } = {}) {
    const models = Array.from({ length: 120 }, (_, index) => ({
        ID: index + 1, modelID: index + 1, comparisonIdentity: identity(index + 1), name: `Model ${index + 1}`,
        lower: 120 - index, upper: 120 - index, coverage: 100, missingWeight: 0, comparable: true,
        inferredScores: [], availableInference: null, calculationScores: [{ conditionID: 1,
            normalizedScore: 120 - index, effectiveWeight: 100, contribution: 120 - index,
            fallbackFor: null, memberIDs: [index + 1], memberWeights: [{ ID: index + 1, weight: 1 }],
            memberEvidence: [{ ID: index + 1, hash: 'a'.repeat(64) }] }]
    }));
    const pager = createRankingPager();
    const initial = pager.create({ scoreMode: 'range', benchmarks: [], personalPie: { entries: [] },
        modelLeaderboards: { public: isPrivate ? [] : models, personal: isPrivate ? models : [] } },
    { initialMode: isPrivate ? 'personal' : 'public' });
    const state = { loadSequence: 1, loading: false, comparisonPending: false, categoryID: 1, mode: isPrivate ? 'personal' : 'public',
        scoreMode: 'range', userID: null, selectedContextValues: {}, contextIsPrivate: isPrivate,
        comparisonRequest: { mode: 'best', keys: ['model'], filters: [] },
        rankingPagination: initial.rankingPagination, modelLeaderboards: initial.modelLeaderboards };
    const requests = [], messages = [], frames = [], timers = new Map(), timeouts = [];
    let timerID = 0, focusPage = null, rendered = [], rankingShown = 0;
    const doc = { activeElement: null };
    const render = models => { rendered = models.map(model => {
        const classes = new Set();
        const row = Object.assign(new Events(), { dataset: {}, ownerDocument: doc,
            classList: { add: key => classes.add(key), remove: key => classes.delete(key), contains: key => classes.has(key) },
            focusCalls: [], scrollCalls: [], focus(options) { doc.activeElement?.blur(); doc.activeElement = this; this.focusCalls.push(options); },
            blur() { if (doc.activeElement === this) doc.activeElement = null; this.emit('blur'); },
            scrollIntoView(options) { this.scrollCalls.push(options); }, closest: () => null, getClientRects: () => [{}] });
        markModelFocusTarget(row, model);
        return row;
    }); };
    render(initial.modelLeaderboards[state.mode]);
    const rows = { scrollTop: 0, scrollLeft: 0, querySelector: () => null,
        querySelectorAll: () => rendered, scrollTo() {} };
    const view = { getFocusPage: () => focusPage, setFocusPage(page) {
        focusPage = page;
        render(page?.items ?? state.modelLeaderboards[state.mode]);
    } };
    const win = Object.assign(new Events(), { scrollX: 0, scrollY: 0, scrollTo() {},
        setTimeout(callback, duration) { timeouts.push(duration); timers.set(++timerID, callback); return timerID; },
        clearTimeout: ID => timers.delete(ID), matchMedia: () => ({ matches: reduced }),
        requestAnimationFrame(callback) { if (manualFrame) frames.push(callback); else queueMicrotask(callback); } });
    const events = new Events();
    const controller = createHomeModelFocus({ intent, state, rows, view, win, events, loadStyles: async () => {},
        onMessage: message => messages.push(message), showRanking: () => rankingShown++,
        request: async (path, body, options) => {
            requests.push({ path, body, options });
            return request ? request(path, body, options) : path === '/api/locate_ranking_model'
                ? pager.locateModel(body) : pager.getPage(body);
        } });
    return { controller, state, view, requests, messages, win, events, frames, timers, timeouts, pager, doc,
        get rows() { return rendered; }, get shown() { return rankingShown; } };
}

test('ordinary no-intent startup tolerates a null focus page before any ranking snapshot exists', async () => {
    const oldWindow = globalThis.window, oldDocument = globalThis.document;
    const element = () => ({ setAttribute() {}, append() {}, replaceChildren() {}, closest: () => element() });
    globalThis.document = { getElementById: () => element(), createElement: element, querySelector: () => null };
    globalThis.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, ResizeObserver: class { observe() {} } };
    try {
        const state = { mode: 'public', rankingPagination: null };
        const view = createModelListView({ state, modelRows: element(), onNeedMore() {} });
        assert.equal(view.getFocusPage(), null);
        let requests = 0, displayed = 0;
        const win = Object.assign(new Events(), { clearTimeout() {} });
        const controller = createHomeModelFocus({ intent: null, state, rows: {}, win, events: new Events(),
            view: { getFocusPage: view.getFocusPage, setFocusPage: page => view.setFocusPage(page, { render: false }) },
            request() { requests++; }, onMessage() { displayed++; }, showRanking() { displayed++; },
            loadStyles() { throw new Error('No-intent startup must not load focus styling'); } });
        controller.suspend();
        await controller.reveal();
        assert.equal(view.getFocusPage(), null);
        assert.equal(controller.pending, false);
        assert.equal(requests, 0);
        assert.equal(displayed, 1, 'Clearing an old focus notice is harmless during ordinary startup');
        state.rankingPagination = { snapshotID: 'snapshot' };
        assert.equal(view.getFocusPage(), null);
        controller.destroy();
    } finally { globalThis.window = oldWindow; globalThis.document = oldDocument; }
});

test('a search jump loads both neighboring pages so a page-boundary result can be centered', async () => {
    const h = harness({ intent: null });
    await h.controller.start(identity(26));
    const page = h.view.getFocusPage();
    assert.equal(page.offset, 0);
    assert.equal(page.items.length, 75);
    assert.equal(page.items[25].comparisonIdentity, identity(26));
    const row = h.rows.find(item => item.dataset.comparisonIdentity === identity(26));
    assert.equal(row.scrollCalls[0].block, 'center');
    assert.equal(row.classList.contains('is-model-jump-focus'), true);
    assert.equal(h.requests.filter(request => request.path === '/api/get_ranking_page').length, 2);
});

test('Home focus parses explicit comparison intent and removes only its one-shot URL parameters', () => {
    const target = JSON.stringify([['field:20', true, 201], ['model', true, 301]]);
    const intent = intentFor(target, '&compareReasoning=1&compareHarness=0');
    assert.deepEqual(intent, { valid: true, targetModel: target, scoreMode: 'range', mode: 'public',
        comparison: { reasoning: true, harness: false }, keys: ['field:20', 'model'] });
    let replaced;
    const win = { location: { href: `https://benchpoll.test/language-models?context_budget=fast&discussion=1&focusModel=${encodeURIComponent(target)}&scoreMode=range&compareReasoning=1&compareHarness=0&mode=public#model-card` },
        history: { state: { keep: true }, replaceState: (...args) => { replaced = args; } } };
    consumeHomeModelFocusURL(win);
    assert.deepEqual(replaced, [{ keep: true }, '', '/language-models?context_budget=fast&discussion=1#model-card']);
    assert.equal(readHomeModelFocusIntent('https://benchpoll.test/language-models?mode=public'), null);
    win.location.href = 'https://benchpoll.test/topic?source=home&context_budget=extended&focusModel=42&mode=personal#model-card';
    consumeHomeModelFocusURL(win);
    assert.equal(replaced[2], '/topic?source=home&context_budget=extended#model-card');
});

test('lazy focus styles use the public root, including when the importer lives in a build chunk', async () => {
    let link;
    const callbacks = new Map();
    const doc = { getElementById: () => link, createElement: () => ({ addEventListener: (event, callback) => callbacks.set(event, callback) }),
        head: { append(value) { link = value; callbacks.get('load')(); } } };
    await loadModelFocusStyles(doc);
    assert.equal(new URL(link.href, 'https://benchpoll.test/build/home/shared-HASH.js').pathname, '/css/workspace-model-focus.css');
    assert.equal(link.id, 'model-focus-styles');
    await loadModelFocusStyles(doc);
});

test('invalid or repeated focus parameters are rejected instead of changing ranking preferences', () => {
    for (const query of ['focusModel=', 'focusModel=0', 'focusModel=-3', 'focusModel=1&focusModel=2',
        'focusModel=1&scoreMode=bad', 'focusModel=1&compareHarness=true', 'focusModel=1&compareReasoning=',
        'focusModel=1&mode=invalid', 'focusModel=1&mode=public&mode=public']) {
        assert.deepEqual(readHomeModelFocusIntent(`https://benchpoll.test/topic?${query}`), { valid: false });
    }
    assert.equal(normalizeModelFocusTarget(42), '42');
});

test('exact comparison matching does not degrade to name or numeric prefix matching', () => {
    const models = [{ ID: 9, modelID: 42, name: 'Same', comparisonIdentity: 'exact-one' },
        { ID: 10, modelID: 42, name: 'Same', comparisonIdentity: 'exact-two' }];
    assert.equal(findModelFocusIndex(models, 'exact-two'), 1);
    assert.equal(findModelFocusIndex(models, 'Same'), -1);
    assert.equal(findModelFocusIndex(models, 'exact'), -1);
    assert.equal(findModelFocusIndex(models, '42'), -1);
});

test('temporary Home comparison overrides the first request and rendering without writing account storage', () => {
    const data = new Map(), writes = [];
    const storage = { getItem: key => data.get(key), setItem: (key, value) => { data.set(key, value); writes.push(key); } };
    writeComparisonSettings({ basic: { mode: 'best', keys: ['model', 'field:1'], filters: [] } }, '7', storage);
    const baseline = [...data], initialWrites = writes.length, changes = [], applied = [];
    const button = Object.assign(new Events(), { disabled: false, dataset: { quickComparison: 'reasoning', fieldKey: 'field:20' },
        setAttribute(name, value) { this[name] = value; } });
    const controls = { configureAccount: ID => readComparisonSettings(ID, storage).basic, render() {}, resetToDefault() {} };
    const target = JSON.stringify([['field:20', true, 201], ['model', true, 42]]);
    const wrapped = withHomeFocusComparison({ controls, intent: intentFor(target, '&compareReasoning=1'),
        onChange: value => changes.push(value), onApply: value => applied.push(value),
        root: { querySelectorAll: () => [button] }, storage });
    assert.deepEqual(wrapped.configureAccount('7').keys, ['field:20', 'model']);
    assert.deepEqual(wrapped.requestOptions(), { homeComparison: { reasoning: true, harness: false } });
    wrapped.render({ keys: ['model', 'field:20'], fields: [{ ID: 20, name: 'Thinking effort' }, { ID: 21, name: 'Effort' }],
        availableKeys: ['model', 'field:20', 'field:21'] });
    assert.deepEqual(applied[0].keys, ['model', 'field:20']);
    assert.equal(button['aria-pressed'], 'true');
    assert.equal(button.dataset.fieldKey, 'field:20', 'Home uses the same lowest-ID effort field as its preview API');
    assert.deepEqual([...data], baseline);
    assert.equal(writes.length, initialWrites);
    button.emit('click', { preventDefault() {}, stopImmediatePropagation() {} });
    assert.deepEqual(changes[0].keys, ['model']);
    assert.deepEqual(wrapped.requestOptions(), {});
    assert.deepEqual(readComparisonSettings('7', storage).basic.keys, ['model']);
    assert.equal(writes.length, initialWrites + 1);
});

test('returning to ordinary context restores saved comparison without persisting Home intent', () => {
    let writes = 0;
    const saved = { mode: 'best', keys: ['model', 'field:1'], filters: [] };
    const wrapper = withHomeFocusComparison({ controls: { configureAccount: () => saved, render() {}, resetToDefault() { writes++; } },
        intent: intentFor(), onChange() {}, onApply() {}, root: { querySelectorAll: () => [] } });
    wrapper.configureAccount('7');
    assert.deepEqual(wrapper.reset(), saved);
    assert.deepEqual(wrapper.requestOptions(), {});
    assert.equal(writes, 0);
});

test('a target already loaded is scrolled and highlighted exactly once without a locate request', async () => {
    const h = harness({ target: identity(7) });
    await h.controller.reveal();
    const row = h.rows[6];
    assert.equal(h.requests.length, 0);
    assert.equal(h.shown, 1);
    assert.equal(row.classList.contains('is-model-jump-focus'), true);
    assert.deepEqual(row.focusCalls, [{ preventScroll: true }]);
    assert.deepEqual(row.scrollCalls, [{ behavior: 'smooth', block: 'center', inline: 'center' }]);
    assert.deepEqual(h.timeouts, [1900], 'Automatic emphasis is transient, not an indefinite focused state');
    await h.controller.reveal();
    assert.equal(row.scrollCalls.length, 1);
    for (const callback of h.timers.values()) callback();
    assert.equal(row.classList.contains('is-model-jump-focus'), false);
    assert.equal(row.classList.contains('is-model-jump-auto-focus'), true, 'No persistent native focus rectangle after the highlight fades');
    assert.equal(h.doc.activeElement, row, 'Keyboard continuation still starts at the located model');
    h.controller.destroy();
    assert.equal(row.classList.contains('is-model-jump-auto-focus'), false);
    assert.equal(h.doc.activeElement, null, 'Destroy releases only the focus owned by this automatic jump');
});

test('a real key releases automatic focus suppression without blurring the model', async () => {
    const h = harness({ target: identity(7) });
    await h.controller.reveal();
    const row = h.rows[6];
    h.events.emit('keydown', { key: 'Shift' });
    assert.equal(row.classList.contains('is-model-jump-auto-focus'), true);
    h.events.emit('keydown', { key: 'ArrowRight' });
    assert.equal(row.classList.contains('is-model-jump-auto-focus'), false);
    assert.equal(row.classList.contains('is-model-jump-focus'), false);
    assert.equal(h.doc.activeElement, row);
    h.controller.destroy();
    assert.equal(h.doc.activeElement, row, 'Destroy must not steal genuine keyboard focus');
});

test('pointer and wheel cancellation do not reveal a leftover automatic focus frame', async () => {
    for (const action of ['pointerdown', 'click', 'wheel', 'touchstart', 'input']) {
        const h = harness({ target: identity(7) });
        await h.controller.reveal();
        const row = h.rows[6];
        h.events.emit(action);
        assert.equal(row.classList.contains('is-model-jump-focus'), false);
        assert.equal(row.classList.contains('is-model-jump-auto-focus'), true);
        row.blur();
        assert.equal(row.classList.contains('is-model-jump-auto-focus'), false, 'Suppression must not survive a later keyboard refocus');
        assert.equal(row.listeners.get('blur').size, 0);
        h.controller.destroy();
    }
});

test('suspending or leaving the page cleans up the owned automatic focus and its listener', async () => {
    for (const action of ['suspend', 'pagehide', 'popstate']) {
        const h = harness({ target: identity(7) });
        await h.controller.reveal();
        const row = h.rows[6];
        if (action === 'suspend') h.controller.suspend();
        else h.win.emit(action);
        assert.equal(row.classList.contains('is-model-jump-auto-focus'), false);
        assert.equal(row.classList.contains('is-model-jump-focus'), false);
        assert.equal(h.doc.activeElement, null);
        assert.equal(row.listeners.get('blur').size, 0);
        h.controller.destroy();
    }
});

test('a deep target is located in one request and does not turn a jump into loaded-prefix progress', async () => {
    const h = harness();
    const originalModels = h.state.modelLeaderboards.public;
    const originalPage = structuredClone(h.state.rankingPagination.public);
    await h.controller.reveal();
    assert.deepEqual(h.requests.map(item => item.path), ['/api/locate_ranking_model']);
    assert.equal(h.view.getFocusPage().offset, 50);
    assert.equal(h.view.getFocusPage().items.length, 25);
    const target = findRenderedModelFocus({ querySelectorAll: () => h.rows }, identity(72));
    assert.equal(target.classList.contains('is-model-jump-focus'), true);
    assert.equal(h.state.modelLeaderboards.public, originalModels);
    assert.deepEqual(h.state.rankingPagination.public, originalPage);
    await h.controller.loadPage(75);
    assert.equal(h.view.getFocusPage().offset, 75);
    assert.deepEqual(h.state.rankingPagination.public, originalPage);
    assert.deepEqual(h.requests.map(item => item.body.offset), [undefined, 75]);
    h.controller.backToTop();
    assert.equal(h.view.getFocusPage(), null);
    assert.equal(h.rows.length, 25);
    assert.equal(h.state.rankingPagination.public.nextOffset, 25);
    h.controller.destroy();
});

test('private Home previews locate personal rankings and never request the public leaderboard', async () => {
    for (const mode of ['personal', 'public']) {
        const intent = readHomeModelFocusIntent(`https://benchpoll.test/personal/1/topic?focusModel=${encodeURIComponent(identity(72))}&scoreMode=range&mode=${mode}`);
        const h = harness({ intent, isPrivate: true });
        const before = structuredClone(h.state.rankingPagination.personal);
        await h.controller.reveal();
        assert.equal(h.requests.length, 1);
        assert.equal(h.requests[0].body.list, 'personal');
        assert.equal(h.view.getFocusPage().list, 'personal');
        assert.equal(h.shown, 1);
        assert.deepEqual(h.state.rankingPagination.personal, before);
        assert.equal(h.rows.some(row => row.classList.contains('is-model-jump-focus')), true);
        h.controller.destroy();
    }
});

test('reduced motion uses immediate scrolling but retains a brief nonanimated exact-target emphasis', async () => {
    const h = harness({ reduced: true, target: identity(3) });
    await h.controller.reveal();
    assert.equal(h.rows[2].scrollCalls[0].behavior, 'auto');
    assert.equal(h.rows[2].classList.contains('is-model-jump-focus'), true);
    h.events.emit('wheel');
    assert.equal(h.rows[2].classList.contains('is-model-jump-focus'), false);
    h.controller.destroy();
});

test('missing or invalid targets leave the current ranking available without highlighting a substitute', async () => {
    for (const options of [{ target: identity(999) }, { intent: { valid: false } }]) {
        const h = harness(options);
        await h.controller.reveal();
        assert.equal(h.view.getFocusPage(), null);
        assert.equal(h.shown, 1, 'Missing and invalid links still expose the actual ranking and its notice');
        assert.ok(h.messages.at(-1));
        assert.equal(h.rows.some(row => row.scrollCalls.length || row.classList.contains('is-model-jump-focus')), false);
        h.controller.destroy();
    }
});

for (const action of ['pointerdown', 'click', 'keydown', 'wheel', 'touchstart', 'input']) {
    test(`${action} cancels a pending locate even when the transport ignores abort`, async () => {
        let complete;
        const h = harness({ request: (_path, body) => new Promise(resolve => { complete = () => resolve(h.pager.locateModel(body)); }) });
        const work = h.controller.reveal();
        await Promise.resolve();
        h.events.emit(action, { key: 'ArrowDown' });
        assert.equal(h.requests[0].options.signal.aborted, true);
        complete();
        await work;
        assert.equal(h.view.getFocusPage(), null);
        assert.equal(h.shown, 0);
        assert.equal(h.messages.filter(Boolean).length, 0);
        h.controller.destroy();
    });
}

test('a frame queued before a context change cannot perform a late scroll or highlight', async () => {
    const h = harness({ target: identity(7), manualFrame: true });
    const work = h.controller.reveal();
    await Promise.resolve();
    h.state.loadSequence++;
    h.controller.suspend();
    h.frames.splice(0).forEach(callback => callback());
    await work;
    assert.equal(h.rows.some(row => row.scrollCalls.length), false);
    h.controller.destroy();
});

test('changed snapshot scope and stale locate results are discarded without changing the current page', async () => {
    let complete;
    const h = harness({ request: (_path, body) => new Promise(resolve => { complete = () => resolve(h.pager.locateModel(body)); }) });
    const work = h.controller.reveal();
    await Promise.resolve();
    h.state.rankingPagination = { ...h.state.rankingPagination, snapshotID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
    complete();
    await work;
    assert.equal(h.view.getFocusPage(), null);
    assert.equal(h.shown, 0);
    h.controller.destroy();
});

test('wrong-target, wrong-snapshot and malformed target pages are rejected', () => {
    const h = harness();
    const args = { snapshotID: h.state.rankingPagination.snapshotID, list: 'public', targetModel: identity(72), scoreMode: 'range', total: 120 };
    const result = h.pager.locateModel(args);
    assert.equal(validateModelLocatePayload(result, args), result);
    for (const override of [{ snapshotID: 'bad' }, { list: 'personal' }, { targetModel: identity(73) },
        { targetOffset: 70 }, { offset: 49 }, { page: { ...result.page, total: 121 } },
        { found: false }, { page: { ...result.page, scoreMode: 'available' } }]) {
        assert.throws(() => validateModelLocatePayload({ ...result, ...override }, args));
    }
    h.controller.destroy();
});

for (const status of [403, 410, 500]) {
    test(`locate ${status} keeps the ranking available and gives an actionable one-shot-link notice`, async () => {
        const h = harness({ request: async () => { throw Object.assign(new Error('Snapshot unavailable'), { status }); } });
        await h.controller.reveal();
        assert.equal(h.shown, 1);
        assert.equal(h.controller.pending, false);
        assert.equal(h.view.getFocusPage(), null);
        assert.equal(h.rows.some(row => row.scrollCalls.length), false);
        assert.equal(h.requests.length, 1);
        assert.equal(h.messages.at(-1), status === 500
            ? 'Could not locate this model. The current ranking is still available.'
            : 'This ranking changed. Open the model again from Home.');
        h.controller.destroy();
    });
}

test('untrusted locate payloads cannot render or highlight a different model', async () => {
    const h = harness({ request: (_path, body) => ({ ...h.pager.locateModel(body), targetModel: identity(73) }) });
    await h.controller.reveal();
    assert.equal(h.view.getFocusPage(), null);
    assert.equal(h.rows.some(row => row.scrollCalls.length), false);
    assert.match(h.messages.at(-1), /Could not locate/);
    h.controller.destroy();
});

test('focus page navigation rejects invalid offsets before requesting another page', async () => {
    const h = harness();
    await h.controller.reveal();
    const page = h.view.getFocusPage();
    for (const offset of [-25, 1, 26, 125, Number.NaN, '75']) await h.controller.loadPage(offset);
    assert.equal(h.requests.length, 1);
    assert.equal(h.view.getFocusPage(), page);
    h.controller.destroy();
});

test('partial target pages and changed totals do not replace a complete current page', async () => {
    for (const malformed of ['partial', 'total']) {
        const h = harness({ request: (path, body) => {
            if (path.endsWith('locate_ranking_model')) return h.pager.locateModel(body);
            const page = h.pager.getPage(body);
            return malformed === 'partial' ? { ...page, items: page.items.slice(0, -1), nextOffset: page.nextOffset - 1, hasMore: true }
                : { ...page, total: page.total + 1 };
        } });
        await h.controller.reveal();
        const previous = h.view.getFocusPage();
        await h.controller.loadPage(75);
        assert.equal(h.view.getFocusPage().offset, previous.offset);
        assert.equal(h.view.getFocusPage().items, previous.items);
        assert.match(h.view.getFocusPage().error, /Could not load/);
        h.controller.destroy();
    }
});

test('a cancelled page request cannot replace the current focus page or leave it loading', async () => {
    let complete;
    const h = harness({ request: (path, body) => path.endsWith('locate_ranking_model') ? h.pager.locateModel(body)
        : new Promise(resolve => { complete = () => resolve(h.pager.getPage(body)); }) });
    await h.controller.reveal();
    const previous = h.view.getFocusPage();
    const task = h.controller.loadPage(75);
    assert.equal(h.view.getFocusPage().loading, true);
    h.events.emit('keydown', { key: 'Escape' });
    assert.equal(h.requests.at(-1).options.signal.aborted, true);
    complete();
    await task;
    assert.equal(h.view.getFocusPage().offset, previous.offset);
    assert.equal(h.view.getFocusPage().loading, false);
    assert.equal(h.view.getFocusPage().error, '');
    h.controller.destroy();
});

test('the ranking is exposed before focusing a row previously hidden by a composition view', async () => {
    const h = harness({ target: identity(7), manualFrame: true });
    const row = h.rows[6];
    row.closest = () => h.shown ? null : { hidden: true };
    row.getClientRects = () => h.shown ? [{}] : [];
    const task = h.controller.reveal();
    await Promise.resolve();
    assert.equal(h.shown, 1);
    assert.equal(row.focusCalls.length, 0);
    h.frames.splice(0).forEach(callback => callback());
    await task;
    assert.equal(row.focusCalls.length, 1);
    assert.equal(row.classList.contains('is-model-jump-focus'), true);
    h.controller.destroy();
});
