import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createBenchmarkInformationLink } from '../public/js/workspace/benchmark-link.js';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('shared version links preserve identity, escape text and inspect only ordinary clicks', () => {
    const previous = globalThis.document;
    globalThis.document = { createElement: tag => ({ tag, dataset: {}, children: [], attributes: {}, listeners: {},
        append(child) { this.children.push(child); }, setAttribute(key, value) { this.attributes[key] = value; },
        addEventListener(key, handler) { this.listeners[key] = handler; } }) };
    try {
        let inspections = 0;
        const member = { conditionID: 7, benchmarkID: 101, name: '<Benchmark>', conditionName: 'v2 & offline' };
        const link = createBenchmarkInformationLink(member, { getURL: item => {
            assert.equal(item, member); return '/?discussion=1&benchmarkID=101&conditionID=7';
        }, onInspect: () => { inspections++; }, showVersion: true });
        assert.equal(link.tag, 'a'); assert.equal(link.dataset.benchmarkControl, 'information');
        assert.equal(link.children[0].textContent, '<Benchmark>');
        assert.equal(link.children[1].textContent, 'v2 & offline');
        assert.equal(link.innerHTML, undefined);
        assert.match(link.href, /conditionID=7/);
        for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) link.listeners.click({ button: 0, [modifier]: true });
        link.listeners.click({ button: 1 }); assert.equal(inspections, 0);
        link.listeners.click({ button: 0 }); assert.equal(inspections, 1);
        const short = createBenchmarkInformationLink(member, { getURL: () => '/', label: 'v2' });
        assert.equal(short.textContent, 'v2'); assert.equal(short.children.length, 0);
        const ordinary = createBenchmarkInformationLink(member, { getURL: () => '/?conditionID=7' });
        assert.equal(ordinary.children.length, 1);
        assert.equal(ordinary.children[0].textContent, '<Benchmark>');
        assert.doesNotMatch(ordinary.attributes['aria-label'], /v2/);
        assert.match(link.attributes['aria-label'], /v2 & offline/);
    } finally { globalThis.document = previous; }
});

test('disclosure motion leaves nested information links and buttons alone', async () => {
    const source = await read('public/js/shared/motion.js');
    const functionSource = source.slice(source.indexOf('export function mountDisclosureMotion(')).replace('export ', '');
    let listener, prevented = 0, toggled = 0;
    const details = { matches: () => true }, summary = { parentElement: details, contains: () => true };
    const container = { addEventListener: (_, handler) => { listener = handler; }, contains: () => true };
    const context = vm.createContext({ setDisclosureOpen: () => { toggled++; }, isDisclosureOpen: () => false });
    vm.runInContext(functionSource, context); context.mountDisclosureMotion(container, 'details');
    const event = control => ({ target: { closest: selector => selector === 'summary' ? summary : control },
        preventDefault: () => { prevented++; } });
    listener(event({ tagName: 'A' })); listener(event({ tagName: 'BUTTON' }));
    assert.equal(prevented, 0); assert.equal(toggled, 0);
    listener(event(null)); assert.equal(prevented, 1); assert.equal(toggled, 1);
});

test('empty discovery actions use existing forms and preserve search and category details', async () => {
    const home = await read('public/js/home-workspace.js');
    const actions = home.slice(home.indexOf('function appendBenchmarkDiscoveryActions('), home.indexOf('function onBenchmarkActivation('));
    assert.match(actions, /bulkImportTemplate\(\{ query, categoryPath: state.categoryPath, contextValues: state.selectedContextValues \}/);
    assert.match(actions, /contributionEditURL\('new_benchmark', \{ benchmarkName: query/);
    assert.match(actions, /contributionEditURL\('feedback', \{ targetKind: 'bulk_import', details, pageURL: window.location.href \}/);
    assert.match(home, /empty\.append\(retry\);\s*\} else if \(!expanded\) appendBenchmarkDiscoveryActions\(empty\)/);
    assert.doesNotMatch(actions, /postJSON|postWriteJSON|scheduleSave/);
});

test('all score and fallback views reuse information links without wrapping them in buttons', async () => {
    for (const module of ['model-scores', 'family-view', 'fallback-picker']) {
        assert.match(await read(`public/js/workspace/${module}.js`), /createBenchmarkInformationLink/);
    }
    const home = await read('private/home.html');
    assert.match(home, /<div id="inline-fallback-preview"/);
    assert.doesNotMatch(home, /<button id="inline-fallback-configurations"[^>]*>\s*<span id="inline-fallback-preview-sequence"/);
    const controller = await read('public/js/home-workspace.js');
    assert.match(controller, /inlineFallbackConfigurations\.addEventListener\('click'/);
    assert.doesNotMatch(controller, /inlineFallback(?:Settings|Preview)\.addEventListener\('(?:click|keydown)'/);
    assert.doesNotMatch(await read('public/css/ui/fallback.css'), /settings:not\(\.is-editing\) \{ cursor: pointer; \}/);
});

test('finish editing is visibly an action, not a checkmarked completion status', async () => {
    const home = await read('private/home.html');
    const done = home.match(/<button id="inline-fallback-done"[\s\S]*?<\/button>/)[0];
    assert.match(done, /data-ui-variant="secondary"/);
    assert.match(done, /Finish editing/);
    assert.doesNotMatch(done, /fa-check|bp-quiet-action/);
});
