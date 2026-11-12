import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { categoryDiscussionURL, createDiscussionEntry, setDiscussionEntryView } from '../public/js/workspace/discussion-entry.js';
import { scenePath, parseTopicPath } from '../public/js/shared/topics.js';
import { readRankingContext } from '../public/js/shared/ranking-url.js';
import { orderedScenes } from '../public/js/navigation/scenes.js';
import { createDiscussionAutoLoader } from '../public/js/shared/discussion-auto-load.js';
import { profileAvatarURL } from '../public/js/shared/profile-editor.js';
import { profileURL } from '../public/js/shared/profile-identity.js';
import { createAccountWriteScope, isAccountWriteError } from '../public/js/shared/account-identity.js';
import { hasAADisplayRestriction, AA_DISPLAY_MESSAGE } from '../public/js/shared/aa-ranking-policy.js';

const loadingSource = (await readFile(new URL('../public/js/shared/loading.js', import.meta.url), 'utf8')).replace(/^export /gm, '');

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const source = await read('public/js/discussion.js');
const flush = async () => { for (let turn = 0; turn < 30; turn++) await Promise.resolve(); };
const scenes = [{ ID: 70, sceneNumber: 1, url: '/7/1', name: 'Standard', isDefault: true },
    { ID: 71, sceneNumber: 2, url: '/7/2', name: 'Extended', isDefault: false }];
const customAvatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQSQv4DwADZgHaE5klaQAAAABJRU5ErkJggg==';

class Element {
    constructor(tagName = 'div') {
        this.tagName = tagName; this.className = '';
        this.attributes = new Map(); this.events = new Map(); this.children = []; this.dataset = {};
        this.textContent = ''; this.value = ''; this.hidden = false; this.isConnected = true;
        this.classList = {
            add: name => { if (!this.className.split(' ').includes(name)) this.className = `${this.className} ${name}`.trim(); },
            remove: name => { this.className = this.className.split(' ').filter(item => item !== name).join(' '); },
            toggle: (name, enabled) => { this.classList[enabled ? 'add' : 'remove'](name); }
        };
    }
    get firstChild() { return this.children[0] ?? null; }
    insertBefore(child, anchor) {
        child.remove?.(); child.parentElement = this;
        const index = this.children.indexOf(anchor);
        if (index < 0) this.children.push(child); else this.children.splice(index, 0, child);
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(name, handler) { this.events.set(name, handler); }
    remove() {
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
        this.parentElement = null;
    }
    append(...children) {
        for (const child of children) { child.remove?.(); child.parentElement = this; this.children.push(child); }
    }
    prepend(child) { child.remove(); child.parentElement = this; this.children.unshift(child); }
    before(child) {
        child.remove(); child.parentElement = this.parentElement;
        this.parentElement.children.splice(this.parentElement.children.indexOf(this), 0, child);
    }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    matches(selector) { return selector.startsWith('.') ? this.className.split(' ').includes(selector.slice(1)) : this.tagName === selector; }
    querySelector(selector) { return this.parts?.[selector] ?? this.querySelectorAll(selector)[0] ?? null; }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches?.(selector) ? [child] : []), ...(child.querySelectorAll?.(selector) ?? [])]); }
    closest() { return null; }
    contains(child) { return this === child || this.children.some(item => item.contains?.(child)); }
    focus() { this.focused = true; }
}

