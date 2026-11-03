import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createDiscussionAutoLoader, isDiscussionSentinelNear } from '../public/js/shared/discussion-auto-load.js';
import { createAccountWriteScope, isAccountWriteError } from '../public/js/shared/account-identity.js';
import { scenePath, topicSlug } from '../public/js/shared/topics.js';
import { readRankingContext } from '../public/js/shared/ranking-url.js';
import { orderedScenes } from '../public/js/navigation/scenes.js';
import { profileAvatarURL } from '../public/js/shared/profile-editor.js';
import { hasAADisplayRestriction, AA_DISPLAY_MESSAGE } from '../public/js/shared/aa-ranking-policy.js';

const loadingSource = (await readFile(new URL('../public/js/shared/loading.js', import.meta.url), 'utf8')).replace(/^export /gm, '');

const source = await readFile(new URL('../public/js/discussion.js', import.meta.url), 'utf8');
const actions = await readFile(new URL('../public/js/shared/ui-components.js', import.meta.url), 'utf8');
const actionSource = actions.slice(actions.indexOf('export function configureAction('), actions.indexOf('export function createDisclosureTrigger('))
    .replaceAll('export function', 'function');
const flush = async () => { for (let turn = 0; turn < 35; turn++) await Promise.resolve(); };
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

function geometryHarness({ observers = true } = {}) {
    let targetTop = 700, visible = true, rootTop = 100, allowed = true, calls = 0;
    let serial = 0;
    const frames = new Map(), listeners = new Map(), observersCreated = [];
    class Observer {
        constructor(callback, options) { this.callback = callback; this.options = options; this.targets = []; observersCreated.push(this); }
        observe(target) { this.targets.push(target); }
        disconnect() { this.targets = []; }
    }
    const view = { innerHeight: 900, innerWidth: 1440,
        requestAnimationFrame(callback) { frames.set(++serial, callback); return serial; },
        cancelAnimationFrame(id) { frames.delete(id); },
        addEventListener(type, callback) { listeners.set(`view:${type}`, callback); },
        removeEventListener(type) { listeners.delete(`view:${type}`); },
        ...(observers ? { IntersectionObserver: Observer, ResizeObserver: Observer } : {}) };
    const sentinel = { hidden: false, getClientRects: () => visible ? [{}] : [],
        getBoundingClientRect: () => ({ top: targetTop, bottom: targetTop + 32, left: 10, right: 100 }) };
    const root = { ownerDocument: { defaultView: view }, clientHeight: 500, clientTop: 0,
        contains: target => target === sentinel, getClientRects: () => visible ? [{}] : [],
        getBoundingClientRect: () => ({ top: rootTop, bottom: rootTop + 500, left: 0, right: 400 }),
        addEventListener(type, callback) { listeners.set(type, callback); },
        removeEventListener(type) { listeners.delete(type); } };
    const loader = createDiscussionAutoLoader({ root, sentinel, canLoad: () => allowed, loadMore: () => { calls++; } });
    return { root, sentinel, view, loader, listeners, observersCreated,
        setTop(value) { targetTop = value; }, setRootTop(value) { rootTop = value; },
        setVisible(value) { visible = value; }, setAllowed(value) { allowed = value; },
        get calls() { return calls; }, get queued() { return frames.size; },
        frame() { const current = [...frames.values()]; frames.clear(); current.forEach(callback => callback()); } };
}

test('sentinel geometry uses the panel root, not the window bottom', () => {
    const h = geometryHarness();
    assert.equal(isDiscussionSentinelNear(h.root, h.sentinel), true);
    h.setTop(761); assert.equal(isDiscussionSentinelNear(h.root, h.sentinel), false);
    h.setTop(60); assert.equal(isDiscussionSentinelNear(h.root, h.sentinel), false);
    h.setTop(700); h.setVisible(false); assert.equal(isDiscussionSentinelNear(h.root, h.sentinel), false);
    h.setVisible(true); h.setRootTop(950); assert.equal(isDiscussionSentinelNear(h.root, h.sentinel), false);
    h.setRootTop(100); h.sentinel.hidden = true; assert.equal(isDiscussionSentinelNear(h.root, h.sentinel), false);
});

test('observer events coalesce and stale intersections recheck current geometry', () => {
    const h = geometryHarness();
    h.loader.setActive(true);
    assert.equal(h.observersCreated[0].options.root, h.root);
    assert.equal(h.observersCreated[0].options.rootMargin, '0px 0px 160px 0px');
    h.observersCreated.forEach(observer => observer.callback([]));
    h.listeners.get('scroll')(); h.loader.refresh();
    assert.equal(h.queued, 1);
    h.setTop(1200); h.frame(); assert.equal(h.calls, 0);
    h.setTop(700); h.loader.refresh(); h.frame(); assert.equal(h.calls, 1);
    h.setAllowed(false); h.loader.refresh(); h.frame(); assert.equal(h.calls, 1);
    h.loader.setActive(false);
    assert.equal(h.listeners.size, 0);
    assert.ok(h.observersCreated.every(observer => observer.targets.length === 0));
    h.observersCreated[0].callback([]); assert.equal(h.queued, 0);
});

