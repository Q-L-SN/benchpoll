import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { columnLayout, fitWeightLabel } from '../public/js/topics-home/layout.js';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('composition-only reveals the treemap rather than reviving an internally scrolling showcase list', async () => {
    const html = await read('private/index.html');
    const css = await read('public/css/topics-home.css');
    const source = await read('public/js/topics-home.js');
    assert.match(html, /id="topics-view-toggle"[^>]*aria-label="Switch to benchmark weights"/);
    assert.doesNotMatch(html, /id="weight-bars"|showcase-scene/);
    assert.doesNotMatch(source, /createShowcaseWeightScroll|showcase-weight-scroll\.js/);
    assert.match(css, /\[data-view="weights"\] \.th-treemap\s*\{[^}]*mask-image: none/);
    assert.match(css, /\[data-view="weights"\] \.th-model-scroll\s*\{ display: none/);
});

test('model browsing uses native horizontal scroll and permits vertical page gestures', async () => {
    const css = await read('public/css/topics-home.css');
    assert.match(css, /\.th-model-scroll\s*\{[^}]*overflow-x: auto;[^}]*overflow-y: hidden/);
    assert.match(css, /\.th-model-scroll\s*\{[^}]*overscroll-behavior-x: contain/);
    assert.match(css, /\.th-model-scroll\s*\{[^}]*scroll-snap-type: x mandatory/);
    assert.match(css, /\.th-model-scroll\s*\{[^}]*touch-action: pan-x pan-y/);
    assert.match(css, /\.th-model\s*\{[^}]*scroll-snap-align: start/);
});

test('small weight rectangles fade a complete name without introducing manual text scrolling', () => {
    const tile = { name: 'A benchmark name too long for this rectangle', conditionName: '2026.10', share: .06 };
    assert.deepEqual(fitWeightLabel({ ...tile, width: 45, height: 30 }).lines,
        [{ text: tile.name, kind: 'name', overflow: true }]);
    assert.deepEqual(fitWeightLabel({ ...tile, width: 15, height: 10 }).lines, []);
});

test('native scroll bounds always end on a whole column after pagination', () => {
    for (const width of [240, 330, 720, 1280]) {
        const geometry = columnLayout(width, 25, 37);
        const initialMaximum = (25 - geometry.visible) * geometry.slot;
        const nextMaximum = (37 - geometry.visible) * geometry.slot;
        assert.equal(initialMaximum % geometry.slot, 0);
        assert.equal(nextMaximum % geometry.slot, 0);
        assert.ok(nextMaximum > initialMaximum);
    }
});
