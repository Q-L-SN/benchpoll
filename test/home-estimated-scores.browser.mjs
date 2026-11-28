import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { startTopicsPreview } from '../scripts/frontend/topics-home-fixtures.mjs';
import { startPreview } from '../scripts/frontend/server.mjs';

for (const [engine, width] of [[chromium, 1440], [webkit, 390]]) {
    test(`Home ranks with a single score at ${width}px in ${engine.name()}`, { timeout: 30000 }, async t => {
        const app = await startTopicsPreview();
        let browser;
        t.after(async () => { await browser?.close(); await app.close(); });
        browser = await engine.launch();
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(app.url);
        const card = page.locator('.th-card[data-topic-id="54"][data-preview-state="loaded"]');
        await card.waitFor();
        const model = card.locator('a.th-model').first();
        assert.equal(await model.locator('.th-model-bar').count(), 1);
        assert.equal(await card.locator('.th-model-range').count(), 0);
        assert.match(await model.getAttribute('aria-label'), /Score \d+/);
        assert.equal(new URL(await model.getAttribute('href'), app.url).searchParams.has('scoreMode'), false);
        await page.evaluate(() => scrollTo(0, document.getElementById('home-hero').getBoundingClientRect().bottom + scrollY + 24));
        const filters = page.locator('#topics-filters-toggle');
        await filters.waitFor();
        if (await filters.getAttribute('aria-expanded') !== 'true') await filters.click();
        assert.equal(await page.locator('#topics-score-toggle').count(), 0);
        const version = page.waitForResponse(response => response.url().endsWith('/api/get_topic_preview')
            && response.request().postDataJSON().categoryID === 54 && response.request().postDataJSON().reasoning === true);
        await page.locator('#topics-filter-controls [data-comparison="reasoning"]').click();
        assert.equal((await version).request().postDataJSON().scoreMode, undefined);
        await page.waitForFunction(() => document.querySelector('.th-card[data-topic-id="54"] a.th-model')?.href.includes('compareReasoning=1'));
        await page.locator('#topics-view-toggle').click();
        await card.locator('.th-treemap[role="img"]').waitFor();
        assert.deepEqual(errors, []);
    });
}

test('a model deep link opens the estimated ranking and locates an unloaded model', { timeout: 30000 }, async t => {
    const app = await startPreview({ rankingStress: true });
    let browser;
    t.after(async () => { await browser?.close(); await app.close(); });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await page.goto(app.url + '/1?focusModel=2040&scoreMode=range&mode=public');
    const target = page.locator('.is-model-jump-focus[data-model-focus-id="2040"]');
    await target.waitFor({ state: 'visible' });
    const query = new URL(page.url()).searchParams;
    assert.equal(query.has('scoreMode'), false);
    const initial = app.state.requests.find(request => request.path === '/api/get_weighted_workspace');
    assert.equal(initial.body.scoreMode, undefined);
    const locate = app.state.requests.filter(request => request.path === '/api/locate_ranking_model');
    assert.equal(locate.length, 1);
    assert.equal(locate[0].body.targetModel, '2040');
});
