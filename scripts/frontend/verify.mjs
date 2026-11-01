import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';
import { familyEntries } from './fixtures.mjs';

const output = process.env.FRONTEND_OUTPUT ? resolve(process.env.FRONTEND_OUTPUT) + '/'
    : fileURLToPath(new URL('../../artifacts/frontend/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
const publicFamilies = parts => [{ primaryConditionID: 1, families: parts.map(([IDs, weightBasisPoints], index) => ({
    primaryConditionID: 1, familyID: IDs.length ? index + 1 : null,
    entries: familyEntries(IDs.map(conditionID => ({ conditionID }))),
    weightBasisPoints, overallWeightBasisPoints: weightBasisPoints * 0.26
})) }];

async function until(condition, message, timeout = 8000) {
    const end = Date.now() + timeout;
    while (!await condition()) { if (Date.now() > end) throw new Error(message); await delay(30); }
}
async function check(name, action, options = {}) {
    if (process.env.FRONTEND_CHECK && !name.includes(process.env.FRONTEND_CHECK)) return;
    const app = await startPreview(options);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', ...options.browser });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    try {
        await action({ app, page, context });
        assert.deepEqual(pageErrors, [], 'Uncaught browser errors');
        assert.ok(!page.url().includes('/dialogPage'), 'Unexpected global error redirect');
        results.push({ name, passed: true });
        console.log(`PASS ${name}`);
    } catch (error) {
        results.push({ name, passed: false, error: error.message, pageErrors });
        await page.screenshot({ path: output + name.replaceAll(/[^a-z0-9]+/gi, '-') + '-failure.png', fullPage: true }).catch(() => {});
        console.error(`FAIL ${name}: ${error.stack ?? error.message}`);
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
    await page.waitForFunction(() => !document.querySelector('#workspace-refresh').disabled
        && !document.querySelector('#last-updated').textContent.includes('Saving'));
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
            data.rankingPagination.personal = { total: 0, nextOffset: 0, hasMore: false };
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
    await page.waitForFunction(mode => document.querySelector(`#pie-mode-${mode}`)?.getAttribute('aria-selected') === 'true'
        && document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false'
        && !document.querySelector('.bp-pie-flip-face'), mode);
    assert.equal(await page.locator(`#pie-mode-${mode}`).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator(`#pie-mode-${mode === 'personal' ? 'public' : 'personal'}`).getAttribute('aria-selected'), 'false');
}

try {
    for (const width of [1440, 390, 320]) {
        await check(`public composition is read-only and reversible at ${width}px`, async ({ app, page }) => {
            await home(page, app);
            await page.locator('#pie-mode-public').click();
            assert.equal(await page.locator('#personal-pie-guidance').isVisible(), false);
            assert.equal(await page.locator('#public-pie-count').textContent(), '128 pies');
            const benchmarksBefore = await page.locator('#benchmark-rows').innerText();
            const modelsBefore = await page.locator('#model-rows').innerText();
            await page.locator('#public-composition-toggle').click();
            assert.equal(await page.locator('#weight-pie').isVisible(), false);
            assert.equal(await page.locator('#public-composition-pie').isVisible(), true);
            assert.equal(await page.locator('#inline-fallback').isVisible(), false);
            assert.equal(await page.locator('#public-composition-pie g[data-category-id]').count(), 3);
            const reasoning = page.locator('#public-composition-list button[data-category-id="2"]');
            assert.match(await reasoning.innerText(), /80 pies/);
            assert.match(await reasoning.innerText(), /62.5%/);
            await reasoning.click();
            assert.equal(await reasoning.getAttribute('aria-pressed'), 'true');
            assert.equal(await page.locator('#benchmark-rows').innerText(), benchmarksBefore);
            assert.equal(await page.locator('#model-rows').innerText(), modelsBefore);
            assert.equal(saves(app).length, 0);
            await noOverflow(page);
            const box = await page.locator('#public-composition-pie').boundingBox();
            assert.ok(Math.abs(box.width - box.height) <= 1, 'Composition pie must remain circular');
            await page.screenshot({ path: output + `public-composition-${width}.png`, fullPage: true });
            await page.locator('#public-composition-toggle').click();
            assert.equal(await page.locator('#weight-pie').isVisible(), true);
            await page.locator('#public-composition-toggle').click();
            await page.locator('#pie-mode-personal').click();
            await pieMode(page, 'personal');
            assert.equal(await page.locator('#public-pie-summary').isVisible(), false);
            assert.equal(await page.locator('#public-composition-pie').isVisible(), false);
            assert.equal(await page.locator('#personal-pie-guidance').isVisible(), true);
            await page.locator('#pie-mode-public').click();
            await pieMode(page, 'public');
            assert.equal(await page.locator('#public-composition-toggle').getAttribute('aria-expanded'), 'false');
        }, { browser: { viewport: { width, height: 1000 } } });
    }
    await check('empty public composition has no invented contributions', async ({ app, page }) => {
        await page.goto(app.url);
        await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
        assert.equal(await page.locator('#public-pie-count').textContent(), '0 pies');
        await page.locator('#public-composition-toggle').click();
        assert.equal(await page.locator('#public-composition-pie g[data-category-id]').count(), 0);
        assert.equal(await page.locator('#public-composition-list button').count(), 3);
        assert.match(await page.locator('#public-composition-list').innerText(), /0 pies/);
        await noOverflow(page);
    }, { empty: true });
    await check('short ranking URLs preserve context on reload and canonicalize old links', async ({ app, page }) => {
        await page.goto(app.url + '/Language-models?context_budget=extended');
        await page.waitForURL('**/Language-models?extended');
        assert.equal(app.state.requests.filter(request => request.path === '/api/get_weighted_workspace').at(-1).body.contextValues.budget, 'extended');
        await page.reload();
        await page.locator('.bp-benchmark-row').first().waitFor();
        assert.equal(new URL(page.url()).search, '?extended');
        await page.locator('.bp-template-control').hover();
        await page.getByRole('option', { name: 'Standard', exact: true }).click();
        await page.waitForURL('**/Language-models?standard');
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
        assert.match(await row.locator('.bp-benchmark-information-link').getAttribute('href'), /benchmarkID=101/);
        await row.locator('.bp-benchmark-information-link').click();
        await page.locator('#post-801').waitFor();
        assert.equal(await page.locator('#discussion-brand-slot .bp-brand').isVisible(), true);
        assert.equal(await page.locator('#workspace-brand-slot .bp-brand').count(), 0);
        assert.equal(await page.locator('#discussion-compose-fields').isVisible(), false);
        assert.ok((await page.locator('.discussion-scroll').boundingBox()).height > 750, 'Browsing should dominate the panel');
        assert.equal(app.state.requests.filter(request => request.path === '/api/get_discussion').at(-1).body.contextValues.budget, 'standard');
        assert.equal(new URL(page.url()).pathname, '/');
    });
    await check('discussion trades sidebar space without overlay and preserves drafts', async ({ app, page }) => {
        await home(page, app);
        assert.equal(await page.locator('#mission-banner').count(), 0);
        assert.equal(await page.getByText('Independent evaluation · Community priorities', { exact: true }).count(), 0);
        assert.equal(await page.locator('#welcome-dialog').count(), 0);
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
        fallbackRules: [{ primaryConditionID: 1, mode: 'ordered', entries: familyEntries([{ conditionID: 2 }]) }],
        publicFamilyComposition: publicFamilies([[ [2], 10000 ]])
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
            assert.deepEqual(style, { background: 'rgb(196, 81, 5)', color: 'rgb(255, 255, 255)', fontSize: '16px', fits: true });
            await button.hover();
            assert.deepEqual(await button.boundingBox(), initial, 'Hover must not shift or resize the CTA');
            await button.focus();
            await noOverflow(page);
            await page.screenshot({ path: output + `create-mix-entry-${width}.png`, fullPage: true });
            await button.click();
            await page.locator(width < 768 ? '#pie-empty-compact' : '#personal-empty-mode').waitFor();
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
        await check(`relative benchmark coverage drawer ${width}`, async ({ app, page }) => {
            await page.addInitScript(() => sessionStorage.setItem('benchpoll-workspace-preferences-v1', JSON.stringify({ groupBenchmarkVersions: true })));
            await home(page, app);
            const sparse = page.locator('#benchmark-low-rows .bp-benchmark-row');
            const other = page.locator('[aria-controls="benchmark-other-rows"]');
            const toggle = page.locator('[aria-controls="benchmark-low-rows"]');
            assert.equal(await page.locator('.bp-benchmark-row[data-condition-id="900"]').isVisible(), true, 'Ignore obsolete grouping preferences when not searching');
            await page.locator('#benchmark-search').fill('General');
            await toggle.waitFor();
            assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
            assert.match(await toggle.innerText(), /lower-coverage benchmark version/i);
            assert.equal(await sparse.isVisible(), false);
            assert.equal(await page.locator('.bp-benchmark-row').first().locator('.bp-benchmark-score-count').innerText(), '8 scores');
            assert.equal(await other.isVisible(), false, 'Do not nest a lower-coverage-only group in an empty other-versions group');
            assert.equal(await toggle.isVisible(), true);
            await toggle.click();
            await until(() => sparse.isVisible(), 'Sparse conditions did not load after expansion');
            assert.equal(await sparse.locator('.bp-benchmark-score-count').innerText(), '1 score');
            await page.screenshot({ path: output + `relative-coverage-${width}.png`, fullPage: true });
            await toggle.click();
            assert.equal(await sparse.isVisible(), false);
            const searched = page.waitForResponse(response => response.url().endsWith('/api/get_ranking_page')
                && response.request().postDataJSON()?.query === 'Experimental');
            await page.locator('#benchmark-search').fill('Experimental');
            await searched;
            const match = page.locator('.bp-benchmark-row[data-condition-id="900"]');
            await until(() => match.isVisible(), 'The dominant exact search match must be visible without expanding a group');
            assert.equal(await toggle.isVisible(), false);
            assert.match(await match.innerText(), /Experimental/);
            await noOverflow(page);
        }, { sparseBenchmark: true, browser: { viewport: { width, height: 900 } } });
    }
    await check('leaderboards load ranked pages and search beyond the first page', async ({ app, page }) => {
        await home(page, app);
        assert.equal(await page.locator('.bp-benchmark-row').count(), 40);
        assert.equal(await page.locator('.bp-model-row').count(), 25);
        assert.equal(await page.locator('.bp-benchmark-row').first().locator('.bp-benchmark-rank').innerText(), '1');
        await page.locator('#benchmark-rows').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await until(() => page.locator('.bp-benchmark-row').count().then(count => count >= 80), 'Second benchmark page missing');
        await page.locator('#benchmark-rows').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await until(() => page.locator('.bp-benchmark-row').count().then(count => count === 93), 'Final benchmark page missing');
        await page.locator('#benchmark-search').fill('Additional benchmark 72');
        await until(() => page.locator('.bp-benchmark-row').count().then(count => count === 1), 'Remote benchmark search missed an unloaded row');
        assert.match(await page.locator('.bp-benchmark-row').innerText(), /Additional benchmark 72/);
        await page.locator('#model-rows').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await until(() => page.locator('.bp-model-row').count().then(count => count >= 50), 'Second model page missing');
        assert.equal(await page.locator('.bp-model-row').nth(25).locator('.bp-model-rank').innerText(), '26');
        await page.locator('#pie-mode-personal').click();
        await page.locator('.bp-model-row').first().waitFor();
        assert.ok(app.state.requests.some(request => request.path === '/api/get_ranking_page' && request.body.list === 'personal'));
        assert.deepEqual(await page.locator('#model-rows .bp-model-rank').first().innerText(), '1');
    }, { rankingStress: true });
    await check('mobile page scrolling loads bounded ranking pages', async ({ app, page }) => {
        await home(page, app);
        assert.equal(await page.locator('.bp-benchmark-row').count(), 40);
        assert.equal(await page.locator('.bp-model-row').count(), 25);
        await page.locator('#benchmark-rows .bp-ranking-page-footer').scrollIntoViewIfNeeded();
        await until(() => page.locator('.bp-benchmark-row').count().then(count => count === 80), 'Mobile benchmark continuation missing');
        await delay(250);
        assert.equal(await page.locator('.bp-benchmark-row').count(), 80, 'Do not fetch off-screen benchmark pages');
        await page.evaluate(() => window.scrollTo(0, 0));
        await delay(100);
        await page.locator('[data-mobile-panel="models"]').click();
        await page.locator('#model-rows .bp-ranking-page-footer').scrollIntoViewIfNeeded();
        await until(() => page.locator('.bp-model-row').count().then(count => count === 50), 'Mobile model continuation missing');
        await delay(250);
        assert.equal(await page.locator('.bp-model-row').count(), 50, 'Do not fetch off-screen model pages');
    }, { rankingStress: true, browser: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } });
    for (const width of [1440, 390]) {
        await check(`dynamic model score scale ${width}`, async ({ app, page }) => {
            await page.route('**/api/get_weighted_workspace', async route => {
                const response = await route.fetch();
                const data = await response.json();
                const bounds = [[120, 150], [-50, 80], [30, 200]];
                data.modelLeaderboards.public = data.modelLeaderboards.public.slice(0, 3)
                    .map((model, i) => ({ ...model, lower: bounds[i][0], upper: bounds[i][1],
                        calculationScores: model.calculationScores.map(score => ({ ...score,
                            normalizedScore: bounds[i][0] * 100 / model.coverage,
                            contribution: bounds[i][0] * score.effectiveWeight / model.coverage })) }))
                    .sort((left, right) => right.lower - left.lower)
                    .map((model, index) => ({ ...model, rank: index + 1 }));
                data.modelLeaderboards.public[0].fallbackUsageCount = 1;
                data.rankingPagination.public = { total: 3, nextOffset: 3, hasMore: false };
                data.rankingPagination.modelScales.public = { min: -50, max: 200 };
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
                rangeWidth: parseFloat(row.querySelector('.bp-score-uncertain').style.width)
            })));
            assert.equal(await page.locator('.bp-score-zero').count(), 0, 'Score bars omit per-row zero-reference lines');
            assert.deepEqual(rows.map(row => row.score), ['120', '30', '-50']);
            const expected = [[20, 48, 68, 12], [20, 12, 32, 68], [0, 20, 0, 52]];
            rows.forEach((row, i) => {
                [row.knownLeft, row.knownWidth, row.rangeLeft, row.rangeWidth].forEach((value, j) => assert.ok(Math.abs(value - expected[i][j]) < 1e-8));
                assert.ok(row.rangeLeft + row.rangeWidth <= 100);
            });
            if (width === 390) await page.locator('[data-mobile-panel="models"]').click();
            await noOverflow(page);
            await page.screenshot({ path: output + `dynamic-model-scale-${width}.png`, fullPage: true });
            if (width === 1440) {
                await page.locator('#pie-mode-personal').click();
                await pieMode(page, 'personal');
                assert.equal(await page.locator('.bp-score-zero').count(), 0, 'Personal score bars also omit zero-reference lines');
            }
        }, { browser: { viewport: { width, height: 1000 } } });
    }
    for (const width of [1440, 390]) {
        await check(`available-score factor penalizes sparse results and fills the leading bar ${width}`, async ({ app, page }) => {
            await home(page, app);
            if (width === 390) await page.locator('[data-mobile-panel="models"]').click();
            const names = () => page.locator('.bp-model-row .bp-model-name').allTextContents();
            assert.equal((await names())[0], 'Full');
            await page.locator('[data-score-mode="available"]').click();
            await until(async () => await page.locator('[data-score-mode="available"]').getAttribute('aria-pressed') === 'true'
                && await page.locator('.bp-model-row').first().locator('.bp-score-known').evaluate(item => parseFloat(item.style.width)) === 100,
            'Available mode did not apply its relative bar scale');
            assert.equal((await names())[0], 'Full');
            assert.equal(await page.locator('.bp-model-row').first().locator('.bp-model-score').innerText(), '70');
            assert.equal(await page.locator('.bp-model-row').first().locator('.bp-model-coverage').getAttribute('role'), 'img');
            assert.equal(await page.locator('.bp-model-row').first().locator('.bp-model-coverage').textContent(), '');
            assert.match(await page.locator('.bp-model-row').filter({ has: page.locator('.bp-model-name', { hasText: /^Partial$/ }) }).locator('.bp-model-score').innerText(), /^48\b/);
            assert.equal(await page.locator('.bp-model-row').first().locator('.bp-score-known').evaluate(item => parseFloat(item.style.width)), 100);
            assert.equal(await page.locator('#model-first-bar-full').count(), 0);
            await page.locator('[data-score-mode="range"]').click();
            await until(async () => (await names())[0] === 'Full', 'Range mode did not restore the original order');
            assert.equal(await page.locator('.bp-model-row').first().locator('.bp-score-known').evaluate(item => parseFloat(item.style.width)), 70);
            await noOverflow(page);
            if (width === 390) await page.screenshot({ path: output + 'available-score-mobile.png', fullPage: true });
        }, { comparisonModels: [
            { ID: 1, modelID: 1, modelName: 'Partial', name: 'Partial', vendor: 'Example', vendorSlug: 'openai', condition: { parameters: {} },
                results: new Map([['1', { normalizedScore: 95 }]]) },
            { ID: 2, modelID: 2, modelName: 'Full', name: 'Full', vendor: 'Example', vendorSlug: 'openai', condition: { parameters: {} },
                results: new Map([['1', { normalizedScore: 70 }], ['2', { normalizedScore: 70 }], ['3', { normalizedScore: 70 }],
                    ['4', { normalizedScore: 70 }], ['5', { normalizedScore: 70 }], ['6', { normalizedScore: 70 }], ['7', { normalizedScore: 70 }]]) }
        ], browser: { viewport: { width, height: 844 } } });
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
        await page.getByText('Rename version?', { exact: true }).waitFor();
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
        await page.getByText('Rename version?', { exact: true }).waitFor();
        await page.locator('.global-system-dialog global-dialog-action').filter({ hasText: 'Confirm rename' }).click();
        await page.locator('[data-action="remove-profile"]').first().click();
        await page.getByText('This version is in use', { exact: true }).waitFor();
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
            await details.waitFor();
            assert.equal(await details.inputValue(), '');
            assert.match(await page.locator('#feedback-guidance').textContent(), /To merge.*benchmark #101/);
            await details.fill('Same object as benchmark #102.');
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
            await page.locator('#public-fallback-toggle').click();
            const chart = page.locator('#inline-fallback-chart');
            await chart.waitFor();
            assert.equal(await page.locator('#inline-fallback-guide').textContent(),
                'When General knowledge has no score, each fallback configuration uses its first available result.');
            assert.match(await chart.innerText(), /No fallback/);
            assert.equal(await chart.locator('.bp-family-composition-row').count(), 3);
            assert.equal(await chart.locator('.bp-family-composition-segment').count(), 3);
            assert.equal(await page.locator('#inline-fallback-personal-control').isVisible(), false);
            await chart.hover(); await page.mouse.wheel(0, -100); await delay(600);
            assert.equal(saves(app).length, 0);
            await noOverflow(page);
            await page.locator('#public-fallback-toggle').click();
            await chart.waitFor({ state: 'hidden' });
            await page.locator('#public-fallback-toggle').click();
            await page.locator('#weight-pie g[data-object-id="2"]').click();
            assert.equal(await chart.isVisible(), true);
            assert.equal(await page.locator('#public-fallback-toggle').getAttribute('aria-expanded'), 'true');
            assert.match(await chart.innerText(), /No fallback/);
            assert.equal(saves(app).length, 0);
        }, { authenticated: false, publicFamilyComposition: publicFamilies([[[2, 3], 5000], [[3], 2500], [[], 2500]]),
            browser: mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {} });
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
        const before = structuredClone({ entries: app.state.personalEntries, personal: app.state.fallbackRules, public: app.state.publicFamilyComposition });
        const toggle = page.locator('#public-fallback-toggle');
        const chart = page.locator('#inline-fallback-chart');
        const publicFallback = async expanded => {
            await pieMode(page, 'public');
            assert.equal(await toggle.isVisible(), true);
            assert.equal(await toggle.getAttribute('aria-expanded'), String(expanded));
            assert.equal(await toggle.innerText(), expanded ? 'Hide fallback configurations' : 'View fallback configurations');
            assert.equal(await chart.isVisible(), expanded);
            if (expanded) {
                const component = chart.locator('.bp-family-composition-row').filter({ hasText: 'Advanced reasoning' });
                assert.equal(await component.count(), 1, 'Fallback contents came from the wrong mode or context');
                assert.equal(await component.locator('.bp-family-summary > strong').textContent(), '75%');
            }
        };
        const personalFallback = async () => {
            await pieMode(page, 'personal');
            assert.equal(await toggle.isVisible(), false);
            const settings = page.locator('#inline-fallback-toggle');
            if (await settings.getAttribute('aria-expanded') === 'false') await settings.click();
            assert.equal(await settings.getAttribute('aria-expanded'), 'true');
            assert.equal(await chart.isVisible(), true, 'Personal settings visibility must be independent of Public');
            assert.equal(await chart.locator('.bp-family-member[data-condition-id="3"] .bp-family-member-name span').getAttribute('title'), 'Code generation');
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
        assert.deepEqual({ entries: app.state.personalEntries, personal: app.state.fallbackRules, public: app.state.publicFamilyComposition }, before);
    }, {
        fallbackRules: [{ primaryConditionID: 1, mode: 'ordered', entries: familyEntries([{ conditionID: 3 }]) }],
        publicFamilyComposition: publicFamilies([[[2], 7500], [[], 2500]])
    });
    await check('personal fallback folding persists across contexts without changing rules', async ({ app, page }) => {
        const rule = conditionID => [{ primaryConditionID: 1, mode: 'ordered', entries: familyEntries([{ conditionID }]) }];
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
        const settings = page.locator('#inline-fallback-toggle');
        const personalFallback = async (componentID, expanded) => {
            await pieMode(page, 'personal');
            assert.equal(await page.locator('#public-fallback-toggle').isVisible(), false);
            assert.equal(await page.locator('#inline-fallback-personal-control').isVisible(), true);
            assert.equal(await settings.getAttribute('aria-expanded'), String(expanded));
            assert.equal(await chart.isVisible(), expanded);
            if (expanded && componentID !== null) {
                assert.equal(await chart.locator('.bp-family-member').count(), 1);
                assert.equal(await chart.locator(`.bp-family-member[data-condition-id="${componentID}"]`).count(), 1);
            } else if (expanded) {
                assert.equal(await chart.locator('.bp-inline-fallback-empty').isVisible(), true);
            }
        };
        await page.locator('#weight-pie g[data-object-id="1"]').click();
        await personalFallback(3, false);
        await settings.click();
        await personalFallback(3, true);
        await page.locator('#pie-mode-public').click();
        await pieMode(page, 'public');
        assert.equal(await page.locator('#public-fallback-toggle').getAttribute('aria-expanded'), 'true');
        assert.equal(await chart.isVisible(), true, 'The previous public display preference should still load');
        await page.locator('#pie-mode-personal').click();
        await personalFallback(3, true);
        await page.locator('[data-category-id="2"]').click();
        await navigationWorkspace(page, 'Reasoning');
        await personalFallback(null, true);
        await navigationTemplate(page, 'Extended');
        await navigationWorkspace(page, 'Reasoning', 'Extended');
        await personalFallback(4, true);
        await navigationTemplate(page, 'Standard');
        await navigationWorkspace(page, 'Reasoning');
        await personalFallback(null, true);
        await parentBreadcrumb(page);
        await personalFallback(3, true);

        await settings.click();
        await personalFallback(3, false);
        await navigationTemplate(page, 'Extended');
        await navigationWorkspace(page, 'Language models', 'Extended');
        await personalFallback(2, false);
        await page.locator('[data-category-id="3"]').click();
        await navigationWorkspace(page, 'Coding');
        await personalFallback(2, false);
        await parentBreadcrumb(page);
        await personalFallback(3, false);

        await settings.click();
        await personalFallback(3, true);
        await page.locator('#inline-fallback-add-benchmark').click();
        assert.equal(await page.locator('#benchmark-card').evaluate(element => element.classList.contains('is-fallback-target-active')), true);
        await page.locator('[data-category-id="2"]').click();
        await navigationWorkspace(page, 'Reasoning');
        await personalFallback(null, true);
        await parentBreadcrumb(page);
        await personalFallback(3, true);
        await page.locator('#inline-fallback-add-benchmark').click();
        await navigationTemplate(page, 'Extended');
        await navigationWorkspace(page, 'Language models', 'Extended');
        await personalFallback(2, true);
        await navigationTemplate(page, 'Standard');
        await navigationWorkspace(page, 'Language models');
        await personalFallback(3, true);
        await page.reload();
        await navigationWorkspace(page, 'Language models');
        await personalFallback(3, true);
        assert.equal(saves(app).length, 0, 'Navigation and folding must not change saved fallback rules');
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
        await page.getByRole('button', { name: 'All scores', exact: true }).click();
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
        await page.getByText('No benchmarks found', { exact: true }).waitFor();
        assert.equal(await page.locator('#benchmark-rows').innerText(), 'No benchmarks found');
        await page.locator('#benchmark-search').fill('Reasoning');
        await page.locator('.bp-benchmark-row').first().waitFor();
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
        await page.locator('#inline-fallback-toggle').click();
        await page.locator('#inline-fallback-add-benchmark').click();
        await page.getByRole('button', { name: 'Add Advanced reasoning to Fallback', exact: true }).click();
        await waitSaved(page, app, 3);
        assert.equal(app.state.fallbackRules[0].primaryConditionID, 1);
        assert.equal(app.state.fallbackRules[0].entries[0].conditionID, 2);
        assert.equal(Object.hasOwn(app.state.fallbackRules[0].entries[0], 'weightBasisPoints'), false);
        await page.screenshot({ path: output + 'personal-fallback.png', fullPage: true });
        await page.locator('#inline-fallback-chart').getByRole('button', { name: 'Remove Advanced reasoning from fallback', exact: true }).click();
        await waitSaved(page, app, 4);
        assert.deepEqual(app.state.fallbackRules, []);
        await page.locator('#weight-pie g[data-object-id="1"]').click();
        await page.locator('#benchmark-personal-pin').click();
        assert.equal(await page.locator('#benchmark-personal-pin').getAttribute('aria-pressed'), 'true');
        await page.locator('.bp-benchmark-row').first().waitFor();
        app.state.saveDelay = 650;
        const rowCount = await page.locator('.bp-benchmark-row').count();
        const removedRowCount = await page.locator('.bp-benchmark-row[data-condition-id="1"]').count();
        await page.getByRole('button', { name: 'Remove General knowledge from Personal Weights', exact: true }).click();
        assert.equal(await page.locator('.bp-benchmark-row').count(), rowCount - removedRowCount);
        assert.equal(await page.locator('.bp-benchmark-row').first().locator('.bp-benchmark-name').innerText(), 'Advanced reasoning');
        assert.ok(app.state.personalEntries.some(item => item.conditionID === 1), 'Row must move before the server saves');
        await waitSaved(page, app, 5);
        assert.ok(!app.state.personalEntries.some(item => item.conditionID === 1));
        assert.equal(app.state.personalEntries.reduce((sum, entry) => sum + entry.weightBasisPoints, 0), 10000);
        assert.equal(await page.locator('.bp-benchmark-row').count(), rowCount - removedRowCount);
        await page.locator('#workspace-undo').click();
        await waitSaved(page, app, 6);
        assert.equal(await page.locator('.bp-benchmark-row').count(), rowCount);
    });

    await check('personal focus switches in one click and selected pie slices reveal their rows', async ({ app, page }) => {
        await home(page, app);
        await page.locator('#pie-mode-personal').click();
        await page.locator('.bp-benchmark-row[data-condition-id="1"]').click();
        assert.equal(await page.locator('#pie-adjustment-status').isVisible(), true);
        assert.match(await page.locator('#pie-adjustment-status').innerText(), /General knowledge/);
        await page.screenshot({ path: output + 'personal-adjustment-status.png', fullPage: true });
        await page.locator('.bp-benchmark-row[data-condition-id="2"]').click();
        assert.equal(await page.locator('.bp-benchmark-row[data-condition-id="2"].selected').count(), 1);
        assert.equal(await page.locator('.bp-benchmark-row[data-condition-id="1"].is-muted').count(), 1);
        await page.locator('.bp-benchmark-row[data-condition-id="2"]').click();
        assert.equal(await page.locator('#pie-adjustment-status').isVisible(), false);
        await page.locator('#benchmark-rows').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await page.locator('#weight-pie g[data-object-id="1"]').click();
        assert.equal(await page.locator('#pie-adjustment-status').isVisible(), true);
        assert.equal(await page.locator('#pie-adjustment-status').evaluate(node => getComputedStyle(node).position), 'fixed');
        assert.match(await page.locator('#pie-adjustment-instruction').innerText(), /Scroll over pie/);
        await page.waitForFunction(() => {
            const row = document.querySelector('.bp-benchmark-row[data-condition-id="1"]');
            const viewport = document.querySelector('#benchmark-rows');
            const a = row.getBoundingClientRect(), b = viewport.getBoundingClientRect();
            return a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
        });
        await page.locator('#pie-mode-public').click();
        assert.equal(await page.locator('#pie-adjustment-status').isVisible(), false);
        await page.locator('#benchmark-rows').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await page.locator('#weight-pie g[data-object-id="1"]').click();
        await page.waitForFunction(() => {
            const row = document.querySelector('.bp-benchmark-row[data-condition-id="1"]');
            const viewport = document.querySelector('#benchmark-rows');
            const a = row.getBoundingClientRect(), b = viewport.getBoundingClientRect();
            return a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
        });
        await page.locator('#weight-pie g[data-object-id="6"] .bp-pie-slice').hover();
        assert.match(await page.locator('#pie-hover-tooltip').innerText(), /Long context/);
    });

    await check('selecting a pie slice loads and reveals an unpaged benchmark row', async ({ app, page }) => {
        let deferredBenchmark;
        await page.route('**/api/get_weighted_workspace', async route => {
            const response = await route.fetch();
            const data = await response.json();
            deferredBenchmark = data.benchmarks.find(item => item.ID === 6);
            data.benchmarks = data.benchmarks.filter(item => item.ID !== 6);
            data.rankingPagination.benchmarks.primary.nextOffset -= 1;
            await route.fulfill({ response, json: data });
        });
        await page.route('**/api/get_ranking_page', async route => {
            const response = await route.fetch();
            const data = await response.json();
            const request = route.request().postDataJSON();
            if (request.list === 'benchmarks' && request.offset === 39) {
                data.items[0] = deferredBenchmark;
            }
            await route.fulfill({ response, json: data });
        });
        await home(page, app);
        assert.equal(await page.locator('.bp-benchmark-row[data-condition-id="6"]').count(), 0);
        await page.locator('#weight-pie g[data-object-id="6"]').click();
        await page.locator('.bp-benchmark-row[data-condition-id="6"]').waitFor();
        await page.waitForFunction(() => {
            const row = document.querySelector('.bp-benchmark-row[data-condition-id="6"]');
            const viewport = document.querySelector('#benchmark-rows');
            const bounds = row.getBoundingClientRect(), visible = viewport.getBoundingClientRect();
            return bounds.top >= visible.top - 1 && bounds.bottom <= visible.bottom + 1;
        });
    }, { rankingStress: true });

    await check('edits made while a pie save is in flight are serialized without a visual rollback', async ({ app, page }) => {
        await home(page, app);
        await page.locator('#pie-mode-personal').click();
        await page.locator('.bp-benchmark-row[data-condition-id="1"]').click();
        app.state.saveDelay = 650;
        const originalWeight = app.state.personalEntries.find(entry => entry.conditionID === 1).weightBasisPoints;
        await page.getByRole('button', { name: 'Remove Mathematics from Personal Weights', exact: true }).click();
        await until(() => saves(app).length === 1, 'First save did not start');
        await page.locator('#weight-pie').hover();
        await page.mouse.wheel(0, -100);
        await page.waitForTimeout(60);
        assert.equal(await page.locator('#pie-adjustment-status').isVisible(), true);
        assert.equal(await page.locator('.bp-benchmark-row[data-condition-id="4"]').count(), 0);
        await until(() => saves(app).length >= 2 && app.state.revision >= 3, 'Queued edit did not save', 6000);
        assert.equal(app.state.personalEntries.some(entry => entry.conditionID === 4), false);
        assert.notEqual(app.state.personalEntries.find(entry => entry.conditionID === 1).weightBasisPoints, originalWeight);
        assert.equal(saves(app)[1].body.expectedRevision, 2);
        assert.equal(saves(app)[1].body.entries.some(entry => entry.conditionID === 4), false);
        await page.waitForFunction(() => document.querySelector('#last-updated')?.textContent !== 'Saving your pie…');
        assert.equal(await page.locator('.bp-benchmark-row[data-condition-id="4"]').count(), 0);
    });

    await check('save failure keeps the draft and retries safely; conflicts require review', async ({ app, page }) => {
        const identities = [];
        page.on('request', request => {
            if (request.url().endsWith('/api/save_personal_pie')) identities.push(request.headers()['idempotency-key']);
        });
        await home(page, app);
        await page.locator('#pie-mode-personal').click();
        const original = structuredClone(app.state.personalEntries);
        app.state.saveDelay = 650;
        const rowCount = await page.locator('.bp-benchmark-row').count();
        app.state.saveFailure = 500;
        await page.getByRole('button', { name: 'Remove General knowledge from Personal Weights', exact: true }).click();
        assert.equal(await page.locator('.bp-benchmark-row').count(), rowCount - 1);
        assert.ok(app.state.personalEntries.some(item => item.conditionID === 1), 'Failure must not delay the initial row removal');
        await page.locator('#model-rows').getByText('Could not confirm saving. Your changes are kept; retry to confirm.', { exact: true }).waitFor();
        assert.deepEqual(app.state.personalEntries, original);
        assert.equal(await page.locator('.bp-personal-weight-remove').count(), 3);
        assert.equal(await page.locator('.bp-benchmark-row').count(), rowCount - 1);
        assert.equal(await page.locator('#model-rows .bp-model-row').count() > 0, true);
        app.state.saveFailure = null;
        await page.getByRole('button', { name: 'Retry save', exact: true }).click();
        await waitSaved(page, app, 1);
        assert.equal(app.state.personalEntries.some(entry => entry.conditionID === 1), false);
        assert.ok(identities[0]);
        assert.equal(identities[0], identities[1]);
        app.state.saveFailure = 409;
        const initialLoads = app.state.requests.filter(item => item.path === '/api/get_weighted_workspace').length;
        await page.getByRole('button', { name: 'Remove Advanced reasoning from Personal Weights', exact: true }).click();
        await page.getByRole('button', { name: 'Review saved pie', exact: true }).waitFor();
        assert.equal(app.state.requests.filter(item => item.path === '/api/get_weighted_workspace').length, initialLoads);
        assert.equal(await page.locator('.bp-personal-weight-remove').count(), 2);
        assert.equal(app.state.personalEntries.length, 3);
        app.state.saveFailure = null;
        await page.getByRole('button', { name: 'Review saved pie', exact: true }).click();
        await page.locator('#guest-draft-notice').waitFor({ state: 'visible' });
        assert.equal(await page.locator('.bp-personal-weight-remove').count(), 2);
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

    await check('guest login entry without a welcome overlay', async ({ app, page }) => {
        await home(page, app);
        assert.equal(await page.locator('#login-button').isVisible(), true);
        assert.equal(await page.locator('#contribute-button').isVisible(), false);
        assert.equal(await page.locator('#personal-pie-create').isVisible(), true);
        assert.equal(await page.locator('#welcome-overlay').count(), 0);
        await page.locator('#personal-pie-create').click();
        assert.equal(saves(app).length, 0);
    }, { authenticated: false });

    await check('guest weights preview, survive reload, and require explicit account save', async ({ app, page }) => {
        await home(page, app);
        const publicRanking = await page.locator('#model-rows').innerText();
        await page.locator('#personal-pie-create').click();
        await page.locator('.bp-benchmark-row:not(.is-family) .bp-benchmark-add').first().click();
        await until(() => app.state.requests.some(request => request.path === '/api/get_weighted_workspace'
            && request.body.previewPersonalPie?.entries.length === 1), 'Guest preview was not calculated');
        await page.locator('#guest-draft-notice').waitFor({ state: 'visible' });
        assert.match(await page.locator('#guest-draft-notice').innerText(), /Sign in to save/);
        assert.equal(saves(app).length, 0);
        assert.equal(await page.locator('#model-rows .bp-model-row').count() > 0, true);
        await page.screenshot({ path: output + 'guest-preview-desktop.png', fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await noOverflow(page);
        await page.screenshot({ path: output + 'guest-preview-mobile.png', fullPage: true });
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.locator('#pie-mode-public').click();
        await pieMode(page, 'public');
        await page.locator('#model-rows .bp-model-row').first().waitFor();
        assert.equal(await page.locator('#model-rows').innerText(), publicRanking);
        await page.reload();
        await page.locator('#guest-draft-notice').waitFor({ state: 'visible' });
        assert.equal(saves(app).length, 0);
        app.state.authenticated = true;
        await page.reload();
        await page.locator('#guest-draft-notice').waitFor({ state: 'visible' });
        assert.match(await page.locator('#guest-draft-notice').innerText(), /replace your weights/);
        assert.equal(saves(app).length, 0);
        await page.locator('#guest-draft-save').click();
        await until(() => saves(app).length === 1 && app.state.revision === 2, 'Explicit save did not persist');
        await page.locator('#guest-draft-notice').waitFor({ state: 'hidden' });
    }, { authenticated: false });

    await check('guest wheel, fallback, and context drafts remain read-only previews', async ({ app, page }) => {
        await home(page, app);
        await page.locator('#personal-pie-create').click();
        await page.locator('.bp-benchmark-row:not(.is-family)').first().locator('.bp-benchmark-add').click();
        await until(() => app.state.requests.some(request => request.body.previewPersonalPie?.entries.length === 1), 'First guest preview missing');
        await page.locator('.bp-benchmark-row:not(.is-family)').nth(1).locator('.bp-benchmark-add').click();
        await until(() => app.state.requests.some(request => request.body.previewPersonalPie?.entries.length === 2), 'Second guest preview missing');
        const beforeWheel = app.state.requests.filter(request => request.body.previewPersonalPie).at(-1).body.previewPersonalPie;
        await page.locator('#weight-pie').hover();
        await page.mouse.wheel(0, -100);
        await until(() => app.state.requests.filter(request => request.body.previewPersonalPie).some(request => (
            request.body.previewPersonalPie.entries.length === 2
            && request.body.previewPersonalPie.entries[1].weightBasisPoints > beforeWheel.entries[1].weightBasisPoints
        )), 'Guest wheel adjustment was not previewed');
        await page.locator('#inline-fallback-toggle').click();
        await page.locator('#inline-fallback-add-benchmark').click();
        await page.locator('.bp-benchmark-row:not(.is-family)').nth(2).locator('.bp-benchmark-add').click();
        await until(() => app.state.requests.some(request => request.body.previewPersonalPie?.fallbackRules.length === 1), 'Guest fallback preview missing');
        await navigationTemplate(page, 'Extended');
        await navigationWorkspace(page, 'Language models', 'Extended');
        assert.equal(await page.locator('#guest-draft-notice').isVisible(), false);
        await navigationTemplate(page, 'Standard');
        await navigationWorkspace(page, 'Language models', 'Standard');
        await page.locator('#guest-draft-notice').waitFor({ state: 'visible' });
        assert.equal(saves(app).length, 0);
    }, { authenticated: false });

    await check('empty workspace', async ({ app, page }) => {
        await page.goto(app.url);
        await page.getByText('No benchmarks found', { exact: true }).waitFor();
        await page.getByText('No Public Weights are available in this context yet.', { exact: true }).waitFor();
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
                await page.getByRole('button', { name: 'All scores', exact: true }).click();
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

    const modes = ['new_benchmark', 'new_model', 'benchmark_result', 'correct_or_add_info', 'feedback', 'edit_benchmark', 'edit_model', 'edit_result'];
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
        assert.equal(await page.locator('#contribution-tree').count(), 0);
        assert.equal(await page.locator('.contribution-sidebar-actions').isVisible(), true);
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
        await page.locator('#weight-pie g[data-object-id="1"]').tap();
        assert.equal(await page.locator('#pie-adjustment-status').isVisible(), true);
        assert.match(await page.locator('#pie-adjustment-instruction').innerText(), /Swipe on the pie/);
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
