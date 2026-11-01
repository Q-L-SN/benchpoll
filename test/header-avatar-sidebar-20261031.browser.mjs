import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { startTopicsPreview } from '../scripts/frontend/topics-home-fixtures.mjs';
import { startPreview } from '../scripts/frontend/server.mjs';
import { startConfigSidebarPreview } from './helpers/config-sidebar-fixture-20261022.mjs';

const output = resolve(process.env.HEADER_SIDEBAR_ARTIFACT_DIR ?? 'D:/Codex-artifacts/website1/header-sidebar-20261031');
const storageKey = 'benchpoll:config-sidebar-collapsed';
const browsers = new Map();
const longName = 'Account name long enough to require truncation';

before(async () => {
    const temp = join(output, 'tmp');
    await mkdir(temp, { recursive: true });
    const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    for (const engine of [chromium, webkit]) browsers.set(engine.name(), await engine.launch({ headless: true, env }));
});
after(async () => { for (const browser of browsers.values()) await browser.close(); });

async function openPage(t, engine, kind, width, { collapsed = true, reducedMotion = 'no-preference' } = {}) {
    const fixture = await (kind === 'home' ? startTopicsPreview({ built: false })
        : kind === 'standalone' ? startPreview() : startConfigSidebarPreview());
    const context = await browsers.get(engine).newContext({ viewport: { width, height: 900 },
        hasTouch: width <= 760, reducedMotion, serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    t.after(async () => { await context.close(); await fixture.close(); assert.deepEqual(errors, []); });
    // A deliberately non-square uploaded image exercises cover sizing without remote traffic.
    const avatar = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 80; canvas.height = 40;
        const paint = canvas.getContext('2d');
        paint.fillStyle = '#166575'; paint.fillRect(0, 0, 80, 40);
        paint.fillStyle = '#edc954'; paint.fillRect(30, 0, 20, 40);
        return canvas.toDataURL('image/png');
    });
    await page.route('**/api/get_user_profile', route => route.fulfill({ json: {
        userID: kind === 'home' ? '42' : '1', userName: longName, userProfilePictureURL: avatar,
        hasCustomDisplayName: true, hasCustomAvatar: true, role: 'reviewer'
    } }));
    if (kind === 'config') await context.addInitScript(({ key, collapsed }) => {
        if (localStorage.getItem(key) === null) localStorage.setItem(key, String(collapsed));
    }, { key: storageKey, collapsed });
    await page.goto(fixture.url + (kind === 'config' ? '/intelligence' : kind === 'standalone' ? '/dialogPage?dialogCode=1' : '/'));
    await page.waitForSelector(kind === 'home' ? '#topics-account .bp-identity-avatar img'
        : kind === 'standalone' ? 'global-header #site-account img' : '#header-user-profile:not([hidden])', { state: 'attached' });
    await page.evaluate(() => document.fonts.ready);
    if (kind === 'config') {
        await page.waitForFunction(() => document.body.dataset.configSidebarPhase === 'idle');
        await page.waitForTimeout(350);
    }
    return { page, context };
}

async function assertSquare(avatar, size) {
    const geometry = await avatar.evaluate(node => {
        const rect = element => {
            const { x, y, width, height } = element.getBoundingClientRect();
            return { x, y, width, height };
        };
        return { box: rect(node), parent: rect(node.parentElement), radius: getComputedStyle(node).borderRadius,
            image: node.querySelector('img') ? rect(node.querySelector('img')) : null };
    });
    assert.ok(Math.abs(geometry.box.width - size) < .5 && Math.abs(geometry.box.height - size) < .5, JSON.stringify(geometry));
    assert.equal(geometry.radius, '50%');
    const { box, parent, image } = geometry;
    assert.ok(box.x >= parent.x - .5 && box.y >= parent.y - .5
        && box.x + box.width <= parent.x + parent.width + .5
        && box.y + box.height <= parent.y + parent.height + .5, 'Avatar remains inside its control');
    if (image) assert.deepEqual(image, box, 'The image fills the avatar instead of overflowing its circular mask');
}

