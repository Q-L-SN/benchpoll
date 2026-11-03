import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, webkit, devices } from 'playwright';
import { startConfigSidebarPreview } from './helpers/config-sidebar-fixture-20261022.mjs';
import { startPreview } from '../scripts/frontend/server.mjs';

const output = resolve('artifacts/workspace-ui-20261101/mobile-controls');
const browsers = new Map();
before(async () => {
    await mkdir(join(output, 'tmp'), { recursive: true });
    const env = { ...process.env, TEMP: join(output, 'tmp'), TMP: join(output, 'tmp'), TMPDIR: join(output, 'tmp'),
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    for (const engine of [chromium, webkit]) browsers.set(engine.name(), await engine.launch({ headless: true, env }));
});
after(async () => { for (const browser of browsers.values()) await browser.close(); });

async function open(t, engine, width = 393, complete = false) {
    const fixture = await (complete ? startPreview() : startConfigSidebarPreview());
    const mobile = width <= 760;
    const context = await browsers.get(engine).newContext({ ...(mobile ? devices['iPhone 16'] : {}),
        viewport: { width, height: 852 }, isMobile: mobile, hasTouch: true, reducedMotion: 'reduce' });
    await context.addInitScript(() => localStorage.setItem('benchpoll:config-sidebar-collapsed', 'true'));
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await context.close(); await fixture.close(); assert.deepEqual(errors, []); });
    await page.goto(fixture.url + (complete ? '/' : '/intelligence'));
    await page.waitForSelector('#weight-pie [data-object-id]');
    await page.waitForSelector('#workspace-update-indicator', { state: 'attached' });
    assert.equal(await page.locator('#workspace-update-indicator').count(), 1);
    assert.equal(await page.locator('.bp-context-row #last-updated').count(), 0);
    await page.evaluate(() => document.fonts.ready);
    return { page, fixture };
}

