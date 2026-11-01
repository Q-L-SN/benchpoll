import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';

const origin = 'https://benchpoll.com';
const output = resolve(process.env.REVIEW_OUTPUT ?? 'artifacts/review-20261008/startup');
await mkdir(output, { recursive: true });
const reports = [];
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch({ headless: true, env });
    try {
        for (const width of [1440, 390]) {
            const page = await browser.newPage({ viewport: { width, height: 960 }, isMobile: width < 500, hasTouch: width < 500 });
            const errors = [];
            const failures = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('response', response => {
                const url = new URL(response.url());
                if (url.origin === origin && response.status() >= 400) failures.push({ path: url.pathname, status: response.status() });
            });
            page.setDefaultTimeout(90000);
            try {
                for (const cache of ['cold', 'warm']) {
                    const started = Date.now();
                    const response = cache === 'cold'
                        ? await page.goto(origin, { waitUntil: 'domcontentloaded' })
                        : await page.reload({ waitUntil: 'domcontentloaded' });
                    assert.equal(response.status(), 200);
                    await page.locator('#benchmark-card[aria-busy="false"]').waitFor({ state: 'attached' });
                    await page.locator('.bp-benchmark-row').first().waitFor();
                    const elapsed = Date.now() - started;
                    const timing = await page.evaluate(() => {
                        const round = value => Math.round(value * 10) / 10;
                        const navigation = performance.getEntriesByType('navigation')[0];
                        const resources = performance.getEntriesByType('resource').filter(entry => new URL(entry.name).origin === location.origin)
                            .map(entry => ({ path: new URL(entry.name).pathname, type: entry.initiatorType,
                                start: round(entry.startTime), duration: round(entry.duration),
                                ttfb: round(entry.responseStart - entry.requestStart), end: round(entry.responseEnd),
                                transferBytes: entry.transferSize, encodedBytes: entry.encodedBodySize }));
                        return { domContentLoaded: round(navigation.domContentLoadedEventEnd),
                            documentResponse: round(navigation.responseEnd), resources };
                    });
                    reports.push({ engine, width, cache, elapsed, ...timing, errors: [...errors], failures: [...failures], passed: true });
                    const apis = timing.resources.filter(resource => resource.path.startsWith('/api/'));
                    const slowest = [...timing.resources].sort((a, b) => b.duration - a.duration).slice(0, 5);
                    console.log(JSON.stringify({ engine, width, cache, elapsed, domContentLoaded: timing.domContentLoaded, apis, slowest }));
                    if (cache === 'warm') await page.screenshot({ path: join(output, `${engine}-${width}.png`), fullPage: true });
                }
                assert.deepEqual(failures, []);
            } catch (error) {
                reports.push({ engine, width, passed: false, error: error.stack, errors, failures });
                console.error(`FAIL ${engine} ${width}: ${error.message}`);
            } finally { await page.close(); }
        }
    } finally { await browser.close(); }
}
await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
if (reports.some(report => !report.passed)) process.exitCode = 1;
