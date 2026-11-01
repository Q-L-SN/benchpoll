import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { catalog } from '../scripts/frontend/fixtures.mjs';
import { startPreview } from '../scripts/frontend/server.mjs';

let browser, preview;
before(async () => {
    preview = await startPreview();
    browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await preview?.close(); });

async function openPage(t, fallback, path) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(6000);
    const errors = [], submissions = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
    if (fallback) await page.addInitScript(() => {
        Object.defineProperty(HTMLElement.prototype, 'showPopover', { configurable: true, value: undefined });
        Object.defineProperty(HTMLElement.prototype, 'hidePopover', { configurable: true, value: undefined });
    });
    await page.route('**/api/get_contribution_catalog', route => route.fulfill({ json: catalog() }));
    await page.route('**/api/submit_contribution', route => {
        submissions.push(route.request().postDataJSON());
        return route.fulfill({ json: { ID: 1001, status: 'pending' } });
    });
    if (path) await page.goto(preview.url + path);
    return { page, submissions };
}

async function assertLayer(page, fallback, selector) {
    const panel = page.locator(selector);
    await panel.waitFor({ state: 'visible' });
    assert.equal(await panel.getAttribute('data-floating-search-layer'), fallback ? 'portal' : 'popover');
    const state = await panel.evaluate(node => {
        const box = node.getBoundingClientRect();
        return { visible: node.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)),
            left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight };
    });
    assert.equal(state.visible, true, JSON.stringify(state));
    assert.ok(state.left >= 0 && state.right <= state.width && state.top >= 0 && state.bottom <= state.height, JSON.stringify(state));
    assert.equal(await page.locator('[data-floating-search-layer]').count(), 1);
}

async function assertClosed(page) {
    await page.waitForFunction(() => !document.querySelector('[data-floating-search-layer], [data-floating-search-portal]'));
    assert.equal(await page.locator('.evaluation-suggestions:visible, .bp-vendor-search-panel:visible, .bp-model-limit-results:visible, .bp-filter-search-results:visible').count(), 0);
}

