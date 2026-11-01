import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';

const output = 'D:/Codex-artifacts/website1/weight-treemap-20261031';
const fixture = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/vendor/fontawesome/css/all.min.css"><link rel="stylesheet" href="/css/global.css">
<link rel="stylesheet" href="/css/ui/tokens.css"><link rel="stylesheet" href="/css/ui/workspace.css">
<link rel="stylesheet" href="/css/site-palette.css"></head><body style="margin:0">
<main class="bp-pie-card" style="width:min(100%,560px);margin:30px auto;padding:0"><div class="bp-pie-stage">
<svg id="weight-pie"></svg></div></main></body></html>`;
let chrome, safari;
before(async () => {
    const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*' };
    chrome = await chromium.launch({ headless: true, env });
    safari = await webkit.launch({ headless: true, env });
    await mkdir(output, { recursive: true });
});
after(async () => { await chrome?.close(); await safari?.close(); });

for (const [engine, width] of [['chromium', 1440], ['chromium', 390], ['webkit', 320]]) {
    test(`${engine} ${width}: rectangular geometry, labels, hover, keyboard, animation and cleanup`, async t => {
        const app = await startPreview();
        const page = await (engine === 'webkit' ? safari : chrome).newPage({ viewport: { width, height: 960 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        t.after(async () => { await page.close(); await app.close(); assert.deepEqual(errors, []); });
        await page.route('**/__treemap', route => route.fulfill({ contentType: 'text/html', body: fixture }));
        await page.goto(app.url + '/__treemap');
        await page.evaluate(async () => {
            const { createPieRenderer } = await import('/js/workspace/pie-renderer.js');
            const state = { mode: 'personal', categoryID: 1, selectedObjectID: 1, pieOrderByObjectID: new Map(),
                limits: { totalBasisPoints: 10000 }, visualPieWeights: new Map(), visualPieEntries: new Map(), pieAnimationFrame: null };
            let entries = [];
            const selections = [];
            const renderer = createPieRenderer({ state, pieSvg: document.querySelector('#weight-pie'),
                orderedPieEntries: values => values, currentPieEntries: () => entries,
                selectedObjectIndex: values => values.findIndex(entry => entry.conditionID === state.selectedObjectID),
                renderInlineFallback() {}, fallbackRuleFor: () => ({ entries: [{ conditionID: 99 }] }), publicFallbackRuleFor: () => null,
                onSelect(id) { state.selectedObjectID = id; selections.push(id); renderer.renderPie(); } });
            window.treemapQA = { state, selections, renderer,
                set(weights, name = 'Benchmark', animateWeights = false) {
                    entries = weights.map((weight, i) => ({ conditionID: i + 1, name: i === 0 ? name : `Benchmark ${i + 1}`,
                        conditionName: 'Default', weightBasisPoints: weight, weight: weight / 100 }));
                    renderer.renderPie({ animateWeights });
                } };
            window.treemapQA.set([5000, 3000, 1500, 500]);
        });
        const matrix = await page.evaluate(() => {
            let checked = 0;
            for (const weights of [[10000], [6000, 2500, 1500], [9900, 50, 50], Array(100).fill(100)]) {
                for (const name of ['MMLU', 'Long Benchmark Name Needing More Than Two Lines To Display In Full', 'W'.repeat(100)]) {
                    window.treemapQA.set(weights, name);
                    const groups = [...document.querySelectorAll('#weight-pie > g[data-object-id]')];
                    if (groups.length !== weights.length) throw new Error('Missing rectangles');
                    for (const group of groups) {
                        const rect = group.querySelector('.bp-weight-tile').getBBox();
                        if (group.dataset.labelMode === 'truncated') {
                            const rows = group.querySelectorAll('[data-label-kind]');
                            if (rows.length !== 1 || rows[0].dataset.labelKind !== 'name' || !rows[0].hasAttribute('mask')) throw new Error('Invalid truncated name');
                        }
                        for (const row of group.querySelectorAll('[data-label-kind]')) {
                            const box = row.getBBox();
                            if (Number(row.getAttribute('font-size')) < 11) throw new Error('Text shrunk');
                            if (!row.hasAttribute('mask') && (box.x < rect.x - .1 || box.x + box.width > rect.x + rect.width + .1
                                || box.y < rect.y - .1 || box.y + box.height > rect.y + rect.height + .1)) throw new Error('Label escaped block');
                        }
                        if (!group.dataset.tooltip.includes('%')) throw new Error('Missing full weight tooltip');
                    }
                    checked++;
                }
            }
            window.treemapQA.set([5000, 3000, 1500, 500]);
            return checked;
        });
        assert.equal(matrix, 12);
        const target = page.locator('#weight-pie > g[data-object-id="1"]');
        await target.hover();
        await page.waitForFunction(() => {
            const tile = document.querySelector('[data-object-id="1"] .bp-weight-tile');
            const bounds = tile.getBBox(), viewport = tile.closest('svg').viewBox.baseVal;
            const expected = Math.min(1.08, (viewport.width - 2) / bounds.width, (viewport.height - 2) / bounds.height);
            const scale = new DOMMatrix(getComputedStyle(tile.closest('.bp-weight-tile-lift')).transform).a;
            return scale > 1 && Math.abs(scale - expected) < .001;
        });
        assert.equal(await target.evaluate(group => {
            const outer = group.closest('svg').getBoundingClientRect(), rect = group.querySelector('.bp-weight-tile').getBoundingClientRect();
            return rect.left >= outer.left && rect.right <= outer.right && rect.top >= outer.top && rect.bottom <= outer.bottom;
        }), true);
        await target.click();
        for (const key of ['Enter', 'Space']) { await target.focus(); await page.keyboard.press(key); }
        assert.deepEqual(await page.evaluate(() => window.treemapQA.selections), [1, 1, 1]);
        assert.equal(await target.evaluate(node => document.activeElement === node), true);
        await page.evaluate(() => window.treemapQA.set([6000, 2000, 1000, 1000], 'Benchmark', true));
        await page.waitForFunction(() => window.treemapQA.state.pieAnimationFrame === null);
        assert.equal(await target.getAttribute('data-weight'), '6000');
        await page.screenshot({ path: `${output}/${engine}-${width}-hover.png` });
        await page.mouse.move(0, 0);
        await page.evaluate(() => document.activeElement.blur());
        await page.setViewportSize({ width: width < 500 ? width + 30 : 1200, height: 960 });
        await page.waitForFunction(() => {
            const svg = document.querySelector('#weight-pie');
            return Math.abs(svg.viewBox.baseVal.width - svg.getBoundingClientRect().width) < 1;
        });
        await page.evaluate(() => { window.treemapQA.set([]); });
        assert.equal(await page.locator('#weight-pie > g, #weight-pie mask, #weight-pie clipPath').count(), 0);
        assert.equal(await page.locator('.bp-pie-empty').textContent(), 'Add a benchmark or topic from Evaluation items');
        await page.evaluate(() => window.treemapQA.set([10000]));
        assert.equal(await page.locator('.bp-weight-tile').count(), 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    });

    test(`${engine} ${width}: workspace selection and weight editing still save and reload`, async t => {
        const app = await startPreview({ topicHome: true });
        const page = await (engine === 'webkit' ? safari : chrome).newPage({ viewport: { width, height: 960 },
            hasTouch: width < 760, reducedMotion: 'reduce' });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        t.after(async () => { await page.close(); await app.close(); assert.deepEqual(errors, []); });
        if (process.env.TREEMAP_BUNDLED === '1') {
            await page.route(app.url + '/Intelligence', route => readFile(new URL('../private/home-built.html', import.meta.url), 'utf8')
                .then(body => route.fulfill({ contentType: 'text/html', body })));
        }
        await page.goto(app.url + '/Intelligence');
        await page.locator('#pie-mode-personal').click();
        await page.waitForSelector('#weight-pie[data-chart="treemap"] .bp-weight-tile');
        const dimensions = await page.locator('#weight-pie').evaluate(node => ({
            width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height,
            viewWidth: node.viewBox.baseVal.width, viewHeight: node.viewBox.baseVal.height
        }));
        assert.ok(Math.abs(dimensions.width - dimensions.height) <= 1, JSON.stringify(dimensions));
        assert.ok(Math.abs(dimensions.viewWidth - dimensions.viewHeight) <= 1, JSON.stringify(dimensions));
        const id = Number(await page.locator('#weight-pie > g[data-object-id]').first().getAttribute('data-object-id'));
        const target = page.locator(`#weight-pie > g[data-object-id="${id}"]`);
        const original = app.state.personalEntries.find(entry => entry.conditionID === id).weightBasisPoints;
        await target.click();
        assert.equal(await target.getAttribute('aria-pressed'), 'true');
        const saved = page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie') && response.status() === 200);
        if (width >= 760 || engine === 'webkit') {
            await target.hover();
            await page.mouse.wheel(0, -120);
        } else {
            await target.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'nearest' }));
            await page.waitForFunction(id => {
                const target = document.querySelector(`#weight-pie > g[data-object-id="${id}"]`);
                const rect = target.getBoundingClientRect();
                return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
                    ?.closest('[data-object-id]') === target;
            }, id);
            const box = await target.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
            const client = await page.context().newCDPSession(page);
            await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
            for (let step = 1; step <= 5; step++) {
                await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 7 }] });
            }
            await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await client.detach();
        }
        await saved;
        const changed = app.state.personalEntries.find(entry => entry.conditionID === id).weightBasisPoints;
        assert.notEqual(changed, original);
        assert.equal(app.state.personalEntries.reduce((sum, entry) => sum + entry.weightBasisPoints, 0), 10000);
        await page.reload();
        await page.locator('#pie-mode-personal').click();
        await page.waitForFunction(({ id, changed }) => document.querySelector(`#weight-pie > g[data-object-id="${id}"]`)?.dataset.weight === String(changed), { id, changed });
        await page.screenshot({ path: `${output}/${engine}-${width}-workspace.png`, fullPage: true });
        await page.locator('#pie-mode-public').click();
        await page.waitForFunction(() => document.querySelector('#weight-pie').getAttribute('aria-label').startsWith('Public'));
        assert.match(await page.locator('#weight-pie').getAttribute('aria-label'), /^Public.*treemap/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    });
}
