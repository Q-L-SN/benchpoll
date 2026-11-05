import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { startTopicsPreview } from '../scripts/frontend/topics-home-fixtures.mjs';

const liveOrigin = process.env.HOME_HEADER_LIVE_ORIGIN;
const output = 'D:/Codex-artifacts/website1/topics-home-header-fade-20261101' + (liveOrigin ? '/live' : '');
const browsers = new Map();
let app;
before(async () => {
    await mkdir(output, { recursive: true });
    const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    const proxy = liveOrigin && (process.env.HTTPS_PROXY || process.env.HTTP_PROXY);
    for (const launcher of [chromium, webkit]) browsers.set(launcher.name(), await launcher.launch({ headless: true, env,
        ...(proxy ? { proxy: { server: proxy } } : {}) }));
    app = liveOrigin ? { url: liveOrigin, close: async () => {} } : await startTopicsPreview({ built: false });
});
after(async () => {
    for (const browser of browsers.values()) await browser.close();
    await app?.close();
});

async function open(t, engine, width, reducedMotion = 'no-preference') {
    const context = await browsers.get(engine).newContext({ viewport: { width, height: 900 },
        isMobile: width <= 390, hasTouch: width <= 390, reducedMotion, serviceWorkers: 'block' });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(liveOrigin ? 45000 : 10000);
    page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
    await page.goto(app.url, { waitUntil: 'domcontentloaded' });
    // Header motion must also work while ranking previews are still loading or unavailable.
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--th-header-height'));
    await page.evaluate(() => document.fonts.ready);
    return page;
}

async function transition(page, visible, fraction = .5) {
    return page.evaluate(({ visible, fraction }) => {
        const header = document.querySelector('.th-header'), filters = document.getElementById('topics-filters');
        const hero = document.getElementById('home-hero'), placeholder = document.querySelector('.th-header-placeholder');
        const top = () => document.getElementById('topics').getBoundingClientRect().top + scrollY;
        const before = top();
        const threshold = hero.getBoundingClientRect().bottom + scrollY - Math.max(placeholder.offsetHeight, header.offsetHeight) - 160;
        scrollTo(0, threshold + (visible ? 30 : -30));
        dispatchEvent(new Event('scroll'));
        const motions = [header, filters].flatMap(node => node.getAnimations());
        const initialOpacity = Number(getComputedStyle(header).opacity);
        for (const motion of motions) {
            motion.pause();
            motion.currentTime = motion.effect.getTiming().duration * fraction;
        }
        return { count: motions.length, initialOpacity, opacity: Number(getComputedStyle(header).opacity),
            filterOpacity: Number(getComputedStyle(filters).opacity), hidden: filters.hidden,
            inert: [header.inert, filters.inert], position: getComputedStyle(header).position,
            pointerEvents: [getComputedStyle(header).pointerEvents, getComputedStyle(filters).pointerEvents],
            shift: top() - before, overflow: document.documentElement.scrollWidth - innerWidth };
    }, { visible, fraction });
}

async function settle(page) {
    await page.evaluate(async () => {
        const motions = [document.querySelector('.th-header'), document.getElementById('topics-filters')].flatMap(node => node.getAnimations());
        motions.forEach(motion => motion.play());
        await Promise.all(motions.map(motion => motion.finished.catch(() => {})));
    });
}