for (const fallback of [false, true]) {
    const mode = fallback ? 'portal' : 'popover';
    test(`contribution ${mode}: vendor focus, refresh, selection and subject-model dismissal`, async t => {
        const { page } = await openPage(t, fallback, '/contribute/models/new');
        const summary = page.locator('[data-catalog-picker="vendor"] summary');
        await summary.click();
        const query = page.locator('[data-vendor-search]');
        await query.fill('Aster');
        await assertLayer(page, fallback, '.bp-vendor-search-panel');
        await query.press('Escape');
        await assertClosed(page);
        assert.equal(await summary.evaluate(node => document.activeElement === node), true);
        await summary.click();
        await query.fill('Aster');
        await page.locator('[data-select-vendor="1"]').click();
        await assertClosed(page);
        assert.match(await summary.textContent(), /Aster/);
        const model = page.locator('[data-subject-model-name]');
        await model.fill('Aster Pro');
        await assertLayer(page, fallback, '.evaluation-suggestions:visible');
        await page.locator('[data-select-subject-model]').first().focus();
        await page.keyboard.press('Escape');
        await assertClosed(page);
        await page.waitForTimeout(200);
        await assertClosed(page);
        assert.equal(await model.evaluate(node => document.activeElement === node), true);
        await model.fill('Aster');
        await page.locator('[data-select-subject-model]').first().click();
        await page.waitForURL('**/contribute/models/301/edit');
        await assertClosed(page);
    });

    test(`contribution ${mode}: score chooser handlers retain source IDs and submit exactly once`, async t => {
        const { page, submissions } = await openPage(t, fallback, '/contribute/scores/new');
        const model = page.locator('[data-result-model-query]');
        await model.fill('Aster Pro');
        await assertLayer(page, fallback, '.evaluation-suggestions:visible');
        await page.locator('[data-select-result-model]').first().click();
        await assertClosed(page);
        const benchmark = page.locator('[data-result-object-query]');
        await benchmark.fill('General knowledge');
        await assertLayer(page, fallback, '.evaluation-suggestions:visible');
        await benchmark.press('Tab');
        await assertClosed(page);
        await page.locator('[data-score-value-input]').fill('55');
        await page.locator('[data-field="sourceURL"]').fill('https://example.com/evidence');
        await page.locator('#submit-contribution').click();
        await page.locator('#submit-success-dialog:not([hidden])').waitFor();
        assert.equal(submissions.length, 1);
        assert.equal(submissions[0].results[0].modelID, 301);
        assert.equal(submissions[0].results[0].benchmarkID, 101);
        assert.equal(submissions[0].results[0].benchmarkConditionID, 1);
        assert.equal(submissions[0].results[0].rawScore, 55);
    });

    test(`comparison ${mode}: clipped field/model search, Escape, validation and parent cleanup`, async t => {
        const { page } = await openPage(t, fallback);
        await page.route('**/__comparison-floating', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
            <html><head><meta name="viewport" content="width=device-width,initial-scale=1">
            <link rel="stylesheet" href="/css/model-comparison.css"><style>
            :root { --bp-surface:#fff; --bp-surface-soft:#fafafa; --bp-line:#ddd; --bp-text:#222; --bp-ink:#111; }
            body { margin:16px; font:14px Arial; } [hidden] { display:none!important; }
            #model-comparison-panel { transform:translateZ(0); contain:paint; overflow:hidden; }
            button, input { min-height:32px; } .bp-filter-search-wrap { width:270px; }
            </style></head><body>
            <button id="outside">Outside action</button><button id="model-comparison-toggle">Comparison</button>
            <input id="experimental-comparison" type="checkbox"><p id="comparison-experiment-status"></p>
            <button id="quick-comparison-help">Help</button><div id="quick-comparison-tooltip" hidden></div>
            <section id="model-comparison-panel" class="bp-comparison-panel" hidden>
            <div class="bp-comparison-heading"><h3>Comparison</h3><button id="model-comparison-close">Close</button></div>
            <div id="model-comparison-mode"><button data-mode="best">Best</button><button data-mode="matched">Matched</button></div>
            <h4 id="model-comparison-keys-heading">Fields</h4><div id="model-comparison-keys"></div><p id="model-comparison-note"></p></section>
            <script type="module">
            import { createComparisonControls } from '/js/workspace/comparison-controls.js';
            localStorage.setItem('benchpoll-comparison-settings-v1:1', JSON.stringify({ experimental:true }));
            window.changes = []; window.outsideClicks = 0;
            document.getElementById('outside').onclick = () => window.outsideClicks++;
            const controls = createComparisonControls({ onChange:value=>window.changes.push(value), onInvalid:()=>{} });
            controls.configureAccount('1', { last:null, profiles:[] });
            controls.render({ mode:'best', keys:['model'], filters:[], availableKeys:['model','field:9'],
                fields:[{ ID:9, name:'Temperature', type:'number' }], models:[{ID:301,name:'Aster Pro',vendor:'Aster'}], unconfiguredCount:0 });
            window.ready = true;
            </script></body></html>` }));
        await page.goto(preview.url + '/__comparison-floating');
        await page.waitForFunction(() => window.ready);
        await page.locator('#model-comparison-toggle').click();
        const field = page.getByRole('searchbox', { name: 'Search fields to limit' });
        await field.fill('Model');
        await assertLayer(page, fallback, '.bp-filter-search-results');
        await field.press('Escape');
        await assertClosed(page);
        assert.equal(await page.locator('#model-comparison-panel').isVisible(), true);
        await field.fill('Model');
        await page.getByRole('option', { name: 'Add Model filter' }).click();
        const model = page.getByRole('combobox', { name: 'Model value', exact: true });
        await model.fill('Aster');
        await assertLayer(page, fallback, '.bp-model-limit-results');
        await model.press('ArrowDown');
        await model.press('Enter');
        await assertClosed(page);
        assert.deepEqual(await page.evaluate(() => window.changes.at(-1).filters), [{ key: 'model', operator: 'eq', value: 301 }]);
        await model.fill('Not a catalog model');
        await page.locator('#outside').click();
        assert.equal(await model.getAttribute('aria-invalid'), 'true');
        assert.deepEqual(await page.evaluate(() => window.changes.at(-1).filters), [{ key: 'model', operator: 'eq', value: 301 }]);
        assert.equal(await page.evaluate(() => window.outsideClicks), 1);
        await model.fill('Aster');
        await assertLayer(page, fallback, '.bp-model-limit-results');
        await page.locator('#model-comparison-close').click();
        await assertClosed(page);
        assert.equal(await page.locator('#model-comparison-panel').isVisible(), false);
    });
}
