import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UI_COMPONENTS } from '../public/js/shared/ui-components.js';

const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');

test('the UI inventory has five primitives rather than one component per old skin', () => {
    assert.deepEqual(UI_COMPONENTS, ['action', 'segmented', 'field', 'disclosure', 'dialog']);
    assert.match(read('public/css/site-palette.css'), /ui\/components.css/);
    assert.match(read('public/js/global.js'), /class="bp-ui-action"/);
    assert.match(read('public/js/global.js'), /css\/ui\/components.css/);
    assert.doesNotMatch(read('public/js/global.js'), /#button \{\s*min-height:/);
});

test('workspace switches retain measured segmented geometry while sidebar modes are icon-only', () => {
    const html = read('private/home.html');
    for (const name of ['bp-mode-switch', 'bp-scoring-switch']) {
        assert.match(html, new RegExp(`class="[^"]*${name}[^>]+data-ui-component="segmented"`));
    }
    assert.deepEqual([...html.matchAll(/data-navigation-view="([^"]+)"/g)].map(match => match[1]), ['popular', 'recent', 'configured', 'search']);
    for (const [view, label, title] of [['popular', 'Popular topics', 'Popular'], ['recent', 'Recently viewed topics', 'Recent'],
        ['configured', 'Mine', 'Mine'], ['search', 'Search topics', 'Search']]) {
        assert.match(html, new RegExp(`data-navigation-view="${view}"[^>]+aria-label="${label}"[^>]+data-tooltip="${title}"[^>]+aria-pressed="${view === 'popular'}"[^>]*><i[^>]+aria-hidden="true"[^>]*><\\/i><\\/button>`));
    }
    const code = read('public/js/shared/ui-components.js');
    assert.match(code, /marker\.offsetLeft/);
    assert.match(code, /marker\.offsetWidth/);
    const observed = code.match(/attributeFilter:\s*\[([^\]]+)\]/)?.[1];
    for (const attribute of ['aria-selected', 'aria-pressed', 'hidden']) assert.ok(observed?.includes(`'${attribute}'`));
    assert.doesNotMatch(code, /addEventListener\('click'/);
    assert.match(code, /resize\.disconnect\(\)/);
    assert.match(code, /selection\.disconnect\(\)/);
});

test('the shared segmented primitive uses content-sized, single-line slots and state-stable typography', () => {
    const styles = read('public/css/ui/components.css');
    const root = styles.match(/body \.bp-ui-segmented\[data-ui-component="segmented"\] \{([^}]+)\}/)[1];
    assert.match(root, /display: flex/);
    assert.match(root, /min-width: max-content/);
    assert.match(styles, /flex: 1 0 auto/);
    assert.match(root, /padding: 2px/);
    assert.match(styles, /font: 600 12px\/1\.35/);
    assert.match(styles, /white-space: nowrap/);
    assert.match(styles, /min-height: 32px/);
    assert.doesNotMatch(styles, /aria-pressed="true"[^{}]*\{[^}]*font-weight/);
});

test('fallback and ordinary benchmark identities share unframed left-aligned typography', () => {
    const code = read('public/js/workspace/model-scores.js');
    assert.match(code, /title\.append\(benchmark \? informationLink\(benchmark\)/);
    assert.match(code, /iconOnly: true, className: 'bp-model-fallback-toggle'/);
    assert.doesNotMatch(code, /createDisclosureTrigger\(\{ name: benchmarkName/);
    const styles = read('public/css/ui/components.css');
    const rule = styles.match(/body \.bp-ui-disclosure \{([^}]+)\}/)[1];
    assert.match(rule, /justify-content: flex-start/);
    assert.match(rule, /text-align: left/);
    assert.match(rule, /border: 0/);
    assert.match(rule, /background: transparent/);
    assert.doesNotMatch(read('public/css/ui/control-policy.css'), /bp-model-fallback-toggle/);
});

test('both benchmark weight columns remain numeric with or without fallback', () => {
    const code = read('public/js/home-workspace.js');
    const columns = code.slice(code.indexOf("publicValue.className = 'bp-benchmark-weight"), code.indexOf('const actionCell', code.indexOf("publicValue.className = 'bp-benchmark-weight")));
    assert.match(columns, /publicValue.textContent/);
    assert.match(columns, /personalValue.textContent/);
    assert.doesNotMatch(columns, /createElement\('i'\)|has-fallback|code-branch/);
});

test('contribution rerenders adopt shared controls rather than recreating old button skins', () => {
    assert.match(read('public/js/contribute.js'), /enhanceUI\(stepSurface\)/);
    assert.doesNotMatch(read('public/css/contribute.css'), /^\.primary-button \{/m);
    assert.doesNotMatch(read('public/css/contribute.css'), /^\.soft-icon-button \{/m);
});

test('shared inputs retain combobox adornment space and framed search icons occupy a flex slot', () => {
    const styles = read('public/css/ui/components.css');
    const input = styles.match(/body \.bp-ui-input \{([^}]+)\}/)[1];
    assert.match(input, /padding: 8px var\(--ui-input-padding-end, 10px\) 8px var\(--ui-input-padding-start, 10px\)/);
    const icon = styles.match(/body \.bp-ui-field > i \{([^}]+)\}/)[1];
    assert.match(icon, /position: static/);
    assert.match(icon, /transform: none/);
    assert.match(icon, /flex: 0 0 16px/);
    const forms = read('public/css/contribute.css');
    assert.match(forms, /\.evaluation-combobox \{[^}]*--ui-input-padding-start: 39px/);
    assert.match(forms, /\.evaluation-combobox\.has-selection:not\(\.has-model-selection\) \{[^}]*--ui-input-padding-start: 13px/);
    assert.match(forms, /\.evaluation-combobox\.has-model-selection \{[^}]*--ui-input-padding-start: 44px/);
});

test('shared framed inputs paint one complete focus surface without adding an external frame', () => {
    const policy = read('public/css/ui/control-policy.css');
    const frame = policy.match(/body :is\(\.bp-ui-field:has\(input, textarea\),[\s\S]*?\):focus-within \{([^}]+)\}/)?.[1];
    assert.ok(frame);
    assert.match(frame, /background-color: var\(--bp-surface-soft\) !important/);
    assert.match(frame, /outline: none !important/);
    assert.match(frame, /box-shadow: none !important/);
    assert.doesNotMatch(policy, /:is\(\.bp-ui-field,/);
    assert.match(policy, /\):focus-within :is\(input, textarea\):focus \{\s*background-color: transparent !important/);
    assert.match(policy, /\[aria-invalid="true"\] \{\s*border-color: #b24d54 !important/);
});

test('topic creation is contained in Mine and other navigation actions retain quiet skins', () => {
    const html = read('private/home.html');
    for (const ID of ['configured-browse', 'configured-login']) {
        assert.match(html, new RegExp(`id="${ID}"[^>]*class="bp-quiet-action"`));
    }
    const mine = html.match(/<section id="configured-panel"[\s\S]*?<\/section>/)[0];
    assert.doesNotMatch(html, /data-create-topic="public"|id="mine-panel"/);
    assert.match(mine, /data-create-topic="private"/);
    assert.match(mine, /for="topic-create-name">Topic name<\/label>/);
    assert.doesNotMatch(html, /private-category-create-toggle/);
    assert.match(html, /id="configured-browse"[^>]*><span class="bp-ui-action-label">Browse topics<\/span>/);
    assert.match(mine, /class="primary-button" type="submit"><i[^>]+><\/i><span>Create<\/span>/);
    assert.doesNotMatch(read('public/css/ui/navigation.css'), /\.bp-configured-actions button\s*\{/);
    assert.doesNotMatch(read('public/css/ui/private-categories.css'), /\.bp-private-category-form button/);
});
