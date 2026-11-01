import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium, webkit } from 'playwright';
import { observeDocumentTelemetry } from './cloudflare-telemetry.mjs';

const origin = new URL(process.argv.find(value => /^https?:/.test(value)) ?? 'https://benchpoll.com').origin;
const output = resolve(process.env.STARTUP_OUTPUT ?? 'artifacts/review-20261008/startup-timing-before');
const repetitions = Number(process.env.STARTUP_REPETITIONS ?? 2);
assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 5);
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const state = JSON.parse((await readFile('artifacts/review-20261008/review-state.json', 'utf8')).replace(/^\uFEFF/, ''));
const release = process.env.STARTUP_RELEASE ?? state.release;
assert.match(release, /^launch-20261008-\d+$/);
const reports = [];
await mkdir(output, { recursive: true });

for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    if (process.env.STARTUP_ENGINE && process.env.STARTUP_ENGINE !== engine) continue;
    const browser = await launcher.launch({ headless: true, env });
    try {
        for (const width of [1440, 390]) {
            if (process.env.STARTUP_WIDTH && Number(process.env.STARTUP_WIDTH) !== width) continue;
            for (let repetition = 1; repetition <= repetitions; repetition++) {
                const context = await browser.newContext({ viewport: { width, height: 960 },
                    isMobile: width < 500, hasTouch: width < 500,
                    ignoreHTTPSErrors: process.argv.includes('--origin-tunnel') });
                const page = await context.newPage();
                page.setDefaultTimeout(75000);
                await page.addInitScript(() => {
                    const marks = { document: performance.now() };
                    globalThis.__startupReviewMarks = marks;
                    const inspect = () => {
                        if (marks.firstBenchmark === undefined && document.querySelector('.bp-benchmark-row')) {
                            marks.firstBenchmark = performance.now();
                        }
                        if (marks.benchmarksReady === undefined
                            && document.querySelector('#benchmark-card[aria-busy="false"] .bp-benchmark-row')) {
                            marks.benchmarksReady = performance.now();
                        }
                        if (marks.modelsReady === undefined
                            && document.querySelector('#model-card[aria-busy="false"] .bp-model-row')) {
                            marks.modelsReady = performance.now();
                        }
                    };
                    document.addEventListener('DOMContentLoaded', () => {
                        marks.domContentLoaded = performance.now(); inspect();
                        new MutationObserver(inspect).observe(document.body, { childList: true,
                            subtree: true, attributes: true, attributeFilter: ['aria-busy'] });
                    }, { once: true });
                    window.addEventListener('load', () => { marks.load = performance.now(); }, { once: true });
                });
                const requests = new Map(), pending = new Set();
                let current;
                page.on('request', request => {
                    if (!current) return;
                    const url = new URL(request.url());
                    const entry = { path: url.origin === origin ? url.pathname + url.search : request.url(),
                        method: request.method(), type: request.resourceType(), at: performance.now() - current.started,
                        host: url.host, finished: false };
                    if (url.pathname === '/api/get_weighted_workspace') {
                        try {
                            const body = request.postDataJSON();
                            entry.workspaceRequest = { categoryID: body.categoryID, initialMode: body.initialMode,
                                scoreMode: body.scoreMode, preview: Boolean(body.previewPersonalPie) };
                        } catch { entry.bodyUnavailable = true; }
                    }
                    current.requests.push(entry); requests.set(request, entry);
                });
                page.on('requestfinished', request => {
                    const entry = requests.get(request);
                    if (!entry) return;
                    const task = (async () => {
                        entry.finished = true; entry.timing = request.timing();
                        const response = await request.response();
                        entry.status = response?.status();
                        if (response) {
                            const headers = await response.allHeaders();
                            entry.headers = Object.fromEntries(['content-type', 'content-length', 'content-encoding',
                                'cache-control', 'cf-cache-status', 'server-timing'].filter(key => headers[key])
                                .map(key => [key, headers[key]]));
                        }
                        try { entry.sizes = await request.sizes(); } catch { entry.sizesUnavailable = true; }
                    })().catch(error => { entry.observationError = error.message; });
                    pending.add(task); void task.finally(() => pending.delete(task));
                });
                page.on('requestfailed', request => {
                    const entry = requests.get(request);
                    if (entry) { entry.failure = request.failure()?.errorText; entry.timing = request.timing(); }
                });
                page.on('pageerror', error => current?.errors.push({ message: error.message,
                    stack: error.stack, page: page.url() }));
                try {
                    for (const phase of ['fresh', 'reload']) {
                        current = { engine, browserVersion: browser.version(), width, repetition, phase,
                            started: performance.now(), requests: [], errors: [], passed: false };
                        reports.push(current);
                        const telemetry = observeDocumentTelemetry(page, `${origin}/Intelligence`);
                        try {
                            const response = phase === 'fresh'
                                ? await page.goto(origin, { waitUntil: 'domcontentloaded' })
                                : await page.reload({ waitUntil: 'domcontentloaded' });
                            current.domContentLoadedMilliseconds = performance.now() - current.started;
                            assert.equal(response.status(), 200);
                            await page.waitForFunction(() => globalThis.__startupReviewMarks?.benchmarksReady !== undefined);
                            current.benchmarksReadyMilliseconds = performance.now() - current.started;
                            await page.waitForFunction(() => globalThis.__startupReviewMarks?.modelsReady !== undefined);
                            current.modelsReadyMilliseconds = performance.now() - current.started;
                            await page.evaluate(() => document.fonts.ready);
                            current.fontsReadyMilliseconds = performance.now() - current.started;
                            current.document = await page.evaluate(() => ({ marks: globalThis.__startupReviewMarks,
                                navigation: performance.getEntriesByType('navigation').map(entry => entry.toJSON()),
                                paints: performance.getEntriesByType('paint').map(entry => entry.toJSON()),
                                resources: performance.getEntriesByType('resource').map(entry => entry.toJSON()),
                                benchmarkRows: document.querySelectorAll('.bp-benchmark-row').length,
                                modelRows: document.querySelectorAll('.bp-model-row').length }));
                            if (await page.locator('script[src*="cloudflareinsights.com"]').count()) current.telemetry = await telemetry;
                            await Promise.all([...pending]);
                            await page.screenshot({ path: `${output}/${engine}-${width}-${repetition}-${phase}.png`, fullPage: false });
                            current.passed = true;
                        } catch (error) { current.error = error.stack; }
                        finally {
                            current.durationMilliseconds = performance.now() - current.started;
                            await writeFile(`${output}/results.json`, JSON.stringify({ release,
                                origin, scope: 'Sequential fresh guest browser contexts and same-context reloads; no form submissions or authenticated mutations. UI readiness is measured before waiting for telemetry. No cookies or private headers saved.',
                                results: reports }, null, 2));
                            console.log(JSON.stringify({ engine, width, repetition, phase, passed: current.passed,
                                dom: current.domContentLoadedMilliseconds, benchmarks: current.benchmarksReadyMilliseconds,
                                models: current.modelsReadyMilliseconds, error: current.error }));
                        }
                    }
                } finally {
                    await context.close(); await Promise.all([...pending]);
                    await writeFile(`${output}/results.json`, JSON.stringify({ release,
                        origin, scope: 'Sequential fresh guest browser contexts and same-context reloads; no form submissions or authenticated mutations. UI readiness is measured before waiting for telemetry. No cookies or private headers saved.',
                        results: reports }, null, 2));
                }
            }
        }
    } finally { await browser.close(); }
}
if (reports.some(report => !report.passed)) process.exitCode = 1;
