import test from 'node:test';
import assert from 'node:assert/strict';
import { createFallbackPicker } from '../public/js/workspace/fallback-picker.js';
import { createFamilyView } from '../public/js/workspace/family-view.js';

// Only DOM behavior used by these renderers is modeled; requests and frames are controlled.
class Element {
    constructor(tag) {
        this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = new Map();
        this.events = new Map(); this.className = ''; this._text = ''; this.parentElement = null;
        this.hidden = false; this.disabled = false; this.scrollTop = 0; this.scrollLeft = 0;
        this.captured = new Set(); this.style = { setProperty() {} };
        this.classList = {
            contains: name => this.className.split(' ').includes(name),
            add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
            remove: (...names) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' '); },
            toggle: (name, enabled = !this.classList.contains(name)) => { this.classList[enabled ? 'add' : 'remove'](name); }
        };
    }
    get firstElementChild() { return this.children[0] ?? null; }
    get lastElementChild() { return this.children.at(-1) ?? null; }
    get isConnected() { return this === document.body || Boolean(this.parentElement?.isConnected); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    set innerHTML(value) {
        this.replaceChildren(...[...value.matchAll(/<(i|span|strong)\b/g)].map(match => new Element(match[1])));
    }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    replaceChildren(...children) {
        for (const child of this.children) child.parentElement = null;
        this.children = []; this._text = ''; this.append(...children);
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    matches(selector) {
        if (selector === '*') return true;
        if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
        if (selector === '[hidden]') return this.hidden;
        if (selector === '[inert]') return this.inert;
        if (selector === '[data-family-focus]') return this.dataset.familyFocus !== undefined;
        return this.tagName === selector.toUpperCase();
    }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    closest(selector) { return selector.split(',').some(item => this.matches(item.trim())) ? this : this.parentElement?.closest(selector) ?? null; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    addEventListener(name, handler) { const handlers = this.events.get(name) ?? []; handlers.push(handler); this.events.set(name, handlers); }
    removeEventListener(name, handler) { this.events.set(name, (this.events.get(name) ?? []).filter(item => item !== handler)); }
    emit(name, options = {}) {
        const event = { target: this, button: 0, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...options };
        for (const handler of this.events.get(name) ?? []) handler(event);
    }
    click() { if (!this.disabled) this.emit('click'); }
    focus() { document.activeElement = this; }
    scrollTo({ left = this.scrollLeft, top = this.scrollTop }) { this.scrollLeft = left; this.scrollTop = top; }
    getBoundingClientRect() {
        const top = (this.parentElement?.children.indexOf(this) ?? 0) * 40 + (Number.parseFloat(this.style.transform?.slice(11)) || 0);
        return { left: 0, right: 400, top, bottom: top + 40, height: 40 };
    }
    get offsetHeight() { return 40; }
    setPointerCapture(ID) { this.captured.add(ID); }
    hasPointerCapture(ID) { return this.captured.has(ID); }
    releasePointerCapture(ID) { this.captured.delete(ID); }
}

function dom(t) {
    const names = ['document', 'window', 'requestAnimationFrame'];
    const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const frames = [];
    const body = new Element('body');
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { body, activeElement: body,
        createElement: tag => new Element(tag), getElementById: ID => body.querySelectorAll('*').find(node => node.id === ID) ?? null } });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
        matchMedia: query => ({ matches: query.includes('prefers-reduced-motion'), addEventListener() {}, removeEventListener() {} }),
        ResizeObserver: class { observe() {} disconnect() {} }
    } });
    Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: callback => { frames.push(callback); } });
    t.after(() => {
        for (const [name, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    });
    return { body, frames, frame() { for (const callback of frames.splice(0)) callback(); } };
}

const primary = { ID: 1, conditionID: 1, benchmarkID: 101, name: 'Entrance', conditionName: 'Default', isPrimaryCondition: true };
const member = ID => ({ conditionID: ID, benchmarkID: 100 + ID, name: `Benchmark ${ID}`, conditionName: 'Default', isPrimaryCondition: true });
const order = (ID, ...IDs) => ({ familyID: ID, familyEntries: IDs.map(member) });
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function pickerHarness(t, options = {}) {
    const UI = dom(t), applied = [], customized = [], inspected = [], loaded = [];
    const state = { scope: 'personal|guest|context-1', current: { entries: [] }, allowed: true,
        view: { featured: [order(10, 2)], items: [], loaded: true, loading: false, hasMore: false, error: '', suspended: false }, ...options };
    const picker = createFallbackPicker({
        catalogue: { view: () => state.view, load: ID => { loaded.push(ID); return state.load?.(ID); } },
        getScope: () => state.scope, getPrimary: ID => ({ ...primary, ID }), getComposition: () => state.composition,
        getCurrent: () => state.current, canApply: () => state.allowed,
        onApply: async (...args) => {
            applied.push(args);
            const result = await (state.apply?.(...args) ?? true);
            if (result) state.current = args[1].community ? null : { familyID: args[1].familyID,
                entries: args[1].entries, selectionSource: args[1].selectionSource ?? 'selected' };
            return result;
        },
        onCustomize: (...args) => { customized.push(args); return state.customize?.(...args) ?? true; },
        onInspectGroup: (...args) => { inspected.push(args); }, getMemberURL: entry => `/benchmarks/${entry.conditionID ?? entry.ID}`
    });
    const dialog = UI.body.querySelector('global-dialog');
    const $ = selector => dialog.querySelector(selector);
    return { ...UI, state, picker, dialog, $, applied, customized, inspected, loaded,
        columns: () => dialog.querySelectorAll('.bp-fallback-picker-column'),
        toggle(key) {
            const card = dialog.querySelectorAll('.bp-fallback-picker-column').find(column => column.dataset.familyKey === key);
            assert.ok(card); const action = card.querySelector('.bp-fallback-picker-card-toggle'); assert.ok(action); action.click();
        },
        add(key) {
            const card = dialog.querySelectorAll('.bp-fallback-picker-column').find(column => column.dataset.familyKey === key);
            assert.ok(card); const action = card.querySelector('.bp-fallback-picker-card-add'); assert.ok(action); action.click();
        } };
}

test('pagination, retry and custom deduplication preserve the selected order until its card is toggled', async t => {
    const h = pickerHarness(t, { current: { entries: [member(2)] } });
    h.state.view.hasMore = true;
    h.state.load = async () => {
        h.state.view.loading = true; h.picker.refresh();
        await settle();
        h.state.view.loading = false; h.state.view.error = 'Could not load fallback configurations.'; h.picker.refresh();
    };
    h.picker.open(primary, { action: 'replace' });
    assert.equal(h.columns()[0].querySelector('.bp-fallback-picker-card-toggle').getAttribute('aria-pressed'), 'true');
    assert.equal(h.$('.bp-fallback-picker-confirm'), null);
    h.$('.bp-fallback-picker-more').click();
    assert.equal(h.$('.bp-fallback-picker-more').disabled, true);
    await settle();
    assert.equal(h.$('.bp-fallback-picker-more').textContent, 'Retry');
    h.state.load = () => {
        h.state.view.error = ''; h.state.view.hasMore = false;
        h.state.view.items = [order(10, 2), order(11, 3)]; h.picker.refresh();
    };
    h.$('.bp-fallback-picker-more').click();
    assert.deepEqual(h.columns().map(column => column.dataset.familyKey), ['[1,2]', '[1]', '[1,3]']);
    assert.equal(h.columns()[0].querySelector('.bp-fallback-picker-card-toggle').getAttribute('aria-pressed'), 'true');
    assert.equal(h.$('.bp-fallback-picker-more').hidden, true);
    assert.deepEqual(h.loaded, [1, 1]);
    assert.equal(h.applied.length + h.customized.length, 0);
    h.toggle('[1,3]'); await settle();
    assert.deepEqual(h.state.current.entries, [member(3)]);
    assert.equal(h.columns()[2].querySelector('.bp-fallback-picker-card-toggle').getAttribute('aria-pressed'), 'true');
    assert.equal(h.dialog.hidden, false);
});

test('newly loaded popular configurations append until the chooser is reopened', async t => {
    const h = pickerHarness(t, { current: null, composition: { families: [
        { entries: [member(2)], weightBasisPoints: 10000 }
    ] } });
    h.picker.open(primary, { action: 'replace' });
    const keys = () => h.columns().map(column => column.dataset.familyKey);
    assert.deepEqual(keys(), ['[1,2]', '[1]']);
    h.state.composition.families = [
        { entries: [member(3)], weightBasisPoints: 9000 }, { entries: [member(2)], weightBasisPoints: 1000 }
    ];
    h.state.view.items.push(order(11, 3)); h.picker.refresh();
    assert.deepEqual(keys(), ['[1,2]', '[1]', '[1,3]']);
    h.toggle('[1,3]'); await settle();
    assert.deepEqual(keys(), ['[1,2]', '[1]', '[1,3]']);
    h.picker.close(); h.picker.open(primary, { action: 'replace' });
    assert.deepEqual(keys(), ['[1,3]', '[1,2]', '[1]']);
});

test('old apply completions cannot close or show errors in a newly opened picker', async t => {
    const h = pickerHarness(t);
    for (const result of ['success', 'reject']) {
        const pending = deferred(); h.state.apply = () => pending.promise;
        h.picker.open(primary); h.add('[1,2]');
        assert.equal(h.$('.bp-fallback-picker-card-add').disabled, true);
        h.picker.close({ restore: false });
        h.picker.open({ ...primary, ID: 4, conditionID: 4 }, { action: 'view' });
        if (result === 'success') pending.resolve(true); else pending.reject(new Error('Old request failed'));
        await settle();
        assert.equal(h.dialog.hidden, false);
        assert.equal(h.dialog.dataset.conditionId, '4');
        assert.equal(h.$('.bp-fallback-picker-status').textContent, '');
        assert.equal(h.$('.bp-fallback-picker-card-toggle'), null);
        assert.equal(h.dialog.querySelectorAll('input').length, 0);
    }
});

test('scope changes and disabled permissions block stale actions without adding a nested fallback', async t => {
    const h = pickerHarness(t);
    h.picker.open(primary);
    h.state.scope = 'personal|other-user|context-2';
    h.add('[1,2]'); h.$('.bp-fallback-picker-custom-add').click();
    assert.equal(h.applied.length, 0);
    h.picker.refresh(); assert.equal(h.dialog.hidden, true);
    h.state.allowed = false; h.picker.open(primary);
    h.add('[1,2]');
    assert.equal(h.applied.length, 0);
    h.state.allowed = true; h.picker.refresh(); h.add('[1,2]');
    await settle();
    assert.equal(h.applied.length, 1);
    assert.equal(h.applied[0][2], 'add');
    assert.deepEqual(h.applied[0][1].entries, [member(2)], 'Adoption sends explicit flat steps, not another family');
    assert.equal(h.applied[0][1].entries.some(entry => entry.isFamily || entry.familyEntries), false);
});

test('adding from a configuration card applies once and allows retry after failure', async t => {
    const pending = deferred();
    const h = pickerHarness(t, { apply: () => pending.promise });
    h.picker.open(primary);
    assert.equal(h.$('.bp-fallback-picker-confirm'), null);
    assert.equal(h.dialog.querySelectorAll('input').length, 0);
    assert.equal(h.$('.bp-fallback-picker-columns').getAttribute('role'), 'list');
    h.add('[1,2]'); h.add('[1,2]');
    assert.equal(h.applied.length, 1);
    assert.equal(h.$('.bp-fallback-picker-card-add').disabled, true);
    pending.resolve(false); await settle();
    assert.equal(h.dialog.hidden, false);
    assert.match(h.$('.bp-fallback-picker-status').textContent, /Could not apply/);
    assert.equal(h.$('.bp-fallback-picker-card-add').disabled, false);
    h.state.apply = () => true;
    h.add('[1,2]'); await settle();
    assert.equal(h.applied.length, 2);
    assert.equal(h.dialog.hidden, true);
});

test('unselected follows community; choosing and toggling the same card preserves explicit none semantics', async t => {
    const h = pickerHarness(t, { current: null });
    h.picker.open(primary, { action: 'replace' });
    const summary = h.$('.bp-fallback-picker-selection-status');
    assert.equal(summary.dataset.selection, 'community');
    assert.match(summary.textContent, /following the community/);
    assert.deepEqual(h.columns().map(column => column.dataset.familyKey), ['[1,2]', '[1]']);
    assert.equal(h.columns().some(column => column.classList.contains('is-selected')), false);
    for (const key of ['[1,2]', '[1]']) {
        h.toggle(key); await settle();
        assert.equal(h.dialog.hidden, false);
        assert.equal(summary.dataset.selection, 'manual');
        assert.equal(h.columns().filter(column => column.classList.contains('is-selected')).length, 1);
        assert.deepEqual(h.state.current.entries, key === '[1]' ? [] : [member(2)]);
        h.toggle(key); await settle();
        assert.equal(summary.dataset.selection, 'community');
        assert.equal(h.state.current, null);
        assert.equal(h.columns().some(column => column.classList.contains('is-selected')), false);
    }
    assert.deepEqual(h.applied.map(([, choice]) => choice.community === true), [false, true, false, true]);
});

test('only an active custom choice hides Create my own; clearing it restores that action', async t => {
    const h = pickerHarness(t, { current: { entries: [member(9)], selectionSource: 'custom' } });
    h.picker.open(primary, { action: 'replace' });
    assert.equal(h.$('.bp-fallback-picker-customize').hidden, true);
    h.toggle('[1,9]'); await settle();
    assert.equal(h.$('.bp-fallback-picker-customize').hidden, false);
    h.toggle('[1,2]'); await settle();
    assert.equal(h.$('.bp-fallback-picker-customize').hidden, false);
    h.toggle('[1,9]'); await settle();
    assert.equal(h.$('.bp-fallback-picker-customize').hidden, true);
    assert.equal(h.state.current.selectionSource, 'custom');
});

test('a custom card remains available after deselection, and failed selections preserve the current state', async t => {
    const h = pickerHarness(t, { current: { entries: [member(9)] } });
    h.picker.open(primary, { action: 'replace' });
    const keys = h.columns().map(column => column.dataset.familyKey);
    h.toggle('[1,9]'); await settle();
    assert.equal(h.state.current, null);
    assert.deepEqual(h.columns().map(column => column.dataset.familyKey), keys);
    h.state.apply = () => false;
    h.toggle('[1,9]'); await settle();
    assert.equal(h.$('.bp-fallback-picker-selection-status').dataset.selection, 'community');
    assert.match(h.$('.bp-fallback-picker-status').textContent, /Could not apply/);
    h.state.apply = () => true;
    h.toggle('[1,9]'); await settle();
    assert.deepEqual(h.state.current.entries, [member(9)]);
    assert.equal(h.$('.bp-fallback-picker-status').textContent, '');
});

test('an active drag is cancelled when same-primary rendering becomes disabled or replaces its order', t => {
    const UI = dom(t), moves = [];
    const container = new Element('div'); UI.body.append(container);
    const view = createFamilyView({ container, onMove: (...args) => { moves.push(args); }, onRemove() {}, onInspectGroup() {} });
    for (const change of [{ disabled: true }, { entries: [member(3), member(2)] }]) {
        const initial = { primary, entries: [member(2), member(3)], active: true, disabled: false };
        view.renderPersonal(initial);
        const handle = container.querySelector('.bp-family-drag');
        handle.emit('pointerdown', { isPrimary: true, pointerId: 1, clientY: 0 });
        handle.emit('pointermove', { pointerId: 1, clientY: 80 });
        assert.equal(handle.hasPointerCapture(1), true);
        view.renderPersonal({ ...initial, ...change });
        assert.equal(handle.hasPointerCapture(1), false, 'Changed state must cancel the old drag');
        const current = container.querySelector('.bp-family-drag');
        assert.equal(current.disabled, change.disabled ?? false);
        assert.equal(container.querySelector('.bp-family-member').dataset.conditionId, change.entries ? '3' : '2');
        handle.emit('pointerup', { pointerId: 1 });
        assert.deepEqual(moves, [], 'A detached drag must not commit its captured old index');
    }
});

test('unchanged rerenders preserve a live drag and preview controls never move or remove steps', t => {
    const UI = dom(t), mutations = [];
    const container = new Element('div'), preview = new Element('div'); UI.body.append(container, preview);
    const view = createFamilyView({ container, onMove: (...args) => { mutations.push(args); }, onRemove: key => { mutations.push(key); }, onInspectGroup() {} });
    const current = { primary, entries: [member(2), member(3)], active: true, disabled: false };
    view.renderPersonal(current);
    const handle = container.querySelector('.bp-family-drag');
    handle.emit('pointerdown', { isPrimary: true, pointerId: 1, clientY: 0 });
    view.renderPersonal(structuredClone(current));
    assert.equal(container.querySelector('.bp-family-drag'), handle);
    assert.equal(handle.hasPointerCapture(1), true);
    view.renderPreview(preview, current);
    assert.equal(handle.hasPointerCapture(1), false);
    assert.equal(preview.querySelectorAll('button').length, 0);
    assert.deepEqual(mutations, []);
});
