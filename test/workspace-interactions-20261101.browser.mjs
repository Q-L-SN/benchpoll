import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startConfigSidebarPreview } from './helpers/config-sidebar-fixture-20261022.mjs';
import { workspace } from '../scripts/frontend/fixtures.mjs';
import { buildBenchmarkList } from '../ranking-service.js';
import { referenceCondition } from '../topic-reference-service.js';
import { createRankingPager } from '../ranking-pagination.js';
import { sceneSummary } from '../public/js/shared/topics.js';
import { entryFromContext } from '../public/js/navigation/model.js';

const output = 'artifacts/workspace-ui-20261101';
const built = process.env.BP_TEST_BUILT === '1';
const scenes = Array.from({ length: 30 }, (_, i) => ({ ID: 5401 + i, name: `Scene ${String(i + 1).padStart(2, '0')}`,
    description: `Intelligence: Scene ${String(i + 1).padStart(2, '0')}.`, slug: `scene-${i + 1}`, isDefault: i === 0 }));
const targets = [{ contextID: 16702, categoryID: 167, sceneID: 16702, name: 'Research / Physics',
    topicName: 'Research', sceneName: 'Physics', description: 'Scientific problem solving.', hasWeights: true,
    isPrivate: false, url: '/research/physics' }];

async function mountFixture(page, app) {
    const pager = createRankingPager(), reads = [], coverageReads = [];
    const fixture = { reads, coverageReads, delay: 0, failure: false, loadedScene: null };
    const metadata = topic => ({ ...topic, categoryID: topic.ID, categoryName: topic.name,
        description: 'Compare models on reasoning, knowledge and practical skills.',
        scenes: topic.ID === 54 ? scenes : [], rootContextID: topic.ID * 100 + 1, defaultContextID: topic.ID * 100 + 1,
        isMine: false, configured: true, contextValues: {}, dimensions: [], url: `/${topic.slug}`,
        lineage: [{ ID: topic.ID, name: topic.name }] });
    await page.route('**/api/get_topic', route => route.fulfill({ json: metadata(app.topics[0]) }));
    await page.route('**/api/get_topics', route => route.fulfill({ json: { topics: app.topics.map(metadata) } }));
    await page.route('**/api/get_category_navigation', route => route.fulfill({ json: {
        items: app.topics.filter(topic => !topic.isPrivate).map(topic => entryFromContext(metadata(topic))) } }));
    await page.route('**/api/get_personal_navigation', route => route.fulfill({ json: { userID: app.state.userID, items: [] } }));
    await page.route('**/api/get_topic_reference_targets', route => route.fulfill({ json: { targets } }));
    await page.route('**/api/get_topic_preview', route => {
        coverageReads.push(route.request().postDataJSON());
        return route.fulfill({ json: { totalCoverageIndex: 1.5 } });
    });
    await page.route('**/api/get_weighted_workspace', async route => {
        const body = route.request().postDataJSON(); reads.push(body);
        if (fixture.delay) await new Promise(resolve => setTimeout(resolve, fixture.delay));
        if (fixture.failure) return route.fulfill({ status: fixture.failure, json: { error: 'fixture_unavailable' } });
        const base = workspace(app.state, { ...body, categoryID: 1, contextValues: {} }, { paginate: false });
        const meta = metadata(app.topics[0]), scene = scenes.find(scene => scene.ID === Number(body.contextValues?.scene)) ?? scenes[0];
        base.context = { ...base.context, ...meta, ID: scene.ID, sceneID: scene.ID, categoryPath: meta.slug,
            contextValues: { scene: String(scene.ID) }, description: sceneSummary(meta, scene) };
        base.benchmarks = buildBenchmarkList([...base.benchmarks, ...targets.map(referenceCondition)], [
            { conditionID: 1, weightBasisPoints: 7000 }, { conditionID: -16702, weightBasisPoints: 2000 },
            { conditionID: 2, weightBasisPoints: 1000 }
        ], base.personalPie.entries);
        fixture.loadedScene = scene.ID;
        return route.fulfill({ json: pager.create(base, { userID: app.state.userID, initialMode: body.initialMode ?? 'public',
            query: body.benchmarkQuery ?? '', pinPersonal: body.pinPersonal ?? false, groupVersions: body.groupVersions ?? false }) });
    });
    await page.route('**/api/get_ranking_page', route => route.fulfill({ json: pager.getPage({
        ...route.request().postDataJSON(), userID: app.state.userID }) }));
    if (built) await page.route('**/intelligence/**', async route => {
        if (route.request().isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: await readFile('private/home-built.html', 'utf8') });
        return route.fallback();
    });
    return fixture;
}

