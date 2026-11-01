import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { benchmarks } from './fixtures.mjs';

const output = process.env.SHOWCASE_PAGINATION_OUTPUT ?? 'D:/Codex-artifacts/website1/showcase-pagination-20261016/source';
const liveURL = process.argv.find(value => /^https?:\/\//.test(value));
const builtRoot = process.env.HOME_BUILT_ROOT;
const html = builtRoot ? await readFile(join(builtRoot, 'home-built.html'), 'utf8') : null;
const weights = Array.from({ length: 25 }, (_, index) => ({ ...benchmarks[index] ?? benchmarks[0],
    ID: index + 1, conditionID: index + 1, benchmarkID: index + 101,
    name: benchmarks[index]?.name ?? `Additional benchmark ${index - 7}`,
    weightBasisPoints: Math.floor((25 - index) / 325 * 10000) }));
weights.at(-1).weightBasisPoints += 10000 - weights.reduce((sum, entry) => sum + entry.weightBasisPoints, 0);
await mkdir(output, { recursive: true });
const reports = [];
for (const [engine, launcher, width, height] of [['chromium', chromium, 1440, 900], ['chromium', chromium, 1440, 760],
    ['chromium', chromium, 820, 760], ['chromium', chromium, 390, 844], ['chromium', chromium, 320, 640],
    ['webkit', webkit, 1440, 900], ['webkit', webkit, 390, 844]]) {
    const app = await startPreview({ rankingStress: true, publicWeights: weights });
    const browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 760, hasTouch: width < 760 });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    const errors = [], label = `${engine}-${width}x${height}`;
    page.on('pageerror', error => errors.push(error.message));
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
    let holdModelPage = false, releaseModelPage, failModelPage = false;
    await page.route('**/api/get_ranking_page', async route => {
        if (route.request().postDataJSON().list !== 'public') return route.fallback();
        if (holdModelPage) {
            holdModelPage = false;
            await new Promise(resolve => { releaseModelPage = resolve; });
        }
        if (failModelPage) { failModelPage = false; return route.fulfill({ status: 503, json: { error: 'fixture_model_page_failed' } }); }
        return route.fallback();
    });
    const ready = () => page.waitForFunction(() => document.querySelector('#model-ranking-status')?.dataset.phase === 'ready');
    async function showCharts() {
        await page.evaluate(() => {
            const scene = document.getElementById('showcase');
            const hold = scene.querySelector('.bp-showcase-stage').offsetHeight;
            scrollTo({ top: (scene.offsetHeight - document.documentElement.clientHeight - hold) * .55, behavior: 'instant' });
        });
        await page.waitForFunction(() => getComputedStyle(document.body).getPropertyValue('--showcase-reveal').trim() === '1'
            && getComputedStyle(document.body).getPropertyValue('--showcase-outro').trim() === '0');
    }
    async function weightScrollGeometry() {
        return page.evaluate(() => {
            const slot = document.getElementById('pie-home-slot');
            const list = document.getElementById('weight-bars');
            const panel = document.getElementById('weight-bars-panel');
            const source = document.querySelector('.bp-pie-mode-row');
            return { sourceTop: source.getBoundingClientRect().top, sourceBottom: source.getBoundingClientRect().bottom,
                slotTop: slot.scrollTop, slotOverflow: getComputedStyle(slot).overflowY,
                listTop: list.scrollTop, listHeight: list.clientHeight, listContent: list.scrollHeight,
                listBottom: list.getBoundingClientRect().bottom, panelBottom: panel.getBoundingClientRect().bottom,
                slotBottom: slot.getBoundingClientRect().bottom, pageTop: window.scrollY };
        });
    }
    async function assertPinnedSource() {
        const before = await weightScrollGeometry();
        await page.locator('#weight-bars').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await page.locator('#pie-home-slot').evaluate(node => { node.scrollTop = node.scrollHeight; });
        const after = await weightScrollGeometry();
        assert.ok(['clip', 'visible'].includes(after.slotOverflow), JSON.stringify(after));
        assert.equal(after.slotTop, 0, 'Only the weight list, not the source controls, can scroll internally');
        assert.ok(Math.abs(after.sourceTop - before.sourceTop) <= 1, JSON.stringify({ before, after }));
        assert.ok(Math.abs(after.sourceBottom - before.sourceBottom) <= 1);
        assert.equal(after.pageTop, before.pageTop);
        assert.ok(after.listBottom <= after.slotBottom + 1, JSON.stringify(after));
        assert.ok(after.panelBottom <= after.slotBottom + 1, JSON.stringify(after));
        if (after.listContent > after.listHeight + 1) assert.ok(after.listTop > 0);
        return after;
    }
    try {
        await page.goto(liveURL ?? app.url); await ready(); await showCharts(); await page.evaluate(() => document.fonts.ready);
        const rows = page.locator('.bp-weight-bar-row'), more = page.getByRole('button', { name: 'Load more benchmarks', exact: true });
        const bars = page.locator('#weight-bars');
        assert.equal(await rows.count(), 10);
        assert.equal(await page.locator('#model-rows .bp-ranking-page-footer').count(), 0);
        const modelGeometry = await page.locator('#model-rows').evaluate(node => ({ overflow: getComputedStyle(node).overflowY,
            height: node.clientHeight, contentHeight: node.scrollHeight, bottom: node.getBoundingClientRect().bottom,
            footerTop: document.querySelector('.bp-showcase-footer').getBoundingClientRect().top }));
        assert.equal(modelGeometry.overflow, 'visible');
        assert.ok(modelGeometry.bottom <= modelGeometry.footerTop + 1, JSON.stringify(modelGeometry));
        const viewportHeight = await bars.evaluate(node => node.clientHeight);
        if (width < 760) assert.ok(viewportHeight > (height > 730 ? 170 : 90), String(viewportHeight));
        const pinnedSource = await assertPinnedSource();
        await bars.evaluate(node => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event('scroll')); });
        await page.waitForTimeout(250);
        assert.equal(await rows.count(), 10, 'Weight scrolling never reveals the next batch');
        const top = await bars.evaluate(node => node.scrollTop);
        await more.click(); assert.equal(await rows.count(), 20);
        assert.ok(Math.abs(await bars.evaluate(node => node.scrollTop) - top) <= 1);
        await more.click(); assert.equal(await rows.count(), 25);
        assert.equal(await more.isVisible(), false);
        await assertPinnedSource();
        assert.equal(await page.locator('#weight-bars input, #weight-bars [role="slider"]').count(), 0);
        await page.locator('#pie-mode-personal').click(); await page.waitForFunction(() => document.querySelector('#pie-mode-personal').getAttribute('aria-selected') === 'true');
        assert.equal(await rows.count(), 4);
        await assertPinnedSource();
        await page.locator('#pie-mode-public').click(); await page.waitForFunction(() => document.querySelector('#pie-mode-public').getAttribute('aria-selected') === 'true');
        assert.equal(await rows.count(), 10);
        await assertPinnedSource();
        await bars.evaluate(node => { node.scrollTop = 0; });
        await page.screenshot({ path: join(output, `${label}.png`) });
        const columns = page.locator('.bp-model-column');
        const originalCount = await columns.count();
        const heightBeforeLoading = await page.locator('#model-rows').evaluate(node => node.clientHeight);
        holdModelPage = true;
        await page.locator('.bp-model-chart-scroll').evaluate(node => { node.scrollLeft = node.scrollWidth; });
        await page.waitForFunction(() => document.querySelector('#model-rows .bp-ranking-page-footer')?.textContent.includes('Loading more'));
        assert.equal(await page.locator('#model-rows .bp-ranking-page-footer').evaluate(node => getComputedStyle(node).position), 'absolute');
        assert.equal(await page.locator('#model-rows').evaluate(node => node.clientHeight), heightBeforeLoading);
        const offset = await page.locator('.bp-model-chart-scroll').evaluate(node => node.scrollLeft);
        while (!releaseModelPage) await page.waitForTimeout(20);
        releaseModelPage();
        await page.waitForFunction(count => document.querySelectorAll('.bp-model-column').length > count, originalCount);
        assert.ok(Math.abs(await page.locator('.bp-model-chart-scroll').evaluate(node => node.scrollLeft) - offset) <= 1);
        assert.equal(await page.locator('#model-rows .bp-ranking-page-footer').count(), 0);
        failModelPage = true;
        await page.locator('.bp-model-chart-scroll').evaluate(node => { node.scrollLeft = node.scrollWidth; });
        const retry = page.locator('#model-rows .bp-ranking-page-footer').getByRole('button', { name: 'Retry', exact: true });
        await retry.waitFor();
        assert.equal(await page.locator('#model-rows').evaluate(node => node.clientHeight), heightBeforeLoading);
        await retry.click();
        await page.waitForFunction(() => document.querySelectorAll('.bp-model-column').length === 66);
        assert.equal(await page.locator('#model-rows .bp-ranking-page-footer').count(), 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.equal(app.state.requests.some(request => /save_personal_pie/.test(request.path)), false);
        assert.deepEqual(errors, []);
        reports.push({ label, initial: 10, afterClicks: [20, 25], reset: 10, viewportHeight, pinnedSource, modelGeometry, modelLoadAndRetry: true });
        console.log(`PASS ${label}: fixed weight-source controls, paginated weights, stable scrolling and no vertical model scroll`);
    } catch (error) { await page.screenshot({ path: join(output, `${label}-failure.png`) }).catch(() => {}); throw error; }
    finally { await context.close(); await browser.close(); await app.close(); }
}
await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
