import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { openOverview } from './showcase-interactions.mjs';
import { PRIVACY_CONTENT_SECURITY_POLICY } from '../../privacy-headers.js';

const observe = process.argv.includes('--observe');
const live = process.argv.includes('--live');
const builtRoot = process.env.BUILT_APP_ROOT;
const output = resolve(process.env.FRONTEND_OUTPUT ?? 'D:/Codex-artifacts/website1/showcase-composition-20261021');
await mkdir(output, { recursive: true });
const results = [];
const cases = [
    ['chromium', chromium, 1440, 900, false],
    ['chromium', chromium, 390, 844, false],
    ['chromium', chromium, 320, 568, false],
    ['chromium', chromium, 844, 390, false],
    ['webkit', webkit, 1440, 900, false],
    ['webkit', webkit, 390, 844, false],
    ['chromium', chromium, 390, 844, true]
];

async function settle(page) {
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await Promise.all(document.getAnimations().filter(animation =>
            animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
    });
}

for (const [engine, launcher, width, height, reduced] of cases) {
    if (live && (reduced || width === 320 || width === 844 || engine === 'webkit' && width !== 390)) continue;
    if (process.env.UI_TEST_WIDTH && Number(process.env.UI_TEST_WIDTH) !== width) continue;
    if (process.env.UI_TEST_ENGINE && process.env.UI_TEST_ENGINE !== engine) continue;
    const label = `${engine}-${width}x${height}${reduced ? '-reduced' : ''}`;
    const app = live ? { url: 'https://benchpoll.com', close: async () => {} } : await startPreview({ rankingStress: true });
    const browser = await launcher.launch({ headless: true, env: { ...process.env,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 760,
        hasTouch: width < 760, reducedMotion: reduced ? 'reduce' : 'no-preference' });
    if (live) {
        const agentPage = await context.newPage();
        const userAgent = await agentPage.evaluate(() => navigator.userAgent);
        await agentPage.close();
        await context.setExtraHTTPHeaders({ 'User-Agent': `${userAgent} BenchPoll-QA/showcase-20261021` });
    }
    const page = await context.newPage();
    page.setDefaultTimeout(25000);
    const errors = [];
    const requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { const path = new URL(request.url()).pathname; if (path.startsWith('/api/')) requests.push(path); });
    try {
        if (builtRoot) await page.route(`${app.url}/**`, async route => {
            const path = new URL(route.request().url()).pathname;
            if (route.request().resourceType() === 'document') return route.fulfill({ contentType: 'text/html',
                headers: { 'Content-Security-Policy': PRIVACY_CONTENT_SECURITY_POLICY },
                body: await readFile(resolve(builtRoot, 'private/home-built.html')) });
            if (path.startsWith('/build/home/')) return route.fulfill({ contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript',
                body: await readFile(resolve(builtRoot, 'public', '.' + path)) });
            return route.fallback();
        });
        await page.addInitScript(() => localStorage.setItem('benchpoll-workspace-display-v1', 'standard'));
        const initialRead = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace'));
        await page.goto(`${app.url}/${live ? 'Intelligence' : 'Language-models'}`);
        const initialResponse = await initialRead;
        assert.equal(initialResponse.status(), 200);
        assert.equal(initialResponse.request().postDataJSON().scoreMode, 'available');
        assert.deepEqual(await page.locator('[data-score-mode]').evaluateAll(nodes => nodes.map(node => node.dataset.scoreMode)), ['available', 'range']);
        await page.locator('.bp-model-row').first().waitFor({ state: 'attached' });
        await page.waitForFunction(() => document.querySelector('#model-card').getAttribute('aria-busy') === 'false');
        await page.locator('#public-composition-toggle').click();
        await page.waitForFunction(() => document.querySelector('#public-composition-toggle').getAttribute('aria-expanded') === 'true');
        await page.locator('.bp-pie-transition').waitFor({ state: 'detached' });
        const compositionOptions = page.locator('#public-composition-list button');
        await compositionOptions.nth(Math.min(1, await compositionOptions.count() - 1)).click();
        await settle(page);
        await page.screenshot({ path: resolve(output, `${label}-formal.png`) });
        const before = {
            weights: app.state ? structuredClone(app.state.personalEntries) : null,
            calculations: requests.filter(path => path === '/api/get_weighted_workspace').length,
            saves: requests.filter(path => path === '/api/save_personal_pie').length,
            selectedCategory: await page.locator('#public-composition-list [aria-pressed="true"]').getAttribute('data-category-id')
        };
        await page.evaluate(() => {
            window.compositionRankingNotices = [];
            const notice = document.querySelector('#model-ranking-status');
            new MutationObserver(() => {
                if (!notice.hidden) window.compositionRankingNotices.push(notice.dataset.phase);
            }).observe(notice, { attributes: true });
        });
        await openOverview(page, width < 760);
        await settle(page);
        await page.evaluate(() => {
            const scene = document.getElementById('showcase');
            const start = scene.getBoundingClientRect().top + scrollY;
            const travel = scene.offsetHeight - document.documentElement.clientHeight - scene.querySelector('.bp-showcase-stage').offsetHeight;
            scrollTo({ top: start + travel * .55, behavior: 'instant' });
        });
        await settle(page);
        const overview = await page.evaluate(() => {
            const list = document.getElementById('public-composition-list');
            const bars = document.getElementById('weight-bars');
            const footer = document.querySelector('.bp-showcase-footer').getBoundingClientRect();
            return { compositionHidden: list.hidden, compositionDisplay: getComputedStyle(list).display,
                visibleCategories: list.getBoundingClientRect().height,
                benchmarkRows: bars.querySelectorAll('.bp-weight-bar-row').length,
                bars: bars.getBoundingClientRect().toJSON(), footer: footer.toJSON(),
                documentOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
        });
        await page.screenshot({ path: resolve(output, `${label}-overview.png`) });
        const columns = page.locator('.bp-model-column');
        const plot = await columns.first().locator('.bp-model-column-plot').boundingBox();
        const column = await columns.first().boundingBox();
        assert.ok(column.width <= (width < 760 ? 36.1 : 44.1), 'Model columns stay compact');
        if (width === 390) assert.ok(plot.height >= 149, 'Phone model plots are taller');
        if (width < 760) assert.ok(overview.bars.height >= 80, 'Small screens keep a usable weight list');
        if (width > 760) {
            const beforeHover = await columns.first().evaluate(node => ({
                plot: getComputedStyle(node.querySelector('.bp-model-column-plot'), '::before').backgroundColor,
                column: getComputedStyle(node).backgroundColor,
                identity: getComputedStyle(node.querySelector('.bp-model-column-identity')).backgroundColor
            }));
            await columns.first().hover();
            await settle(page);
            const hover = await columns.first().evaluate(node => ({
                plot: getComputedStyle(node.querySelector('.bp-model-column-plot'), '::before').backgroundColor,
                column: getComputedStyle(node).backgroundColor,
                identity: getComputedStyle(node.querySelector('.bp-model-column-identity')).backgroundColor,
                filter: getComputedStyle(node.querySelector('.bp-column-known')).filter }));
            assert.notEqual(hover.plot, beforeHover.plot);
            assert.equal(hover.column, beforeHover.column);
            assert.equal(hover.identity, beforeHover.identity);
            assert.equal(hover.filter, 'none');
            await page.screenshot({ path: resolve(output, `${label}-plot-hover.png`) });
        }
        await page.locator('#showcase-enter').click();
        await page.waitForFunction(() => !document.body.classList.contains('is-showcase'));
        await settle(page);
        const restored = {
            visible: await page.locator('#public-composition-list').isVisible(),
            expanded: await page.locator('#public-composition-toggle').getAttribute('aria-expanded'),
            selectedCategory: await page.locator('#public-composition-list [aria-pressed="true"]').getAttribute('data-category-id')
        };
        await page.screenshot({ path: resolve(output, `${label}-restored.png`) });
        const notices = await page.evaluate(() => window.compositionRankingNotices);
        const passed = overview.compositionHidden && overview.compositionDisplay === 'none'
            && overview.visibleCategories === 0 && overview.benchmarkRows > 0 && !overview.documentOverflow
            && overview.bars.bottom <= overview.footer.top + 1 && restored.visible
            && restored.expanded === 'true' && restored.selectedCategory === before.selectedCategory
            && notices.length === 0 && errors.length === 0;
        results.push({ label, overview, restored, notices, errors, passed });
        if (app.state) assert.deepEqual(app.state.personalEntries, before.weights);
        assert.equal(requests.filter(path => path === '/api/save_personal_pie').length, before.saves);
        assert.equal(requests.filter(path => path === '/api/get_weighted_workspace').length, before.calculations);
        if (live) {
            await page.goto(app.url + '/AGI');
            await page.locator('#agi-promo').waitFor();
            assert.match(await page.locator('#agi-promo').innerText(), /AGI needs a public standard\./);
            assert.doesNotMatch(await page.locator('#agi-promo').innerText(), /80\s*%/);
            await page.waitForFunction(() => document.querySelector('#model-card').getAttribute('aria-busy') === 'false');
            await settle(page);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
            await page.screenshot({ path: resolve(output, `${label}-agi.png`) });
            assert.deepEqual(errors, []);
        }
        console.log(JSON.stringify(results.at(-1)));
    } catch (error) {
        await page.screenshot({ path: resolve(output, `${label}-error.png`) }).catch(() => {});
        throw error;
    } finally { await context.close(); await browser.close(); await app.close(); }
}
await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2));
assert.ok(results.length);
if (!observe) assert.ok(results.every(result => result.passed), 'Composition must not leak into the overview or change ranking inputs.');
