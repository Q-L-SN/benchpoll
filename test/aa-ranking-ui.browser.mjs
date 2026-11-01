import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';

test('AA benchmark remains browsable but cannot be added to a personal pie', async t => {
    const app = await startPreview({ aaBenchmarks: true });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await page.close(); await browser.close(); await app.close(); assert.deepEqual(errors, []); });
    await page.goto(`${app.url}/Intelligence`);
    await page.waitForSelector('#benchmark-rows .bp-benchmark-row');
    await page.locator('#pie-mode-personal').click();
    await page.locator('#benchmark-search').fill('AA Example');
    const row = page.locator('#benchmark-rows [data-condition-id="9901"]');
    await row.waitFor();
    const add = row.locator('[data-benchmark-control="add"]');
    assert.equal(await add.getAttribute('aria-disabled'), 'true');
    assert.match(await add.getAttribute('title'), /Artificial Analysis.*do not count/);
    const saves = app.state.requests.filter(request => request.path === '/api/save_personal_pie').length;
    await add.click({ force: true });
    await page.waitForTimeout(300);
    assert.equal(app.state.requests.filter(request => request.path === '/api/save_personal_pie').length, saves);
});
