import test from 'node:test';
import assert from 'node:assert/strict';
import { horizontalScrollEdges, createChainScrollEdges } from '../public/js/workspace/chain-scroll-edges.js';

test('horizontal overflow indicators follow the unread edges', () => {
    const edges = scrollLeft => horizontalScrollEdges({ scrollLeft, scrollWidth: 500, clientWidth: 200 });
    assert.deepEqual(edges(0), { left: false, right: true });
    assert.deepEqual(edges(150), { left: true, right: true });
    assert.deepEqual(edges(300), { left: true, right: false });
    assert.deepEqual(edges(-30), { left: false, right: true });
    assert.deepEqual(edges(330), { left: true, right: false });
    assert.deepEqual(edges(0.75), { left: false, right: true });
    assert.deepEqual(edges(299.25), { left: true, right: false });
});

test('fitting, empty, hidden and subpixel geometry has no phantom shadow', () => {
    for (const [scrollWidth, clientWidth] of [[100, 200], [200, 200], [0, 200], [500, 0], [200.75, 200]]) {
        assert.deepEqual(horizontalScrollEdges({ scrollLeft: 0, scrollWidth, clientWidth }), { left: false, right: false });
    }
});

test('shared observers release replaced rows and stop on disposal', () => {
    const names = ['ResizeObserver', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
    const original = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const frames = new Map(); let frameID = 0;
    const resizeObservers = []; const mutationObservers = [];
    globalThis.requestAnimationFrame = callback => { frames.set(++frameID, callback); return frameID; };
    globalThis.cancelAnimationFrame = ID => frames.delete(ID);
    globalThis.ResizeObserver = class {
        nodes = new Set();
        constructor(callback) { this.callback = callback; resizeObservers.push(this); }
        observe(node) { this.nodes.add(node); }
        unobserve(node) { this.nodes.delete(node); }
        disconnect() { this.nodes.clear(); }
    };
    globalThis.MutationObserver = class {
        constructor(callback) { this.callback = callback; mutationObservers.push(this); }
        observe() {}
        disconnect() { this.disconnected = true; }
    };
    const flush = () => {
        const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback());
    };
    const chain = () => {
        const classes = new Set();
        return { scrollLeft: 0, scrollWidth: 500, clientWidth: 200, children: [{}, {}],
            matches: value => value === '.bp-benchmark-family-chain',
            parentElement: { classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
                remove(...names) { names.forEach(name => classes.delete(name)); } }, classes } };
    };
    let current = [chain(), chain()];
    const fontListeners = new Map(); const listeners = new Map();
    const container = {
        ownerDocument: { fonts: { addEventListener(name, callback) { fontListeners.set(name, callback); },
            removeEventListener(name) { fontListeners.delete(name); } } },
        querySelectorAll: () => current,
        addEventListener(name, callback, options) { listeners.set(name, callback); assert.deepEqual(options, { capture: true, passive: true }); },
        removeEventListener(name) { listeners.delete(name); }
    };
    try {
        const control = createChainScrollEdges(container);
        flush();
        assert.equal(resizeObservers.length, 1);
        assert.equal(mutationObservers.length, 1);
        assert.equal(resizeObservers[0].nodes.size, 6);
        assert.equal(current[0].parentElement.classes.has('can-scroll-right'), true);
        current[0].scrollLeft = 300;
        listeners.get('scroll')({ target: current[0] });
        assert.deepEqual([...current[0].parentElement.classes], ['can-scroll-left']);
        const old = current.flatMap(node => [node, ...node.children]);
        current = [chain()]; current[0].scrollWidth = 100;
        mutationObservers[0].callback(); mutationObservers[0].callback();
        assert.equal(frames.size, 1, 'Coalesce repeated DOM changes');
        flush();
        assert.equal(resizeObservers[0].nodes.size, 3);
        assert.equal(old.some(node => resizeObservers[0].nodes.has(node)), false);
        assert.equal(current[0].parentElement.classes.size, 0);
        current[0].scrollWidth = 600;
        resizeObservers[0].callback(); flush();
        assert.equal(current[0].parentElement.classes.has('can-scroll-right'), true);
        fontListeners.get('loadingdone')();
        control.destroy();
        assert.equal(frames.size, 0);
        assert.equal(resizeObservers[0].nodes.size, 0);
        assert.equal(mutationObservers[0].disconnected, true);
        assert.equal(listeners.size, 0);
        assert.equal(fontListeners.size, 0);
        assert.equal(current[0].parentElement.classes.size, 0);
        control.refresh(); assert.equal(frames.size, 0);
    } finally {
        for (const [name, descriptor] of original) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    }
});
