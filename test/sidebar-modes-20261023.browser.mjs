import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { startConfigSidebarPreview } from './helpers/config-sidebar-fixture-20261022.mjs';

const temporaryDirectory = 'D:/Codex-artifacts/website1/showcase-composition-20261021/tmp';
await mkdir(temporaryDirectory, { recursive: true });
process.env.TEMP = temporaryDirectory;
process.env.TMP = temporaryDirectory;
const preview = await startConfigSidebarPreview();
const output = pathToFileURL(resolve(process.env.SIDEBAR_MODES_ARTIFACT_DIR
    ?? 'D:/Codex-artifacts/website1/topics-polish-20261023/sidebar/modes') + sep);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
const ready = async page => {
    await page.waitForSelector('#benchmark-rows .bp-benchmark-row', { state: 'attached' });
    await page.waitForFunction(() => document.getElementById('benchmark-card').getAttribute('aria-busy') === 'false');
};
const openSidebar = async page => {
    if (page.viewportSize().width <= 760 && !await page.locator('body').evaluate(node => node.classList.contains('taxonomy-open'))) {
        await page.locator('#taxonomy-toggle').click();
        await page.waitForSelector('body.taxonomy-open');
    } else if (page.viewportSize().width > 760 && await page.locator('body').evaluate(node => node.classList.contains('config-sidebar-collapsed'))) {
        await page.locator('#config-sidebar-toggle').click();
        await page.waitForFunction(() => !document.body.classList.contains('config-sidebar-collapsed')
            && document.body.dataset.configSidebarPhase === 'idle');
    }
};
const mode = async (page, name) => {
    await openSidebar(page);
    await page.locator(`[data-navigation-view="${name}"]`).click();
    assert.equal(await page.locator('.bp-navigation-views [aria-pressed="true"]').count(), 1);
    assert.equal(await page.locator(`[data-navigation-view="${name}"]`).getAttribute('aria-pressed'), 'true');
};
const mineReady = page => page.waitForFunction(() => !document.getElementById('configured-empty').textContent.includes('Loading'));
const screenshot = (page, name) => page.screenshot({ path: fileURLToPath(new URL(name + '.png', output)), fullPage: true });

async function guestFormCleanup(context, width) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(preview.url + '/intelligence'); await ready(page); await mode(page, 'configured');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const writesBefore = preview.state.requests.filter(request => request.path === '/api/create_topic').length;
    await page.evaluate(() => {
        const form = document.getElementById('topic-create-form');
        const animate = form.animate;
        window.__topicFormAnimations = [];
        form.animate = function (...args) {
            const animation = animate.apply(this, args);
            animation.pause();
            window.__topicFormAnimations.push({ animation, finished: animation.finished });
            return animation;
        };
        document.querySelector('[data-create-topic="private"]').click();
        document.getElementById('topic-create-name').value = 'Private unsent draft';
    });
    preview.setAccount(null);
    await page.evaluate(async () => {
        const { navigationChannel } = await import('/js/shared/navigation-channel.js');
        let snapshot;
        const stop = navigationChannel.subscribe(value => { snapshot = value; });
        stop();
        await navigationChannel.publish({ ...snapshot, userID: null, authenticated: false, hasPersonalWeights: false });
    });
    await page.waitForSelector('#configured-login:not([hidden])');
    const animation = await page.evaluate(async () => {
        const held = window.__topicFormAnimations;
        const active = held.filter(item => item.animation.playState !== 'idle');
        for (const item of active) {
            item.animation.finish(); await item.finished;
            item.animation.finish(); await item.finished;
        }
        await new Promise(resolve => requestAnimationFrame(resolve));
        const form = document.getElementById('topic-create-form');
        return { captured: held.length, cancelled: held.filter(item => item.animation.playState === 'idle').length,
            hidden: form.hidden, inert: form.inert, ariaHidden: form.getAttribute('aria-hidden'),
            draft: document.getElementById('topic-create-name').value,
            buttonsClosed: [...document.querySelectorAll('[data-create-topic]')].every(button => button.getAttribute('aria-expanded') === 'false') };
    });
    assert.ok(animation.captured >= 2 && animation.cancelled >= 1, JSON.stringify(animation));
    assert.deepEqual({ hidden: animation.hidden, inert: animation.inert, ariaHidden: animation.ariaHidden,
        draft: animation.draft, buttonsClosed: animation.buttonsClosed },
    { hidden: true, inert: true, ariaHidden: 'true', draft: '', buttonsClosed: true });
    assert.equal(await page.locator('#configured-content [data-private="true"]').count(), 0);
    assert.equal(await page.locator('#topic-visibility-notice').isVisible(), true);
    assert.equal(preview.state.requests.filter(request => request.path === '/api/create_topic').length, writesBefore);
    assert.deepEqual(errors, []);
    await screenshot(page, width + '-guest-cleanup');
    await page.close();
    return animation;
}

