import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';

const output = new URL('../../artifacts/arena-current-scores-20261003/ui/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];
try {
    for (const width of [1440, 390]) {
        const preview = await startPreview({ secondaryBenchmark: true });
        const context = await browser.newContext({ viewport: { width, height: 950 } });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.setDefaultTimeout(10000);
        try {
            await page.route('**/api/get_contribution_catalog', async route => {
                const response = await route.fetch();
                const payload = await response.json();
                payload.benchmarks[0].name = 'Synced-only fixture';
                payload.benchmarks[0].conditions[0].scoreSource = 'arena_official';
                payload.benchmarks = [payload.benchmarks[0]];
                await route.fulfill({ response, json: payload });
            });
            await page.goto(`${preview.url}/contribute/scores/new`);
            const model = page.locator('[data-result-model-query]').first();
            await model.fill('Aster Pro');
            await model.press('Tab');
            const benchmark = page.locator('[data-result-object-query]').first();
            await benchmark.fill('Synced-only fixture');
            const synced = page.locator('[data-select-result-object][data-condition-id="1"]');
            await synced.waitFor();
            assert.equal(await synced.isDisabled(), true);
            assert.match(await synced.innerText(), /Scores sync automatically/);
            await benchmark.press('Tab');
            assert.equal(await page.locator('[data-catalog-picker="benchmark-condition"]').count(), 0);
            await benchmark.focus();
            await synced.waitFor();
            await page.locator('.evaluation-suggestions .condition-suggestion-fold > summary').first().click();
            await page.locator('[data-select-result-object][data-condition-id="901"]').click();
            const picker = page.locator('[data-catalog-picker="benchmark-condition"]');
            assert.match(await picker.locator('summary').first().innerText(), /Extended/);
            await picker.locator('summary').first().click();
            const managedCondition = page.locator('[data-select-result-profile="1"]');
            await managedCondition.waitFor();
            assert.equal(await managedCondition.isDisabled(), true);
            await page.screenshot({ path: fileURLToPath(new URL(`new-score-${width}.png`, output)), fullPage: true });

            await page.goto(`${preview.url}/contribute?mode=edit_result&targetResultID=501`);
            const changePicker = page.locator('[data-catalog-picker="benchmark-condition"]');
            await changePicker.locator('summary').first().click();
            assert.equal(await page.locator('[data-select-result-profile="1"]').isDisabled(), false);
            assert.equal(await page.locator('.condition-source-notice').count(), 0);
            assert.deepEqual(errors, []);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
            checks.push({ width, newManagedScoresBlocked: true, staticConditionsSelectable: true,
                existingScoresChangeable: true, browserErrors: errors });
        } finally {
            await context.close();
            await preview.close();
        }
    }
} finally { await browser.close(); }
await writeFile(new URL('results.json', output), JSON.stringify({ passed: true, checks }, null, 2));
console.log(JSON.stringify({ passed: true, checks }));