function harness({ mobile = false, resolveRequest, sceneOptions = scenes } = {}) {
    const elements = new Map();
    const $ = id => {
        if (/^post-\d+$/.test(id)) return [...elements.values()].flatMap(element => element.querySelectorAll('article')).find(post => post.id === id) ?? null;
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
    };
    const requests = [], errors = [], listeners = new Map();
    const sidebar = new Element(), workspace = new Element(), body = new Element(), media = { matches: mobile, addEventListener() {} };
    sidebar.parts = { '.bp-brand': $('brand') }; sidebar.append($('brand'));
    $('discussion-entry').parts = { '[data-discussion-count]': $('entry-label') };
    $('context-actions').append($('discussion-entry'), $('workspace-refresh'));
    $('benchmark-information').parts = { '.benchmark-information-meta': $('benchmark-meta') };
    for (const id of ['benchmark-scores-view', 'benchmark-information', 'benchmark-discussion-heading']) $(id).hidden = true;
    $('discussion-sort-toggle').append(new Element('i'), new Element('span'));
    const scope = createAccountWriteScope();
    const context = vm.createContext({
        document: { getElementById: $, body, documentElement: { lang: 'en' }, createElement: tag => new Element(tag), createTextNode: value => ({ textContent: value }),
            addEventListener(name, callback) { listeners.set(`document:${name}`, callback); },
            querySelector(selector) { return selector === '.bp-shell > .bp-sidebar' ? sidebar : selector === '.bp-workspace' ? workspace : $('sort'); },
            querySelectorAll(selector) {
                if (selector === '.bp-discussion-author[data-profile-self="true"]') return [$('thread-root'), $('discussion-feed')]
                    .flatMap(host => host.querySelectorAll('.bp-discussion-author')).filter(author => author.dataset.profileSelf === 'true');
                return [];
            } },
        window: { matchMedia: () => media, scrollY: 0, scrollTo() {},
            Option: class extends Element { constructor(text, value) { super(); this.textContent = text; this.value = value; } },
            addEventListener(name, callback) { listeners.set(name, callback); } },
        location: new URL('http://localhost/7/1'), URL, URLSearchParams, structuredClone, console, AbortController,
        setDiscussionEntryView, readDiscussionEntryContext: () => null, readRankingContext, orderedScenes, scenePath, parseTopicPath, createDiscussionAutoLoader, profileAvatarURL, profileURL,
        hasAADisplayRestriction, AA_DISPLAY_MESSAGE,
        createAction({ label, href, className = '', iconOnly }) {
            const element = new Element(); element.className = className;
            if (href) element.href = href;
            if (iconOnly) { element.dataset.tooltip = label; element.setAttribute('aria-label', label); }
            else element.textContent = label;
            return element;
        },
        postJSON: async (path, request) => {
            const body = structuredClone(request); requests.push({ path, body });
            if (resolveRequest) {
                const response = resolveRequest(path, body);
                if (response !== undefined) return response;
            }
            if (path === '/api/get_benchmark_information') return { benchmarkID: 101, conditionID: body.conditionID,
                name: 'General knowledge', conditionName: 'Extended', isPrimaryCondition: false, differenceExplanation: 'More questions',
                description: '', scoresUpdatedAt: null };
            return { context: { categoryID: body.categoryID, categoryPath: `topics/${body.categoryID}/reasoning`,
                lineage: [{ ID: body.categoryID, name: 'Reasoning', position: 0 }],
                contextValues: body.contextValues, dimensions: [], scenes: sceneOptions }, contexts: [{ ID: 70, values: { scene: '70' } }],
                root: body.threadID ? { ID: body.threadID, parentID: null, contextValues: { scene: '70' },
                    createdAt: '2026-10-01T00:00:00Z', authorName: 'Fixture', authorAvatarURL: null, mentions: [], text: 'Thread',
                    upvotes: 0, downvotes: 0, myVote: 0, isOwn: false, isDeleted: false } : null,
                authenticated: true, userID: '1', posts: [], total: 0, hasMore: false };
        },
        createBenchmarkScoresView: ({ onViewChange }) => ({ reset() { onViewChange(false); }, open() { onViewChange(true); } }),
        pageAccountWriteScope: scope, isAccountWriteError: error => { errors.push(error); return isAccountWriteError(error); }, buildContributionURL: () => '/contribute',
        animateContent() {}, mountDisclosureMotion() {}, setDisclosureOpen() {}, mountDisclosureChevron() {},
        mountSegmentedControl: () => ({ refresh() {} }), ResizeObserver: class { observe() {} },
        setVisible(element, visible) { element.hidden = !visible; }, relativeDateAge: () => '', loginWithGitHub() {}
    });
    const code = source.replace(/^import[^\r\n]+\r?\n/gm, '')
        .replace("if (params.get('discussion') === '1') await openDiscussion(new URL(location.href));", '');
    vm.runInContext(`${loadingSource}\n${code}\nthis.ui = { state, openDiscussion, closeDiscussion, renderDiscussionScope };`, context);
    listeners.get('benchpoll:discussion-context')({ detail: { categoryID: 7, contextValues: { scene: '70' }, scenes: sceneOptions } });
    const open = async (extra = '') => {
        await context.ui.openDiscussion(new URL(`http://localhost/7/1?discussion=1&categoryID=7&benchmarkID=101&conditionID=901${extra}`));
        assert.equal($('discussion-error').hidden, true, errors.at(-1)?.stack ?? $('discussion-error').textContent);
    };
    return { $, requests, media, listeners, scope, ...context.ui, open,
        async click(id) { await $(id).events.get('click')?.(); await flush(); },
        async scene(value) {
            const tab = $('discussion-context').children.find(tab => tab.dataset.sceneId === String(value));
            assert.ok(tab, 'The scene must exist as an actual tab'); await tab.events.get('click')(); await flush();
        },
        async updateContext(detail) { listeners.get('benchpoll:discussion-context')({ detail }); await flush(); } };
}

