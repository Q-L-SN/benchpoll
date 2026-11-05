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
