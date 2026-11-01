import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseURL = process.env.BENCHPOLL_VERIFY_URL ?? 'https://benchpoll.com';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
    await page.addInitScript(() => localStorage.setItem('benchpoll-welcome-seen-v1', '1'));
    const firstResponse = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace'), { timeout: 120000 });
    await page.goto(baseURL, { waitUntil: 'commit', timeout: 60000 });
    const response = await firstResponse;
    assert.equal(response.status(), 200);
    const payload = await response.json();
    assert.equal(payload.benchmarks.length, Math.min(40, payload.rankingPagination.benchmarks.primary.total));
    assert.equal(payload.modelLeaderboards.public.length, Math.min(25, payload.rankingPagination.public.total));
    await page.locator('#benchmark-rows .bp-benchmark-row').first().waitFor({ timeout: 30000 });
    await page.locator('#model-rows .bp-model-row').first().waitFor({ timeout: 30000 });
    const initialCounts = await page.evaluate(() => ({
        benchmarks: document.querySelectorAll('#benchmark-rows .bp-benchmark-row').length,
        models: document.querySelectorAll('#model-rows .bp-model-row').length
    }));
    assert.ok(initialCounts.benchmarks <= 80 && initialCounts.models <= 50, 'Initial render must remain bounded');
    for (const [list, container, rowSelector] of [
        ['benchmarks', '#benchmark-rows', '.bp-benchmark-row'],
        ['public', '#model-rows', '.bp-model-row']
    ]) {
        if (!(list === 'benchmarks' ? payload.rankingPagination.benchmarks.primary : payload.rankingPagination[list]).hasMore) continue;
        const count = await page.locator(`${container} ${rowSelector}`).count();
        const nextResponse = page.waitForResponse(item => item.url().endsWith('/api/get_ranking_page')
            && item.request().postDataJSON()?.list === list, { timeout: 30000 });
        await page.locator(container).evaluate(element => { element.scrollTop = element.scrollHeight; });
        const next = await nextResponse;
        assert.equal(next.status(), 200);
        await page.waitForFunction(({ selector, count }) => document.querySelectorAll(selector).length > count,
            { selector: `${container} ${rowSelector}`, count }, { timeout: 30000 });
    }
    const query = 'LiveCodeBench';
    const searchResponse = page.waitForResponse(item => item.url().endsWith('/api/get_ranking_page')
        && item.request().postDataJSON()?.query === query, { timeout: 30000 });
    await page.locator('#benchmark-search').fill(query);
    const search = await searchResponse;
    assert.equal(search.status(), 200);
    const searchData = await search.json();
    assert.ok(searchData.items.length > 0, 'Search must reach benchmarks outside the first page');
    await mkdir('artifacts/frontend', { recursive: true });
    await page.screenshot({ path: 'artifacts/frontend/ranking-pages-live-desktop.png', timeout: 30000 });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.screenshot({ path: 'artifacts/frontend/ranking-pages-live-mobile.png', timeout: 30000 });
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    mobile.on('pageerror', error => errors.push(error.message));
    await mobile.addInitScript(() => localStorage.setItem('benchpoll-welcome-seen-v1', '1'));
    const mobileResponse = mobile.waitForResponse(item => item.url().endsWith('/api/get_weighted_workspace'), { timeout: 120000 });
    await mobile.goto(baseURL, { waitUntil: 'commit', timeout: 60000 });
    assert.equal((await mobileResponse).status(), 200);
    await mobile.locator('#benchmark-rows .bp-benchmark-row').first().waitFor({ timeout: 30000 });
    await mobile.locator('[data-mobile-panel="models"]').click();
    await mobile.locator('#model-rows .bp-model-row').first().waitFor({ timeout: 30000 });
    assert.equal(await mobile.locator('#model-rows .bp-model-row').count(), 25);
    const mobileNext = mobile.waitForResponse(item => item.url().endsWith('/api/get_ranking_page')
        && item.request().postDataJSON()?.list === 'public', { timeout: 30000 });
    await mobile.locator('#model-rows .bp-ranking-page-footer').scrollIntoViewIfNeeded();
    assert.equal((await mobileNext).status(), 200);
    await mobile.waitForFunction(() => document.querySelectorAll('#model-rows .bp-model-row').length === 50, null, { timeout: 30000 });
    await mobile.screenshot({ path: 'artifacts/frontend/ranking-pages-live-mobile-fresh.png', timeout: 30000 });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ status: 'passed', initialCounts,
        responseBytes: Buffer.byteLength(JSON.stringify(payload)), searchMatches: searchData.total, errors }));
} finally { await browser.close(); }
