import test from 'node:test';
import assert from 'node:assert/strict';
import { createPieLabelLayout } from '../public/js/workspace/pie-label-layout.js';

const measure = (text, size) => ({ width: text.length * size * .55 });
const render = options => createPieLabelLayout(measure).layout({ name: 'MMLU', version: '', percent: '25%',
    width: 140, height: 120, fontFamily: 'sans-serif', ...options });

test('rectangular labels show a name and weight with fixed, readable sizes', () => {
    const label = render();
    assert.equal(label.mode, 'full');
    assert.deepEqual(label.rows.map(row => [row.text, row.size]), [['MMLU', 13], ['25%', 18]]);
});
test('names and versions wrap only at word boundaries without dropping words', () => {
    const label = render({ name: 'Code generation', version: 'full offline binary accuracy', width: 130, height: 150 });
    assert.equal(label.mode, 'full');
    assert.equal(label.rows.filter(row => row.kind === 'name').map(row => row.text).join(' '), 'Code generation');
    assert.equal(label.rows.filter(row => row.kind === 'version').map(row => row.text).join(' '), 'full offline binary accuracy');
});
test('long names retain the full name for fade clipping, never a percentage-only label', () => {
    const name = 'An extremely long benchmark name without enough space';
    const label = render({ name, width: 80, height: 120 });
    assert.equal(label.mode, 'truncated');
    assert.deepEqual(label.rows.map(row => row.kind), ['name']);
    assert.equal(label.rows[0].text, name);
    assert.equal(label.rows[0].clipped, true);
    assert.equal(label.rows[0].size, 13);
});
test('small heights and narrow percentage widths prefer the benchmark name', () => {
    for (const input of [{ height: 35 }, { name: 'M', width: 40, percent: '100%' }]) {
        assert.deepEqual(render(input).rows.map(row => row.kind), ['name']);
    }
});
test('unrenderable blocks omit text, rather than reduce the font size', () => {
    for (const input of [{ width: 18 }, { height: 28 }]) assert.deepEqual(render(input).rows, []);
});
test('oversized versions do not hide the benchmark name or percentage', () => {
    assert.equal(render({ version: 'An impossibly long version description that cannot wrap onto two lines' }).mode, 'name');
    assert.deepEqual(render({ height: 70, version: 'Version one two three' }).rows.map(row => row.kind), ['name', 'percent']);
});
test('weight treemap labels never include fallback branch icons', () => {
    assert.equal(render().fallbackIcon, undefined);
    assert.equal(render({ height: 60 }).fallbackIcon, undefined);
});
test('non-clipped label widths and baselines stay within each rectangle', () => {
    for (const width of [0, 20, 36, 60, 100, 180, 320]) for (const height of [0, 20, 32, 60, 100, 300]) {
        const label = render({ width, height });
        for (const row of label.rows) {
            assert.ok(row.y >= 7 && row.y <= height - 7);
            if (!row.clipped) assert.ok(measure(row.text, row.size).width <= width - 16);
        }
    }
});
