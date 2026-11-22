import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startTopicsPreview } from '../scripts/frontend/topics-home-fixtures.mjs';
import { startPreview } from '../scripts/frontend/server.mjs';
import { topicCollections } from '../public/js/navigation/collections.js';

const built = process.env.TOPICS_HOME_BUILT === '1';
const home = await startTopicsPreview({ built, authenticated: true });
const workspace = await startPreview({ topics: [
    { ID: 1, publicID: 1, name: 'Intelligence' }, { ID: 2, publicID: 2, name: 'Coding', isMine: true },
    { ID: 3, publicID: 3, name: 'Language', scenes: [{ ID: 301, name: 'Italian', isDefault: true }] }
] });
const initialRecent = [2, 3].map((categoryID, index) => ({ categoryID, contextValues: {}, isPrivate: false, visitedAt: 100 - index }));
const names = Object.values(topicCollections);

async function choose(page, value, keyboard = false) {
    const trigger = page.getByRole('combobox', { name: 'Topic collection' });
    await trigger.click();
    const options = page.locator('.bp-topic-collection-options:visible').getByRole('option');
    assert.deepEqual(await options.allTextContents(), names);
    const search = options.last();
    assert.notEqual(await search.evaluate(n => getComputedStyle(n).color), await options.nth(2).evaluate(n => getComputedStyle(n).color));
    if (keyboard) { await trigger.press('End'); await trigger.press('Enter'); }
    else await options.getByText(topicCollections[value], { exact: true }).click();
}

async function checkSearch(page, surface, query, matchingName) {
    const isHome = surface === 'home';
    const field = page.getByRole('searchbox', { name: 'Search topics', exact: true });
    const trigger = page.getByRole('combobox', { name: 'Topic collection' });
    const before = await trigger.boundingBox();
    await choose(page, 'search', isHome);
    assert.equal(await field.getAttribute('placeholder'), 'Search');
    assert.equal(await field.evaluate(node => node === document.activeElement), true);
    const after = await field.locator('..').boundingBox();
    for (const axis of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(before[axis] - after[axis]) <= 1, surface + ' ' + axis);
    await field.fill(query);
    const result = page.locator(isHome ? '#topics-grid .th-card:not([hidden]) .th-topic-name' : '#category-search-results .bp-topic-row-heading');
    await result.filter({ hasText: matchingName }).first().waitFor();
    await page.getByRole('button', { name: 'Clear search', exact: true }).first().click();
    assert.equal(await field.inputValue(), '');
    await field.press('Escape');
    assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
}

async function checkHome(page) {
    await page.goto(home.url);
    await page.locator('#topics-account[href="/me"]').waitFor();
    await page.locator('#topics-grid .th-card').first().waitFor();
    assert.equal(await page.locator('header [type=search], header #topic-search-toggle, header .bp-topic-collection').count(), 0);
    const topics = home.state.topics;
    const ids = () => page.locator('#topics-grid .th-card:not([hidden])').evaluateAll(nodes => nodes.map(n => Number(n.dataset.topicId)));
    assert.deepEqual(await ids(), topics.filter(t => !t.isPrivate).map(t => t.ID));
    for (const [view, predicate] of [['favorites', t => t.isFavorited], ['configured', t => t.configured], ['created', t => t.isMine]]) {
        await choose(page, view);
        assert.deepEqual(await ids(), topics.filter(predicate).map(t => t.ID));
    }
    await choose(page, 'recent');
    assert.deepEqual(await ids(), [2, 3]);
    await checkSearch(page, 'home', 'Intelligence', 'Intelligence');
    assert.deepEqual(await ids(), [2, 3]);
    await choose(page, 'popular');
    await page.evaluate(() => window.scrollTo(0, 850));
    await page.waitForSelector('body.is-scrolled');
    const rect = await page.locator('#topics-navigation').boundingBox();
    const head = await page.locator('.th-header').boundingBox();
    assert.ok(rect.y >= head.y + head.height - 1 && rect.y < head.height + 22 && rect.x <= 80);
    await choose(page, 'favorites');
    const old = await ids();
    await page.locator('#topics-grid .th-card:not([hidden]) .bp-topic-favorite').first().click();
    await page.waitForFunction(ID => document.querySelector(`#topics-grid .th-card[data-topic-id="${ID}"]`).hidden, old[0]);
    assert.equal((await ids()).includes(old[0]), false);
}

async function checkSidebar(page) {
    if (built) await page.route(workspace.url + '/1', async route => route.fulfill({ contentType: 'text/html',
        body: await readFile(new URL('../private/home-built.html', import.meta.url), 'utf8') }));
    await page.goto(workspace.url + '/1');
    await page.locator('#benchmark-rows .bp-benchmark-row').first().waitFor({ state: 'attached' });
    if (page.viewportSize().width <= 760) await page.locator('#taxonomy-toggle').click();
    const treeIDs = () => page.locator('#tree-content > [data-category-id]').evaluateAll(nodes => nodes.map(n => Number(n.dataset.categoryId)));
    await choose(page, 'created');
    await page.locator('#sidebar-topic-creation:not([hidden])').waitFor();
    await page.locator('#tree-content > [data-category-id="2"]').waitFor();
    assert.deepEqual(await treeIDs(), [2]);
    await choose(page, 'favorites');
    await page.locator('#tree-content > [data-category-id="3"]').waitFor();
    assert.deepEqual(await treeIDs(), [3]);
    await choose(page, 'configured');
    await page.locator('#configured-panel [data-location-category-id="1"]').waitFor();
    await choose(page, 'recent');
    await page.locator('#tree-content > [data-category-id="1"]').waitFor();
    assert.deepEqual(await treeIDs(), [1, 2, 3]);
    await checkSearch(page, 'sidebar', 'Italian', 'Language');
    assert.deepEqual(await treeIDs(), [1, 2, 3]);
}

try {
    for (const [engine, width] of [[webkit, 390], [chromium, 1440], [webkit, 320]]) {
        const browser = await engine.launch();
        try {
            const page = await browser.newPage({ viewport: { width, height: 850 }, isMobile: width < 761, hasTouch: width < 761 });
            page.setDefaultTimeout(7000);
            const errors = []; page.on('pageerror', error => errors.push(error.message));
            workspace.state.favorites = { 3: { active: true, count: 23 } };
            await page.addInitScript(recent => {
                for (const owner of ['1', '42']) localStorage.setItem('benchpoll-sidebar-recent-v1:user:' + owner, JSON.stringify(recent));
                localStorage.setItem('benchpoll:config-sidebar-collapsed', 'false');
            }, initialRecent);
            await checkHome(page); await checkSidebar(page);
            assert.deepEqual(errors, []);
            console.log(engine.name(), width, built ? 'built' : 'source', 'passed');
        } finally { await browser.close(); }
    }
} finally { await workspace.close(); await home.close(); }
