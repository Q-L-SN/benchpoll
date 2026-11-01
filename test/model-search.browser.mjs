import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
import { startTopicsPreview, fixtureModels } from '../scripts/frontend/topics-home-fixtures.mjs';

let browser, mobileSafari;
before(async () => {
    const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    browser = await chromium.launch({ headless: true, env }); mobileSafari = await webkit.launch({ headless: true, env });
});
after(async () => { await browser.close(); await mobileSafari.close(); });

test('configuration search locates an unloaded model in a centered window', async t => {
    const app = await startPreview({ rankingStress: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await page.close(); await app.close(); assert.deepEqual(errors, []); });
    await page.goto(`${app.url}/Intelligence`);
    await page.waitForSelector('#model-rows .bp-model-row');
    await page.locator('#ranking-model-search button').first().click();
    await page.getByRole('combobox', { name: 'Search models' }).fill('Additional model 40');
    await page.getByRole('option', { name: 'Additional model 40', exact: true }).click();
    await page.waitForSelector('#model-rows .is-model-jump-focus');
    const centered = await page.evaluate(() => {
        const row = document.querySelector('#model-rows .is-model-jump-focus').getBoundingClientRect();
        const area = document.querySelector('#model-rows').getBoundingClientRect();
        return { distance: Math.abs((row.top + row.bottom - area.top - area.bottom) / 2), height: row.height };
    });
    assert.ok(centered.distance <= centered.height + 1, JSON.stringify(centered));
    assert.ok(app.state.requests.some(item => item.path === '/api/search_ranking_models'));
    assert.ok(app.state.requests.some(item => item.path === '/api/locate_ranking_model'));
});

for (const [engine, width] of [['chromium', 320], ['chromium', 340], ['chromium', 360], ['chromium', 375], ['chromium', 390], ['chromium', 430],
    ['webkit', 320], ['webkit', 340], ['webkit', 375]]) test(`${engine} mobile ranking search shares the filter row at ${width}px`, async t => {
    const app = await startPreview({ rankingStress: true });
    const page = await (engine === 'webkit' ? mobileSafari : browser).newPage({ viewport: { width, height: 844 }, hasTouch: true, reducedMotion: 'reduce' });
    page.setDefaultTimeout(7000);
    t.after(async () => { await page.close(); await app.close(); });
    await page.goto(`${app.url}/Intelligence`);
    await page.locator('button[data-mobile-panel="models"]').click();
    await page.waitForSelector('#model-rows .bp-model-row');
    const layout = await page.evaluate(() => {
        const mode = document.querySelector('.bp-scoring-switch').getBoundingClientRect();
        const search = document.querySelector('#ranking-model-search button').getBoundingClientRect();
        return { mode: mode.toJSON(), search: search.toJSON(), viewport: innerWidth,
            controls: [...document.querySelector('.bp-scoring-toolbar').children].map(node => ({ rect: node.getBoundingClientRect().toJSON(), margin: getComputedStyle(node).marginRight })) };
    });
    assert.ok(Math.abs((layout.mode.top + layout.mode.bottom) - (layout.search.top + layout.search.bottom)) < 4, JSON.stringify(layout));
    assert.ok(layout.search.right <= width + 1, JSON.stringify(layout));
    for (const help of await page.locator('.bp-scoring-help, .bp-quick-comparison-help').all()) {
        const bounds = await help.boundingBox();
        assert.ok(bounds.width >= 24 && bounds.height >= 44, JSON.stringify(bounds));
    }
    await page.locator('#ranking-model-search button').first().click();
    assert.equal(await page.getByRole('combobox', { name: 'Search models' }).isVisible(), true);
});

