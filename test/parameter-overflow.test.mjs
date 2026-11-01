import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { comparisonDisplayParts, renderComparisonName } from '../public/js/shared/comparison-display.js';

const effort = 'Extended reasoning with repeated verification and a generous token budget';
const harness = 'Research harness with a long configuration name, tool suite and version 2026.10';
const model = { modelID: 71, modelName: 'Example Model', condition: { scoreFields: [
    { fieldID: 20, value: effort }, { fieldID: 1, value: harness }
] } };
const comparison = { keys: ['model', 'field:20', 'field:1'], fields: [
    { ID: 20, name: 'Reasoning effort', type: 'text' }, { ID: 1, name: 'Agent harness', type: 'text' }
] };

class Element {
    constructor(tagName) {
        this.tagName = tagName;
        this.className = '';
        this.children = [];
        this.dataset = {};
        this.attributes = new Map();
        this.listeners = new Map();
        this.clientWidth = 120;
        this.scrollWidth = 480;
        this.scrollLeft = 0;
        this.classList = {
            add: name => this.classList.toggle(name, true),
            contains: name => this.className.split(' ').includes(name),
            toggle: (name, enabled) => {
                const names = new Set(this.className.split(' ').filter(Boolean));
                if (enabled) names.add(name); else names.delete(name);
                this.className = [...names].join(' ');
            }
        };
    }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    addEventListener(type, callback) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(callback);
        this.listeners.set(type, listeners);
    }
    emit(type, values = {}) {
        const event = { type, defaultPrevented: false, stopped: false,
            preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...values };
        for (const callback of this.listeners.get(type) ?? []) callback(event);
        return event;
    }
    scrollTo({ left }) {
        this.scrollLeft = Math.max(0, Math.min(this.scrollWidth - this.clientWidth, left));
        this.emit('scroll');
    }
}

function render(t, options) {
    const original = globalThis.document;
    globalThis.document = { createElement: tag => new Element(tag) };
    t.after(() => {
        if (original === undefined) delete globalThis.document;
        else globalThis.document = original;
    });
    const target = new Element('span');
    renderComparisonName(target, model, comparison, options);
    return target;
}

test('scrolling parameters retain complete values, tooltips, icons and model-name semantics', t => {
    const parts = comparisonDisplayParts(model, comparison);
    assert.deepEqual(parts.map(part => part.text), ['Example Model', effort, harness]);
    assert.equal(parts[1].title, `Reasoning effort: ${effort}`);
    const target = render(t);
    const [name, region] = target.children;
    assert.equal(name.children[0].translate, false);
    assert.equal(region.className, 'bp-model-parameters');
    assert.equal(region.tagName, 'span');
    assert.equal(region.attributes.get('role'), 'group');
    assert.equal(region.tabIndex, 0);
    assert.deepEqual(region.children.map(item => item.children[1].textContent), [effort, harness]);
    assert.deepEqual(region.children.map(item => item.dataset.tooltip), [`Reasoning effort: ${effort}`, `Agent harness: ${harness}`]);
    assert.deepEqual(region.children.map(item => item.children[0].className), ['fa-solid fa-brain', 'fa-solid fa-puzzle-piece']);
    assert.ok(region.children.every(item => item.children[0].attributes.get('aria-hidden') === 'true'));
});

test('homepage opt-out preserves flat parameter nodes for the rotated-label layout', t => {
    const target = render(t, { fitParameters: false });
    assert.equal(target.children.length, 3);
    assert.equal(target.classList.contains('has-scrollable-parameters'), false);
    assert.deepEqual(target.children.map(item => item.dataset.entryPart), ['model', 'field:20', 'field:1']);
    assert.ok(target.children.every(item => !item.classList.contains('bp-model-parameters')));
    assert.equal(target.children[2].dataset.tooltip, `Agent harness: ${harness}`);
});

test('gradient edges follow both scroll limits and disappear when values fit', t => {
    const region = render(t).children[1];
    const edges = () => [region.classList.contains('can-scroll-left'), region.classList.contains('can-scroll-right')];
    region.emit('scroll');
    assert.deepEqual(edges(), [false, true]);
    region.scrollTo({ left: 120 });
    assert.deepEqual(edges(), [true, true]);
    region.emit('keydown', { key: 'End' });
    assert.deepEqual(edges(), [true, false]);
    region.emit('keydown', { key: 'Home' });
    assert.deepEqual(edges(), [false, true]);
    region.scrollWidth = region.clientWidth;
    region.scrollLeft = -20;
    region.emit('scroll');
    assert.deepEqual(edges(), [false, false]);
});

test('swipes and drags suppress accidental activation without intercepting ordinary clicks', t => {
    const region = render(t).children[1];
    const pointer = { pointerId: 1, clientX: 100, clientY: 20 };
    region.emit('pointerdown', pointer);
    region.emit('pointermove', { ...pointer, clientX: 50 });
    region.emit('pointerup', { ...pointer, clientX: 50 });
    const dragClick = region.emit('click');
    assert.equal(dragClick.defaultPrevented, true);
    assert.equal(dragClick.stopped, true);
    region.emit('pointerdown', pointer);
    region.emit('pointerup', pointer);
    const ordinaryClick = region.emit('click');
    assert.equal(ordinaryClick.defaultPrevented, false);
    assert.equal(ordinaryClick.stopped, false);
    region.emit('pointerdown', pointer);
    region.scrollTo({ left: 80 });
    region.emit('pointerup', pointer);
    assert.equal(region.emit('click', { detail: 0 }).stopped, false, 'Keyboard-generated clicks are not drag gestures');
    assert.equal(region.emit('click').stopped, true);
});

test('parameter fonts are fixed and the coverage pie is outside the masked region', async () => {
    const source = await readFile(new URL('../public/js/shared/comparison-display.js', import.meta.url), 'utf8');
    const css = await readFile(new URL('../public/css/model-comparison.css', import.meta.url), 'utf8');
    const rows = await readFile(new URL('../public/js/workspace/model-list.js', import.meta.url), 'utf8');
    const layout = await readFile(new URL('../public/css/ui/workspace.css', import.meta.url), 'utf8');
    assert.doesNotMatch(source + css, /--bp-parameter-font-size|naturalWidth|11 \* available/);
    assert.match(css, /\.bp-model-display-parameter > span\s*\{[^}]*font-size: 11px/);
    assert.match(css, /\.bp-model-parameters\s*\{[^}]*overflow-x: auto/);
    assert.match(css, /\.bp-model-parameters:is\(\.can-scroll-left, \.can-scroll-right\)[^}]*mask-image: linear-gradient\(to right/);
    assert.match(rows, /identity\.append\(coverage\)/);
    assert.doesNotMatch(rows, /modelName\.append\(coverage\)/);
    assert.match(layout, /\.bp-model-coverage\s*\{[^}]*flex: 0 0 16px/);
    assert.doesNotMatch(layout, /\.bp-model-name-wrap > \.bp-model-coverage\s*\{[^}]*margin-inline-start: auto/);
    assert.match(css, /\.bp-model-name\.bp-comparison-entry-label\s*\{[^}]*flex: 0 1 auto/);
});
