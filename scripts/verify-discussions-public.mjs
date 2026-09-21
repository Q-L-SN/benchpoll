import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const origin = process.env.BENCHPOLL_VERIFY_ORIGIN || 'https://benchpoll.com';
const browser = await chromium.launch({ headless: true });
await mkdir('artifacts/frontend', { recursive: true });
try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error(error.stack); });
    page.on('requestfailed', request => {
        if (['script', 'stylesheet'].includes(request.resourceType())) {
            console.error('Asset failed:', new URL(request.url()).pathname, request.failure()?.errorText);
        }
    });
    await page.addInitScript(() => localStorage.setItem('benchpoll-welcome-seen-v1', '1'));
    await page.goto(origin + '/?discussion=1', { waitUntil: 'networkidle', timeout: 60000 });
    await page.locator('#category-path').filter({ hasText: /.+/ }).waitFor();
    assert.equal(await page.locator('#discussion-error').isVisible(), false);
    const rail = await page.locator('#discussion-panel').boundingBox();
    const model = await page.locator('#model-card').boundingBox();
    const bench = await page.locator('#benchmark-card').boundingBox();
    assert.ok(model.x + model.width <= rail.x);
    assert.ok(Math.abs(model.height - bench.height) < 2 && Math.abs(model.y - bench.y) < 2);
    assert.ok(Math.abs(model.y + model.height - 984) < 2);
    const response = await context.request.post(origin + '/api/get_discussion', { data: {} });
    assert.equal(response.status(), 200);
    const feed = await response.json();
    assert.ok(Number.isSafeInteger(feed.context.categoryID));
    for (const path of ['/api/create_discussion_post', '/api/vote_discussion', '/api/get_reported_discussion', '/api/submit_contribution']) {
        const result = await context.request.post(origin + path, { data: {} });
        assert.equal(result.status(), 401, `Anonymous access: ${path}`);
    }
    const crossSite = await context.request.post(origin + '/api/vote_discussion', { data: {}, headers: { origin: 'https://untrusted.example' } });
    assert.equal(crossSite.status(), 403);
    const invalid = await context.request.post(origin + '/api/get_discussion', { data: { categoryID: -1 } });
    assert.equal(invalid.status(), 400);
    const suggestions = await context.request.post(origin + '/api/search_discussion_benchmarks', { data: { query: 'Agent' } });
    assert.equal(suggestions.status(), 200);
    assert.ok(Array.isArray((await suggestions.json()).benchmarks));
    const preview = await context.request.post(origin + '/api/get_discussion_summary', { data: { categoryID: feed.context.categoryID } });
    assert.equal(preview.status(), 200);
    assert.deepEqual(Object.keys(await preview.json()), ['count']);
    await page.screenshot({ path: 'artifacts/frontend/discussions-public-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.locator('#discussion-close').click();
    await page.locator('#discussion-entry').click();
    await page.locator('#discussion-compose-toggle').waitFor();
    await page.screenshot({ path: 'artifacts/frontend/discussions-public-mobile.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PASS: public inline discussion, full-height tables, search, count, mobile layout, anonymous write/reviewer denial and cross-origin denial');
    await context.close();
} finally { await browser.close(); }
