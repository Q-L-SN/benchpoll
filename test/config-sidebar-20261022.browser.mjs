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
const preview = await startConfigSidebarPreview({ port: Number(process.env.CONFIG_SIDEBAR_PREVIEW_PORT ?? 0) });
if (process.argv.includes('--serve')) {
    console.log(`Configuration preview (synthetic data): ${preview.url}/topics/54/intelligence`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await preview.close(); process.exit(0); });
} else {
    const output = pathToFileURL(resolve(process.env.CONFIG_SIDEBAR_ARTIFACT_DIR
        ?? 'D:/Codex-artifacts/website1/topics-polish-20261023/sidebar/config') + sep);
    await mkdir(output, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const results = [];
    const waitIdle = page => page.waitForFunction(() => document.body.dataset.configSidebarPhase === 'idle'
        && !document.getElementById('config-sidebar-toggle').disabled);
    const ready = async page => {
        await page.waitForSelector('#benchmark-rows .bp-benchmark-row', { state: 'attached' });
        await page.waitForSelector('#model-rows .bp-model-row, #model-rows .bp-empty-state', { state: 'attached' });
        await page.waitForFunction(() => document.getElementById('benchmark-card').getAttribute('aria-busy') === 'false');
        const back = page.locator('#back-to-topics');
        assert.equal(await back.getAttribute('href'), '/');
        assert.equal(await back.isVisible(), page.viewportSize().width > 760);
        assert.equal(await back.getAttribute('data-ui-variant'), 'quiet');
        if (page.viewportSize().width > 760) {
            const box = await back.boundingBox();
            assert.ok(box.height >= 44 && box.x >= 0 && box.x + box.width <= page.viewportSize().width, JSON.stringify(box));
        }
    };
    const checkNavigationControls = async (page, minimumHeight) => {
        const controls = await page.locator('[data-navigation-view]').evaluateAll(nodes => nodes.map(node => ({
            label: node.getAttribute('aria-label'), width: node.clientWidth, scrollWidth: node.scrollWidth,
            height: node.getBoundingClientRect().height
        })));
        assert.equal(controls.length, 4);
        assert.ok(controls.every(control => control.label && control.height >= minimumHeight && control.scrollWidth <= control.width));
    };
    const metrics = page => page.evaluate(() => {
        const rect = selector => {
            const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
            return { x, y, width, height };
        };
        return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
            headline: rect('#workspace-headline'), workspace: rect('.bp-workspace'), sidebar: rect('#config-sidebar'),
            grid: rect('.bp-workspace-grid'), brandCount: document.querySelectorAll('.bp-shell .bp-brand').length,
            brandParent: document.querySelector('.bp-shell .bp-brand').parentElement.id,
            collapsed: document.body.classList.contains('config-sidebar-collapsed') };
    });
    const sampleToggle = page => page.evaluate(async () => {
        const samples = [];
        document.getElementById('config-sidebar-toggle').click();
        const started = performance.now();
        do {
            const brand = document.querySelector('.bp-shell .bp-brand');
            samples.push({ time: Math.round(performance.now() - started), phase: document.body.dataset.configSidebarPhase,
                headlineY: document.getElementById('workspace-headline').getBoundingClientRect().y,
                sidebarSpace: Number.parseFloat(getComputedStyle(document.querySelector('.bp-shell')).gridTemplateColumns),
                gap: document.getElementById('workspace-brand-slot').getBoundingClientRect().width,
                opacity: Number(getComputedStyle(brand).opacity), parent: brand.parentElement.id,
                brands: document.querySelectorAll('.bp-shell .bp-brand').length });
            await new Promise(resolve => requestAnimationFrame(resolve));
        } while (document.body.dataset.configSidebarPhase !== 'idle' && performance.now() - started < 2500);
        return samples;
    });
    async function panelCycle(page, width, label) {
        const before = await metrics(page);
        await page.locator('#discussion-entry').click();
        await page.waitForFunction(() => document.body.classList.contains('discussion-open'));
        await page.waitForFunction(() => document.querySelector('.bp-brand').parentElement.id === 'discussion-brand-slot');
        await page.waitForSelector('#discussion-feed .discussion-post');
        await page.waitForTimeout(380);
        assert.equal((await metrics(page)).brandCount, 1);
        const panel = await page.locator('#discussion-panel').boundingBox();
        assert.ok(panel.x >= -1 && panel.x + panel.width <= width + 1, `Discussion panel outside ${width}px viewport`);
        await page.screenshot({ path: fileURLToPath(new URL(`${width}-${label}-discussion.png`, output)), fullPage: true });
        await page.locator('#discussion-close').click();
        await page.waitForFunction(() => !document.body.classList.contains('discussion-open'));
        await page.waitForTimeout(380);
        const after = await metrics(page);
        assert.equal(after.collapsed, before.collapsed);
        assert.equal(after.brandParent, before.brandParent);
        assert.equal(after.brandCount, 1);
        assert.ok(Math.abs(after.headline.y - before.headline.y) < 1);
        const info = page.locator('[data-benchmark-control="information"], [data-family-control="information"]').first();
        await info.click();
        await page.waitForSelector('#benchmark-information-name:not(:empty)');
        assert.equal(await page.locator('#discussion-panel').getAttribute('aria-hidden'), 'false');
        await page.locator('#benchmark-scores-open').click();
        await page.waitForSelector('#benchmark-scores-view:not([hidden])');
        await page.locator('#discussion-close').click();
        await page.waitForTimeout(380);
        assert.equal((await metrics(page)).brandParent, before.brandParent);
    }
    try {
        for (const width of [1440, 1280, 1024, 390, 320]) {
            const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 761,
                hasTouch: width < 761, reducedMotion: 'no-preference' });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(() => {
                localStorage.setItem('benchpoll-workspace-display-v1', 'charts');
                if (innerWidth > 760 && localStorage.getItem('benchpoll:config-sidebar-collapsed') === null)
                    localStorage.setItem('benchpoll:config-sidebar-collapsed', 'false');
            });
            await page.goto(`${preview.url}/topics/54?view=showcase`);
            await ready(page);
            assert.equal(new URL(page.url()).pathname, '/intelligence');
            assert.equal(new URL(page.url()).searchParams.has('view'), false);
            assert.equal(await page.locator('#showcase, #showcase-trigger, #public-composition-toggle').count(), 0);
            assert.notEqual(await page.locator('.bp-workspace').getAttribute('data-display'), 'charts');
            assert.equal(await page.locator('#tree-content .tree-group, #tree-content .icon-folder').count(), 0);
            if (width <= 760) assert.equal(await page.locator('#config-sidebar-toggle').isVisible(), false);
            const clippedModeLabels = await page.locator('.bp-mode-option').evaluateAll(buttons => buttons
                .filter(button => button.offsetWidth && button.scrollWidth > button.clientWidth).length);
            assert.equal(clippedModeLabels, 0, `Weight mode label clipped at ${width}px`);
            const initial = await metrics(page);
            assert.ok(initial.scrollWidth <= width, `Document overflow at ${width}: ${initial.scrollWidth}`);
            assert.equal(initial.brandCount, 1);
            await page.screenshot({ path: fileURLToPath(new URL(`${width}-expanded.png`, output)), fullPage: true });
            if (width > 760) {
                await checkNavigationControls(page, 40);
                const selectedCard = await page.locator('#tree-content [aria-current="page"]').evaluate(node => {
                    const style = getComputedStyle(node);
                    return { shadow: style.boxShadow, background: style.backgroundColor };
                });
                assert.equal(selectedCard.shadow, 'none');
                assert.notEqual(selectedCard.background, 'rgb(255, 255, 255)');
                await panelCycle(page, width, 'expanded');
                const samples = await sampleToggle(page);
                await waitIdle(page);
                const collapsed = await metrics(page);
                assert.equal(collapsed.brandParent, 'workspace-brand-slot');
                const headingAlignment = await page.evaluate(() => {
                    const bounds = selector => document.querySelector(selector).getBoundingClientRect();
                    const center = rect => rect.top + rect.height / 2;
                    const brand = bounds('#workspace-brand-slot .bp-brand');
                    const headline = bounds('#workspace-headline');
                    const toggle = bounds('#config-sidebar-toggle');
                    const header = bounds('.bp-page-heading');
                    const context = bounds('.bp-context-row');
                    return { brand: center(brand), headline: center(headline), toggle: center(toggle),
                        gap: context.top - header.bottom };
                });
                assert.ok(Math.abs(headingAlignment.brand - headingAlignment.headline) < 2, JSON.stringify(headingAlignment));
                assert.ok(Math.abs(headingAlignment.toggle - headingAlignment.headline) < 2, JSON.stringify(headingAlignment));
                assert.ok(headingAlignment.gap <= 16, JSON.stringify(headingAlignment));
                assert.equal(await page.locator('#config-sidebar-toggle').getAttribute('aria-label'), 'Show topics sidebar');
                assert.equal(await page.locator('#config-sidebar-toggle .fa-table-columns').count(), 1);
                assert.ok(Math.abs(collapsed.workspace.width - initial.workspace.width) < 1);
                assert.ok(Math.abs(collapsed.workspace.x + collapsed.workspace.width / 2 - width / 2) < 1);
                assert.ok(Math.abs(collapsed.headline.y - initial.headline.y) < 1, `Headline shifted at ${width}`);
                assert.ok(samples.every(sample => sample.brands === 1));
                assert.ok(samples.every(sample => Math.abs(sample.headlineY - initial.headline.y) < 1), `Animation shifted headline at ${width}`);
                assert.equal(samples[0].phase, 'brand-out');
                assert.ok(samples.some(sample => sample.phase === 'brand-out' && sample.gap > 0 && sample.sidebarSpace > 0));
                assert.ok(samples.some(sample => sample.phase === 'brand-in' && sample.parent === 'workspace-brand-slot'
                    && sample.opacity > 0 && sample.sidebarSpace > 0));
                await page.screenshot({ path: fileURLToPath(new URL(`${width}-collapsed.png`, output)), fullPage: true });
                await panelCycle(page, width, 'collapsed');
                await page.reload();
                await ready(page);
                await waitIdle(page);
                assert.equal((await metrics(page)).collapsed, true);
                await sampleToggle(page);
                await waitIdle(page);
                assert.equal((await metrics(page)).brandParent, 'config-sidebar');
                await page.locator('#pie-mode-personal').click();
                await page.waitForFunction(() => document.getElementById('pie-mode-personal').getAttribute('aria-selected') === 'true');
                const personal = await metrics(page);
                const personalSamples = await sampleToggle(page);
                await waitIdle(page);
                assert.ok(personalSamples.every(sample => Math.abs(sample.headlineY - personal.headline.y) < 1));
                await sampleToggle(page);
                await waitIdle(page);
                results.push({ width, initial, collapsed, samples, errors });
            } else {
                assert.equal(initial.brandParent, 'config-sidebar');
                assert.equal(await page.locator('#config-site-links > .th-social').isVisible(), true);
                assert.equal(await page.locator('#config-site-links > #taxonomy-toggle').isVisible(), true);
                assert.equal(await page.locator('#config-site-more').isVisible(), false);
                assert.equal(await page.locator('#config-site-links > a[href="/topic-proposals"], #config-site-links > a[href="/how-it-works"], #config-site-account').count(), 0);
                const header = await page.locator('#config-sidebar').evaluate(node => {
                    const style = getComputedStyle(node);
                    const rect = node.getBoundingClientRect();
                    return { height: rect.height, backdrop: style.backdropFilter || style.webkitBackdropFilter };
                });
                assert.ok(header.height <= 64 && header.backdrop.includes('blur'), JSON.stringify(header));
                await page.locator('#taxonomy-toggle').click();
                await page.waitForSelector('body.taxonomy-open');
                await checkNavigationControls(page, 44);
                assert.equal(await page.locator('#tree-content [aria-current="page"]').getAttribute('data-category-id'), '54');
                await page.locator('#navigation-search-toggle').click();
                await page.locator('#configured-search').fill('Research');
                await page.waitForSelector('#category-search-results a');
                assert.equal(await page.locator('#category-search-results a').count(), 2);
                await page.locator('#category-search-results a[data-category-id="190"]').click();
                await ready(page);
                await page.waitForFunction(() => !document.body.classList.contains('taxonomy-open'));
                assert.equal(new URL(page.url()).pathname, '/secondary-research');
                await page.locator('#taxonomy-toggle').click();
                await page.waitForSelector('body.taxonomy-open');
                assert.equal(await page.locator('#tree-content [aria-current="page"]').getAttribute('data-category-id'), '190');
                await page.locator('#taxonomy-close').click();
                await page.waitForFunction(() => !document.body.classList.contains('taxonomy-open'));
                await panelCycle(page, width, 'mobile');
                assert.ok((await metrics(page)).scrollWidth <= width);
                results.push({ width, initial, errors });
            }
            assert.deepEqual(errors, [], `Browser errors at ${width}`);
            await context.close();
        }
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
        await context.addInitScript(() => {
            if (localStorage.getItem('benchpoll:config-sidebar-collapsed') === null)
                localStorage.setItem('benchpoll:config-sidebar-collapsed', 'false');
        });
        const page = await context.newPage();
        await page.goto(`${preview.url}/topics/54/intelligence`);
        await ready(page);
        await page.locator('#public-fallback-toggle').click();
        await page.waitForSelector('#fallback-picker');
        await page.keyboard.press('Escape');
        const before = await metrics(page);
        await page.locator('#config-sidebar-toggle').click();
        await waitIdle(page);
        assert.equal((await metrics(page)).brandParent, 'workspace-brand-slot');
        assert.equal(await page.locator('.bp-shell').evaluate(node => getComputedStyle(node).transitionDuration), '0s');
        assert.equal((await metrics(page)).headline.y, before.headline.y);
        if (!process.argv.includes('--navigation-only')) {
        await page.locator('#header-user-profile').click();
        await page.locator('#edit-profile-button').click();
        await page.getByRole('textbox', { name: 'Display name', exact: true }).fill('Updated account');
        await page.locator('.bp-profile-editor input[type="file"]').setInputFiles({ name: 'avatar.png', mimeType: 'image/png',
            buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
        await page.waitForFunction(() => document.querySelector('.bp-profile-editor form').getAttribute('aria-busy') === 'false');
        await page.locator('.bp-profile-editor').getByRole('button', { name: 'Save', exact: true }).click();
        await page.waitForFunction(() => document.getElementById('account-dialog-name').textContent === 'Updated account');
        assert.equal(await page.locator('#user-profile-name').textContent(), 'Updated account');
        assert.match(await page.locator('#header-user-profile').getAttribute('aria-label'), /Updated account/);
        const avatars = await page.locator('#user-profile-picture, #account-dialog-picture, #header-user-profile [data-account-picture]')
            .evaluateAll(nodes => nodes.map(node => node.style.backgroundImage));
        assert.ok(avatars[0].startsWith('url("data:image/png;base64,'));
        assert.ok(avatars.every(avatar => avatar === avatars[0]));
        await page.evaluate(() => document.dispatchEvent(new CustomEvent('benchpoll:profile-updated',
            { detail: { userID: '2', userName: 'Wrong account' } })));
        assert.equal(await page.locator('#account-dialog-name').textContent(), 'Updated account');
        assert.equal(preview.state.requests.find(request => request.path === '/api/save_user_profile').body.expectedUserID, '1');
        await page.locator('#user-account-dialog .dialog-close-button').click();
        }
        await page.locator('#config-sidebar-toggle').click();
        await waitIdle(page);
        await page.locator('[data-navigation-view="configured"]').click();
        await page.locator('[data-create-topic="private"]').click();
        await page.locator('#topic-create-name').fill('My private topic');
        await page.locator('#topic-create-description').fill('A private topic with no saved Pie.');
        await page.locator('#topic-create-form [type="submit"]').click();
        await page.waitForURL('**/personal/999');
        await ready(page);
        assert.equal(await page.locator('#bp-breadcrumb').innerText(), 'My private topic\nPrivate');
        await page.locator('#configured-content [data-location-category-id="999"]').waitFor();
        assert.equal(await page.locator('#configured-content [data-location-category-id="999"]').getAttribute('data-configured'), 'false');
        assert.equal(preview.state.requests.find(request => request.path === '/api/create_topic').body.expectedUserID, '1');
        assert.equal(preview.state.requests.some(request => /composition|load_benchmarks_and_subcategories/.test(request.path)), false);

        const readVisits = () => page.evaluate(() => JSON.parse(localStorage.getItem('benchpoll-sidebar-recent-v1:user:1') ?? '[]'));
        const recentOrder = () => page.locator('#tree-content [data-key]').evaluateAll(nodes => nodes.map(node => node.dataset.key));
        await page.locator('[data-navigation-view="recent"]').click();
        await page.waitForSelector('#tree-content [data-category-id="999"]');
        assert.ok((await readVisits()).some(visit => visit.categoryID === 999));
        assert.equal(JSON.stringify(await readVisits()).includes('My private topic'), false);
        await page.locator('[data-navigation-view="popular"]').click();
        assert.deepEqual(await page.locator('#tree-content [data-category-id]').evaluateAll(nodes => nodes.map(node => Number(node.dataset.categoryId))), [54, 167, 170, 190]);
        await page.locator('#tree-content [data-category-id="170"]').click();
        await page.waitForURL('**/biology-and-medicine*');
        await page.waitForFunction(() => JSON.parse(localStorage.getItem('benchpoll-sidebar-recent-v1:user:1')).some(visit => visit.categoryID === 170));
        await ready(page);
        await page.locator('[data-navigation-view="configured"]').click();
        assert.equal(await page.locator('#configured-content [data-location-category-id="170"]').count(), 0);
        assert.equal(await page.locator('#configured-content [data-location-category-id="999"]').count(), 1);
        assert.ok(await page.locator('#configured-content [data-location-category-id="54"]').count() > 0);

        await page.locator('[data-navigation-view="popular"]').click();
        const beforeFailure = await readVisits();
        await page.route('**/api/get_topic', route => route.request().postDataJSON().categoryID === 167
            ? route.fulfill({ status: 503, json: { error: 'fixture_failure' } }) : route.continue());
        await page.locator('#tree-content [data-category-id="167"]').click();
        await page.waitForFunction(() => document.getElementById('navigation-feedback').textContent.includes('Could not open'));
        assert.deepEqual(await readVisits(), beforeFailure);
        await page.unroute('**/api/get_topic');
        await page.locator('#tree-content [data-category-id="167"]').click();
        await page.waitForFunction(() => JSON.parse(localStorage.getItem('benchpoll-sidebar-recent-v1:user:1')).some(visit => visit.categoryID === 167));
        await ready(page);
        await page.locator('[data-navigation-view="recent"]').click();
        await page.waitForFunction(() => document.querySelector('#tree-content [data-category-id]')?.dataset.categoryId === '167');
        await page.waitForSelector('#tree-content [data-category-id="999"]');
        const ordered = await recentOrder();
        preview.state.workspaceDelay = 250;
        await page.locator('#tree-content [data-category-id="54"]').click();
        await page.waitForTimeout(80);
        assert.deepEqual(await recentOrder(), ordered, 'Recent order changed during navigation');
        await page.waitForFunction(() => document.querySelector('#tree-content [aria-current="page"]')?.dataset.categoryId === '54');
        await page.waitForTimeout(350);
        assert.deepEqual(await recentOrder(), ordered, 'Recent item jumped while it still had pointer/keyboard focus');
        await page.locator('#workspace-headline').click();
        await page.waitForFunction(() => document.querySelector('#tree-content [data-category-id]')?.dataset.categoryId === '54');
        preview.state.workspaceDelay = 0;

        await page.goto(`${preview.url}/topics/167/research?context_budget=extended`);
        await ready(page);
        await page.waitForFunction(() => JSON.parse(localStorage.getItem('benchpoll-sidebar-recent-v1:user:1'))
            .filter(visit => visit.categoryID === 167).length === 2);
        await page.locator('[data-navigation-view="recent"]').click();
        assert.match(await page.locator('#tree-content [aria-current="page"]').getAttribute('data-key'), /167:.*extended/);
        assert.equal((await readVisits())[0].contextValues.budget, 'extended');
        await page.reload();
        await ready(page);
        assert.match(await page.locator('#tree-content [aria-current="page"]').getAttribute('data-key'), /167:.*extended/);

        await page.close();
        preview.setAccount('2');
        const other = await context.newPage();
        await other.goto(`${preview.url}/topics/54/intelligence`);
        await ready(other);
        await other.evaluate(() => localStorage.setItem('benchpoll-sidebar-recent-v1:user:2', JSON.stringify([
            { categoryID: 999, contextValues: {}, isPrivate: true, visitedAt: Date.now() },
            { categoryID: 54, contextValues: { budget: 'standard' }, isPrivate: false, visitedAt: Date.now() - 1 }
        ])));
        await other.reload();
        await ready(other);
        await other.locator('[data-navigation-view="recent"]').click();
        await other.waitForTimeout(100);
        assert.equal(await other.locator('#tree-content [data-category-id="999"]').count(), 0);
        assert.equal((await other.locator('body').innerText()).includes('My private topic'), false);
        assert.equal(await other.locator('#user-profile-name').textContent(), 'User 2');
        await other.close();
        preview.setAccount(null);
        const guest = await context.newPage();
        await guest.goto(`${preview.url}/topics/54/intelligence`);
        await ready(guest);
        await guest.locator('[data-navigation-view="recent"]').click();
        assert.equal(await guest.locator('#tree-content [data-category-id="999"]').count(), 0);
        assert.ok(await guest.evaluate(() => JSON.parse(localStorage.getItem('benchpoll-sidebar-recent-v1:guest')).every(visit => !visit.isPrivate)));
        await guest.close();
        await context.close();
        await writeFile(new URL('results.json', output), JSON.stringify(results, null, 2));
        console.log(`PASS: ${results.length} viewports, brand motion/reduced motion, discussions/details, four navigation modes, successful-visit persistence, no-jump navigation, account isolation${process.argv.includes('--navigation-only') ? '' : ', profile name/avatar'} and Mine private topic creation.`);
    } finally { await browser.close(); await preview.close(); }
}
