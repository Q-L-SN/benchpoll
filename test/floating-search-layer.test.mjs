import assert from 'node:assert/strict';
import { test } from 'node:test';
import { floatingSearchPosition } from '../public/js/shared/floating-search-layer.js';

const viewport = { left: 0, top: 0, width: 390, height: 844 };
const anchor = { left: 320, right: 364, top: 80, bottom: 124 };

test('search placement aligns below the trigger with a fixed viewport gutter', () => {
    assert.deepEqual(floatingSearchPosition({ anchor, viewport, height: 280 }),
        { left: 44, top: 128, width: 320, maxHeight: 700, placement: 'below' });
});

test('narrow viewports clamp both alignment directions without horizontal overflow', () => {
    for (const align of ['start', 'end']) {
        const result = floatingSearchPosition({ anchor, viewport: { ...viewport, width: 280 }, height: 280, align });
        assert.equal(result.width, 248);
        assert.equal(result.left, 16);
    }
});

test('a growing result list flips above and remains bounded', () => {
    const result = floatingSearchPosition({ anchor: { ...anchor, top: 700, bottom: 744 }, viewport, height: 360 });
    assert.equal(result.placement, 'above');
    assert.equal(result.top, 336);
    assert.equal(result.maxHeight, 680);
});

test('phone keyboard size and visual viewport offsets constrain the entire panel', () => {
    const viewport = { left: 40, top: 150, width: 320, height: 240 };
    const result = floatingSearchPosition({ anchor: { left: 30, right: 74, top: 80, bottom: 124 }, viewport, height: 350 });
    assert.equal(result.left, 56);
    assert.equal(result.top, 166);
    assert.equal(result.width, 288);
    assert.equal(result.maxHeight, 208);
});

test('an anchor below the visual viewport stays usable above the keyboard', () => {
    const result = floatingSearchPosition({ anchor: { ...anchor, top: 600, bottom: 644 },
        viewport: { ...viewport, height: 280 }, height: 360 });
    assert.equal(result.placement, 'above');
    assert.equal(result.top, 16);
    assert.equal(result.maxHeight, 248);
});

test('equal space prefers the lower side and constrains excessive content', () => {
    const result = floatingSearchPosition({ anchor: { ...anchor, top: 400, bottom: 444 }, viewport, height: 700 });
    assert.equal(result.placement, 'below');
    assert.equal(result.maxHeight, 380);
    assert.equal(result.top, 448);
});

test('positioning never returns negative dimensions even for a collapsed visual viewport', () => {
    for (const size of [0, 10, 31]) {
        const result = floatingSearchPosition({ anchor, viewport: { left: 5, top: 7, width: size, height: size }, height: 300 });
        assert.ok(result.width >= 0);
        assert.ok(result.maxHeight >= 0);
        assert.ok(Number.isFinite(result.left) && Number.isFinite(result.top));
    }
});
