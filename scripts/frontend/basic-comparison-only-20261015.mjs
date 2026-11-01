import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { benchmarks, models } from './fixtures.mjs';

const output = process.env.BASIC_COMPARISON_OUTPUT ?? 'D:/Codex-artifacts/website1/basic-comparison-only-20261015/source';
const builtRoot = process.env.HOME_BUILT_ROOT;
const html = builtRoot ? await readFile(join(builtRoot, 'home-built.html'), 'utf8') : null;
const liveURL = process.argv.find(value => /^https?:\/\//.test(value));
const fields = [{ ID: 1, name: 'Harness', type: 'text', options: [] },
    { ID: 20, name: 'Effort', type: 'enum', options: [{ ID: 201, label: 'High' }, { ID: 202, label: 'Max' }] }];
const comparisonModels = Array.from({ length: 9 }, (_, index) => {
    const model = models[index < 4 ? 0 : 1];
    const parameters = index === 8 ? [] : [{ fieldID: 1, value: index % 4 < 2 ? 'Agent X' : 'Agent Y' }, { fieldID: 20, value: index % 2 ? 202 : 201 }];
    return { ...model, ID: 201 + index, modelName: model.name, vendor: model.vendorName,
        condition: { parameters: Object.fromEntries(parameters.map(parameter => [`field:${parameter.fieldID}`, parameter.value])), scoreFields: parameters },
        results: new Map(benchmarks.map(item => [String(item.conditionID), { normalizedScore: 45 + index * 4 }])) };
});
const advanced = { mode: 'matched', keys: ['field:1'], filters: [{ key: 'model', operator: 'eq', value: 301 }] };
const reports = [];
await mkdir(output, { recursive: true });
for (const [engine, launcher, width] of [['chromium', chromium, 1440], ['chromium', chromium, 390], ['chromium', chromium, 320], ['webkit', webkit, 390]]) {
    const app = await startPreview({ comparisonModels, comparisonFields: fields, comparisonLast: advanced,
        comparisonProfiles: [{ name: 'Old advanced setup', comparison: advanced }] });
    const browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce' });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    const errors = [], scripts = [], label = `${engine}-${width}`;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.resourceType() === 'script') scripts.push(request.url()); });
    if (liveURL) await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        await route.fulfill({ response: await route.fetch({ url: app.url + url.pathname + url.search }) });
    });
    if (html || engine === 'webkit' && !liveURL) await page.route(`${app.url}/**`, async route => {
        const path = new URL(route.request().url()).pathname;
        if (html && route.request().resourceType() === 'document') return route.fulfill({ body: html, contentType: 'text/html' });
        if (html && path.startsWith('/build/home/')) return route.fulfill({ body: await readFile(join(builtRoot, path.slice(1))), contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript' });
        if (engine === 'webkit') { const response = await route.fetch(); return route.fulfill({ response, body: await response.body() }); }
        return route.fallback();
    });
    await context.addInitScript(() => {
        localStorage.setItem('benchpoll-workspace-display-v1', 'standard');
        for (const user of ['1', 'guest']) if (!localStorage.getItem(`benchpoll-comparison-settings-v1:${user}`))
            localStorage.setItem(`benchpoll-comparison-settings-v1:${user}`, JSON.stringify({ experimental: true, basic: { mode: 'best', keys: ['model'], filters: [] } }));
        if (!localStorage.getItem('benchpoll-comparison-profiles-v2:1')) localStorage.setItem('benchpoll-comparison-profiles-v2:1', JSON.stringify({ last: { mode: 'matched', keys: ['field:1'], filters: [{ key: 'model', operator: 'eq', value: 301 }] }, profiles: [] }));
    });
    async function ready(count) {
        await page.waitForFunction(count => document.querySelector('#model-ranking-status')?.dataset.phase === 'ready'
            && document.querySelectorAll('.bp-model-row').length === count, count);
    }
    try {
        await page.goto(liveURL ?? app.url); await ready(2);
        if (width < 760) await page.locator('[data-mobile-panel="models"]').click();
        assert.equal(await page.locator('#model-comparison-toggle,#model-comparison-panel,#experimental-comparison,.bp-profile-menu').count(), 0);
        assert.deepEqual(app.state.requests.find(request => request.path === '/api/get_weighted_workspace').body.comparison, { mode: 'best', keys: ['model'], filters: [] });
        await page.locator('[data-quick-comparison="reasoning"]').click(); await ready(5);
        await page.locator('[data-quick-comparison="harness"]').click(); await ready(9);
        const last = app.state.requests.filter(request => request.path === '/api/get_weighted_workspace').at(-1).body.comparison;
        assert.deepEqual(last, { mode: 'best', keys: ['model', 'field:20', 'field:1'], filters: [] });
        assert.ok(await page.locator('.bp-model-row').filter({ hasText: /not recorded|unknown/i }).count(), 'Missing settings remain represented');
        assert.equal(await page.locator('.bp-model-row .bp-vendor-mark').count(), 9);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await page.screenshot({ path: join(output, `${label}.png`) });
        await page.reload(); await ready(9);
        assert.equal(await page.locator('[data-quick-comparison="reasoning"]').getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('[data-quick-comparison="harness"]').getAttribute('aria-pressed'), 'true');
        assert.equal(app.state.requests.some(request => /comparison_profile/.test(request.path)), false);
        assert.equal(scripts.some(path => /\/comparison-(?:controls|profiles|profile-menu)\.js/.test(path)), false);
        assert.deepEqual(app.state.comparisonLast, advanced);
        assert.deepEqual(errors, []);
        reports.push({ label, bestPerformance: true, modelRequired: true, unknownSettingsIncluded: true, noAdvancedRequests: true });
        console.log(JSON.stringify({ label, passed: true }));
    } catch (error) { await page.screenshot({ path: join(output, `${label}-failure.png`) }).catch(() => {}); throw error; }
    finally { await context.close(); await browser.close(); await app.close(); }
}
await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