async function settled(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function touchTap(page, selector) {
    const target = page.locator(selector);
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

async function gesture(page, selector = '#swipe-surface', { x = 80, points = [[25, 0], [65, 2], [110, 2]],
    duration = 200, cancel = false, multiple = false, scroll = false } = {}) {
    return page.locator(selector).evaluate((node, options) => {
        const y = node.getBoundingClientRect().top + 15;
        let prevented = false;
        const point = (dx, dy) => ({ identifier: 7, clientX: options.x + dx, clientY: y + dy });
        const send = (type, touches, changedTouches, time) => {
            const event = new Event(type, { bubbles: true, composed: true, cancelable: true });
            Object.defineProperties(event, { touches: { value: touches }, changedTouches: { value: changedTouches },
                timeStamp: { value: time } });
            const allowed = node.dispatchEvent(event);
            prevented ||= !allowed;
        };
        const start = point(0, 0);
        send('touchstart', [start], [start], 1000);
        if (options.multiple) send('touchstart', [start, { ...start, identifier: 8 }], [], 1010);
        if (options.scroll) document.dispatchEvent(new Event('scroll'));
        options.points.forEach(([dx, dy], index) => {
            const next = point(dx, dy);
            send('touchmove', [next], [next], 1000 + options.duration * (index + 1) / options.points.length);
        });
        send(options.cancel ? 'touchcancel' : 'touchend', [], [point(...options.points.at(-1))], 1000 + options.duration);
        return { prevented, open: document.body.classList.contains('taxonomy-open') };
    }, { x, points, duration, cancel, multiple, scroll });
}

async function installSurface(page, content = '') {
    await page.evaluate(content => {
        document.getElementById('swipe-surface')?.remove();
        const surface = document.createElement('section');
        surface.id = 'swipe-surface';
        surface.style.cssText = 'position:fixed;left:32px;top:400px;width:calc(100% - 64px);height:70px;background:white;z-index:20';
        surface.innerHTML = content;
        document.querySelector('.bp-workspace').append(surface);
    }, content);
    await settled(page);
}

for (const engine of ['chromium', 'webkit']) {
    for (const width of [320, 393, 760]) test(`${engine} ${width}: topic and actions share one row; summary and header stay sticky`, async t => {
        const { page } = await open(t, engine, width);
        const empty = await page.evaluate(() => {
            const title = document.querySelector('.bp-breadcrumb-current').getBoundingClientRect();
            const action = document.getElementById('workspace-refresh').getBoundingClientRect();
            return { title: title.y + title.height / 2, action: action.y + action.height / 2 };
        });
        assert.ok(Math.abs(empty.title - empty.action) < 1, JSON.stringify(empty));
        await page.evaluate(() => {
            const summary = document.getElementById('workspace-topic-summary');
            summary.hidden = false;
            summary.textContent = 'Independent benchmarks for a broad range of research and development tasks.';
            const creator = document.getElementById('workspace-topic-creator');
            creator.hidden = false;
            creator.innerHTML = '<span class="bp-topic-byline"><span class="bp-topic-byline-prefix">By</span><span class="bp-topic-byline-name">Preview account</span></span>';
        });
        for (const name of ['Intelligence', 'A very long topic name for research and evaluation', 'UnbrokenTopicName'.repeat(6)]) {
            for (const redo of [false, true]) {
                await page.evaluate(({ name, redo }) => {
                    document.querySelector('.bp-breadcrumb-current').textContent = name;
                    document.getElementById('workspace-redo').hidden = !redo;
                }, { name, redo });
                await settled(page);
                const geometry = await page.evaluate(() => {
                    const rect = selector => {
                        const r = document.querySelector(selector).getBoundingClientRect();
                        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height, cy: r.y + r.height / 2 };
                    };
                    const title = document.querySelector('.bp-breadcrumb-current');
                    return { title: rect('.bp-breadcrumb-current'), indicator: rect('#workspace-update-indicator'),
                        discussion: rect('#discussion-entry'), refresh: rect('#workspace-refresh'), undo: rect('#workspace-undo'),
                        redo: document.getElementById('workspace-redo').hidden ? null : rect('#workspace-redo'),
                        summary: rect('#workspace-topic-summary'), creator: rect('#workspace-topic-creator'), row: rect('.bp-context-row'),
                        identity: rect('.bp-context-identity'), header: rect('#config-sidebar'), count: rect('#discussion-entry [data-discussion-count]'),
                        style: { wrap: getComputedStyle(title).whiteSpace, mask: getComputedStyle(title).maskImage },
                        creatorParent: document.getElementById('workspace-topic-creator').parentElement.className,
                        width: innerWidth, documentWidth: document.documentElement.scrollWidth, scrollX };
                });
                const report = JSON.stringify(geometry);
                assert.equal(geometry.style.wrap, 'nowrap', report);
                assert.match(geometry.style.mask, /linear-gradient/, report);
                assert.ok(geometry.title.height <= 44.5, report);
                assert.equal(geometry.indicator.width, 18, report);
                for (const item of [geometry.indicator, geometry.discussion, geometry.refresh, geometry.undo, geometry.redo].filter(Boolean)) {
                    assert.ok(Math.abs(item.cy - geometry.title.cy) < 1, report);
                }
                assert.ok(geometry.title.right <= geometry.indicator.x + 1, report);
                assert.ok(geometry.indicator.right <= geometry.discussion.x + 1, report);
                assert.ok(Math.abs((geometry.redo ?? geometry.undo).right - geometry.row.right) < 1, report);
                assert.ok(geometry.count.width <= 1 && geometry.count.height <= 1, report);
                assert.ok(geometry.summary.y >= geometry.title.bottom && Math.abs(geometry.summary.width - geometry.row.width) < 1, report);
                assert.ok(geometry.creator.y >= geometry.summary.bottom, report);
                assert.match(geometry.creatorParent, /bp-context-identity/);
                assert.ok(Math.abs(geometry.identity.height - geometry.row.height) < 1, report);
                assert.ok(geometry.header.x === 0 && geometry.header.width === width && geometry.header.y === 0, report);
                assert.ok(geometry.documentWidth <= geometry.width + 1 && geometry.scrollX === 0, report);
            }
        }
        const originalTop = (await page.locator('.bp-context-row').boundingBox()).y;
        await page.locator('#model-index-tab').click();
        await page.locator('.bp-right-workspace').evaluate(node => { node.scrollTop = 400; });
        await settled(page);
        const sticky = await page.evaluate(() => {
            const row = document.querySelector('.bp-context-row').getBoundingClientRect();
            const tabs = document.querySelector('.bp-mobile-panels').getBoundingClientRect();
            return { row: row.y, bottom: row.bottom, tabs: tabs.y, height: row.height,
                observed: parseFloat(document.querySelector('.bp-workspace').style.getPropertyValue('--bp-mobile-topic-height')),
                backdrop: getComputedStyle(document.getElementById('config-sidebar')).backdropFilter };
        });
        assert.equal(sticky.row, originalTop, JSON.stringify(sticky));
        assert.ok(sticky.tabs >= sticky.bottom - 1, JSON.stringify(sticky));
        assert.ok(Math.abs(sticky.observed - sticky.height) < 1, JSON.stringify(sticky));
        assert.match(sticky.backdrop, /blur/, JSON.stringify(sticky));
        await page.screenshot({ path: join(output, `${engine}-${width}-sticky.png`) });
    });

    test(`${engine}: continuous drag settles the drawer without changing desktop preference`, async t => {
        const { page } = await open(t, engine);
        await installSurface(page);
        assert.deepEqual(await gesture(page), { prevented: true, open: true });
        assert.equal(await page.locator('#taxonomy-toggle').getAttribute('aria-expanded'), 'true');
        assert.equal(await page.locator('[data-taxonomy-trigger]').getAttribute('aria-expanded'), 'true');
        assert.equal(await page.evaluate(() => localStorage.getItem('benchpoll:config-sidebar-collapsed')), 'true');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.body.classList.contains('taxonomy-open'));
        for (const options of [{ x: 12 }, { x: 380 }, { points: [[5, 25], [110, 25]] },
            { points: [[-20, 0], [110, 0]] }, { points: [[40, 110]] }, { multiple: true }, { scroll: true }]) {
            assert.deepEqual(await gesture(page, '#swipe-surface', options), { prevented: false, open: false }, JSON.stringify(options));
        }
        for (const options of [{ points: [[25, 0]] }, { duration: 800 }, { cancel: true }]) {
            assert.deepEqual(await gesture(page, '#swipe-surface', options), { prevented: true, open: false }, JSON.stringify(options));
        }
        assert.deepEqual(await gesture(page, '#swipe-surface', { points: [[50, 0], [110, 0], [230, 0]], duration: 1200 }),
            { prevented: true, open: true }, 'slow drags can still open the drawer by distance');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.body.classList.contains('taxonomy-open'));
        await page.setViewportSize({ width: 1200, height: 852 });
        await settled(page);
        assert.deepEqual(await gesture(page), { prevented: false, open: false });
        const toggle = page.locator('#config-sidebar-toggle');
        assert.equal(await toggle.locator('.fa-table-columns').count(), 1);
        assert.equal(await toggle.locator('.bp-sidebar-toggle-direction.bp-ui-disclosure-chevron.fa-chevron-right').count(), 1);
        await toggle.click();
        assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
        assert.equal(await toggle.locator('.bp-ui-disclosure-chevron').evaluate(node => getComputedStyle(node).transform), 'matrix(0, 1, -1, 0, 0, 0)');
        assert.match(await page.locator('#workspace-topic-creator').evaluate(node => node.parentElement.className), /bp-context-actions/);
        assert.ok(await page.locator('#discussion-entry [data-discussion-count]').evaluate(node => node.getBoundingClientRect().width > 1));
        await page.locator('#swipe-surface').evaluate(node => node.remove());
        await page.screenshot({ path: join(output, `${engine}-desktop-sidebar.png`) });
    });

    test(`${engine}: scene/model/parameter scrolling, forms, nested actions and dialogs never become sidebar swipes`, async t => {
        const { page } = await open(t, engine);
        for (const content of [
            '<div class="bp-scene-tabs"><span id="gesture-target">Scenes</span></div>',
            '<div class="bp-model-parameters"><span id="gesture-target">Parameters</span></div>',
            '<div class="bp-model-name"><span id="gesture-target">Model name</span></div>',
            '<div style="overflow-x:auto;width:180px"><div style="width:700px"><span id="gesture-target">Scrollable content</span></div></div>',
            '<form><span id="gesture-target">Form label</span><input></form>',
            '<button><span id="gesture-target">Real button</span></button>',
            '<a href="#destination"><span id="gesture-target">Real link</span></a>',
            '<div contenteditable="true"><span id="gesture-target">Editor</span></div>',
            '<div class="bp-pie-stage"><span id="gesture-target">Weight chart</span></div>',
            '<div data-sidebar-swipe="ignore"><span id="gesture-target">Custom gesture</span></div>',
            '<div role="dialog" aria-modal="true"><span id="gesture-target">Dialog</span></div>'
        ]) {
            await installSurface(page, content);
            assert.deepEqual(await gesture(page, '#gesture-target'), { prevented: false, open: false }, content);
        }
        await installSurface(page, '<input id="focused-field">');
        await page.locator('#focused-field').focus();
        assert.deepEqual(await gesture(page), { prevented: false, open: false });
        await page.locator('#focused-field').evaluate(node => node.blur());
        await page.evaluate(() => document.body.classList.add('discussion-open'));
        assert.deepEqual(await gesture(page), { prevented: false, open: false });
        await page.evaluate(() => document.body.classList.remove('discussion-open'));
        await page.evaluate(() => { document.getElementById('logout-dialog').hidden = false; });
        assert.deepEqual(await gesture(page), { prevented: false, open: false });
        await page.evaluate(() => { document.getElementById('logout-dialog').hidden = true; });
        await installSurface(page);
        assert.deepEqual(await gesture(page), { prevented: true, open: true });
    });

    test(`${engine}: real mobile refresh, discussion, undo and redo execute on the first tap`, async t => {
        const { page, fixture } = await open(t, engine, 393, true);
        let response = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace'));
        await page.locator('#workspace-refresh').tap();
        assert.equal((await response).status(), 200);
        await page.waitForFunction(() => !document.getElementById('workspace-refresh').disabled);
        await page.locator('#discussion-entry').tap();
        await page.waitForSelector('body.discussion-open');
        assert.equal(await page.locator('#bp-help-popover').isVisible(), false);
        await page.locator('#discussion-close').tap();
        await page.waitForFunction(() => !document.body.classList.contains('discussion-open'));
        await page.locator('#pie-mode-personal').tap();
        const before = structuredClone(fixture.state.personalEntries);
        response = page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie'));
        await page.getByRole('button', { name: 'Remove General knowledge from Personal Weights', exact: true }).tap();
        assert.equal((await response).status(), 200);
        assert.equal(fixture.state.personalEntries.length, before.length - 1);
        await page.waitForFunction(() => !document.getElementById('workspace-undo').disabled);
        response = page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie'));
        await page.locator('#workspace-undo').tap();
        assert.equal((await response).status(), 200);
        assert.deepEqual(fixture.state.personalEntries.map(item => item.weightBasisPoints), before.map(item => item.weightBasisPoints));
        response = page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie'));
        await page.locator('#workspace-redo').tap();
        assert.equal((await response).status(), 200);
        assert.equal(fixture.state.personalEntries.length, before.length - 1);
        assert.equal(await page.locator('#workspace-update-indicator').count(), 1);
        assert.equal(await page.locator('#bp-help-popover').isVisible(), false);
    });

    test(`${engine}: explanatory help and disabled reasons open on tap; nested and follow actions still execute`, async t => {
        const { page } = await open(t, engine);
        await page.evaluate(() => {
            const section = document.createElement('section');
            section.id = 'touch-fixture';
            section.style.cssText = 'display:grid;gap:14px;position:relative';
            section.innerHTML = `
                <button id="tap-help" type="button" data-help-text="This explains how missing scores are handled." aria-expanded="false">About missing scores</button>
                <button id="disabled-help" type="button" disabled data-tooltip="This benchmark cannot be added because it has no approved scores.">Unavailable</button>
                <span id="passive-help" tabindex="0" data-tooltip="Coverage uses the weight of recorded scores.">Coverage</span>
                <button id="real-action" type="button" data-tooltip="Your existing scores will remain available.">Continue</button>
                <button id="follow-action" type="button" data-help-action="follow" data-help-text="Choose an evaluation item next.">Choose item</button>
                <form id="nested-form"><div data-help-text="This describes the group, not the button."><button id="nested-submit" type="submit">Submit</button></div></form>
                <a id="nested-link" href="#native-destination"><span data-help-text="A description inside a real link.">Follow native link</span></a>`;
            document.querySelector('.bp-workspace').prepend(section);
            window.touchActions = { real: 0, follow: 0, submit: 0 };
            document.getElementById('real-action').addEventListener('click', () => window.touchActions.real++);
            document.getElementById('follow-action').addEventListener('click', () => window.touchActions.follow++);
            document.getElementById('nested-form').addEventListener('submit', event => { event.preventDefault(); window.touchActions.submit++; });
        });
        const panel = page.locator('#bp-help-popover');
        for (const selector of ['#tap-help', '#disabled-help', '#passive-help']) {
            await touchTap(page, selector);
            await panel.waitFor({ state: 'visible' });
            assert.equal(await panel.textContent(), await page.locator(selector).evaluate(node => node.dataset.helpText ?? node.dataset.tooltip));
            await touchTap(page, selector);
            await panel.waitFor({ state: 'hidden' });
        }
        for (const selector of ['#real-action', '#follow-action', '#nested-submit', '#nested-link']) {
            await touchTap(page, selector);
            assert.equal(await panel.isVisible(), false, selector);
        }
        assert.deepEqual(await page.evaluate(() => window.touchActions), { real: 1, follow: 1, submit: 1 });
        assert.equal(new URL(page.url()).hash, '#native-destination');
        const help = page.locator('#tap-help');
        await help.scrollIntoViewIfNeeded();
        const bounds = await help.boundingBox();
        const pointer = { pointerType: 'touch', pointerId: 3, isPrimary: true, clientX: bounds.x + 10, clientY: bounds.y + 10 };
        for (const type of ['pointerdown', 'pointerup']) await help.dispatchEvent(type, pointer);
        await panel.waitFor({ state: 'visible' });
        assert.equal(await help.getAttribute('aria-expanded'), 'true');
        await page.keyboard.press('Escape');
        await panel.waitFor({ state: 'hidden' });
        assert.equal(await help.getAttribute('aria-expanded'), 'false');
        await help.dispatchEvent('pointerdown', pointer);
        await help.dispatchEvent('pointermove', { ...pointer, clientX: pointer.clientX + 30 });
        await help.dispatchEvent('pointerup', { ...pointer, clientX: pointer.clientX + 30 });
        assert.equal(await panel.isVisible(), false, 'dragging explanatory content is not a tap');
        await touchTap(page, '#tap-help');
        await page.screenshot({ path: join(output, `${engine}-touch-help.png`) });
    });
}

