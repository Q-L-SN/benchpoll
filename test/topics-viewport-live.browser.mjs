import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const output = 'D:/Codex-artifacts/website1/topics-viewport-live-20261029';
let browser;
before(async () => { await mkdir(output, { recursive: true }); browser = await chromium.launch({ headless: true }); });
after(async () => { await browser.close(); });

for (const width of [390, 1440]) test(`live home switches from the introductory header to the frosted toolbar at ${width}px`, async t => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(30000);
    t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
    await page.goto('https://benchpoll.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.th-card .th-model', { timeout: 60000 });
    assert.equal(await page.locator('.th-header').evaluate(node => getComputedStyle(node).position), 'relative');
    assert.equal(await page.locator('#topics-navigation').isVisible(), false);
    assert.equal(await page.locator('.th-footer').count(), 0);
    assert.equal(await page.locator('#beta-feedback-link').isVisible(), true);
    await page.locator('#topics-more summary').click();
    assert.equal(await page.getByRole('link', { name: 'Privacy', exact: true }).getAttribute('href'), '/privacy');
    await page.locator('#topics-more summary').press('Escape');
    const links = await page.locator('.th-header-links > a').evaluateAll(nodes => nodes.map(node => node.id || node.getAttribute('aria-label')));
    await page.evaluate(() => scrollTo(0, document.getElementById('home-hero').getBoundingClientRect().bottom + scrollY + 24));
    await page.waitForFunction(() => !document.getElementById('topics-filters').hidden);
    assert.equal(await page.locator('.th-header').evaluate(node => getComputedStyle(node).position), 'fixed');
    assert.deepEqual(await page.locator('.th-header-links > a').evaluateAll(nodes => nodes.map(node => node.id || node.getAttribute('aria-label'))), links);
    assert.equal(await page.locator('#topics-score-toggle .fa-arrow-right-arrow-left').count(), 1);
    assert.equal(await page.locator('#topics-view-toggle .fa-arrow-right-arrow-left').count(), 1);
    assert.equal(await page.locator('.th-pagination-next').first().evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
    await page.screenshot({ path: `${output}/home-${width}.png` });
});

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
    test(`live empty search can reveal the toolbar repeatedly at ${viewport.width}px`, async t => {
        const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.setDefaultTimeout(30000);
        t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
        await page.goto('https://benchpoll.com/', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.th-card .th-model', { timeout: 60000 });
        await page.evaluate(() => scrollTo(0, document.getElementById('home-hero').getBoundingClientRect().bottom + scrollY + 24));
        await page.waitForFunction(() => !document.getElementById('topics-filters').hidden);
        await page.getByRole('tab', { name: 'Search topics' }).click();
        await page.getByRole('searchbox', { name: 'Search topics' }).fill('no matching topic 4821');
        assert.equal(await page.locator('.th-card:visible').count(), 0);
        for (let round = 0; round < 2; round++) {
            await page.evaluate(() => scrollTo(0, 0));
            await page.waitForFunction(() => document.getElementById('topics-filters').hidden);
            const bounds = await page.evaluate(() => ({ maxScroll: document.documentElement.scrollHeight - innerHeight,
                heroBottom: document.getElementById('home-hero').getBoundingClientRect().bottom + scrollY }));
            assert.ok(bounds.maxScroll >= bounds.heroBottom - 1, JSON.stringify(bounds));
            await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
            await page.waitForFunction(() => !document.getElementById('topics-filters').hidden);
            assert.ok(await page.locator('#home-hero').evaluate(node => node.getBoundingClientRect().bottom) <= 1);
            assert.equal(await page.locator('.th-header').evaluate(node => getComputedStyle(node).position), 'fixed');
            assert.equal(await page.getByRole('searchbox', { name: 'Search topics' }).inputValue(), 'no matching topic 4821');
        }
    });
}

test('live mobile benchmark panel keeps the version bar clear and category entry outside the panel', async t => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(30000);
    t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
    await page.goto('https://benchpoll.com/Intelligence', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#benchmark-rows .bp-benchmark-information-link', { timeout: 60000 });
    assert.equal(await page.locator('#back-to-topics').isVisible(), false);
    assert.equal(await page.locator('#config-site-links > .th-social').isVisible(), true);
    assert.equal(await page.locator('#config-site-links > #taxonomy-toggle').isVisible(), true);
    assert.equal(await page.locator('#config-site-more').isVisible(), false);
    await page.locator('button[data-mobile-panel="mix"]').click();
    await page.locator('#benchmark-rows .bp-benchmark-information-link').first().click();
    await page.waitForSelector('#benchmark-information-name:not(:empty)');
    assert.equal(await page.getByRole('tab', { name: 'Discussion', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('.benchmark-scores-heading').count(), 0);
    await page.waitForSelector('#benchmark-information-weights:not([hidden])');
    assert.equal(await page.locator('#discussion-panel #discussion-entry').count(), 0);
    const weights = await page.locator('#benchmark-information-weights').evaluate(host => {
        const context = host.querySelector('#benchmark-weight-context').getBoundingClientRect();
        const values = host.querySelector('dl').getBoundingClientRect();
        return { text: host.textContent, offset: Math.abs(context.top - values.top) };
    });
    assert.doesNotMatch(weights.text, /Weight in /);
    assert.ok(weights.offset < 10, JSON.stringify(weights));
    await page.locator('#benchmark-scores-open').click();
    await page.waitForSelector('#benchmark-scores-list .benchmark-score-row', { timeout: 60000 });
    await page.locator('.discussion-scroll').evaluate(node => { node.scrollTop = 500; });
    await page.waitForFunction(() => document.querySelector('.discussion-scroll').scrollTop >= 250);
    const geometry = await page.evaluate(() => {
        const scroll = document.querySelector('.discussion-scroll').getBoundingClientRect();
        const label = document.querySelector('.benchmark-scores-condition').getBoundingClientRect();
        const select = document.querySelector('.benchmark-scores-condition .bp-ui-select-trigger').getBoundingClientRect();
        return { top: label.top - scroll.top, right: scroll.right - select.right };
    });
    assert.ok(Math.abs(geometry.top) <= 1 && geometry.right >= 7, JSON.stringify(geometry));
    await page.locator('#discussion-panel').screenshot({ path: `${output}/benchmark-390.png` });
    await page.locator('#discussion-close').click();
    assert.equal(await page.locator('#discussion-entry').isVisible(), true);
});
