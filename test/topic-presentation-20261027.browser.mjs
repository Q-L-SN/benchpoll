import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, webkit } from 'playwright';
import { startTopicsPreview } from '../scripts/frontend/topics-home-fixtures.mjs';
import { startConfigSidebarPreview } from './helpers/config-sidebar-fixture-20261022.mjs';
import { betaFeedbackTemplate } from '../public/js/shared/feedback-templates.js';

const output = resolve('D:/Codex-artifacts/website1/topic-presentation-20261027');
const browsers = new Map();
const widths = [1440, 480, 390, 320];
const storageKey = 'benchpoll:config-sidebar-collapsed';
const sponsor = { name: 'A sponsor with a long display name', avatarURL: '/assets/apple-touch-icon.png' };

before(async () => {
    const temp = join(output, 'tmp');
    await mkdir(temp, { recursive: true });
    const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    for (const launcher of [chromium, webkit]) browsers.set(launcher.name(), await launcher.launch({ headless: true, env }));
});
after(async () => { for (const browser of browsers.values()) await browser.close(); });

async function pageFor(t, engine, fixture, width, { path = '/', init } = {}) {
    const context = await browsers.get(engine).newContext({ viewport: { width, height: 900 },
        hasTouch: width <= 480, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [], csp = [], external = [];
    let disposed = false;
    const dispose = async () => {
        if (disposed) return;
        disposed = true;
        try { await context.close(); }
        finally { await fixture.close(); }
        assert.deepEqual(errors, [], 'No console, script or HTTP errors');
        assert.deepEqual(csp, [], 'No CSP violations');
        assert.deepEqual(external, [], 'No production or external requests');
    };
    t.after(dispose);
    page.setDefaultTimeout(9000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    await page.exposeFunction('__topicCSPFailure', value => csp.push(value));
    await context.addInitScript(() => document.addEventListener('securitypolicyviolation', event => {
        void globalThis.__topicCSPFailure({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
    }));
    await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === fixture.url) return route.continue();
        external.push(route.request().url());
        return route.abort();
    });
    if (init) await init({ page, context });
    const response = await page.goto(fixture.url + path);
    assert.equal(response.status(), 200);
    await page.evaluate(() => document.fonts.ready);
    return { page, context, dispose };
}

async function homeReady(page) {
    await page.waitForFunction(() => document.getElementById('topics-grid').getAttribute('aria-busy') === 'false'
        && document.querySelector('.th-card[data-preview-state="loaded"] .th-model'));
}

async function configReady(page) {
    await page.waitForFunction(() => document.getElementById('benchmark-card')?.getAttribute('aria-busy') === 'false'
        && document.querySelector('#benchmark-rows .bp-benchmark-row') && document.body.dataset.configSidebarPhase === 'idle');
}

async function revealNavigation(page) {
    await page.evaluate(() => scrollTo(0, document.getElementById('home-hero').getBoundingClientRect().bottom + scrollY + 24));
    await page.waitForFunction(() => !document.getElementById('topics-filters').hidden);
}

async function openSidebar(page, width) {
    if (width <= 760) {
        await page.locator('#taxonomy-toggle').click();
        await page.waitForFunction(() => document.body.classList.contains('taxonomy-open'));
    } else if (await page.locator('body').evaluate(node => node.classList.contains('config-sidebar-collapsed'))) {
        await page.locator('#config-sidebar-toggle').click();
        await page.waitForFunction(() => !document.body.classList.contains('config-sidebar-collapsed')
            && document.body.dataset.configSidebarPhase === 'idle');
    }
}

const screenshot = (page, name) => page.screenshot({ path: join(output, name + '.png'), fullPage: true });

async function assertNoOverflow(page) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'No horizontal document overflow');
}

