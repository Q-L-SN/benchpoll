import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { UI_COMPONENTS, mountInputClear, observeInputClears } from '../public/js/shared/ui-components.js';

const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');

test('input clear is a shared field behavior, including pages that only compose individual primitives', () => {
    assert.deepEqual(UI_COMPONENTS, ['action', 'segmented', 'field', 'disclosure', 'dialog']);
    for (const method of [mountInputClear, observeInputClears]) assert.equal(typeof method, 'function');
    const code = read('public/js/shared/ui-components.js');
    assert.match(code, /observeInputClears\(root\)/);
    for (const readyState of ['loading', 'complete']) {
        let onReady;
        const calls = [];
        vm.runInNewContext(code.slice(code.indexOf('// Some pages compose primitives')), {
            document: { readyState, addEventListener(name, callback) { assert.equal(name, 'DOMContentLoaded'); onReady = callback; } },
            observeInputClears: () => calls.push('clear'), observeDisclosureChevrons: () => calls.push('disclosure'),
            observeTextareaAutosize: () => calls.push('autosize')
        });
        if (readyState === 'loading') { assert.deepEqual(calls, []); onReady(); }
        assert.deepEqual(calls, ['clear', 'disclosure', 'autosize']);
    }
});

test('only search fields and explicitly opted-in text fields get generated clear controls', () => {
    const code = read('public/js/shared/input-clear.js');
    assert.match(code, /input\[type="search"\]/);
    assert.match(code, /input\[role="searchbox"\]/);
    assert.match(code, /input\[data-ui-clearable\]/);
    assert.match(code, /\['search', 'text', 'email', 'url', 'tel'\]\.includes\(input\.type\)/);
    assert.match(code, /input\.dataset\.uiClearable !== 'false'/);
    assert.doesNotMatch(code, /closest\(['"]button|querySelectorAll\(['"]button|fa-times|\[class\*=/);
});

test('known close and clear/close-morph actions are adopted without replacing their handlers or labels', () => {
    const code = read('public/js/shared/input-clear.js');
    assert.match(code, /\['topic-search', 'topic-search-close'\]/);
    assert.match(code, /\['configured-search', 'navigation-search-close'\]/);
    assert.match(code, /action\.parentElement === parent/);
    assert.match(code, /if \(!existing\) \{\s*button\.addEventListener\('mousedown'/);
    assert.match(code, /if \(disposed \|\| existing\) return/);
    assert.doesNotMatch(code, /addEventListener\('keydown'|stopPropagation|stopImmediatePropagation/);
});

test('clearing retains form backing, guards editing state, and emits one pair of bubbling events', () => {
    const code = read('public/js/shared/input-clear.js');
    assert.match(code, /button\.type = 'button'/);
    assert.match(code, /input\.matches\(':disabled'\) \|\| input\.readOnly \|\| !input\.value/);
    assert.match(code, /input\.focus\(\{ preventScroll: true \}\)/);
    assert.match(code, /input\.dispatchEvent\(new view\.Event\('input', \{ bubbles: true, composed: true \}\)\)/);
    assert.match(code, /input\.dispatchEvent\(new view\.Event\('change', \{ bubbles: true, composed: true \}\)\)/);
    assert.doesNotMatch(code, /input\.type\s*=(?!=)|input\.name\s*=(?!=)|input\.required\s*=(?!=)|requestSubmit|\.submit\(/);
});

test('dynamic fields, canceled resets and programmatic values share the same lifecycle', () => {
    const code = read('public/js/shared/input-clear.js');
    assert.match(code, /childList: true, subtree: true, attributes: true/);
    assert.match(code, /document\.defaultView\.queueMicrotask/);
    assert.match(code, /event\.defaultPrevented/);
    assert.match(code, /controller\.input\.form === event\.target/);
    assert.match(code, /Object\.defineProperty\(input, 'value'/);
    assert.match(code, /restoreValue\(\)/);
    assert.match(code, /controller\.destroy\(\)/);
});

test('clear controls have one large transparent skin, a focus cue, and no duplicate native glyph', () => {
    const css = read('public/css/ui/components.css');
    const rule = css.match(/body button\.bp-ui-field-clear \{([^}]+)\}/)[1];
    for (const property of ['width', 'height', 'min-width', 'min-height']) assert.match(rule, new RegExp(`${property}: 44px !important`));
    for (const declaration of ['background: transparent !important', 'border: 0 !important', 'box-shadow: none !important', 'transition: none !important']) assert.ok(rule.includes(declaration));
    assert.match(css, /\.bp-ui-field-clear:focus-visible \{ outline: 2px solid var\(--bp-accent/);
    assert.match(css, /\.bp-ui-clear-input::-webkit-search-cancel-button \{ display: none; -webkit-appearance: none/);
    assert.match(css, /\.bp-ui-field-clear\[hidden\] \{ display: none !important/);
});
