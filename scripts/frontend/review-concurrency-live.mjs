import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.BENCHPOLL_URL || 'https://benchpoll.com';
const browser = await chromium.launch({ headless: true });
const checks = [];
try {
    for (const width of [1440, 390, 320]) {
        const page = await browser.newPage({ viewport: { width, height: 950 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.setDefaultTimeout(30000);
        await page.route('**/api/**', async route => {
            const pathname = new URL(route.request().url()).pathname;
            if (!pathname.startsWith('/api/get_') && pathname !== '/api/load_benchmarks_and_subcategories') {
                errors.push(`Unexpected production write: ${pathname}`);
                await route.abort(); return;
            }
            await route.continue();
        });
        try {
            await page.goto(base);
            await page.waitForFunction(() => document.getElementById('benchmark-card')?.getAttribute('aria-busy') === 'false');
            await page.waitForTimeout(1100);
            const initialURL = page.url();
            await page.evaluate(() => {
                window.reviewHistorySentinel = 'preserved';
                history.pushState({}, '', location.pathname + '?history-probe=1');
            });
            await page.goBack(); await page.waitForURL(initialURL);
            await page.waitForTimeout(250);
            assert.equal(await page.evaluate(() => window.reviewHistorySentinel), 'preserved');
            await page.locator('#beta-feedback-link').focus();
            await page.evaluate(async () => {
                const { showDialog } = await import('/js/global.js');
                window.reviewDialogValues = [];
                void showDialog({ title: 'Review check A', cancelLabel: 'Cancel' }).then(value => window.reviewDialogValues.push(['A', value]));
                void showDialog({ title: 'Review check B', cancelLabel: 'Cancel' }).then(value => window.reviewDialogValues.push(['B', value]));
            });
            const dialogs = page.locator('global-dialog.global-system-dialog:not([hidden])');
            await page.waitForFunction(() => document.querySelectorAll('global-dialog.global-system-dialog:not([hidden])')[1]?.contains(document.activeElement));
            await page.keyboard.press('Tab');
            assert.equal(await dialogs.nth(1).evaluate(host => host.contains(document.activeElement)), true);
            await page.keyboard.press('Escape');
            assert.equal(await dialogs.count(), 1);
            assert.deepEqual(await page.evaluate(() => window.reviewDialogValues), [['B', false]]);
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => document.activeElement.id === 'beta-feedback-link');
            await page.goto(`${base}/dialogPage?dialogCode=2&oldURL=${encodeURIComponent('javascript:window.reviewURLExecuted=true;void(0)')}`);
            await page.locator('#code-2-dialog:not([hidden]) .dialog-close-button').click();
            await page.waitForURL(url => url.pathname === '/' || url.pathname === '/Intelligence');
            assert.equal(await page.evaluate(() => window.reviewURLExecuted ?? false), false);
            await page.goto(`${base}/dialogPage?dialogCode=7&bannedUntil=invalid`);
            await page.locator('#code-7-dialog:not([hidden])').waitFor();
            assert.equal(await page.locator('#code-7-dialog a[href="/privacy#operator"]').count(), 1);
            assert.deepEqual(errors, []);
            checks.push({ width, noProductionWrites: true, historyPreserved: true, nestedDialogs: true,
                unsafeReturnRejected: true, invalidDateRenders: true });
        } finally { await page.close(); }
    }
} finally { await browser.close(); }
console.log(JSON.stringify({ passed: true, checks }));
