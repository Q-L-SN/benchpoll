import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, webkit, devices } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
import { startTopicsPreview } from '../scripts/frontend/topics-home-fixtures.mjs';

const output = resolve(process.env.BP_MOBILE_POLISH_OUTPUT ?? '/workspace/benchpoll-work/mobile-workspace-20261031');
const browsers = new Map();
before(async () => {
    await mkdir(join(output, 'tmp'), { recursive: true });
    const env = { ...process.env, TEMP: join(output, 'tmp'), TMP: join(output, 'tmp'), TMPDIR: join(output, 'tmp'),
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    for (const engine of [chromium, webkit]) browsers.set(engine.name(), await engine.launch({ headless: true, env }));
});
after(async () => { for (const browser of browsers.values()) await browser.close(); });
async function open(t, engine, { home = false, width = 1440, mobile = false, collapsed = true } = {}) {
    const fixture = await (home ? startTopicsPreview({ built: false }) : startPreview());
    const context = await browsers.get(engine).newContext({ ...(mobile ? devices['iPhone 16'] : {}),
        viewport: { width, height: mobile ? 852 : 900 }, isMobile: mobile, hasTouch: mobile,
        deviceScaleFactor: mobile ? 3 : 1, reducedMotion: 'no-preference' });
    await context.addInitScript(collapsed => localStorage.setItem('benchpoll:config-sidebar-collapsed', String(collapsed)), collapsed);
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await context.close(); await fixture.close(); assert.deepEqual(errors, []); });
    await page.goto(fixture.url + (home ? '/' : '/1'));
    await page.waitForSelector(home ? '.th-model' : '#weight-pie [data-object-id]');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    return page;
}

async function assertMobileGeometry(page) {
    const geometry = await page.evaluate(() => {
        const rect = selector => { const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect(); return { x, y, width, height }; };
        const work = document.querySelector('.bp-workspace'), style = getComputedStyle(work);
        return { header: rect('#config-sidebar'), brand: rect('#config-sidebar .bp-brand'), workspace: rect('.bp-workspace'),
            viewport: { width: innerWidth, scrollX, documentWidth: document.documentElement.scrollWidth, scale: visualViewport.scale },
            padding: { left: style.paddingLeft, right: style.paddingRight }, classes: document.body.className };
    });
    const { header, brand, workspace, viewport, padding } = geometry;
    assert.equal(viewport.scrollX, 0, JSON.stringify(geometry));
    assert.ok(viewport.documentWidth <= viewport.width + 1, JSON.stringify(geometry));
    assert.ok(Math.abs(header.y) < 1 && header.height >= 60, JSON.stringify(geometry));
    assert.ok(brand.y >= header.y && brand.y + brand.height <= header.y + header.height, JSON.stringify(geometry));
    assert.ok(Math.abs(workspace.x * 2 + workspace.width - viewport.width) < 1, JSON.stringify(geometry));
    assert.equal(padding.left, padding.right);
    return geometry;
}