test('deactivation cancels queued work and scroll fallback works without observers', () => {
    const h = geometryHarness({ observers: false });
    h.loader.setActive(true); h.loader.setActive(false); h.frame(); assert.equal(h.calls, 0);
    h.loader.setActive(true); h.frame(); assert.equal(h.calls, 1);
    h.listeners.get('view:resize')(); h.listeners.get('scroll')(); h.frame(); assert.equal(h.calls, 2);
    h.loader.destroy(); assert.equal(h.listeners.size, 0);
});

class Element {
    constructor(tagName = 'div') {
        this.tagName = tagName; this.children = []; this.attributes = new Map(); this.events = new Map(); this.dataset = {};
        this.hidden = false; this.value = ''; this.className = ''; this._text = ''; this.isConnected = true;
        this.classList = {
            add: name => { if (!this.className.split(' ').includes(name)) this.className = `${this.className} ${name}`.trim(); },
            remove: name => { this.className = this.className.split(' ').filter(item => item !== name).join(' '); },
            contains: name => this.className.split(' ').includes(name),
            toggle: (name, enabled) => { this.classList[enabled ? 'add' : 'remove'](name); }
        };
    }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(name, handler) { this.events.set(name, handler); }
    remove() {
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
        this.parentElement = null;
    }
    append(...children) { children.forEach(child => { child.remove?.(); child.parentElement = this; this.children.push(child); }); }
    prepend(child) { child.remove(); child.parentElement = this; this.children.unshift(child); }
    before(child) {
        child.remove(); child.parentElement = this.parentElement;
        this.parentElement.children.splice(this.parentElement.children.indexOf(this), 0, child);
    }
    replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
    matches(selector) { return selector.startsWith('.') ? this.classList.contains(selector.slice(1)) : this.tagName === selector; }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches?.(selector) ? [child] : []), ...(child.querySelectorAll?.(selector) ?? [])]); }
    querySelector(selector) { return this.parts?.[selector] ?? this.querySelectorAll(selector)[0] ?? null; }
    closest() { return null; }
    contains(child) { return this === child || this.children.some(item => item.contains?.(child)); }
    focus() {}
    scrollIntoView(options) { this.scrolled = options; }
}

const scenes = [{ ID: 11, name: 'General', isDefault: true }, { ID: 10, name: 'Standard', isDefault: false }];
const customAvatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQSQv4DwADZgHaE5klaQAAAABJRU5ErkJggg==';
const makePost = (ID, parentID = null, contextValues = {}) => ({ ID, parentID, categoryID: 1, categoryName: 'Language models',
    contextValues, authorName: 'Fixture', authorAvatarURL: null, text: `Post ${ID}`, createdAt: '2026-10-01T00:00:00Z', mentions: [],
    upvotes: 4, downvotes: 1, myVote: 0, replyCount: 45, isOwn: false, isDeleted: false });
const pageData = (body, posts, hasMore = true, extra = {}) => ({
    context: { categoryID: body.categoryID ?? 1, categoryPath: 'topics/1/language-models',
        lineage: [{ ID: body.categoryID ?? 1, name: 'Language models', position: 0 }], contextValues: body.contextValues, dimensions: [], scenes },
    contexts: [{ ID: 10, values: { scene: '10' } }], authenticated: true, userID: '1',
    root: body.threadID ? makePost(body.threadID) : null, posts, total: 45, hasMore, ...extra
});

