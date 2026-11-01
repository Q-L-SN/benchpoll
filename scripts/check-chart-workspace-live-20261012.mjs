import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const output = 'D:/Codex-artifacts/website1/chart-workspace-20261012/live';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
try {
    for (const width of [1440, 390, 320]) {
        const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width < 760, isMobile: width < 760 });
        const page = await context.newPage(); page.setDefaultTimeout(30000);
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        try {
            await page.goto('https://benchpoll.com/Intelligence');
            await page.waitForFunction(() => document.querySelector('#model-ranking-status')?.dataset.phase === 'ready');
            const initial = await page.locator('#model-rows [data-model-key]').evaluateAll(rows => rows.map(row => row.dataset.modelKey));
            await page.locator('#workspace-display-toggle').click();
            await page.waitForFunction(() => document.querySelector('.bp-workspace')?.dataset.display === 'charts');
            assert.deepEqual(await page.locator('.bp-model-column').evaluateAll(rows => rows.map(row => row.dataset.modelKey)), initial);
            assert.equal(await page.locator('#benchmark-card').isVisible(), false);
            assert.equal(await page.locator('#weight-pie').isVisible(), false);
            assert.equal(await page.locator('#inline-fallback').isVisible(), false);
            assert.equal(await page.locator('.bp-mode-switch').isVisible(), false);
            assert.equal(await page.locator('#weight-bars-title').textContent(), 'Public Weights');
            assert.equal(await page.locator('#weight-bars input, #weight-bars button').count(), 0);
            assert.equal(await page.locator('#personal-pie-create').isVisible(), false);
            assert.equal(await page.locator('.bp-column-known .bp-model-column-value').count(), initial.length);
            assert.equal(await page.locator('.bp-quick-comparison button:visible').count(), 2);
            assert.equal(await page.locator('.bp-left-workspace').isVisible(), true);
            assert.equal(await page.locator('.bp-right-workspace').isVisible(), true);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            const weights = await page.locator('.bp-weight-bar-value').allTextContents();
            assert.ok(weights.length > 0);
            const values = weights.map(value => Number.parseFloat(value));
            assert.deepEqual(values, [...values].sort((a, b) => b - a));
            await page.waitForFunction(() => document.querySelector('#model-ranking-status').hidden);
            await page.screenshot({ path: join(output, `${width}-public-charts.png`), fullPage: true });
            await page.reload();
            await page.waitForFunction(() => document.querySelector('#model-ranking-status')?.dataset.phase === 'ready');
            assert.equal(await page.locator('.bp-workspace').getAttribute('data-display'), 'charts');
            await page.locator('.bp-weight-bar-heading a').first().click();
            await page.waitForFunction(() => document.querySelector('#discussion-panel').getAttribute('aria-hidden') === 'false');
            assert.equal(await page.locator('#benchmark-information').isVisible(), true);
            await page.locator('#discussion-close').click();
            await page.locator('.bp-model-column').first().click();
            await page.locator('#model-scores-dialog').waitFor();
            await page.locator('#model-scores-dialog .dialog-close-button').click();
            await page.locator('#workspace-display-toggle').click();
            assert.equal(await page.locator('#benchmark-card').isVisible(), true);
            assert.deepEqual(errors, []);
            results.push({ width, models: initial.length, weights: weights.length, sameSamples: true, sorted: true, dialogs: true, persistence: true, errors });
        } finally { await context.close(); }
    }
} finally { await browser.close(); }
await writeFile(join(output, 'verification.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
