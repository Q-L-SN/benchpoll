import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { startTopicsPreview } from '../scripts/frontend/topics-home-fixtures.mjs';
import { startConfigSidebarPreview } from './helpers/config-sidebar-fixture-20261022.mjs';
import { renderTopicDirectory, renderPublicTopic, searchHead, replaceSearchSlot, PUBLIC_DOCUMENTS } from '../search-presentation.js';
import { PRIVACY_CONTENT_SECURITY_POLICY } from '../privacy-headers.js';

const output = 'D:/Codex-artifacts/website1/search-legal-20261101';
const browsers = new Map();
const origin = 'https://benchpoll.com';
const topic = { ID: 54, name: 'Intelligence', url: '/intelligence', description: 'Reasoning, knowledge, and getting useful work done.',
    isPrivate: false, hasWeights: true, scenes: [
        { ID: 101, name: 'Overall', description: 'Broad capability.', isDefault: true },
        { ID: 102, name: 'Real-time', description: 'Real-time capability.', isDefault: false }
    ] };
const snapshot = { models: [{ modelName: 'Example model', lower: 71, coverage: 85, comparable: true }],
    weights: [{ name: 'Example benchmark', conditionName: 'Version 1', weightBasisPoints: 10000 }] };

before(async () => {
    await mkdir(output, { recursive: true });
    const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    for (const launcher of [chromium, webkit]) browsers.set(launcher.name(), await launcher.launch({ headless: true, env }));
});
after(async () => { for (const browser of browsers.values()) await browser.close(); });

async function transform(page, pathname, render) {
    await page.route(url => url.pathname === pathname, async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: render(await response.text()),
            headers: { ...response.headers(), 'content-security-policy': PRIVACY_CONTENT_SECURITY_POLICY } });
    });
}

for (const engine of ['chromium', 'webkit']) for (const width of [390, 1440]) {
    test(`${engine} ${width}px public directory is useful with scripts disabled and does not expose private topics`, async t => {
        const fixture = await startTopicsPreview({ built: false, authenticated: false });
        const context = await browsers.get(engine).newContext({ javaScriptEnabled: false, viewport: { width, height: 900 } });
        const page = await context.newPage();
        t.after(async () => { await context.close(); await fixture.close(); });
        const topics = [topic, { ...topic, ID: 50, name: 'Hidden private plan', url: '/personal/50', isPrivate: true }];
        await transform(page, '/', html => replaceSearchSlot(replaceSearchSlot(html, 'metadata', searchHead(PUBLIC_DOCUMENTS[0], origin)),
            'directory', renderTopicDirectory(topics)));
        await page.goto(fixture.url);
        assert.equal(await page.locator('.th-server-card').count(), 1);
        assert.equal(await page.getByRole('link', { name: 'Intelligence', exact: true }).isVisible(), true);
        await page.getByText('Scenes (2)', { exact: true }).click();
        assert.equal(await page.getByRole('link', { name: 'Real-time', exact: true }).getAttribute('href'), '/intelligence?scene=102');
        assert.doesNotMatch(await page.content(), /Hidden private plan/);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.screenshot({ path: `${output}/directory-noscript-${engine}-${width}.png` });
    });

    test(`${engine} ${width}px public topic without scripts exposes real scores, weights and scene links`, async t => {
        const fixture = await startConfigSidebarPreview();
        const context = await browsers.get(engine).newContext({ javaScriptEnabled: false, viewport: { width, height: 900 } });
        const page = await context.newPage();
        t.after(async () => { await context.close(); await fixture.close(); });
        await transform(page, '/intelligence', html => renderPublicTopic(html, topic, topic.scenes[1], snapshot, origin));
        await page.goto(fixture.url + '/intelligence?scene=102');
        assert.equal(await page.getByRole('cell', { name: '85%' }).isVisible(), true);
        assert.equal(await page.getByText('Example model', { exact: true }).isVisible(), true);
        assert.equal(await page.getByText('Example benchmark', { exact: false }).isVisible(), true);
        assert.equal(await page.getByRole('link', { name: 'Overall', exact: true }).getAttribute('href'), '/intelligence');
        assert.equal(await page.getByRole('link', { name: 'Overall', exact: true }).isVisible(), true);
        assert.equal(await page.locator('.bp-context-row').evaluate(node => getComputedStyle(node).position), 'static');
        assert.equal(await page.getByRole('heading', { name: 'Evaluation items', exact: true }).isVisible(), true);
        assert.equal(await page.getByRole('navigation', { name: 'About BenchPoll' }).isVisible(), true);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.screenshot({ path: `${output}/topic-noscript-${engine}-${width}.png` });
    });
}

test('SSR topic cards hydrate once, with valid JSON-LD and no CSP violations', async t => {
    const fixture = await startTopicsPreview({ built: false, authenticated: false });
    const context = await browsers.get('chromium').newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage(), errors = [];
    t.after(async () => { await context.close(); await fixture.close(); });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (/Content Security Policy|violates.*directive/i.test(message.text())) errors.push(message.text()); });
    await transform(page, '/', html => replaceSearchSlot(replaceSearchSlot(html, 'metadata', searchHead(PUBLIC_DOCUMENTS[0], origin)),
        'directory', renderTopicDirectory([topic])));
    await page.goto(fixture.url);
    await page.waitForSelector('.th-card[data-preview-state="loaded"]');
    assert.equal(await page.locator('.th-server-card').count(), 0);
    assert.equal(await page.locator('.th-card').count(), fixture.state.topics.filter(item => !item.isPrivate).length);
    assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), origin + '/');
    assert.equal(await page.locator('#bp-search-structured-data').count(), 1);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${output}/directory-hydrated.png` });
});

test('workspace hydration replaces public snapshot with interactive rankings without metadata errors', async t => {
    const fixture = await startConfigSidebarPreview();
    const context = await browsers.get('chromium').newContext({ viewport: { width: 390, height: 900 } });
    const page = await context.newPage(), errors = [];
    t.after(async () => { await context.close(); await fixture.close(); });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (/Content Security Policy|violates.*directive/i.test(message.text())) errors.push(message.text()); });
    await transform(page, '/intelligence', html => renderPublicTopic(html, { ...topic, scenes: [] }, null, snapshot, origin));
    await page.goto(fixture.url + '/intelligence');
    await page.waitForSelector('#benchmark-rows .bp-benchmark-row');
    assert.equal(await page.locator('.bp-search-snapshot').count(), 0);
    assert.match(await page.title(), /Intelligence.*AI Index \| BenchPoll/);
    assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), origin + '/intelligence');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${output}/topic-hydrated-mobile.png` });
});

test('formal terms remain readable at mobile width', async t => {
    const fixture = await startConfigSidebarPreview();
    const context = await browsers.get('chromium').newContext({ viewport: { width: 390, height: 900 } });
    const page = await context.newPage();
    t.after(async () => { await context.close(); await fixture.close(); });
    const html = await readFile(new URL('../private/terms.html', import.meta.url), 'utf8');
    await page.route(url => url.pathname === '/terms', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto(fixture.url + '/terms');
    assert.equal(await page.getByRole('heading', { name: 'Terms of Use', exact: true }).isVisible(), true);
    assert.match(await page.locator('time').textContent(), /November 1, 2026/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: `${output}/terms-mobile.png` });
});
