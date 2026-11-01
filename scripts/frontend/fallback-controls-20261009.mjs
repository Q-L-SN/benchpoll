import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';
import { benchmarks, models } from './fixtures.mjs';

const liveURL = process.env.FALLBACK_CONTROLS_URL;
const builtRoot = process.env.HOME_BUILT_ROOT;
const builtHTML = process.env.HOME_BUILT || builtRoot ? await readFile(join(builtRoot ?? '.', 'private/home-built.html'), 'utf8') : null;
const output = resolve(`artifacts/fallback-controls-20261009/browser${liveURL ? '-live' : ''}${builtHTML ? '-built' : ''}${builtRoot ? '-installed' : ''}`);
await mkdir(output, { recursive: true });
const fields = [
    { ID: 1, name: 'Agent harness', type: 'text', revision: 1, allowEmpty: true, excludeMissing: true, excludeEmpty: true, options: [] },
    { ID: 20, name: 'Reasoning effort', type: 'enum', revision: 1, allowEmpty: true, excludeMissing: true, excludeEmpty: true,
        options: [{ ID: 201, label: 'high', excluded: false }, { ID: 202, label: 'low', excluded: false }] }
];
const comparisonModels = [
    [301, { 'field:1': 'A', 'field:20': 201 }], [301, {}],
    [302, { 'field:1': 'B', 'field:20': 202 }], [302, {}],
    [303, null], [304, { 'field:1': 'A', 'field:20': null }]
].map(([modelID, parameters], index) => ({ ...models[modelID - 301], ID: 201 + index,
    modelID, modelName: models[modelID - 301].name, vendor: models[modelID - 301].vendorName,
    condition: { parameters, scoreFields: Object.entries(parameters ?? {}).map(([key, value]) => ({ fieldID: Number(key.slice(6)), value })) },
    results: new Map(benchmarks.map(item => [String(item.conditionID), { normalizedScore: 50 + index * 5 }])) }));
