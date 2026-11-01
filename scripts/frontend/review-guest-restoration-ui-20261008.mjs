import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const before = process.argv.find(value => value.startsWith('--before='))?.slice(9);
const variant = before ? 'before' : 'after';
const runID = `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`;
const output = resolve(`artifacts/review-20261008/guest-restoration-ui-${variant}-${runID}`);
await mkdir(output, { recursive: true });
const source = await readFile(join(before ?? '.', 'public/js/home-workspace.js'), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const runnerSourceHash = sha(await readFile('scripts/frontend/review-guest-restoration-ui-20261008.mjs'));
const homeSourceHash = sha(source);
await writeFile(join(output, 'home-workspace.js'), source, { flag: 'wx' });
const key = '1:[["budget","standard"]]';
const draft = { entries: [{ conditionID: 1, weightBasisPoints: 5000 }, { conditionID: 2, weightBasisPoints: 5000 }], fallbackRules: [] };
const results = [];
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
async function save() {
    await writeFile(join(output, 'results.json'), JSON.stringify({ variant, completeMatrix: !before && results.length === 24,
        homeSourceHash, runnerSourceHash, results,
        scope: 'Local anonymous fixtures, actual page modules and controls. Range/available alternate by repeat. Timeout tests accelerate only the 60000ms browser request timer to800ms. Before replaces only the frozen installed home module. No production, database or account mutations.' }, null, 2));
}
for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    if (before && engine !== 'chromium') continue;
    const browser = await launcher.launch({ headless: true, env });
    try {
        for (const width of [1440, 390]) {
            if (before && width !== 390) continue;
            for (let repeat = 1; repeat <= 2; repeat++) {
                for (const scenario of ['comparison-error', 'late-preview-error', 'preview-timeout']) {
                    const app = await startPreview({ authenticated: false });
                    const page = await browser.newPage({ viewport: { width, height: 960 }, isMobile: width < 500,
                        hasTouch: width < 500, reducedMotion: 'reduce' });
                    page.setDefaultTimeout(12000);
                    const report = { engine, width, repeat, scenario, scoreMode: repeat === 1 ? 'range' : 'available', passed: false, requests: [], errors: [] };
                    results.push(report);
                    const routes = [];
                    let inject = scenario === 'comparison-error', holdNext = false, held = null;
                    page.on('pageerror', error => report.errors.push(error.message));
                    page.on('request', request => {
                        const path = new URL(request.url()).pathname;
                        if (path.startsWith('/api/')) report.requests.push({ path, body: request.postDataJSON() });
                    });
                    await page.addInitScript(({ key, draft, scoreMode, scenario }) => {
                        if (!sessionStorage.getItem('benchpoll-guest-weights-v2-ordered')) sessionStorage.setItem('benchpoll-guest-weights-v2-ordered', JSON.stringify([[key, draft]]));
                        sessionStorage.setItem('benchpoll-workspace-preferences-v1', JSON.stringify({ mode: 'personal', scoreMode }));
                        if (scenario === 'preview-timeout') {
                            const original = window.setTimeout.bind(window);
                            window.setTimeout = (callback, delay, ...args) => original(callback, delay === 60000 ? 800 : delay, ...args);
                        }
                    }, { key, draft, scenario, scoreMode: report.scoreMode });
                    if (before) await page.route('**/js/home-workspace.js?*', route => route.fulfill({ contentType: 'text/javascript', body: source }));
                    await page.route('**/api/get_weighted_workspace', async route => {
                        const body = route.request().postDataJSON();
                        if (!body?.previewPersonalPie) return route.continue();
                        if (inject) {
                            inject = false;
                            return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'comparison_keys_unavailable' }) });
                        }
                        if (scenario === 'preview-timeout') { routes.push(route); return; }
                        if (holdNext) { holdNext = false; held = route; routes.push(route); return; }
                        return route.continue();
                    });
                    const stored = () => page.evaluate(key => JSON.parse(sessionStorage.getItem('benchpoll-guest-weights-v2-ordered')).find(entry => entry[0] === key)?.[1] ?? null, key);
                    const ready = async () => {
                        await page.locator('#benchmark-card[aria-busy="false"]').waitFor({ state: 'attached' });
                        await page.locator('#guest-draft-notice').waitFor();
                        assert.deepEqual(await stored(), draft);
                    };
                    try {
                        await page.goto(app.url, { waitUntil: 'domcontentloaded' });
                        if (scenario === 'preview-timeout') {
                            await page.locator('#benchmark-rows .bp-error-state').waitFor();
                            assert.deepEqual(await stored(), draft);
                            assert.equal(await page.locator('#benchmark-card').getAttribute('aria-busy'), 'false');
                            assert.equal(routes.length, 3, 'Initial preview and two bounded retries');
                            assert.match(await page.locator('#benchmark-rows').innerText(), /Connection interrupted.*Retry/s);
                        } else {
                            await ready();
                            if (scenario === 'comparison-error') {
                                const previews = report.requests.filter(request => request.body?.previewPersonalPie);
                                assert.equal(previews.length, 2, 'The comparison error is recovered and the draft retried');
                            } else {
                                holdNext = true;
                                await page.locator('#workspace-refresh').click();
                                for (let turn = 0; turn < 100 && !held; turn++) await page.waitForTimeout(10);
                                assert.ok(held, 'The first refresh reaches its deferred preview');
                                const nextPreview = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace')
                                    && response.request().postDataJSON()?.previewPersonalPie && response.status() === 200);
                                await page.locator('#workspace-refresh').click();
                                await nextPreview;
                                await ready();
                                const obsoleteResponse = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace') && response.status() === 400);
                                await held.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'pie_benchmark_condition_not_found', conditionID: 1 }) });
                                await (await obsoleteResponse).finished();
                                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                                assert.deepEqual(await stored(), draft, 'An obsolete failure cannot delete the accepted draft');
                            }
                            await page.reload({ waitUntil: 'domcontentloaded' });
                            await ready();
                        }
                        assert.equal(report.requests.some(request => /save|submit|delete/.test(request.path)), false);
                        assert.deepEqual(report.errors, []);
                        report.passed = true;
                        await page.screenshot({ path: join(output, `${engine}-${width}-${repeat}-${scenario}.png`), fullPage: false });
                        console.log(`PASS ${variant} ${engine} ${width} ${repeat} ${scenario}`);
                    } catch (error) {
                        report.error = error.stack;
                        report.storedDraft = await stored().catch(() => 'unavailable');
                        await page.screenshot({ path: join(output, `${engine}-${width}-${repeat}-${scenario}-failure.png`), fullPage: false });
                        console.error(`FAIL ${variant} ${engine} ${width} ${repeat} ${scenario}: ${error.message}`);
                    } finally {
                        for (const route of routes) await route.abort('aborted').catch(() => {});
                        await page.close();
                        await app.close();
                        await save();
                    }
                }
            }
        }
    } finally { await browser.close(); }
}
await save();
console.log(join(output, 'results.json'));
if (results.some(report => !report.passed)) process.exitCode = 1;
