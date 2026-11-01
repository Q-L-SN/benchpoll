import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const output = new URL('../../artifacts/fallback-settings-20261006/ui/', import.meta.url);
const checks = [];
const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP benchpoll.com 18.226.222.18'],
    env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
try {
    for (const width of [1440, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 940 }, isMobile: width < 500, hasTouch: width < 500 });
        const page = await context.newPage(); page.setDefaultTimeout(60000);
        const errors = [], blockedWrites = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/api/**', route => {
            const path = new URL(route.request().url()).pathname;
            if (/^\/api\/(?:get_|load_benchmarks)/.test(path)) return route.continue();
            blockedWrites.push(path); return route.abort();
        });
        try {
            await page.goto('https://benchpoll.com/Intelligence', { waitUntil: 'domcontentloaded', timeout: 90000 });
            await page.waitForFunction(() => document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false');
            assert.equal(await page.locator('#inline-fallback-enabled').count(), 0);
            const rows = page.locator('.bp-benchmark-row:not(.is-family)'); const count = await rows.count();
            assert.ok(count > 0);
            const row = rows.first(); const id = await row.getAttribute('data-condition-id');
            await row.locator('.bp-benchmark-information-link').click();
            await page.waitForFunction(ID => document.body.classList.contains('discussion-open')
                || document.querySelector('.bp-left-workspace').dataset.workspaceView === 'focus'
                    && document.querySelector(`.bp-benchmark-row.selected[data-condition-id="${ID}"]`), id);
            if (!await page.evaluate(() => document.body.classList.contains('discussion-open'))) await row.locator('.bp-benchmark-information-link').click();
            await page.locator('#benchmark-information-name').waitFor();
            await page.waitForFunction(() => document.querySelector('#benchmark-information').getAttribute('aria-busy') === 'false');
            assert.ok((await page.locator('#benchmark-information-name').textContent()).trim());
            await page.locator('#discussion-close').click(); await page.locator('#discussion-panel').waitFor({ state: 'hidden' });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            assert.deepEqual(errors, []); assert.deepEqual(blockedWrites, []);
            await page.screenshot({ path: new URL(`live-public-${width}.png`, output).pathname.replace(/^\/(?=[A-Za-z]:)/, ''), fullPage: true, animations: 'disabled' });
            checks.push({ width, passed: true, benchmarkRows: count, inspectedConditionID: Number(id), errors, blockedWrites });
            console.log(`PASS public live ${width}: ${count} rows, inspection ${id}`);
        } catch (error) {
            checks.push({ width, passed: false, error: error.stack, errors, blockedWrites });
            await page.screenshot({ path: new URL(`live-public-${width}-failure.png`, output).pathname.replace(/^\/(?=[A-Za-z]:)/, ''), fullPage: true });
            throw error;
        } finally { await context.close(); }
    }
} finally {
    await browser.close(); await writeFile(new URL('live-public-checks.json', output), JSON.stringify(checks, null, 2));
}
