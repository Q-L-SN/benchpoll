import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser.close(); });

for (const width of [390, 1440]) test(`live home model search uses real topic snapshots at ${width}px`, async t => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
    await page.goto('https://benchpoll.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.th-card .th-model', { timeout: 60000 });
    const card = page.locator('.th-card').filter({ has: page.locator('.th-model') }).first();
    const topicID = Number(await card.getAttribute('data-topic-id'));
    const modelName = (await card.locator('.th-model-name').first().textContent()).trim();
    assert.ok(topicID > 0 && modelName);
    await page.evaluate(() => scrollTo(0, document.getElementById('home-hero').getBoundingClientRect().bottom + scrollY + 24));
    await page.waitForFunction(() => !document.getElementById('topics-filters').hidden);
    await page.locator('#home-model-search button').first().click();
    await page.getByRole('combobox', { name: 'Search models' }).fill(modelName);
    const option = page.locator('#home-model-search [role="option"]').filter({ hasText: modelName }).first();
    await option.waitFor({ timeout: 60000 });
    const panel = await page.locator('#home-model-search .bp-model-search-panel').boundingBox();
    assert.ok(panel.x >= 0 && panel.x + panel.width <= width, JSON.stringify(panel));
    const location = page.waitForResponse(response => response.url().includes('/api/locate_topic_model')
        && response.request().postDataJSON()?.categoryID === topicID, { timeout: 60000 });
    await option.click();
    const response = await location;
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).found, true);
    await card.locator('.th-model.is-model-jump-focus').waitFor();
});

test('live configuration model search scrolls and highlights a real ranking row', async t => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
    await page.goto('https://benchpoll.com/Intelligence', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#model-rows .bp-model-row', { timeout: 60000 });
    await page.locator('#ranking-model-search button').first().click();
    await page.getByRole('combobox', { name: 'Search models' }).fill('gpt');
    const option = page.locator('#ranking-model-search [role="option"]').first();
    await option.waitFor({ timeout: 60000 });
    await option.click();
    await page.waitForSelector('#model-rows .is-model-jump-focus', { timeout: 60000 });
});

test('live new-model form retains its vendor selector without the extra prompt', async t => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
    await page.route('**/api/get_user_profile', route => route.fulfill({ json: {
        userID: '999999', userName: 'Preview user', userProfilePictureURL: null,
        hasVerifiedEmail: false, reviewEmailEnabled: false
    } }));
    await page.goto('https://benchpoll.com/contribute/models/new', { waitUntil: 'domcontentloaded' });
    await page.locator('[data-catalog-picker="vendor"]').waitFor({ timeout: 60000 });
    assert.equal(await page.getByText('Choose or add a vendor to continue.', { exact: true }).count(), 0);
});
