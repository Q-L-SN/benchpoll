import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
import { workspace } from '../scripts/frontend/fixtures.mjs';
import { topicPreviewComparison } from '../topic-home-service.js';
import { buildHomeAssets } from '../scripts/build-home-assets.mjs';
import { createHomeAssetRenderer } from '../home-assets.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const outputBase = resolve(process.env.HOME_MODEL_FOCUS_ARTIFACTS ?? resolve(tmpdir(), 'benchpoll-home-model-focus'));
await mkdir(outputBase, { recursive: true });
const builtRoot = await mkdtemp(resolve(outputBase, 'build-'));
await mkdir(resolve(builtRoot, 'private'), { recursive: true });
for (const path of ['public/js', 'public/css', 'public/vendor/fontawesome/css', 'private/home.html', 'private/index.html']) {
    await cp(resolve(root, path), resolve(builtRoot, path), { recursive: true });
}
const builtPages = {};
for (const pageName of ['home', 'index']) {
    await buildHomeAssets(builtRoot, { pageName });
    const render = createHomeAssetRenderer(builtRoot, { pageName });
    await render({ set() {}, type() { return this; }, send(value) { builtPages[pageName] = value.toString(); },
        sendFile() { throw new Error('Built asset renderer fell back to source'); } });
    assert.match(builtPages[pageName], new RegExp(`/build/${pageName}/entry-`));
}
const results = [];
for (const [engine, launcher] of [['chrome-for-testing', chromium], ['webkit', webkit]]) {
for (const build of ['source', 'built']) {
const output = resolve(outputBase, engine, build);
await mkdir(output, { recursive: true });
const browser = await launcher.launch({ headless: true, env: { ...process.env,
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
const app = await startPreview({ authenticated: true, rankingStress: true });
const storageKey = 'benchpoll-comparison-settings-v1:1';
const savedComparison = JSON.stringify({ experimental: false, basic: { mode: 'best', keys: ['model', 'field:1'], filters: [] } });
const newContext = async options => {
    const context = await browser.newContext(options);
    if (build === 'built') await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (request.resourceType() === 'document' && ['/', '/Intelligence', '/language-models', '/personal/1'].includes(url.pathname)) {
            return route.fulfill({ contentType: 'text/html', body: builtPages[url.pathname === '/' ? 'index' : 'home'] });
        }
        if (url.pathname.startsWith('/build/')) {
            const path = resolve(builtRoot, 'public', '.' + url.pathname);
            return route.fulfill({ contentType: extname(path) === '.css' ? 'text/css' : 'text/javascript', body: await readFile(path) });
        }
        return route.continue();
    });
    return context;
};

async function ready(page) {
    await page.waitForFunction(() => document.querySelector('#model-ranking-status')?.dataset.phase === 'ready'
        && document.querySelectorAll('#model-rows [data-model-focus-id]').length > 0);
}
async function targetVisible(page, target) {
    await page.waitForFunction(target => {
        const row = [...document.querySelectorAll('[data-model-focus-id]')].find(row => row.dataset.modelFocusId === target);
        if (!row || !row.classList.contains('is-model-jump-focus')) return false;
        const bounds = row.getBoundingClientRect(), viewport = document.querySelector('#model-rows').getBoundingClientRect();
        return bounds.top >= Math.max(0, viewport.top) - 1 && bounds.bottom <= Math.min(innerHeight, viewport.bottom) + 1;
    }, target);
}

try {
    for (const authenticated of [true, false]) {
        app.state.authenticated = authenticated;
        const context = await newContext({ viewport: { width: 1440, height: 960 } });
        const page = await context.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const start = app.state.requests.length;
        try {
            await page.goto(app.url + '/Intelligence');
            await ready(page);
            assert.deepEqual(errors, [], 'Ordinary no-focus workspaces must start without exceptions');
            assert.equal(app.state.requests.slice(start).some(request => request.path === '/api/locate_ranking_model'), false);
            assert.equal(await page.locator('#model-focus-styles').count(), 0);
            assert.equal(await page.locator('.is-model-jump-focus').count(), 0);
            console.log(`PASS no-intent startup (${authenticated ? 'account' : 'guest'})`);
        } finally { await context.close(); }
    }
    app.state.authenticated = true;

    for (const [name, viewport, reducedMotion] of [
        ['desktop', { width: 1440, height: 960 }, 'no-preference'],
        ['mobile', { width: 390, height: 844 }, 'no-preference'],
        ['reduced', { width: 320, height: 740 }, 'reduce']
    ]) {
        const context = await newContext({ viewport, reducedMotion, hasTouch: viewport.width < 500 });
        await context.addInitScript(({ key, value }) => {
            localStorage.setItem(key, value);
            sessionStorage.setItem('benchpoll-workspace-preferences-v1', JSON.stringify({ mode: 'personal', scoreMode: 'available' }));
        }, { key: storageKey, value: savedComparison });
        const page = await context.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.setDefaultTimeout(10000);
        const start = app.state.requests.length;
        try {
            await page.goto(app.url + '/Intelligence?focusModel=2040&scoreMode=range&compareReasoning=0&compareHarness=0&mode=public');
            await ready(page);
            await targetVisible(page, '2040');
            const focused = page.locator('[data-model-focus-id="2040"]');
            assert.equal(await focused.getAttribute('data-rank'), '48');
            assert.equal(await focused.evaluate(node => getComputedStyle(node).animationName), reducedMotion === 'reduce' ? 'none' : 'bp-model-jump-focus');
            assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), savedComparison);
            const query = new URL(page.url()).searchParams;
            for (const key of ['focusModel', 'scoreMode', 'compareReasoning', 'compareHarness', 'mode']) assert.equal(query.has(key), false);
            const requests = app.state.requests.slice(start);
            const firstWorkspace = requests.find(request => request.path === '/api/get_weighted_workspace');
            assert.equal(firstWorkspace.body.scoreMode, 'range', 'The first request must use Home scoring, not saved preferences');
            assert.equal(firstWorkspace.body.initialMode, 'public');
            assert.deepEqual(firstWorkspace.body.homeComparison, { reasoning: false, harness: false });
            assert.equal(requests.filter(request => request.path === '/api/locate_ranking_model').length, 1);
            assert.equal(requests.filter(request => request.path === '/api/get_ranking_page' && request.body.list === 'public').length, 0);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            await page.screenshot({ path: resolve(output, `${name}-list-focus.png`), fullPage: true });
            await page.getByRole('button', { name: 'Next models', exact: true }).click();
            await page.locator('.bp-model-focus-pagination').getByText('51-66 / 66', { exact: true }).waitFor();
            await page.getByRole('button', { name: 'Previous models', exact: true }).click();
            await page.locator('.bp-model-focus-pagination').getByText('26-50 / 66', { exact: true }).waitFor();
            await page.getByRole('button', { name: 'Top of ranking', exact: true }).click();
            await page.locator('.bp-model-focus-pagination').waitFor({ state: 'detached' });
            assert.equal(await page.locator('#model-rows [data-model-focus-id]').first().getAttribute('data-rank'), '1');
            assert.equal(await page.locator('#model-rows [data-model-focus-id]').count(), 25);
            assert.deepEqual(errors, []);
            console.log(`PASS ${name}: bounded deep page, exact rank, URL cleanup, unchanged preferences, page navigation`);
        } catch (error) {
            await page.screenshot({ path: resolve(output, `${name}-failure.png`), fullPage: true });
            console.error(JSON.stringify({ name, errors, messages: await page.locator('.bp-model-focus-status').allTextContents() }));
            throw error;
        } finally { await context.close(); }
    }

    for (const width of [1440, 390]) {
    const chartContext = await newContext({ viewport: { width, height: 844 } });
    const chartPage = await chartContext.newPage(), chartErrors = [];
    chartPage.on('pageerror', error => chartErrors.push(error.message));
    await chartPage.route('**/__model-focus-chart', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
        <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" href="/vendor/fontawesome/css/all.min.css">
        <link rel="stylesheet" href="/css/ui/tokens.css"><link rel="stylesheet" href="/css/ui/workspace.css">
        <link rel="stylesheet" href="/css/ui/chart-workspace.css">
        <style>body{margin:20px}#model-card{width:100%;max-width:1000px}#model-rows{height:650px;max-height:650px}.bp-model-chart-scroll{max-width:100%}</style>
        <body data-current-view="composition"><div id="composition">Composition</div><main id="model-card" hidden><div class="bp-model-viewport"><div id="model-ranking-status" hidden></div><div id="model-rows"></div></div></main>` }));
    try {
        await chartPage.goto(app.url + '/__model-focus-chart');
        const progress = await chartPage.evaluate(async () => {
            const { createWorkspaceState } = await import('/js/workspace/state.js');
            const { createModelListView } = await import('/js/workspace/model-list.js');
            const { createHomeModelFocus, readHomeModelFocusIntent } = await import('/js/workspace/model-focus.js');
            const { postJSON } = await import('/js/shared/http.js');
            const payload = await postJSON('/api/get_weighted_workspace', { categoryID: 1, initialMode: 'public', scoreMode: 'range' });
            const state = Object.assign(createWorkspaceState(), { categoryID: 1, mode: 'public', scoreMode: 'range', userID: payload.userID,
                modelLeaderboards: payload.modelLeaderboards, rankingPagination: payload.rankingPagination,
                comparisonRequest: payload.comparison, comparison: payload.comparison, rankingVersion: 1, workspaceDisplay: 'charts' });
            const rows = document.getElementById('model-rows');
            const view = createModelListView({ state, modelRows: rows, openApprovedModelResults() {}, onNeedMore() {} });
            view.renderModels();
            const focus = createHomeModelFocus({ intent: readHomeModelFocusIntent(location.origin + '/topic?focusModel=2040&scoreMode=range'),
                state, rows, view, request: postJSON,
                showRanking() { document.body.dataset.currentView = 'ranking'; document.getElementById('composition').hidden = true; document.getElementById('model-card').hidden = false; },
                onMessage(message) { if (message) throw new Error(message); } });
            await focus.reveal();
            globalThis.__homeFocusChartTest = { state, view, focus };
            return { depth: state.rankingPagination.public.nextOffset, offset: view.getFocusPage()?.offset };
        });
        assert.deepEqual(progress, { depth: 25, offset: 25 });
        await chartPage.waitForFunction(() => {
            const target = document.querySelector('[data-model-focus-id="2040"]');
            const bounds = target?.getBoundingClientRect(), scroll = document.querySelector('.bp-model-chart-scroll');
            const viewport = scroll?.getBoundingClientRect();
            return bounds && bounds.left >= viewport.left && bounds.right <= viewport.right + 1 && scroll.scrollLeft > 0;
        });
        assert.equal(await chartPage.locator('.bp-model-column.is-model-jump-focus').count(), 1);
        assert.equal(await chartPage.locator('.bp-model-column').count(), 25);
        assert.equal(await chartPage.locator('body').getAttribute('data-current-view'), 'ranking');
        assert.deepEqual(chartErrors, []);
        await chartPage.screenshot({ path: resolve(output, `${width}-chart-focus.png`), fullPage: true });
        console.log('PASS chart: exact horizontal target focus, bounded target page, continuous prefix untouched');
    } finally { await chartContext.close(); }
    }

    app.state.comparisonFields = [{ ID: 1, name: 'Harness', type: 'enum', allowEmpty: false, excludeMissing: true,
        options: [{ ID: 11, label: 'Standard', excluded: false }, { ID: 12, label: 'Agent', excluded: false }] },
    { ID: 20, name: 'Effort', type: 'enum', allowEmpty: false, excludeMissing: true,
        options: [{ ID: 201, label: 'High', excluded: false }, { ID: 202, label: 'Low', excluded: false }] }];
    app.state.comparisonModels = Array.from({ length: 80 }, (_, index) => ({ ID: 5000 + index, modelID: 1000 + Math.floor(index / 2),
        modelName: 'Repeated model name', name: 'Repeated model name', vendor: 'Synthetic', vendorSlug: 'openai',
        condition: { name: '', parameters: { 'field:1': index % 2 ? 12 : 11, 'field:20': index % 2 ? 202 : 201 },
            scoreFields: [{ fieldID: 1, value: index % 2 ? 12 : 11 }, { fieldID: 20, value: index % 2 ? 202 : 201 }] },
        results: new Map(Array.from({ length: 8 }, (_, condition) => [String(condition + 1), { normalizedScore: 100 - index * .7 }])) }));
    const identityContext = await newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
    await identityContext.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: storageKey, value: savedComparison });
    const identityPage = await identityContext.newPage(), identityErrors = [];
    identityPage.on('pageerror', error => identityErrors.push(error.message));
    const comparisonIdentity = JSON.stringify([['field:20', true, 202], ['model', true, 1031]]);
    try {
        await identityPage.goto(app.url + '/Intelligence?focusModel=' + encodeURIComponent(comparisonIdentity)
            + '&scoreMode=range&compareReasoning=1&compareHarness=0&mode=public');
        await identityPage.locator('.is-model-jump-focus').waitFor();
        assert.equal(await identityPage.locator('.is-model-jump-focus').getAttribute('data-comparison-identity'), comparisonIdentity);
        assert.equal(await identityPage.locator('.is-model-jump-focus').getAttribute('data-rank'), '64');
        assert.equal(await identityPage.locator('[data-quick-comparison="reasoning"]').getAttribute('aria-pressed'), 'true');
        assert.equal(await identityPage.locator('[data-quick-comparison="harness"]').getAttribute('aria-pressed'), 'false');
        assert.equal(await identityPage.evaluate(key => localStorage.getItem(key), storageKey), savedComparison);
        await identityPage.locator('[data-quick-comparison="reasoning"]').click();
        await identityPage.waitForFunction(key => JSON.parse(localStorage.getItem(key))?.basic?.keys?.join() === 'model', storageKey);
        await ready(identityPage);
        assert.equal(await identityPage.locator('.is-model-jump-focus').count(), 0);
        assert.deepEqual(identityErrors, []);
        console.log('PASS exact comparison identity: correct effort variant, temporary controls, explicit preference edit');
    } finally { await identityContext.close(); }
    for (const isPrivate of [false, true]) {
        app.state.isPrivate = isPrivate;
        const width = isPrivate ? 390 : 1440;
        const context = await newContext({ viewport: { width, height: 960 }, reducedMotion: 'reduce', hasTouch: isPrivate });
        await context.addInitScript(({ key, value }) => {
            localStorage.setItem(key, value);
            sessionStorage.setItem('benchpoll-workspace-preferences-v1', JSON.stringify({ mode: 'personal', scoreMode: 'available' }));
        }, { key: storageKey, value: savedComparison });
        const topic = { ID: 1, categoryID: 1, name: isPrivate ? 'Private ranking' : 'Language models',
            categoryName: isPrivate ? 'Private ranking' : 'Language models', slug: 'language-models',
            url: isPrivate ? '/personal/1?source=home' : '/language-models?source=home',
            isPrivate, isMine: true, configured: true, creator: { name: 'Preview account' } };
        await context.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (route.request().resourceType() === 'document' && ['/', '/language-models', '/personal/1'].includes(url.pathname)) {
                return route.fulfill({ contentType: 'text/html', body: build === 'built' ? builtPages[url.pathname === '/' ? 'index' : 'home']
                    : await readFile(resolve(root, `private/${url.pathname === '/' ? 'index' : 'home'}.html`), 'utf8') });
            }
            return route.fallback();
        });
        await context.route('**/api/get_topics', route => route.fulfill({ json: { topics: [topic], featuredTopicID: 1 } }));
        await context.route('**/api/get_private_category', route => route.fulfill({ json: topic }));
        await context.route('**/api/get_topic_preview', route => {
            const body = route.request().postDataJSON();
            const comparison = topicPreviewComparison(app.state.comparisonFields, { reasoning: body.reasoning, harness: body.harness });
            const payload = workspace(app.state, { ...body, comparison }, { paginate: false });
            const models = payload.modelLeaderboards[isPrivate ? 'personal' : 'public'].map((model, index) => ({ ...model, rank: index + 1 }));
            const offset = body.offset ?? 0, nextOffset = Math.min(models.length, offset + 25);
            return route.fulfill({ json: { topicID: 1, models: models.slice(offset, nextOffset), comparison: payload.comparison,
                weights: (isPrivate ? payload.personalPie : payload.publicPie).entries, scoreScale: payload.scoreScale,
                contextValues: payload.context.contextValues,
                pagination: { snapshotID: 'home-model-focus-preview', total: models.length, nextOffset, hasMore: nextOffset < models.length } } });
        });
        const page = await context.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.setDefaultTimeout(10000);
        try {
            await page.goto(app.url + '/');
            if (isPrivate) await page.locator('#topics-configured').click();
            await page.evaluate(() => scrollTo(0, document.getElementById('home-hero').getBoundingClientRect().bottom + scrollY + 24));
            await page.locator('#topics-score-toggle').click();
            await page.locator('[data-comparison="reasoning"]').click();
            await page.locator('[data-comparison="harness"]').click();
            const card = page.locator('.th-card[data-topic-id="1"]');
            await page.waitForFunction(() => document.querySelector('.th-model')?.href.includes('compareReasoning=1')
                && document.querySelector('.th-model')?.href.includes('compareHarness=1'));
            for (let attempt = 0; attempt < 5 && !await card.locator('.th-model[data-rank="64"]').count(); attempt++) {
                const count = await card.locator('.th-model').count();
                const response = page.waitForResponse(response => response.url().endsWith('/api/get_topic_preview')
                    && response.request().postDataJSON().offset > 0);
                await card.locator('.th-model-scroll').evaluate(scroll => { scroll.scrollLeft = scroll.scrollWidth; scroll.dispatchEvent(new Event('scroll')); });
                await response;
                await page.waitForFunction(count => document.querySelectorAll('.th-model').length > count, count);
            }
            const link = card.locator('.th-model[data-rank="64"]');
            const target = await link.getAttribute('data-model-key');
            const href = new URL(await link.getAttribute('href'), app.url);
            assert.equal(href.searchParams.get('focusModel'), target);
            assert.equal(href.searchParams.get('mode'), isPrivate ? 'personal' : 'public');
            const start = app.state.requests.length;
            await link.click();
            await ready(page);
            await page.waitForFunction(target => document.querySelector('.is-model-jump-focus')?.dataset.comparisonIdentity === target, target);
            assert.equal(await page.locator('.is-model-jump-focus').getAttribute('data-rank'), '64');
            assert.equal(await page.locator('[data-quick-comparison="reasoning"]').getAttribute('aria-pressed'), 'true');
            assert.equal(await page.locator('[data-quick-comparison="harness"]').getAttribute('aria-pressed'), 'true');
            assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), savedComparison);
            const requests = app.state.requests.slice(start);
            const first = requests.find(request => request.path === '/api/get_weighted_workspace');
            assert.equal(first.body.scoreMode, 'range');
            assert.equal(first.body.initialMode, isPrivate ? 'personal' : 'public');
            assert.deepEqual(first.body.homeComparison, { reasoning: true, harness: true });
            const locate = requests.filter(request => request.path === '/api/locate_ranking_model');
            assert.equal(locate.length, 1);
            assert.equal(locate[0].body.list, isPrivate ? 'personal' : 'public');
            assert.equal(locate[0].body.targetModel, target);
            assert.deepEqual(Object.keys(locate[0].body).sort(), ['list', 'snapshotID', 'targetModel']);
            assert.equal(requests.some(request => request.path === '/api/get_ranking_page' && request.body.list === locate[0].body.list), false);
            const query = new URL(page.url()).searchParams;
            for (const key of ['focusModel', 'scoreMode', 'compareReasoning', 'compareHarness', 'mode']) assert.equal(query.has(key), false);
            assert.equal(query.get('source'), 'home');
            await page.screenshot({ path: resolve(output, `home-click-${isPrivate ? 'private-mine' : 'public'}.png`), fullPage: true });
            await page.locator('[data-quick-comparison="reasoning"]').click();
            await ready(page);
            await page.locator('[data-quick-comparison="harness"]').click();
            await ready(page);
            assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).basic.keys, storageKey), ['model']);
            assert.equal(await page.locator('.is-model-jump-focus').count(), 0);
            assert.deepEqual(errors, []);
            console.log(`PASS Home click (${isPrivate ? 'private Mine' : 'public'}): exact effort/harness variant, bounded deep page, explicit preference edit`);
        } catch (error) {
            await page.screenshot({ path: resolve(output, `home-click-${isPrivate ? 'private-mine' : 'public'}-failure.png`), fullPage: true });
            console.error(JSON.stringify({ engine, build, isPrivate, errors, focusStatus: await page.locator('.bp-model-focus-status').allTextContents() }));
            throw error;
        } finally { await context.close(); }
    }
    console.log(`Screenshots: ${output}`);
    results.push({ engine, version: browser.version(), build, passed: true });
} catch (error) {
    results.push({ engine, version: browser.version(), build, passed: false, error: error.stack });
    console.error(`FAIL ${engine} ${build}: ${error.message}`);
} finally { await browser.close(); await app.close(); }
}
}
await writeFile(resolve(outputBase, 'results.json'), JSON.stringify({ builtRoot, results }, null, 2));
assert.equal(results.filter(result => !result.passed).length, 0, 'Every source/built browser suite must pass');
