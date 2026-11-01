import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { observeDocumentTelemetry } from './cloudflare-telemetry.mjs';

const base = process.argv.find(value => /^https?:/.test(value));
const output = resolve(process.env.LAUNCH_OUTPUT ?? 'artifacts/launch-check');
await mkdir(output, { recursive: true });
const reports = [];
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const preview = base ? null : await startPreview({ authenticated: false });
const origin = base ?? preview.url;
const settledTelemetry = process.argv.includes('--settled-telemetry');
try {
    for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
        if (process.env.LAUNCH_ENGINE && process.env.LAUNCH_ENGINE !== engine) continue;
        const browser = await launcher.launch({ headless: true, env });
        try {
            for (const width of [1440, 390]) {
                if (process.env.LAUNCH_WIDTH && Number(process.env.LAUNCH_WIDTH) !== width) continue;
                const page = await browser.newPage({ viewport: { width, height: 960 }, isMobile: width < 500, hasTouch: width < 500 });
                page.setDefaultTimeout(base ? 60000 : 12000);
                const errors = [], failedResponses = [], api = [], networkFailures = [], telemetry = [];
                page.on('pageerror', error => errors.push({ message: error.message, stack: error.stack, url: page.url() }));
                page.on('requestfailed', request => networkFailures.push({ url: request.url(), error: request.failure()?.errorText }));
                page.on('response', response => {
                    const url = new URL(response.url());
                    if (url.origin === new URL(origin).origin && response.status() >= 400) failedResponses.push({ path: url.pathname, status: response.status() });
                    if (url.pathname.startsWith('/api/')) api.push({ path: url.pathname, status: response.status() });
                });
                try {
                    const start = Date.now();
                    assert.equal((await page.goto(origin, { waitUntil: 'domcontentloaded' })).status(), 200);
                    await page.locator('#benchmark-card[aria-busy="false"]').waitFor({ state: 'attached' });
                    await page.locator('.bp-benchmark-row').first().waitFor();
                    const loadMilliseconds = Date.now() - start;
                    await page.locator('#model-card[aria-busy="false"]').waitFor({ state: 'attached' });
                    await page.locator('#model-ranking-status').waitFor({ state: 'hidden' });
                    await page.screenshot({ path: join(output, `${engine}-${width}-public.png`), fullPage: true });
                    const create = page.locator('#personal-pie-create');
                    if (await create.isVisible()) await create.click();
                    else await page.locator('#pie-mode-personal').click();
                    await page.waitForFunction(() => document.querySelector('#pie-mode-personal')?.getAttribute('aria-selected') === 'true');
                    await page.locator('.bp-pie-flip-face').waitFor({ state: 'detached' });
                    for (let i = 0; i < 3; i++) {
                        const response = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace')
                            && response.request().postDataJSON()?.previewPersonalPie?.entries.length === i + 1);
                        await page.locator('.bp-benchmark-row:not(.is-family) .bp-benchmark-add:not([disabled])').first().click();
                        assert.equal((await response).status(), 200);
                        await page.locator('#benchmark-card[aria-busy="false"]').waitFor({ state: 'attached' });
                    }
                    await page.locator('#guest-draft-notice').waitFor();
                    await page.locator('#model-card[aria-busy="false"]').waitFor({ state: 'attached' });
                    await page.locator('#model-ranking-status').waitFor({ state: 'hidden' });
                    assert.match(await page.locator('#guest-draft-notice').innerText(), /Sign in to save/);
                    assert.equal(api.some(request => request.path === '/api/save_personal_pie'), false);
                    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
                    await page.screenshot({ path: join(output, `${engine}-${width}-personal.png`), fullPage: width >= 768 });
                    if (width < 768) await page.locator('[data-mobile-panel="models"]').click();
                    await page.locator('.bp-model-row').first().waitFor();
                    for (const field of ['reasoning', 'harness']) {
                        const control = page.locator(`[data-quick-comparison="${field}"]`);
                        if (await control.isEnabled()) {
                            const updated = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace'));
                            await control.click();
                            assert.equal((await updated).status(), 200);
                            await page.locator('#benchmark-card[aria-busy="false"]').waitFor({ state: 'attached' });
                        }
                    }
                    await page.evaluate(() => document.fonts.ready);
                    await page.locator('#model-card[aria-busy="false"]').waitFor({ state: 'attached' });
                    await page.locator('#model-ranking-status').waitFor({ state: 'hidden' });
                    await page.screenshot({ path: join(output, `${engine}-${width}-models.png`), fullPage: true });
                    assert.equal(await page.locator('.bp-model-display-parameter').evaluateAll(nodes => nodes.some(node => {
                        node.scrollLeft = 10; return node.scrollLeft !== 0;
                    })), false);
                    await page.locator('.bp-model-row').first().click();
                    await page.locator('#model-scores-dialog').waitFor();
                    await page.locator('#model-scores-dialog .bp-model-score-detail-row').first().waitFor();
                    await page.screenshot({ path: join(output, `${engine}-${width}-evidence.png`), fullPage: true });
                    await page.locator('#model-scores-dialog .dialog-close-button').click();
                    await page.reload({ waitUntil: 'domcontentloaded' });
                    await page.locator('#guest-draft-notice').waitFor();
                    await page.locator('#benchmark-card[aria-busy="false"]').waitFor({ state: 'attached' });
                    for (const path of ['/how-it-works', '/privacy', '/terms', '/contribute/scores/new']) {
                        const observed = settledTelemetry ? observeDocumentTelemetry(page, origin + path) : null;
                        assert.equal((await page.goto(origin + path, { waitUntil: 'domcontentloaded' })).status(), 200, path);
                        await page.evaluate(() => document.fonts.ready);
                        if (observed && await page.locator('script[src*="cloudflareinsights.com"]').count()) {
                            const result = await observed;
                            telemetry.push(result);
                            assert.equal(result.completed, true, result.error ?? 'Current document telemetry must complete');
                        }
                        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${path}: overflow`);
                    }
                    await page.locator('#auth-missing').waitFor();
                    assert.deepEqual(errors, []);
                    assert.deepEqual(failedResponses, []);
                    reports.push({ engine, width, loadMilliseconds, passed: true, api, networkFailures, telemetry,
                        mode: settledTelemetry ? 'settled-telemetry' : 'immediate-navigation' });
                    console.log(`PASS ${engine} ${width}; initial workspace ${loadMilliseconds}ms`);
                } catch (error) {
                    reports.push({ engine, width, passed: false, error: error.stack, errors, failedResponses, api, networkFailures, telemetry,
                        mode: settledTelemetry ? 'settled-telemetry' : 'immediate-navigation' });
                    await page.screenshot({ path: join(output, `${engine}-${width}-failure.png`), fullPage: true });
                    console.error(`FAIL ${engine} ${width}: ${error.message}`);
                } finally { await page.close(); }
            }
        } finally { await browser.close(); }
    }
} finally { await preview?.close(); }
await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
if (reports.some(report => !report.passed)) process.exitCode = 1;