async function chartMetrics(card) {
    return card.evaluate(node => {
        const visual = node.querySelector('.th-visual').getBoundingClientRect();
        const header = node.querySelector('.th-card-header').getBoundingClientRect();
        const summary = node.querySelector('.th-topic-summary');
        const summaryBox = summary.getBoundingClientRect();
        const style = getComputedStyle(node), summaryStyle = getComputedStyle(summary);
        const scroll = node.querySelector('.th-model-scroll').getBoundingClientRect();
        const columns = [...node.querySelectorAll('.th-model')].map(model => {
            const box = model.getBoundingClientRect();
            return { left: box.left, right: box.right, width: box.width, opacity: Number(getComputedStyle(model).opacity) };
        });
        const visible = columns.filter(column => column.opacity > .99);
        const partial = columns.filter(column => column.opacity > .01 && column.opacity < .99);
        return { height: node.getBoundingClientRect().height, header: header.height, visual: visual.height,
            expectedVisual: node.getBoundingClientRect().height - parseFloat(style.gridTemplateRows) - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
                - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth),
            summary: { font: parseFloat(summaryStyle.fontSize), weight: Number(summaryStyle.fontWeight),
                height: summaryBox.height, bottom: summaryBox.bottom, title: summary.title, text: summary.textContent },
            headerBottom: header.bottom, visualTop: visual.top, visible: visible.length, partial: partial.length,
            complete: visible.every(column => column.left >= scroll.left - 1 && column.right <= scroll.right + 1),
            bar: node.querySelector('.th-model-bar').getBoundingClientRect().height };
    });
}