for (const width of [320, 390, 1440]) test(`home model search centers the selection in each visible topic at ${width}px`, async t => {
    const app = await startTopicsPreview();
    const models = fixtureModels({ categoryID: 54, scoreMode: 'available' });
    for (let index = 38; index <= 70; index++) models.push({ ...models[0], modelID: index, rank: index,
        modelName: `Extra model ${index}`, name: `Extra model ${index}`,
        comparisonIdentity: JSON.stringify([['model', true, index]]) });
    app.state.previewOverrides.set(54, { models });
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await page.close(); await app.close(); assert.deepEqual(errors, []); });
    await page.goto(app.url);
    await page.waitForSelector('.th-card[data-topic-id="54"] .th-model');
    await page.evaluate(() => scrollTo(0, document.getElementById('home-hero').getBoundingClientRect().bottom + scrollY + 24));
    await page.waitForFunction(() => !document.getElementById('topics-filters').hidden);
    await page.locator('#home-model-search button').first().click();
    await page.getByRole('combobox', { name: 'Search models' }).fill('Mistral Large 4');
    const panel = await page.locator('#home-model-search .bp-model-search-panel').boundingBox();
    assert.ok(panel.x >= 0 && panel.x + panel.width <= width, JSON.stringify(panel));
    await page.getByRole('option', { name: 'Mistral Large 4', exact: true }).click();
    const card = page.locator('.th-card[data-topic-id="54"]');
    await card.locator('.th-model.is-model-jump-focus').waitFor();
    await page.waitForTimeout(300);
    const centered = await card.evaluate(node => {
        const model = node.querySelector('.th-model.is-model-jump-focus').getBoundingClientRect();
        const viewport = node.querySelector('.th-model-scroll').getBoundingClientRect();
        return { distance: Math.abs((model.left + model.right - viewport.left - viewport.right) / 2), width: model.width };
    });
    assert.ok(centered.distance <= centered.width + 1, JSON.stringify(centered));
    assert.ok(app.state.requests.some(item => item.path === '/api/search_home_models'));
    assert.ok(app.state.requests.some(item => item.path === '/api/locate_topic_model' && item.body.categoryID === 54));
    const another = page.locator('.th-card[data-topic-id="1"]');
    await another.scrollIntoViewIfNeeded();
    await another.locator('.th-model.is-model-jump-focus').waitFor();
    assert.ok(app.state.requests.some(item => item.path === '/api/locate_topic_model' && item.body.categoryID === 1));
});

test('home model search preserves access to earlier and later results outside its centered window', async t => {
    const app = await startTopicsPreview();
    const models = fixtureModels({ categoryID: 54, scoreMode: 'available' });
    for (let index = 38; index <= 150; index++) models.push({ ...models[0], modelID: index, rank: index,
        modelName: `Extra model ${index}`, name: `Extra model ${index}`,
        comparisonIdentity: JSON.stringify([['model', true, index]]) });
    app.state.previewOverrides.set(54, { models });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(7000);
    t.after(async () => { await page.close(); await app.close(); });
    await page.goto(app.url);
    await page.waitForSelector('.th-card[data-topic-id="54"] .th-model');
    await page.evaluate(() => scrollTo(0, 800));
    await page.waitForFunction(() => !document.getElementById('topics-filters').hidden);
    await page.locator('#home-model-search button').first().click();
    await page.getByRole('combobox', { name: 'Search models' }).fill('Extra model 100');
    await page.getByRole('option', { name: 'Extra model 100', exact: true }).click();
    const card = page.locator('.th-card[data-topic-id="54"]');
    await card.locator('.th-model.is-model-jump-focus').waitFor();
    const scroll = card.locator('.th-model-scroll');
    await scroll.evaluate(node => { node.scrollLeft = 0; node.dispatchEvent(new Event('scroll')); });
    await page.waitForFunction(() => document.querySelector('.th-card[data-topic-id="54"] .th-model')?.dataset.rank === '38');
    await scroll.evaluate(node => { node.scrollLeft = node.scrollWidth; node.dispatchEvent(new Event('scroll')); });
    await page.waitForFunction(() => [...document.querySelectorAll('.th-card[data-topic-id="54"] .th-model')].some(node => node.dataset.rank === '150'));
});

test('home search suspends pending locations while the page is cached and resumes them on return', async t => {
    const app = await startTopicsPreview();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(7000);
    let release, started;
    const held = new Promise(resolve => { release = resolve; });
    const firstStarted = new Promise(resolve => { started = resolve; });
    let attempts = 0;
    t.after(async () => { release(); await page.close(); await app.close(); });
    await page.route('**/api/locate_topic_model', async route => {
        if (route.request().postDataJSON()?.categoryID === 54 && ++attempts === 1) {
            started();
            await held;
        }
        await route.continue().catch(() => {});
    });
    await page.goto(app.url);
    await page.waitForSelector('.th-card[data-topic-id="54"] .th-model');
    await page.evaluate(() => scrollTo(0, 800));
    await page.waitForFunction(() => !document.getElementById('topics-filters').hidden);
    await page.locator('#home-model-search button').first().click();
    await page.getByRole('combobox', { name: 'Search models' }).fill('Mistral Large 4');
    await page.getByRole('option', { name: 'Mistral Large 4', exact: true }).click();
    await firstStarted;
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    release();
    await page.waitForTimeout(250);
    assert.equal(attempts, 1, 'No retries while the page is suspended');
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await page.locator('.th-card[data-topic-id="54"] .th-model.is-model-jump-focus').waitFor();
    assert.equal(attempts, 2);
});