async function touchDriver(page, native) {
    const cdp = native ? await page.context().newCDPSession(page) : null;
    let target = null;
    return async (type, x, y) => {
        if (cdp) return cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
        // Playwright exposes native touch injection only for Chromium. WebKit covers the same drawer event handlers.
        if (type === 'touchStart') target = { x, y };
        await page.evaluate(({ type, x, y, target }) => {
            if (type === 'touchStart') window.drawerTestTarget = document.elementFromPoint(target.x, target.y);
            const node = window.drawerTestTarget;
            const touch = { identifier: 1, target: node, clientX: x, clientY: y };
            const event = new Event(type.toLowerCase(), { bubbles: true, composed: true, cancelable: true });
            Object.defineProperties(event, { touches: { value: type === 'touchEnd' ? [] : [touch] },
                changedTouches: { value: [touch] } });
            node.dispatchEvent(event);
        }, { type, x, y, target });
    };
}

const cases = built ? [[chromium, 390]] : [[chromium, 390], [webkit, 390], [chromium, 320], [chromium, 1440]];
for (const [engine, width] of cases) test(`workspace interactions ${engine.name()} ${width} ${built ? 'bundled' : 'source'}`, { timeout: 90000 }, async t => {
    await mkdir(output, { recursive: true });
    const app = await startConfigSidebarPreview(), browser = await engine.launch({ headless: true });
    t.after(async () => { await browser.close(); await app.close(); });
    const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: width <= 760, hasTouch: width <= 760 });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const fixture = await mountFixture(page, app);
    await page.goto(`${app.url}/intelligence/scene-30`);
    if (built) assert.ok(await page.locator('script[src^="/build/home/"]').count(), 'The journey uses compiled frontend assets');
    await page.waitForSelector('.bp-scene-tab[data-scene-id="5430"][aria-selected="true"]');
    await page.waitForSelector('.bp-model-row');
    await page.evaluate(() => document.fonts.ready);
    const sceneTabs = page.getByRole('tablist', { name: 'Scenes', exact: true });
    const selectedRect = await page.locator('#scene-tab-5430').boundingBox(), tabsRect = await sceneTabs.boundingBox();
    assert.ok(selectedRect.x >= tabsRect.x - 1 && selectedRect.x + selectedRect.width <= tabsRect.x + tabsRect.width + 1,
        'direct scene entry reveals the selected tab');
    assert.match(await page.locator('#workspace-topic-summary').textContent(), /Compare models on reasoning/);

    // The selected pill begins moving while the scene response is deliberately still pending.
    fixture.delay = 650;
    const oldX = await sceneTabs.evaluate(node => getComputedStyle(node, '::before').transform);
    await page.locator('#scene-tab-5429').click();
    await page.waitForFunction(() => document.querySelector('#scene-tab-5429').getAttribute('aria-selected') === 'true');
    await page.waitForTimeout(90);
    const movingX = await sceneTabs.evaluate(node => getComputedStyle(node, '::before').transform);
    assert.notEqual(movingX, oldX, `scene marker moves before the request completes: ${JSON.stringify(await sceneTabs.evaluate(node => ({
        x: node.style.getPropertyValue('--ui-segment-x'), selected: node.querySelector('[aria-selected="true"]').offsetLeft,
        animated: node.dataset.sceneAnimated, duration: getComputedStyle(node, '::before').transitionDuration
    })))}`);
    assert.equal(fixture.loadedScene, 5430);
    await page.waitForFunction(() => !document.querySelector('#scene-tab-5429').disabled);
    assert.equal(fixture.loadedScene, 5429); fixture.delay = 0;

    fixture.failure = 400;
    await page.locator('#scene-tab-5428').click();
    await page.waitForSelector('#benchmark-rows .bp-error-state');
    assert.equal(await page.locator('#scene-tab-5429').getAttribute('aria-selected'), 'true', 'failed loading restores the previous selection');
    fixture.failure = false;
    await page.locator('#benchmark-rows .bp-error-state button').click();
    await page.waitForURL('**/intelligence/scene-28');
    await page.waitForSelector('#scene-tab-5428[aria-selected="true"]');

    const reference = page.locator('.bp-benchmark-row[data-context-id="16702"]');
    await reference.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('[data-context-id="16702"] [data-coverage-value]')?.textContent === '1.5');
    assert.equal(await reference.locator('.bp-benchmark-condition').count(), 0);
    assert.equal(await reference.locator('.fa-layer-group').count(), 1);
    assert.equal(await reference.locator('.fa-angle-right').count(), 1);
    assert.equal(await reference.locator('.fa-circle-half-stroke').count(), 1);
    assert.equal(await reference.locator('.bp-evidence-count').getAttribute('role'), 'img');
    assert.equal(await reference.locator('.bp-evidence-count').getAttribute('tabindex'), '0');
    assert.equal(await reference.locator('a').getAttribute('href'), '/research/physics');
    assert.equal(await page.locator('.bp-benchmark-topic-results').count(), 0);
    const siblings = await reference.evaluate(node => [node.parentElement.previousElementSibling?.querySelector('.bp-benchmark-row')?.dataset.conditionId,
        node.parentElement.nextElementSibling?.querySelector('.bp-benchmark-row')?.dataset.conditionId]);
    assert.ok(siblings.every(value => Number(value) > 0), 'topic is mixed between ordinary benchmark rows');
    await page.screenshot({ path: `${output}/${engine.name()}-${width}-evaluations${built ? '-built' : ''}.png` });

    if (width <= 760) {
        const pager = page.locator('#workspace-scene-panel');
        await page.locator('.bp-left-workspace').evaluate(node => { node.scrollTop = 0; });
        const heading = await page.locator('.bp-context-row').boundingBox();
        const undoStyle = await page.locator('#workspace-undo').evaluate(node => ({ border: getComputedStyle(node).borderWidth, background: getComputedStyle(node).backgroundColor }));
        assert.equal(undoStyle.border, '0px'); assert.equal(undoStyle.background, 'rgba(0, 0, 0, 0)');
        const touch = await touchDriver(page, engine === chromium);
        const pagerBox = await pager.boundingBox(), y = Math.round(pagerBox.y + 110);
        if (engine === chromium) {
            await touch('touchStart', width - 50, y);
            for (let x = width - 70; x >= Math.round(width / 2) - 40; x -= 20) {
                await touch('touchMove', x, y); await page.waitForTimeout(20);
            }
            const middle = await pager.evaluate(node => node.scrollLeft);
            assert.ok(middle > 40 && middle < pagerBox.width - 20, `native pager follows the finger before release (${middle})`);
            await touch('touchMove', 40, y); await touch('touchEnd', 40, y);
        } else await page.locator('.bp-mobile-panels [data-mobile-panel="models"]').click();
        await page.waitForFunction(() => document.querySelector('#workspace-undo').getBoundingClientRect().width < .1
            && document.querySelector('#workspace-undo').getAttribute('aria-hidden') === 'true');
        assert.equal(await page.locator('#workspace-undo').getAttribute('aria-hidden'), 'true');
        const sameHeading = await page.locator('.bp-context-row').boundingBox();
        assert.ok(Math.abs(sameHeading.y - heading.y) < 1, 'topic and scene header remain fixed across pages');
        assert.equal(await sceneTabs.isVisible(), true);
        const toolbar = page.locator('.bp-model-controls');
        assert.equal(await toolbar.evaluate(node => getComputedStyle(node).flexWrap), 'nowrap');
        assert.equal(await toolbar.evaluate(node => node.classList.contains('has-overflow-end')), true);
        await toolbar.evaluate(node => { node.scrollLeft = node.scrollWidth; });
        await page.waitForFunction(() => document.querySelector('.bp-model-controls').classList.contains('has-overflow-start'));
        assert.equal(await page.locator('#contribute-data-button > span').isVisible(), true);
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-ranking${built ? '-built' : ''}.png` });
        await toolbar.evaluate(node => { node.scrollLeft = 0; });
        if (engine === chromium) {
            await touch('touchStart', 50, y);
            for (let x = 75; x < width / 2 + 45; x += 20) {
                await touch('touchMove', x, y); await page.waitForTimeout(20);
            }
            const middle = await pager.evaluate(node => node.scrollLeft);
            assert.ok(middle > 20 && middle < pagerBox.width - 30, 'return swipe follows the finger');
            assert.equal(await page.locator('body').evaluate(node => node.classList.contains('taxonomy-open')), false);
            await touch('touchMove', width - 35, y); await touch('touchEnd', width - 35, y);
        } else await page.locator('.bp-mobile-panels [data-mobile-panel="mix"]').click();
        await page.waitForFunction(() => document.querySelector('#workspace-scene-panel').scrollLeft < 1);

        // The sidebar remains at an intermediate translation until the finger is released.
        const title = await page.locator('.bp-page-heading').boundingBox(), drawerY = Math.round(title.y + 12);
        await touch('touchStart', 65, drawerY);
        await touch('touchMove', 110, drawerY); await page.waitForTimeout(35);
        await touch('touchMove', 170, drawerY); await page.waitForTimeout(35);
        const partialDrawer = await page.locator('#config-sidebar').boundingBox();
        assert.ok(partialDrawer.x < -20 && partialDrawer.x > -partialDrawer.width + 20, 'drawer follows partial drag');
        assert.ok(await page.locator('body').evaluate(node => node.classList.contains('taxonomy-dragging')));
        await touch('touchMove', width - 40, drawerY); await touch('touchEnd', width - 40, drawerY);
        await page.waitForFunction(() => Math.abs(document.querySelector('#config-sidebar').getBoundingClientRect().x) < 1);
        await touch('touchStart', 250, 250); await touch('touchMove', 200, 250); await page.waitForTimeout(35);
        await touch('touchMove', 110, 250); await page.waitForTimeout(35);
        assert.ok((await page.locator('#config-sidebar').boundingBox()).x < -30);
        await touch('touchMove', 35, 250); await touch('touchEnd', 35, 250);
        await page.waitForFunction(() => !document.body.classList.contains('taxonomy-open'));
        assert.ok(Math.abs((await page.locator('.bp-context-row').boundingBox()).y - heading.y) < 1, 'drawer leaves header geometry intact');
        await page.locator('.bp-mobile-panels [data-mobile-panel="models"]').click();
        await page.waitForFunction(() => document.querySelector('#workspace-undo').getBoundingClientRect().width < 1);
    }

    await page.locator('[data-score-mode="available"]').click();
    await page.locator('.bp-model-row').first().click();
    const dialog = page.locator('#model-scores-dialog');
    await dialog.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#model-scores-summary').textContent.includes('Before adjustment'));
    const details = await page.locator('.bp-model-calculation-details').textContent();
    assert.match(details, /Before adjustment:/); assert.match(details, /After adjustment:/);
    assert.doesNotMatch(details, /rational|factor|penalty|a =|5 ×/i);
    assert.equal(await dialog.locator('a[href="/how-it-works#rankings"]').count(), 1);
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${output}/${engine.name()}-${width}-score-dialog${built ? '-built' : ''}.png` });
    await dialog.locator('.dialog-close-button').click();
    await dialog.waitFor({ state: 'hidden' });
    if (width <= 760) {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.locator('.bp-mobile-panels [data-mobile-panel="mix"]').click();
        assert.equal(await page.locator('#workspace-scene-panel').evaluate(node => node.scrollLeft), 0);
        assert.equal(await page.locator('.bp-right-workspace').evaluate(node => node.inert), true);
        await page.setViewportSize({ width: 1440, height: 844 });
        await page.waitForFunction(() => !document.querySelector('.bp-right-workspace').inert);
        assert.equal(await page.locator('.bp-mobile-panels').isVisible(), false);
        await page.setViewportSize({ width, height: 844 });
        await page.waitForFunction(() => document.querySelector('.bp-right-workspace').inert);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.deepEqual(errors, []);
});
