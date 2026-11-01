import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const after = process.argv.includes('--after');
const run = process.argv.find(value => value.startsWith('--run='))?.slice(6);
assert.match(run ?? '', /^[a-z0-9-]+$/);
const output = `artifacts/review-20261008/profile-read-${run}`;
await mkdir(output);
const baseline = !after ? 'D:/BenchPoll-artifacts/review-20261008/profile-read-production-before' : null;
const paths = ['public/js/shared/http.js', 'public/js/workspace/comparison-profiles.js', 'public/js/home-workspace.js'];
const sources = [];
for (const path of paths) sources.push({ path, sha256: createHash('sha256').update(await readFile(baseline ? join(baseline, path) : path)).digest('hex') });
const results = [];
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const saved = { mode: 'matched', keys: ['model'], filters: [] };
for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch({ headless: true, env });
    try {
        for (let repetition = 1; repetition <= 2; repetition++) {
            for (const scenario of ['fetch', 'body', 'http-error']) {
                const app = await startPreview({ authenticated: true, userID: '7' });
                app.state.comparisonLast = structuredClone(saved);
                const page = await browser.newPage({ viewport: { width: repetition === 1 ? 1440 : 390, height: 960 } });
                const result = { engine, repetition, scenario, passed: false, errors: [] };
                results.push(result);
                page.on('pageerror', error => result.errors.push(error.message));
                try {
                    if (baseline) {
                        for (const path of paths) await page.route(url => url.pathname === path.replace(/^public/, ''),
                            route => route.fulfill({ contentType: 'text/javascript', path: join(baseline, path) }));
                    }
                    await page.clock.install();
                    await page.addInitScript(({ scenario, saved }) => {
                        localStorage.setItem('benchpoll-comparison-settings-v1:7', JSON.stringify({ experimental: true,
                            basic: { mode: 'best', keys: ['model'], filters: [] } }));
                        const realFetch = window.fetch.bind(window);
                        let release;
                        window.__profileProbe = { count: 0, signals: [], released: false };
                        window.__releaseProfile = () => {
                            window.__profileProbe.released = true;
                            release?.({ authenticated: true, userID: '7', last: saved, profiles: [] });
                        };
                        window.fetch = (url, options) => {
                            if (new URL(url, location.href).pathname !== '/api/get_comparison_profiles') return realFetch(url, options);
                            const probe = window.__profileProbe;
                            probe.count++;
                            probe.signals.push(options?.signal ?? null);
                            if (probe.count > 1) return realFetch(url, options);
                            if (scenario === 'http-error') return Promise.resolve(new Response(JSON.stringify({ error: 'fixture_profile_failure' }),
                                { status: 503, headers: { 'content-type': 'application/json' } }));
                            const pending = new Promise(resolve => { release = resolve; });
                            // Deliberately ignore abort: a late transport/body must still be unable to apply settings.
                            if (scenario === 'body') return Promise.resolve({ ok: true, status: 200,
                                headers: new Headers({ 'content-type': 'application/json' }), json: () => pending });
                            return pending.then(payload => new Response(JSON.stringify(payload),
                                { status: 200, headers: { 'content-type': 'application/json' } }));
                        };
                    }, { scenario, saved });
                    await page.goto(app.url, { waitUntil: 'domcontentloaded' });
                    await page.waitForFunction(() => window.__profileProbe?.count === 1);
                    await page.clock.runFor(15000);
                    await page.waitForTimeout(100);
                    result.initial = await page.evaluate(() => ({
                        profileCount: window.__profileProbe.count,
                        aborted: Boolean(window.__profileProbe.signals[0]?.aborted),
                        errors: [...document.querySelectorAll('#model-rows .bp-error-state span')].map(node => node.textContent),
                        modelRows: document.querySelectorAll('.bp-model-row').length,
                        currentMode: document.querySelector('#model-comparison-mode')?.dataset.mode
                    }));
                    result.initialWorkspaces = app.state.requests.filter(request => request.path === '/api/get_weighted_workspace').map(request => request.body);
                    if (after) {
                        assert.equal(result.initialWorkspaces.length, 0, 'Do not calculate with silently substituted defaults');
                        assert.equal(result.initial.modelRows, 0);
                        assert.equal(result.initial.errors.length, 1);
                        assert.match(result.initial.errors[0], /comparison settings/i);
                        if (scenario !== 'http-error') assert.equal(result.initial.aborted, true);
                        await page.locator('#benchmark-rows .bp-error-state button').click();
                        if (repetition === 2) await page.locator('[data-mobile-panel="models"]').click();
                        await page.locator('.bp-model-row').first().waitFor();
                        await page.locator('#model-card[aria-busy="false"]').waitFor({ state: 'attached' });
                        const requests = app.state.requests.filter(request => request.path === '/api/get_weighted_workspace');
                        assert.equal(requests.length, 1);
                        assert.deepEqual(requests[0].body.comparison, saved);
                        await page.evaluate(() => window.__releaseProfile());
                        await page.waitForTimeout(100);
                        assert.equal(app.state.requests.filter(request => request.path === '/api/get_weighted_workspace').length, 1);
                        assert.equal(await page.locator('#model-comparison-mode').getAttribute('data-mode'), 'matched');
                        assert.equal(await page.locator('#model-rows .bp-error-state').count(), 0);
                        assert.equal(app.state.requests.some(request => /save_comparison_profile|save_personal_pie/.test(request.path)), false);
                    } else if (scenario === 'http-error') {
                        assert.equal(result.initialWorkspaces.length, 1);
                        assert.equal(result.initialWorkspaces[0].comparison.mode, 'best');
                        result.failure = 'Saved matched comparison silently replaced by default best comparison';
                    } else {
                        assert.equal(result.initialWorkspaces.length, 0);
                        assert.deepEqual(result.initial.errors, []);
                        assert.equal(result.initial.aborted, false);
                        result.failure = 'No ranking request, recovery state or cancellation after 15 seconds of controlled time';
                    }
                    assert.deepEqual(result.errors, []);
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                    await page.screenshot({ path: `${output}/${engine}-${repetition}-${scenario}.png`, fullPage: true });
                    result.passed = true;
                } catch (error) { result.error = error.stack; }
                finally { await page.close(); await app.close(); }
                await writeFile(`${output}/results.json`, JSON.stringify({ after, sources,
                    scope: 'Current full browser entry with local synthetic API/storage. Profile fetch/body deliberately held or rejected; 15 seconds virtual clock. No production, database, real accounts or writes.', results }, null, 2));
                console.log(JSON.stringify({ engine, repetition, scenario, passed: result.passed, failure: result.failure, error: result.error }));
            }
        }
    } finally { await browser.close(); }
}
if (results.some(result => !result.passed)) process.exitCode = 1;