for (const { label, categoryPath, metadata, expected } of [
    { label: 'the explicit topic name', categoryPath: 'topics/7/vision-language',
        metadata: { categoryName: 'Vision/Language', lineage: [{ name: 'Legacy root' }, { name: 'Ignored lineage name' }] }, expected: 'Vision/Language' },
    { label: 'the final lineage name', categoryPath: 'topics/7/reasoning',
        metadata: { lineage: [{ name: 'Legacy root' }, { name: 'Reasoning' }] }, expected: 'Reasoning' },
    { label: 'legacy path fallback', categoryPath: 'Legacy/Reasoning', metadata: {}, expected: 'Legacy / Reasoning' }
]) {
    test(`weight labels use ${label} without adding a topic subtitle below Discussion`, async () => {
        const h = harness({ resolveRequest: (path, body) => {
            if (path !== '/api/get_discussion') return undefined;
            return { context: { categoryID: body.categoryID, categoryPath, ...metadata,
                contextValues: body.contextValues, dimensions: [], scenes }, contexts: [], root: null,
            authenticated: true, userID: '1', posts: [], total: 0, hasMore: false };
        } });
        await h.openDiscussion(new URL('http://localhost/7/1?discussion=1&categoryID=7'));
        assert.equal(h.$('discussion-error').hidden, true);
        await h.open();
        h.$('discussion-text').value = 'Keep the scoped draft';
        const detail = { categoryID: 7, categoryPath, ...metadata, contextValues: { scene: '70' },
            isPrivate: false, mode: 'personal', personal: [{ conditionID: 901, weightBasisPoints: 4500 }],
            public: [{ conditionID: 901, weightBasisPoints: 1234 }] };
        h.listeners.get('benchpoll:context-weights')({ detail });
        assert.equal(h.$('benchmark-information-weights').hidden, false);
        assert.equal(h.$('benchmark-weight-context').textContent, `${expected} / Standard`);
        assert.equal(h.$('benchmark-information-weights').getAttribute('aria-label'), `Benchmark weights in ${expected} / Standard`);
        assert.equal(h.$('benchmark-personal-weight').textContent, '45%');
        assert.equal(h.$('benchmark-public-weight').textContent, '12.34%');
        assert.equal(h.$('discussion-text').value, 'Keep the scoped draft');
        h.listeners.get('benchpoll:context-weights')({ detail: { ...detail, categoryID: 8 } });
        assert.equal(h.$('benchmark-information-weights').hidden, true, 'Weights from another topic remain hidden');
        assert.equal(h.state.categoryID, 7);
        assert.equal(h.scope.capture(), '1');
    });
}

test('scope toggle preserves benchmark, version, category, posting options and draft', async () => {
    const h = harness(); await h.open();
    await h.scene(71);
    h.$('discussion-text').value = 'Keep this benchmark draft';
    assert.deepEqual({ ...h.state.contextValues }, { scene: '71' });
    for (const allCategories of [true, false, true, false]) {
        await h.click('discussion-scope-toggle');
        assert.equal(h.state.allCategories, allCategories);
        assert.equal(h.state.contextID, null);
        assert.equal(h.state.benchmarkID, 101); assert.equal(h.state.conditionID, 901); assert.equal(h.state.categoryID, 7);
        assert.deepEqual({ ...h.state.contextValues }, { scene: '71' });
        assert.equal(h.$('discussion-text').value, 'Keep this benchmark draft');
        assert.equal(h.$('discussion-scope-label').textContent, allCategories ? 'All topics' : 'This topic');
        assert.equal(h.$('discussion-scope-toggle').dataset.tooltip, allCategories ? 'Show this benchmark in this topic' : 'Show this benchmark across all topics');
        assert.equal(h.$('benchmark-discussion-heading').textContent, allCategories
            ? 'Discussion about this benchmark across all topics' : 'Discussion about this benchmark in this topic');
        assert.equal(h.$('discussion-scope-toggle').getAttribute('aria-pressed'), String(allCategories));
        assert.equal(h.$('context-filter-label').hidden, allCategories);
        const request = h.requests.at(-1);
        assert.equal(request.body.allCategories, allCategories); assert.equal(request.body.conditionID, 901);
        assert.equal(h.requests.filter(request => request.path === '/api/get_benchmark_information').length, 1);
    }
});

