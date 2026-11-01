import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { startTopicsPreview } from '../scripts/frontend/topics-home-fixtures.mjs';

const output = resolve('D:/Codex-artifacts/website1/topics-home-header-20261028');
const browsers = new Map();
const widths = [320, 360, 390, 760, 768, 1024, 1280, 1440];

before(async () => {
    const temp = join(output, 'tmp');
    await mkdir(temp, { recursive: true });
    const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    for (const launcher of [chromium, webkit]) browsers.set(launcher.name(), await launcher.launch({ headless: true, env }));
});

after(async () => { for (const browser of browsers.values()) await browser.close(); });

async function startPage(t, engine, width, options = {}) {
    const fixture = await startTopicsPreview({ built: false, ...options });
    const context = await browsers.get(engine).newContext({ viewport: { width, height: 900 },
        hasTouch: width <= 390, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    t.after(async () => {
        await context.close();
        await fixture.close();
        assert.deepEqual(errors, [], 'No uncaught page errors');
    });
    await page.goto(fixture.url);
    await page.waitForFunction(() => document.querySelector('.th-card[data-topic-id="54"][data-preview-state="loaded"] .th-model'));
    await page.evaluate(() => document.fonts.ready);
    return { page, fixture };
}

async function assertHeaderGeometry(page) {
    const layout = await page.evaluate(() => {
        const rect = node => {
            const box = node.getBoundingClientRect();
            return { name: node.id || node.getAttribute('aria-label') || node.className,
                left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
        };
        const nodes = document.querySelectorAll('.th-brand, .th-search, .th-filter-bar button, .th-header-links > a, .th-more > summary');
        return { overflow: document.documentElement.scrollWidth - innerWidth,
            items: [...nodes].filter(node => node.getClientRects().length).map(rect) };
    });
    assert.ok(layout.overflow <= 1, `Document overflow: ${JSON.stringify(layout)}`);
    for (const [index, first] of layout.items.entries()) {
        assert.ok(first.left >= -1 && first.right <= await page.evaluate(() => innerWidth) + 1, JSON.stringify(first));
        for (const second of layout.items.slice(index + 1)) {
            const intersectionWidth = Math.min(first.right, second.right) - Math.max(first.left, second.left);
            const intersectionHeight = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
            assert.ok(intersectionWidth <= 1 || intersectionHeight <= 1, `Overlapping header controls: ${JSON.stringify({ first, second })}`);
        }
    }
}

async function revealSettings(page) {
    await page.evaluate(() => scrollTo(0, document.getElementById('home-hero').getBoundingClientRect().bottom + scrollY + 24));
    await page.waitForFunction(() => !document.getElementById('topics-filters').hidden);
}

for (const engine of ['chromium', 'webkit']) {
    test(`${engine} search opens below navigation and settings occupy a separate island`, async t => {
        const { page } = await startPage(t, engine, 390);
        await revealSettings(page);
        await page.getByRole('tab', { name: 'Search topics' }).click();
        assert.equal(await page.getByRole('tab', { name: 'Search topics' }).isVisible(), true);
        assert.equal(await page.getByRole('tab', { name: 'Popular' }).isVisible(), true);
        assert.equal(await page.getByRole('searchbox', { name: 'Search topics' }).evaluate(node => node === document.activeElement), true);
        const boxes = await page.evaluate(() => ({
            header: document.querySelector('.th-header').getBoundingClientRect().bottom,
            search: document.querySelector('.th-search').getBoundingClientRect().toJSON(),
            island: document.getElementById('topics-filters').getBoundingClientRect().toJSON(),
            fixed: getComputedStyle(document.getElementById('topics-filters')).position
        }));
        assert.ok(boxes.search.top >= boxes.header - 1, JSON.stringify(boxes));
        assert.ok(boxes.island.top >= boxes.search.bottom, JSON.stringify(boxes));
        assert.equal(boxes.fixed, 'fixed');
        await page.getByRole('tab', { name: 'Search topics' }).click();
        assert.equal(await page.getByRole('searchbox', { name: 'Search topics' }).isVisible(), false);
        assert.equal(await page.getByRole('tab', { name: 'Popular' }).getAttribute('aria-selected'), 'true');
    });
    for (const width of widths) {
        test(`${engine} ${width}px integrated home header, settings and plot navigation`, async t => {
            const { page, fixture } = await startPage(t, engine, width);
            const header = page.locator('.th-header');
            const filters = page.locator('#topics-filters');
            const card = page.locator('.th-card[data-topic-id="54"]');
            assert.equal(await filters.isVisible(), false);
            const compact = await page.locator('.th-header-links').evaluate(node => node.classList.contains('is-compact'));
            if (compact) await page.locator('#topics-more summary').click();
            const x = page.locator('.th-social');
            assert.equal(await x.getAttribute('href'), 'https://x.com/BenchPoll');
            assert.equal(await x.getAttribute('target'), '_blank');
            assert.match(await x.getAttribute('rel'), /\bnoopener\b/);
            assert.match(await x.getAttribute('rel'), /\bnoreferrer\b/);
            assert.equal(await x.locator('.th-x-mark').isVisible(), true);
            assert.equal(await page.locator('#topics-account .bp-identity-avatar').isVisible(), true);
            assert.equal(await page.locator('#topics-navigation').isVisible(), false);
            assert.equal(await header.evaluate(node => getComputedStyle(node).position), 'relative');
            assert.equal(await header.evaluate(node => getComputedStyle(node).backdropFilter), 'none');
            assert.equal(await page.locator('footer.th-footer').count(), 0);
            assert.equal(await page.locator('#beta-feedback-link').isVisible(), true);
            await assertHeaderGeometry(page);
            await page.screenshot({ path: join(output, `${engine}-${width}-initial.png`) });

            if (!compact) await page.locator('#topics-more summary').click();
            assert.equal(await page.getByRole('link', { name: 'Privacy', exact: true }).isVisible(), true);
            await page.locator('#topics-more summary').press('Escape');
            assert.equal(await page.locator('#topics-more').evaluate(node => node.open), false);

            await revealSettings(page);
            assert.equal(await header.evaluate(node => getComputedStyle(node).position), 'fixed');
            assert.equal(await page.locator('#topics-navigation').isVisible(), true);
            const island = await filters.boundingBox();
            if (width <= 760) assert.ok(Math.abs(island.x + island.width / 2 - width / 2) <= 1, JSON.stringify(island));
            else {
                const grid = await page.locator('#topics-grid').boundingBox();
                assert.ok(Math.abs(island.x - grid.x) <= 1, JSON.stringify({ island, grid }));
            }
            await assertHeaderGeometry(page);
            await page.getByRole('tab', { name: 'Search topics' }).click();
            await page.getByRole('searchbox', { name: 'Search topics' }).fill('Coding');
            assert.equal(await page.locator('.th-card:visible').count(), 1);
            await page.getByRole('searchbox', { name: 'Search topics' }).press('Escape');
            assert.equal(await page.locator('#topics-popular').getAttribute('aria-selected'), 'true');
            await page.locator('#topics').evaluate(node => node.scrollIntoView({ block: 'start' }));
            const bounds = await page.evaluate(() => ({ header: document.querySelector('.th-header').getBoundingClientRect().bottom,
                topics: document.getElementById('topics').getBoundingClientRect().top }));
            assert.ok(bounds.topics >= bounds.header - 1, JSON.stringify(bounds));
            await page.screenshot({ path: join(output, `${engine}-${width}-settings.png`) });

            const previous = card.getByRole('button', { name: 'Previous models' });
            const next = card.getByRole('button', { name: 'Next models' });
            assert.equal(await previous.isVisible(), false);
            assert.equal(await next.isEnabled(), true);
            await page.mouse.move(5, 5);
            const idleOpacity = await next.evaluate(node => Number(getComputedStyle(node).opacity));
            assert.equal(idleOpacity, width <= 390 ? 1 : 0);
            await next.focus();
            assert.equal(await next.evaluate(node => Number(getComputedStyle(node).opacity)), 1);
            assert.equal(await next.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
            await next.click();
            await page.waitForFunction(() => document.querySelector('.th-card[data-topic-id="54"] .th-model').closest('.th-model-scroll').scrollLeft > 0);
            await page.waitForFunction(() => !document.querySelector('.th-card[data-topic-id="54"] .th-pagination-previous').hidden);
            assert.equal(await previous.isVisible(), true);
            const scroll = card.locator('.th-model-scroll');
            await scroll.evaluate(node => { node.scrollLeft = node.scrollWidth; node.dispatchEvent(new Event('scroll')); });
            await page.waitForFunction(() => document.querySelectorAll('.th-card[data-topic-id="54"] .th-model').length === 37);
            await scroll.evaluate(node => { node.scrollLeft = node.scrollWidth; node.dispatchEvent(new Event('scroll')); });
            await page.waitForFunction(() => document.querySelector('.th-card[data-topic-id="54"] .th-pagination-next').hidden);
            assert.equal(await next.isVisible(), false);
            assert.equal(await previous.isVisible(), true);

            const score = page.locator('#topics-score-toggle');
            const view = page.locator('#topics-view-toggle');
            assert.equal(await score.locator('.fa-arrow-right-arrow-left').count(), 1);
            assert.equal(await view.locator('.fa-arrow-right-arrow-left').count(), 1);
            await score.click();
            assert.equal(await score.getAttribute('aria-pressed'), 'true');
            assert.equal(await score.innerText(), 'Score range');
            await page.waitForFunction(() => document.querySelector('.th-card[data-topic-id="54"]').dataset.previewState === 'loaded');
            assert.ok(fixture.state.requests.some(request => request.path === '/api/get_topic_preview' && request.body.categoryID === 54 && request.body.scoreMode === 'range'));
            await view.click();
            assert.equal(await view.getAttribute('aria-pressed'), 'true');
            assert.equal(await card.locator('.th-pagination').isVisible(), false);
            assert.equal(await card.locator('.th-treemap').getAttribute('role'), 'img');
            await view.focus();
            await page.evaluate(() => scrollTo(0, 0));
            await page.waitForFunction(() => document.getElementById('topics-filters').hidden);
            assert.equal(await page.evaluate(() => document.activeElement.classList.contains('th-brand')), true);
            await revealSettings(page);
            assert.equal(await score.getAttribute('aria-pressed'), 'true');
            assert.equal(await view.getAttribute('aria-pressed'), 'true');
            await view.click();
            assert.equal(await view.getAttribute('aria-pressed'), 'false');
            assert.equal(await card.locator('.th-visual').getAttribute('data-view'), 'default');
            const modelURL = await card.locator('a.th-model').first().getAttribute('href');
            const url = new URL(modelURL, fixture.url);
            assert.equal(url.searchParams.get('scoreMode'), 'range');
            assert.ok(url.searchParams.get('focusModel'));
            assert.equal(await header.evaluate(node => getComputedStyle(node).position), 'fixed');
        });
    }

    test(`${engine} preserves private creation and model activation`, async t => {
        const { page, fixture } = await startPage(t, engine, 390);
        await revealSettings(page);
        await page.getByRole('tab', { name: 'Mine', exact: true }).click();
        await page.getByRole('button', { name: 'New private topic' }).click();
        await page.getByLabel('Name', { exact: true }).fill('My research topic');
        await page.getByLabel('One-sentence summary').fill('My private research priorities.');
        await page.getByRole('button', { name: 'Create private topic' }).click();
        await page.waitForFunction(() => !document.getElementById('create-topic-dialog').open);
        assert.equal(fixture.state.created.length, 1);
        assert.equal(fixture.state.created[0].isPrivate, true);
        assert.equal(await page.locator('.th-card[data-topic-id="200"]').isVisible(), true);
        await page.waitForFunction(() => document.getElementById('topics-announcement').textContent.includes('created.'));

        await revealSettings(page);
        await page.getByRole('tab', { name: 'Popular', exact: true }).click();
        const model = page.locator('.th-card[data-topic-id="54"] a.th-model').first();
        const target = new URL(await model.getAttribute('href'), fixture.url);
        await page.route('**/community-priorities?**', route => route.fulfill({ status: 200, contentType: 'text/html', body: 'Model target' }));
        await model.click();
        await page.waitForURL(url => url.pathname === target.pathname && url.searchParams.get('focusModel') === target.searchParams.get('focusModel'));
        assert.equal(await page.locator('body').innerText(), 'Model target');
    });
}
