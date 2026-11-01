import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startCloudPreview } from '../scripts/cloud/preview.mjs';

const built = process.argv.includes('--built');
const output = resolve(process.env.CLOUD_PREVIEW_OUTPUT ?? fileURLToPath(new URL('../artifacts/cloud-runtime/', import.meta.url)));
await mkdir(output, { recursive: true });
const app = await startCloudPreview({ port: 0, built });
let browser;
try {
    browser = await chromium.launch({ headless: true });
    for (const width of [1440, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
        const page = await context.newPage();
        const errors = [], failedResponses = [], external = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('response', response => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });
        await context.route('**/*', route => {
            if (new URL(route.request().url()).origin === app.url) return route.continue();
            external.push(route.request().url());
            return route.abort();
        });
        try {
            assert.equal((await page.goto(app.url)).status(), 200);
            await page.locator('#topics-grid[aria-busy="false"]').waitFor();
            await page.locator('.th-card[data-preview-state="loaded"]').first().waitFor();
            assert.ok(await page.locator('.th-card').count() > 0);
            assert.equal(await page.locator('script[type="module"]').first().getAttribute('src').then(src => src.startsWith('/build/index/')), built);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            await page.screenshot({ path: resolve(output, `${built ? 'built' : 'source'}-${width}.png`), fullPage: true });
            assert.deepEqual(errors, []);
            assert.deepEqual(failedResponses, []);
            assert.deepEqual(external, []);
            console.log(`PASS cloud fixture ${built ? 'built' : 'source'} ${width}px`);
        } finally { await context.close(); }
    }
} finally { await browser?.close(); await app.close(); }