try {
    for (const width of [320, 390, 1280]) {
        preview.setAccount('1');
        Object.assign(preview.state, { navigationEmpty: false, navigationFailure: 0, catalogueFailure: 0,
            mineEmpty: false, creationFailure: null });
        const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 761,
            isMobile: width < 761, reducedMotion: 'reduce' });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => {
            window.__sidebarLegalEvents = 0;
            window.addEventListener('benchpoll:legal-acceptance-required', event => {
                window.__sidebarLegalEvents++; event.stopImmediatePropagation();
            }, true);
        });
        await page.goto(preview.url + '/intelligence');
        await ready(page);
        await mode(page, 'popular');
        assert.deepEqual(await page.locator('#tree-content [data-category-id]').evaluateAll(nodes => nodes.map(node => Number(node.dataset.categoryId))),
            preview.topics.filter(topic => !topic.isPrivate).map(topic => topic.ID));
        const controls = await page.locator('.bp-navigation-views > button').evaluateAll(nodes => nodes.map(node => ({
            label: node.getAttribute('aria-label'), title: node.title, text: node.textContent.trim(), view: node.dataset.navigationView,
            width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height,
            icon: getComputedStyle(node.querySelector('i')).display,
            iconClass: node.querySelector('i').className,
            glyph: getComputedStyle(node.querySelector('i'), '::before').content,
            pressed: node.getAttribute('aria-pressed'),
            style: Object.fromEntries(['backgroundColor', 'color', 'borderWidth', 'borderRadius', 'boxShadow', 'padding', 'display']
                .map(property => [property, getComputedStyle(node)[property]])),
            fits: node.querySelector('i').getBoundingClientRect().left >= node.getBoundingClientRect().left
                && node.querySelector('i').getBoundingClientRect().right <= node.getBoundingClientRect().right
        })));
        assert.equal(controls.length, 4);
        assert.ok(controls.every(control => control.label && !control.title && !control.text && control.icon !== 'none'
            && control.glyph && !['none', 'normal', '""'].includes(control.glyph) && control.fits
            && control.width >= (width < 761 ? 40 : 32) && control.height >= (width < 761 ? 44 : 40)), JSON.stringify(controls));
        assert.ok(Math.max(...controls.map(control => control.width)) - Math.min(...controls.map(control => control.width)) < 1);
        assert.ok(controls.every(control => control.height === controls[0].height));
        const expected = [
            ['popular', 'Popular topics', 'fa-solid fa-fire'],
            ['recent', 'Recently viewed topics', 'fa-solid fa-clock'],
            ['configured', 'Mine', 'fa-solid fa-user'],
            ['search', 'Search topics', 'fa-solid fa-magnifying-glass']
        ];
        assert.deepEqual(controls.map(control => [control.view, control.label, control.iconClass]), expected);
        const inactive = controls.filter(control => control.pressed === 'false');
        assert.ok(inactive.every(control => JSON.stringify(control.style) === JSON.stringify(inactive[0].style)),
            'Search must share the other inactive mode buttons\' appearance');
        await page.locator('[data-navigation-view="popular"]').focus();
        await page.keyboard.press('Shift+Tab');
        for (const [view] of expected) {
            await page.keyboard.press('Tab');
            const focus = await page.evaluate(() => ({
                view: document.activeElement?.dataset.navigationView,
                visible: document.activeElement?.matches(':focus-visible'),
                outlineWidth: getComputedStyle(document.activeElement).outlineWidth,
                outlineStyle: getComputedStyle(document.activeElement).outlineStyle
            }));
            assert.equal(focus.view, view);
            assert.ok(focus.visible && parseFloat(focus.outlineWidth) >= 2 && focus.outlineStyle !== 'none', JSON.stringify(focus));
        }
        await mode(page, 'recent');
        assert.equal(await page.locator('#tree-content').isVisible(), true);
        await mode(page, 'popular');
        await screenshot(page, width + '-navigation');
        await mode(page, 'configured');
        await page.waitForSelector('#configured-content [data-location-category-id="167"]');
        await page.waitForSelector('#configured-content [data-location-category-id="998"]');
        assert.ok(await page.locator('#configured-content [data-location-category-id="998"]').count() > 0);
        assert.equal(await page.locator('#configured-content [data-location-category-id="170"]').count(), 0);
        assert.match(await page.locator('#configured-content [data-location-category-id="167"]').getAttribute('href'), /^\/research\?/);
        assert.equal(await page.locator('[data-create-topic]:not(#configured-panel *)').count(), 0);
        assert.equal(await page.locator('#private-category-create-toggle').count(), 0);
        assert.equal(await page.locator('#topic-visibility-notice').isVisible(), true);
        await screenshot(page, width + '-mine');

        await mode(page, 'configured');
        await page.waitForSelector('#configured-content [data-location-category-id="54"]');
        assert.equal(await page.locator('#configured-content [data-location-category-id="998"]').count(), 1);
        assert.equal(await page.locator('#configured-content [data-location-category-id="170"]').count(), 0);
        assert.equal(await page.locator('[data-create-topic]:visible').count(), 1);
        await mode(page, 'search');
        await page.waitForSelector('#configured-search-wrap:not([hidden])');
        await page.locator('#configured-search').fill('Research');
        await page.waitForFunction(() => document.querySelectorAll('#category-search-results a').length === 2);
        assert.equal(await page.locator('#category-search-results [data-category-id="190"]').getAttribute('href'), '/secondary-research');
        await screenshot(page, width + '-search');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('[data-navigation-view="configured"]').getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('#configured-search-wrap').isVisible(), false);

        await mode(page, 'configured');
        assert.equal(await page.locator('[data-create-topic="public"], a[href="/topic-proposals"]').count(), 0);
        await page.locator('[data-create-topic="private"]').click();
        await page.locator('#topic-create-description').fill('A private topic without a saved Pie.');
        for (const [status, error, name, message] of [
            [400, 'reserved_topic_name', 'Privacy', 'reserved'],
            [409, 'topic_name_exists', 'Research', 'already exists'],
            [409, 'legal_acceptance_required', 'Legal draft', 'updated terms'],
            [429, 'topic_creation_limit', 'Limited draft', 'daily'],
            [503, 'fixture_unavailable', 'Offline draft', 'draft is kept']
        ]) {
            preview.state.creationFailure = { status, error };
            await page.locator('#topic-create-name').fill(name);
            await page.locator('#topic-create-form [type="submit"]').click();
            await page.waitForFunction(text => document.getElementById('topic-create-error').textContent.includes(text), message);
            assert.equal(await page.locator('#topic-create-name').inputValue(), name);
            assert.equal(await page.locator('#topic-create-name').isEnabled(), true);
        }
        assert.ok(await page.evaluate(() => window.__sidebarLegalEvents) > 0);
        await screenshot(page, width + '-create-error');
        preview.state.creationFailure = null;
        const privateName = `Private laboratory ${width}`;
        await page.locator('#topic-create-name').fill(privateName);
        await page.locator('#topic-create-form [type="submit"]').click();
        await page.waitForURL('**/personal/*');
        await ready(page);
        const privateID = Number(new URL(page.url()).pathname.split('/').at(-1));
        await mode(page, 'configured');
        assert.equal(await page.locator(`#configured-content [data-location-category-id="${privateID}"]`).count(), 1);
        await mode(page, 'configured');
        await page.waitForSelector(`#configured-content [data-location-category-id="${privateID}"]`);
        await screenshot(page, width + '-created-private');

        preview.state.mineEmpty = true;
        preview.state.navigationEmpty = true;
        await mode(page, 'configured');
        await page.waitForFunction(() => document.getElementById('configured-empty').textContent.includes('No topics in Mine'));
        await screenshot(page, width + '-mine-empty');
        preview.state.mineEmpty = false;
        preview.state.catalogueFailure = 503;
        await mode(page, 'configured');
        await page.waitForFunction(() => document.getElementById('configured-empty').textContent.includes('Could not load'));
        preview.state.catalogueFailure = 0;
        await page.locator('#navigation-retry').click();
        await page.waitForSelector('#configured-content [data-location-category-id="998"]');

        preview.state.navigationEmpty = true;
        preview.state.mineEmpty = true;
        await page.reload(); await ready(page);
        await mode(page, 'configured');
        await page.waitForFunction(() => document.getElementById('configured-empty').textContent === 'No topics in Mine yet.');
        assert.equal(await page.locator('#configured-content a').count(), 0);
        await screenshot(page, width + '-configured-empty');
        preview.state.navigationFailure = 503;
        await page.reload(); await ready(page); await mode(page, 'configured');
        await page.waitForSelector('#navigation-retry:not([hidden])');
        assert.match(await page.locator('#configured-empty').innerText(), /Could not load/);
        preview.state.navigationFailure = 0;
        await page.locator('#navigation-retry').click();
        await page.waitForSelector('#navigation-retry', { state: 'hidden' });

        if (width === 1280) {
            await page.goto(preview.url + '/intelligence');
            await ready(page);
            await page.waitForSelector('#discussion-entry:not([hidden])');
            await page.locator('#config-sidebar-toggle').click();
            await page.waitForFunction(() => document.body.dataset.configSidebarPhase === 'idle');
            assert.equal(await page.locator('.bp-shell .bp-brand').count(), 1);
            await page.locator('#discussion-entry').click();
            await page.waitForSelector('body.discussion-open');
            assert.equal(await page.locator('.bp-shell .bp-brand').count(), 1);
            await page.locator('#discussion-close').click();
            await page.waitForFunction(() => !document.body.classList.contains('discussion-open'));
            assert.equal(await page.locator('body').evaluate(node => node.classList.contains('config-sidebar-collapsed')), true);
            await page.locator('#config-sidebar-toggle').click();
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        const creates = preview.state.requests.filter(request => request.path === '/api/create_topic' && request.body.name?.endsWith(String(width)));
        assert.ok(creates.some(request => request.body.isPrivate === true));
        assert.ok(creates.every(request => request.body.expectedUserID === '1' && request.body.isPrivate === true));
        assert.deepEqual(errors, []);
        await page.close();

        preview.setAccount('2');
        const other = await context.newPage();
        await other.goto(preview.url + '/intelligence'); await ready(other); await mode(other, 'configured');
        await mineReady(other);
        assert.equal(await other.locator('#configured-content [data-location-category-id="998"]').count(), 0);
        assert.ok(!(await other.locator('#configured-panel').innerText()).includes(privateName));
        await other.close();
        preview.setAccount('1');
        for (const [status, error, expected] of [[401, 'authentication_required', 'Sign in'], [409, 'account_changed', 'account changed']]) {
            const expired = await context.newPage();
            await expired.goto(preview.url + '/intelligence'); await ready(expired); await mode(expired, 'configured');
            await expired.locator('[data-create-topic="private"]').click();
            const draft = `Unsent ${status} ${width}`;
            await expired.locator('#topic-create-name').fill(draft);
            await expired.locator('#topic-create-description').fill('A private topic draft.');
            preview.state.creationFailure = { status, error };
            await expired.locator('#topic-create-form [type="submit"]').click();
            await expired.waitForFunction(text => document.getElementById('topic-create-error').textContent.includes(text), expected);
            assert.equal(await expired.locator('#topic-create-name').inputValue(), draft);
            const submitted = preview.state.requests.filter(request => request.path === '/api/create_topic' && request.body.name === draft).length;
            preview.state.creationFailure = null;
            await expired.locator('#topic-create-form [type="submit"]').click();
            await expired.waitForFunction(() => document.getElementById('topic-create-error').textContent.includes('account changed'));
            assert.equal(preview.state.requests.filter(request => request.path === '/api/create_topic' && request.body.name === draft).length, submitted);
            await expired.close();
        }
        const guestCleanup = await guestFormCleanup(context, width);
        preview.setAccount(null);
        const guest = await context.newPage();
        await guest.goto(preview.url + '/intelligence'); await ready(guest); await mode(guest, 'configured');
        assert.equal(await guest.locator('#configured-login').isVisible(), true);
        assert.equal(await guest.locator('#topic-create-form').isVisible(), false);
        await mode(guest, 'configured');
        assert.equal(await guest.locator('#configured-login').isVisible(), true);
        assert.equal(await guest.locator('#configured-empty').innerText(), 'Sign in to see your topics.');
        assert.equal(await guest.locator('#configured-content a').count(), 0);
        await screenshot(guest, width + '-guest');
        await guest.close(); await context.close();
        results.push({ width, modes: 4, controls, guestCleanup, passed: true });
    }
    await writeFile(new URL('results.json', output), JSON.stringify(results, null, 2));
    console.log('PASS: 320/390/1280, four icon modes, Mine with saved Pies and owned private topics, private-only creation, empty/auth/error states, canonical URLs, account separation and guest form cleanup.');
} finally {
    await browser.close(); await preview.close();
}