function discussionHarness(request = (body => pageData(body, Array.from({ length: 20 }, (_, index) => makePost(801 + body.offset + index, body.threadID)))),
    { write, profile } = {}) {
    const elements = new Map(), listeners = new Map(), reads = [], writes = [];
    const $ = id => {
        if (/^post-\d+$/.test(id)) return [...elements.values()].flatMap(element => element.querySelectorAll('article')).find(post => post.id === id) ?? null;
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
    };
    const sidebar = new Element(), workspace = new Element(), sort = [new Element('button'), new Element('button')];
    sort[0].dataset.sort = 'hot'; sort[1].dataset.sort = 'new';
    sidebar.parts = { '.bp-brand': $('brand') }; sidebar.append($('brand'));
    $('context-actions').append($('discussion-entry'), $('workspace-refresh'));
    $('benchmark-information').parts = { '.benchmark-information-meta': $('benchmark-meta') };
    for (const id of ['discussion-compose-fields', 'benchmark-scores-view']) $(id).hidden = true;
    const auto = { active: false, setActive(value) { this.active = value; } };
    let autoOptions, viewChanged;
    const scope = createAccountWriteScope();
    const sandbox = vm.createContext({
        document: { getElementById: $, body: new Element(), documentElement: { lang: 'en' }, createElement: tag => new Element(tag),
            addEventListener(name, callback) { listeners.set(`document:${name}`, callback); },
            querySelector: selector => selector === '.bp-shell > .bp-sidebar' ? sidebar : selector === '.bp-workspace' ? workspace : $('sort'),
            querySelectorAll(selector) {
                if (selector === '[data-sort]') return sort;
                if (selector === '.bp-discussion-author[data-profile-self="true"]') return [$('thread-root'), $('discussion-feed')]
                    .flatMap(host => host.querySelectorAll('.bp-discussion-author')).filter(author => author.dataset.profileSelf === 'true');
                return [];
            } },
        window: { matchMedia: () => ({ matches: false, addEventListener() {} }), scrollY: 0, scrollTo() {},
            Option: class extends Element { constructor(text, value) { super('option'); this.textContent = text; this.value = value; } },
            addEventListener(name, callback) { listeners.set(name, callback); }, dispatchEvent() {} },
        CustomEvent: class { constructor(type) { this.type = type; } },
        location: new URL('http://localhost/?categoryID=1'), URL, URLSearchParams, structuredClone, console, AbortController,
        readDiscussionEntryContext: () => null, readRankingContext, orderedScenes, scenePath, topicSlug, pageAccountWriteScope: scope, isAccountWriteError, profileAvatarURL,
        hasAADisplayRestriction, AA_DISPLAY_MESSAGE,
        createDiscussionAutoLoader(options) { autoOptions = options; return auto; },
        createBenchmarkScoresView({ onViewChange }) {
            viewChanged = onViewChange;
            return { reset() { onViewChange(false); }, open() { onViewChange(true); } };
        },
        postJSON(path, body, options) {
            if (path === '/api/get_discussion') { reads.push({ body: structuredClone(body), options }); return Promise.resolve(request(body, reads.length)); }
            if (path === '/api/get_benchmark_information') return Promise.resolve({ benchmarkID: 101, conditionID: 1,
                name: 'Fixture benchmark', conditionName: 'Default', isPrimaryCondition: true, differenceExplanation: '', description: '' });
            if (path === '/api/get_user_profile') return profile ? profile() : Promise.resolve({ userID: '1' });
            writes.push({ path, body: structuredClone(body) });
            if (write) return write(path, body);
            return Promise.reject(new Error('Unexpected fixture write'));
        },
        buildContributionURL: () => '/contribute/report', relativeDateAge: () => '', loginWithGitHub() {},
        animateContent() {}, mountDisclosureMotion() {}, setDisclosureOpen() {}, mountDisclosureChevron() {}, setDiscussionEntryView() {},
        setVisible(element, visible) { element.hidden = !visible; }
    });
    const code = source.replace(/^import[^\r\n]+\r?\n/gm, '')
        .replace("if (params.get('discussion') === '1') await openDiscussion(new URL(location.href));", '');
    vm.runInContext(`${loadingSource}\n${actionSource}\n${code}\nthis.ui = { state, load, openDiscussion, closeDiscussion, renderPost,
        paging: () => ({ loading, hasMore, retryAppend, feedLoaded }) };`, sandbox);
    return { $, reads, writes, auto, scope, sort, listeners, ...sandbox.ui,
        open(extra = '') { return sandbox.ui.openDiscussion(new URL(`http://localhost/?discussion=1&categoryID=1${extra}`)); },
        async event(id, type = 'click', value = '') { await $(id).events.get(type)?.({ target: { value }, preventDefault() {} }); await flush(); },
        async scene(value) {
            const tab = $('discussion-context').children.find(tab => tab.dataset.sceneId === String(value));
            assert.ok(tab, 'The selected scene is a real tab'); await tab.events.get('click')(); await flush();
        },
        async autoCheck() { if (auto.active && autoOptions.canLoad()) await autoOptions.loadMore(); },
        showScores(value) { viewChanged(value); },
        ids() { return $('discussion-feed').children.filter(child => child.id?.startsWith('post-')).map(post => Number(post.id.slice(5))); } };
}

test('feed and reply appends are single-flight, use raw offsets, deduplicate and stop on zero progress', async () => {
    const work = deferred();
    const h = discussionHarness((body, count) => count === 2 ? work.promise : pageData(body, Array.from({ length: 20 }, (_, i) => makePost(801 + i))));
    await h.open(); assert.equal(h.auto.active, true);
    const postingSelector = h.$('posting-context').children[0];
    const filterOption = h.$('discussion-context').children[0];
    const append = h.load(true); const duplicate = h.load(true);
    assert.equal(h.reads.length, 2); assert.equal(h.$('discussion-more').textContent, 'Loading discussions');
    assert.equal(h.$('discussion-more').children[0].children[0].className, 'bp-spinner');
    work.resolve(pageData(h.reads[1].body, [makePost(820), makePost(821)]));
    await Promise.all([append, duplicate]);
    assert.equal(h.ids().length, 21); assert.equal(h.state.offset, 22);
    assert.equal(h.$('posting-context').children[0], postingSelector, 'Appending preserves composer controls and their focus');
    assert.equal(h.$('discussion-context').children[0], filterOption);
    await h.load(true);
    assert.deepEqual(h.reads.map(read => read.body.offset), [0, 20, 22]);
    assert.equal(h.ids().length, 21); assert.equal(h.paging().hasMore, false); assert.equal(h.auto.active, false);
    await h.autoCheck(); await h.load(true); assert.equal(h.reads.length, 3);

    const replies = discussionHarness(body => pageData(body, [makePost(2000 + body.offset, body.threadID)], body.offset === 0));
    await replies.open('&threadID=801');
    const root = replies.$('thread-root').children[0];
    await replies.autoCheck();
    assert.equal(replies.$('thread-root').children[0], root, 'Appending preserves the original message and its controls');
    assert.equal(replies.$('discussion-panel').dataset.view, 'thread');
    assert.deepEqual(replies.ids(), [2000, 2001]);
    assert.equal(replies.$('thread-root').children[0].classList.contains('is-root'), true);
    assert.ok(replies.$('discussion-feed').children.every(post => post.classList.contains('is-reply')));
    assert.equal(replies.auto.active, false);
});