const browser = await chromium.launch({ headless: true });
const results = [];
async function check(name, width, options, run) {
    const app = await startPreview(options);
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(liveURL ? 60000 : 12000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => sessionStorage.setItem('benchpoll-workspace-preferences-v1',
        JSON.stringify({ groupBenchmarkVersions: true })));
    try {
        if (builtHTML) await context.route('**/*', route => route.request().resourceType() === 'document'
            ? route.fulfill({ body: builtHTML, contentType: 'text/html' }) : route.fallback());
        if (builtRoot) await context.route('**/build/home/**', async route => {
            const path = new URL(route.request().url()).pathname;
            await route.fulfill({ body: await readFile(join(builtRoot, 'public', path)),
                contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript' });
        });
        if (liveURL) await context.route('**/api/**', async route => {
            const url = new URL(route.request().url());
            const response = await route.fetch({ url: app.url + url.pathname + url.search });
            await route.fulfill({ response });
        });
        await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded' });
        await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
        const result = await run(page, app);
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await page.screenshot({ path: join(output, name + '.png'), fullPage: true, animations: 'disabled' });
        results.push({ name, width, passed: true, ...result });
        console.log('PASS ' + name);
    } catch (error) {
        await page.screenshot({ path: join(output, name + '-failure.png'), fullPage: true, animations: 'disabled' });
        throw new Error(name + ': ' + error.message, { cause: error });
    } finally { await context.close(); await app.close(); }
}
async function panel(page, name, width) {
    if (width <= 760) await page.locator(`button[data-mobile-panel="${name === 'weights' ? 'mix' : name}"]`).click();
}
const appearance = node => {
    const style = getComputedStyle(node);
    return { color: style.color, background: style.backgroundColor, border: style.borderTopWidth, shadow: style.boxShadow };
};
try {
    for (const width of [1440, 390, 320]) {
        await check('missing-values-' + width, width, { comparisonModels, comparisonFields: fields }, async page => {
            await panel(page, 'models', width);
            await page.waitForFunction(() => document.querySelectorAll('.bp-model-row').length === 4);
            await page.locator('[data-quick-comparison="reasoning"]').click();
            await page.waitForFunction(() => document.querySelectorAll('.bp-model-row').length === 6);
            assert.equal(await page.locator('.bp-model-row').filter({ hasText: 'Not recorded' }).count(), 3);
            assert.equal(await page.locator('.bp-model-row').filter({ hasText: 'Empty' }).count(), 1);
            await page.locator('[data-quick-comparison="harness"]').click();
            await page.waitForFunction(() => document.querySelectorAll('.bp-model-row').length === 6
                && document.querySelectorAll('.bp-model-display-parameter').length === 12);
            const rangeLabels = await page.locator('.bp-model-name').allTextContents();
            await page.locator('[data-score-mode="available"]').click();
            await page.waitForFunction(() => document.querySelector('.bp-scoring-switch').dataset.mode === 'available'
                && !document.querySelector('#model-card').matches('[aria-busy="true"]'));
            assert.deepEqual((await page.locator('.bp-model-name').allTextContents()).sort(), rangeLabels.sort());
            await page.locator('[data-quick-comparison="reasoning"]').click();
            await page.waitForFunction(() => document.querySelectorAll('.bp-model-display-parameter').length === 6);
            await page.locator('[data-quick-comparison="harness"]').click();
            await page.waitForFunction(() => document.querySelectorAll('.bp-model-row').length === 4);
            return { retainedRuns: comparisonModels.length };
        });
        await check('fallback-and-flat-list-' + width, width, { secondaryBenchmark: true, sparseBenchmark: true }, async (page, app) => {
            await panel(page, 'weights', width);
            assert.equal(await page.locator('#benchmark-version-grouping').count(), 0);
            assert.equal(await page.locator('.bp-benchmark-row[data-condition-id="900"]').count(), 1);
            assert.equal(await page.locator('.bp-benchmark-row[data-condition-id="901"]').count(), 1);
            assert.equal(await page.locator('.bp-benchmark-low-toggle').count(), 0);
            await page.locator('#benchmark-search').fill('General');
            await page.waitForFunction(() => document.querySelectorAll('.bp-benchmark-low-toggle').length > 0);
            await page.locator('#benchmark-search').fill('');
            await page.waitForFunction(() => document.querySelectorAll('.bp-benchmark-row').length === 10);
            assert.equal(await page.locator('.bp-benchmark-low-toggle').count(), 0);
            assert.ok(app.state.requests.filter(request => request.path === '/api/get_weighted_workspace')
                .every(request => !Object.hasOwn(request.body, 'groupVersions')));
            await page.locator('#pie-mode-personal').click();
            const pin = page.locator('#benchmark-personal-pin');
            await page.mouse.move(0, 0);
            const before = await pin.evaluate(appearance);
            await pin.hover();
            const hovered = await pin.evaluate(appearance);
            assert.equal(before.border, '0px'); assert.equal(hovered.border, '0px');
            assert.equal(before.background, 'rgba(0, 0, 0, 0)'); assert.equal(hovered.background, before.background);
            assert.notEqual(hovered.color, before.color);
            await pin.click(); assert.equal(await pin.getAttribute('aria-pressed'), 'true');
            await pin.click();
            await page.locator('#weight-pie g[data-object-id="1"]').click();
            await page.locator('#inline-fallback-toggle').click();
            const chart = page.locator('#inline-fallback-chart');
            await chart.waitFor();
            const idle = await chart.evaluate(node => ({ glow: getComputedStyle(node, '::after').borderTopColor,
                radius: getComputedStyle(node).borderTopLeftRadius }));
            assert.equal(idle.glow, 'rgb(22, 101, 117)'); assert.equal(idle.radius, '6px');
            await page.locator('#inline-fallback-add-benchmark').click();
            const active = await chart.evaluate(node => {
                const actions = node.nextElementSibling;
                return { borderColor: getComputedStyle(node).borderTopColor,
                    frameBorder: getComputedStyle(node.parentElement).borderTopWidth,
                    actionBorder: getComputedStyle(actions).borderLeftColor,
                    chartBottom: node.getBoundingClientRect().bottom, actionsTop: actions.getBoundingClientRect().top };
            });
            assert.equal(active.borderColor, 'rgb(22, 101, 117)'); assert.equal(active.frameBorder, '0px');
            assert.notEqual(active.actionBorder, active.borderColor);
            assert.ok(Math.abs(active.chartBottom - active.actionsTop) <= 1);
            await page.locator('.bp-inline-fallback-frame').screenshot({ path: join(output, 'fallback-border-' + width + '.png') });
            await page.getByRole('button', { name: 'Add Advanced reasoning to Fallback', exact: true }).click();
            await page.waitForFunction(() => document.querySelectorAll('#inline-fallback-chart .bp-family-member').length === 1);
            assert.equal(await chart.evaluate(node => node.classList.contains('bp-weight-setup-glow')), false);
            return { pin: { before, hovered }, fallback: active };
        });
        await check('empty-personal-' + width, width, { personalEntries: [] }, async page => {
            await panel(page, 'weights', width);
            await page.locator('#personal-pie-create').click();
            const empty = page.locator('#personal-pie-empty');
            if (width > 760) {
                await empty.waitFor();
                const design = { ...await empty.evaluate(appearance), ...await empty.evaluate(node => ({ radius: getComputedStyle(node).borderRadius,
                    height: node.getBoundingClientRect().height, glow: getComputedStyle(node, '::after').content })) };
                assert.equal(design.border, '0px'); assert.equal(design.radius, '0px'); assert.equal(design.glow, 'none');
                assert.ok(design.height < 230);
                const find = page.locator('#personal-pie-find-benchmarks');
                assert.equal((await find.evaluate(appearance)).border, '0px');
                await find.focus(); await page.keyboard.press('Enter');
                await page.waitForFunction(() => document.activeElement.id === 'benchmark-search');
            } else {
                await page.locator('#pie-empty-compact').waitFor();
                assert.equal(await empty.isVisible(), false);
                assert.ok((await page.locator('#pie-empty-compact').boundingBox()).height < 70);
            }
            await page.screenshot({ path: join(output, 'empty-before-add-' + width + '.png'), fullPage: true });
            await page.getByRole('button', { name: 'Add General knowledge to Personal Weights', exact: true }).click();
            await page.locator('#weight-pie g[data-object-id="1"]').waitFor();
            assert.equal(await empty.isVisible(), false);
            return { addedFirstBenchmark: true };
        });
    }
    await check('weight-adjustment-cursor', 1440, {}, async (page, app) => {
        await page.locator('#pie-mode-personal').click();
        await page.locator('#pie-mode-personal[aria-selected="true"][aria-busy="false"]').waitFor();
        await page.locator('#weight-pie g[data-object-id="1"]').click();
        const row = page.locator('.bp-benchmark-row[data-condition-id="2"]');
        const box = await row.boundingBox();
        await page.mouse.move(box.x + 4, box.y + box.height / 2);
        assert.match(await page.locator('.bp-weight-wheel-target').evaluate(node => getComputedStyle(node).cursor), /weight-scroll\.svg.*16 16, ns-resize$/);
        assert.equal((await page.request.get(new URL('/assets/cursors/weight-scroll.svg', page.url()).href)).status(), 200);
        const original = app.state.personalEntries[0].weightBasisPoints;
        await page.mouse.wheel(0, -100);
        await page.waitForFunction(() => document.querySelector('#pie-adjustment-value').textContent === '37%');
        await page.locator('#benchmark-search').hover();
        assert.equal(await page.locator('.bp-weight-wheel-target').count(), 0);
        await page.mouse.wheel(0, -100);
        assert.equal(await page.locator('#pie-adjustment-value').textContent(), '37%');
        await page.locator('.bp-model-row').first().hover();
        assert.equal(await page.locator('.bp-weight-wheel-target').count(), 0);
        await row.getByRole('button').first().hover();
        assert.equal(await page.locator('.bp-weight-wheel-target').count(), 0);
        await page.locator('#inline-fallback-toggle').click();
        await page.locator('#inline-fallback-chart').hover();
        assert.equal(await page.locator('.bp-weight-wheel-target').count(), 0);
        await page.locator('#inline-fallback-toggle').click();
        await page.locator('.bp-benchmark-row[data-condition-id="1"]').click({ position: { x: 4, y: 20 } });
        await page.waitForFunction(() => document.querySelector('.bp-left-workspace').dataset.workspaceView !== 'focus');
        await page.mouse.move(box.x + 4, box.y + box.height / 2);
        assert.equal(await page.locator('.bp-weight-wheel-target').count(), 0);
        await page.mouse.wheel(0, -100);
        assert.equal(await page.locator('#pie-adjustment-value').textContent(), '37%');
        assert.equal(original, 3500);
        return { searchAndActionsExcluded: true, clearedOnExit: true };
    });
} finally {
    await browser.close();
    await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
}
