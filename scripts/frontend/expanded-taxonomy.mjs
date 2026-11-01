import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';
import { desiredDimensions } from '../migrate-expanded-taxonomy.mjs';
import { canonicalizeContextValues } from '../../ranking-service.js';

const output = new URL('../../artifacts/expanded-taxonomy/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
    for (const width of [1440, 390]) {
        const app = await startPreview();
        const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.setDefaultTimeout(8000);
        try {
            await page.route('**/api/get_weighted_workspace', async route => {
                const response = await route.fetch();
                const data = await response.json();
                const resolved = canonicalizeContextValues(route.request().postDataJSON().contextValues, desiredDimensions('programming'));
                Object.assign(data.context, { contextValues: resolved.contextValues, contextDisplayValues: resolved.displayValues,
                    dimensions: resolved.dimensions });
                await route.fulfill({ response, json: data });
            });
            await page.goto(app.url);
            const picker = page.locator('[data-template-key="language_framework"].bp-template-picker');
            await picker.locator('.bp-template-control').click();
            assert.equal(await picker.locator('input').count(), 0);
            await picker.getByRole('option').first().waitFor({ state: 'visible' });
            assert.ok(await picker.getByRole('option').count() > 20);
            const bounds = await picker.locator('.bp-template-menu').boundingBox();
            assert.ok(bounds.height <= 361 && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
            await page.screenshot({ path: fileURLToPath(new URL(`programming-${width}.png`, output)), fullPage: true });
            if (width > 760) {
                await picker.locator('.bp-template-control').press('ArrowDown');
                await page.keyboard.type('pytorch');
                assert.equal(await page.locator(':focus').textContent(), 'PyTorch');
                await page.keyboard.press('Enter');
            } else await picker.getByRole('option', { name: 'PyTorch', exact: true }).click();
            await page.waitForFunction(() => document.querySelector('.bp-template-value')?.textContent === 'PyTorch');
            assert.ok(new URL(page.url()).searchParams.has('pytorch'));
            assert.deepEqual(errors, []);
            console.log(`PASS search-free bounded context selector and keyboard choice at ${width}px`);
        } finally {
            await context.close();
            await app.close();
        }
    }
} finally {
    await browser.close();
}
