import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startTopicsPreview } from '../scripts/frontend/topics-home-fixtures.mjs';
import { startPreview } from '../scripts/frontend/server.mjs';

const output = resolve(process.env.BP_HOME_DISCUSSION_OUTPUT ?? '/workspace/benchpoll-work/screenshots');
await mkdir(output, { recursive: true });
const engines = process.env.BP_BROWSER_ENGINE === 'chromium' ? [chromium] : [chromium, webkit];
const launchOptions = engine => ({ headless: true,
    ...(engine.name() === 'chromium' && process.env.BP_CHROMIUM_EXECUTABLE ? { executablePath: process.env.BP_CHROMIUM_EXECUTABLE } : {}) });

async function settle(page) {
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
        const motions = [document.body, document.querySelector('.th-header'), document.querySelector('#topics-filters')]
            .filter(Boolean).flatMap(node => node.getAnimations());
        await Promise.all(motions.map(motion => motion.finished.catch(() => {})));
    });
}

for (const engine of engines) for (const width of [320, 390, 1440]) {
    test(`${engine.name()} ${width}px homepage cards, collapsed island and scenes`, async t => {
        const fixture = await startTopicsPreview({ built: false });
        const coding = fixture.state.topics.find(topic => topic.ID === 1);
        const intelligence = fixture.state.topics.find(topic => topic.publicID === 1);
        Object.assign(coding, { configured: true, coverageIndex: 89.99, favoriteCount: 100, isFavorited: false,
            scenes: [{ ID: 101, sceneNumber: 1, name: 'General', isDefault: true, url: '/2/1' },
                { ID: 102, sceneNumber: 2, name: 'Python', isDefault: false, url: '/2/2' }] });
        fixture.state.topics = [coding, intelligence, ...fixture.state.topics.filter(topic => ![coding, intelligence].includes(topic))];
        const browser = await engine.launch(launchOptions(engine));
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'no-preference' });
        page.setDefaultTimeout(15000);
        const errors = [], failed = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('response', response => { if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`); });
        t.after(async () => { await browser.close(); await fixture.close(); assert.deepEqual(errors, []); assert.deepEqual(failed, []); });
        await page.goto(fixture.url);
        await page.locator('#topic-card-1[data-preview-state="loaded"] .th-model').first().waitFor();
        await page.waitForFunction(() => document.querySelector('#topics-account')?.getAttribute('href') === '/me');
        await settle(page);
        const initial = await page.evaluate(() => {
            const card = document.querySelector('#topic-card-1'), title = card.querySelector('.th-card-title'), summary = card.querySelector('.th-topic-summary');
            const visual = card.querySelector('.th-visual').getBoundingClientRect();
            return { order: [...document.querySelectorAll('#topics-grid > .th-card:not([hidden])')].map(node => Number(node.dataset.topicId)),
                body: getComputedStyle(document.body).backgroundColor, overflow: document.documentElement.scrollWidth - innerWidth,
                subtitle: Number.parseFloat(getComputedStyle(document.querySelector('.th-intro-copy')).fontSize),
                title: Number.parseFloat(getComputedStyle(document.querySelector('#home-title')).fontSize),
                summaryBelow: summary.getBoundingClientRect().top >= title.getBoundingClientRect().bottom,
                landscape: visual.width > visual.height, islandWidth: document.querySelector('#topics-filters').style.getPropertyValue('--th-filter-width'),
                phraseLines: document.querySelector('.th-headline-nowrap').getClientRects().length,
                chartHeight: card.querySelector('.th-model-plot').clientHeight,
                cardHeight: card.getBoundingClientRect().height,
                labelSize: parseFloat(getComputedStyle(card.querySelector('.th-model-name')).fontSize),
                markSize: card.querySelector('.th-vendor-mark').clientWidth,
                modelCount: [...card.querySelectorAll('.th-model')].filter(node => Number(getComputedStyle(node).opacity) > .99).length,
                createInHeader: document.querySelector('.th-header-links').contains(document.querySelector('#new-private-topic')) };
        });
        assert.deepEqual(initial.order.slice(0, 2), [1, 54], 'The service order survives the Intelligence feature treatment');
        assert.equal(initial.body, 'rgb(255, 255, 255)'); assert.ok(initial.overflow <= 1);
        assert.equal(initial.summaryBelow, true); assert.equal(initial.createInHeader, true);
        assert.ok(initial.labelSize < 11 && initial.markSize < 26, 'All screen sizes use smaller identities');
        assert.ok(initial.modelCount >= (width === 390 ? 9 : 7), `Denser chart at ${width}px: ${JSON.stringify(initial)}`);
        if (width < 640) assert.ok(initial.cardHeight <= 344 && initial.chartHeight >= 130, 'Compact cards give their saved name space to the chart');
        if (width < 640) { assert.ok(initial.subtitle <= 14); assert.ok(initial.title >= 30); assert.equal(initial.landscape, true); assert.equal(initial.phraseLines, 1); }
        assert.equal(await page.locator('#topic-card-1 .bp-topic-official').innerText(), 'Official');
        assert.equal(await page.locator('#topics-grid .bp-topic-report').count(), 0);
        assert.equal(await page.locator('#topic-card-1 .th-topic-coverage').innerText(), '89');
        assert.equal(await page.locator('#topic-card-1 .bp-topic-configured-dot').isVisible(), true);
        assert.match(await page.locator('#topic-card-1 .th-model').first().getAttribute('aria-label'), /87% benchmark coverage/);
        assert.equal(await page.locator('#topic-card-54').evaluate(node => node.classList.contains('is-featured')), true);
        await page.screenshot({ path: resolve(output, `homepage-${engine.name()}-${width}.png`) });

        const fade = await page.evaluate(() => {
            scrollTo(0, 420); dispatchEvent(new Event('scroll'));
            const header = document.querySelector('.th-header'), island = document.querySelector('#topics-filters');
            const motions = [header, island, document.body].flatMap(node => node.getAnimations())
                .filter(motion => motion.effect.getTiming().duration === 220);
            for (const motion of motions) { motion.pause(); motion.currentTime = 110; }
            const result = { count: motions.length, header: Number(getComputedStyle(header).opacity), island: Number(getComputedStyle(island).opacity),
                body: getComputedStyle(document.body).backgroundColor, width: island.offsetWidth, inert: document.querySelector('#topics-filter-controls').inert };
            for (const motion of motions) motion.play();
            return result;
        });
        assert.equal(fade.count, 3); assert.ok(fade.header > .3 && fade.header < .7); assert.ok(Math.abs(fade.header - fade.island) < .01);
        assert.notEqual(fade.body, 'rgb(255, 255, 255)'); assert.notEqual(fade.body, 'rgb(246, 247, 249)');
        assert.equal(fade.width, 50); assert.equal(fade.inert, true);
        await settle(page);
        await page.locator('#topics-filters-toggle').click(); await settle(page);
        const expanded = await page.locator('#topics-filters').evaluate(node => ({ width: node.offsetWidth, height: node.offsetHeight,
            x: node.getBoundingClientRect().left, controls: [...document.querySelector('#topics-filter-controls').children]
                .map(child => ({ top: child.getBoundingClientRect().top, bottom: child.getBoundingClientRect().bottom })),
            top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom,
            overflow: document.documentElement.scrollWidth - innerWidth }));
        assert.ok(expanded.width > 50 && expanded.width <= width - 32); assert.equal(expanded.height, 50); assert.ok(expanded.overflow <= 1);
        assert.ok(expanded.controls.every(control => control.top >= expanded.top && control.bottom <= expanded.bottom));
        if (width === 320) {
            assert.equal(await page.locator('#topics-filter-controls').evaluate(node => node.classList.contains('has-overflow-end')), true);
            await page.locator('#topics-filter-controls').evaluate(node => { node.scrollLeft = node.scrollWidth; node.dispatchEvent(new Event('scroll')); });
            assert.equal(await page.locator('#topics-filter-controls').evaluate(node => node.classList.contains('has-overflow-start')), true);
        }
        await page.locator('#topics-filters-toggle').click(); await settle(page);
        assert.equal(await page.locator('#topics-filters').evaluate(node => node.offsetWidth), 50);
        await page.locator('#topics-filters-toggle').click(); await settle(page);
        assert.equal(await page.locator('#topics-filters').evaluate(node => node.getBoundingClientRect().left), expanded.x);

        await page.locator('#topic-search-toggle').click(); await page.locator('#topic-search').fill('Intelligence');
        assert.equal(await page.locator('.th-card.is-featured').count(), 0, 'Search uses an ordinary Intelligence card');
        await page.locator('#topic-search-toggle').click();
        assert.equal(await page.locator('#topic-card-54').evaluate(node => node.classList.contains('is-featured')), true);
        const feedback = await page.locator('#topic-card-1 .bp-topic-favorite').evaluate(button => {
            const pulse = () => button.getAnimations().find(animation => animation.effect.getKeyframes().some(frame => frame.transform));
            button.click(); const first = pulse(); button.click();
            return { restarted: Boolean(first) && first !== pulse(), busy: button.getAttribute('aria-busy') };
        });
        assert.equal(feedback.restarted, true); assert.equal(feedback.busy, 'true');
        await page.waitForFunction(() => document.querySelector('#topic-card-1 .bp-topic-favorite').getAttribute('aria-busy') === 'false');
        assert.equal(await page.locator('#topic-card-1 .bp-topic-favorite').getAttribute('aria-pressed'), 'true');
        assert.equal(fixture.state.requests.filter(request => request.path === '/api/set_topic_favorite').length, 1, 'Repeated feedback must not duplicate an in-flight write');
        assert.equal(await page.locator('#topic-card-1 .bp-topic-favorite-count').innerText(), '101');
        await page.locator('#topic-card-1 .bp-topic-favorite').click();
        await page.waitForFunction(() => document.querySelector('#topic-card-1 .bp-topic-favorite').getAttribute('aria-busy') === 'false');
        assert.equal(await page.locator('#topic-card-1 .bp-topic-favorite-count').innerText(), '100');

        await page.locator('#topic-card-1 .th-scene-toggle').click();
        await page.locator('#topic-scenes-dialog[open]').waitFor();
        assert.equal(await page.locator('#topic-card-1-scene-102 .th-topic-link').getAttribute('href'), '/2/2');
        if (width < 640) {
            const bounds = await page.locator('#topic-scenes-dialog').boundingBox();
            assert.deepEqual(bounds, { x: 0, y: 0, width, height: 900 });
            await page.screenshot({ path: resolve(output, `scenes-${engine.name()}-${width}.png`) });
        }
        await page.locator('#topic-scenes-close').click();
        await page.evaluate(() => { scrollTo(0, 420); dispatchEvent(new Event('scroll')); }); await settle(page);
        if (!await page.locator('#new-private-topic').isVisible()) await page.locator('#topics-more summary').click();
        await page.locator('#new-private-topic').click();
        await page.locator('#new-topic-name').fill('My compact topic'); await page.locator('#new-topic-description').fill('A focused collection for my tests.');
        await page.locator('#create-topic-submit').click();
        await page.locator('#create-topic-dialog').waitFor({ state: 'hidden' });
        assert.equal(fixture.state.created.length, 1); assert.match(fixture.state.created[0].url, /^\/private\/[A-Za-z0-9]{12,64}$/);
        await page.evaluate(() => { scrollTo(0, 0); dispatchEvent(new Event('scroll')); }); await settle(page);
        assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(255, 255, 255)');
    });
}

for (const engine of engines) for (const reducedMotion of ['no-preference', 'reduce']) {
    test(`${engine.name()} homepage background reversals stay aligned with the header (${reducedMotion})`, async t => {
        const fixture = await startTopicsPreview({ built: false });
        const browser = await engine.launch(launchOptions(engine));
        const page = await browser.newPage({ viewport: { width: 390, height: 900 }, reducedMotion });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        t.after(async () => { await browser.close(); await fixture.close(); assert.deepEqual(errors, []); });
        await page.goto(fixture.url); await page.locator('.th-card[data-preview-state="loaded"]').first().waitFor(); await settle(page);
        const transition = (visible, fraction) => page.evaluate(({ visible, fraction }) => {
            scrollTo(0, visible ? 420 : 0); dispatchEvent(new Event('scroll'));
            const header = document.querySelector('.th-header'), filters = document.querySelector('#topics-filters');
            const motions = [header, filters, document.body].flatMap(node => node.getAnimations())
                .filter(motion => motion.effect.getTiming().duration === 220);
            for (const motion of motions) { motion.pause(); motion.currentTime = 220 * fraction; }
            return { body: getComputedStyle(document.body).backgroundColor, opacity: getComputedStyle(header).opacity,
                filterOpacity: getComputedStyle(filters).opacity, motions: motions.length, hidden: filters.hidden };
        }, { visible, fraction });
        if (reducedMotion === 'reduce') {
            const incoming = await transition(true, .5);
            assert.equal(incoming.motions, 0); assert.equal(incoming.hidden, false); assert.equal(incoming.body, 'rgb(246, 247, 249)');
            const outgoing = await transition(false, .5);
            assert.equal(outgoing.motions, 0); assert.equal(outgoing.hidden, true); assert.equal(outgoing.body, 'rgb(255, 255, 255)');
            return;
        }
        const incoming = await transition(true, .6), reversed = await transition(false, 0);
        assert.equal(incoming.body, reversed.body); assert.equal(incoming.opacity, reversed.opacity);
        assert.equal(reversed.opacity, reversed.filterOpacity);
        const outgoing = await transition(false, .4), reversedAgain = await transition(true, 0);
        assert.equal(outgoing.body, reversedAgain.body); assert.equal(outgoing.opacity, reversedAgain.opacity);
        await page.evaluate(() => [document.body, document.querySelector('.th-header'), document.querySelector('#topics-filters')]
            .flatMap(node => node.getAnimations()).forEach(motion => motion.finish()));
        await settle(page);
        assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(246, 247, 249)');
        const final = await transition(false, 1); assert.equal(final.body, 'rgb(255, 255, 255)');
        await page.evaluate(() => [document.body, document.querySelector('.th-header'), document.querySelector('#topics-filters')]
            .flatMap(node => node.getAnimations()).forEach(motion => motion.finish()));
        await settle(page);
        assert.equal(await page.locator('#topics-filters').isVisible(), false);
    });
}

if (!process.env.BP_HOME_ONLY) for (const engine of engines) for (const width of [390, 1440]) {
    test(`${engine.name()} ${width}px discussion composer stays above the feed with drafts intact`, async t => {
        const fixture = await startPreview({ communityVersions: true });
        const browser = await engine.launch(launchOptions(engine));
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
        page.setDefaultTimeout(15000);
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        t.after(async () => { await browser.close(); await fixture.close(); assert.deepEqual(errors, []); });
        await page.goto(fixture.url);
        await page.locator('#benchmark-rows .bp-benchmark-row').first().waitFor();
        if (width < 760) await page.locator('[data-mobile-panel="discussion"]').click();
        else await page.locator('#discussion-entry').click();
        await page.locator('#discussion-text').waitFor({ state: 'visible' });
        await page.locator('#discussion-feed .discussion-post').first().waitFor();
        const geometry = await page.evaluate(() => {
            const composer = document.querySelector('#discussion-composer').getBoundingClientRect();
            const filters = document.querySelector('.discussion-filterbar').getBoundingClientRect();
            const feed = document.querySelector('#discussion-feed').getBoundingClientRect();
            return { afterScenes: composer.top >= filters.bottom, beforeFeed: composer.bottom <= feed.top,
                titleVisible: document.querySelector('#discussion-title').offsetHeight > 0,
                expanded: !document.querySelector('#discussion-compose-fields').hidden, subtitle: Boolean(document.querySelector('#category-path')) };
        });
        assert.equal(geometry.afterScenes, true); assert.equal(geometry.beforeFeed, true); assert.equal(geometry.expanded, true);
        assert.equal(geometry.subtitle, false); assert.equal(geometry.titleVisible, width >= 760);
        await page.locator('#discussion-text').fill('Keep my reasoning while I change the order.');
        await page.locator('#discussion-sort-toggle').click();
        await page.waitForFunction(() => document.querySelector('#discussion-feed').getAttribute('aria-busy') === 'false');
        assert.equal(await page.locator('#discussion-sort-toggle').getAttribute('aria-label'), 'Show hot discussions');
        assert.equal(fixture.state.requests.filter(request => request.path === '/api/get_discussion').at(-1).body.sort, 'new');
        assert.equal(await page.locator('#discussion-text').inputValue(), 'Keep my reasoning while I change the order.');
        await page.locator('#discussion-sort-toggle').click();
        assert.equal(await page.locator('#discussion-sort-toggle').getAttribute('aria-label'), 'Show newest discussions');
        await page.screenshot({ path: resolve(output, `discussion-${engine.name()}-${width}.png`) });
    });
}

for (const engine of engines) test(`${engine.name()}: Intelligence feature uses the catalogue identity when its public number differs`, async t => {
    const fixture = await startTopicsPreview({ built: process.env.BP_TEST_BUILT === '1' });
    t.after(() => fixture.close());
    Object.assign(fixture.state.topics.find(topic => topic.ID === 54), { publicID: 88, url: '/88' });
    Object.assign(fixture.state.topics.find(topic => topic.ID === 1), { publicID: 1, url: '/1' });
    const browser = await engine.launch(launchOptions(engine)); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    await page.goto(fixture.url);
    await page.locator('#topics-grid .th-card.is-featured').waitFor();
    assert.equal(await page.locator('#topics-grid .th-card.is-featured').getAttribute('data-topic-id'), '54');
    assert.equal(await page.locator('#topic-card-54 .th-card-title a').getAttribute('href'), '/88');
});
