import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';
import { weightedEntries } from './fixtures.mjs';

const output = fileURLToPath(new URL('../../artifacts/frontend/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
async function until(condition, message, timeout = 8000) {
    const end = Date.now() + timeout;
    while (!await condition()) { if (Date.now() > end) throw new Error(message); await delay(30); }
}
async function check(name, action, options = {}) {
    const app = await startPreview(options);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', ...options.browser });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('benchpoll-welcome-seen-v1', '1'));
    try {
        await action({ app, page, context });
        assert.deepEqual(pageErrors, [], 'Uncaught browser errors');
        assert.ok(!page.url().includes('/dialogPage'), 'Unexpected global error redirect');
        results.push({ name, passed: true });
        console.log(`PASS ${name}`);
    } catch (error) {
        results.push({ name, passed: false, error: error.message, pageErrors });
        await page.screenshot({ path: output + name.replaceAll(/[^a-z0-9]+/gi, '-') + '-failure.png', fullPage: true }).catch(() => {});
        console.error(`FAIL ${name}: ${error.message}`);
    } finally { await context.close(); await app.close(); }
}
async function home(page, app) {
    await page.goto(app.url);
    await page.locator('.bp-benchmark-row').first().waitFor();
    await page.locator('.bp-model-row').first().waitFor({ state: 'attached' });
}
const saves = app => app.state.requests.filter(request => request.path === '/api/save_personal_pie');
async function waitSaved(page, app, count) {
    await until(() => saves(app).length >= count && app.state.revision >= count + 1, 'Save was not persisted in fixture');
    await page.waitForFunction(() => !document.querySelector('#workspace-undo').disabled);
}
async function noOverflow(page) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'Page overflows horizontally');
}
async function navigationFixture(page, { emptyPersonalContext = false, personalFallbackRulesByContext } = {}) {
    // The real hierarchy includes a hidden root. Keep it in this fixture so the
    // Reasoning breadcrumb renders a real Language models navigation link.
    await page.route('**/api/get_page**', async route => {
        const response = await route.fetch();
        const data = await response.json();
        data.categoryTree = [{ ID: 99, name: 'All Categories', hasChildren: true, expanded: true, children: data.categoryTree }];
        const path = new URL(route.request().url()).pathname;
        data.currentCategoryID = path.endsWith('/Reasoning') ? 2 : path.endsWith('/Coding') ? 3 : 1;
        await route.fulfill({ response, json: data });
    });
    await page.route('**/api/get_weighted_workspace', async route => {
        const response = await route.fetch();
        const data = await response.json();
        data.context.categoryPath = `All-Categories/${data.context.categoryPath}`;
        if (personalFallbackRulesByContext) {
            const key = `${data.context.categoryID}:${data.context.contextValues.budget}`;
            data.personalPie.fallbackRules = structuredClone(personalFallbackRulesByContext.get(key) ?? []);
        }
        if (emptyPersonalContext && data.context.categoryID === 2 && data.context.contextValues.budget === 'extended') {
            data.personalPie.entries = [];
            data.personalPie.fallbackRules = [];
            data.modelLeaderboards.personal = [];
        }
        await route.fulfill({ response, json: data });
    });
    if (personalFallbackRulesByContext) {
        await page.route('**/api/save_personal_pie', async route => {
            const response = await route.fetch();
            const data = await response.json();
            const key = `${data.context.categoryID}:${data.context.contextValues.budget}`;
            personalFallbackRulesByContext.set(key, structuredClone(data.personalPie.fallbackRules));
            data.context.categoryPath = `All-Categories/${data.context.categoryPath}`;
            await route.fulfill({ response, json: data });
        });
    }
}
async function navigationWorkspace(page, category, template = 'Standard') {
    await page.waitForFunction(({ category, template }) => (
        document.querySelector('#bp-breadcrumb .bp-breadcrumb-current')?.textContent === category
        && document.querySelector('.bp-template-value')?.textContent === template
        && document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false'
    ), { category, template });
}
async function navigationTemplate(page, name) {
    await page.locator('.bp-template-control').click();
    await page.getByRole('option', { name, exact: true }).click();
}
async function parentBreadcrumb(page) {
    const previousDocument = await page.evaluate(() => performance.timeOrigin);
    await Promise.all([
        page.waitForEvent('domcontentloaded'),
        page.locator('#bp-breadcrumb').getByRole('link', { name: 'Language models', exact: true }).click()
    ]);
    await navigationWorkspace(page, 'Language models');
    assert.notEqual(await page.evaluate(() => performance.timeOrigin), previousDocument, 'Breadcrumb did not load a new document');
}
async function pieMode(page, mode) {
    assert.equal(await page.locator(`#pie-mode-${mode}`).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator(`#pie-mode-${mode === 'personal' ? 'public' : 'personal'}`).getAttribute('aria-selected'), 'false');
}