test('chromium real touch gestures open the sidebar but leave horizontal scroll and edge starts native', async t => {
    const { page } = await open(t, 'chromium');
    const client = await page.context().newCDPSession(page);
    const drag = async (x, dx) => {
        const send = (type, offset = 0) => client.send('Input.dispatchTouchEvent', {
            type, touchPoints: type === 'touchEnd' ? [] : [{ x: x + offset, y: 430 }]
        });
        await send('touchStart');
        for (let step = 1; step <= 5; step++) { await send('touchMove', dx * step / 5); await page.waitForTimeout(20); }
        await send('touchEnd');
        await settled(page);
    };
    await installSurface(page);
    await drag(80, 220);
    assert.equal(await page.locator('body').evaluate(node => node.classList.contains('taxonomy-open')), true);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.body.classList.contains('taxonomy-open'));
    await page.evaluate(() => { document.getElementById('swipe-surface').style.left = '0'; });
    await drag(8, 120);
    assert.equal(await page.locator('body').evaluate(node => node.classList.contains('taxonomy-open')), false);
    await installSurface(page, '<div id="horizontal-scroll" style="width:100%;height:70px;overflow-x:auto"><div style="width:900px;height:60px">Scrollable scene/model/parameter content</div></div>');
    await page.locator('#horizontal-scroll').evaluate(node => { node.scrollLeft = 240; });
    await settled(page);
    await drag(100, 120);
    assert.equal(await page.locator('body').evaluate(node => node.classList.contains('taxonomy-open')), false);
    assert.ok(await page.locator('#horizontal-scroll').evaluate(node => node.scrollLeft < 210));
});
