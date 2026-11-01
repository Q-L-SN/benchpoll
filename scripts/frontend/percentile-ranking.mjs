import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { familyEntries, models, weightedEntries } from './fixtures.mjs';

const output = 'artifacts/percentile-ranking-20261007/ui';
await mkdir(output, { recursive: true });
const liveURL = process.env.PERCENTILE_RANKING_URL;
const results = [];
const ordinary = (page, ID) => page.locator(`.bp-benchmark-row:not(.is-family)[data-condition-id="${ID}"]`);
const rules = [{ primaryConditionID: 1, familyID: 20, mode: 'ordered', entries: familyEntries([{ conditionID: 3 }]) }];
const weights = [{ conditionID: 1, weightBasisPoints: 5000 }, { conditionID: 2, weightBasisPoints: 5000 }];
const values = [{ 1: 80, 3: 10 }, { 1: 40, 2: 20, 3: 20 }, { 1: 60, 2: 100, 3: 30 }];
const comparisonModels = models.slice(0, 3).map((model, index) => ({ ...model, modelName: model.name,
    condition: { parameters: {}, scoreFields: [] },
    results: new Map(Object.entries(values[index]).map(([key, normalizedScore]) => [key, { normalizedScore }])) }));
const ready = page => page.waitForFunction(() => document.querySelector('#model-ranking-status')?.dataset.phase === 'ready'
    && document.querySelectorAll('.bp-model-row').length > 0);
const sleepFrames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function check(browser, engine, name, width, options, action, reduce = false) {
    const app = await startPreview(Object.fromEntries(Object.entries(options).map(([key, value]) => [key, structuredClone(value)])));
    const context = await browser.newContext({ viewport: { width, height: 960 }, isMobile: width < 500,
        hasTouch: width < 500, reducedMotion: reduce ? 'reduce' : 'no-preference' });
    const page = await context.newPage(); page.setDefaultTimeout(liveURL ? 60000 : 15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (liveURL) await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        await route.fulfill({ response: await route.fetch({ url: app.url + url.pathname + url.search }) });
    });
    const prefix = `${output}/${liveURL ? 'live-' : ''}${engine}-${name}-${width}${reduce ? '-reduced' : ''}`;
    try {
        await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded' });
        await ready(page); await action(page, app, prefix);
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await page.screenshot({ path: `${prefix}.png`, fullPage: true, animations: 'disabled' });
        results.push({ engine, name, width, reduce, passed: true });
        console.log(`PASS ${engine}-${name}-${width}${reduce ? '-reduced' : ''}`);
    } catch (error) {
        await page.screenshot({ path: `${prefix}-failure.png`, fullPage: true });
        results.push({ engine, name, width, reduce, passed: false, error: error.stack, errors });
        console.error(`FAIL ${engine}-${name}-${width}: ${error.stack}`);
    } finally { await context.close(); await app.close(); }
}

