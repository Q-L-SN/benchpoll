import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startTopicsPreview } from '../scripts/frontend/topics-home-fixtures.mjs';
import { startPreview } from '../scripts/frontend/server.mjs';
import { topicCollections } from '../public/js/navigation/collections.js';

const built = process.env.TOPICS_HOME_BUILT === '1';
const home = await startTopicsPreview({ built, authenticated: true });
home.state.topics[0].scenes = [
    { ID: 101, sceneNumber: 1, name: 'General', isDefault: true },
    { ID: 102, sceneNumber: 2, name: 'Python' }
];
const workspace = await startPreview({ topics: [
    { ID: 1, publicID: 1, name: 'Intelligence' }, { ID: 2, publicID: 2, name: 'Coding', isMine: true },
    { ID: 3, publicID: 3, name: 'Language', scenes: [{ ID: 301, name: 'Italian', isDefault: true }] }
] });
const initialRecent = [2, 3].map((categoryID, index) => ({ categoryID, contextValues: {}, isPrivate: false, visitedAt: 100 - index }));
const names = Object.values(topicCollections);

async function choose(page, value, keyboard = false) {
    const trigger = page.getByRole('combobox', { name: 'Topic collection' });
    const current = await trigger.locator('span').innerText();
    await trigger.click();
    const options = page.locator('.bp-topic-collection-options:visible').getByRole('option');
    const labels = await options.allTextContents();
    assert.deepEqual(labels, [current, ...names.filter(name => name !== current && labels.includes(name))]);
    assert.equal(labels.at(-1), 'Search');
    const search = options.last();
    assert.notEqual(await search.evaluate(n => getComputedStyle(n).color), await options.first().evaluate(n => getComputedStyle(n).color));
    if (keyboard) { await trigger.press('End'); await trigger.press('Enter'); }
    else await options.getByText(topicCollections[value], { exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-collection-surface].is-choosing-collection'));
}

async function checkDisclosure(page, target) {
    const trigger = page.getByRole('combobox', { name: 'Topic collection' });
    const before = await trigger.textContent();
    const triggerStyle = () => trigger.evaluate(el => {
        const style = getComputedStyle(el);
        return { frame: [style.borderWidth, style.outlineStyle, style.backgroundColor, style.boxShadow, style.justifyContent],
            fontWeight: Number(style.fontWeight) };
    });
    const unframed = ['0px', 'none', 'rgba(0, 0, 0, 0)', 'none', 'flex-start'];
    const resting = await triggerStyle();
    assert.deepEqual(resting.frame, unframed);
    await trigger.click();
    assert.deepEqual((await triggerStyle()).frame, unframed);
    const backdrop = page.locator('.is-choosing-collection > .bp-collection-backdrop');
    assert.match(await backdrop.evaluate(el => getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter), /blur/);
    const point = await page.locator(target).first().boundingBox();
    const x = point.x + point.width - 12, y = Math.min(point.y + 16, page.viewportSize().height - 12);
    assert.equal(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.classList.contains('bp-collection-backdrop'), [x, y]), true);
    const url = page.url();
    await page.mouse.click(x, y);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await trigger.textContent(), before);
    assert.equal(page.url(), url);
    await trigger.press('ArrowDown');
    assert.equal(await trigger.evaluate(el => el.matches(':focus-visible')), true);
    const focused = await triggerStyle();
    assert.deepEqual(focused.frame, unframed);
    assert.ok(focused.fontWeight > resting.fontWeight, 'The label shows keyboard focus');
    await trigger.press('Escape');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    await trigger.press('r');
    assert.match(await trigger.getAttribute('aria-activedescendant'), /-recent$/);
    await trigger.press('Escape');
}

