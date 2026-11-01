import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UI_COMPONENTS, observeCustomSelects, handleCustomSelectKeydown } from '../public/js/shared/ui-components.js';
import { mountCustomSelect } from '../public/js/shared/custom-select.js';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('select is a shared field adapter, not a sixth primitive or multiple skins', () => {
    assert.deepEqual(UI_COMPONENTS, ['action', 'segmented', 'field', 'disclosure', 'dialog']);
    for (const API of [mountCustomSelect, observeCustomSelects, handleCustomSelectKeydown]) assert.equal(typeof API, 'function');
    const code = read('public/js/shared/custom-select.js');
    assert.match(code, /root\.dataset\.uiComponent = 'field'/);
    assert.match(code, /bp-ui-field bp-ui-select-trigger/);
    assert.doesNotMatch(code, /type = 'search'|type="search"|data\.skin|data\.variant/);
});

test('global and local adoption cover future selects and cooperate with dialog keyboard traps', () => {
    assert.match(read('public/js/shared/ui-components.js'), /observeCustomSelects\(root\)/);
    const global = read('public/js/global.js');
    assert.match(global, /observeCustomSelects\(\)/);
    assert.ok(global.indexOf('if (handleCustomSelectKeydown(event)) return;') < global.indexOf('const dialog = openDialogs.at(-1)'));
    assert.match(global, /control\.tabIndex >= 0 \|\| control\.matches\('global-dialog-action'\)/);
    const code = read('public/js/shared/custom-select.js');
    assert.match(code, /node\.matches\?\.\('select'\)/);
    assert.match(code, /childList: true, subtree: true, attributes: true/);
    assert.match(code, /controller\.destroy\(\)/);
    assert.match(global, /ui-components\.js\?v=custom-select-20261013/);
    assert.match(global, /components\.css\?v=custom-select-20261013/);
    assert.match(read('public/js/shared/ui-components.js'), /custom-select\.js\?v=custom-select-20261013/);
});

test('viewport events are positioned without treating Window or VisualViewport as DOM nodes', () => {
    const code = read('public/js/shared/custom-select.js');
    assert.match(code, /event\?\.target instanceof view\.Node && state\.active\.popup\.contains\(event\.target\)/);
    assert.match(code, /view\.visualViewport\?\.addEventListener\('scroll', reposition\)/);
    assert.match(code, /view\.addEventListener\('resize', reposition\)/);
});

test('native backing is not an activatable menu and keeps original event and form semantics', () => {
    const styles = read('public/css/ui/components.css');
    assert.match(styles, /body select\.bp-ui-select-native \{[^}]*display: none !important;[^}]*pointer-events: none !important/s);
    assert.match(styles, /body select, body select\.bp-ui-select-native/);
    const code = read('public/js/shared/custom-select.js');
    assert.match(code, /select\.setAttribute\('aria-hidden', 'true'\)/);
    assert.match(code, /select\.tabIndex = -1/);
    assert.match(code, /Object\.defineProperty\(select, 'focus'/);
    assert.match(code, /Object\.defineProperty\(view\.HTMLSelectElement\.prototype, 'focus'/);
    assert.match(code, /Object\.defineProperty\(select, 'showPicker'/);
    assert.match(code, /select\.dispatchEvent\(new view\.Event\('input', \{ bubbles: true, composed: true \}\)\)/);
    assert.match(code, /select\.dispatchEvent\(new view\.Event\('change', \{ bubbles: true, composed: true \}\)\)/);
    assert.match(code, /select\.dispatchEvent\(new view\.FocusEvent\('focus'/);
    assert.match(code, /select\.dispatchEvent\(new view\.FocusEvent\('blur'/);
    assert.match(code, /select\.validationMessage/);
    assert.match(code, /select\.matches\(':disabled'\)/);
    assert.match(code, /controller\.select\.form === event\.target/);
});

test('direct assignments, collection setters and reset do not require business rerender hooks', () => {
    const code = read('public/js/shared/custom-select.js');
    for (const property of ['value', 'selectedIndex']) assert.ok(code.includes(`intercept(select, '${property}', refresh, propertyRestores)`));
    assert.match(code, /intercept\(option, 'selected', refresh, optionRestores\)/);
    assert.match(code, /view\.setInterval/);
    assert.match(code, /view\.queueMicrotask/);
    assert.match(code, /event\.defaultPrevented/);
    assert.match(code, /restoreProperties\(optionRestores\)/);
});

test('the select-only keyboard contract includes navigation, typeahead and explicit commitment', () => {
    const code = read('public/js/shared/custom-select.js');
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', 'Escape', 'Tab', 'PageDown', 'PageUp']) assert.ok(code.includes(`'${key}'`));
    for (const attribute of ['role', 'aria-activedescendant', 'aria-expanded', 'aria-selected', 'aria-disabled', 'aria-required']) assert.ok(code.includes(`'${attribute}'`));
    assert.match(code, /typedAt > 700/);
    assert.match(code, /event\.stopImmediatePropagation\(\)/);
    assert.match(code, /option\.parentElement\?\.disabled/);
    assert.match(code, /option\.parentElement\?\.hidden/);
});

test('the shared select skin has internal focus, distinct states and safe text/touch geometry', () => {
    const styles = read('public/css/ui/components.css');
    const selectStyles = styles.slice(styles.indexOf('/* Select is a field behavior'), styles.indexOf('body .bp-ui-disclosure {'));
    assert.match(selectStyles, /:focus-visible \{ outline: 2px solid var\(--bp-accent\); outline-offset: -4px/);
    assert.match(selectStyles, /aria-selected="true"[^}]*background: var\(--bp-selected\)/);
    assert.match(selectStyles, /:hover:not\(\[aria-disabled="true"\]\):not\(\[aria-selected="true"\]\)[^}]*background: var\(--bp-hover\)/);
    assert.match(selectStyles, /text-overflow: ellipsis/);
    assert.match(selectStyles, /overflow-wrap: anywhere/);
    assert.doesNotMatch(selectStyles, /border-(?:left|right|top|bottom)|inset\s+\d/);
    assert.match(styles, /\.bp-ui-select > \.bp-ui-select-trigger \{ font-size: 16px; \}/);
    assert.match(styles, /\.bp-ui-select \.bp-ui-select-option \{ min-height: 44px; \}/);
    assert.match(styles, /\.bp-ui-select \.bp-ui-select-popup\[data-ui-open="true"\] \{ animation: none; \}/);
    assert.match(styles, /outline-color: Highlight/);
});

test('single-line fields and select triggers share one border-box height across screens', () => {
    const styles = read('public/css/ui/components.css');
    assert.match(styles, /--ui-control-height: 44px/);
    for (const selector of ['body .bp-ui-field', 'body input.bp-ui-input', 'body .bp-ui-select > .bp-ui-select-trigger']) {
        const declaration = styles.slice(styles.indexOf(selector + ' {')).split('}')[0];
        assert.match(declaration, /box-sizing: border-box/);
        assert.match(declaration, /height: var\(--ui-control-height\)/);
        assert.match(declaration, /min-height: var\(--ui-control-height\)/);
    }
    assert.match(styles, /height: calc\(var\(--ui-control-height\) - 2px\)/);
    assert.match(read('public/js/workspace/comparison-controls.js'), /input\.className = 'bp-filter-value-input bp-ui-input'/);
});