async function fallback(page, app, prefix) {
    const originalEntries = app.state.personalEntries.map(entry => [entry.conditionID, entry.weightBasisPoints]);
    await page.locator('#pie-mode-personal').click(); await ready(page);
    await page.locator('.bp-pie-flip-face').waitFor({ state: 'detached' });
    await ordinary(page, 1).locator('.bp-benchmark-personal-weight').click();
    await page.locator('#inline-fallback-toggle').click();
    const chart = page.locator('#inline-fallback-chart');
    await chart.waitFor();
    const inactive = async () => {
        assert.equal(await page.locator('#inline-fallback-add-benchmark').getAttribute('aria-pressed'), 'false');
        assert.equal(await chart.evaluate(node => node.classList.contains('is-target-active')), false);
        assert.equal(await page.locator('#benchmark-card').evaluate(node => node.classList.contains('is-fallback-target-active')), false);
    };
    await inactive();
    const heights = await chart.evaluate(node => ({ chart: node.getBoundingClientRect().height,
        row: node.querySelector('.bp-family-member').getBoundingClientRect().height }));
    assert.ok(heights.chart - heights.row < 5, JSON.stringify(heights));
    await chart.locator('.bp-family-member-name').click(); await inactive();
    await chart.click({ position: { x: 5, y: 5 } }); await inactive();
    await chart.locator('.bp-family-drag').click(); await inactive();
    await page.locator('#inline-fallback-add-other-versions').click(); await ready(page); await inactive();
    const connector = chart.locator('.bp-family-connection');
    assert.equal(await connector.count(), 1);
    assert.equal(await chart.locator('.bp-family-member .fa-link').count(), 0);
    assert.equal(await connector.evaluate(node => node.previousElementSibling?.classList.contains('bp-family-member')
        && node.nextElementSibling?.classList.contains('is-automatic-group')), true);
    assert.equal(await connector.textContent(), app.state.personalEntries.find(entry => entry.conditionID === 3)?.name ?? 'Global MMLU Lite');
    await chart.locator('.bp-family-action[aria-label^="Move "][aria-label$=" earlier"]').last().click();
    await ready(page); await inactive();
    assert.equal(await chart.locator('.bp-family-chain').evaluate(node => node.firstElementChild.classList.contains('bp-family-connection')), true);
    await page.locator('#inline-fallback-add-benchmark').click();
    assert.equal(await page.locator('#inline-fallback-add-benchmark').getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('inline-fallback-chart')).borderTopColor === 'rgb(36, 99, 189)');
    await page.screenshot({ path: `${prefix}-adding.png`, fullPage: true, animations: 'disabled' });
    assert.equal(await page.locator('#benchmark-rows .bp-personal-weight-remove, #benchmark-rows .bp-benchmark-applied').count(), 0);
    await ordinary(page, 2).locator('.bp-benchmark-add').click(); await ready(page);
    assert.deepEqual(app.state.personalEntries.map(entry => [entry.conditionID, entry.weightBasisPoints]), originalEntries);
    assert.equal(app.state.fallbackRules[0].entries.at(-1).conditionID, 2);
    await page.locator('#inline-fallback-toggle').click();
    await page.locator('#inline-fallback-toggle').click(); await inactive();
    await chart.locator('.bp-family-member-name').last().click(); await inactive();
    const handle = chart.locator('.bp-family-drag').last();
    await handle.scrollIntoViewIfNeeded();
    const from = await handle.boundingBox(), to = await chart.locator('.bp-family-member').first().boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, to.y + to.height / 2 - 10, { steps: 12 });
    await page.mouse.up(); await ready(page); await inactive();
    assert.equal(app.state.fallbackRules[0].entries[0].conditionID, 2, 'Reordering must ignore connector rows');
    assert.equal(await chart.locator('.bp-family-connection').textContent(), 'Advanced reasoning');
}

async function notice(page, _app, prefix) {
    if (page.viewportSize().width <= 760) await page.locator('.bp-mobile-panels [data-mobile-panel="models"]').click();
    await page.waitForFunction(() => document.getElementById('model-ranking-status').hidden);
    await page.evaluate(async () => {
        const { createRankingNotice } = await import('/js/workspace/ranking-notice.js?v=percentile-ranking-20261007');
        const oldStatus = document.getElementById('model-ranking-status');
        const status = oldStatus.cloneNode(false); oldStatus.replaceWith(status);
        const rows = document.getElementById('model-rows');
        window.noticeTest = createRankingNotice({ status, rows }); window.noticeTest.resetRows();
        window.noticeTest.update({ pending: false, version: 1, scope: 'test' });
        for (let index = 0; index < 80; index++) {
            const row = document.createElement('div'); row.className = 'notice-test-row'; row.dataset.index = index;
            row.textContent = `Model ${index + 1}`; row.style.cssText = 'height:60px;display:flex;align-items:center;padding:0 20px;border-bottom:1px solid #ddd;box-sizing:border-box';
            rows.append(row);
        }
        if (innerWidth <= 760) window.scrollTo({ top: rows.getBoundingClientRect().top + scrollY
            - 60 - document.querySelector('.bp-mobile-panels').getBoundingClientRect().height, behavior: 'instant' });
        else rows.scrollTop = 0;
    });
    await sleepFrames(page);
    const top = await page.locator('.notice-test-row').first().evaluate(node => node.getBoundingClientRect().top);
    await page.evaluate(() => window.noticeTest.update({ pending: true, version: 1, scope: 'test' }));
    await page.waitForFunction(() => document.getElementById('model-ranking-status').dataset.motion === 'open');
    const open = await page.evaluate(() => ({
        notice: document.getElementById('model-ranking-status').getBoundingClientRect().toJSON(),
        spacer: document.querySelector('.bp-model-ranking-spacer').getBoundingClientRect().height,
        first: document.querySelector('.notice-test-row').getBoundingClientRect().top
    }));
    assert.ok(open.spacer >= 44 && Math.abs(open.spacer - open.notice.height) < 1, JSON.stringify(open));
    assert.ok(open.first >= open.notice.bottom - 1, JSON.stringify(open));
    assert.ok(Math.abs(open.first - top - open.spacer) < 2, JSON.stringify({ top, open }));
    await page.evaluate(() => window.noticeTest.update({ pending: false, version: 1, scope: 'test' }));
    await page.waitForFunction(() => document.getElementById('model-ranking-status').hidden);
    await page.evaluate(() => {
        const rows = document.getElementById('model-rows');
        if (innerWidth <= 760) window.scrollTo({ top: document.querySelector('[data-index="7"]').getBoundingClientRect().top + scrollY - 180, behavior: 'instant' });
        else rows.scrollTop = 420;
    });
    await sleepFrames(page);
    const before = await page.locator('[data-index="7"]').evaluate(node => node.getBoundingClientRect().top);
    await page.evaluate(() => window.noticeTest.update({ pending: true, version: 2, scope: 'test' }));
    await page.waitForFunction(() => document.getElementById('model-ranking-status').dataset.motion === 'open');
    const after = await page.locator('[data-index="7"]').evaluate(node => node.getBoundingClientRect().top);
    assert.ok(Math.abs(after - before) < 1.1, `Opening scroll anchor moved ${after - before}px`);
    const sticky = await page.locator('#model-ranking-status').boundingBox();
    if (page.viewportSize().width <= 760) {
        const panels = await page.locator('.bp-mobile-panels').boundingBox();
        assert.ok(Math.abs(sticky.y - panels.y - panels.height) < 1, JSON.stringify({ sticky, panels }));
    }
    await page.screenshot({ path: `${prefix}-scrolled-updating.png`, fullPage: false });
    await page.evaluate(() => window.noticeTest.update({ pending: false, version: 2, scope: 'test' }));
    await page.waitForFunction(() => document.getElementById('model-ranking-status').hidden);
    const end = await page.locator('[data-index="7"]').evaluate(node => node.getBoundingClientRect().top);
    assert.ok(Math.abs(end - before) < 1.1, `Closing scroll anchor moved ${end - before}px`);
    await page.evaluate(() => window.noticeTest.update({ pending: true, version: 3, scope: 'test' }));
    await page.waitForFunction(() => document.getElementById('model-ranking-status').dataset.motion === 'open');
    await page.evaluate(() => window.noticeTest.update({ pending: false, version: 3, scope: 'test' }));
    await page.waitForTimeout(900);
    await page.evaluate(() => window.noticeTest.update({ pending: true, version: 4, scope: 'test' }));
    await page.waitForTimeout(1900);
    assert.equal(await page.locator('#model-ranking-status').isVisible(), true, 'Previous completion must not hide a new request');
    await page.evaluate(() => window.noticeTest.update({ pending: false, error: 'Could not update the ranking. Please try again after checking your connection.', version: 4, scope: 'test' }));
    await page.waitForFunction(() => document.getElementById('model-ranking-status').dataset.motion === 'open');
    await page.waitForTimeout(1900);
    assert.equal(await page.locator('#model-ranking-status').isVisible(), true);
    assert.equal(await page.locator('#model-card').getAttribute('aria-busy'), 'false');
    const fits = await page.locator('.bp-model-ranking-status-content').evaluate(node => node.scrollWidth <= node.clientWidth);
    assert.equal(fits, true);
}

