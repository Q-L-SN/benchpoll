import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { postJSON } from '../public/js/shared/http.js';
import { hasAADisplayRestriction, AA_DISPLAY_MESSAGE, AA_DISPLAY_RESTRICTION } from '../public/js/shared/aa-ranking-policy.js';

const root = process.env.PANEL_READ_BASELINE ?? fileURLToPath(new URL('../', import.meta.url));
const discussion = await readFile(resolve(root, 'public/js/discussion.js'), 'utf8');
const scores = await readFile(resolve(root, 'public/js/workspace/benchmark-scores.js'), 'utf8');
const flush = async () => { for (let turn = 0; turn < 25; turn++) await Promise.resolve(); };

class Element {
    constructor() { this.attributes = new Map(); this.events = new Map(); this.children = []; this.textContent = ''; this.hidden = false; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(name, handler) { this.events.set(name, handler); }
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    focus() {}
    click() { return this.events.get('click')?.(); }
}

function harness(kind) {
    const elements = new Map();
    const $ = id => {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
    };
    $('benchmark-information').querySelector = selector => selector === '.benchmark-information-meta' ? $('benchmark-meta') : null;
    const errors = [], requests = [];
    const context = vm.createContext({ $, document: { getElementById: $, createElement: () => new Element() },
        postJSON: (url, body, options) => { requests.push({ url, body, options }); return postJSON(url, body, options); },
        console: { error: error => errors.push(error) }, animateContent() {}, mountDisclosureMotion() {},
        setDisclosureOpen() {}, renderInformationWeights() {}, renderContext() {}, restoreDraft() {}, setComposerExpanded() {},
        benchmarkScores: { reset() {} }, URL, Number, Set,
        hasAADisplayRestriction, AA_DISPLAY_MESSAGE, AA_DISPLAY_RESTRICTION,
        pageAccountWriteScope: { bind() {} }, structuredClone, AbortController, isOpen: true, informationOnly: false,
        canReadDiscussion: () => true, syncDiscussionAutoLoad() {},
        readController: null, hasMore: false, retryAppend: null, feedLoaded: false,
        draftKey: () => 'same-draft', renderPost() {}, node: () => new Element(),
        showError(error) { $('discussion-error').textContent = error.message; },
        state: { categoryID: 1, benchmarkID: 101, conditionID: 1, contextValues: {}, threadID: null, offset: 0,
            mentions: [], contextID: null, sort: 'hot', allCategories: false },
        text: { value: '' }, informationSequence: 0, loadSequence: 0, benchmarkInformation: null, loading: false });
    if (kind === 'scores') {
        const code = scores.replace(/^import[\s\S]*?from [^;]+;\r?\n/gm, '').replace('export function', 'function');
        vm.runInContext(`${code}\nthis.view = createBenchmarkScoresView({ onViewChange(show) {
            $('benchmark-scores-view').hidden = !show;
        } });`, context);
    } else {
        const name = kind === 'information' ? 'loadBenchmarkInformation' : 'load';
        const start = discussion.indexOf(`async function ${name}(`);
        const end = discussion.indexOf(kind === 'information' ? '\nfunction contextLabel(' : '\nfunction renderMentions(', start);
        assert.ok(start >= 0 && end > start, 'Extract the actual current loader');
        vm.runInContext(`${discussion.slice(start, end)}\nthis.start = ${name};`, context);
    }
    return { $, errors, requests,
        start: () => kind === 'scores' ? context.view.open({ benchmarkID: 101, conditionID: 1, conditionName: 'Overall' }) : context.start(),
        reset: () => context.view.reset(),
        busy: () => $(kind === 'information' ? 'benchmark-information' : kind === 'discussion' ? 'discussion-feed' : 'benchmark-scores-list').getAttribute('aria-busy') };
}

const response = json => ({ status: 200, ok: true, headers: new Headers({ 'Content-Type': 'application/json' }), json });
for (const repetition of [1, 2]) for (const kind of ['information', 'discussion', 'scores']) {
    for (const phase of ['fetch', 'body']) for (const late of ['resolve', 'reject']) {
        test(`${kind} ${phase} settles at its own deadline and ignores late ${late} (${repetition})`, async t => {
            t.mock.timers.enable({ apis: ['setTimeout'] });
            let resolveWork, rejectWork, signal;
            const work = new Promise((resolve, reject) => { resolveWork = resolve; rejectWork = reject; });
            work.catch(() => {});
            t.mock.method(globalThis, 'fetch', (_url, options) => {
                signal = options.signal;
                return phase === 'fetch' ? work : Promise.resolve(response(() => work));
            });
            const h = harness(kind);
            h.start();
            await flush();
            assert.equal(h.busy(), 'true');
            t.mock.timers.tick(59999);
            await flush();
            assert.equal(h.busy(), 'true', 'Do not terminate an in-budget read');
            t.mock.timers.tick(1);
            await flush();
            assert.equal(h.busy(), 'false', 'A hung fetch or body must stop the busy state');
            assert.equal(h.requests.length, 1);
            assert.equal(h.requests[0].options?.timeoutMs, 60000);
            assert.equal(signal.aborted, true);
            const before = [...h.errors];
            const status = kind === 'scores' ? h.$('benchmark-scores-status').textContent
                : kind === 'information' ? h.$('benchmark-information-status').textContent : h.$('discussion-error').textContent;
            assert.ok(status.length > 0);
            if (kind === 'scores') assert.equal(h.$('benchmark-scores-retry').hidden, false);
            if (late === 'reject') rejectWork(new Error('Obsolete transport failure'));
            else resolveWork(phase === 'fetch' ? response(async () => ({ obsolete: true })) : { obsolete: true });
            await flush();
            assert.equal(h.busy(), 'false');
            assert.deepEqual(h.errors, before);
        });
    }
}

for (const repetition of [1, 2]) for (const action of ['back', 'reset']) {
    test(`scores ${action} retires its busy state before the pending read settles (${repetition})`, async t => {
        let fail;
        const pending = new Promise((_resolve, reject) => { fail = reject; });
        t.mock.method(globalThis, 'fetch', () => pending);
        const h = harness('scores');
        h.start();
        await flush();
        assert.equal(h.busy(), 'true');
        if (action === 'back') h.$('benchmark-scores-back').click();
        else h.reset();
        assert.equal(h.busy(), 'false');
        fail(new Error('Closed read'));
        await flush();
        assert.deepEqual(h.errors, []);
        assert.equal(h.busy(), 'false');
        assert.equal(h.$('benchmark-scores-view').hidden, true);
    });
}
