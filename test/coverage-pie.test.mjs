import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { rankingNumber } from '../public/js/shared/ranking-number.js';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const source = read('public/js/workspace/model-list.js');
const createCoveragePie = vm.runInNewContext(source.slice(source.indexOf('export function createCoveragePie('),
    source.indexOf('export function createModelListView(')).replace('export ', '') + '\ncreateCoveragePie', {
    rankingNumber,
    document: { createElement: tag => ({ tag, textContent: '', attributes: new Map(), dataset: {},
        style: { values: new Map(), setProperty(name, value) { this.values.set(name, value); } },
        setAttribute(name, value) { this.attributes.set(name, value); } }) }
});

test('coverage pies use exact weighted proportions at the endpoints and between them', () => {
    for (const percent of [0, .01, 25, 33.3333, 50, 99.99, 100]) {
        const pie = createCoveragePie(percent);
        assert.equal(pie.tag, 'span');
        assert.equal(pie.className, 'bp-model-coverage');
        assert.equal(pie.style.values.get('--coverage-share'), `${percent}%`);
        assert.equal(pie.textContent, '');
        assert.equal(pie.attributes.get('role'), 'img');
        assert.equal(pie.attributes.get('aria-label'), pie.dataset.tooltip);
        assert.match(pie.dataset.tooltip, /Recorded scores cover .+ of this ranking's weight\./);
    }
});

test('tiny and near-complete pies do not describe partial coverage as empty or complete', () => {
    assert.match(createCoveragePie(.01).dataset.tooltip, /<1%/);
    assert.match(createCoveragePie(99.99).dataset.tooltip, />99%/);
    assert.match(createCoveragePie(0).dataset.tooltip, / 0%/);
    assert.match(createCoveragePie(100).dataset.tooltip, / 100%/);
});

test('invalid or out-of-range values cannot create invalid pie styles', () => {
    for (const [value, expected] of [[-10, 0], [150, 100], [NaN, 0], [Infinity, 0], [null, 0], [undefined, 0]]) {
        const pie = createCoveragePie(value);
        assert.equal(pie.style.values.get('--coverage-share'), `${expected}%`);
        assert.doesNotMatch(pie.dataset.tooltip, /NaN|Infinity|undefined|null/);
    }
});

test('only comparable Estimated-score rows receive the pie and no visible coverage text', () => {
    assert.match(source, /if \(comparable && state\.scoreMode === 'available'\) \{\s*const coverage = createCoveragePie\(model\.coverage\)/);
    assert.match(source, /row\.setAttribute\('aria-label', `\$\{row\.getAttribute\('aria-label'\)\}\. \$\{coverage\.dataset\.tooltip\}`\)/);
    assert.doesNotMatch(source, /% covered|coverage\.textContent/);
    const rule = read('public/css/ui/workspace.css').match(/\.bp-model-coverage \{([^}]+)\}/)?.[1];
    assert.ok(rule);
    assert.match(rule, /flex: 0 0 16px; width: 16px; height: 16px/);
    assert.match(rule, /border-radius: 50%; background: conic-gradient/);
    assert.doesNotMatch(rule, /border:|box-shadow|mask/);
});

test('coverage stays beside the identity outside the scrollable parameters and score column', () => {
    assert.match(source, /identity\.className = 'bp-model-name-wrap'/);
    const appendName = source.indexOf('identity.append(name)');
    const appendCoverage = source.indexOf('identity.append(coverage)');
    assert.ok(appendName >= 0 && appendCoverage > appendName, 'Coverage must follow the name inside the identity container');
    assert.doesNotMatch(source, /(?:modelName|name|score|row|parameters)\.append\(coverage\)/);
    const css = read('public/css/ui/workspace.css');
    const rule = css.match(/\.bp-model-name-wrap\s*\{([^}]+)\}/)?.[1];
    assert.match(rule, /display: flex/);
    assert.match(rule, /align-items: center/);
    assert.match(rule, /min-width: 0/);
    assert.doesNotMatch(css, /\.bp-model-name-wrap > \.bp-model-coverage\s*\{[^}]*margin-inline-start: auto/);
    assert.match(read('public/css/model-comparison.css'), /\.bp-model-name\.bp-comparison-entry-label\s*\{[^}]*flex: 0 1 auto/);
});
