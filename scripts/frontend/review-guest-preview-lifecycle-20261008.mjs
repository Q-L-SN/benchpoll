import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const phase = process.argv.find(arg => arg.startsWith('--phase='))?.slice(8);
const sourceRoot = resolve(process.argv.find(arg => arg.startsWith('--source='))?.slice(9) ?? '.');
const scenario = process.argv.find(arg => arg.startsWith('--scenario='))?.slice(11) ?? 'timeout';
assert.ok(['before', 'after'].includes(phase));
assert.ok(['timeout', 'interrupted'].includes(scenario));
for (const path of ['public/js/home-workspace.js', 'public/js/workspace/model-list.js']) {
    await readFile(join(sourceRoot, path));
}
const output = resolve(`artifacts/review-20261008/guest-preview-browser-${phase}-${Date.now()}`);
await mkdir(output, { recursive: false });
const sources = new Map(), paths = new Map();
async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name).replaceAll('\\', '/');
        if (entry.isDirectory()) await collect(path);
        else if (/\.(css|js)$/.test(path)) {
            sources.set(path, await readFile(path)); paths.set(path, path);
        }
    }
}
await collect('public/js'); await collect('public/css');
for (const path of ['private/home.html', 'scripts/frontend/server.mjs', 'scripts/frontend/fixtures.mjs',
    'scripts/frontend/review-guest-preview-lifecycle-20261008.mjs']) {
    sources.set(path, await readFile(path)); paths.set(path, path);
}
for (const path of sources.keys()) {
    if (!path.startsWith('public/') && path !== 'private/home.html') continue;
    const candidate = join(sourceRoot, path);
    try { sources.set(path, await readFile(candidate)); paths.set(path, candidate); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hashes = {};
for (const [path, bytes] of sources) {
    hashes[path] = hash(bytes);
    const destination = join(output, 'sources', path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: 'wx' });
}
const results = [];
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch({ headless: true, env });
    try {
        for (const width of [1440, 390]) for (const repeat of [1, 2]) {
            const app = await startPreview({ authenticated: false });
            const context = await browser.newContext({ viewport: { width, height: 950 },
                isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce' });
            const page = await context.newPage(); page.setDefaultTimeout(7000);
            const held = [], report = { engine, width, repeat, phase, scenario, passed: false, pageErrors: [], previewBodies: [] };
            page.on('pageerror', error => report.pageErrors.push(error.message));
            await context.addInitScript(() => {
                const original = window.setTimeout;
                window.__workspaceDeadlines = [];
                window.setTimeout = (callback, delay, ...args) => {
                    if (delay === 60000) window.__workspaceDeadlines.push({ at: performance.now(), milliseconds: delay });
                    return original(callback, delay === 60000 ? 1500 : delay, ...args);
                };
            });
            let holdFirst = true;
            await context.route('**/*', async route => {
                const url = new URL(route.request().url());
                if (url.origin !== app.url) return route.abort('blockedbyclient');
                if (url.pathname === '/api/get_weighted_workspace') {
                    const body = route.request().postDataJSON();
                    if (body.previewPersonalPie) {
                        report.previewBodies.push(body.previewPersonalPie);
                        if (holdFirst) { holdFirst = false; held.push(route); return; }
                    }
                }
                const path = url.pathname === '/' ? 'private/home.html' : 'public' + url.pathname;
                if (sources.has(path)) return route.fulfill({ body: sources.get(path),
                    contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' });
                return route.continue();
            });
            try {
                await page.goto(app.url, { waitUntil: 'domcontentloaded' });
                await page.locator('.bp-model-row').first().waitFor({ state: 'attached' });
                await page.locator('#personal-pie-create').click();
                await page.locator('.bp-benchmark-row:not(.is-family) .bp-benchmark-add').first().click();
                await page.waitForFunction(() => document.querySelector('#guest-draft-save').disabled);
                if (scenario === 'interrupted') {
                    assert.equal(held.length, 1);
                    await held[0].abort('failed');
                }
                await page.waitForTimeout(scenario === 'timeout' ? 2300 : 150);
                assert.equal(held.length, 1, 'The actual edited guest preview must be held.');
                report.observed = await page.evaluate(() => ({
                    saveDisabled: document.querySelector('#guest-draft-save').disabled,
                    lastUpdated: document.querySelector('#last-updated').textContent,
                    rows: document.querySelector('#model-rows').textContent,
                    draft: JSON.parse(sessionStorage.getItem('benchpoll-guest-weights-v2-ordered')),
                    deadlineTimers: window.__workspaceDeadlines
                }));
                report.ruleSatisfied = !report.observed.saveDisabled
                    && /Could not calculate this temporary ranking/.test(report.observed.lastUpdated)
                    && (scenario !== 'interrupted' || /Could not calculate this temporary ranking/.test(report.observed.rows));
                assert.equal(report.ruleSatisfied, phase === 'after');
                assert.equal(report.observed.draft[0][1].entries.length, 1);
                assert.equal(report.observed.draft[0][1].entries[0].weightBasisPoints, 10000);
                await page.screenshot({ path: join(output, `${engine}-${width}-${repeat}-timeout.png`) });
                if (phase === 'after') {
                    await page.locator('#workspace-refresh').click();
                    await page.locator('.bp-model-row').first().waitFor({ state: 'attached' });
                    assert.ok(report.previewBodies.length >= 2, 'Explicit refresh recalculates the retained draft.');
                    const currentRows = await page.locator('#model-rows').innerText();
                    await held[0].fulfill({ status: 500, contentType: 'application/json',
                        body: '{"error":"abandoned_guest_preview"}' }).catch(() => {});
                    await page.waitForTimeout(80);
                    assert.equal(await page.locator('#model-rows').innerText(), currentRows);
                    assert.equal(await page.locator('#guest-draft-save').isEnabled(), true);
                    await page.screenshot({ path: join(output, `${engine}-${width}-${repeat}-recovered.png`) });
                }
                assert.deepEqual(report.pageErrors, []);
                assert.equal(app.state.requests.some(request => /save|submit|delete|create|vote/.test(request.path)), false,
                    'Anonymous preview must not submit any account or data mutation.');
                report.passed = true; console.log(`PASS ${phase} ${engine} ${width} ${repeat}`);
            } catch (error) {
                report.error = error.stack;
                await page.screenshot({ path: join(output, `${engine}-${width}-${repeat}-failure.png`) }).catch(() => {});
                console.error(`FAIL ${phase} ${engine} ${width} ${repeat}: ${error.message}`);
            } finally {
                for (const route of held) await route.abort('aborted').catch(() => {});
                await context.close(); await app.close(); results.push(report);
            }
        }
    } finally { await browser.close(); }
}
const sourceDrift = [];
for (const [path, expected] of Object.entries(hashes)) {
    if (hash(await readFile(paths.get(path))) !== expected) sourceDrift.push(path);
}
await writeFile(join(output, 'results.json'), JSON.stringify({ phase, sourceRoot, hashes, sourceDrift, results,
    scope: 'Actual frozen frontend controls and draft storage, anonymous synthetic HTTP fixtures, desktop/mobile Chromium and WebKit. Captured runtime assets override local assets when supplied. Only 60s timers accelerated to 1500ms. Before success means the defect was reproduced. No production, login or database mutation.' }, null, 2), { flag: 'wx' });
console.log(join(output, 'results.json'));
if (results.some(result => !result.passed) || sourceDrift.length) process.exitCode = 1;
