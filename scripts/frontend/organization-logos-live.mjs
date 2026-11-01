import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const output = new URL('../../artifacts/organization-logos-20261006/ui/', import.meta.url);
const checks = [];
const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP benchpoll.com 18.226.222.18'],
    env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
try {
    for (const width of [1440, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 950 },
            isMobile: width < 500, hasTouch: width < 500, deviceScaleFactor: width < 500 ? 3 : 1 });
        const page = await context.newPage();
        page.setDefaultTimeout(60000);
        const errors = [], assets = [], blockedWrites = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('response', response => {
            if (response.url().includes('/assets/vendors/') || response.url().includes('/js/shared/organization-logos.js')) {
                assets.push({ url: response.url(), status: response.status() });
            }
        });
        await page.route('**/api/**', route => {
            const path = new URL(route.request().url()).pathname;
            if (/^\/api\/(?:get_|load_benchmarks)/.test(path)) return route.continue();
            blockedWrites.push(path); return route.abort();
        });
        try {
            await page.goto('https://benchpoll.com/Intelligence', { waitUntil: 'domcontentloaded', timeout: 90000 });
            await page.waitForFunction(() => document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false');
            if (width < 500) await page.locator('[data-mobile-panel="models"]').click();
            const count = await page.locator('#model-rows .bp-model-row').count();
            const images = await page.locator('#model-rows .bp-vendor-mark img').evaluateAll(async images => {
                await Promise.all(images.map(image => image.decode()));
                return images.map(image => ({ src: image.getAttribute('src'), width: image.width, height: image.height,
                    decoded: image.complete && image.naturalWidth > 0 }));
            });
            for (const image of images) {
                assert.ok(image.decoded); assert.equal(image.width, 20); assert.equal(image.height, 20);
                assert.match(image.src, /^\/assets\/vendors\/.+\?v=organization-logos-20261006$/);
            }
            assert.ok(assets.some(asset => asset.url.includes('/js/shared/organization-logos.js?v=organization-logos-20261006')));
            assert.ok(assets.every(asset => asset.status === 200));
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            assert.deepEqual(errors, []); assert.deepEqual(blockedWrites, []);
            await page.screenshot({ path: new URL(`live-ranking-${width}.png`, output).pathname.replace(/^\/(?=[A-Za-z]:)/, ''), fullPage: true });
            checks.push({ width, passed: true, models: count, decodedLogos: images.length, assets, errors, blockedWrites });
            console.log(`PASS live ${width}: ${count} model rows, ${images.length} decoded logos`);
        } catch (error) {
            checks.push({ width, passed: false, error: error.stack, errors, assets, blockedWrites });
            await page.screenshot({ path: new URL(`live-ranking-${width}-failure.png`, output).pathname.replace(/^\/(?=[A-Za-z]:)/, ''), fullPage: true });
            throw error;
        } finally { await context.close(); }
    }
} finally {
    await browser.close(); await writeFile(new URL('live-checks.json', output), JSON.stringify(checks, null, 2));
}
