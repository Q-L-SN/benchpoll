import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { weightedEntries } from './fixtures.mjs';
import { validateWorkspacePayload } from '../../public/js/workspace/contracts.js';

const output = resolve(process.env.COVERAGE_POWER_OUTPUT || 'D:/Codex-artifacts/website1/topic-identity-coverage-20261026/coverage-browser');
await mkdir(output, { recursive: true });
const report = { cases: [], errors: [], passed: false };
const weights = [1, 2].map(conditionID => ({ conditionID, weightBasisPoints: 5000 }));
const model = (ID, values) => ({ ID, modelID: ID, name: `M${ID}`, modelName: `M${ID}`, vendor: 'Example', vendorSlug: 'openai',
    condition: { parameters: {} }, results: new Map(Object.entries(values).map(([key, normalizedScore]) => [key, { normalizedScore }])) });
try {
    for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
        const browser = await launcher.launch({ headless: true, env: { ...process.env,
            HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
        try {
            for (const width of [1440, 390, 320]) {
                const app = await startPreview({ comparisonModels: [model(1, { 1: 88 }), model(2, { 1: 80, 2: 80 })],
                    personalEntries: weightedEntries(weights), publicWeights: weights });
                const context = await browser.newContext({ viewport: { width, height: 950 }, hasTouch: width < 500 });
                const page = await context.newPage();
                page.setDefaultTimeout(20000);
                page.on('pageerror', error => report.errors.push({ engine, width, message: error.message }));
                try {
                    const read = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace'));
                    await page.goto(app.url);
                    const payload = validateWorkspacePayload(await (await read).json());
                    const sparse = payload.modelLeaderboards.public.find(row => row.modelID === 1);
                    assert.equal(payload.scoreMode, 'available');
                    assert.equal(sparse.lower, 69.04);
                    assert.equal(sparse.availableInference.coverageFactor, .5 ** .35);
                    await page.locator('.bp-model-row').first().waitFor({ state: 'attached' });
                    if (width < 760) await page.locator('[data-mobile-panel="models"]').click();
                    const row = page.locator('.bp-model-row').filter({ has: page.locator('.bp-model-name', { hasText: /^M1$/ }) });
                    await row.click();
                    await page.locator('#model-scores-dialog').waitFor();
                    assert.match(await page.locator('#model-scores-summary').innerText(), /Coverage factor: x0\.7846/);
                    await page.screenshot({ path: join(output, `${engine}-${width}-positive.png`) });
                    await page.locator('#model-scores-dialog .dialog-close-button').click();
                    app.state.comparisonModels = [model(1, { 1: -20 }), model(2, { 1: -20, 2: -20 })];
                    const negativeRead = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace'));
                    await page.goto(app.url);
                    const negative = validateWorkspacePayload(await (await negativeRead).json());
                    const negativeSparse = negative.modelLeaderboards.public.find(row => row.modelID === 1);
                    assert.equal(negativeSparse.lower, -24.31);
                    assert.equal(negativeSparse.availableInference.appliedFactor, 2 - .5 ** .35);
                    await page.locator('.bp-model-row').first().waitFor({ state: 'attached' });
                    if (width < 760) await page.locator('[data-mobile-panel="models"]').click();
                    await row.click(); await page.locator('#model-scores-dialog').waitFor();
                    assert.match(await page.locator('#model-scores-summary').innerText(), /Negative scores use x1\.2154/);
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
                    await page.screenshot({ path: join(output, `${engine}-${width}-negative.png`) });
                    report.cases.push({ engine, width, positive: sparse.lower, negative: negativeSparse.lower, passed: true });
                    console.log(`PASS coverage power ${engine} ${width}`);
                } finally { await context.close(); await app.close(); }
            }
        } finally { await browser.close(); }
    }
    assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.failure = error.stack; throw error; }
finally { await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); }
