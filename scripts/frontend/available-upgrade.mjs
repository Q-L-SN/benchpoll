import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { weightedEntries } from './fixtures.mjs';

const output = resolve('D:/Codex-artifacts/website1/available-score-upgrade-20261012/browser');
await mkdir(output, { recursive: true });
const model = (ID, scores) => ({ ID, modelID: ID, name: `M${ID}`, modelName: `M${ID}`, condition: { parameters: {}, scoreFields: [] },
    results: new Map(Object.entries(scores).map(([key, normalizedScore]) => [key, { normalizedScore }])) });
const weights = [1, 2].map(conditionID => ({ conditionID, weightBasisPoints: 5000 }));
const models = [model(1, { 1: 95 }), model(2, { 1: 90, 3: 20, 2: 10 }), model(3, { 3: 80, 2: 70 }), model(4, { 2: 60 }), model(5, { 2: 90 })];
const report = [];
for (const [engine, type] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await type.launch({ headless: true });
    try {
        for (const width of [1440, 390]) {
            const app = await startPreview({ comparisonModels: models, personalEntries: weightedEntries(weights), publicWeights: weights });
            const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
            const page = await context.newPage(), errors = [], responses = [];
            page.setDefaultTimeout(10000);
            await page.route('https://**', route => route.abort());
            if (engine === 'webkit') await page.route(app.url + '/**', async route => {
                const response = await route.fetch();
                await route.fulfill({ response, body: await response.body() });
            });
            page.on('pageerror', e => errors.push(e.message));
            page.on('response', async response => {
                if (response.url().endsWith('/api/get_weighted_workspace')) responses.push(await response.json());
            });
            try {
                await page.goto(app.url);
                await page.locator('.bp-benchmark-row').first().waitFor();
                if (width === 390) await page.locator('button[data-mobile-panel="models"]').click();
                await page.locator('.bp-model-row').first().waitFor();
                await page.locator('[data-score-mode="available"]').click();
                await page.waitForFunction(() => document.querySelector('[data-score-mode="available"]')?.getAttribute('aria-pressed') === 'true'
                    && document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false');
                const current = responses.findLast(payload => payload.scoreMode === 'available');
                assert.ok(current);
                assert.ok(current.modelLeaderboards.public.every(row => row.availableInference?.method === 'pairwise-anchored'));
                assert.ok(app.state.requests.filter(r => r.path === '/api/get_weighted_workspace').every(r => r.body.availableInferenceVersion === 2));
                const row = current.modelLeaderboards.public.find(r => r.modelID === 1);
                assert.ok(row.inferredScores[0].normalizedScore < 60);
                assert.equal(row.coverage, 50);
                const help = page.getByRole('button', { name: 'About missing scores', exact: true });
                assert.match(await help.getAttribute('data-help-text'), /shared tests/);
                await help.click();
                await page.getByText('Score range leaves gaps as a range.', { exact: false }).last().waitFor();
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                await page.screenshot({ path: join(output, `${engine}-${width}-ranking.png`), fullPage: true });
                await page.goto(app.url + '/how-it-works');
                await page.getByText('Full calculation rules', { exact: true }).click();
                const summary = page.getByText('How does Available results estimate a missing score?', { exact: true });
                await summary.click();
                const faq = summary.locator('..');
                assert.match(await faq.textContent(), /tests they share/);
                assert.doesNotMatch(await faq.textContent(), /Average its percentiles/);
                await page.screenshot({ path: join(output, `${engine}-${width}-help.png`), fullPage: true });
                assert.deepEqual(errors, []);
                report.push({ engine, width, passed: true });
            } catch (error) {
                await page.screenshot({ path: join(output, `${engine}-${width}-failure.png`), fullPage: true });
                console.error(JSON.stringify({ engine, width, errors, url: page.url(), html: (await page.content()).slice(0, 250),
                    body: await page.locator('body').innerText() }));
                throw error;
            } finally { await context.close(); await app.close(); }
        }
    } finally { await browser.close(); }
}
await writeFile(join(output, 'checks.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