for (const engine of ['chromium', 'webkit']) {
    for (const width of widths) {
        test(`${engine} ${width}px Home: quiet one-line summaries, optional byline, fixed chart and complete bars`, async t => {
            const fixture = await startTopicsPreview({ built: false });
            for (const topic of fixture.state.topics) topic.creator = null;
            const featured = fixture.state.topics.find(topic => topic.ID === 54);
            featured.creator = sponsor;
            featured.description = 'Community-selected benchmarks for reasoning across scientific, mathematical, and practical problems.';
            const { page } = await pageFor(t, engine, fixture, width);
            await homeReady(page);
            assert.deepEqual(await page.locator('[data-topics-view]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))),
                ['Popular', 'Recent', 'Mine', 'Search topics']);
            assert.equal(await page.locator('#new-topic').getAttribute('href'), '/topic-proposals');
            assert.equal(await page.locator('#new-private-topic').isVisible(), false);
            await page.screenshot({ path: join(output, `${engine}-${width}-home-viewport.png`) });
            const card = page.locator('.th-card[data-topic-id="54"]');
            await card.scrollIntoViewIfNeeded();
            await page.waitForFunction(() => document.querySelector('.th-card[data-topic-id="54"]').dataset.previewState === 'loaded');
            assert.equal(await card.locator('.th-topic-summary').innerText(), featured.description);
            assert.equal(await card.locator('.th-creator .bp-topic-byline-name').innerText(), sponsor.name);
            assert.equal(await page.locator('.th-card[data-topic-id="1"] .th-creator').isVisible(), false);
            assert.equal(await page.locator('.th-card[data-topic-id="1"] .bp-topic-byline').count(), 0);
            assert.equal(await card.locator('.th-topic-link > .fa-chevron-right').count(), 1);
            assert.equal(await card.locator('.th-topic-link > .fa-arrow-right').count(), 0);
            const creator = await card.locator('.th-creator').boundingBox();
            const summary = await card.locator('.th-topic-summary').boundingBox();
            const pagination = await card.locator('.th-pagination').boundingBox();
            assert.ok(summary.x + summary.width <= creator.x + 1);
            assert.ok(pagination.y >= creator.y + creator.height);
            const initial = await chartMetrics(card);
            assert.equal(initial.height, 456);
            assert.equal(initial.header, 38);
            assert.ok(Math.abs(initial.visual - initial.expectedVisual) < 1);
            assert.ok(initial.summary.font === 13 && initial.summary.weight === 400 && initial.summary.height <= 20);
            assert.ok(initial.summary.bottom <= initial.headerBottom + 1 && initial.headerBottom <= initial.visualTop + 1);
            assert.ok(initial.complete && initial.visible > 0 && initial.partial === 0 && initial.bar > 0, JSON.stringify(initial));
            assert.equal(initial.summary.title, featured.description);
            await assertNoOverflow(page);
            await screenshot(page, `${engine}-${width}-home`);
            await card.screenshot({ path: join(output, `${engine}-${width}-topic-card.png`) });
            const next = card.getByRole('button', { name: 'Next models', exact: true });
            if (await next.isEnabled()) {
                const offset = await card.locator('.th-model-scroll').evaluate(node => node.scrollLeft);
                await next.click();
                await page.waitForFunction(({ offset }) => document.querySelector('.th-card[data-topic-id="54"] .th-model-scroll').scrollLeft > offset, { offset });
                await page.waitForFunction(() => {
                    const scroll = document.querySelector('.th-card[data-topic-id="54"] .th-model-scroll').getBoundingClientRect();
                    return [...document.querySelectorAll('.th-card[data-topic-id="54"] .th-model')].every(node => {
                        const opacity = Number(getComputedStyle(node).opacity), box = node.getBoundingClientRect();
                        return opacity < .01 || opacity > .99 && box.left >= scroll.left - 1 && box.right <= scroll.right + 1;
                    });
                });
                const after = await chartMetrics(card);
                assert.equal(after.height, initial.height);
                assert.equal(after.visual, initial.visual);
                assert.equal(after.complete, true);
            }
            assert.equal(await page.locator('#home-coverage-penalty, .bp-coverage-experiment').count(), 0);
            assert.ok(fixture.state.requests.filter(request => request.path === '/api/get_topic_preview')
                .every(request => request.body.availableInferenceVersion === 7));
            await revealNavigation(page);
            await page.locator('#topics-configured').click();
            const expected = fixture.state.topics.filter(topic => topic.configured || topic.isPrivate && topic.isMine);
            assert.deepEqual(await page.locator('.th-card:visible').evaluateAll(nodes => nodes.map(node => Number(node.dataset.topicId))),
                expected.map(topic => topic.ID));
            assert.equal(await page.locator('.th-card[data-topic-id="15"]').isVisible(), true);
            assert.equal(await page.locator('#new-private-topic').isVisible(), true);
            assert.equal(await page.locator('#new-topic').getAttribute('href'), '/topic-proposals');
        });

        test(`${engine} ${width}px configuration: actual universal summary, quiet filled mode icons and complete selected cards`, async t => {
            const fixture = await startConfigSidebarPreview();
            for (const topic of fixture.topics) { topic.description = `Actual scope for ${topic.name}.`; topic.creator = null; }
            const legacyDuplicate = fixture.topics.find(topic => topic.ID === 190);
            legacyDuplicate.name = 'Secondary research'; legacyDuplicate.slug = 'secondary-research';
            fixture.topics[0].name = 'AGI';
            fixture.topics[0].slug = 'agi';
            fixture.topics[0].description = 'Actual AGI topic description, not a special promotional title.';
            fixture.topics[1].creator = sponsor;
            const { page } = await pageFor(t, engine, fixture, width, { path: '/agi', init: async ({ context }) => {
                await context.addInitScript(() => sessionStorage.setItem('benchpoll-sidebar-preferences-v1',
                    JSON.stringify({ view: 'mine', scroll: { mine: 0 } })));
            } });
            await configReady(page);
            assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), null, 'Initial state does not overwrite preferences');
            if (width > 760) {
                assert.equal(await page.locator('body').evaluate(node => node.classList.contains('config-sidebar-collapsed')), true);
                assert.equal(await page.locator('#config-sidebar').getAttribute('aria-hidden'), 'true');
                await screenshot(page, `${engine}-${width}-configuration-first-visit`);
            }
            assert.equal(await page.locator('#workspace-topic-summary').innerText(), fixture.topics[0].description);
            assert.equal(await page.locator('.bp-context-identity > #workspace-topic-summary').count(), 1);
            assert.equal(await page.locator('.bp-page-heading #workspace-topic-summary, #agi-promo, .bp-agi-help').count(), 0);
            assert.equal(await page.locator('#workspace-topic-creator').isVisible(), false);
            await assertNoOverflow(page);
            await openSidebar(page, width);
            assert.equal(await page.locator('[data-navigation-view]').count(), 4);
            assert.equal(await page.locator('[data-navigation-view="configured"]').getAttribute('aria-label'), 'Mine');
            assert.equal(await page.locator('[data-navigation-view="configured"]').getAttribute('aria-pressed'), 'true');
            await page.locator('#configured-content [data-location-category-id="998"]').waitFor();
            assert.equal(await page.locator('#configured-content [data-location-category-id="998"]').getAttribute('data-configured'), 'false');
            assert.equal(await page.locator('#mine-panel, [data-navigation-view="mine"], [data-create-topic="public"], a[href="/topic-proposals"]').count(), 0);
            await page.screenshot({ path: join(output, `${engine}-${width}-mine-viewport.png`) });
            const sidebar = await page.locator('#config-sidebar').evaluate(node => {
                const style = getComputedStyle(node);
                return { background: style.backgroundColor, page: getComputedStyle(document.body).backgroundColor,
                    borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth] };
            });
            assert.equal(sidebar.background, sidebar.page);
            assert.deepEqual(sidebar.borders, ['0px', '0px', '0px', '0px']);
            for (const view of ['popular', 'recent', 'configured', 'search']) {
                const button = page.locator(`[data-navigation-view="${view}"]`);
                await button.click();
                assert.equal(await button.getAttribute('aria-pressed'), 'true');
                const selected = await button.evaluate(node => ({ background: getComputedStyle(node).backgroundColor,
                    color: getComputedStyle(node).color, accent: getComputedStyle(document.body).getPropertyValue('--bp-accent').trim(),
                    iconColor: getComputedStyle(node.querySelector('i')).color,
                    weight: getComputedStyle(node.querySelector('i')).fontWeight,
                    glyph: getComputedStyle(node.querySelector('i'), '::before').content,
                    shadow: getComputedStyle(node).boxShadow }));
                assert.equal(selected.background, 'rgba(0, 0, 0, 0)');
                assert.equal(selected.shadow, 'none');
                assert.equal(selected.iconColor, selected.color);
                assert.equal(selected.weight, '900');
                assert.ok(selected.glyph && !['none', 'normal', '""'].includes(selected.glyph));
                if (view === 'recent') await screenshot(page, `${engine}-${width}-sidebar-recent`);
                if (width > 760) {
                    await button.hover();
                    assert.equal(await button.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
                }
            }
            await page.locator('[data-navigation-view="popular"]').click();
            const selected = page.locator('#tree-content [data-category-id="54"]');
            await selected.waitFor();
            const emphasis = await selected.evaluate(node => {
                const style = getComputedStyle(node);
                const other = node.parentElement.querySelector('[data-category-id="167"]');
                return { background: style.backgroundColor, other: getComputedStyle(other).backgroundColor,
                    colors: [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor],
                    widths: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
                    shadow: style.boxShadow };
            });
            assert.notEqual(emphasis.background, emphasis.other);
            assert.ok(emphasis.colors.every(color => color === emphasis.colors[0]));
            assert.ok(emphasis.widths.every(value => parseFloat(value) >= 1));
            assert.equal(emphasis.shadow, 'none');
            await screenshot(page, `${engine}-${width}-sidebar-selected-topic`);
            if (width > 760) {
                assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), 'false');
                await page.reload();
                await configReady(page);
                assert.equal(await page.locator('body').evaluate(node => node.classList.contains('config-sidebar-collapsed')), false);
            }
            await page.goto(fixture.url + '/research');
            await configReady(page);
            assert.equal(await page.locator('#workspace-topic-summary').innerText(), fixture.topics[1].description);
            assert.equal(await page.locator('.bp-context-actions > #workspace-topic-creator .bp-topic-byline-name').innerText(), sponsor.name);
            assert.equal(await page.locator('#bp-breadcrumb .bp-topic-byline').count(), 0);
            await assertNoOverflow(page);
            await screenshot(page, `${engine}-${width}-configuration-sponsor`);
            assert.equal(await page.locator('#workspace-coverage-penalty, #beta-feedback-link').count(), 0);
        });
    }

    test(`${engine}: guests can enter the hall from Home without opening Mine, a modal or POSTing`, async t => {
        const fixture = await startTopicsPreview({ built: false, authenticated: false });
        const { page } = await pageFor(t, engine, fixture, 390, { init: async ({ page }) => {
            await page.route('**/topic-proposals', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Local hall destination</title>' }));
        } });
        await homeReady(page);
        assert.equal(await page.locator('#topics-popular').getAttribute('aria-selected'), 'true');
        if (!await page.locator('#new-topic').isVisible()) await page.locator('#topics-more summary').click();
        assert.equal(await page.locator('#new-topic').isVisible(), true);
        assert.equal(await page.locator('#new-private-topic').isVisible(), false);
        assert.equal(await page.locator('#create-topic-dialog').evaluate(node => node.open), false);
        assert.equal(await page.locator('#mine-actions #new-topic').count(), 0);
        const style = await page.locator('#new-topic').evaluate(node => ({ background: getComputedStyle(node).backgroundColor,
            border: getComputedStyle(node).borderTopWidth, underline: getComputedStyle(node).textDecorationLine,
            height: node.getBoundingClientRect().height }));
        assert.deepEqual(style, { background: 'rgba(0, 0, 0, 0)', border: '0px', underline: 'none', height: 44 });
        assert.equal(await page.locator('#new-topic').getAttribute('href'), '/topic-proposals');
        await page.locator('#new-topic').click();
        await page.waitForURL(fixture.url + '/topic-proposals');
        assert.equal(fixture.state.requests.filter(request => request.path === '/api/create_topic').length, 0);
        assert.equal(fixture.state.created.length, 0);
    });

    test(`${engine}: private-only modal has no visibility choice or review notice and guards duplicate creation`, async t => {
        const fixture = await startTopicsPreview({ built: false });
        const { page } = await pageFor(t, engine, fixture, 320);
        await homeReady(page);
        await revealNavigation(page);
        await page.locator('#topics-configured').click();
        await page.locator('#new-private-topic').click();
        const dialog = page.getByRole('dialog', { name: 'New private topic', exact: true });
        assert.equal(await dialog.locator('input[type="checkbox"], input[type="radio"]').count(), 0);
        assert.doesNotMatch(await dialog.innerText(), /public topic|review|verified.*email/i);
        await page.locator('#new-topic-name').fill('My private presentation topic');
        await page.locator('#new-topic-description').fill('Personal coding benchmarks and weights.');
        await screenshot(page, `${engine}-320-private-modal`);
        let release;
        const hold = new Promise(resolveHold => { release = resolveHold; });
        t.after(() => release());
        const sent = [];
        await page.route('**/api/create_topic', async route => {
            sent.push(route.request().postDataJSON());
            await hold;
            await route.fallback();
        });
        await page.locator('#create-topic-submit').click();
        await page.waitForFunction(() => document.getElementById('create-topic-submit').disabled);
        await page.locator('#create-topic-form').evaluate(form => {
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
        await delay(100);
        assert.equal(sent.length, 1);
        assert.deepEqual(sent[0], { name: 'My private presentation topic', description: 'Personal coding benchmarks and weights.', isPrivate: true, expectedUserID: '42' });
        release();
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(fixture.state.created.length, 1);
        assert.equal(fixture.state.created[0].isPrivate, true);
        assert.equal(await page.locator('#topics-configured').getAttribute('aria-selected'), 'true');
        assert.equal(await page.locator('.th-card[data-topic-id="200"]').isVisible(), true);
        await assertNoOverflow(page);
    });

    test(`${engine}: the quiet Home Beta link activates the shared feedback template without query leakage`, async t => {
        const fixture = await startTopicsPreview({ built: false });
        const { page } = await pageFor(t, engine, fixture, 390, { init: async ({ page }) => {
            await page.route('**/contribute/feedback', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Local feedback destination</title>' }));
        } });
        await homeReady(page);
        const link = page.locator('#home-hero #beta-feedback-link');
        assert.equal(await link.innerText(), 'BenchPoll is in beta. Tell us what to improve.');
        const href = new URL(await link.getAttribute('href'), fixture.url);
        assert.equal(href.pathname, '/contribute/feedback');
        assert.equal(href.search, '');
        assert.match(href.hash, /^#entry=[0-9a-f-]{36}$/);
        await link.scrollIntoViewIfNeeded();
        const style = await link.evaluate(node => ({ background: getComputedStyle(node).backgroundColor,
            border: getComputedStyle(node).borderTopWidth, underline: getComputedStyle(node).textDecorationLine,
            height: node.getBoundingClientRect().height }));
        assert.deepEqual(style, { background: 'rgba(0, 0, 0, 0)', border: '0px', underline: 'none', height: 44 });
        await screenshot(page, `${engine}-390-beta-feedback`);
        await link.click();
        await page.waitForURL(url => url.pathname === '/contribute/feedback');
        const entry = await page.evaluate(token => JSON.parse(localStorage.getItem('benchpoll:contribution-entry:' + token)), href.hash.slice('#entry='.length));
        assert.equal(entry.path, '/contribute/feedback');
        assert.deepEqual(entry.values, { details: betaFeedbackTemplate(), pageURL: fixture.url + '/' });
    });

    test(`${engine}: first guest sign-in refreshes in place and preserves the private topic draft`, async t => {
        const fixture = await startTopicsPreview({ built: false, authenticated: false });
        const { page } = await pageFor(t, engine, fixture, 390);
        await homeReady(page);
        await page.evaluate(() => {
            globalThis.__topicDraftDocument = 'original';
            document.getElementById('new-private-topic').click();
        });
        await page.locator('#new-topic-name').fill('Guest draft to retain');
        await page.locator('#new-topic-description').fill('Retain the existing private-topic draft through sign-in.');
        fixture.state.authenticated = true;
        await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'user-profile-update',
            newValue: JSON.stringify({ date: new Date().toISOString() }) })));
        await page.waitForFunction(() => document.getElementById('topics-account').textContent.includes('Alex Chen'));
        assert.equal(await page.evaluate(() => globalThis.__topicDraftDocument), 'original');
        assert.equal(await page.locator('#new-topic-name').inputValue(), 'Guest draft to retain');
        assert.equal(await page.locator('#new-topic-description').inputValue(), 'Retain the existing private-topic draft through sign-in.');
        await page.locator('#create-topic-submit').click();
        await page.locator('#create-topic-dialog').waitFor({ state: 'hidden' });
        assert.equal(fixture.state.created.length, 1);
        assert.equal(fixture.state.requests.find(request => request.path === '/api/create_topic').body.expectedUserID, '42');
    });

    test(`${engine}: sign-in after an actual bound-account sign-out reloads the document before rebinding`, async t => {
        const fixture = await startTopicsPreview({ built: false });
        const { page } = await pageFor(t, engine, fixture, 390);
        await homeReady(page);
        await page.waitForFunction(() => document.getElementById('topics-account').textContent.includes('Alex Chen'));
        await page.evaluate(() => { globalThis.__oldAccountDocument = true; });
        fixture.state.authenticated = false;
        await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'user-profile-update', newValue: null })));
        await page.waitForFunction(() => document.getElementById('topics-account').textContent.includes('Sign in'));
        fixture.state.authenticated = true;
        const reloaded = page.waitForEvent('domcontentloaded');
        await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'user-profile-update',
            newValue: JSON.stringify({ date: new Date().toISOString() }) })));
        await reloaded;
        await homeReady(page);
        await page.waitForFunction(() => document.getElementById('topics-account').textContent.includes('Alex Chen'));
        assert.equal(await page.evaluate(() => globalThis.__oldAccountDocument), undefined);
    });
}