async function sidebarState(page) {
    return page.evaluate(() => ({
        phase: document.body.dataset.configSidebarPhase,
        collapsed: document.body.classList.contains('config-sidebar-collapsed'),
        header: document.body.classList.contains('config-brand-in-header'),
        parent: document.querySelector('.bp-shell .bp-brand').parentElement.id,
        brands: document.querySelectorAll('.bp-shell .bp-brand').length,
        opacity: Number(getComputedStyle(document.querySelector('.bp-shell .bp-brand')).opacity),
        inert: document.getElementById('config-sidebar').inert,
        hidden: document.getElementById('config-sidebar').getAttribute('aria-hidden'),
        expanded: document.getElementById('config-sidebar-toggle').getAttribute('aria-expanded'),
        disabled: document.getElementById('config-sidebar-toggle').disabled,
        active: document.activeElement.id,
        saved: localStorage.getItem('benchpoll:config-sidebar-collapsed')
    }));
}

async function assertSettled(page, collapsed, parent = collapsed ? 'workspace-brand-slot' : 'config-sidebar') {
    await page.waitForFunction(() => document.body.dataset.configSidebarPhase === 'idle');
    const state = await sidebarState(page);
    assert.equal(state.collapsed, collapsed, JSON.stringify(state));
    assert.equal(state.parent, parent, JSON.stringify(state));
    assert.equal(state.brands, 1);
    assert.equal(state.opacity, 1);
    const icons = await page.locator('#config-sidebar-toggle').evaluate(button => {
        const bounds = button.getBoundingClientRect();
        if (bounds.width < 1 || bounds.height < 1 || getComputedStyle(button).visibility === 'hidden') return [];
        return [...button.querySelectorAll('i')].map(icon => {
            const box = icon.getBoundingClientRect();
            return { left: box.left - bounds.left, right: bounds.right - box.right };
        });
    });
    assert.ok(icons.every(icon => icon.left >= 3 && icon.right >= 3), `Sidebar icons must not be clipped: ${JSON.stringify(icons)}`);
    return state;
}

async function sampleToggle(page, screenshot) {
    await page.evaluate(() => {
        const frames = [];
        window.headerSidebarFrames = frames;
        window.headerSidebarSampling = true;
        const toggle = document.getElementById('config-sidebar-toggle');
        toggle.focus(); toggle.click();
        const start = performance.now();
        function sample() {
            const brand = document.querySelector('.bp-shell .bp-brand');
            const sidebar = document.getElementById('config-sidebar');
            frames.push({ time: performance.now() - start, phase: document.body.dataset.configSidebarPhase,
                sidebar: parseFloat(getComputedStyle(document.querySelector('.bp-shell')).gridTemplateColumns),
                gap: document.getElementById('workspace-brand-slot').getBoundingClientRect().width,
                parent: brand.parentElement.id, opacity: Number(getComputedStyle(brand).opacity),
                moving: sidebar.getAnimations().some(animation => animation.transitionProperty === 'transform' && animation.playState === 'running'),
                headlineY: document.getElementById('workspace-headline').getBoundingClientRect().y,
                brands: document.querySelectorAll('.bp-shell .bp-brand').length,
                collapsed: document.body.classList.contains('config-sidebar-collapsed'),
                header: document.body.classList.contains('config-brand-in-header') });
            if (performance.now() - start < 400) requestAnimationFrame(sample);
            else window.headerSidebarSampling = false;
        }
        sample();
    });
    if (screenshot) {
        await page.waitForFunction(() => document.body.dataset.configSidebarPhase === 'brand-in', null, { polling: 'raf' });
        await page.screenshot({ path: join(output, screenshot) });
    }
    await page.waitForFunction(() => !window.headerSidebarSampling);
    return page.evaluate(() => window.headerSidebarFrames);
}