test('workspace context changes keep the benchmark and all-category scope until category entry navigation', async () => {
    const h = harness();
    await h.updateContext({ categoryID: 7, contextValues: { scene: '70' }, isPrivate: false });
    await h.open(); await h.click('discussion-scope-toggle');
    await h.updateContext({ categoryID: 8, contextValues: { scene: '71' }, isPrivate: false });
    assert.equal(h.state.categoryID, 8); assert.equal(h.state.benchmarkID, 101); assert.equal(h.state.conditionID, 901);
    assert.equal(h.state.allCategories, true);
    assert.equal(h.$('entry-label').textContent, 'Category discussion');
    await h.openDiscussion(new URL('http://localhost/8/2?discussion=1&categoryID=8'));
    assert.equal(h.state.benchmarkID, null); assert.equal(h.state.conditionID, null); assert.equal(h.state.allCategories, false);
    assert.deepEqual({ ...h.state.contextValues }, { scene: '71' });
    assert.equal(h.$('benchmark-information').hidden, true); assert.equal(h.$('discussion-scope-toggle').hidden, true);
    assert.equal(h.$('discussion-title').textContent, 'Discussion');
});

test('mobile benchmark panel keeps category navigation outside the panel until it is closed', async () => {
    const h = harness({ mobile: true }); await h.open();
    assert.equal(h.$('discussion-entry').parentElement, h.$('context-actions'));
    assert.equal(h.$('entry-label').textContent, 'Category discussion');
    await h.openDiscussion(new URL('http://localhost/7/1?discussion=1&categoryID=7'));
    assert.equal(h.$('discussion-entry').parentElement, h.$('context-actions'));
    await h.open(); h.closeDiscussion();
    assert.equal(h.$('discussion-entry').parentElement, h.$('context-actions'));
    assert.equal(h.$('entry-label').textContent, 'Discussions');
});

test('desktop category entry stays in the workspace while the benchmark panel is open', async () => {
    const h = harness(); await h.open();
    assert.equal(h.$('discussion-entry').parentElement, h.$('context-actions'));
    assert.equal(h.$('entry-label').textContent, 'Category discussion');
    await h.openDiscussion(new URL('http://localhost/?discussion=1&categoryID=7'), h.$('discussion-entry'));
    h.closeDiscussion(); assert.equal(h.$('discussion-entry').focused, true);
});

test('benchmark and ordinary discussion drafts stay separate and survive switching', async () => {
    const h = harness(); await h.open(); h.$('discussion-text').value = 'Benchmark draft';
    const categoryURL = new URL('http://localhost/7/1?discussion=1&categoryID=7');
    await h.openDiscussion(categoryURL); assert.equal(h.$('discussion-text').value, '');
    h.$('discussion-text').value = 'Category draft';
    await h.open(); assert.equal(h.$('discussion-text').value, 'Benchmark draft');
    await h.openDiscussion(categoryURL); assert.equal(h.$('discussion-text').value, 'Category draft');
});

test('scope control is absent from ordinary discussion, threads and private information-only panels', async () => {
    const h = harness(); await h.openDiscussion(new URL('http://localhost/?discussion=1&categoryID=7'));
    assert.equal(h.$('discussion-scope-toggle').hidden, true);
    await h.open('&threadID=803'); assert.equal(h.$('discussion-scope-toggle').hidden, true);
    await h.updateContext({ categoryID: 7, contextValues: {}, isPrivate: true });
    await h.open(); assert.equal(h.$('discussion-scope-toggle').hidden, true);
    assert.equal(h.$('benchmark-discussion-view').hidden, true);
    assert.equal(h.$('discussion-composer').hidden, true);
    assert.equal(h.$('discussion-entry').parentElement, h.$('context-actions'));
});

