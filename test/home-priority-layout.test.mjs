import assert from 'node:assert/strict';
import test from 'node:test';
import { weightEntries, weightLayout, weightChainLength, WEIGHT_LAYOUT_POLICY } from '../public/js/topics-home/layout.js';

function admissible(w, h, area) {
    return w + 1e-7 >= Math.min(56, Math.sqrt(area) * .8)
        && h + 1e-7 >= Math.min(24, Math.sqrt(area) * .5)
        && Math.max(w / h, h / w) <= 12 + 1e-7;
}

// Deliberately enumerate all compositions for small inputs, independent of the DP.
function exhaustiveChain(weights, width, height) {
    const { entries, total } = weightEntries(weights);
    let optimum = -1;
    for (let head = 0; head <= entries.length; head++) {
        if (!entries.slice(0, head).every(entry => admissible(width * entry.share, height, width * height * entry.share))) continue;
        const tail = entries.slice(head), tailWeight = tail.reduce((sum, entry) => sum + entry.weightBasisPoints, 0);
        const tailWidth = width * tailWeight / total;
        function visit(index, y, chain, broken) {
            if (index === tail.length) { optimum = Math.max(optimum, chain); return; }
            let weight = 0;
            for (let end = index + 1; end <= tail.length; end++) {
                weight += tail[end - 1].weightBasisPoints;
                const rowHeight = height * weight / tailWeight;
                if (!tail.slice(index, end).every(entry => admissible(tailWidth * entry.weightBasisPoints / weight,
                    rowHeight, width * height * entry.share))) continue;
                const below = broken || y > height * .4 + 1e-7;
                visit(end, y + rowHeight, chain + (below ? 0 : end - index), below);
            }
        }
        if (tail.length) visit(0, 0, head, false);
        else optimum = Math.max(optimum, head);
    }
    return optimum;
}

test('the exposure boundary is 60% from the bottom and stops on the first missing rank', () => {
    assert.equal(WEIGHT_LAYOUT_POLICY.ceiling, .4);
    assert.equal(weightChainLength([{ y: 0 }, { y: 40 }, { y: 41 }, { y: 0 }], 100), 2);
});

test('priority DP reaches the exhaustive optimum for varied small distributions and viewports', () => {
    let seed = 143;
    for (let run = 0; run < 48; run++) {
        const count = 2 + run % 7;
        const weights = Array.from({ length: count }, (_, ID) => {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            return { conditionID: ID + 1, name: `Benchmark ${ID}`, weightBasisPoints: 1 + seed % 60 };
        });
        const width = [240, 330, 760, 1320][run % 4], height = [142, 220, 300][run % 3];
        const optimum = exhaustiveChain(weights, width, height);
        const tiles = weightLayout(weights, width, height);
        if (optimum >= 0) assert.equal(weightChainLength(tiles, height), optimum, `run ${run}`);
        assert.deepEqual(tiles, weightLayout([...weights].reverse(), width, height));
        for (const tile of tiles) assert.ok(Math.abs(tile.width * tile.height / (width * height) - tile.share) < 1e-9);
    }
});

test('dominant, tied, tiny, empty and degenerate inputs retain finite area-correct rectangles', () => {
    for (const values of [[9000, 500, 300, 200], [2500, 2500, 2500, 2500], [9900, 50, 50], [10000]]) {
        const weights = values.map((weightBasisPoints, conditionID) => ({ conditionID, name: `B${conditionID}`, weightBasisPoints }));
        for (const [width, height] of [[1, 100], [300, 1], [320, 220], [1320, 220]]) {
            const tiles = weightLayout(weights, width, height);
            assert.ok(Math.abs(tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0) - width * height) < 1e-7);
            for (const tile of tiles) assert.ok([tile.x, tile.y, tile.width, tile.height].every(Number.isFinite));
        }
    }
    assert.deepEqual(weightLayout([], 320, 220), []);
    assert.deepEqual(weightLayout([{ weightBasisPoints: 1 }], Infinity, 220), []);
});
