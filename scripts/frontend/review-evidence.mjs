import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { approvedResults } from './fixtures.mjs';

const output = resolve(process.env.REVIEW_OUTPUT ?? 'artifacts/review-20261008/evidence');
await mkdir(output, { recursive: true });
const reports = [];
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch({ headless: true, env });
    try {
        for (const width of [1440, 390]) {
            for (const sourceURL of ['https://example.com/evidence', '', null]) {
                const app = await startPreview();
                const page = await browser.newPage({ viewport: { width, height: 960 }, reducedMotion: 'reduce' });
                const errors = [];
                page.on('pageerror', error => errors.push(error.message));
                page.setDefaultTimeout(10000);
                try {
                    await page.route('**/api/get_approved_benchmark_results', async route => {
                        const body = route.request().postDataJSON();
                        const payload = approvedResults(body);
                        const group = payload.scoreGroups[0];
                        group.medianRawScore = 0.01405;
                        group.samples[0].rawScore = 0.014;
                        group.samples[1].rawScore = 0.0141;
                        group.samples[0].sourceURL = sourceURL;
                        const unbounded = payload.scoreGroups[1];
                        unbounded.usesPercentageScale = false;
                        unbounded.medianRawScore = 80.765432;
                        unbounded.samples[0].rawScore = -12.345678;
                        unbounded.samples[1].rawScore = 173.876542;
                        await route.fulfill({ json: payload });
                    });
                    await page.goto(app.url);
                    await page.locator('.bp-model-row').first().waitFor({ state: 'attached' });
                    if (width < 768) await page.locator('[data-mobile-panel="models"]').click();
                    await page.locator('.bp-model-row').first().click();
                    await page.locator('#model-scores-list .bp-model-configuration-link').first().click();
                    const group = page.locator('#model-scores-list .bp-model-score-detail-row').first();
                    await group.locator('.bp-model-score-sample').first().waitFor();
                    assert.equal(await group.locator('.bp-model-score-detail-value').textContent(), '0.01405%');
                    assert.deepEqual(await group.locator('.bp-model-score-sample-value').allTextContents(), ['0.014%', '0.0141%']);
                    const source = group.locator('.bp-model-score-source').first();
                    assert.equal(await source.evaluate(node => node.tagName), sourceURL ? 'A' : 'SPAN');
                    if (!sourceURL) assert.match(await source.innerText(), /No source link/);
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                    assert.deepEqual(errors, []);
                    const label = sourceURL === null ? 'null' : sourceURL ? 'linked' : 'empty';
                    await page.screenshot({ path: join(output, `${engine}-${width}-${label}.png`), fullPage: true });
                    await page.getByRole('button', { name: 'Back to ranking calculation', exact: true }).click();
                    await page.getByRole('button', { name: 'All scores', exact: true }).click();
                    await page.locator('#model-scores-list .bp-model-score-sample').first().waitFor();
                    assert.equal(await page.locator('#model-scores-list .bp-model-score-detail-value').first().textContent(), '0.01405%');
                    assert.deepEqual(await page.locator('#model-scores-list .bp-model-score-detail-row').nth(1)
                        .locator('.bp-model-score-sample-value').allTextContents(), ['-12.345678', '173.876542']);
                    reports.push({ engine, width, sourceURL, passed: true });
                    console.log(`PASS ${engine} ${width} ${label}: precise, safe source evidence`);
                } catch (error) {
                    reports.push({ engine, width, sourceURL, passed: false, error: error.stack, errors,
                        requests: app.state.requests, url: page.url() });
                    console.error(`FAIL ${engine} ${width} ${sourceURL}: ${error.message}`);
                } finally { await page.close(); await app.close(); }
            }
        }
    } finally { await browser.close(); }
}
await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
if (reports.some(report => !report.passed)) process.exitCode = 1;
