import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { rankingNumber } from '../public/js/shared/ranking-number.js';

test('ranking numbers round to whole values, including half values, zero and negative scores', () => {
    for (const [value, expected] of [[6.94, '7'], [86.49, '86'], [86.5, '87'], [99.99, '100'],
        [.01, '0'], [.5, '1'], [0, '0'], [-0, '0'], [-.01, '0'], [-.5, '-1'], [-86.5, '-87'], [120.7, '121']]) {
        assert.equal(rankingNumber(value), expected, String(value));
    }
});

test('ranking views share display rounding without rounding score or weight geometry', async () => {
    for (const module of ['model-list', 'model-bar-chart', 'chart-workspace']) {
        const code = await readFile(new URL(`../public/js/workspace/${module}.js`, import.meta.url), 'utf8');
        assert.match(code, /import \{ rankingNumber \} from '\.\.\/shared\/ranking-number\.js'/);
        assert.doesNotMatch(code, /toFixed\(/);
    }
    const list = await readFile(new URL('../public/js/workspace/model-list.js', import.meta.url), 'utf8');
    assert.match(list, /position\(model\.lower\)/);
    assert.match(list, /position\(model\.upper\)/);
    const weights = await readFile(new URL('../public/js/workspace/chart-workspace.js', import.meta.url), 'utf8');
    assert.match(weights, /Number\(entry\.weightBasisPoints\) \/ maximum \* 100/);
    const details = await readFile(new URL('../public/js/workspace/model-scores.js', import.meta.url), 'utf8');
    assert.match(details, /Index score \$\{rankingNumber\(model\.lower\)\}/);
    assert.match(details, /Score range \$\{rankingNumber\(model\.lower\)\} to \$\{rankingNumber\(model\.upper\)\}/);
    assert.match(details, /numericValue\.toFixed\(7\)/, 'Original score evidence keeps its precision');
});

test('short endpoint labels move outside by default for both weight and score tracks', async () => {
    const code = await readFile(new URL('../public/js/shared/bar-label.js', import.meta.url), 'utf8');
    const css = await readFile(new URL('../public/css/ui/workspace.css', import.meta.url), 'utf8');
    assert.match(code, /overflow = 'outside'/);
    assert.match(css, /body \.bp-bar-endpoint-label\[data-bar-label-overflow="true"\]\[data-bar-label-fallback="outside"\]\s*\{[^}]*opacity: 1;[^}]*translate\(0, -50%\)[^}]*color: #111/);
});

test('both score modes use the same thick track and inline endpoint labels', async () => {
    const code = await readFile(new URL('../public/js/workspace/model-list.js', import.meta.url), 'utf8');
    const css = await readFile(new URL('../public/css/ui/workspace.css', import.meta.url), 'utf8');
    assert.match(code, /if \(comparable\) mountBarEndpointLabel\(track, score/);
    assert.match(code, /row\.classList\.toggle\('has-inline-score', comparable\)/);
    assert.doesNotMatch(code, /if \(relative\) mountBarEndpointLabel/);
    assert.match(css, /\.bp-score-track\s*\{[^}]*height: 26px;[^}]*background: transparent;[^}]*overflow: visible;[^}]*border-radius: 3px;/);
    assert.match(css, /\.bp-score-negative-range > \.bp-model-score \{ top: 75%; \}/);
});