async function checkLanding(page) {
    const trigger = page.getByRole('combobox', { name: 'Topic collection' });
    await trigger.click();
    const trajectory = await page.locator('.bp-collection-option[data-view="created"]').evaluate(async option => {
        const word = option.firstElementChild;
        await Promise.all(word.getAnimations().map(animation => animation.finished));
        const start = word.getBoundingClientRect();
        option.click();
        const carried = document.querySelector('.bp-collection-flight');
        const motion = carried?.getAnimations()[0];
        if (carried !== word || !motion) return null;
        motion.pause(); motion.currentTime = 0;
        const from = word.getBoundingClientRect();
        motion.currentTime = motion.effect.getTiming().duration;
        const to = word.getBoundingClientRect(), anchor = document.querySelector('.bp-collection-trigger span').getBoundingClientRect();
        motion.finish();
        const center = box => box.top + box.height / 2;
        return { from: Math.abs(center(start) - center(from)), to: Math.abs(center(anchor) - center(to)),
            x: Math.abs(anchor.left - to.left), distance: Math.abs(center(from) - center(to)) };
    });
    assert.ok(trajectory && trajectory.from <= 1 && trajectory.to <= 1 && trajectory.x <= 1 && trajectory.distance > 20, JSON.stringify(trajectory));
    await page.locator('.bp-collection-flight').waitFor({ state: 'detached' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await choose(page, 'popular');
    assert.equal(await page.locator('.bp-collection-flight').count(), 0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
}

async function checkSearch(page, surface, query, matchingName) {
    const isHome = surface === 'home';
    const field = page.getByRole('searchbox', { name: 'Search topics', exact: true });
    const trigger = page.getByRole('combobox', { name: 'Topic collection' });
    const before = await trigger.boundingBox();
    await choose(page, 'search', isHome);
    assert.equal(await field.getAttribute('placeholder'), 'Search');
    assert.equal(await field.evaluate(node => node === document.activeElement), true);
    const searchSurfaces = await field.evaluate(input => [input.parentElement, input].map(element => {
        const style = getComputedStyle(element);
        return [style.borderWidth, style.outlineStyle, style.boxShadow, style.backgroundColor];
    }));
    const unframed = ['0px', 'none', 'none', 'rgba(0, 0, 0, 0)'];
    assert.deepEqual(searchSurfaces, [unframed, unframed], surface + ' focused search remains borderless');
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

async function checkFailedRemoval(page, row) {
    const star = row.locator('.bp-topic-favorite');
    const count = await star.textContent();
    let hold;
    const write = new Promise(resolve => { hold = resolve; });
    await page.route('**/api/set_topic_favorite', route => { hold(route); });
    await star.click();
    const request = await write;
    await row.waitFor({ state: 'hidden' });
    await request.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    await row.waitFor({ state: 'visible' });
    assert.equal(await star.textContent(), count);
    assert.equal(await star.getAttribute('aria-pressed'), 'true');
    await page.locator('.bp-toast.is-visible').getByText(/Could not update your favorites/).waitFor();
    await page.unroute('**/api/set_topic_favorite');
}

async function checkHome(page) {
    await page.goto(home.url);
    await page.locator('#topics-account[href="/me"]').waitFor();
    await page.locator('#topics-grid .th-card').first().waitFor();
    assert.equal(await page.locator('header [type=search], header #topic-search-toggle, header .bp-topic-collection').count(), 0);
    const topics = home.state.topics;
    const ids = () => page.locator('#topics-grid .th-card:not([hidden])').evaluateAll(nodes => nodes.map(n => Number(n.dataset.topicId)));
    assert.deepEqual(await ids(), topics.filter(t => !t.isPrivate).map(t => t.ID));
    await checkDisclosure(page, '#topics-grid .th-card');
    await checkLanding(page);
    const scenes = page.locator('#topics-grid .th-scene-toggle:not([hidden])').first();
    assert.equal(await scenes.getAttribute('data-scene-count'), '2');
    const glyph = await scenes.locator('i.fa-list-ul').evaluate(node => getComputedStyle(node, '::before').content);
    assert.ok(glyph.includes('\uf0ca'), glyph);
    await scenes.click(); await page.locator('#topic-scenes-dialog[open]').waitFor();
    await page.locator('#topic-scenes-close').click();
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
    await checkFailedRemoval(page, page.locator('#topics-grid .th-card[data-topic-id="' + old[0] + '"]'));
    await page.locator('#topics-grid .th-card:not([hidden]) .bp-topic-favorite').first().click();
    await page.waitForFunction(ID => document.querySelector(`#topics-grid .th-card[data-topic-id="${ID}"]`).hidden, old[0]);
    assert.equal((await ids()).includes(old[0]), false);
}

async function openWorkspace(page) {
    if (built) await page.route(workspace.url + '/1', async route => route.fulfill({ contentType: 'text/html',
        body: await readFile(new URL('../private/home-built.html', import.meta.url), 'utf8') }));
    await page.goto(workspace.url + '/1');
    await page.locator('#benchmark-rows .bp-benchmark-row').first().waitFor({ state: 'attached' });
    if (page.viewportSize().width <= 760) await page.locator('#taxonomy-toggle').click();
}

async function checkSidebar(page) {
    await openWorkspace(page);
    await checkDisclosure(page, '#config-sidebar .bp-brand');
    await checkLanding(page);
    const treeIDs = () => page.locator('#tree-content > [data-category-id]').evaluateAll(nodes => nodes.map(n => Number(n.dataset.categoryId)));
    await choose(page, 'created');
    await page.locator('#sidebar-topic-creation:not([hidden])').waitFor();
    await page.locator('#tree-content > [data-category-id="2"]').waitFor();
    assert.deepEqual(await treeIDs(), [2]);
    await choose(page, 'favorites');
    await page.locator('#tree-content > [data-category-id="3"]').waitFor();
    assert.deepEqual(await treeIDs(), [3]);
    await checkFailedRemoval(page, page.locator('#tree-content > [data-category-id="3"]'));
    await choose(page, 'configured');
    await page.locator('#configured-panel [data-location-category-id="1"]').waitFor();
    await choose(page, 'recent');
    await page.locator('#tree-content > [data-category-id="1"]').waitFor();
    assert.deepEqual(await treeIDs(), [1, 2, 3]);
    await checkSearch(page, 'sidebar', 'Italian', 'Language');
    assert.deepEqual(await treeIDs(), [1, 2, 3]);
}

async function checkOptions(page, expected) {
    const trigger = page.getByRole('combobox', { name: 'Topic collection' });
    await trigger.click();
    const options = page.locator('.bp-topic-collection-options:visible').getByRole('option');
    assert.deepEqual(await options.allTextContents(), expected.map(view => topicCollections[view]));
    await trigger.press('Escape');
}

async function checkEmptyCollections(page) {
    const originalTopics = home.state.topics;
    const originalWorkspace = { topics: workspace.state.topics, personalEntries: workspace.state.personalEntries, favorites: workspace.state.favorites };
    try {
        const topic = { ...originalTopics[0], isMine: false, configured: false, isFavorited: true };
        home.state.topics = [topic];
        await page.goto(home.url);
        const trigger = page.getByRole('combobox', { name: 'Topic collection' });
        const card = page.locator('#topics-grid .th-card');
        await card.waitFor();
        await page.locator('#topics-account[href="/me"]').waitFor();
        await checkOptions(page, ['popular', 'favorites', 'search']);
        await choose(page, 'favorites');
        await checkFailedRemoval(page, card);
        assert.equal(await trigger.textContent(), topicCollections.favorites);
        const star = card.locator('.bp-topic-favorite');
        await star.click();
        await page.waitForFunction(() => document.body.dataset.collection === 'popular');
        await checkOptions(page, ['popular', 'search']);
        await star.click();
        await page.locator('.bp-topic-favorite[aria-pressed="true"][aria-busy="false"]').waitFor();
        await checkOptions(page, ['popular', 'favorites', 'search']);

        home.state.topics = [];
        await page.reload();
        const search = page.getByRole('searchbox', { name: 'Search topics' });
        await search.waitFor();
        assert.equal(await trigger.count(), 0);
        await search.fill('no results');
        await page.getByRole('button', { name: 'Clear search', exact: true }).first().click();
        assert.equal(await search.inputValue(), '');

        Object.assign(workspace.state, { topics: originalWorkspace.topics.map(topic => ({ ...topic, isMine: false })), personalEntries: [], favorites: {} });
        await openWorkspace(page);
        await page.locator('#sidebar-topic-creation:not([hidden])').waitFor();
        await page.waitForFunction(() => JSON.parse(localStorage.getItem('benchpoll-sidebar-recent-v1:user:1') ?? '[]')
            .some(topic => topic.categoryID === 1));
        await checkOptions(page, ['popular', 'recent', 'search']);
        await page.getByRole('button', { name: 'Create topic', exact: true }).click();
        await page.locator('#create-topic-dialog[open]').waitFor();
        await page.getByRole('button', { name: 'Close topic editor' }).click();
    } finally {
        home.state.topics = originalTopics;
        Object.assign(workspace.state, originalWorkspace);
    }
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
            if (width === 1440) {
                const emptyPage = await browser.newPage({ viewport: { width, height: 850 } });
                const emptyErrors = []; emptyPage.on('pageerror', error => emptyErrors.push(error.message));
                await emptyPage.addInitScript(() => localStorage.setItem('benchpoll:config-sidebar-collapsed', 'false'));
                emptyPage.setDefaultTimeout(7000);
                await checkEmptyCollections(emptyPage);
                assert.deepEqual(emptyErrors, []);
                await emptyPage.close();
            }
            console.log(engine.name(), width, built ? 'built' : 'source', 'passed');
        } finally { await browser.close(); }
    }
} finally { await workspace.close(); await home.close(); }
