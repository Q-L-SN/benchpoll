import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { fixtureTopics, startTopicsPreview } from '../scripts/frontend/topics-home-fixtures.mjs';

const browsers = new Map();
before(async () => {
    const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    for (const launcher of [chromium, webkit]) browsers.set(launcher.name(), await launcher.launch({ headless: true, env }));
});
after(async () => { for (const browser of browsers.values()) await browser.close(); });

async function exerciseScroll(page) {
    for (let round = 0; round < 2; round++) {
        await page.evaluate(() => scrollTo(0, 0));
        await page.waitForFunction(() => document.getElementById('topics-filters').hidden);
        const bounds = await page.evaluate(() => ({ maxScroll: document.documentElement.scrollHeight - innerHeight,
            heroBottom: document.getElementById('home-hero').getBoundingClientRect().bottom + scrollY }));
        assert.ok(bounds.maxScroll >= bounds.heroBottom - 1, `Cannot scroll the introduction fully away: ${JSON.stringify(bounds)}`);
        await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForFunction(() => !document.getElementById('topics-filters').hidden);
        assert.ok(await page.locator('#home-hero').evaluate(node => node.getBoundingClientRect().bottom) <= 1);
        assert.equal(await page.locator('.th-header').evaluate(node => getComputedStyle(node).position), 'fixed');
    }
}

for (const engine of ['chromium', 'webkit']) for (const viewport of [
    { width: 320, height: 568 }, { width: 390, height: 844 },
    { width: 844, height: 390 }, { width: 1440, height: 1000 }
]) for (const empty of [true, false]) {
    test(`${engine} ${viewport.width}x${viewport.height} ${empty ? 'empty' : 'short'} directory can always reveal the toolbar`, async t => {
        const app = await startTopicsPreview({ built: false });
        app.state.topics = empty ? [] : [{ ...fixtureTopics[0], configured: true, isMine: true }];
        const context = await browsers.get(engine).newContext({ viewport, hasTouch: viewport.width <= 390, reducedMotion: 'reduce' });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.setDefaultTimeout(10000);
        t.after(async () => { await context.close(); await app.close(); assert.deepEqual(errors, []); });
        await page.goto(app.url);
        await page.waitForFunction(() => document.getElementById('topics-grid').getAttribute('aria-busy') === 'false');
        assert.equal(await page.locator('.th-card:visible').count(), empty ? 0 : 1);
        await exerciseScroll(page);
        await page.getByRole('tab', { name: 'Recent', exact: true }).click();
        await page.waitForFunction(() => document.body.dataset.collection === 'recent');
        assert.equal(await page.locator('.th-card:visible').count(), 0);
        await exerciseScroll(page);
        await page.getByRole('tab', { name: 'Mine', exact: true }).click();
        await page.waitForFunction(() => document.body.dataset.collection === 'configured');
        assert.equal(await page.locator('.th-card:visible').count(), empty ? 0 : 1);
        await exerciseScroll(page);
        await page.getByRole('tab', { name: 'Search topics' }).click();
        await page.getByRole('searchbox', { name: 'Search topics' }).fill('no matching topic 4821');
        assert.equal(await page.locator('.th-card:visible').count(), 0);
        await exerciseScroll(page);
        assert.equal(await page.locator('#topic-search').inputValue(), 'no matching topic 4821');
        assert.equal(await page.locator('#topic-search').isVisible(), false, 'Scrolling back down must not reopen the search');
        await page.getByRole('tab', { name: 'Search topics' }).click();
        assert.equal(await page.getByRole('searchbox', { name: 'Search topics' }).inputValue(), 'no matching topic 4821');
    });
}
