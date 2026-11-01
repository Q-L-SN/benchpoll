import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1380, height: 920 } });
const errors = [];
const failed = [];
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => {
    if (response.url().includes('/api/') && response.status() >= 400) failed.push(`${response.status()} ${response.url()}`);
});
await page.addInitScript(() => localStorage.setItem('benchpoll-welcome-seen-v1', '1'));
try {
    await page.goto('https://benchpoll.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('#model-comparison-toggle:not([disabled])').waitFor({ timeout: 60000 });
    await page.locator('#model-comparison-toggle').click();
    assert.equal(await page.locator('#model-comparison-keys input[value="model"]').isChecked(), true);
    assert.equal(await page.locator('#model-comparison-keys label').first().textContent(), 'Model');
    const extra = page.locator('#model-comparison-keys input:not([value="model"])').first();
    if (await extra.count()) {
        assert.equal(await extra.isChecked(), false);
        const refreshed = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace'), { timeout: 60000 });
        await extra.check();
        await refreshed;
        const selected = await page.locator('#model-comparison-keys input:checked').evaluateAll(inputs => inputs.map(input => input.value));
        assert.ok(selected.includes('model') && selected.length === 2);
    }
    const toggle = page.getByRole('button', { name: 'Saved configurations', exact: true });
    const menu = page.locator('.bp-profile-popover');
    await toggle.click();
    assert.equal(await menu.getByText('Last used', { exact: true }).count(), 0);
    await menu.getByRole('button', { name: 'Save current configuration', exact: true }).click();
    await menu.getByLabel('Configuration name').fill('Live guest check');
    await menu.getByRole('button', { name: 'Save', exact: true }).click();
    await menu.getByText('Configuration saved.', { exact: true }).waitFor();
    assert.equal(await menu.getByRole('button', { name: 'Saved as Live guest check', exact: true }).isDisabled(), true);
    await menu.getByRole('button', { name: 'Rename Live guest check', exact: true }).click();
    await menu.getByLabel('Configuration name').fill('My ranking');
    await menu.getByRole('button', { name: 'Rename', exact: true }).click();
    await menu.getByText('Configuration renamed.', { exact: true }).waitFor();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#model-comparison-toggle:not([disabled])').click();
    await toggle.click();
    assert.equal(await menu.getByRole('button', { name: 'My ranking', exact: true }).count(), 1);
    assert.equal(await page.locator('#model-comparison-keys input[value="model"]').isChecked(), true);
    if (await extra.count()) assert.equal(await extra.isChecked(), true);
    await menu.evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); });
    const bounds = await menu.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 1380 && bounds.y + bounds.height <= 920);
    await mkdir('artifacts/frontend', { recursive: true });
    await page.screenshot({ path: 'artifacts/frontend/comparison-profiles-live.png', fullPage: true });
    await menu.getByRole('button', { name: 'Delete My ranking' }).click();
    await menu.getByText('Configuration deleted.', { exact: true }).waitFor();
    assert.equal(await menu.locator('.bp-profile-row').count(), 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(failed, []);
    console.log('Live comparison profiles: implicit restore, guest save, duplicate prevention, rename, delete and bounded menu passed.');
} finally {
    await browser.close();
}
