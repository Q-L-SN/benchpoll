import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import { chromium, webkit, request } from 'playwright';

const origin = process.env.BENCHPOLL_TEST_ORIGIN || 'https://benchpoll.com';
const output = 'D:/Codex-artifacts/website1/search-legal-20261101';
const proxyURL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const parsedProxy = proxyURL ? new URL(proxyURL) : null;
const proxy = parsedProxy ? { server: parsedProxy.origin,
    ...(parsedProxy.username ? { username: decodeURIComponent(parsedProxy.username), password: decodeURIComponent(parsedProxy.password) } : {}) } : undefined;
let client, topics, featured, sceneTopic, scene;

before(async () => {
    await mkdir(output, { recursive: true });
    client = await request.newContext({ proxy, timeout: 90000 });
    const response = await client.post(origin + '/api/get_topics', { data: {} });
    assert.equal(response.status(), 200);
    ({ topics } = await response.json());
    featured = topics.find(topic => topic.ID === 54);
    sceneTopic = topics.find(topic => topic.scenes.length > 1);
    scene = sceneTopic.scenes.find(scene => !scene.isDefault);
});
after(async () => { await client?.dispose(); });

test('live public discovery, canonical metadata, error status and sensitive route exclusions', async () => {
    const response = await client.get(origin + '/');
    assert.equal(response.status(), 200);
    const html = await response.text();
    assert.match(html, /rel="canonical" href="https:\/\/benchpoll.com\/"/);
    assert.equal([...html.matchAll(/class="th-card th-server-card/g)].length, topics.length);
    const graph = JSON.parse(html.match(/type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
    assert.equal(graph.find(item => item['@type'] === 'ItemList').itemListElement.length, topics.length);
    for (const topic of topics) assert.ok(html.includes(`href="${topic.url}"`), topic.url);
    const sitemap = await client.get(origin + '/sitemap.xml');
    assert.equal(sitemap.status(), 200); assert.match(sitemap.headers()['content-type'], /application\/xml/);
    assert.equal(sitemap.headers()['set-cookie'], undefined);
    const xml = await sitemap.text();
    assert.equal([...xml.matchAll(/<url>/g)].length, topics.length + topics.reduce((sum, topic) => sum + topic.scenes.filter(scene => !scene.isDefault).length, 0) + 6);
    assert.doesNotMatch(xml, /\/personal\//);
    const robots = await client.get(origin + '/robots.txt');
    assert.equal(robots.status(), 200); assert.match(await robots.text(), /Sitemap: https:\/\/benchpoll.com\/sitemap.xml/);
    const llms = await client.get(origin + '/llms.txt');
    assert.equal(llms.status(), 200); assert.match(await llms.text(), /not new laboratory measurements/);
    for (const path of ['/terms', '/privacy', '/cookies', '/community-guidelines', '/how-it-works']) {
        const doc = await client.get(origin + path);
        assert.equal(doc.status(), 200);
        assert.ok((await doc.text()).includes(`rel="canonical" href="${origin}${path}"`));
    }
    assert.match(await (await client.get(origin + '/terms')).text(), /datetime="2026-11-01"/);
    for (const path of ['/search-discovery-missing-20261101', featured.url + '?scene=999999999']) {
        const missing = await client.get(origin + path, { maxRedirects: 0 });
        assert.equal(missing.status(), 404, path); assert.match(missing.headers()['x-robots-tag'], /noindex/);
        assert.match(await missing.text(), /name="benchpoll-page-error"/);
    }
    const canonical = await client.get(origin + featured.url.toUpperCase(), { maxRedirects: 0 });
    assert.equal(canonical.status(), 308); assert.equal(canonical.headers().location, featured.url);
    for (const path of ['/sign-in', '/account/privacy', '/personal/999999999', '/contribute', '/topic-proposals']) {
        const privatePage = await client.get(origin + path, { maxRedirects: 0 });
        assert.match(privatePage.headers()['x-robots-tag'], /noindex/, path);
    }
    const models = await client.post(origin + '/api/get_topic_preview', { data: {
        categoryID: featured.ID, scoreMode: 'available', reasoning: false, harness: false
    } });
    assert.equal(models.status(), 200);
    const snapshot = await models.json();
    const topicHTML = await (await client.get(origin + featured.url)).text();
    assert.match(topicHTML, /Measured coverage/);
    assert.ok(topicHTML.includes(snapshot.models[0].modelName));
    const scenario = await (await client.get(origin + sceneTopic.url + '?scene=' + scene.ID)).text();
    assert.ok(scenario.includes(`rel="canonical" href="${origin}${sceneTopic.url}?scene=${scene.ID}"`));
    assert.ok(scenario.includes(scene.name + ' AI Index | BenchPoll'));
});

for (const [engine, width] of [[chromium, 1440], [webkit, 390]]) test(`live search presentation hydrates correctly in ${engine.name()} ${width}`, async t => {
    const browser = await engine.launch({ headless: true, proxy });
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce',
        ...(width < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    const page = await context.newPage(), errors = [], writes = [], blockedTelemetry = [];
    page.setDefaultTimeout(60000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
        if (!/Content Security Policy|violates.*directive/i.test(message.text())) return;
        // The edge-injected beacon is intentionally excluded by the site's existing privacy CSP.
        if (/https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\//.test(message.text())) blockedTelemetry.push(message.text());
        else errors.push(message.text());
    });
    page.on('request', request => { if (/\/api\/(save_|create_|propose_|vote_)/.test(request.url())) writes.push(request.url()); });
    t.after(async () => {
        if (blockedTelemetry.length) t.diagnostic(`Existing privacy CSP blocked ${blockedTelemetry.length} edge telemetry injections`);
        await browser.close(); assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    });
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.th-card[data-preview-state="loaded"]');
    assert.equal(await page.locator('.th-server-card').count(), 0);
    assert.equal(await page.locator('.th-card:not([data-scene-id])').count(), topics.length);
    await page.screenshot({ path: `${output}/live-home-${width}.png` });
    await page.goto(origin + sceneTopic.url + '?scene=' + scene.ID, { waitUntil: 'domcontentloaded' });
    await page.locator(`#scene-tab-${scene.ID}[aria-selected="true"]`).waitFor();
    assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), origin + sceneTopic.url + '?scene=' + scene.ID);
    assert.ok((await page.title()).includes(scene.name));
    const defaultScene = sceneTopic.scenes.find(item => item.isDefault);
    await page.locator(`#scene-tab-${defaultScene.ID}`).click();
    await page.locator(`#scene-tab-${defaultScene.ID}[aria-selected="true"]`).waitFor();
    await page.waitForFunction(expected => document.querySelector('link[rel="canonical"]').href === expected, origin + sceneTopic.url);
    assert.equal(await page.locator('.bp-search-snapshot').count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: `${output}/live-topic-${width}.png` });
});

test('live no-script topic remains readable on mobile', async t => {
    const browser = await chromium.launch({ headless: true, proxy });
    t.after(() => browser.close());
    const page = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 390, height: 900 } });
    await page.goto(origin + featured.url, { waitUntil: 'load' });
    await page.getByRole('columnheader', { name: 'Measured coverage' }).waitFor();
    assert.ok(await page.locator('.bp-search-snapshot tbody tr').count() > 20);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: `${output}/live-topic-noscript-390.png` });
});
