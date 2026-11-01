import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';

const browser = await chromium.launch({ headless: true });
const checks = [];
try {
    for (const width of [1440, 390, 320]) {
        const preview = await startPreview();
        const page = await browser.newPage({ viewport: { width, height: 950 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        try {
            for (const target of ['javascript:window.reviewURLExecuted=true;void(0)', 'https://example.com/']) {
                await page.goto(`${preview.url}/dialogPage?dialogCode=2&oldURL=${encodeURIComponent(target)}`);
                await page.locator('#code-2-dialog:not([hidden]) .dialog-close-button').click();
                await page.waitForURL(url => url.pathname === '/');
                assert.equal(await page.evaluate(() => window.reviewURLExecuted ?? false), false);
            }
            await page.goto(`${preview.url}/dialogPage?dialogCode=6&displayURL=https%3A%2F%2Fexample.com%2F&bannedUntil=invalid`);
            await page.locator('#code-6-dialog:not([hidden])').waitFor();
            assert.equal(new URL(page.url()).origin, preview.url);
            await page.goto(`${preview.url}/dialogPage?dialogCode=7&bannedUntil=invalid`);
            const suspended = page.locator('#code-7-dialog:not([hidden])');
            await suspended.waitFor();
            assert.ok((await suspended.textContent()).includes('the date shown in your suspension notice'));
            assert.equal(await suspended.getByRole('link', { name: 'contact procedure to submit an appeal' }).getAttribute('href'), '/privacy#operator');
            assert.equal(await suspended.locator('a[href^="mailto:"]').count(), 0);
            assert.deepEqual(errors, []);
            checks.push({ width, unsafeReturnRejected: true, invalidParametersRender: true, realAppealRoute: true });
        } finally { await page.close(); await preview.close(); }
    }
} finally { await browser.close(); }
console.log(JSON.stringify({ passed: true, checks }));
