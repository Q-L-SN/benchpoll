import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { weightedEntries } from './fixtures.mjs';

const output = resolve(process.env.FRONTEND_OUTPUT || 'D:/Codex-artifacts/website1/available-factor-20261019');
await mkdir(output, { recursive: true });
const weights = [1, 2].map(conditionID => ({ conditionID, weightBasisPoints: 5000 }));
const model = (ID, values) => ({ ID, modelID: ID, name: `M${ID}`, modelName: `M${ID}`, vendor: 'Example',
    vendorSlug: 'openai', condition: { parameters: {} }, results: new Map(Object.entries(values).map(([key, normalizedScore]) => [key, { normalizedScore }])) });
const results = [];
for (const [engine, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await browserType.launch({ headless: true, env: { ...process.env,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
        NO_PROXY: '*', no_proxy: '*' } });
    try {
        for (const width of [1440, 390, 320]) {
            const app = await startPreview({ comparisonModels: [model(1, { 1: 88 }), model(2, { 1: 80, 2: 80 })],
                personalEntries: weightedEntries(weights), publicWeights: weights });
            const context = await browser.newContext({ viewport: { width, height: 900 } });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            try {
                await page.addInitScript(() => localStorage.setItem('benchpoll-workspace-display-v1', 'standard'));
                await page.goto(app.url);
                await page.locator('.bp-model-row').first().waitFor({ state: 'attached' });
                if (width < 760) await page.locator('[data-mobile-panel="models"]').click();
                await page.locator('.bp-model-row').first().waitFor();
                const loaded = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace')
                    && response.request().postDataJSON()?.scoreMode === 'available');
                await page.locator('[data-score-mode="available"]').click();
                const response = await loaded;
                assert.equal(response.request().postDataJSON().availableInferenceVersion, 4);
                const payload = await response.json();
                const loadedLists = Object.values(payload.modelLeaderboards).filter(list => list.length);
                assert.ok(loadedLists.length > 0);
                for (const list of loadedLists) {
                    const sparse = list.find(row => row.modelID === 1);
                    assert.equal(sparse.lower, 69.04);
                    assert.equal(sparse.availableInference.coverageFactor, .5 ** .35);
                    assert.equal(Object.hasOwn(sparse.availableInference, 'coveragePenalty'), false);
                    assert.equal(sparse.availableInference.unpenalizedScore, 88);
                }
                await page.waitForFunction(() => document.querySelector('.bp-model-row .bp-model-name')?.textContent === 'M2'
                    && document.querySelector('[data-score-mode="available"]').getAttribute('aria-pressed') === 'true');
                const sparseRow = page.locator('.bp-model-row').filter({ has: page.locator('.bp-model-name', { hasText: /^M1$/ }) });
                assert.match(await sparseRow.locator('.bp-model-score').innerText(), /^69\b/);
                await sparseRow.click();
                const summary = page.locator('#model-scores-summary');
                await page.locator('#model-scores-dialog').waitFor({ state: 'visible' });
                await page.locator('#model-scores-dialog').evaluate(async dialog => {
                    await Promise.all(dialog.getAnimations({ subtree: true }).filter(animation =>
                        animation.effect.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
                });
                assert.match(await summary.innerText(), /Coverage factor: x0\.7846 \(88\.00 before adjustment\)/);
                assert.match(await summary.innerText(), /50\.00% could not be estimated/);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
                await page.screenshot({ path: `${output}/${engine}-${width}-details.png` });
                await page.locator('#model-scores-dialog .dialog-close-button').click();
                await page.locator('[data-score-mode="range"]').click();
                await page.waitForFunction(() => document.querySelector('[data-score-mode="range"]').getAttribute('aria-pressed') === 'true'
                    && document.querySelector('.bp-model-row .bp-model-score')?.textContent.includes('80'));
                app.state.comparisonModels = [model(1, { 1: -20 }), model(2, { 1: -20, 2: -20 })];
                await page.reload();
                await page.locator('.bp-model-row').first().waitFor({ state: 'attached' });
                if (width < 760) await page.locator('[data-mobile-panel="models"]').click();
                const negativeRead = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace')
                    && response.request().postDataJSON()?.scoreMode === 'available');
                await page.locator('[data-score-mode="available"]').click();
                const negativePayload = await (await negativeRead).json();
                for (const list of Object.values(negativePayload.modelLeaderboards).filter(list => list.length)) {
                    const sparse = list.find(row => row.modelID === 1);
                    assert.equal(sparse.lower, -24.31);
                    assert.equal(sparse.availableInference.appliedFactor, 2 - .5 ** .35);
                    assert.ok(sparse.lower < sparse.availableInference.unpenalizedScore);
                }
                await page.waitForFunction(() => document.querySelector('.bp-model-row .bp-model-name')?.textContent === 'M2'
                    && document.querySelector('[data-score-mode="available"]').getAttribute('aria-pressed') === 'true');
                await page.locator('.bp-model-row').filter({ has: page.locator('.bp-model-name', { hasText: /^M1$/ }) }).click();
                await page.locator('#model-scores-dialog').waitFor();
                assert.match(await summary.innerText(), /Negative scores use x1\.2154/);
                await page.locator('#model-scores-dialog').evaluate(async dialog => {
                    await Promise.all(dialog.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
                });
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
                await page.screenshot({ path: `${output}/${engine}-${width}-negative.png` });
                await page.locator('#model-scores-dialog .dialog-close-button').click();
                await page.route('**/api/get_weighted_workspace', async route => {
                    const response = await route.fetch();
                    const payload = await response.json();
                    payload.context = { ...payload.context, categoryPath: 'AGI', categoryName: 'AGI',
                        lineage: [{ ID: payload.context.categoryID, name: 'AGI' }], contextValues: {}, dimensions: [] };
                    await route.fulfill({ response, json: payload });
                });
                await page.goto(app.url + '/AGI');
                await page.locator('#agi-promo').waitFor({ state: 'visible' });
                await page.locator('#agi-promo').evaluate(async promo => {
                    await Promise.all(promo.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
                });
                const agi = await page.evaluate(() => {
                    const promo = document.querySelector('#agi-promo');
                    const path = document.querySelector('#bp-breadcrumb').getBoundingClientRect();
                    const rect = promo.getBoundingClientRect();
                    return { sharedRow: Boolean(promo.closest('.bp-context-row')),
                        sameBand: path.top < rect.bottom && path.bottom > rect.top,
                        height: rect.height, rect: rect.toJSON(), path: path.toJSON(),
                        style: { padding: getComputedStyle(promo).padding, height: getComputedStyle(promo).height,
                            boxSizing: getComputedStyle(promo).boxSizing, minHeight: getComputedStyle(promo).minHeight },
                        overflow: document.documentElement.scrollWidth > innerWidth + 1 };
                });
                assert.equal(agi.sharedRow, true);
                assert.equal(agi.sameBand, true);
                assert.ok(agi.height <= 44.1, JSON.stringify({ engine, width, agi }));
                assert.equal(agi.overflow, false);
                await page.screenshot({ path: `${output}/${engine}-${width}-agi.png` });
                assert.deepEqual(errors, []);
                results.push({ engine, width, passed: true });
                console.log(`PASS ${engine} ${width}`);
            } catch (error) {
                await page.screenshot({ path: `${output}/${engine}-${width}-failure.png`, fullPage: true });
                throw error;
            } finally {
                await context.close();
                await app.close();
            }
        }
    } finally { await browser.close(); }
}
await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
