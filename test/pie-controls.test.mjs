import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('Personal guidance retains its two live text targets without a decorative information icon', () => {
    const guidance = read('private/home.html').match(/<div id="personal-pie-guidance"[^>]*>([\s\S]*?)<\/div>/)[1];
    assert.match(guidance, /id="pie-instruction"/);
    assert.match(guidance, /id="pie-context-note"/);
    assert.doesNotMatch(guidance, /<i|fa-circle-info|fa-circle-question/);
    const style = read('public/css/ui/workspace.css');
    assert.match(style, /\.bp-pie-guidance\s*\{[^}]*display: grid;[^}]*grid-template-columns:/);
    assert.match(style, /\.bp-pie-guidance p:last-child\s*\{[^}]*text-align: right/);
    assert.match(style, /\.bp-pie-guidance p\s*\{[^}]*overflow-wrap: anywhere/);
});

test('Fallback footer is two compact action cells without decorative borders', () => {
    const style = read('public/css/ui/fallback.css');
    assert.match(style, /\.bp-fallback-add-actions \{[^}]*gap: 4px; padding: 0;/);
    assert.match(style, /\.bp-fallback-add-actions > button \{[^}]*min-height: 44px;[^}]*border: 0; border-radius: 0;/);
    assert.doesNotMatch(style, /\.bp-fallback-add-actions > button \+ button \{ border-left:/);
    assert.match(style, /\.bp-fallback-add-actions > button:focus-visible \{[^}]*outline-offset: -3px/);
    assert.match(style, /\.bp-fallback-add-actions > button:hover:not\(:disabled\)/);
    const html = read('private/home.html');
    assert.match(html, /bp-fallback-add-actions" role="group" aria-label="Add fallback options"/);
});

test('Question glyphs have fixed dimensions; mobile guide links appear only inside the open drawer', () => {
    const icon = read('public/css/global.css').match(/\.fa-regular\.fa-circle-question \{([^}]+)\}/)[1];
    for (const property of ['width', 'height', 'font-size']) assert.match(icon, new RegExp(`${property}: 14px;`));
    assert.match(icon, /line-height: 1;/);
    assert.doesNotMatch(icon, /circle-info/);
    const navigation = read('public/css/ui/navigation.css');
    assert.match(navigation, /\.bp-sidebar > \.bp-sidebar-brand-links \{ display: none; \}/);
    assert.match(navigation, /\.taxonomy-open \.bp-sidebar > \.bp-sidebar-brand-links \{ display: flex; \}/);
    assert.doesNotMatch(navigation, /left: 184px|top: 19px/);
    for (const path of ['private/home.html', 'private/contribute.html']) {
        assert.match(read(path), /\/css\/global.css\?v=help-popovers-20261008/);
    }
});

test('the sidebar guide keeps its compact brand group while Beta feedback lives on Home', () => {
    const html = read('private/home.html');
    const group = html.match(/<nav class="bp-sidebar-brand-links"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
    assert.ok(group);
    assert.match(html, /class="bp-brand"[\s\S]*class="bp-sidebar-brand-links"[\s\S]*id="taxonomy-toggle"/);
    assert.match(group, /id="how-it-works-link"/);
    assert.match(group, /href="\/how-it-works"[^>]*><span>How it works<\/span><i class="fa-regular fa-circle-question"/);
    assert.equal([...html.matchAll(/id="how-it-works-link"/g)].length, 1);
    assert.equal([...html.matchAll(/id="beta-feedback-link"/g)].length, 0);
    assert.equal([...group.matchAll(/class="bp-sidebar-brand-link[^\"]*bp-quiet-action"/g)].length, 1);
    const home = read('private/index.html');
    assert.match(home, /<section id="home-hero"[\s\S]*?id="beta-feedback-link"[^>]*href="\/contribute\/feedback"/);
    assert.equal([...home.matchAll(/id="beta-feedback-link"/g)].length, 1);
    assert.doesNotMatch(html, /class="bp-sidebar-actions"/);
    assert.doesNotMatch(group, /data-help-text/);
    assert.doesNotMatch(read('public/css/ui/showcase.css'), /\.bp-sidebar > \.bp-beta-link/);
});

test('weight adjustment uses a wheel cursor rather than a hand or drag cursor', () => {
    const rule = read('public/css/ui/workspace.css').match(/\.bp-weight-wheel-target \{([^}]+)\}/)[1];
    assert.match(rule, /weight-scroll\.svg'\) 16 16, ns-resize !important/);
    assert.doesNotMatch(rule, /grab|pointer/);
    const image = read('public/assets/cursors/weight-scroll.svg');
    assert.match(image, /width="32" height="32"/);
    assert.match(image, /stroke="#fff"/);
});

test('the adjustment prompt is a compact neutral floating status, not an orange-framed callout', () => {
    const style = read('public/css/ui/workspace.css');
    const rule = style.match(/\.bp-pie-adjustment-status \{([^}]+)\}/)[1];
    assert.match(rule, /position: fixed/);
    assert.match(rule, /width: min\(400px, calc\(100vw - 24px\)\)/);
    assert.match(rule, /background: #282d35/);
    assert.doesNotMatch(rule, /border:[^;]*var\(--bp-purple\)|translateX/);
    assert.doesNotMatch(rule, /pointer-events: none/);
    assert.match(read('private/home.html'), /id="pie-adjustment-label"/);
});

test('right-click exits adjustment immediately while preserving pending wheel input and native editing menus', () => {
    const source = read('public/js/home-workspace.js');
    const stop = source.slice(source.indexOf('function stopWeightAdjustment()'), source.indexOf("pieAdjustmentDismiss.addEventListener('click'"));
    const listener = source.slice(source.indexOf("document.addEventListener('contextmenu'"), source.indexOf("document.addEventListener('wheel'"));
    assert.match(listener, /isWeightAdjustmentMode\(\)/);
    assert.match(listener, /event\.pointerType === 'touch'/);
    assert.match(listener, /input, textarea, select/);
    assert.match(listener, /event\.preventDefault\(\)/);
    assert.match(listener, /stopWeightAdjustment\(\)/);
    assert.match(stop, /void commitPendingWheelAdjustment\(\)/);
    assert.match(stop, /setWorkspaceView\('leaderboard'\)/);
    assert.match(stop, /flushTouchPiePreview\(gesture\)/);
    assert.doesNotMatch(listener + stop, /await|restorePersonalPieSnapshot/);
    assert.match(source, /if \(!isWeightAdjustmentMode\(\) \|\| event.ctrlKey/);
});

test('the adjustment prompt is a native exit button with desktop and touch-specific instructions', () => {
    const source = read('public/js/home-workspace.js');
    assert.match(read('private/home.html'), /<button id="pie-adjustment-dismiss"[^>]+type="button"[^>]+aria-label="Stop adjusting weight"/);
    assert.match(source, /pieAdjustmentDismiss\.addEventListener\('click', stopWeightAdjustment\)/);
    assert.match(source, /pieAdjustmentDismiss\.disabled = single/);
    assert.match(source, /\(pointer: coarse\)/);
    assert.match(source, /Swipe on the pie to adjust\. Tap this prompt to stop adjusting\./);
    assert.match(source, /Right-click or click this prompt to stop adjusting\./);
    assert.match(source, /\.focus\(\{ preventScroll: true \}\)/);
    assert.match(read('public/css/ui/workspace.css'), /\.bp-pie-adjustment-dismiss:focus-visible \{ outline: 2px solid #fff; outline-offset: -4px;/);
});