for (const engine of ['chromium', 'webkit']) for (const width of [320, 390, 1440]) {
    test(`${engine} ${width}px home header and island fade both ways without layout shifts`, async t => {
        const page = await open(t, engine, width);
        assert.equal(await page.locator('.th-header').evaluate(node => getComputedStyle(node).position), 'relative');
        assert.equal(await page.locator('#topics-filters').isVisible(), false);
        const incoming = await transition(page, true);
        assert.equal(incoming.count, 2);
        assert.equal(incoming.initialOpacity, 0);
        assert.ok(incoming.opacity > .3 && incoming.opacity < .7, JSON.stringify(incoming));
        assert.ok(Math.abs(incoming.filterOpacity - incoming.opacity) < .01);
        assert.deepEqual(incoming.inert, [false, false]);
        assert.equal(incoming.position, 'fixed');
        assert.equal(incoming.shift, 0);
        assert.ok(incoming.overflow <= 1);
        await page.screenshot({ path: join(output, `${engine}-${width}-fade-in.png`) });
        await settle(page);
        assert.equal(await page.locator('.th-header').evaluate(node => Number(getComputedStyle(node).opacity)), 1);
        await page.locator('#topics-view-toggle').focus();
        const outgoing = await transition(page, false);
        assert.equal(outgoing.count, 2);
        assert.ok(outgoing.opacity > .3 && outgoing.opacity < .7, JSON.stringify(outgoing));
        assert.ok(Math.abs(outgoing.filterOpacity - outgoing.opacity) < .01);
        assert.equal(outgoing.hidden, false, 'Do not remove the island before its fade ends');
        assert.equal(outgoing.position, 'fixed', 'Do not move the header during its fade');
        assert.deepEqual(outgoing.inert, [true, true]);
        assert.deepEqual(outgoing.pointerEvents, ['none', 'none']);
        assert.equal(outgoing.shift, 0);
        await page.screenshot({ path: join(output, `${engine}-${width}-fade-out.png`) });
        await settle(page);
        assert.equal(await page.locator('#topics-filters').isVisible(), false);
        assert.equal(await page.locator('.th-header').evaluate(node => getComputedStyle(node).position), 'relative');
        assert.equal(await page.locator('.th-brand').evaluate(node => document.activeElement === node), true);
        await page.evaluate(() => scrollTo(0, 0));
        assert.equal(await page.locator('.th-header').evaluate(node => getComputedStyle(node).opacity), '1');
    });

    test(`${engine} ${width}px rapid threshold reversals continue from the current opacity`, async t => {
        const page = await open(t, engine, width);
        await transition(page, true);
        await settle(page);
        const outgoing = await transition(page, false, .4);
        const returning = await transition(page, true, .3);
        assert.ok(Math.abs(returning.initialOpacity - outgoing.opacity) < .01, JSON.stringify({ outgoing, returning }));
        assert.ok(returning.opacity > outgoing.opacity && returning.opacity < 1);
        await settle(page);
        const incoming = await transition(page, false, .3);
        const interrupted = await transition(page, true, .2);
        const finalHide = await transition(page, false, .4);
        assert.ok(Math.abs(interrupted.initialOpacity - incoming.opacity) < .01);
        assert.ok(Math.abs(finalHide.initialOpacity - interrupted.opacity) < .01);
        await settle(page);
        assert.equal(await page.locator('#topics-filters').isVisible(), false);
        assert.equal(await page.locator('.th-header').evaluate(node => node.inert), false);
        assert.equal(await page.evaluate(() => document.body.classList.contains('is-scrolled')), false);
    });

    test(`${engine} ${width}px reduced motion stays immediate and returning to hero closes search`, async t => {
        const page = await open(t, engine, width, 'reduce');
        const incoming = await transition(page, true);
        assert.equal(incoming.count, 0);
        assert.equal(incoming.opacity, 1);
        await page.getByRole('tab', { name: 'Search topics' }).click();
        assert.equal(await page.getByRole('searchbox', { name: 'Search topics' }).isVisible(), true);
        const outgoing = await transition(page, false);
        assert.equal(outgoing.count, 0);
        assert.equal(outgoing.hidden, true);
        assert.equal(outgoing.position, 'relative');
        assert.equal(await page.getByRole('searchbox', { name: 'Search topics' }).isVisible(), false);
        assert.equal(await page.locator('.th-brand').evaluate(node => document.activeElement === node), true);
        await transition(page, true);
        assert.equal(await page.getByRole('searchbox', { name: 'Search topics' }).isVisible(), false);
    });
}