test('empty pages advertising hasMore stop immediately', async () => {
    const h = discussionHarness(body => pageData(body, []));
    await h.open(); await h.autoCheck();
    assert.equal(h.reads.length, 1); assert.equal(h.$('discussion-more').hidden, true);
});

for (const action of ['sort', 'scope', 'context', 'open', 'close', 'scores', 'private']) {
    test(`pending appends cannot mutate feed or busy state after ${action}`, async () => {
        const pending = deferred();
        const h = discussionHarness((body, count) => count === 2 ? pending.promise
            : pageData(body, [makePost(801 + count * 100)], true));
        await h.open('&benchmarkID=101&conditionID=1');
        h.$('discussion-text').value = 'Keep this draft';
        const append = h.load(true);
        if (action === 'sort') { h.sort[1].events.get('click')(); await flush(); }
        if (action === 'scope') await h.event('discussion-scope-toggle');
        if (action === 'context') await h.scene(10);
        if (action === 'open') await h.open('&threadID=901');
        if (action === 'close') h.closeDiscussion();
        if (action === 'scores') h.showScores(true);
        if (action === 'private') h.listeners.get('benchpoll:discussion-context')({ detail: { categoryID: 9, contextValues: {}, isPrivate: true } });
        assert.equal(h.reads[1].options.signal.aborted, true);
        const before = h.ids();
        pending.resolve(pageData(h.reads[1].body, [makePost(9999)], true, { userID: '2' }));
        await append;
        assert.deepEqual(h.ids(), before); assert.equal(h.$('discussion-feed').getAttribute('aria-busy'), 'false');
        assert.equal(h.scope.capture(), '1', 'A stale account cannot poison the write scope');
        assert.equal(h.writes.length, 0);
        if (['sort', 'scope', 'close', 'scores', 'private'].includes(action)) assert.equal(h.$('discussion-text').value, 'Keep this draft');
        if (action === 'context') {
            assert.equal(h.$('discussion-text').value, '', 'Another scene cannot inherit this draft');
            await h.open('&benchmarkID=101&conditionID=1'); assert.equal(h.$('discussion-text').value, 'Keep this draft');
        }
        if (action === 'close') { await h.open('&benchmarkID=101&conditionID=1'); assert.equal(h.$('discussion-text').value, 'Keep this draft'); }
    });
}

test('errors latch automatic paging until explicit same-page retry, including initial failures', async () => {
    let fail = true;
    const h = discussionHarness(body => {
        if (fail && body.offset > 0) throw new Error('Fixture failed');
        return pageData(body, [makePost(801 + body.offset)], body.offset === 0);
    });
    await h.open(); await h.autoCheck();
    assert.equal(h.$('discussion-more').textContent, 'Retry'); assert.equal(h.$('discussion-more').disabled, false);
    assert.equal(h.auto.active, false);
    for (let i = 0; i < 5; i++) await h.autoCheck();
    assert.equal(h.reads.length, 2);
    fail = false; await h.event('discussion-more');
    assert.deepEqual(h.reads.map(read => read.body.offset), [0, 1, 1]);
    assert.deepEqual(h.ids(), [801, 802]); assert.equal(h.$('discussion-error').hidden, true);

    let initialFailure = true;
    const initial = discussionHarness(body => {
        if (initialFailure) throw new Error('Initial failure');
        return pageData(body, [makePost(901)], false);
    });
    await initial.open(); initial.showScores(true); initial.showScores(false); await flush();
    assert.equal(initial.reads.length, 1, 'Changing views cannot bypass a failed-read retry latch');
    initialFailure = false; await initial.event('discussion-more');
    assert.deepEqual(initial.reads.map(read => read.body.offset), [0, 0]); assert.deepEqual(initial.ids(), [901]);
});