test('scene changes isolate drafts and scope changes preserve the selected scene', async () => {
    const h = harness(); await h.open();
    h.$('discussion-text').value = 'Standard draft';
    await h.scene(71);
    assert.deepEqual({ ...h.state.contextValues }, { scene: '71' });
    assert.equal(h.$('discussion-text').value, '');
    h.$('discussion-text').value = 'Extended draft';
    await h.click('discussion-scope-toggle');
    assert.equal(h.$('discussion-text').value, 'Extended draft');
    assert.deepEqual({ ...h.state.contextValues }, { scene: '71' });
    await h.click('discussion-scope-toggle');
    await h.scene(70);
    assert.equal(h.$('discussion-text').value, 'Standard draft');
    assert.equal(h.$('posting-context').children.length, 0, 'No combinatorial template controls remain');
});

test('scene filter remains hidden without scenes in either scope', async () => {
    const h = harness({ sceneOptions: [] }); await h.openDiscussion(new URL('http://localhost/?discussion=1&categoryID=7&benchmarkID=101'));
    assert.equal(h.$('context-filter-label').hidden, true);
    await h.click('discussion-scope-toggle'); await h.click('discussion-scope-toggle');
    assert.equal(h.$('context-filter-label').hidden, true);
});

test('scope changes leave benchmark information visible when a feed read fails', async () => {
    let fail = false;
    const h = harness({ resolveRequest: path => path === '/api/get_discussion' && fail ? Promise.reject(new Error('fixture_timeout')) : undefined });
    await h.open(); fail = true; await h.click('discussion-scope-toggle');
    assert.equal(h.state.benchmarkID, 101); assert.equal(h.state.allCategories, true);
    assert.equal(h.$('benchmark-information').hidden, false);
    assert.equal(h.$('discussion-error').hidden, false);
    assert.equal(h.$('discussion-feed').getAttribute('aria-busy'), 'false');
});

test('custom author metadata survives scope reloads without changing the posting draft or account scope', async () => {
    const h = harness({ resolveRequest: (path, body) => {
        if (path !== '/api/get_discussion') return undefined;
        return { context: { categoryID: body.categoryID, categoryPath: `topics/${body.categoryID}/reasoning`,
            lineage: [{ ID: body.categoryID, name: 'Reasoning', position: 0 }], contextValues: body.contextValues, dimensions: [], scenes },
        contexts: [], root: null, authenticated: true, userID: '1', total: 1, hasMore: false,
        posts: [{ ID: 803, parentID: null, categoryName: 'Reasoning', contextValues: body.contextValues,
            authorName: 'Server custom name', authorAvatarURL: customAvatar, createdAt: '2026-10-01T00:00:00Z',
            mentions: [], text: 'Evidence', upvotes: 0, downvotes: 0, myVote: 0, isOwn: true, isDeleted: false }] };
    } });
    await h.open();
    const author = () => h.$('discussion-feed').querySelector('.bp-discussion-author');
    assert.equal(author().querySelector('strong').textContent, 'Server custom name');
    assert.equal(author().querySelector('img').src, customAvatar);
    h.$('discussion-text').value = 'Keep the scoped draft';
    h.listeners.get('document:benchpoll:profile-updated')({ detail: { userID: '1', userName: 'New custom name', userProfilePictureURL: null } });
    assert.equal(author().querySelector('strong').textContent, 'New custom name');
    assert.equal(author().querySelector('img'), null);
    await h.click('discussion-scope-toggle');
    assert.equal(h.state.allCategories, true);
    assert.equal(h.requests.at(-1).body.allCategories, true);
    assert.equal(h.requests.at(-1).body.benchmarkID, 101);
    assert.equal(h.requests.at(-1).body.conditionID, 901);
    assert.equal(author().querySelector('strong').textContent, 'New custom name', 'A scope reload cannot restore stale server author metadata');
    assert.equal(author().querySelector('img'), null, 'An explicit reset must not reuse the older server avatar');
    assert.equal(h.$('discussion-text').value, 'Keep the scoped draft');
    assert.deepEqual({ ...h.state.contextValues }, { scene: '70' });
    assert.equal(h.scope.capture(), '1');
});

