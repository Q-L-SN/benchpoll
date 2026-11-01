import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
    await page.addInitScript(() => localStorage.setItem('benchpoll-welcome-seen-v1', '1'));
    const workspaceResponse = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace'));
    await page.goto('https://benchpoll.com/', { waitUntil: 'domcontentloaded' });
    const workspace = await (await workspaceResponse).json();
    assert.ok(workspace.modelLeaderboards.public.length > 0);
    await page.locator('#model-comparison-toggle:not([disabled])').click();
    const model = workspace.comparison.models[0];
    await page.getByRole('button', { name: 'Add Model filter' }).click();
    const filteredResponse = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace'));
    await page.getByLabel('Model value', { exact: true }).fill(model.name);
    await page.getByLabel('Model value', { exact: true }).blur();
    const filtered = await filteredResponse;
    assert.equal(filtered.status(), 200);
    const data = await filtered.json();
    assert.deepEqual(data.comparison.filters, [{ key: 'model', operator: 'eq', value: model.ID }]);
    const numericField = workspace.comparison.fields.find(field => field.type === 'number');
    if (numericField) {
        await page.getByRole('searchbox', { name: 'Search fields to limit' }).fill(numericField.name);
        await page.getByRole('button', { name: 'Add ' + numericField.name + ' filter', exact: true }).last().click();
        await page.getByRole('combobox', { name: numericField.name + ' filter', exact: true }).selectOption('gt');
        const numericResponse = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace'));
        await page.getByLabel(numericField.name + ' value', { exact: true }).fill('0');
        await page.getByLabel(numericField.name + ' value', { exact: true }).blur();
        const numeric = await numericResponse;
        assert.equal(numeric.status(), 200);
        assert.deepEqual((await numeric.json()).comparison.filters.at(-1),
            { key: 'field:' + numericField.ID, operator: 'gt', value: '0' });
    }
    await mkdir('artifacts/frontend', { recursive: true });
    await page.screenshot({ path: 'artifacts/frontend/score-fields-live-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'artifacts/frontend/score-fields-live-mobile.png', fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ live: true, configurations: workspace.modelLeaderboards.public.length,
        filteredModel: model.name, numericField: numericField?.name ?? null, pageErrors: errors }));
} finally { await browser.close(); }
