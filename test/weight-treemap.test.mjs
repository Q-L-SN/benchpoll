import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeightTreemapLayout, treemapHoverTransform } from '../public/js/workspace/weight-treemap-layout.js';

const entries = weights => weights.map((weight, index) => ({ conditionID: index + 1, weightBasisPoints: weight, name: `Benchmark ${index}` }));
function check(tiles, width, height) {
    const area = tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0);
    for (const tile of tiles) {
        assert.ok(tile.width >= 0 && tile.height >= 0);
        assert.ok(tile.x >= 0 && tile.y >= 0 && tile.x + tile.width <= width && tile.y + tile.height <= height);
        assert.ok(Math.abs(tile.width * tile.height / area - tile.share) < 1e-9);
        const hover = treemapHoverTransform(tile, width, height);
        const left = tile.x + hover.x - tile.width * (hover.scale - 1) / 2;
        const top = tile.y + hover.y - tile.height * (hover.scale - 1) / 2;
        assert.ok(left >= 0 && top >= 0 && left + tile.width * hover.scale <= width && top + tile.height * hover.scale <= height);
    }
    for (let i = 0; i < tiles.length; i++) for (let j = i + 1; j < tiles.length; j++) {
        const a = tiles[i], b = tiles[j];
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        assert.ok(overlapX < 1e-9 || overlapY < 1e-9, 'tiles overlap');
    }
}
test('treemap keeps all positive benchmarks, proportional areas, no overlaps and bounded hover', () => {
    for (const [width, height] of [[300, 225], [560, 420], [240, 180], [1000, 250]]) {
        for (const weights of [[10000], [6000, 2500, 1500], Array(100).fill(100), [9997, 1, 1, 1]]) {
            const tiles = createWeightTreemapLayout()(entries(weights), width, height);
            assert.equal(tiles.length, weights.length);
            check(tiles, width, height);
        }
    }
});
test('invalid and zero weights cannot corrupt geometry', () => {
    const layout = createWeightTreemapLayout();
    assert.deepEqual(layout([], 360, 270), []);
    assert.deepEqual(layout(entries([0, -1, NaN, Infinity]), 360, 270), []);
    assert.equal(layout(entries([1, 0, -1, NaN]), 360, 270).length, 1);
    for (const size of [0, -1, NaN, Infinity]) assert.deepEqual(layout(entries([1]), size, 270), []);
    assert.throws(() => layout([...entries([1]), ...entries([1])], 360, 270), /Duplicate/);
});
test('the workspace can remove the extra top inset while keeping proportional tile areas', () => {
    for (const width of [240, 390, 560]) {
        const tiles = createWeightTreemapLayout({ paddingTop: 2 })(entries([6000, 2500, 1500]), width, width);
        check(tiles, width, width);
        assert.equal(Math.min(...tiles.map(tile => tile.y)), 2);
        assert.equal(Math.min(...tiles.map(tile => tile.x)), 14);
        assert.ok(Math.abs(Math.max(...tiles.map(tile => tile.y + tile.height)) - (width - 14)) < 1e-9);
    }
});
test('configuration tiles favor wide, shallow shapes in a square canvas', () => {
    for (const width of [280, 360, 560]) {
        for (const weights of [Array(12).fill(1), [30, 20, 15, 12, 8, 6, 5, 4], [60, 25, 15]]) {
            const tiles = createWeightTreemapLayout()(entries(weights), width, width);
            check(tiles, width, width);
            const wide = tiles.filter(tile => tile.width > tile.height * 1.2);
            assert.ok(wide.length >= Math.ceil(tiles.length * 2 / 3), JSON.stringify(tiles));
            assert.ok(wide.reduce((sum, tile) => sum + tile.share, 0) >= .7);
        }
    }
});
test('successive weight edits preserve topology until membership or topic changes', () => {
    const layout = createWeightTreemapLayout();
    const original = layout(entries([5000, 3000, 2000]), 360, 270, 'first');
    const edited = layout(entries([1000, 4000, 5000]), 360, 270, 'first');
    assert.deepEqual(edited.map(tile => tile.conditionID), original.map(tile => tile.conditionID));
    check(edited, 360, 270);
    const other = layout(entries([1000, 4000, 5000]), 360, 270, 'second');
    assert.equal(other[0].conditionID, 3);
    assert.equal(layout(entries([1000, 2000]), 360, 270, 'second').length, 2);
    assert.deepEqual(layout([], 360, 270, 'second'), []);
});
test('resizing recomputes pixel geometry without changing identity or shares', () => {
    const layout = createWeightTreemapLayout();
    const a = layout(entries([6000, 3000, 1000]), 360, 270);
    const b = layout(entries([6000, 3000, 1000]), 600, 450);
    assert.deepEqual(a.map(tile => tile.share), b.map(tile => tile.share));
    assert.deepEqual(a.map(tile => tile.conditionID), b.map(tile => tile.conditionID));
    check(b, 600, 450);
});