function entryHarness(t) {
    const entry = new Element(), label = new Element(), events = new Map();
    entry.parts = { '[data-discussion-count]': label };
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { location: { pathname: '/' },
        addEventListener(name, handler) { events.set(name, handler); }, dispatchEvent() {} } });
    t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; });
    return { entry, label, events };
}

test('category URLs keep task context and omit benchmark filters by default', t => {
    entryHarness(t);
    const url = new URL(categoryDiscussionURL(7, { budget: 'extended', language: 'en-US' }), 'http://localhost');
    assert.equal(url.searchParams.get('context_budget'), 'extended'); assert.equal(url.searchParams.get('categoryID'), '7');
    assert.equal(url.searchParams.has('benchmarkID'), false); assert.equal(url.searchParams.has('conditionID'), false);
    assert.equal(new URL(categoryDiscussionURL(7, {}, 101, 901), url).searchParams.get('conditionID'), '901');
});

test('late summary responses do not overwrite the benchmark-mode entry label', async t => {
    const { entry, label } = entryHarness(t);
    let complete;
    t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { complete = resolve; }));
    const update = createDiscussionEntry(entry);
    const pending = update(7, { budget: 'extended' });
    setDiscussionEntryView(entry, true);
    complete(new Response(JSON.stringify({ count: 3 }), { headers: { 'Content-Type': 'application/json' } }));
    await pending;
    assert.equal(label.textContent, 'Category discussion'); assert.equal(entry.dataset.tooltip, 'Open topic discussion');
    setDiscussionEntryView(entry, false); assert.equal(label.textContent, '3 discussions');
    const next = update(7, { scene: '70' });
    assert.equal(label.textContent, 'Discussions', 'A scene change invalidates the previous count immediately');
    complete(new Response(JSON.stringify({ count: 1 }), { headers: { 'Content-Type': 'application/json' } }));
    await next; assert.equal(label.textContent, '1 discussion');
});

test('summary refresh on posted/focus events retains the category-entry mode', async t => {
    const { entry, label, events } = entryHarness(t);
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ count: 1 }), { headers: { 'Content-Type': 'application/json' } }));
    const update = createDiscussionEntry(entry); await update(7, {}); setDiscussionEntryView(entry, true);
    for (const event of ['focus', 'benchpoll:discussion-posted']) {
        events.get(event)(); await flush(); assert.equal(label.textContent, 'Category discussion');
    }
    setDiscussionEntryView(entry, false); assert.equal(label.textContent, '1 discussion');
    await update(7, {}, true); assert.equal(entry.hidden, true);
});

test('an obsolete category summary cannot replace the current category count or URL', async t => {
    const { entry, label } = entryHarness(t), pending = new Map();
    t.mock.method(globalThis, 'fetch', (_url, options) => new Promise(resolve => { pending.set(JSON.parse(options.body).categoryID, resolve); }));
    const update = createDiscussionEntry(entry);
    const first = update(7, { budget: 'standard' }), second = update(8, { budget: 'extended' });
    pending.get(8)(new Response(JSON.stringify({ count: 4 }), { headers: { 'Content-Type': 'application/json' } }));
    await second;
    pending.get(7)(new Response(JSON.stringify({ count: 99 }), { headers: { 'Content-Type': 'application/json' } }));
    await first;
    assert.equal(label.textContent, '4 discussions');
    assert.equal(new URL(entry.href, 'http://localhost').searchParams.get('categoryID'), '8');
    assert.equal(new URL(entry.href, 'http://localhost').searchParams.get('context_budget'), 'extended');
});

test('panel DOM exposes one accessible button instead of checkbox and clear action', async () => {
    const html = await read('private/home.html'), css = await read('public/css/discussion.css');
    assert.doesNotMatch(html, /id="(?:discussion-all-categories|scope-filter-label|clear-benchmark)"/);
    assert.match(html, /<button id="discussion-scope-toggle"[^>]+aria-label="Include all categories"[^>]+aria-pressed="false"[^>]+aria-controls="discussion-feed"/);
    assert.doesNotMatch(html, /id="discussion-category-entry-slot"/);
    assert.match(css, /button\.discussion-scope-toggle[^\n]+border: 0; background: none/);
    assert.match(css, /button\.discussion-scope-toggle:hover[^\n]+background: none; color: var\(--bp-accent\)/);
    assert.doesNotMatch(css, /discussion-scope-toggle[^\n]+(?:border-(?:left|right|top|bottom)|box-shadow)/);
});