test('an obsolete failure cannot clear a newer busy read or expose an error', async () => {
    const old = deferred(), current = deferred();
    const h = discussionHarness((body, count) => count === 2 ? old.promise : count === 3 ? current.promise : pageData(body, [makePost(801)]));
    await h.open();
    const append = h.load(true);
    h.sort[1].events.get('click')();
    old.reject(new Error('Obsolete append failure')); await append;
    assert.equal(h.$('discussion-feed').getAttribute('aria-busy'), 'true');
    assert.equal(h.$('discussion-error').hidden, true);
    assert.equal(h.$('discussion-more').disabled, true);
    current.resolve(pageData(h.reads[2].body, [makePost(901)], false)); await flush();
    assert.deepEqual(h.ids(), [901]); assert.equal(h.$('discussion-feed').getAttribute('aria-busy'), 'false');
});

test('a missing thread clears old content and explicit retry starts at offset zero', async () => {
    let missing = true;
    const h = discussionHarness(body => {
        if (body.offset > 0 && missing) throw Object.assign(new Error('discussion_post_unavailable'), { status: 404 });
        return pageData(body, [makePost(2001 + body.offset, body.threadID)], body.offset === 0);
    });
    await h.open('&threadID=801'); await h.autoCheck();
    assert.deepEqual(h.ids(), []); assert.equal(h.$('thread-root').children.length, 0);
    assert.equal(h.auto.active, false); assert.equal(h.$('discussion-more').textContent, 'Retry');
    missing = false; await h.event('discussion-more');
    assert.deepEqual(h.reads.map(read => read.body.offset), [0, 1, 0]);
    assert.deepEqual(h.ids(), [2001]);
});

test('all-scores pauses in-flight first read and returning resumes it, information-only never reads', async () => {
    const pending = deferred();
    const h = discussionHarness((body, count) => count === 1 ? pending.promise : pageData(body, [makePost(901)], false));
    const opening = h.open(); h.showScores(true);
    assert.equal(h.reads[0].options.signal.aborted, true);
    h.showScores(false); await flush();
    assert.equal(h.reads.length, 2); assert.deepEqual(h.ids(), [901]);
    pending.reject(new Error('Late failure')); await opening;
    assert.equal(h.$('discussion-error').hidden, true);
    h.closeDiscussion();
    h.listeners.get('benchpoll:discussion-context')({ detail: { categoryID: 1, contextValues: {}, isPrivate: true } });
    await h.open('&benchmarkID=101&conditionID=1'); await h.autoCheck();
    assert.equal(h.reads.length, 2); assert.equal(h.auto.active, false);
});

test('post metadata omits neutral options and shared quiet actions retain accessible labels', async () => {
    const h = discussionHarness(body => pageData(body, [makePost(801)], false));
    await h.open();
    for (const values of [{}, { budget: 'any' }]) {
        assert.equal(h.renderPost(makePost(802, null, values)).querySelector('.discussion-context-badge'), null);
    }
    const post = h.renderPost({ ...makePost(802, null, { budget: 'standard' }), isOwn: true });
    assert.equal(post.querySelector('.discussion-context-badge').textContent, 'standard');
    const buttons = post.querySelectorAll('button');
    assert.equal(buttons[0].getAttribute('aria-label'), 'Like post 802: 4');
    assert.equal(buttons[0].disabled, true);
    assert.equal(buttons[0].querySelector('span').textContent, '4');
    const links = post.querySelector('.discussion-post-actions').querySelectorAll('a');
    const permalink = links.find(link => link.getAttribute('aria-label') === 'Link to this message');
    assert.ok(permalink);
    assert.equal(permalink.getAttribute('aria-label'), 'Link to this message');
    assert.equal(permalink.dataset.tooltip, 'Link to this message');
    assert.equal(permalink.querySelector('i').className, 'fa-solid fa-link');
    assert.equal(post.querySelector('.discussion-report').getAttribute('aria-label'), 'Report post 802');
    assert.equal(post.querySelector('.discussion-delete').dataset.tooltip, 'Delete your message');
    assert.ok([...buttons, ...links].every(action => action.dataset.uiVariant === 'quiet'));
    h.state.allCategories = true;
    assert.equal(h.renderPost(makePost(803)).querySelector('.discussion-context-badge').textContent, 'Language models');
    assert.equal(h.writes.length, 0);
});

