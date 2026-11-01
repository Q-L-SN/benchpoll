import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { openOverview } from './showcase-interactions.mjs';
import { weightedEntries, familyEntries, models, benchmarks } from './fixtures.mjs';

const output = process.env.CHART_TEST_OUTPUT ?? 'D:/Codex-artifacts/website1/chart-workspace-20261012/browser';
await mkdir(output, { recursive: true });
const builtRoot = process.env.HOME_BUILT_ROOT;
const builtHTML = builtRoot ? await readFile(join(builtRoot, 'home-built.html'), 'utf8') : null;
const ready = page => page.waitForFunction(() => document.querySelector('#model-ranking-status')?.dataset.phase === 'ready');
async function useBuiltPreview(page, url) {
    if (!builtHTML) return;
    await page.route(`${url}/**`, async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (route.request().resourceType() === 'document') {
            await route.fulfill({ body: builtHTML, contentType: 'text/html' });
        } else if (pathname.startsWith('/build/home/')) {
            await route.fulfill({ body: await readFile(join(builtRoot, pathname.slice(1))),
                contentType: pathname.endsWith('.css') ? 'text/css' : 'text/javascript' });
        } else await route.fallback();
    });
}
const results = [];
async function revealCharts(page) {
    await page.evaluate(() => {
        const section = document.getElementById('showcase');
        window.scrollTo({ top: (section.offsetHeight - document.documentElement.clientHeight) * .55, behavior: 'instant' });
    });
    await page.waitForFunction(() => getComputedStyle(document.body).getPropertyValue('--showcase-reveal').trim() === '1'
        && getComputedStyle(document.body).getPropertyValue('--showcase-outro').trim() === '0');
}
for (const [engine, launcher, width] of [['chromium', chromium, 1440], ['chromium', chromium, 900], ['chromium', chromium, 390], ['chromium', chromium, 320], ['webkit', webkit, 390]]) {
    if (process.env.UI_TEST_WIDTH && Number(process.env.UI_TEST_WIDTH) !== width) continue;
    if (process.env.UI_TEST_ENGINE && process.env.UI_TEST_ENGINE !== engine) continue;
    const app = await startPreview({ rankingStress: true, secondaryBenchmark: true, sparseBenchmark: true,
        personalEntries: weightedEntries([{ conditionID: 1, weightBasisPoints: 6000 }, { conditionID: 6, weightBasisPoints: 4000 }]),
        fallbackRules: [{ primaryConditionID: 1, mode: 'ordered', entries: familyEntries([{ conditionID: 2 }]) }] });
    const browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width < 760, hasTouch: width < 760 });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const label = `${engine}-${width}${builtHTML ? '-built' : ''}`;
    let closing = false;
    try {
        if (engine === 'webkit' || builtHTML) await page.route(`${app.url}/**`, async route => {
            const url = new URL(route.request().url());
            if (builtHTML && route.request().resourceType() === 'document') {
                await route.fulfill({ body: builtHTML, contentType: 'text/html' }); return;
            }
            if (builtHTML && url.pathname.startsWith('/build/home/')) {
                await route.fulfill({ body: await readFile(join(builtRoot, url.pathname.slice(1))), contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }); return;
            }
            if (engine !== 'webkit') return route.fallback();
            try {
                const response = await route.fetch({ maxRetries: 2 }); await route.fulfill({ response, body: await response.body() });
            } catch (error) {
                if (!closing && !page.isClosed()) { errors.push(error.message); await route.abort().catch(() => {}); }
            }
        });
        await context.addInitScript(() => {
            if (!localStorage.getItem('benchpoll-workspace-display-v1')) localStorage.setItem('benchpoll-workspace-display-v1', 'standard');
            sessionStorage.setItem('benchpoll-workspace-preferences-v1', JSON.stringify({ mode: 'personal', personalFallbackExpanded: true }));
        });
        await page.goto(app.url); await ready(page); await page.evaluate(() => document.fonts.ready);
        const before = await page.locator('#model-rows [data-model-key]').evaluateAll(rows => rows.map(row => row.dataset.modelKey));
        const originalWeights = structuredClone(app.state.personalEntries);
        const originalFallbacks = structuredClone(app.state.fallbackRules);
        await page.locator('#weight-pie g[role="button"][data-object-id="1"]').click();
        await openOverview(page, width < 760);
        await page.waitForFunction(() => document.querySelector('.bp-workspace').dataset.display === 'charts');
        await revealCharts(page);
        assert.equal(await page.locator('#benchmark-card').isVisible(), false);
        assert.equal(await page.locator('#weight-pie').isVisible(), false);
        assert.equal(await page.locator('.bp-left-workspace').isVisible(), true);
        assert.equal(await page.locator('.bp-right-workspace').isVisible(), true);
        assert.equal(await page.locator('.bp-scoring-switch').isVisible(), false);
        assert.equal(await page.locator('#model-comparison-toggle').isVisible(), false);
        assert.equal(await page.locator('.bp-quick-comparison button:visible').count(), 2);
        assert.equal(await page.locator('#inline-fallback').isVisible(), false);
        assert.equal(await page.locator('#public-pie-summary').isVisible(), false);
        assert.equal(await page.locator('#personal-pie-create').isVisible(), false);
        assert.equal(await page.locator('#workspace-undo').isVisible(), false);
        assert.equal(await page.locator('#pie-adjustment-status').isVisible(), false);
        assert.equal(await page.locator('#weight-bars input, #weight-bars button:not(.bp-weight-bars-more)').count(), 0);
        assert.equal(await page.locator('#chart-benchmark-picker, #chart-add-benchmarks').count(), 0);
        const centered = await page.locator('.bp-column-known:not(.is-empty)').evaluateAll(bars => bars.every(bar => {
            const box = bar.getBoundingClientRect(), label = bar.querySelector('.bp-model-column-value').getBoundingClientRect();
            return Math.abs(box.x + box.width / 2 - label.x - label.width / 2) < 1
                && Math.abs(box.y + box.height / 2 - label.y - label.height / 2) < 1;
        }));
        assert.equal(centered, true);
        assert.deepEqual(await page.locator('.bp-model-column').evaluateAll(rows => rows.map(row => row.dataset.modelKey)), before);
        assert.deepEqual(await page.locator('.bp-weight-bar-row').evaluateAll(rows => rows.map(row => Number(row.dataset.conditionId))), [1, 6]);
        await page.waitForFunction(() => document.querySelector('#model-ranking-status').hidden);
        await page.screenshot({ path: join(output, `${label}-charts.png`) });
        const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
        assert.equal(noOverflow, true, `${label} page overflow`);
        const track = page.locator('.bp-weight-bar-row[data-condition-id="6"] .bp-weight-bar-track');
        const allowedScroll = await track.evaluate(node => {
            const event = new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true });
            node.dispatchEvent(event); node.click();
            node.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
            return !event.defaultPrevented;
        });
        assert.equal(allowedScroll, true);
        await page.waitForTimeout(350);
        assert.deepEqual(app.state.personalEntries, originalWeights);
        assert.deepEqual(app.state.fallbackRules, originalFallbacks);
        assert.equal(app.state.requests.some(request => request.path === '/api/save_personal_pie'
            || request.body.previewPersonalPie), false);
        const scroll = page.locator('.bp-model-chart-scroll');
        const initial = await page.locator('.bp-model-column').count();
        await scroll.evaluate(node => { node.scrollLeft = node.scrollWidth; node.dispatchEvent(new Event('scroll')); });
        await page.waitForFunction(count => document.querySelectorAll('.bp-model-column').length > count, initial);
        await page.locator('.bp-model-column').first().click();
        await page.locator('#model-scores-dialog').waitFor();
        await page.locator('#model-scores-dialog .dialog-close-button').click();
        await page.goto(`${app.url}/Language-models/Reasoning`); await ready(page);
        assert.equal(await page.locator('.bp-workspace').getAttribute('data-display'), 'charts');
        await page.reload(); await ready(page);
        assert.equal(await page.locator('.bp-workspace').getAttribute('data-display'), 'charts');
        await revealCharts(page);
        await page.locator('#pie-mode-public').click(); await ready(page);
        await page.waitForFunction(() => document.querySelector('#pie-mode-public').getAttribute('aria-selected') === 'true');
        assert.equal(await page.locator('#inline-fallback').isVisible(), false);
        assert.equal(await page.locator('#weight-bars input, #weight-bars button:not(.bp-weight-bars-more)').count(), 0);
        await page.screenshot({ path: join(output, `${label}-public.png`) });
        await page.locator('#showcase-enter').click();
        await page.waitForFunction(() => document.querySelector('.bp-workspace').dataset.display === 'standard');
        assert.equal(await page.locator('#benchmark-card').isVisible(), true);
        assert.equal(await page.locator('.bp-model-column').count(), 0);
        assert.equal(await page.locator('#workspace-display-toggle').count(), 0);
        assert.deepEqual(errors, []);
        results.push({ engine, width, noOverflow, persistence: true, readOnly: true, centeredScores: true, pagination: true, sameSamples: true, errors });
    } catch (error) {
        await page.screenshot({ path: join(output, `${label}-failure.png`) }).catch(() => {});
        console.error(JSON.stringify({ label, errors, status: await page.locator('#model-ranking-status').textContent().catch(() => null),
            requests: app.state.requests.slice(-8) }));
        throw error;
    } finally { closing = true; await browser.close(); await app.close(); }
}
if (!process.env.UI_TEST_ENGINE || process.env.UI_TEST_ENGINE === 'chromium') {
    const fields = [
        { ID: 1, name: 'Agent harness', type: 'text', revision: 1, allowEmpty: false, excludeMissing: true, excludeEmpty: false, options: [] },
        { ID: 20, name: 'Reasoning effort', type: 'enum', revision: 1, allowEmpty: false, excludeMissing: true, excludeEmpty: false,
            options: [{ ID: 201, label: 'high', excluded: false }, { ID: 202, label: 'max', excluded: false }] }
    ];
    const comparisonModels = Array.from({ length: 8 }, (_, index) => {
        const model = models[index < 4 ? 0 : 1], effort = index % 2 ? 202 : 201, harness = index % 4 < 2 ? 'Agent X' : 'Agent Y';
        return { ...model, ID: 201 + index, modelName: model.name, vendor: index < 4 ? 'OpenAI' : 'Anthropic',
            condition: { parameters: { 'field:1': harness, 'field:20': effort }, scoreFields: [{ fieldID: 1, value: harness }, { fieldID: 20, value: effort }] },
            results: new Map(benchmarks.map(item => [String(item.conditionID), { normalizedScore: 50 + index * 4 }])) };
    });
    const browser = await chromium.launch({ headless: true });
    try {
        for (const experimental of [false, true]) {
            const advanced = { mode: 'best', keys: ['field:1'], filters: [{ key: 'model', operator: 'eq', value: 301 }] };
            const app = await startPreview({ comparisonModels, comparisonFields: fields, comparisonLast: advanced });
            const context = await browser.newContext({ viewport: { width: 390, height: 900 }, hasTouch: true });
            await context.addInitScript(enabled => {
                localStorage.setItem('benchpoll-workspace-display-v1', 'charts');
                localStorage.setItem('benchpoll-comparison-settings-v1:1', JSON.stringify({ experimental: enabled }));
            }, experimental);
            const page = await context.newPage();
            try {
                await useBuiltPreview(page, app.url);
                await page.goto(app.url); await ready(page);
                assert.equal(await page.locator('.bp-model-column').count(), 2);
                assert.equal(await page.locator('#model-comparison-toggle').isVisible(), false);
                assert.equal(await page.locator('.bp-quick-comparison button:visible').count(), 2);
                assert.equal(await page.locator('.bp-model-column-identity > .bp-vendor-mark').count(), experimental ? 0 : 2);
                const first = app.state.requests.find(request => request.path === '/api/get_weighted_workspace').body.comparison;
                assert.deepEqual(first, experimental ? advanced : { mode: 'best', keys: ['model'], filters: [] });
                await page.locator('[data-quick-comparison="reasoning"]').click();
                await page.waitForFunction(() => document.querySelectorAll('.bp-model-column').length === 4); await ready(page);
                if (!experimental) {
                    await page.locator('[data-quick-comparison="harness"]').click();
                    await page.waitForFunction(() => document.querySelectorAll('.bp-model-column').length === 8); await ready(page);
                }
                assert.equal(await page.locator('.bp-model-column .fa-brain').count(), experimental ? 4 : 8);
                assert.equal(await page.locator('.bp-model-column .fa-puzzle-piece').count(), experimental ? 4 : 8);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                await page.waitForFunction(() => document.querySelector('#model-ranking-status').hidden);
                await page.screenshot({ path: join(output, `chromium-390-${experimental ? 'advanced' : 'basic'}-comparison.png`) });
                results.push({ scenario: experimental ? 'advanced-settings-preserved' : 'basic-buttons', passed: true });
            } finally { await context.close(); await app.close(); }
        }
        for (const [scenario, options] of [
            ['empty-guest', { authenticated: false, publicWeights: [] }],
            ['public-only-guest', { authenticated: false }],
            ['public-only-signed-in', { authenticated: true, personalEntries: [] }]
        ]) {
            const app = await startPreview(options);
            const context = await browser.newContext({ viewport: { width: 320, height: 900 }, hasTouch: true });
            await context.addInitScript(() => {
                localStorage.setItem('benchpoll-workspace-display-v1', 'charts');
                sessionStorage.setItem('benchpoll-workspace-preferences-v1', JSON.stringify({ mode: 'personal' }));
            });
            const page = await context.newPage();
            try {
                await useBuiltPreview(page, app.url);
                await page.goto(app.url); await ready(page);
                await revealCharts(page);
                assert.equal(await page.locator('.bp-mode-switch').isVisible(), false);
                assert.equal(await page.locator('#weight-bars-title').textContent(), 'Public Weights');
                assert.equal(await page.locator('#personal-empty-mode').isVisible(), false);
                assert.equal(await page.locator('#personal-pie-create').isVisible(), false);
                assert.equal(await page.locator('#inline-fallback').isVisible(), false);
                if (options.publicWeights?.length === 0) {
                    assert.equal(await page.locator('.bp-chart-empty').textContent(), 'No public weights for this task yet.');
                } else {
                    await page.locator('.bp-model-column').first().waitFor();
                    assert.deepEqual(await page.locator('.bp-weight-bar-value').allTextContents(),
                        benchmarks.filter(item => item.publicWeight).map(item => `${item.publicWeight}%`));
                    const pages = () => app.state.requests.filter(request => request.path === '/api/get_ranking_page'
                        && request.body.list === 'public').length;
                    const initialPages = pages();
                    assert.ok(initialPages <= 1, 'The Public overview needs only its first page');
                    await page.waitForTimeout(200);
                    assert.equal(pages(), initialPages, 'No more model pages are fetched while the chart is stationary');
                }
                assert.equal(app.state.requests.some(request => request.path === '/api/save_personal_pie'
                    || request.body.previewPersonalPie), false);
                await page.goto(`${app.url}/Language-models/Reasoning`); await ready(page);
                assert.equal(await page.locator('.bp-mode-switch').isVisible(), false);
                assert.equal(await page.locator('#weight-bars-title').textContent(), 'Public Weights');
                await page.screenshot({ path: join(output, `chromium-320-${scenario}.png`) });
                results.push({ scenario, passed: true });
            } finally { await context.close(); await app.close(); }
        }
        const failedApp = await startPreview({ workspaceFailure: 503 });
        const failedContext = await browser.newContext({ viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true });
        await failedContext.addInitScript(() => localStorage.setItem('benchpoll-workspace-display-v1', 'charts'));
        const failedPage = await failedContext.newPage();
        try {
            await useBuiltPreview(failedPage, failedApp.url);
            await failedPage.goto(failedApp.url);
            await revealCharts(failedPage);
            await failedPage.locator('#model-rows .bp-error-state').waitFor();
            assert.equal(await failedPage.locator('.bp-workspace').getAttribute('data-display'), 'charts');
            assert.equal(await failedPage.locator('#weight-bars .bp-chart-empty').textContent(), 'The ranking service is temporarily unavailable');
            assert.equal(await failedPage.locator('#weight-bars input, #weight-bars button').count(), 0);
            await failedPage.locator('#showcase-enter').click();
            await failedPage.waitForFunction(() => document.querySelector('.bp-workspace').dataset.display === 'standard');
            assert.equal(await failedPage.locator('#model-rows .bp-error-state').isVisible(), false);
            await openOverview(failedPage, true);
            await failedPage.waitForFunction(() => document.querySelector('.bp-workspace').dataset.display === 'charts');
            await revealCharts(failedPage);
            assert.equal(await failedPage.locator('#model-rows .bp-error-state').isVisible(), true);
            failedApp.state.workspaceFailure = null;
            await revealCharts(failedPage);
            await failedPage.locator('#model-rows .bp-error-state button').click(); await ready(failedPage);
            assert.ok(await failedPage.locator('.bp-model-column').count() > 0);
            results.push({ scenario: 'failed-load-view-switch-and-retry', passed: true });
        } finally { await failedContext.close(); await failedApp.close(); }
    } finally { await browser.close(); }
}
await writeFile(join(output, `verification${builtHTML ? '-built' : ''}.json`), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
