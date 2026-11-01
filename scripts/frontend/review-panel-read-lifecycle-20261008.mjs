import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const phase = process.argv.find(value => value.startsWith('--phase='))?.slice(8);
const panelSource = process.argv.find(value => value.startsWith('--panel-source='))?.slice(15);
assert.ok(['before', 'after'].includes(phase), 'An explicit before/after phase is required');
const output = resolve(`artifacts/review-20261008/panel-reads-${phase}-${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`);
await mkdir(output, { recursive: false });
const sources = new Map();
async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name).replaceAll('\\', '/');
        if (entry.isDirectory()) await collect(path);
        else if (/\.(js|css)$/.test(path)) sources.set(path, await readFile(path));
    }
}
await collect('public/js');
await collect('public/css');
for (const path of ['private/home.html', 'scripts/frontend/server.mjs', 'scripts/frontend/fixtures.mjs',
    'scripts/frontend/discussions.mjs', 'scripts/frontend/review-panel-read-lifecycle-20261008.mjs',
    'server.js', 'benchmark-details.js', 'benchmark-scores.js']) sources.set(path, await readFile(path));
if (panelSource) for (const path of ['public/js/discussion.js', 'public/js/workspace/benchmark-scores.js']) {
    sources.set(path, await readFile(resolve(panelSource, path)));
}
const sha = data => createHash('sha256').update(data).digest('hex');
const hashes = {};
for (const [path, data] of sources) {
    hashes[path] = sha(data);
    const destination = join(output, 'sources', path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, data, { flag: 'wx' });
}
const results = [];
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch({ headless: true, env });
    try {
        for (const width of [1440, 390]) for (const repeat of [1, 2]) {
            for (const scenario of ['information-timeout', 'discussion-timeout', 'scores-timeout', 'scores-close']) {
                const app = await startPreview({ authenticated: false });
                const context = await browser.newContext({ viewport: { width, height: 960 },
                    isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce' });
                const page = await context.newPage();
                page.setDefaultTimeout(7000);
                const held = [];
                const report = { engine, width, repeat, scenario, phase, pageErrors: [], requests: [], passed: false };
                page.on('pageerror', error => report.pageErrors.push(error.message));
                page.on('request', request => { if (request.url().includes('/api/')) report.requests.push(new URL(request.url()).pathname); });
                await context.addInitScript(() => {
                    const original = window.setTimeout;
                    window.__panelReadDeadlines = 0;
                    window.setTimeout = (callback, delay, ...args) => {
                        if (delay === 60000) window.__panelReadDeadlines++;
                        return original(callback, delay === 60000 ? 450 : delay, ...args);
                    };
                });
                let delayFirst = true;
                const endpoint = scenario.startsWith('information') ? '/api/get_benchmark_information'
                    : scenario.startsWith('discussion') ? '/api/get_discussion' : '/api/get_benchmark_scores';
                await context.route('**/*', async route => {
                    const url = new URL(route.request().url());
                    if (url.origin !== app.url) return route.abort('blockedbyclient');
                    if (url.pathname === endpoint && delayFirst) {
                        delayFirst = false;
                        held.push(route);
                        return;
                    }
                    const path = url.pathname === '/' ? 'private/home.html' : 'public' + url.pathname;
                    if (sources.has(path)) return route.fulfill({ body: sources.get(path),
                        contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' });
                    return route.continue();
                });
                try {
                    await page.goto(app.url, { waitUntil: 'domcontentloaded' });
                    await page.locator('.bp-model-row').first().waitFor({ state: 'attached' });
                    if (scenario.startsWith('discussion')) await page.locator('#discussion-entry').click();
                    else await page.locator('.bp-benchmark-row:not(.is-family)[data-condition-id="1"] .bp-benchmark-information-link').click();
                    if (scenario.startsWith('scores')) {
                        await page.locator('#benchmark-scores-open').click();
                        await page.waitForFunction(() => document.querySelector('#benchmark-scores-list').getAttribute('aria-busy') === 'true');
                        if (scenario === 'scores-close') await page.locator('#benchmark-scores-back').click();
                    }
                    await page.waitForTimeout(1000);
                    report.observed = await page.evaluate(() => ({
                        informationBusy: document.querySelector('#benchmark-information').getAttribute('aria-busy'),
                        informationStatus: document.querySelector('#benchmark-information-status').textContent,
                        discussionBusy: document.querySelector('#discussion-feed').getAttribute('aria-busy'),
                        discussionError: document.querySelector('#discussion-error').textContent,
                        scoresBusy: document.querySelector('#benchmark-scores-list').getAttribute('aria-busy'),
                        scoresStatus: document.querySelector('#benchmark-scores-status').textContent,
                        retryVisible: !document.querySelector('#benchmark-scores-retry').hidden,
                        scoresHidden: document.querySelector('#benchmark-scores-view').hidden,
                        deadlineTimers: window.__panelReadDeadlines
                    }));
                    assert.equal(held.length, 1, 'A real panel read is held');
                    const state = report.observed;
                    report.ruleSatisfied = scenario === 'information-timeout'
                        ? state.informationBusy === 'false' && /Could not load/.test(state.informationStatus)
                        : scenario === 'discussion-timeout'
                        ? state.discussionBusy === 'false' && /Could not complete/.test(state.discussionError)
                        : scenario === 'scores-timeout'
                        ? state.scoresBusy === 'false' && state.retryVisible && /Could not load/.test(state.scoresStatus)
                        : state.scoresHidden && state.scoresBusy === 'false';
                    assert.equal(report.ruleSatisfied, phase === 'after', 'Before records the missing lifecycle guarantee; after must satisfy it');
                    if (phase === 'after') {
                        if (scenario.startsWith('scores')) {
                            if (scenario === 'scores-close') await page.locator('#benchmark-scores-open').click();
                            else await page.locator('#benchmark-scores-retry').click();
                            await page.locator('.benchmark-score-row').first().waitFor();
                            assert.equal(await page.locator('#benchmark-scores-list').getAttribute('aria-busy'), 'false');
                        } else {
                            await page.locator('#discussion-close').click();
                            if (scenario.startsWith('discussion')) {
                                await page.locator('#discussion-entry').click();
                                await page.locator('.discussion-post').first().waitFor();
                            } else {
                                await page.locator('.bp-benchmark-row:not(.is-family)[data-condition-id="1"] .bp-benchmark-information-link').click();
                                await page.locator('#benchmark-scores-open').waitFor();
                            }
                        }
                        const beforeOld = await page.locator('#discussion-panel').innerText();
                        await held[0].fulfill({ status: 500, contentType: 'application/json', body: '{"error":"obsolete_fixture_read"}' }).catch(() => {});
                        await page.waitForTimeout(60);
                        assert.equal(await page.locator('#discussion-panel').innerText(), beforeOld, 'An obsolete failure cannot replace recovered content');
                    }
                    assert.deepEqual(report.pageErrors, []);
                    assert.equal(app.state.requests.some(request => /save|submit|delete|create|vote/.test(request.path)), false);
                    report.passed = true;
                    await page.screenshot({ path: join(output, `${engine}-${width}-${repeat}-${scenario}.png`), fullPage: false });
                    console.log(`PASS ${phase} ${engine} ${width} ${repeat} ${scenario}`);
                } catch (error) {
                    report.error = error.stack;
                    await page.screenshot({ path: join(output, `${engine}-${width}-${repeat}-${scenario}-failure.png`), fullPage: false }).catch(() => {});
                    console.error(`FAIL ${phase} ${engine} ${width} ${repeat} ${scenario}: ${error.message}`);
                } finally {
                    for (const route of held) await route.abort('aborted').catch(() => {});
                    await context.close();
                    await app.close();
                    results.push(report);
                }
            }
        }
    } finally { await browser.close(); }
}
const sourceDrift = [];
for (const [path, hash] of Object.entries(hashes)) {
    const original = panelSource && ['public/js/discussion.js', 'public/js/workspace/benchmark-scores.js'].includes(path)
        ? resolve(panelSource, path) : path;
    if (sha(await readFile(original)) !== hash) sourceDrift.push(path);
}
await writeFile(join(output, 'results.json'), JSON.stringify({ phase, panelSource: panelSource ?? null, hashes, sourceDrift, results,
    scope: 'Frozen local frontend with anonymous fixtures and actual panel controls. Only actual 60s timers accelerated to450ms. No production or account writes. Before passes mean reproduced violations, not a correct application.' }, null, 2), { flag: 'wx' });
console.log(join(output, 'results.json'));
if (results.some(result => !result.passed) || sourceDrift.length) process.exitCode = 1;
