import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';

const output = resolve('artifacts/review-20261008/authenticated-pie-recovery-20261008/live-browser-' + Date.now());
await mkdir(output, { recursive: true });
const results = [], origin = 'https://benchpoll.com';
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '',
    all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
for (const [engine, driver] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await driver.launch({ headless: true, env });
    try {
        for (const width of [1440, 390]) {
            const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width < 760, hasTouch: width < 760 });
            const page = await context.newPage(), result = { engine, width, passed: false, errors: [], failures: [], rejectedWrites: [], apiPaths: [] };
            results.push(result); page.setDefaultTimeout(75000);
            assert.deepEqual(await context.cookies(), []);
            page.on('pageerror', error => result.errors.push(error.message));
            page.on('response', response => {
                const url = new URL(response.url());
                if (url.origin === origin && response.status() >= 400) result.failures.push({ path: url.pathname, status: response.status() });
                if (url.origin === origin && url.pathname === '/api/get_user_profile') result.profileStatus = response.status();
            });
            await page.route(origin + '/api/**', async route => {
                const request = route.request(), path = new URL(request.url()).pathname;
                result.apiPaths.push(path);
                if (!['GET', 'HEAD'].includes(request.method()) && !path.startsWith('/api/get_')) {
                    result.rejectedWrites.push(path); return route.abort();
                }
                return route.continue();
            });
            try {
                const started = performance.now();
                const received = page.waitForResponse(response => new URL(response.url()).pathname === '/api/get_weighted_workspace'
                    && response.request().method() === 'POST').then(response => ({ response }), error => ({ error }));
                const document = await page.goto(origin + '/Intelligence', { waitUntil: 'domcontentloaded' }); assert.equal(document.status(), 200);
                result.documentMs = Math.round(performance.now() - started);
                const settled = await received; if (settled.error) throw settled.error;
                const response = settled.response; assert.equal(response.status(), 200);
                await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
                await page.locator('#model-card[aria-busy="false"]').waitFor({ state: 'attached' });
                if (width < 760) {
                    await page.screenshot({ path: join(output, `${engine}-${width}-benchmarks.png`), fullPage: true });
                    await page.getByRole('button', { name: 'Model ranking', exact: true }).click();
                }
                await page.locator('#model-card[aria-busy="false"]').waitFor();
                result.readyMs = Math.round(performance.now() - started);
                result.benchmarkRows = await page.locator('.bp-benchmark-row').count(); result.modelRows = await page.locator('.bp-model-row').count();
                assert.ok(result.benchmarkRows > 0 && result.modelRows > 0, 'Production rows must actually render');
                assert.equal(result.profileStatus, 204, 'The real browser must remain anonymous');
                const accountUI = await page.evaluate(() => ({ loginShown: !document.getElementById('login-button').hidden,
                    profileHidden: document.getElementById('user-profile').hidden }));
                assert.deepEqual(accountUI, { loginShown: true, profileHidden: true });
                result.horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
                result.slowestResources = await page.evaluate(() => performance.getEntriesByType('resource').sort((a, b) => b.duration - a.duration)
                    .slice(0, 10).map(entry => ({ path: new URL(entry.name).pathname, type: entry.initiatorType,
                        startMs: Math.round(entry.startTime), durationMs: Math.round(entry.duration) })));
                assert.equal(result.horizontalOverflow, false);
                assert.deepEqual(result.errors, []); assert.deepEqual(result.failures, []); assert.deepEqual(result.rejectedWrites, []);
                await page.screenshot({ path: join(output, `${engine}-${width}.png`), fullPage: true });
                result.passed = true;
            } catch (error) {
                result.error = error.stack;
                await page.screenshot({ path: join(output, `${engine}-${width}-failure.png`), fullPage: true }).catch(() => {});
            } finally {
                await context.close(); console.log(JSON.stringify(result));
                await writeFile(join(output, 'progress.json'), JSON.stringify({ results }, null, 2));
            }
        }
    } finally { await browser.close(); }
}
await writeFile(join(output, 'report.json'), JSON.stringify({ passed: results.every(result => result.passed), results,
    scope: 'Four fresh headless contexts using the real production document, assets and read-only APIs; profile status 204, anonymous account UI, workspace status 200 and rendered rows checked. Payload schemas are independently checked by the public API verifier, not by CDP response-body retrieval here. No authenticated session, form submission, personal-weight save or physical-device claim.' }, null, 2), { flag: 'wx' });
console.log(join(output, 'report.json')); assert.ok(results.every(result => result.passed));
