import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { weightLayout, fitWeightLabel, mergePreview } from '../public/js/topics-home/layout.js';

const weights = [4200, 3100, 2000, 400, 200, 50, 50].map((weightBasisPoints, index) => ({
    conditionID: index + 1, name: `Benchmark ${index + 1}`, conditionName: '2026', weightBasisPoints
}));

test('root composition uses the actual proportional treemap without the retired Public SVG/list portal', async () => {
    const html = await readFile(new URL('../private/index.html', import.meta.url), 'utf8');
    const css = await readFile(new URL('../public/css/topics-home.css', import.meta.url), 'utf8');
    assert.match(html, /id="topics-view-toggle"[^>]*aria-label="Switch to benchmark weights"/);
    assert.doesNotMatch(html, /public-composition-pie|public-composition-list|showcase-scene/);
    assert.match(css, /\[data-view="weights"\] \.th-treemap\s*\{[^}]*bottom: 0;[^}]*mask-image: none/);
    assert.match(css, /\[data-view="weights"\] \.th-model-scroll\s*\{ display: none/);
});

test('full composition preserves exact weights, sorts large tiles high and does not mutate metadata', () => {
    const before = structuredClone(weights);
    for (const [width, height] of [[260, 222], [330, 262], [1280, 258]]) {
        const tiles = weightLayout(weights, width, height);
        assert.equal(tiles[0].name, 'Benchmark 1');
        assert.equal(tiles[0].y, 0);
        assert.equal(tiles.reduce((sum, tile) => sum + tile.weightBasisPoints, 0), 10000);
        for (let index = 0; index < tiles.length; index++) {
            const tile = tiles[index];
            assert.ok(Math.abs(tile.width * tile.height / (width * height) - tile.share) < 1e-8);
            if (index) assert.ok(tiles[index - 1].weightBasisPoints >= tile.weightBasisPoints);
            const label = fitWeightLabel(tile);
            assert.ok(label.height <= Math.max(0, tile.height - 10));
        }
        const other = tiles.find(tile => tile.isOther);
        assert.equal(other.name, 'Other');
        assert.equal(other.weightBasisPoints, 100);
        assert.equal(other.members.length, 2);
        if (width > 600) assert.ok(tiles.filter(tile => tile.y === 0).length > 1);
    }
    assert.deepEqual(weights, before);
});

test('snapshot pages preserve composition, comparison and scale when those fields are omitted', () => {
    const preview = { topicID: 54, weights, comparison: { keys: ['model'] }, scoreScale: { min: 0, max: 100 },
        models: [{ modelID: 1 }], pagination: { snapshotID: 'home-only', nextOffset: 1, hasMore: true } };
    const next = mergePreview(preview, { topicID: 54, models: [{ modelID: 2 }],
        pagination: { snapshotID: 'home-only', nextOffset: 2, hasMore: false } }, true);
    for (const key of ['weights', 'comparison', 'scoreScale']) assert.equal(next[key], preview[key]);
    assert.deepEqual(next.models.map(model => model.modelID), [1, 2]);
    assert.equal(preview.models.length, 1);
});

test('composition names use an overflow state rather than disappearing when the rectangle is narrow', () => {
    const large = { name: 'GPQA Diamond', conditionName: '2026', share: .42, width: 200, height: 80 };
    assert.deepEqual(fitWeightLabel(large).lines.map(line => line.text), ['GPQA Diamond', '2026']);
    assert.deepEqual(fitWeightLabel({ ...large, width: 45, height: 30 }).lines,
        [{ text: 'GPQA Diamond', kind: 'name', overflow: true }]);
    assert.deepEqual(fitWeightLabel({ name: 'Other', isOther: true, share: .01, width: 100, height: 28 }).lines,
        [{ text: 'Other', kind: 'name', overflow: false }]);
});
