import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';

await mkdir('artifacts/frontend', { recursive: true });
const browser = await chromium.launch({ headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '',
    ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
try {
    for (const authenticated of [true, false]) {
        const app = await startPreview({ authenticated });
        const context = await browser.newContext({ viewport: { width: 1380, height: 920 } });
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const menu = page.locator('.bp-profile-popover');
        const toggle = page.getByRole('button', { name: 'Saved configurations', exact: true });
        const harness = page.locator('#model-comparison-keys input[value="field:1"]');
        const settled = () => page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace'));
        const open = async () => { await toggle.click(); await menu.waitFor({ state: 'visible' }); };
        try {
            await page.goto(app.url);
            await page.locator('#benchmark-card[aria-busy="false"]').waitFor({ state: 'attached' });
            if (await page.locator('body').evaluate(node => node.classList.contains('is-showcase'))) {
                await page.locator('#showcase-enter').click();
                await page.waitForFunction(() => !document.body.classList.contains('is-showcase'));
            }
            if (!authenticated) {
                assert.equal(await page.locator('#model-comparison-toggle').isVisible(), false);
                assert.equal(await toggle.isVisible(), false);
                console.log('PASS guest does not expose the authenticated advanced comparison experiment');
                continue;
            }
            await page.locator('#user-profile').click();
            await page.locator('#experimental-comparison:not([disabled])').setChecked(true);
            await page.locator('#user-account-dialog .dialog-close-button').click();
            await page.locator('#model-comparison-toggle:not([disabled])').click();
            assert.equal(await page.locator('#model-comparison-keys input[value="model"]').isChecked(), true);
            assert.equal(await harness.isChecked(), false);
            let update = settled();
            await harness.check(); await update;
            await open();
            assert.equal(await menu.getByText('Last used', { exact: true }).count(), 0);
            await menu.getByRole('button', { name: 'Save current configuration', exact: true }).click();
            await menu.getByLabel('Configuration name').fill('Models and harnesses');
            await menu.getByRole('button', { name: 'Save', exact: true }).click();
            await menu.getByText('Configuration saved.', { exact: true }).waitFor();
            assert.equal(await menu.getByRole('button', { name: 'Saved as Models and harnesses', exact: true }).isDisabled(), true);
            assert.equal(app.state.comparisonProfiles.length, authenticated ? 1 : 0);
            await menu.getByRole('button', { name: 'Rename Models and harnesses' }).click();
            await menu.getByLabel('Configuration name').fill('My comparison');
            await menu.getByRole('button', { name: 'Rename', exact: true }).click();
            await menu.getByRole('button', { name: 'My comparison', exact: true }).waitFor();
            if (authenticated) assert.equal(app.state.comparisonProfiles[0].name, 'My comparison');
            await page.locator('.bp-comparison-heading h3').click();
            update = settled();
            await harness.uncheck(); await update;
            const storageKey = 'benchpoll-comparison-profiles-v2:' + (authenticated ? app.state.userID : 'guest');
            await page.waitForFunction(key => JSON.parse(localStorage.getItem(key))?.last?.keys?.length === 1, storageKey);
            await page.reload();
            await page.locator('#model-comparison-toggle:not([disabled])').click();
            assert.equal(await harness.isChecked(), false);
            await open();
            update = settled();
            await menu.getByRole('button', { name: 'My comparison', exact: true }).click(); await update;
            assert.equal(await harness.isChecked(), true);
            await open();
            const bounds = await menu.boundingBox();
            assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 1380 && bounds.y + bounds.height <= 920);
            await menu.evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); });
            await page.screenshot({ path: 'artifacts/frontend/comparison-profiles-' + (authenticated ? 'account' : 'guest') + '-desktop.png' });
            await menu.getByRole('button', { name: 'Delete My comparison' }).click();
            await menu.getByText('Configuration deleted.', { exact: true }).waitFor();
            assert.equal(await menu.locator('.bp-profile-row').count(), 0);
            await page.setViewportSize({ width: 390, height: 844 });
            await page.locator('[data-mobile-panel="models"]').click();
            await page.locator('#model-comparison-panel:not([hidden])').waitFor();
            await open();
            await menu.getByRole('button', { name: 'Save current configuration', exact: true }).click();
            const mobileBounds = await menu.boundingBox();
            assert.ok(mobileBounds.x >= 0 && mobileBounds.x + mobileBounds.width <= 390 && mobileBounds.y + mobileBounds.height <= 844);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            const saveBounds = await menu.getByRole('button', { name: 'Save', exact: true }).boundingBox();
            assert.ok(saveBounds.width > 40);
            await menu.evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); });
            await page.screenshot({ path: 'artifacts/frontend/comparison-profiles-' + (authenticated ? 'account' : 'guest') + '-mobile.png', fullPage: true });
            assert.deepEqual(errors, []);
            console.log('PASS ' + (authenticated ? 'account' : 'guest') + ' implicit restore, save, duplicate prevention, rename, delete, and bounded menu');
        } finally { await context.close(); await app.close(); }
    }
} finally { await browser.close(); }