test('profile events update own roots and replies without changing other authors, deleted messages, drafts or paging', async () => {
    const originalAvatar = 'https://avatars.githubusercontent.com/u/1';
    const own = (ID, parentID = null) => ({ ...makePost(ID, parentID), isOwn: true, authorName: 'Original custom name', authorAvatarURL: originalAvatar });
    const h = discussionHarness(body => pageData(body, [own(2001, 801),
        { ...makePost(2002, 801), authorName: 'Other custom name', authorAvatarURL: customAvatar },
        { ...own(2003, 801), isDeleted: true, authorName: 'Deleted message' }], true, { root: own(801) }));
    await h.open('&threadID=801');
    h.$('discussion-text').value = 'Keep my in-progress reply';
    h.state.mentions = [{ benchmarkID: 101, conditionID: 1, label: 'Fixture benchmark' }];
    const root = h.$('thread-root').children[0];
    const reply = h.$('post-2001');
    const other = h.$('post-2002');
    const deleted = h.$('post-2003');
    const paging = { ...h.paging(), offset: h.state.offset };
    const changed = { userID: '1', userName: '自定义 👩‍💻 <b>literal</b>', userProfilePictureURL: customAvatar };
    h.listeners.get('document:benchpoll:profile-updated')({ detail: changed });
    for (const post of [root, reply]) {
        const author = post.querySelector('.bp-discussion-author');
        assert.equal(author.querySelector('strong').textContent, changed.userName);
        assert.equal(author.querySelector('strong').children.length, 0, 'Display names stay text, never parsed HTML');
        assert.equal(author.querySelector('img').src, customAvatar);
        assert.equal(author.querySelector('img').referrerPolicy, 'no-referrer');
        assert.equal(author.querySelector('img').alt, '');
    }
    assert.equal(other.querySelector('strong').textContent, 'Other custom name');
    assert.equal(deleted.querySelector('strong').textContent, 'Deleted message');
    assert.equal(deleted.querySelector('img'), null);
    h.listeners.get('document:benchpoll:profile-updated')({ detail: { ...changed, userProfilePictureURL: null } });
    assert.equal(root.querySelector('img'), null);
    assert.equal(reply.querySelector('img'), null);
    assert.equal(other.querySelector('img').src, customAvatar);
    assert.equal(h.$('thread-root').children[0], root);
    assert.equal(h.$('discussion-text').value, 'Keep my in-progress reply');
    assert.deepEqual(h.state.mentions, [{ benchmarkID: 101, conditionID: 1, label: 'Fixture benchmark' }]);
    assert.deepEqual({ ...h.paging(), offset: h.state.offset }, paging);
    assert.deepEqual(h.ids(), [2001, 2002, 2003]);
    assert.equal(h.reads.length, 1);
    assert.equal(h.writes.length, 0);
});

test('late appended posts use the newest profile including an explicit null avatar without resetting raw pagination', async () => {
    const pending = deferred();
    const own = ID => ({ ...makePost(ID, 801), isOwn: true, authorName: 'Old name', authorAvatarURL: customAvatar });
    const h = discussionHarness((body, count) => count === 2 ? pending.promise
        : pageData(body, [own(2001)], true, { root: { ...own(801), parentID: null } }));
    await h.open('&threadID=801');
    h.$('discussion-text').value = 'Draft during paging';
    const root = h.$('thread-root').children[0];
    const append = h.load(true);
    h.listeners.get('document:benchpoll:profile-updated')({ detail: { userID: '1', userName: 'New name', userProfilePictureURL: null } });
    pending.resolve(pageData(h.reads[1].body, [own(2002), { ...makePost(2003, 801), authorName: 'Independent author', authorAvatarURL: customAvatar }], false));
    await append;
    assert.deepEqual(h.reads.map(read => read.body.offset), [0, 1]);
    assert.equal(h.state.offset, 3);
    assert.deepEqual(h.ids(), [2001, 2002, 2003]);
    assert.equal(h.$('thread-root').children[0], root);
    for (const post of [root, h.$('post-2001'), h.$('post-2002')]) {
        assert.equal(post.querySelector('strong').textContent, 'New name');
        assert.equal(post.querySelector('img'), null);
    }
    assert.equal(h.$('post-2003').querySelector('strong').textContent, 'Independent author');
    assert.equal(h.$('post-2003').querySelector('img').src, customAvatar);
    assert.equal(h.$('discussion-text').value, 'Draft during paging');
    assert.equal(h.auto.active, false);
    assert.equal(h.writes.length, 0);
});

test('profile events from foreign or malformed identities cannot replace visible own author metadata', async () => {
    const h = discussionHarness(body => pageData(body, [{ ...makePost(801), isOwn: true, authorAvatarURL: customAvatar }], false));
    await h.open();
    const update = h.listeners.get('document:benchpoll:profile-updated');
    for (const userID of ['2', '01', 1, 9007199254740992, null]) {
        update({ detail: { userID, userName: 'Wrong account', userProfilePictureURL: null } });
        assert.equal(h.$('post-801').querySelector('strong').textContent, 'Fixture');
        assert.equal(h.$('post-801').querySelector('img').src, customAvatar);
        assert.equal(h.scope.capture(), '1');
    }
    assert.equal(h.reads.length, 1);
    assert.equal(h.writes.length, 0);
});

test('author rendering uses the real avatar allowlist and a failed image never removes the display name', async () => {
    const h = discussionHarness();
    for (const authorAvatarURL of ['https://evil.test/avatar.png', 'data:image/svg+xml,<svg/>', 'javascript:alert(1)']) {
        assert.equal(h.renderPost({ ...makePost(801), authorAvatarURL }).querySelector('img'), null);
    }
    const post = h.renderPost({ ...makePost(801), authorAvatarURL: customAvatar, authorName: 'Custom display name' });
    const image = post.querySelector('img');
    assert.equal(image.width, 24);
    assert.equal(image.height, 24);
    image.events.get('error')();
    assert.equal(post.querySelector('img'), null);
    assert.equal(post.querySelector('strong').textContent, 'Custom display name');
    assert.equal(h.reads.length, 0);
});

