import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { excludedFromRanking, AA_EXCLUSION_MESSAGE } from '../public/js/shared/aa-ranking-policy.js';
import { isTopicReference } from '../public/js/workspace/topic-references.js';

test('toast is polite, uses text content, replaces its timer and clears without moving focus', async () => {
    const source = await readFile(new URL('../public/js/shared/toast.js', import.meta.url), 'utf8');
    const nodes = [], timers = new Map();
    let nextTimer = 0;
    const document = { body: { append(node) { nodes.push(node); } }, createElement(tag) {
        const classes = new Set();
        return { tag, children: [], attributes: {}, textContent: '', style: { removeProperty() {} },
            classList: { add(value) { classes.add(value); }, remove(value) { classes.delete(value); }, contains(value) { return classes.has(value); } },
            setAttribute(key, value) { this.attributes[key] = value; }, append(...children) { this.children.push(...children); } };
    } };
    const create = vm.runInNewContext(source.replace('export function', 'function') + '\ncreateToast', {
        document, setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout(ID) { timers.delete(ID); }
    });
    const toast = create();
    assert.equal(nodes.length, 1); const root = nodes[0], label = root.children[1];
    assert.equal(root.attributes.role, 'status'); assert.equal(root.attributes['aria-live'], 'polite');
    assert.equal(label.textContent, ''); assert.equal(root.classList.contains('is-visible'), false);
    toast.show('<not HTML> added.'); assert.equal(label.textContent, '<not HTML> added.');
    assert.equal(root.classList.contains('is-visible'), true); assert.equal(timers.size, 1);
    toast.show('Added to your fallback list.'); assert.equal(timers.size, 1); assert.equal(label.textContent, 'Added to your fallback list.');
    [...timers.values()][0](); assert.equal(label.textContent, ''); assert.equal(root.classList.contains('is-visible'), false);
    assert.equal(timers.size, 0);
    assert.doesNotMatch(source, /innerHTML|\.focus\(/);
});

test('toast tracks an existing floating hint and removes the clearance after the hint hides', async () => {
    const source = await readFile(new URL('../public/js/shared/toast.js', import.meta.url), 'utf8');
    const styles = new Map(); let resize, bounds = { top: 700, height: 126 };
    const avoid = { getBoundingClientRect() { return bounds; } };
    const document = { body: { append() {} }, createElement() { return {
        classList: { add() {}, remove() {} }, setAttribute() {}, append() {},
        style: { setProperty(key, value) { styles.set(key, value); }, removeProperty(key) { styles.delete(key); } }
    }; } };
    const create = vm.runInNewContext(source.replace('export function', 'function') + '\ncreateToast', {
        document, setTimeout() {}, clearTimeout() {}, window: { innerHeight: 844,
            ResizeObserver: class { constructor(callback) { resize = callback; } observe(node) { assert.equal(node, avoid); } } }
    });
    const toast = create({ avoid }); toast.show('Added.');
    assert.equal(styles.get('--toast-bottom'), '156px');
    bounds = { top: 640, height: 186 }; resize(); assert.equal(styles.get('--toast-bottom'), '216px');
    bounds = { top: 0, height: 0 }; resize(); assert.equal(styles.has('--toast-bottom'), false);
});

const workspace = await readFile(new URL('../public/js/home-workspace.js', import.meta.url), 'utf8');
const functionText = (name, next) => workspace.slice(workspace.indexOf(`function ${name}(`), workspace.indexOf(`function ${next}(`));

test('main Pie success notification follows a real insertion, not a duplicate, rejected or blocked Add', () => {
    const state = { personalEntries: [], limits: { maxPieItems: 2, totalBasisPoints: 10000 } };
    const messages = []; let allowed = true, saves = 0;
    const add = vm.runInNewContext(functionText('addObjectToPersonalPie', 'objectInPersonalPie') + '\naddObjectToPersonalPie', {
        state, excludedFromRanking, AA_EXCLUSION_MESSAGE, isTopicReference, MIN_WEIGHT_BASIS_POINTS: 1, hiddenPersonalBenchmarkIDs: new Set(),
        beginMutation() { return allowed; }, distributeToTarget(values) { return values; }, registerPieEntries() {},
        scheduleSave() { saves++; }, setStatus() {}, additionToast: { show(text) { messages.push(text); } }
    });
    const object = { ID: 1, benchmarkID: 101, name: 'Benchmark' };
    assert.equal(add(object), true); assert.deepEqual(messages, ['Added to Personal Weights.']); assert.equal(saves, 1);
    assert.equal(add(object), true); assert.equal(messages.length, 1); assert.equal(saves, 1);
    allowed = false; assert.equal(add({ ...object, ID: 2 }), false); assert.equal(messages.length, 1);
    allowed = true; state.limits.maxPieItems = 1;
    assert.equal(add({ ...object, ID: 2 }), false); assert.equal(messages.length, 1);
});

test('fallback Add confirms only a new explicit member and rejects nesting another configuration', () => {
    const primary = { ID: 1 }, messages = []; let entries = [], allowed = true, active = true;
    const add = vm.runInNewContext(functionText('addObjectToFallbackChain', 'moveFallbackMember') + '\naddObjectToFallbackChain', {
        excludedFromRanking, AA_EXCLUSION_MESSAGE, selectedInlineFallbackPrimary() { return primary; }, isInlineFallbackTargetActive() { return active; },
        fallbackRuleFor() { return { entries }; }, beginMutation() { return allowed; },
        fallbackComponentFromBenchmark(object) { return { conditionID: object.ID }; },
        replaceFallbackRuleEntries(ID, values) { entries = values; }, fallbackTargetPrimaryID: null,
        setStatus() {}, renderPie() {}, renderBenchmarks() {}, scheduleSave() {},
        additionToast: { show(text) { messages.push(text); } }
    });
    assert.equal(add({ ID: 2, isFamily: true }), false); assert.equal(messages.length, 0);
    assert.equal(add({ ID: 1 }), false); assert.equal(messages.length, 0);
    allowed = false; assert.equal(add({ ID: 2 }), false); assert.equal(messages.length, 0);
    allowed = true; assert.equal(add({ ID: 2 }), true); assert.deepEqual(messages, ['Added to your fallback list.']);
    assert.equal(add({ ID: 2 }), true); assert.equal(messages.length, 1);
    active = false; assert.equal(add({ ID: 3 }), false); assert.equal(messages.length, 1);
});