async function inference(page) {
    if (page.viewportSize().width <= 760) await page.locator('.bp-mobile-panels [data-mobile-panel="models"]').click();
    const response = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace')
        && response.request().postDataJSON().scoreMode === 'available');
    await page.locator('[data-score-mode="available"]').click();
    const payload = await (await response).json(); await ready(page);
    const inferred = payload.modelLeaderboards.public.find(row => row.modelID === 301);
    assert.equal(inferred.availableInference.sourceCount, 2);
    assert.equal(inferred.lower, 70);
    assert.equal(inferred.inferredScores[0].normalizedScore, 60);
    await page.locator('.bp-model-row').filter({ hasText: inferred.name }).first().click();
    await page.locator('.bp-model-inferred-row').waitFor();
    const dialog = page.locator('#model-scores-dialog');
    assert.match(await dialog.textContent(), /Estimated missing results/);
    assert.match(await dialog.textContent(), /not measured|not a measured/i);
    assert.equal(await dialog.locator('.bp-model-inferred-row a, .bp-model-inferred-row button').count(), 0);
    assert.equal(await dialog.locator('.bp-model-score-detail-row:not(.bp-model-inferred-row)').count(), 1);
    assert.equal(await dialog.locator('.bp-model-inferred-row').count(), 1);
}

for (const [engine, launcher, widths] of [['chromium', chromium, [1440, 390, 320]], ['webkit', webkit, [390]]]) {
    const browser = await launcher.launch({ headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    try {
        for (const width of widths) {
            await check(browser, engine, 'fallback', width, { fallbackRules: rules, families: rules, saveDelay: 150 }, fallback);
            await check(browser, engine, 'notice', width, {}, notice);
        }
        await check(browser, engine, 'inference', widths[0], { comparisonModels, publicWeights: weights,
            personalEntries: weightedEntries(weights) }, inference);
        if (engine === 'chromium') await check(browser, engine, 'notice', 390, {}, notice, true);
    } finally { await browser.close(); }
}
await writeFile(`${output}/${liveURL ? 'live-' : ''}results.json`, JSON.stringify(results, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