test('switching threads clears old root and replies even if the replacement read fails', async () => {
    const pending = deferred();
    const h = discussionHarness((body, count) => count === 2 ? pending.promise
        : pageData(body, [makePost(2001, body.threadID)], false));
    await h.open('&threadID=801');
    const switching = h.open('&threadID=901');
    assert.deepEqual(h.ids(), [], 'Thread 801 replies must not remain actionable under thread 901');
    assert.equal(h.$('thread-root').children.length, 0);
    pending.reject(new Error('Replacement thread read failed'));
    await switching;
    assert.deepEqual(h.ids(), []);
    assert.equal(h.$('thread-root').children.length, 0);
    assert.equal(h.$('discussion-more').textContent, 'Retry');
    await h.event('discussion-more');
    assert.deepEqual(h.ids(), [2001]);
    assert.equal(h.$('thread-root').children[0].id, 'post-901');
});

for (const action of ['vote', 'delete']) {
    for (const outcome of ['resolve', 'reject']) {
        test(`obsolete ${action} ${outcome} cannot refresh or expose errors in a different thread`, async () => {
            const pending = deferred();
            const h = discussionHarness(body => pageData(body, [{ ...makePost(2001, body.threadID), isOwn: action === 'delete' }], false),
                { write: () => pending.promise });
            await h.open('&threadID=801');
            const post = h.$('discussion-feed').children[0];
            let operation;
            if (action === 'vote') operation = post.querySelectorAll('button')[0].events.get('click')();
            else {
                post.querySelector('.discussion-delete').events.get('click')();
                operation = post.querySelector('.discussion-delete-confirm').querySelectorAll('button')[1].events.get('click')();
            }
            assert.equal(h.writes.length, 1);
            await h.open('&threadID=901');
            h.$('discussion-text').value = 'New thread draft';
            const postingContext = h.$('posting-context').textContent;
            if (outcome === 'resolve') pending.resolve({ postID: 2001 });
            else pending.reject(new Error('discussion_post_unavailable'));
            await operation;
            assert.equal(h.reads.length, 2, 'An old write must not start another read in the new thread');
            assert.equal(h.$('discussion-error').hidden, true, 'An old write error belongs to its original thread');
            assert.equal(h.$('discussion-text').value, 'New thread draft');
            assert.equal(h.$('posting-context').textContent, postingContext);
        });
    }
}

test('current-thread vote and delete still refresh after a successful synthetic write', async () => {
    for (const action of ['vote', 'delete']) {
        const h = discussionHarness(body => pageData(body, [{ ...makePost(2001, body.threadID), isOwn: action === 'delete' }], false),
            { write: async () => ({ postID: 2001 }) });
        await h.open('&threadID=801');
        const post = h.$('discussion-feed').children[0];
        if (action === 'vote') await post.querySelectorAll('button')[0].events.get('click')();
        else {
            post.querySelector('.discussion-delete').events.get('click')();
            await post.querySelector('.discussion-delete-confirm').querySelectorAll('button')[1].events.get('click')();
        }
        assert.equal(h.writes.length, 1);
        assert.equal(h.reads.length, 2);
    }
});

test('a failed post retains its draft and failure reason when switching away and back', async () => {
    const h = discussionHarness(body => pageData(body, [], false),
        { write: async () => { throw new Error('discussion_post_cooldown'); } });
    await h.open('&threadID=801');
    h.$('discussion-text').value = 'Keep my failed reply';
    await h.event('discussion-composer', 'submit');
    assert.equal(h.$('discussion-error').textContent, 'Please wait 30 seconds between messages.');
    await h.open('&threadID=901');
    assert.equal(h.$('discussion-text').value, '');
    await h.open('&threadID=801');
    assert.equal(h.$('discussion-text').value, 'Keep my failed reply');
    assert.equal(h.$('composer-status').textContent, 'Please wait 30 seconds between messages.');
    h.$('discussion-text').value += ' edited';
    await h.event('discussion-text', 'input');
    await h.open('&threadID=901'); await h.open('&threadID=801');
    assert.equal(h.$('composer-status').textContent, '', 'Editing dismisses the saved failure reason');
});

test('a successfully posted reply beyond the first page is loaded and scrolled into view', async () => {
    let posted = false;
    const replies = Array.from({ length: 45 }, (_, index) => makePost(2001 + index, 801));
    const h = discussionHarness(body => {
        const all = posted ? [...replies, makePost(2046, 801)] : replies;
        return pageData(body, all.slice(body.offset, body.offset + 20), body.offset + 20 < all.length, { total: all.length });
    }, { write: async () => { posted = true; return { ID: 2046, threadID: 801 }; } });
    await h.open('&threadID=801');
    h.$('discussion-text').value = 'My new reply';
    await h.event('discussion-composer', 'submit');
    assert.ok(h.ids().includes(2046), 'A successful post must not disappear behind the oldest reply page');
    assert.equal(h.$('post-2046').scrolled?.block, 'nearest');
    assert.equal(h.$('discussion-text').value, '');
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].body.parentID, 801);
    assert.deepEqual(h.reads.map(read => read.body.offset), [0, 0, 20, 40]);
});

