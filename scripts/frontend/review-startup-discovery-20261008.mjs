import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const output = resolve(process.env.STARTUP_DISCOVERY_OUTPUT ?? 'artifacts/review-20261008/startup-discovery');
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const before = await readFile('D:/BenchPoll-artifacts/review-20261008/startup-production-before/private/home.html', 'utf8');
const after = await readFile('private/home.html', 'utf8');
const sha = text => createHash('sha256').update(text).digest('hex');
const results = [];
await mkdir(output, { recursive: true });
const selectors = ['.bp-sidebar', '.bp-workspace', '#workspace-headline', '#pie-card',
    '#weight-pie', '#benchmark-card', '#model-card', '.bp-benchmark-row', '.bp-model-row'];

for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch({ headless: true, env });
    try {
        for (const width of [1440, 390]) {
            const geometry = new Map();
            for (let repetition = 1; repetition <= 2; repetition++) {
                for (const [variant, html] of [['before', before], ['after', after]]) {
                    const app = await startPreview({ authenticated: false });
                    const context = await browser.newContext({ viewport: { width, height: 960 },
                        isMobile: width < 500, hasTouch: width < 500, reducedMotion: 'reduce' });
                    const page = await context.newPage();
                    page.setDefaultTimeout(12000);
                    const errors = [], requests = [], failedResponses = [];
                    const origin = new URL(app.url).origin;
                    page.on('pageerror', error => errors.push(error.message));
                    page.on('request', request => {
                        const url = new URL(request.url());
                        requests.push({ path: url.pathname + url.search, type: request.resourceType(), origin: url.origin });
                    });
                    page.on('response', response => {
                        if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status() });
                    });
                    const report = { engine, width, repetition, variant, htmlHash: sha(html), passed: false };
                    results.push(report);
                    try {
                        await page.route('**/*', async route => {
                            assert.equal(new URL(route.request().url()).origin, origin, 'The fixture must not call an external service');
                            // A fixed request delay isolates discovery order, not real network or production latency.
                            await delay(150);
                            if (route.request().resourceType() === 'document') await route.fulfill({ contentType: 'text/html', body: html });
                            else await route.continue();
                        });
                        const start = performance.now();
                        const response = await page.goto(app.url, { waitUntil: 'domcontentloaded' });
                        assert.equal(response.status(), 200);
                        report.domMs = performance.now() - start;
                        await page.waitForFunction(() => document.querySelector('#benchmark-card[aria-busy="false"] .bp-benchmark-row')
                            && document.querySelector('#model-card[aria-busy="false"] .bp-model-row'));
                        report.readyMs = performance.now() - start;
                        await page.evaluate(() => document.fonts.ready);
                        report.layout = await page.evaluate(selectors => selectors.map(selector => {
                            const element = document.querySelector(selector);
                            if (!element) return { selector, exists: false };
                            const style = getComputedStyle(element), rect = element.getBoundingClientRect();
                            return { selector, exists: true, box: ['x', 'y', 'width', 'height'].map(key => Math.round(rect[key] * 10) / 10),
                                fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight,
                                color: style.color, background: style.backgroundColor, display: style.display };
                        }), selectors);
                        report.overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
                        assert.equal(report.overflow, false);
                        assert.deepEqual(errors, []);
                        assert.deepEqual(failedResponses, []);
                        const scripts = requests.filter(request => request.path.startsWith('/js/'));
                        assert.equal(new Set(scripts.map(request => request.path)).size, scripts.length, 'Preloads must reuse exact module fetches');
                        report.moduleRequests = scripts.length;
                        assert.equal(report.moduleRequests, 69);
                        report.workspaceRequests = requests.filter(request => request.path === '/api/get_weighted_workspace').length;
                        assert.equal(report.workspaceRequests, 1);
                        if (variant === 'before') geometry.set(repetition, report.layout);
                        else assert.deepEqual(report.layout, geometry.get(repetition), 'Changing discovery order must not alter visible geometry or styles');
                        await page.screenshot({ path: `${output}/${engine}-${width}-${repetition}-${variant}.png` });
                        report.passed = true;
                    } catch (error) { report.error = error.stack; }
                    finally {
                        report.errors = errors; report.failedResponses = failedResponses;
                        report.requests = requests.map(({ path, type }) => ({ path, type }));
                        await context.close(); await app.close();
                        await writeFile(`${output}/results.json`, JSON.stringify({ scope: 'Local unauthenticated fixture. Old installed HTML and current HTML share identical current application modules, CSS and data. A fixed 150ms interception delay per request isolates dependency discovery. Not production timing or actual SQL.',
                            results }, null, 2));
                        console.log(JSON.stringify({ engine, width, repetition, variant, passed: report.passed,
                            domMs: report.domMs, readyMs: report.readyMs, modules: report.moduleRequests, error: report.error }));
                    }
                }
            }
        }
    } finally { await browser.close(); }
}
if (results.some(result => !result.passed)) process.exitCode = 1;