try {
    await check('short ranking URLs preserve context on reload and canonicalize old links', async ({ app, page }) => {
        await page.goto(app.url + '/rankings/Language-models?context_budget=extended');
        await page.waitForURL('**/rankings/Language-models?extended');
        assert.equal(app.state.requests.filter(request => request.path === '/api/get_weighted_workspace').at(-1).body.contextValues.budget, 'extended');
        await page.reload();
        await page.locator('.bp-benchmark-row').first().waitFor();
        assert.equal(new URL(page.url()).search, '?extended');
        await page.locator('.bp-template-control').hover();
        await page.getByRole('option', { name: 'Standard', exact: true }).click();
        await page.waitForURL('**/rankings/Language-models?standard');
        await noOverflow(page);
    });
    await check('contribution handoffs isolate new tabs and survive reload without URL data', async ({ app, page, context }) => {
        await home(page, app);
        const urls = await page.evaluate(async () => {
            const { buildContributionURL } = await import('/js/shared/contribution-navigation.js?v=clean-20260908');
            return ['Alpha benchmark', 'Beta benchmark'].map(benchmarkName => buildContributionURL('new_benchmark', { benchmarkName }));
        });
        const first = await context.newPage();
        const second = await context.newPage();
        await first.goto(app.url + urls[0]);
        await second.goto(app.url + urls[1]);
        for (const [tab, name] of [[first, 'Alpha benchmark'], [second, 'Beta benchmark']]) {
            await tab.locator('[data-evaluation-name]').waitFor();
            assert.equal(await tab.locator('[data-evaluation-name]').inputValue(), name);
            assert.equal(tab.url(), app.url + '/contribute/benchmarks/new');
        }
        await first.reload();
        await first.locator('[data-evaluation-name]').waitFor();
        assert.equal(await first.locator('[data-evaluation-name]').inputValue(), 'Alpha benchmark');
        await first.goto(app.url + '/contribute/benchmarks/new');
        await first.locator('[data-evaluation-name]').waitFor();
        assert.equal(await first.locator('[data-evaluation-name]').inputValue(), '');
        await first.close(); await second.close();
    });
    await check('inline discussion supports references votes replies and reports', async ({ app, page }) => {
        await page.goto(app.url + '/?discussion=1&categoryID=1&context_budget=standard');
        await page.locator('#post-801').waitFor();
        await page.getByRole('button', { name: 'Like post 801: 8', exact: true }).click();
        await page.getByRole('button', { name: 'Like post 801: 9', exact: true }).waitFor();
        await page.locator('#discussion-compose-toggle').click();
        await page.locator('#discussion-text').fill('I would include @General');
        await page.getByRole('option', { name: 'General knowledge', exact: true }).waitFor();
        await page.locator('#discussion-text').press('Tab');
        assert.equal(await page.locator('#composer-mentions button').count(), 1);
        await page.locator('#post-discussion').click();
        await until(() => app.state.requests.some(request => request.path === '/api/create_discussion_post'), 'Message not sent');
        const posted = app.state.requests.find(request => request.path === '/api/create_discussion_post').body;
        assert.deepEqual(posted.mentions, [{ benchmarkID: 101, conditionID: 1 }]);
        await page.locator('#post-802').waitFor();
        await until(async () => (await page.locator('#discussion-entry').textContent()).includes('2 discussions'), 'Discussion count not refreshed');
        assert.equal(await page.locator('#post-802 .discussion-post-body').textContent(), 'I would include @General knowledge ');
        await noOverflow(page);
        await page.screenshot({ path: output + 'discussions-desktop.png', fullPage: true });
        await page.goto(app.url + '/?discussion=1&categoryID=1&threadID=801&context_budget=standard');
        await page.locator('#thread-root #post-801').waitFor();
        await page.locator('#discussion-text').fill('A practical benchmark makes this comparison more useful.');
        await page.locator('#post-discussion').click();
        await page.locator('#post-803').waitFor();
        assert.equal(app.state.requests.filter(request => request.path === '/api/create_discussion_post').at(-1).body.parentID, 801);
        await page.locator('#post-803 .discussion-report').click();
        await page.locator('[data-bind="report"][data-field="postID"]').waitFor();
        assert.equal(await page.locator('[data-field="postID"]').inputValue(), '803');
        await page.locator('[data-bind="report"][data-field="details"]').fill('This message contains misleading information. Please review it.');
        await page.locator('#submit-contribution').click();
        await until(() => app.state.requests.some(request => request.path === '/api/submit_contribution'), 'Report not submitted');
        const report = app.state.requests.find(request => request.path === '/api/submit_contribution').body;
        assert.equal(report.type, 'discussion_report'); assert.equal(report.postID, 803);
    });
    await check('mobile discussion navigation and guest state', async ({ app, page }) => {
        await page.goto(app.url + '/?discussion=1&categoryID=1&benchmarkID=101&context_budget=standard');
        await page.locator('#post-801').waitFor();
        assert.equal(await page.locator('#post-discussion').textContent(), 'Log in to participate');
        await noOverflow(page);
        assert.equal(await page.locator('.bp-workspace').evaluate(element => element.inert), true);
        assert.equal(await page.locator('#discussion-brand-slot .bp-brand').isVisible(), true);
        assert.equal(await page.locator('#discussion-compose-fields').isVisible(), false);
        assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), 'Hidden workspace remains scrollable');
        await page.locator('#discussion-close').click();
        assert.equal(await page.locator('.bp-workspace').evaluate(element => element.inert), false);
        assert.equal(await page.locator('.bp-sidebar > .bp-brand').isVisible(), true);
        await page.locator('#discussion-entry').click();
        await page.locator('#post-801').waitFor();
        await page.screenshot({ path: output + 'discussions-mobile.png', fullPage: true });
    }, { authenticated: false, browser: { viewport: { width: 390, height: 844 } } });
    await check('homepage discussion entry preserves category and benchmark identity', async ({ app, page }) => {
        await home(page, app);
        await until(() => app.state.requests.some(request => request.path === '/api/get_discussion_summary'), 'Missing discussion count');
        assert.match(await page.locator('#discussion-entry').textContent(), /1 discussion/);
        assert.equal(await page.locator('[data-discussion-preview]').count(), 0);
        assert.ok((await page.locator('#discussion-entry').boundingBox()).height < 36);
        const row = page.locator('.bp-benchmark-row').first();
        await row.hover();
        assert.match(await row.locator('.bp-benchmark-discuss').getAttribute('href'), /benchmarkID=101/);
        await row.locator('.bp-benchmark-discuss').click();
        await page.locator('#post-801').waitFor();
        assert.equal(await page.locator('#workspace-brand-slot .bp-brand').isVisible(), true);
        assert.equal(await page.locator('#discussion-compose-fields').isVisible(), false);
        assert.ok((await page.locator('.discussion-scroll').boundingBox()).height > 750, 'Browsing should dominate the panel');
        assert.equal(app.state.requests.filter(request => request.path === '/api/get_discussion').at(-1).body.contextValues.budget, 'standard');
        assert.equal(new URL(page.url()).pathname, '/');
    });
    await check('discussion trades sidebar space without overlay and preserves drafts', async ({ app, page }) => {
        await home(page, app);
        assert.equal(await page.locator('#mission-banner').count(), 0);
        assert.equal(await page.getByText('Independent evaluation · Community priorities', { exact: true }).count(), 0);
        await page.locator('#mission-welcome-trigger').click();
        await page.locator('#welcome-dialog').waitFor();
        await page.locator('#welcome-close').click();
        const before = await page.locator('#model-card').boundingBox();
        assert.ok(Math.abs(before.y + before.height - 984) < 2);
        await page.locator('#discussion-entry').click();
        await page.locator('#post-801').waitFor();
        const rail = await page.locator('#discussion-panel').boundingBox();
        const sidebar = await page.locator('.bp-shell > .bp-sidebar').boundingBox();
        const model = await page.locator('#model-card').boundingBox();
        const bench = await page.locator('#benchmark-card').boundingBox();
        assert.ok(sidebar.x + sidebar.width <= 1, 'Sidebar did not collapse');
        assert.ok(model.x + model.width <= rail.x, 'Discussion covers the model leaderboard');
        assert.ok(Math.abs(model.y - bench.y) < 2 && Math.abs(model.height - bench.height) < 2);
        assert.ok(Math.abs(model.y + model.height - 984) < 2);
        await page.locator('#discussion-compose-toggle').click();
        await page.locator('#discussion-text').fill('My unfinished benchmark discussion');
        await page.locator('#discussion-close').click();
        await page.locator('#discussion-entry').click();
        await page.locator('#post-801').waitFor();
        assert.equal(await page.locator('#discussion-text').inputValue(), 'My unfinished benchmark discussion');
        await page.locator('#discussion-close').click();
        const restored = await page.locator('#model-card').boundingBox();
        assert.ok(Math.abs(restored.x - before.x) < 2);
        await noOverflow(page);
    });
    await check('discussion panel animates and no independent page remains', async ({ app, page }) => {
        await home(page, app);
        const oldPage = await page.request.get(app.url + '/discussion');
        assert.equal(oldPage.status(), 404);
        const samples = await page.evaluate(async () => {
            document.getElementById('discussion-entry').click();
            const frames = [];
            const start = performance.now();
            await new Promise(resolve => {
                function frame() {
                    const rect = document.getElementById('discussion-panel').getBoundingClientRect();
                    frames.push(rect.width);
                    if (performance.now() - start > 400) resolve();
                    else requestAnimationFrame(frame);
                }
                requestAnimationFrame(frame);
            });
            return frames;
        });
        assert.ok(samples.some(width => width > 10 && width < 350), 'Rail snapped instead of sliding');
        assert.ok(Math.abs(samples.at(-1) - 360) < 1);
        await page.locator('#discussion-close').click();
        await page.waitForFunction(() => document.getElementById('discussion-panel').getBoundingClientRect().width < 1);
    }, { browser: { reducedMotion: 'no-preference' } });
    await check('fallback slice icons appear only in personal mode and clear on switching back', async ({ app, page }) => {
        await home(page, app);
        const icons = page.locator('#weight-pie .bp-pie-fallback-icon');
        assert.equal(await icons.count(), 0);
        await page.locator('#pie-mode-personal').click();
        await icons.waitFor();
        assert.equal(await icons.count(), 1);
        await page.locator('#pie-mode-public').click();
        await icons.waitFor({ state: 'detached' });
        await page.locator('#weight-pie g[data-object-id="1"]').click();
        await page.locator('#public-fallback-toggle').click();
        assert.equal(await page.locator('#inline-fallback-chart').isVisible(), true);
        assert.equal(await icons.count(), 0);
        await page.locator('#weight-pie g[data-object-id="2"]').click();
        assert.equal(await icons.count(), 0);
        assert.equal(saves(app).length, 0);
    }, {
        fallbackRules: [{ primaryConditionID: 1, mode: 'fallback_if_missing', entries: weightedEntries([{ conditionID: 2, weightBasisPoints: 10000 }]) }],
        publicFallbackRules: [{ primaryConditionID: 1, mode: 'fallback_if_missing', unconfiguredWeightBasisPoints: 0,
            entries: weightedEntries([{ conditionID: 2, weightBasisPoints: 10000 }]) }]
    });
    for (const width of [1440, 390, 320]) {
        await check(`prominent create mix entry ${width}`, async ({ app, page }) => {
            await home(page, app);
            const button = page.locator('#personal-pie-create');
            await button.waitFor();
            const initial = await button.boundingBox();
            assert.ok(initial.height >= 108);
            const style = await button.evaluate(element => ({
                background: getComputedStyle(element).backgroundColor,
                color: getComputedStyle(element).color,
                fontSize: getComputedStyle(element.querySelector('strong')).fontSize,
                fits: element.scrollWidth <= element.clientWidth
            }));
            assert.deepEqual(style, { background: 'rgb(255, 112, 30)', color: 'rgb(73, 32, 0)', fontSize: '16px', fits: true });
            await button.hover();
            assert.deepEqual(await button.boundingBox(), initial, 'Hover must not shift or resize the CTA');
            await button.focus();
            await noOverflow(page);
            await page.screenshot({ path: output + `create-mix-entry-${width}.png`, fullPage: true });
            await button.click();
            await page.locator('#personal-empty-mode').waitFor();
            assert.equal(await button.isVisible(), false);
            assert.equal(saves(app).length, 0);
        }, { personalEntries: [], browser: { viewport: { width, height: 1000 } } });
    }
    await check('leaderboards share total height across desktop layouts and filtering', async ({ app, page }) => {
        await home(page, app);
        const equalHeight = async () => {
            const benchmark = await page.locator('#benchmark-card').boundingBox();
            const model = await page.locator('#model-card').boundingBox();
            assert.ok(Math.abs(benchmark.height - model.height) < 1, 'Leaderboard heights differ');
            const rows = await page.locator('#benchmark-rows, #model-rows').evaluateAll(elements => elements.map(element => ({
                bottom: element.getBoundingClientRect().bottom,
                cardBottom: element.parentElement.getBoundingClientRect().bottom,
                overflow: getComputedStyle(element).overflowY
            })));
            assert.ok(rows.every(row => row.bottom <= row.cardBottom && row.overflow === 'auto'));
        };
        for (const width of [1440, 1200, 1024, 768]) {
            await page.setViewportSize({ width, height: 1000 });
            await equalHeight();
            await page.locator('#benchmark-search').fill('No matching benchmark');
            await equalHeight();
            await page.locator('#benchmark-search').fill('');
            await noOverflow(page);
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.screenshot({ path: output + 'matched-leaderboard-heights.png', fullPage: true });
    });
    for (const width of [1440, 390]) {
        await check(`dynamic model score scale ${width}`, async ({ app, page }) => {
            await page.route('**/api/get_weighted_workspace', async route => {
                const response = await route.fetch();
                const data = await response.json();
                const bounds = [[120, 150], [-50, 80], [30, 200]];
                data.modelLeaderboards.public = data.modelLeaderboards.public.slice(0, 3)
                    .map((model, i) => ({ ...model, lower: bounds[i][0], upper: bounds[i][1] }));
                data.modelLeaderboards.public[0].fallbackUsageCount = 1;
                await route.fulfill({ response, json: data });
            });
            await home(page, app);
            assert.equal(await page.locator('.bp-model-fallback-badge, #model-rows .fa-code-branch').count(), 0, 'No branch badges in the model leaderboard');
            assert.match(await page.locator('.bp-model-row').first().getAttribute('title'), /Fallback used for 1 benchmark/);
            const rows = await page.locator('.bp-model-row').evaluateAll(elements => elements.map(row => ({
                score: row.querySelector('.bp-model-score').textContent,
                knownLeft: parseFloat(row.querySelector('.bp-score-known').style.left),
                knownWidth: parseFloat(row.querySelector('.bp-score-known').style.width),
                rangeLeft: parseFloat(row.querySelector('.bp-score-uncertain').style.left),
                rangeWidth: parseFloat(row.querySelector('.bp-score-uncertain').style.width),
                zero: parseFloat(row.querySelector('.bp-score-zero').style.left)
            })));
            assert.deepEqual(rows.map(row => row.score), ['120.00', '30.00', '-50.00']);
            const expected = [[20, 48, 68, 12], [20, 12, 32, 68], [0, 20, 0, 52]];
            rows.forEach((row, i) => {
                [row.knownLeft, row.knownWidth, row.rangeLeft, row.rangeWidth].forEach((value, j) => assert.ok(Math.abs(value - expected[i][j]) < 1e-8));
                assert.equal(row.zero, 20);
                assert.ok(row.rangeLeft + row.rangeWidth <= 100);
            });
            if (width === 390) await page.locator('[data-mobile-panel="models"]').click();
            await noOverflow(page);
            await page.screenshot({ path: output + `dynamic-model-scale-${width}.png`, fullPage: true });
            if (width === 1440) {
                await page.locator('#pie-mode-personal').click();
                assert.equal(await page.locator('.bp-score-zero').count(), 0, 'Personal ranking recalculates its own scale');
            }
        }, { browser: { viewport: { width, height: 1000 } } });
    }
    await check('batch scores submit shared URL without any provider fields', async ({ app, page }) => {
        await page.goto(`${app.url}/contribute?mode=benchmark_result`);
        const fillScore = async (index, model, benchmark) => {
            await page.locator(`[data-result-model-query][data-index="${index}"]`).fill(model);
            await page.locator(`[data-select-result-model][data-index="${index}"]`).first().click();
            await page.locator(`[data-result-object-query][data-index="${index}"]`).fill(benchmark);
            await page.locator(`[data-select-result-object][data-index="${index}"]`).first().click();
            await page.locator(`[data-score-value-input][data-index="${index}"]`).fill('55');
        };
        await fillScore(0, 'Aster Pro', 'General');
        assert.equal(await page.locator('[data-catalog-picker="provider"]').count(), 0);
        await page.locator('[data-action="add-result"]').click();
        await fillScore(1, 'Cedar Sonnet', 'Code');
        await page.locator('[data-field="sourceURL"]').fill('https://example.com/evidence');
        await page.screenshot({ path: output + 'scores-without-providers.png', fullPage: true });
        await page.locator('#submit-contribution').click();
        await page.locator('#submit-success-dialog').waitFor();
        const submitted = app.state.requests.find(item => item.path === '/api/submit_contribution').body;
        assert.equal(submitted.results.length, 2);
        assert.ok(submitted.results.every(row => !('providerID' in row.source) && !('providerRef' in row.source)));
        assert.ok(submitted.results.every(row => row.source.url === 'https://example.com/evidence'));
    });
    await check('mobile score form has source but no provider workflow', async ({ app, page }) => {
        await page.goto(`${app.url}/contribute?mode=benchmark_result`);
        await page.locator('[data-result-model-query]').waitFor();
        assert.equal(await page.locator('[data-catalog-picker="provider"], a[href*="new_provider"]').count(), 0);
        assert.equal(await page.locator('[data-field="sourceURL"]').getAttribute('required'), '');
        await noOverflow(page);
        await page.screenshot({ path: output + 'scores-without-providers-mobile.png', fullPage: true });
    }, { browser: { viewport: { width: 390, height: 844 } } });
    await check('duplicate benchmark goes to change form in same tab', async ({ app, page, context }) => {
        await page.goto(`${app.url}/contribute?mode=new_benchmark`);
        await page.locator('[data-evaluation-name]').fill('General');
        await page.getByText('Is your benchmark already listed?', { exact: true }).waitFor();
        await page.locator('[data-select-evaluation="101"]').click();
        await page.waitForURL('**/contribute/benchmarks/101/edit');
        await page.locator('[data-condition-input]').last().waitFor();
        assert.equal(context.pages().length, 1);
        assert.equal(await page.locator('[data-condition-input]').count(), 2);
        assert.equal(await page.locator('[data-condition-input]').last().inputValue(), '');
        await page.waitForFunction(() => document.activeElement === [...document.querySelectorAll('[data-condition-input]')].at(-1));
    });

    await check('condition impact cancel confirm and guarded removal', async ({ app, page }) => {
        await page.goto(`${app.url}/contribute?mode=edit_benchmark&targetBenchmarkID=101&addCondition=1`);
        await page.waitForFunction(() => document.activeElement === [...document.querySelectorAll('[data-condition-input]')].at(-1));
        const input = page.locator('[data-condition-input]').first();
        await input.fill('pass@1');
        await page.locator('h1').click();
        await page.getByText('Rename test condition?', { exact: true }).waitFor();
        await page.getByText(/linked to 3 scores and 2 personal weight mixes/).waitFor();
        await page.locator('.global-system-dialog global-dialog-action').filter({ hasText: 'Cancel' }).click();
        assert.equal(await input.inputValue(), 'default');
        await input.fill('pass@2');
        await page.locator('h1').click();
        await page.locator('.global-system-dialog global-dialog-action').filter({ hasText: 'Confirm rename' }).click();
        assert.equal(await input.inputValue(), 'pass@2');
        await page.locator('[data-restore-path$=".name"]').filter({ has: page.locator('i') }).last().click();
        assert.equal(await input.inputValue(), 'default');
        await input.fill('pass@2');
        await page.locator('h1').click();
        await page.getByText('Rename test condition?', { exact: true }).waitFor();
        await page.locator('.global-system-dialog global-dialog-action').filter({ hasText: 'Confirm rename' }).click();
        await page.locator('[data-action="remove-profile"]').first().click();
        await page.getByText('This condition is in use', { exact: true }).waitFor();
        await page.locator('.global-system-dialog global-dialog-action').click();
        assert.equal(await page.locator('[data-condition-input]').count(), 2);
        assert.equal(app.state.requests.filter(item => item.path === '/api/submit_contribution').length, 0);
    });

    await check('fixed-choice blur errors are inline', async ({ app, page }) => {
        await page.goto(`${app.url}/contribute?mode=benchmark_result`);
        const input = page.locator('[data-result-model-query]').first();
        await input.fill('Not a real model');
        await page.locator('h1').click();
        await page.locator('.field-validation-error').waitFor();
        assert.equal(await input.getAttribute('aria-invalid'), 'true');
        assert.equal(await page.locator('global-dialog:not([hidden])').count(), 0);
        await input.fill('Aster');
        await page.locator('[data-select-result-model]').first().click();
        assert.equal(await page.locator('.field-validation-error').count(), 0);
    });

    for (const [mode, target, kind] of [
        ['edit_benchmark', 'targetBenchmarkID', 'benchmark'],
        ['edit_model', 'targetModelID', 'model'],
        ['edit_result', 'targetResultID', 'result']
    ]) {
        await check(`stored notes round-trip in ${mode}`, async ({ app, page }) => {
            await page.goto(`${app.url}/contribute?mode=${mode}&${target}=101`);
            const notes = page.locator('[data-final-notes] textarea');
            await notes.waitFor();
            const original = kind === 'result' ? 'Saved score note' : 'Saved object note';
            assert.equal(await notes.inputValue(), original);
            await notes.fill('Updated note');
            await page.locator('[data-final-notes] [data-restore-path]').click();
            assert.equal(await notes.inputValue(), original);
            await notes.fill('Updated note');
            await page.locator('#submit-contribution').click();
            await page.locator('#submit-success-dialog').waitFor();
            const body = app.state.requests.find(item => item.path === '/api/submit_contribution').body;
            assert.equal(body.operation, 'update');
            assert.equal((kind === 'result' ? body.proposed.results[0] : body.proposed).notes, 'Updated note');
        });
    }

    for (const width of [1440, 390]) {
        await check(`merge form layout ${width}`, async ({ app, page }) => {
            await page.goto(`${app.url}/contribute?mode=edit_benchmark&targetBenchmarkID=101`);
            await page.locator('[data-change-operation="merge"]').click();
            await page.waitForURL('**/contribute/feedback');
            const details = page.locator('[data-bind="feedback"][data-field="details"]');
            assert.match(await details.inputValue(), /Merge request[\s\S]*benchmark #101/);
            await details.fill((await details.inputValue()) + 'Same object as benchmark #102.');
            await noOverflow(page);
            const email = await page.locator('.submission-email-notice').boundingBox();
            const footer = await page.locator('.contribution-navigation').boundingBox();
            assert.ok(email.y + email.height <= footer.y + 1, 'Email notice overlaps footer');
            await page.screenshot({ path: output + `merge-form-${width}.png`, fullPage: true });
            await page.locator('#submit-contribution').click();
            await page.locator('#submit-success-dialog').waitFor();
            const body = app.state.requests.find(item => item.path === '/api/submit_contribution').body;
            assert.equal(body.type, 'feedback');
            assert.match(body.details, /Same object as benchmark #102/);
            assert.equal(app.state.requests.some(item => item.path === '/api/get_merge_candidates'), false);
        }, { browser: { viewport: { width, height: 1000 } } });
    }
    for (const mobile of [false, true]) {
        await check(`public fallback ${mobile ? 'mobile' : 'desktop'}`, async ({ app, page }) => {
            await home(page, app);
            assert.equal(await page.locator('#weight-pie .bp-pie-fallback-icon').count(), 0);
            await page.locator('#weight-pie g[data-object-id="1"]').click();
            await page.locator('#public-fallback-toggle').waitFor();
            assert.equal(await page.locator('#inline-fallback-chart').isVisible(), false);
            await page.locator('#public-fallback-toggle').click();
            const chart = page.locator('#inline-fallback-chart');
            assert.equal(await page.locator('#inline-fallback-guide').textContent(),
                'When a model has no score for General knowledge, use this benchmark mix instead.');
            const remainder = chart.locator('.bp-public-fallback-unconfigured');
            assert.equal(await remainder.getAttribute('title'), 'No fallback 25%');
            assert.equal(await page.locator('#inline-fallback-personal-control').isVisible(), false);
            assert.equal(await page.locator('#inline-fallback-remove').isVisible(), false);
            const bounds = await chart.boundingBox();
            const remainderBounds = await remainder.boundingBox();
            assert.ok(Math.abs(remainderBounds.width / (bounds.width - 2) - 0.25) < 0.01);
            await chart.locator('.bp-inline-fallback-segment').first().click();
            assert.equal(await page.locator('#inline-fallback-guide').innerText(), 'Advanced reasoning: 50%');
            await chart.hover();
            await page.mouse.wheel(0, -100);
            await delay(600);
            assert.equal(saves(app).length, 0);
            await noOverflow(page);
            await page.screenshot({ path: output + `public-fallback-${mobile ? 'mobile' : 'desktop'}.png`, fullPage: true });
            await page.locator('#public-fallback-toggle').click();
            assert.equal(await chart.isVisible(), false);
            await page.locator('#public-fallback-toggle').click();
            await page.locator('#weight-pie g[data-object-id="2"]').click();
            assert.equal(await chart.isVisible(), true);
            assert.equal(await page.locator('#public-fallback-toggle').getAttribute('aria-expanded'), 'true');
            assert.equal(await chart.innerText(), 'No public fallback configured for this benchmark.');
            assert.equal(saves(app).length, 0);
        }, {
            authenticated: false,
            publicFallbackRules: [{ primaryConditionID: 1, mode: 'fallback_if_missing',
                unconfiguredWeightBasisPoints: 2500,
                entries: weightedEntries([{ conditionID: 2, weightBasisPoints: 5000 }, { conditionID: 3, weightBasisPoints: 2500 }]) }],
            browser: mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {}
        });
    }
    await check('weight modes survive category template breadcrumb and reload navigation', async ({ app, page }) => {
        await navigationFixture(page, { emptyPersonalContext: true });
        await home(page, app);
        await pieMode(page, 'public');
        for (const mode of ['personal', 'public']) {
            await page.locator(`#pie-mode-${mode}`).click();
            await page.locator('[data-category-id="2"]').click();
            await navigationWorkspace(page, 'Reasoning');
            await pieMode(page, mode);
            await navigationTemplate(page, 'Extended');
            await navigationWorkspace(page, 'Reasoning', 'Extended');
            await pieMode(page, mode);
            if (mode === 'personal') assert.equal(await page.locator('#personal-empty-mode').isVisible(), true);
            await parentBreadcrumb(page);
            await pieMode(page, mode);
            await page.reload();
            await navigationWorkspace(page, 'Language models');
            await pieMode(page, mode);
        }
        assert.equal(saves(app).length, 0);
    });
    await check('public fallback visibility survives category template mode breadcrumb and reload navigation', async ({ app, page }) => {
        await navigationFixture(page);
        await home(page, app);
        const before = structuredClone({ entries: app.state.personalEntries, personal: app.state.fallbackRules, public: app.state.publicFallbackRules });
        const toggle = page.locator('#public-fallback-toggle');
        const chart = page.locator('#inline-fallback-chart');
        const publicFallback = async expanded => {
            await pieMode(page, 'public');
            assert.equal(await toggle.isVisible(), true);
            assert.equal(await toggle.getAttribute('aria-expanded'), String(expanded));
            assert.equal(await toggle.innerText(), expanded ? 'Hide fallback' : 'Show fallback');
            assert.equal(await chart.isVisible(), expanded);
            if (expanded) {
                const component = chart.locator('.bp-inline-fallback-segment[data-condition-id="2"]');
                assert.equal(await component.count(), 1, 'Fallback contents came from the wrong mode or context');
                assert.equal(await component.getAttribute('title'), 'Advanced reasoning: 75%');
            }
        };
        const personalFallback = async () => {
            await pieMode(page, 'personal');
            assert.equal(await toggle.isVisible(), false, 'Personal mode must only expose its rule enable switch');
            assert.equal(await page.locator('#inline-fallback-enabled').isChecked(), true);
            assert.equal(await chart.isVisible(), true, 'Public visibility must not hide an enabled personal rule');
            assert.equal(await chart.locator('.bp-inline-fallback-segment[data-condition-id="3"]').getAttribute('title'), 'Code generation: 100%');
        };
        await page.locator('#weight-pie g[data-object-id="1"]').click();
        await publicFallback(false);
        for (const expanded of [true, false]) {
            await toggle.click();
            await publicFallback(expanded);
            await page.locator('[data-category-id="2"]').click();
            await navigationWorkspace(page, 'Reasoning');
            await publicFallback(expanded);
            await navigationTemplate(page, 'Extended');
            await navigationWorkspace(page, 'Reasoning', 'Extended');
            await publicFallback(expanded);
            await page.locator('#pie-mode-personal').click();
            await personalFallback();
            await page.locator('[data-category-id="3"]').click();
            await navigationWorkspace(page, 'Coding');
            await personalFallback();
            await navigationTemplate(page, 'Extended');
            await navigationWorkspace(page, 'Coding', 'Extended');
            await personalFallback();
            await page.locator('#pie-mode-public').click();
            await publicFallback(expanded);
            await parentBreadcrumb(page);
            await publicFallback(expanded);
            await page.reload();
            await navigationWorkspace(page, 'Language models');
            await publicFallback(expanded);
            await page.locator('#pie-mode-personal').click();
            await personalFallback();
            await page.reload();
            await navigationWorkspace(page, 'Language models');
            await personalFallback();
            await page.locator('#pie-mode-public').click();
            await publicFallback(expanded);
        }
        assert.equal(saves(app).length, 0, 'Display preferences must not save personal weights');
        assert.deepEqual({ entries: app.state.personalEntries, personal: app.state.fallbackRules, public: app.state.publicFallbackRules }, before);
    }, {
        fallbackRules: [{ primaryConditionID: 1, mode: 'fallback_if_missing', entries: weightedEntries([{ conditionID: 3, weightBasisPoints: 10000 }]) }],
        publicFallbackRules: [{ primaryConditionID: 1, mode: 'fallback_if_missing', unconfiguredWeightBasisPoints: 2500,
            entries: weightedEntries([{ conditionID: 2, weightBasisPoints: 7500 }]) }]
    });
    await check('personal fallback switches follow context rules and discard unsaved drafts', async ({ app, page }) => {
        const rule = conditionID => [{ primaryConditionID: 1, mode: 'fallback_if_missing',
            entries: weightedEntries([{ conditionID, weightBasisPoints: 10000 }]) }];
        const rulesByContext = new Map([
            ['1:standard', rule(3)], ['1:extended', rule(2)],
            ['2:standard', []], ['2:extended', rule(4)],
            ['3:standard', rule(2)], ['3:extended', []]
        ]);
        const before = structuredClone(rulesByContext);
        await navigationFixture(page, { personalFallbackRulesByContext: rulesByContext });
        await page.addInitScript(() => {
            const key = 'benchpoll-workspace-preferences-v1';
            if (!sessionStorage.getItem(key)) {
                sessionStorage.setItem(key, JSON.stringify({ mode: 'personal', fallbackVisible: { personal: false, public: true } }));
            }
        });
        await home(page, app);
        const entriesBefore = structuredClone(app.state.personalEntries);
        const chart = page.locator('#inline-fallback-chart');
        const personalFallback = async (componentID, { draft = false } = {}) => {
            const enabled = componentID !== null || draft;
            await pieMode(page, 'personal');
            assert.equal(await page.locator('#public-fallback-toggle').isVisible(), false);
            assert.equal(await page.locator('#inline-fallback-personal-control').isVisible(), true);
            assert.equal(await page.locator('#inline-fallback-enabled').isChecked(), enabled, 'Personal switch must reflect this context rule');
            assert.equal(await chart.isVisible(), enabled);
            if (componentID !== null) {
                assert.equal(await chart.locator('.bp-inline-fallback-segment').count(), 1);
                assert.equal(await chart.locator(`.bp-inline-fallback-segment[data-condition-id="${componentID}"]`).count(), 1);
            } else if (draft) {
                assert.equal(await chart.locator('.bp-inline-fallback-empty').isVisible(), true);
            }
            if (!draft) assert.equal(await page.locator('#benchmark-card').evaluate(element => element.classList.contains('is-fallback-target-active')), false);
        };
        await page.locator('#weight-pie g[data-object-id="1"]').click();
        await personalFallback(3); // Ignore the obsolete personal display preference.
        await page.locator('#pie-mode-public').click();
        assert.equal(await page.locator('#public-fallback-toggle').getAttribute('aria-expanded'), 'true');
        assert.equal(await chart.isVisible(), true, 'The previous public display preference should still load');
        await page.locator('#pie-mode-personal').click();
        await personalFallback(3);
        await page.locator('[data-category-id="2"]').click();
        await navigationWorkspace(page, 'Reasoning');
        await personalFallback(null);
        await navigationTemplate(page, 'Extended');
        await navigationWorkspace(page, 'Reasoning', 'Extended');
        await personalFallback(4);
        await navigationTemplate(page, 'Standard');
        await navigationWorkspace(page, 'Reasoning');
        await personalFallback(null);
        await parentBreadcrumb(page);
        await personalFallback(3);

        await page.locator('.bp-fallback-switch').click();
        await waitSaved(page, app, 1);
        await personalFallback(null);
        assert.equal(saves(app)[0].body.categoryID, 1);
        assert.deepEqual(saves(app)[0].body.contextValues, { budget: 'standard' });
        assert.deepEqual(saves(app)[0].body.fallbackRules, [], 'Disabling Personal must persist the rule removal');
        await navigationTemplate(page, 'Extended');
        await navigationWorkspace(page, 'Language models', 'Extended');
        await personalFallback(2);
        await page.locator('[data-category-id="3"]').click();
        await navigationWorkspace(page, 'Coding');
        await personalFallback(2);
        await parentBreadcrumb(page);
        await personalFallback(null);

        await page.locator('.bp-fallback-switch').click();
        await personalFallback(null, { draft: true });
        await chart.click();
        assert.equal(await page.locator('#benchmark-card').evaluate(element => element.classList.contains('is-fallback-target-active')), true);
        await page.locator('[data-category-id="2"]').click();
        await navigationWorkspace(page, 'Reasoning');
        await personalFallback(null);
        await parentBreadcrumb(page);
        await personalFallback(null);
        await page.locator('.bp-fallback-switch').click();
        await personalFallback(null, { draft: true });
        await chart.click();
        await navigationTemplate(page, 'Extended');
        await navigationWorkspace(page, 'Language models', 'Extended');
        await personalFallback(2);
        await navigationTemplate(page, 'Standard');
        await navigationWorkspace(page, 'Language models');
        await personalFallback(null);
        assert.equal(saves(app).length, 1, 'Navigation and empty drafts must not change saved fallback rules');
        before.set('1:standard', []);
        assert.deepEqual(rulesByContext, before);
        assert.deepEqual(app.state.personalEntries, entriesBefore);
    });
    await check('desktop home and evidence', async ({ app, page }) => {
        await home(page, app);
        assert.equal(await page.locator('.bp-benchmark-row').count(), 8);
        assert.equal(await page.locator('.bp-model-row').count(), 8);
        await noOverflow(page);
        const cards = await Promise.all(['#pie-card', '#benchmark-card', '#model-card'].map(selector => page.locator(selector).boundingBox()));
        assert.ok(cards[0].x + cards[0].width <= cards[1].x && cards[1].x + cards[1].width <= cards[2].x, 'Desktop panels overlap');
        await page.screenshot({ path: output + 'home-desktop.png', fullPage: true });
        await page.locator('.bp-model-row').first().focus();
        await page.keyboard.press('Enter');
        await page.locator('.bp-model-score-sample').first().waitFor();
        assert.equal(await page.locator('.bp-model-score-sample').count(), 10);
        assert.equal(await page.locator('.bp-model-score-source').first().getAttribute('href'), 'https://example.com/evidence');
        assert.equal(await page.locator('.bp-model-score-sample .bp-row-edit-action').first().getAttribute('href'), '/contribute/scores/501/edit');
        const list = page.locator('#model-scores-list');
        assert.ok(await list.evaluate(node => node.scrollHeight > node.clientHeight));
        await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
        await page.locator('.bp-model-score-sample').last().scrollIntoViewIfNeeded();
        await page.screenshot({ path: output + 'model-evidence.png', fullPage: true });
        await page.locator('#model-scores-dialog .dialog-close-button').click();
        await page.locator('#model-scores-dialog').waitFor({ state: 'hidden' });
        await page.locator('#benchmark-search').fill('no-such-benchmark');
        assert.equal(await page.locator('#benchmark-rows').innerText(), 'No benchmarks found');
        await page.locator('#benchmark-search').fill('Reasoning');
        assert.ok(await page.locator('.bp-benchmark-row').count() >= 1);
    });

    await check('personal adjustment save undo and fallback', async ({ app, page }) => {
        await home(page, app);
        await page.locator('#pie-mode-personal').click();
        const before = structuredClone(app.state.personalEntries);
        await page.locator('#weight-pie g[data-object-id="1"]').click();
        await page.locator('#weight-pie').hover();
        await page.mouse.wheel(0, -100);
        await waitSaved(page, app, 1);
        assert.notEqual(app.state.personalEntries[0].weightBasisPoints, before[0].weightBasisPoints);
        assert.equal(saves(app)[0].body.entries.reduce((sum, entry) => sum + entry.weightBasisPoints, 0), 10000);
        await page.locator('#workspace-undo').click();
        await waitSaved(page, app, 2);
        assert.deepEqual(app.state.personalEntries.map(item => item.weightBasisPoints), before.map(item => item.weightBasisPoints));
        await page.locator('.bp-fallback-switch').click();
        await page.locator('#inline-fallback-chart').click();
        await page.getByRole('button', { name: 'Add Advanced reasoning to Fallback', exact: true }).click();
        await waitSaved(page, app, 3);
        assert.equal(app.state.fallbackRules[0].primaryConditionID, 1);
        assert.equal(app.state.fallbackRules[0].entries[0].conditionID, 2);
        assert.equal(app.state.fallbackRules[0].entries[0].weightBasisPoints, 10000);
        await page.screenshot({ path: output + 'personal-fallback.png', fullPage: true });
        await page.locator('.bp-fallback-switch').click();
        await waitSaved(page, app, 4);
        assert.deepEqual(app.state.fallbackRules, []);
        await page.locator('#benchmark-personal-pin').click();
        assert.equal(await page.locator('#benchmark-personal-pin').getAttribute('aria-pressed'), 'true');
        await page.getByRole('button', { name: 'Remove General knowledge from Personal Weights', exact: true }).click();
        await waitSaved(page, app, 5);
        assert.ok(!app.state.personalEntries.some(item => item.conditionID === 1));
        assert.equal(app.state.personalEntries.reduce((sum, entry) => sum + entry.weightBasisPoints, 0), 10000);
    });

    await check('save failure and revision conflict recover', async ({ app, page }) => {
        await home(page, app);
        await page.locator('#pie-mode-personal').click();
        const original = structuredClone(app.state.personalEntries);
        app.state.saveFailure = 500;
        await page.getByRole('button', { name: 'Remove General knowledge from Personal Weights', exact: true }).click();
        await page.getByText('Your change was not saved', { exact: true }).waitFor();
        assert.deepEqual(app.state.personalEntries, original);
        assert.equal(await page.locator('.bp-personal-weight-remove').count(), 4);
        app.state.saveFailure = 409;
        const initialLoads = app.state.requests.filter(item => item.path === '/api/get_weighted_workspace').length;
        await page.getByRole('button', { name: 'Remove General knowledge from Personal Weights', exact: true }).click();
        await until(() => app.state.requests.filter(item => item.path === '/api/get_weighted_workspace').length > initialLoads, 'Conflict did not refresh workspace');
        await page.locator('.bp-benchmark-row').first().waitFor();
        assert.equal(await page.locator('.bp-personal-weight-remove').count(), 4);
    });

    await check('category switch flushes queued save and templates remain usable', async ({ app, page }) => {
        await home(page, app);
        await page.locator('#pie-mode-personal').click();
        app.state.saveDelay = 250;
        await page.getByRole('button', { name: 'Remove General knowledge from Personal Weights', exact: true }).click();
        await page.locator('[data-category-id="2"]').click();
        await until(() => app.state.requests.some(item => item.path === '/api/get_weighted_workspace' && item.body.categoryID === 2), 'Category did not load');
        const saveIndex = app.state.requests.findIndex(item => item.path === '/api/save_personal_pie');
        const nextIndex = app.state.requests.findIndex(item => item.path === '/api/get_weighted_workspace' && item.body.categoryID === 2);
        assert.ok(saveIndex >= 0 && saveIndex < nextIndex);
        assert.equal(saves(app)[0].body.categoryID, 1);
        await page.locator('.bp-template-control').click();
        await page.getByRole('option', { name: 'Extended', exact: true }).click();
        await until(() => app.state.requests.some(item => item.body.contextValues?.budget === 'extended'), 'Context choice did not load');
        await page.waitForFunction(() => document.querySelector('.bp-template-value')?.textContent === 'Extended');
    });

    await check('guest login entry and welcome keyboard', async ({ app, page }) => {
        await home(page, app);
        assert.equal(await page.locator('#login-button').isVisible(), true);
        assert.equal(await page.locator('#contribute-button').isVisible(), false);
        assert.equal(await page.locator('#personal-pie-create').isVisible(), true);
        await page.locator('#mission-welcome-trigger').click();
        await page.locator('#welcome-dialog').waitFor();
        await page.screenshot({ path: output + 'welcome.png', fullPage: true });
        await page.keyboard.press('Escape');
        await page.locator('#welcome-overlay').waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => localStorage.getItem('benchpoll-welcome-seen-v1')), '1');
        await page.locator('#personal-pie-create').click();
        assert.equal(saves(app).length, 0);
    }, { authenticated: false });

    await check('empty workspace', async ({ app, page }) => {
        await page.goto(app.url);
        await page.getByText('No benchmarks found', { exact: true }).waitFor();
        await page.getByText('No public model ranking is available in this context yet.', { exact: true }).waitFor();
        await page.screenshot({ path: output + 'empty-state.png', fullPage: true });
    }, { empty: true });

    await check('load failure retry and loading state', async ({ app, page }) => {
        await page.goto(app.url);
        await page.locator('.bp-error-state').first().waitFor();
        await page.screenshot({ path: output + 'error-state.png', fullPage: true });
        app.state.workspaceFailure = null;
        app.state.workspaceDelay = 500;
        await page.getByRole('button', { name: 'Retry', exact: true }).first().click();
        await page.locator('.bp-loading-state').first().waitFor();
        await page.locator('.bp-model-row').first().waitFor();
    }, { workspaceFailure: 503 });

    for (const width of [1920, 1024, 768, 390, 320]) {
        await check(`responsive ${width}`, async ({ app, page }) => {
            await home(page, app);
            await noOverflow(page);
            if (width <= 760) {
                assert.equal(await page.locator('#model-card').isVisible(), false);
                await page.locator('[data-mobile-panel="models"]').click();
                assert.equal(await page.locator('#model-card').isVisible(), true);
                await page.locator('.bp-model-row').first().click();
                await page.locator('.bp-model-score-sample').first().waitFor();
                await noOverflow(page);
                await page.screenshot({ path: output + `evidence-${width}.png`, fullPage: true });
                await page.locator('#model-scores-dialog .dialog-close-button').click();
                await page.locator('#taxonomy-toggle').click();
                await page.locator('[data-category-id="3"]').click();
                assert.equal(await page.locator('#taxonomy-toggle').getAttribute('aria-expanded'), 'false');
                await page.locator('[data-mobile-panel="mix"]').click();
            }
            await page.screenshot({ path: output + `home-${width}.png`, fullPage: true });
        }, { browser: { viewport: { width, height: width <= 760 ? 844 : 1000 }, isMobile: width <= 760, hasTouch: width <= 760 } });
    }

    const modes = ['new_benchmark', 'new_model', 'benchmark_result', 'new_category', 'correct_or_add_info', 'delete_or_migrate_category', 'feedback', 'edit_benchmark', 'edit_model', 'edit_result'];
    await check('all contribution forms and submission', async ({ app, page }) => {
        for (const mode of modes) {
            await page.goto(`${app.url}/contribute?mode=${mode}&targetBenchmarkID=101&targetModelID=301&targetResultID=501&targetName=Reasoning&parentPath=Language-models`);
            await page.locator('#form-surface').waitFor();
            assert.equal(await page.locator('#submit-error-dialog').isVisible(), false, `${mode} failed to initialize`);
            assert.ok((await page.locator('#contribution-step').innerText()).length > 20, `${mode} is empty`);
            await noOverflow(page);
            if (mode === 'new_benchmark') await page.screenshot({ path: output + 'contribution.png', fullPage: true });
        }
        await page.goto(`${app.url}/contribute?mode=feedback`);
        await page.locator('#form-surface').waitFor();
        await page.locator('textarea').first().fill('Please improve the readability of the benchmark sources.');
        await page.locator('#submit-contribution').click();
        await page.locator('#submit-success-dialog').waitFor();
        const submission = app.state.requests.find(item => item.path === '/api/submit_contribution');
        assert.ok(submission, 'No contribution submitted');
        assert.ok(JSON.stringify(submission.body).includes('improve the readability'));
    });

    await check('mobile contribution and methodology', async ({ app, page }) => {
        await page.goto(`${app.url}/contribute?mode=new_benchmark`);
        await page.locator('#form-surface').waitFor();
        await noOverflow(page);
        await page.locator('#contribution-taxonomy-toggle').click();
        await page.locator('#contribution-user').waitFor();
        assert.equal(await page.locator('#contribution-tree').getAttribute('aria-disabled'), 'true');
        await page.locator('#contribution-taxonomy-close').click();
        await page.screenshot({ path: output + 'contribution-mobile.png', fullPage: true });
        await page.goto(`${app.url}/how-it-works`);
        await noOverflow(page);
        await page.screenshot({ path: output + 'methodology-mobile.png', fullPage: true });
    }, { browser: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } });

    await check('new benchmark validation and submission', async ({ app, page }) => {
        await page.goto(`${app.url}/contribute?mode=new_benchmark`);
        await page.locator('#form-surface').waitFor();
        await page.locator('[data-evaluation-name]').fill('Independent test benchmark');
        await page.locator('[data-action="add-profile"]').click();
        await page.locator('[data-condition-input]').last().fill('default');
        await page.locator('#submit-contribution').click();
        await page.locator('#submit-error-dialog').waitFor();
        assert.equal(app.state.requests.filter(item => item.path === '/api/submit_contribution').length, 0);
        await page.locator('#submit-error-dialog .dialog-close-button').click();
        await page.locator('[data-condition-input]').last().fill('pass@1');
        await page.locator('#submit-contribution').click();
        await page.locator('#submit-success-dialog').waitFor();
        assert.equal(app.state.requests.filter(item => item.path === '/api/submit_contribution').length, 1);
    });

    await check('touch weight adjustment and mobile panel state', async ({ app, page, context }) => {
        await home(page, app);
        await page.locator('#pie-mode-personal').click();
        await page.locator('#weight-pie').scrollIntoViewIfNeeded();
        const original = app.state.personalEntries[0].weightBasisPoints;
        const rect = await page.locator('#weight-pie').boundingBox();
        const x = rect.x + rect.width * .65, y = rect.y + rect.height * .6;
        const session = await context.newCDPSession(page);
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - 45 }] });
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await waitSaved(page, app, 1);
        assert.notEqual(app.state.personalEntries[0].weightBasisPoints, original);
        assert.equal(app.state.personalEntries.reduce((sum, item) => sum + item.weightBasisPoints, 0), 10000);
        await page.locator('[data-mobile-panel="models"]').click();
        await page.locator('[data-mobile-panel="mix"]').click();
        assert.equal(await page.locator('#pie-mode-personal').getAttribute('aria-selected'), 'true');
    }, { browser: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } });

    await check('reviewer role and account controls', async ({ app, page }) => {
        await page.goto(`${app.url}/censor`);
        await page.locator('.log-item').waitFor();
        assert.equal(await page.locator('#messages-tab').isVisible(), false);
        await page.locator('[data-workspace-view="explorer"]').click();
        await page.getByText('No matching records.', { exact: true }).waitFor();
        assert.equal(await page.locator('#explorer-add').isVisible(), false);
        await home(page, app);
        await page.locator('#user-profile').click();
        await page.locator('#logout-button').click();
        await page.locator('.dialog-logout-this-device-button').waitFor();
        await page.locator('.dialog-logout-this-device-button').click();
        await page.locator('#logout-success-dialog').waitFor();
        assert.equal(app.state.authenticated, false);
    }, { isSenior: false });

    await check('moderation queue preview editor tabs and approval', async ({ app, page }) => {
        await page.goto(`${app.url}/censor`);
        await page.locator('.log-item').waitFor();
        await noOverflow(page);
        await page.screenshot({ path: output + 'moderation.png', fullPage: true });
        await page.locator('.log-item .action-button.preview').click();
        await page.locator('#sql-overlay').waitFor();
        await page.waitForFunction(() => document.querySelector('#sql-overlay').contains(document.activeElement));
        await page.keyboard.press('Escape');
        await page.locator('#sql-overlay').waitFor({ state: 'hidden' });
        await page.locator('.log-item .action-button.edit').click();
        await page.locator('#editor-overlay').waitFor();
        await page.keyboard.press('Escape');
        for (const view of ['explorer', 'audit', 'messages', 'queue']) {
            await page.locator(`[data-workspace-view="${view}"]`).click();
            await page.locator(`#${view}-view`).waitFor();
            if (view === 'explorer') await page.getByText('No matching records.', { exact: true }).waitFor();
            if (view === 'audit') await page.getByText('No matching audit records.', { exact: true }).waitFor();
            if (view === 'messages') await page.getByText('No messages have been sent to senior reviewers.', { exact: true }).waitFor();
        }
        await page.locator('.log-item .action-button.approve').click();
        await page.locator('global-dialog:not([hidden]) global-dialog-action.main').click();
        await until(() => app.state.logs[0].status === 'approved', 'Moderation approval not sent');
    });
} finally {
    await browser.close();
    await writeFile(output + 'results.json', JSON.stringify(results, null, 2) + '\n');
}
console.log(`${results.filter(item => item.passed).length}/${results.length} frontend checks passed`);
if (results.some(item => !item.passed)) process.exitCode = 1;
