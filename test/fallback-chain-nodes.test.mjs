import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('every active fallback renderer uses the same unnumbered ordered chain', async () => {
    const views = ['family-view', 'fallback-picker', 'model-scores'];
    for (const view of views) {
        const content = await source(`public/js/workspace/${view}.js`);
        assert.match(content, /bp-fallback-chain/);
        assert.match(content, /bp-fallback-chain-step/);
        assert.match(content, /setAttribute\('role', 'list'\)/);
        assert.doesNotMatch(content, /bp-family-order|bp-fallback-picker-step-number|bp-version-priority-number/);
    }
    const scores = await source('public/js/workspace/model-scores.js');
    const path = scores.slice(scores.indexOf('path.slice(1).forEach('), scores.indexOf("toggle.addEventListener('click'"));
    assert.doesNotMatch(path, /String\(index \+ 2\)|item\.append\(order/);
    assert.match(path, /item\.append\(label, status\)/);
    assert.match(path, /'Used' : 'No score'/);
});

test('fallback chains have only explicit identities and retain edit controls', async () => {
    const family = await source('public/js/workspace/family-view.js');
    const picker = await source('public/js/workspace/fallback-picker.js');
    assert.doesNotMatch(family + picker, /createAutomaticVersionButton|isOtherVersions|onInspectGroup/);
    assert.match(family, /row\.append\(handle, identity, actions\)/);
    assert.match(family, /appendBenchmarkIdentity\(identity, entry\)/);
});

test('the chain uses neutral continuous lines and hollow nodes without per-step frames', async () => {
    const fallback = await source('public/css/ui/fallback.css');
    assert.match(fallback, /\.bp-fallback-chain > \.bp-fallback-chain-step::before,[\s\S]*?width: 1px;[\s\S]*?background: #c7cbd1;/);
    assert.match(fallback, /\.bp-fallback-chain > \.bp-fallback-chain-step::after \{[\s\S]*?width: 8px;[\s\S]*?border: 1px solid #929aa3;/);
    assert.match(fallback, /:first-child::before \{ top: 50%; \}/);
    assert.match(fallback, /:last-child::before \{ bottom: 50%; \}/);
    for (const path of ['fallback-picker', 'evidence']) {
        const css = await source(`public/css/ui/${path}.css`);
        const row = css.match(path === 'evidence' ? /\.bp-model-fallback-path > li \{[^}]*\}/ : /\.bp-fallback-picker-steps > li \{[^}]*\}/)?.[0];
        assert.ok(row);
        assert.doesNotMatch(row, /border|box-shadow|background/);
        assert.match(row, /24px/);
    }
    const compatibility = await source('public/css/ui/benchmark-chain-layouts.css');
    assert.match(compatibility, /\.bp-fallback-step-number, \.bp-fallback-connector \{ display: none; \}/);
    assert.doesNotMatch(compatibility, /data-chain-layout|font-variant-numeric/);
});