for (const engine of ['chromium', 'webkit']) {
    for (const width of [320, 393, 760]) test(`${engine} device viewport ${width}: cold load, scroll, reload and drawer stay centered`, async t => {
        const page = await open(t, engine, { width, mobile: true });
        const states = [await assertMobileGeometry(page)];
        await page.locator('#model-index-tab').click();
        await page.evaluate(() => scrollTo(0, 350));
        await page.waitForTimeout(350);
        states.push(await assertMobileGeometry(page));
        await page.reload();
        await page.waitForSelector('#weight-pie [data-object-id]');
        await page.locator('#model-index-tab').click();
        await page.evaluate(() => scrollTo(0, 350));
        await page.waitForTimeout(350);
        states.push(await assertMobileGeometry(page));
        await page.locator('#taxonomy-toggle').click();
        await page.waitForTimeout(350);
        await page.locator('#taxonomy-close').click();
        await page.waitForTimeout(400);
        states.push(await assertMobileGeometry(page));
        await page.setViewportSize({ width: 820, height: 852 });
        await page.waitForTimeout(350);
        await page.setViewportSize({ width, height: 852 });
        await page.waitForTimeout(400);
        states.push(await assertMobileGeometry(page));
        await page.screenshot({ path: join(output, `${engine}-${width}-scrolled.png`) });
        await writeFile(join(output, `${engine}-${width}-geometry.json`), JSON.stringify(states, null, 2));
    });

    for (const home of [false, true]) test(`${engine} ${home ? 'home' : 'configuration'} account control opens the profile page`, async t => {
        const page = await open(t, engine, { home });
        const account = page.locator(home ? '#topics-account' : '#header-user-profile');
        if (home) assert.equal(await account.getAttribute('href'), '/me');
        await page.route('**/me', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Profile route fixture</title>' }));
        await account.click();
        await page.waitForURL('**/me');
        assert.equal(await page.title(), 'Profile route fixture');
    });

    for (const collapsed of [false, true]) test(`${engine} discussion reclaims sidebar toggle space while sliding`, async t => {
        const page = await open(t, engine, { collapsed });
        const frames = await page.evaluate(() => new Promise(resolve => {
            const frames = [], start = performance.now();
            const measure = () => {
                const toggle = document.getElementById('config-sidebar-toggle');
                const headline = document.querySelector('.bp-heading-copy').getBoundingClientRect();
                const workspace = document.querySelector('.bp-workspace').getBoundingClientRect();
                frames.push({ time: performance.now() - start, width: toggle.getBoundingClientRect().width,
                    margin: parseFloat(getComputedStyle(toggle).marginRight),
                    headlineOffset: headline.x - workspace.x });
            };
            measure();
            document.getElementById('discussion-entry').click();
            const sample = () => { measure(); if (performance.now() - start < 380) requestAnimationFrame(sample); else resolve(frames); };
            requestAnimationFrame(sample);
        }));
        assert.ok(frames.some(frame => frame.time < 120 && frame.width < frames[0].width && frame.width > 0), JSON.stringify(frames));
        const last = frames.at(-1);
        assert.ok(last.width < 1 && last.margin < 1, JSON.stringify(frames));
        assert.ok(Math.abs(last.headlineOffset - 20) < 1, JSON.stringify(frames));
        assert.ok(frames.some(frame => frame.time < 140 && frame.headlineOffset < frames[0].headlineOffset - 2));
        await page.locator('#discussion-close').click();
        await page.waitForTimeout(400);
        assert.ok(await page.locator('#config-sidebar-toggle').isVisible());
        await writeFile(join(output, `${engine}-discussion-${collapsed}.json`), JSON.stringify(frames, null, 2));
    });

    for (const width of [393, 1920]) test(`${engine} home ${width}: compact grid and weight-only controls`, async t => {
        const page = await open(t, engine, { home: true, width, mobile: width < 760 });
        const layout = await page.locator('#topics-grid').evaluate(node => {
            const r = node.getBoundingClientRect();
            return { x: r.x, width: r.width, columns: getComputedStyle(node).gridTemplateColumns.split(' ').length };
        });
        assert.ok(layout.width <= 1200.5);
        assert.ok(Math.abs(layout.x * 2 + layout.width - width) < 1);
        assert.equal(layout.columns, width < 760 ? 1 : 3);
        await page.evaluate(() => scrollTo(0, document.getElementById('topics').offsetTop + 300));
        await page.waitForSelector('#topics-filters:not([hidden])');
        await page.locator('#topics-score-toggle').click();
        assert.equal(await page.locator('#topics-score-toggle').getAttribute('aria-pressed'), 'true');
        await page.locator('#topics-view-toggle').click();
        assert.equal(await page.locator('#topics-score-toggle').isVisible(), false);
        assert.equal(await page.locator('#topics-score-toggle').getAttribute('aria-pressed'), 'true');
        await page.screenshot({ path: join(output, `${engine}-${width}-home-weights.png`) });
        await page.locator('#topics-view-toggle').click();
        assert.equal(await page.locator('#topics-score-toggle').isVisible(), true);
        assert.equal(await page.locator('#topics-score-toggle').getAttribute('aria-pressed'), 'true');
        await page.screenshot({ path: join(output, `${engine}-${width}-home-models.png`) });
    });
}