test('obsolete profile failures do not expose errors in a newly opened thread', async () => {
    const pending = deferred();
    const h = discussionHarness(body => pageData(body, [], false), { profile: () => pending.promise });
    await h.open('&threadID=801');
    const profile = h.listeners.get('focus')();
    await h.open('&threadID=901');
    pending.reject(new Error('Old profile failed'));
    await profile;
    assert.equal(h.$('discussion-error').hidden, true);
});

test('returning from scores keeps existing post controls usable', async () => {
    const h = discussionHarness(body => pageData(body, [makePost(2001, body.threadID)], false),
        { write: async () => ({ postID: 2001 }) });
    await h.open('&threadID=801');
    const post = h.$('discussion-feed').children[0];
    h.showScores(true); h.showScores(false); await flush();
    await post.querySelectorAll('button')[0].events.get('click')();
    assert.equal(h.writes.length, 1);
    assert.equal(h.reads.length, 2);
});

test('a write completed while scores are visible refreshes the discussion on return', async () => {
    const pending = deferred();
    const h = discussionHarness(body => pageData(body, [makePost(2001, body.threadID)], false),
        { write: () => pending.promise });
    await h.open('&threadID=801');
    const vote = h.$('discussion-feed').children[0].querySelectorAll('button')[0];
    const operation = vote.events.get('click')();
    h.showScores(true);
    pending.resolve({ postID: 2001 }); await operation;
    assert.equal(h.reads.length, 1, 'Hidden discussions must not issue a refresh read');
    h.showScores(false); await flush();
    assert.equal(h.reads.length, 2, 'The successful write must be reflected when returning');
});

test('obsolete profile success cannot rebind the active thread to a stale signed-out session', async () => {
    const pending = deferred();
    const h = discussionHarness(body => pageData(body, [], false), { profile: () => pending.promise });
    await h.open('&threadID=801');
    const profile = h.listeners.get('focus')();
    await h.open('&threadID=901');
    pending.resolve(null); await profile;
    assert.equal(h.$('discussion-error').hidden, true);
    assert.equal(h.state.authenticated, true);
    assert.equal(h.scope.capture(), '1');
});

test('a deleted root retains its live replies but has no vote, report or delete controls', async () => {
    const h = discussionHarness(body => pageData(body, [makePost(2001, body.threadID)], false,
        { root: { ...makePost(801), isOwn: true, isDeleted: true, text: '', mentions: [] } }));
    await h.open('&threadID=801');
    const root = h.$('thread-root').children[0];
    assert.equal(root.querySelector('.discussion-post-body').textContent, 'This message was deleted by its author.');
    assert.equal(root.querySelectorAll('button').length, 0);
    assert.equal(root.querySelector('.discussion-report'), null);
    assert.equal(root.querySelector('.discussion-delete'), null);
    assert.deepEqual(h.ids(), [2001]);
    assert.equal(h.writes.length, 0);
});

test('filter replacement failures do not leave entries from the previous filter', async () => {
    const h = discussionHarness((body, count) => {
        if (count > 1) throw new Error('Filtered read failed');
        return pageData(body, [makePost(801)], false);
    });
    await h.open(); await h.scene(10);
    assert.deepEqual(h.ids(), []);
    assert.equal(h.state.contextID, null);
    assert.equal(h.state.contextValues.scene, '10');
    assert.equal(h.$('discussion-more').textContent, 'Retry');
    assert.equal(h.auto.active, false);
});

test('revealing a posted reply stops on a failed append and retains the explicit retry latch', async () => {
    let posted = false;
    const replies = Array.from({ length: 25 }, (_, index) => makePost(2001 + index, 801));
    const h = discussionHarness(body => {
        if (posted && body.offset > 0) throw new Error('Reply append failed');
        const all = posted ? [...replies, makePost(2026, 801)] : replies;
        return pageData(body, all.slice(body.offset, body.offset + 20), body.offset + 20 < all.length, { total: all.length });
    }, { write: async () => { posted = true; return { ID: 2026, threadID: 801 }; } });
    await h.open('&threadID=801'); h.$('discussion-text').value = 'Posted once only';
    await h.event('discussion-composer', 'submit');
    assert.equal(h.writes.length, 1);
    assert.equal(h.$('composer-status').textContent, 'Posted.');
    assert.equal(h.$('discussion-text').value, '');
    assert.equal(h.$('discussion-more').textContent, 'Retry');
    assert.equal(h.auto.active, false);
    assert.deepEqual(h.reads.map(read => read.body.offset), [0, 0, 20]);
});
