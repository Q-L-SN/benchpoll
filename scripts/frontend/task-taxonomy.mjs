import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';
import { desiredDimensions } from '../migrate-expanded-taxonomy.mjs';
import { canonicalizeContextValues } from '../../ranking-service.js';

const specification = JSON.parse(await readFile(new URL('../../ops/task-taxonomy-20261002.json', import.meta.url), 'utf8'));
const output = new URL('../../artifacts/task-taxonomy/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
    for (const width of [1440, 390]) {
        const app = await startPreview();
        const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce',
            hasTouch: width === 390, isMobile: width === 390 });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.setDefaultTimeout(10000);
        try {
            await page.route('**/api/get_weighted_workspace', async route => {
                const response = await route.fetch();
                const data = await response.json();
                const resolved = canonicalizeContextValues(route.request().postDataJSON().contextValues, desiredDimensions('image', specification));
                Object.assign(data.context, { contextValues: resolved.contextValues, contextDisplayValues: resolved.displayValues,
                    dimensions: resolved.dimensions });
                await route.fulfill({ response, json: data });
            });
            await page.goto(app.url);
            await page.waitForLoadState('networkidle');
            const picker = key => page.locator(`[data-template-key="${key}"].bp-template-picker`);
            const control = key => picker(key).locator('.bp-template-control');
            const choose = async (key, name) => {
                await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
                await control(key).click();
                await picker(key).getByRole('option', { name, exact: true }).click();
                await page.waitForFunction(([key, name]) => document.querySelector(`[data-template-key="${key}"] .bp-template-value`)?.textContent === name,
                    [key, name]);
                await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
            };
            await control('realtime').waitFor();
            await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
            assert.equal(await control('output').isDisabled(), true);
            assert.equal(await control('reference_image').isDisabled(), true);
            await choose('realtime', 'Any');
            assert.equal(await control('output').isDisabled(), true);
            await choose('realtime', 'No');
            assert.equal(await control('output').isDisabled(), false);
            assert.equal(await control('reference_image').isDisabled(), true);
            await choose('output', 'Vector');
            await choose('reference_image', 'Multiple');
            await choose('realtime', 'Yes');
            assert.equal(await picker('output').locator('.bp-template-value').textContent(), 'Vector');
            assert.equal(await picker('reference_image').locator('.bp-template-value').textContent(), 'Multiple');
            await page.reload();
            await page.waitForFunction(() => document.querySelector('[data-template-key="reference_image"] .bp-template-value')?.textContent === 'Multiple');
            assert.equal(await control('reference_image').isDisabled(), false);
            await choose('realtime', 'Any');
            assert.equal(await control('output').isDisabled(), true);
            assert.equal(await control('reference_image').isDisabled(), true);
            assert.equal(await picker('reference_image').locator('.bp-template-value').textContent(), 'Any');
            await page.screenshot({ path: fileURLToPath(new URL(`ordered-${width}.png`, output)) });
            assert.deepEqual(errors, []);
            console.log(`PASS ordered templates, Any locks and resets, No unlocks, selection preservation, and reload at ${width}px`);
        } catch (error) {
            await page.screenshot({ path: fileURLToPath(new URL(`failed-${width}.png`, output)) });
            console.log(JSON.stringify({ width, url: page.url(), templates: await page.locator('#bp-template-strip').innerHTML(), errors }));
            throw error;
        } finally {
            await context.close();
            await app.close();
        }
    }
} finally {
    await browser.close();
}