for (const engine of ['chromium', 'webkit']) {
    for (const width of [320, 390, 768, 1024, 1440]) test(`${engine} Home ${width}px avatars stay square with long account names`, async t => {
        const { page } = await openPage(t, engine, 'home', width);
        const compact = await page.locator('.bp-site-links').evaluate(node => node.classList.contains('is-compact'));
        if (compact) await page.locator('#topics-more summary').click();
        const avatar = page.locator('#topics-account .bp-identity-avatar');
        await avatar.locator('img').evaluate(image => image.decode());
        await assertSquare(avatar, compact ? 20 : 24);
        await page.screenshot({ path: join(output, `${engine}-home-${width}.png`) });
        await avatar.locator('img').evaluate(image => image.dispatchEvent(new Event('error')));
        assert.equal(await avatar.textContent(), 'A');
        await assertSquare(avatar, compact ? 20 : 24);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    });

    for (const width of [390, 1440]) test(`${engine} shared standalone header ${width}px direct image stays square`, async t => {
        const { page } = await openPage(t, engine, 'standalone', width);
        const header = page.locator('global-header');
        const compact = await header.locator('.bp-site-links').evaluate(node => node.classList.contains('is-compact'));
        if (compact) await header.locator('summary').click();
        const avatar = header.locator('#site-account img');
        await avatar.evaluate(image => image.decode());
        await assertSquare(avatar, compact ? 20 : 24);
    });

    for (const width of [768, 1024, 1440]) test(`${engine} configuration ${width}px avatar ignores generic icon padding`, async t => {
        const { page } = await openPage(t, engine, 'config', width);
        const avatar = page.locator('#header-user-profile [data-account-picture]');
        await assertSquare(avatar, 28);
        assert.equal(await avatar.evaluate(node => getComputedStyle(node).backgroundSize), 'cover');
        assert.equal(await page.locator('#header-user-profile').evaluate(node => getComputedStyle(node).padding), '0px');
        await page.screenshot({ path: join(output, `${engine}-config-${width}.png`) });
        await avatar.evaluate(node => { node.style.backgroundImage = ''; node.dataset.hasPicture = 'false'; });
        await assertSquare(avatar, 28);
        await page.locator('#header-user-profile').focus();
        assert.equal(await page.locator('#header-user-profile').evaluate(node => getComputedStyle(node).outlineStyle), 'solid');
    });

    for (const width of [768, 1024, 1440]) test(`${engine} ${width}px logo reveal overlaps sidebar collapse and gap creation`, async t => {
        const { page } = await openPage(t, engine, 'config', width, { collapsed: false });
        const frames = await sampleToggle(page, `${engine}-${width}-collapse-in-flight.png`);
        const first = frames[0];
        assert.equal(first.collapsed, true, 'Sidebar collapse class is set synchronously');
        assert.equal(first.header, true, 'Header gap class is set synchronously');
        const overlapping = frames.find(frame => frame.time < 100 && frame.sidebar > 0 && frame.sidebar < first.sidebar && frame.gap > 0);
        assert.ok(overlapping, `Sidebar and header gap must both move before the fade-out finishes: ${JSON.stringify(frames)}`);
        const reveal = frames.find(frame => frame.parent === 'workspace-brand-slot' && frame.opacity > .1 && frame.moving);
        assert.ok(reveal && reveal.time < 280 && reveal.sidebar > 0, `Logo must appear before the sidebar finishes: ${JSON.stringify(frames)}`);
        assert.ok(frames.every(frame => frame.brands === 1 && Math.abs(frame.headlineY - first.headlineY) < 1));
        let state = await assertSettled(page, true);
        assert.equal(state.inert, true); assert.equal(state.hidden, 'true'); assert.equal(state.expanded, 'false');
        assert.equal(state.disabled, false); assert.equal(state.saved, 'true');
        await page.reload();
        await page.waitForSelector('#header-user-profile:not([hidden])', { state: 'attached' });
        await assertSettled(page, true);
        await page.waitForTimeout(350);
        const expansion = await sampleToggle(page);
        assert.ok(expansion.some(frame => frame.parent === 'config-sidebar' && frame.opacity > .1 && frame.moving));
        assert.ok(expansion.every(frame => frame.brands === 1));
        state = await assertSettled(page, false);
        assert.equal(state.inert, false); assert.equal(state.hidden, 'false'); assert.equal(state.expanded, 'true');
        assert.equal(state.saved, 'false');
        await writeFile(join(output, `${engine}-${width}-timing.json`), JSON.stringify({ collapse: frames, expansion }, null, 2));
    });

    for (const collapsed of [false, true]) for (const delay of [35, 155]) {
        test(`${engine} discussion interrupts ${collapsed ? 'expansion' : 'collapse'} at ${delay}ms`, async t => {
            const { page } = await openPage(t, engine, 'config', 1280, { collapsed });
            await page.evaluate(delay => {
                document.getElementById('config-sidebar-toggle').click();
                setTimeout(() => document.getElementById('discussion-entry').click(), delay);
            }, delay);
            await page.waitForFunction(() => document.body.classList.contains('discussion-open'));
            await page.waitForTimeout(400);
            const state = await assertSettled(page, !collapsed, 'discussion-brand-slot');
            assert.equal(state.inert, true); assert.equal(state.disabled, true); assert.equal(state.header, false);
            assert.equal(state.active, 'discussion-close', 'Sidebar completion cannot steal panel focus');
            await page.locator('#discussion-close').click();
            await page.waitForTimeout(350);
            const closed = await assertSettled(page, !collapsed);
            assert.equal(closed.active, 'discussion-entry');
            assert.equal(closed.inert, !collapsed);
            assert.equal(closed.disabled, false);
        });
    }

    test(`${engine} reduced motion and storage interruptions settle immediately`, async t => {
        const { page } = await openPage(t, engine, 'config', 1280, { collapsed: false, reducedMotion: 'reduce' });
        await page.locator('#config-sidebar-toggle').click();
        await assertSettled(page, true);
        assert.equal(await page.locator('.bp-shell').evaluate(node => getComputedStyle(node).transitionDuration), '0s');
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.evaluate(() => document.getElementById('config-sidebar-toggle').click());
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await assertSettled(page, false);
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.evaluate(key => {
            document.getElementById('config-sidebar-toggle').click();
            localStorage.setItem(key, 'false');
            dispatchEvent(new StorageEvent('storage', { key, newValue: 'false' }));
        }, storageKey);
        await page.waitForTimeout(400);
        await assertSettled(page, false);
    });

    for (const width of [320, 390]) test(`${engine} resize to ${width}px cancels handoff and preserves mobile drawer/discussions`, async t => {
        const { page } = await openPage(t, engine, 'config', 1280, { collapsed: false });
        await page.evaluate(() => document.getElementById('config-sidebar-toggle').click());
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(400);
        let state = await assertSettled(page, true, 'config-sidebar');
        assert.equal(state.inert, false); assert.equal(state.header, false);
        assert.equal(await page.locator('#config-sidebar-toggle').isVisible(), false);
        await page.locator('#taxonomy-toggle').click();
        await page.waitForFunction(() => document.body.classList.contains('taxonomy-open'));
        await assertSettled(page, true, 'config-sidebar');
        assert.equal(await page.locator('#user-profile').isVisible(), true);
        await page.evaluate(() => document.getElementById('discussion-entry').click());
        await page.waitForFunction(() => document.body.classList.contains('discussion-open'));
        await assertSettled(page, true, 'discussion-brand-slot');
        assert.equal(await page.locator('.bp-workspace').evaluate(node => node.inert), true);
        await page.locator('#discussion-close').click();
        await page.waitForTimeout(400);
        await assertSettled(page, true, 'config-sidebar');
        await page.screenshot({ path: join(output, `${engine}-config-mobile-${width}.png`) });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.waitForTimeout(400);
        state = await assertSettled(page, true);
        assert.equal(state.inert, true); assert.equal(state.saved, 'true');
    });
}
