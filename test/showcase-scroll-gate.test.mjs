import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { columnLayout } from '../public/js/topics-home/layout.js';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('the actual root directory does not mount the retired showcase handoff gate', async () => {
    const html = await read('private/index.html');
    const entry = await read('public/js/topics-home.js');
    const configuration = await read('public/js/home-workspace.js');
    assert.match(html, /id="topics-grid"/);
    assert.match(html, /<script src="\/js\/topics-home\.js" type="module"><\/script>/);
    for (const source of [html, entry, configuration]) {
        assert.doesNotMatch(source, /showcase-(?:view|scroll-gate|weight-scroll)\.js|showcase-trigger|is-showcase-handoff/);
    }
});

test('the root never captures global wheel, touch or vertical scrolling for a story transition', async () => {
    const source = await read('public/js/topics-home.js');
    assert.doesNotMatch(source, /(?:window|document)\.addEventListener\(['"](?:wheel|touchstart|touchmove)['"]/);
    assert.match(source, /window\.addEventListener\('scroll', syncHeader, \{ passive: true \}\)/);
    assert.doesNotMatch(source, /stopImmediatePropagation|recentlyScrolling|scrollGate|showcasePull/);
    assert.match(source, /scroll\.addEventListener\('scroll'/);
});

test('the directory stays in document flow instead of fixing or clipping the page for a handoff', async () => {
    const css = await read('public/css/topics-home.css');
    assert.doesNotMatch(css, /\.th-home\s*\{[^}]*(?:position:\s*fixed|overflow(?:-y)?:\s*(?:hidden|clip))/);
    assert.doesNotMatch(css, /is-showcase|showcase-stage|showcase-handoff/);
    assert.match(css, /\.th-grid\s*\{[^}]*display: grid/);
});

test('complete horizontal columns need no vertical scroll-gate reserve at supported widths', () => {
    for (const width of [240, 292, 330, 720, 960, 1280]) {
        const geometry = columnLayout(width, 25, 37);
        assert.ok(geometry.width <= width);
        assert.equal(geometry.width % geometry.slot, 0);
        assert.ok(geometry.visible >= 1 && geometry.visible <= 25);
        assert.ok(geometry.slot >= 36 && geometry.slot <= 80);
        assert.equal(geometry.visible, Math.min(25, Math.floor(width / 36)));
        assert.ok(geometry.barWidth >= 24 && geometry.barWidth <= 44);
    }
});
