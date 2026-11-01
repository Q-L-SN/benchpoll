import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { before, after, test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { fixtureWeights, startTopicsPreview } from '../scripts/frontend/topics-home-fixtures.mjs';

const output = resolve(process.env.SCENE_HERO_ARTIFACTS || 'D:/Codex-artifacts/website1/scene-tabs-hero-20261101');
const browsers = new Map(), reports = [];
let app;
before(async () => {
    await mkdir(output, { recursive: true });
    const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    for (const launcher of [chromium, webkit]) browsers.set(launcher.name(), await launcher.launch({ headless: true, env }));
    app = await startTopicsPreview({ built: false });
});
after(async () => {
    await writeFile(join(output, 'geometry.json'), JSON.stringify(reports, null, 2));
    for (const browser of browsers.values()) await browser.close();
    await app?.close();
});

async function open(t, engine, width) {
    const context = await browsers.get(engine).newContext({ viewport: { width, height: 900 },
        isMobile: width <= 390, hasTouch: width <= 390, reducedMotion: 'no-preference', serviceWorkers: 'block' });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await context.close(); assert.deepEqual(errors, [], 'No uncaught browser errors'); });
    return page;
}

const sceneHTML = `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/css/ui/tokens.css"><link rel="stylesheet" href="/css/site-palette.css">
<link rel="stylesheet" href="/css/typography.css"><link rel="stylesheet" href="/css/ui/components.css">
<link rel="stylesheet" href="/css/ui/topic-scenes.css"><link rel="stylesheet" href="/vendor/fontawesome/css/all.min.css">
<style>body{margin:0;background:#fff}main{width:calc(100% - 32px);max-width:900px;margin:32px auto}</style>
<main><h1>Language</h1><section id="scenes" class="bp-scene-strip" hidden></section><div id="workspace-scene-panel"></div></main>
<script type="module">
import { createSceneControls } from '/js/workspace/scenes.js';
const names = ['General', 'English', 'French', ...Array.from({ length: 181 }, (_, i) => 'Language ' + (i + 4))];
const state = { categoryID: 219, userID: null, sceneID: 2, loading: false, authenticated: false,
    scenes: names.map((name, i) => ({ ID: i + 1, name, isDefault: !i })) };
const selections = [], transitions = [];
document.getElementById('scenes').addEventListener('transitionrun', event => {
    if (event.pseudoElement === '::before') transitions.push(event.propertyName);
});
const controls = createSceneControls({ host: document.getElementById('scenes'), getState: () => state,
    async onSelect(id) {
        selections.push(id); state.loading = true; controls.render();
        await new Promise(resolve => setTimeout(resolve, 30));
        state.sceneID = id; state.loading = false; controls.render();
    } });
window.sceneFixture = { state, controls, selections, transitions };
controls.render();
</script></html>`;

async function scenePage(t, engine, width) {
    const page = await open(t, engine, width);
    await page.route('**/scene-controls-test', route => route.fulfill({ body: sceneHTML, contentType: 'text/html' }));
    await page.goto(app.url + '/scene-controls-test');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForSelector('.bp-scene-tabs[data-ui-ready="true"]');
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    return page;
}

async function sceneGeometry(page) {
    return page.locator('.bp-scene-tabs').evaluate(tabs => {
        const selected = tabs.querySelector('[aria-selected="true"]'), marker = getComputedStyle(tabs, '::before');
        return { count: tabs.children.length, selected: selected?.dataset.sceneId, scroll: tabs.scrollLeft,
            start: tabs.classList.contains('has-overflow-start'), end: tabs.classList.contains('has-overflow-end'),
            markerX: new DOMMatrix(marker.transform).m41, markerWidth: parseFloat(marker.width),
            selectedX: selected?.offsetLeft, selectedWidth: selected?.offsetWidth, duration: marker.transitionDuration,
            mask: getComputedStyle(tabs).maskImage, scrollbar: getComputedStyle(tabs).scrollbarWidth,
            horizontalOverflow: tabs.scrollWidth > tabs.clientWidth, documentWidth: document.documentElement.scrollWidth,
            viewport: innerWidth };
    });
}

for (const engine of ['chromium', 'webkit']) {
    for (const width of [320, 390, 1440]) test(`${engine} hero keeps two complete measured phrases at ${width}px`, async t => {
        const page = await open(t, engine, width);
        await page.goto(app.url);
        await page.waitForSelector('#home-title[style]');
        await page.evaluate(() => document.fonts.ready);
        await page.waitForSelector('.th-card.is-featured[data-preview-state="loaded"]');
        async function check() {
            await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
            const geometry = await page.locator('#home-title').evaluate(headline => {
                const box = headline.getBoundingClientRect(), style = getComputedStyle(headline);
                return { width: box.width, font: parseFloat(style.fontSize), max: Number(style.getPropertyValue('--headline-max-size')),
                    documentWidth: document.documentElement.scrollWidth, viewport: innerWidth,
                    phrases: [...headline.children].map(phrase => {
                        const rect = phrase.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(phrase);
                        return { text: phrase.textContent, width: rect.width, top: rect.top, bottom: rect.bottom,
                            lines: new Set([...range.getClientRects()].filter(r => r.width).map(r => Math.round(r.top))).size,
                            nowrap: getComputedStyle(phrase).whiteSpace };
                    }) };
            });
            assert.deepEqual(geometry.phrases.map(phrase => phrase.text), ['We believe in benchmarks.', 'Not a narrow selection.']);
            assert.ok(geometry.font >= 18 && geometry.font <= geometry.max, JSON.stringify(geometry));
            for (const phrase of geometry.phrases) {
                assert.equal(phrase.lines, 1); assert.equal(phrase.nowrap, 'nowrap');
                assert.ok(phrase.width <= geometry.width + .5, JSON.stringify(geometry));
            }
            assert.ok(geometry.phrases[0].bottom <= geometry.phrases[1].top + .5, 'The two phrases do not overlap');
            assert.ok(geometry.documentWidth <= geometry.viewport + 1, 'No page-level horizontal overflow');
            reports.push({ engine, width, type: 'hero', ...geometry });
            return geometry;
        }
        const initial = await check();
        if (width === 1440) assert.equal(initial.font, 58, 'Desktop retains the intended maximum size');
        await page.screenshot({ path: join(output, `${engine}-hero-${width}.png`) });
        if (width === 1440) {
            for (const next of [320, 390, 1440]) { await page.setViewportSize({ width: next, height: 900 }); await check(); }
            await page.locator('#home-title').evaluate(headline => { headline.style.maxWidth = '270px'; });
            await check();
            await page.locator('#home-title').evaluate(headline => { headline.style.maxWidth = ''; });
            assert.equal((await check()).font, 58, 'Growing the actual container restores the capped desktop size');
        }
    });

    test(`${engine} discussion scene tabs retain selection before a sliding marker is mounted`, async t => {
        const page = await scenePage(t, engine, 390);
        const selection = await page.evaluate(() => {
            const tabs = document.createElement('div'); tabs.className = 'bp-scene-tabs';
            const button = document.createElement('button'); button.className = 'bp-scene-tab';
            button.setAttribute('aria-selected', 'true'); button.textContent = 'All scenes';
            tabs.append(button); document.body.append(tabs);
            return { background: getComputedStyle(button).backgroundColor, marker: getComputedStyle(tabs, '::before').opacity };
        });
        assert.notEqual(selection.background, 'rgba(0, 0, 0, 0)');
        assert.equal(selection.marker, '0');
    });

    for (const width of [390, 1440]) test(`${engine} benchmark versions appear only in full weights view at ${width}px`, async t => {
        const page = await open(t, engine, width);
        await page.goto(app.url);
        const card = page.locator('.th-card.is-featured');
        const toggle = page.locator('#topics-view-toggle');
        const benchmark = fixtureWeights.find(weight => weight.name === 'GPQA Diamond');
        const tile = card.locator(`[data-weight-key="condition:${benchmark.conditionID}"]`);
        await card.locator('.th-model-bar').first().waitFor();
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await card.locator('.th-visual').getAttribute('data-view'), 'default');
        assert.ok(await card.locator('.th-tile-name').count() > 0, 'Default view still renders benchmark names');
        assert.equal(await page.locator('.th-tile-version').count(), 0, 'Default model/bar backgrounds contain no version labels');
        assert.equal(await toggle.isVisible(), false, 'View controls remain hidden above the directory');
        await page.locator('#topics').evaluate(topics => topics.scrollIntoView({ block: 'start', behavior: 'instant' }));
        await toggle.waitFor({ state: 'visible' });
        assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
        await page.screenshot({ path: join(output, `${engine}-weight-labels-${width}-default.png`) });

        await toggle.click();
        await card.locator('.th-visual[data-view="weights"] .th-tile-version').first().waitFor();
        assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
        assert.equal(await tile.locator('.th-tile-name').textContent(), benchmark.name);
        const version = tile.locator('.th-tile-version');
        assert.equal(await version.textContent(), benchmark.conditionName);
        assert.equal(await version.isVisible(), true, 'A fitting version remains visible in full weights view');
        const fit = await version.evaluate(label => {
            const box = label.getBoundingClientRect(), tileBox = label.closest('.th-tile').getBoundingClientRect();
            const range = document.createRange(); range.selectNodeContents(label);
            return { text: label.textContent, overflow: label.dataset.overflow,
                textWidth: range.getBoundingClientRect().width, labelWidth: box.width,
                insideTile: box.left >= tileBox.left && box.right <= tileBox.right
                    && box.top >= tileBox.top && box.bottom <= tileBox.bottom };
        });
        assert.equal(fit.overflow, 'false');
        assert.ok(fit.textWidth <= fit.labelWidth + .5, JSON.stringify(fit));
        assert.equal(fit.insideTile, true, 'The displayed version is not clipped by its tile');
        assert.equal(await card.locator('.th-model-bar').count(), 0);
        await page.screenshot({ path: join(output, `${engine}-weight-labels-${width}-weights.png`) });

        await toggle.click();
        await card.locator('.th-visual[data-view="default"] .th-model-bar').first().waitFor();
        assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
        assert.equal(await tile.locator('.th-tile-name').textContent(), benchmark.name);
        assert.equal(await page.locator('.th-tile-version').count(), 0, 'Returning to model view removes versions rather than hiding stale nodes');
        await page.screenshot({ path: join(output, `${engine}-weight-labels-${width}-restored.png`) });
        reports.push({ engine, width, type: 'weight-label-visibility', defaultVersions: 0, fullWeights: fit, restoredVersions: 0 });
    });

    for (const width of [320, 390, 1440]) test(`${engine} scene marker survives renders and long-list navigation at ${width}px`, async t => {
        const page = await scenePage(t, engine, width);
        const initial = await sceneGeometry(page);
        assert.equal(initial.count, 184); assert.equal(initial.start, false); assert.equal(initial.end, true);
        assert.equal(initial.scrollbar, 'none'); assert.match(initial.mask, /gradient/);
        assert.ok(Math.abs(initial.markerX - initial.selectedX) <= 1);
        assert.deepEqual(await page.evaluate(() => sceneFixture.transitions), [], 'No initial animation from zero');
        const motion = await page.evaluate(async () => {
            const tabs = document.querySelector('.bp-scene-tabs'), previous = document.getElementById('scene-tab-2');
            const position = () => new DOMMatrix(getComputedStyle(tabs, '::before').transform).m41;
            const start = position(), samples = [];
            document.getElementById('scene-tab-3').click();
            const until = performance.now() + 400;
            while (performance.now() < until) {
                await new Promise(requestAnimationFrame);
                samples.push(position()); sceneFixture.controls.render();
            }
            return { start, end: position(), samples, sameNode: previous === document.getElementById('scene-tab-2') };
        });
        assert.equal(motion.sameNode, true, 'Routine renders retain existing buttons');
        assert.ok(motion.end > motion.start + 20, JSON.stringify(motion));
        assert.ok(motion.samples.some(x => x > motion.start + 1 && x < motion.end - 1), 'Selection interpolates between old and new tabs');
        assert.ok(motion.samples.every(x => x >= motion.start - 1), 'Renders never restart the marker at zero');
        let geometry = await sceneGeometry(page);
        assert.ok(Math.abs(geometry.markerX - geometry.selectedX) <= 1);
        assert.ok(Math.abs(geometry.markerWidth - geometry.selectedWidth) <= 1);
        await page.screenshot({ path: join(output, `${engine}-scenes-${width}.png`) });

        await page.locator('#scene-tab-3').focus();
        await page.keyboard.press('End');
        assert.equal(await page.evaluate(() => document.activeElement.dataset.sceneId), '184');
        assert.deepEqual(await page.evaluate(() => sceneFixture.selections), [3], 'Arrow/Home/End movement does not activate');
        await page.waitForFunction(() => !document.querySelector('.bp-scene-tabs').classList.contains('has-overflow-end'));
        geometry = await sceneGeometry(page);
        assert.ok(geometry.scroll > 0); assert.equal(geometry.start, true);
        await page.evaluate(() => sceneFixture.controls.render());
        assert.equal(await page.evaluate(() => document.activeElement.dataset.sceneId), '184', 'Render retains keyboard focus');
        await page.keyboard.press('Enter');
        await page.waitForSelector('#scene-tab-184[aria-selected="true"]');
        await page.waitForTimeout(280);
        geometry = await sceneGeometry(page);
        assert.ok(Math.abs(geometry.markerX - geometry.selectedX) <= 1);
        await page.screenshot({ path: join(output, `${engine}-scenes-${width}-end.png`) });

        await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
        assert.equal(await page.evaluate(() => document.activeElement.dataset.sceneId), '2');
        assert.deepEqual(await page.evaluate(() => sceneFixture.selections), [3, 184]);
        await page.keyboard.press('Space');
        await page.waitForSelector('#scene-tab-2[aria-selected="true"]');
        await page.waitForTimeout(280);
        await page.locator('.bp-scene-tabs').evaluate(tabs => { tabs.scrollLeft = 500; });
        await page.waitForFunction(() => document.querySelector('.bp-scene-tabs.has-overflow-start.has-overflow-end'));
        const scroll = await page.locator('.bp-scene-tabs').evaluate(tabs => tabs.scrollLeft);
        await page.evaluate(() => sceneFixture.controls.render());
        assert.equal(await page.locator('.bp-scene-tabs').evaluate(tabs => tabs.scrollLeft), scroll, 'Routine render preserves manual scrolling');
        await page.screenshot({ path: join(output, `${engine}-scenes-${width}-middle.png`) });

        if (engine === 'chromium' && width === 390) {
            const tabs = page.locator('.bp-scene-tabs'), bounds = await tabs.boundingBox();
            await tabs.evaluate(node => { node.scrollLeft = 0; });
            const session = await page.context().newCDPSession(page);
            const point = x => [{ x, y: bounds.y + bounds.height / 2 }];
            const start = bounds.x + bounds.width - 35;
            await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(start) });
            for (let step = 1; step <= 10; step++) {
                await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(start - step * 20) });
                await page.waitForTimeout(16);
            }
            await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await page.waitForFunction(() => document.querySelector('.bp-scene-tabs').scrollLeft > 20);
            assert.deepEqual(await page.evaluate(() => sceneFixture.selections), [3, 184, 2], 'Touch scrolling does not activate a scene');
            await session.detach();
        }

        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.evaluate(() => { sceneFixture.state.sceneID = 3; sceneFixture.controls.render(); });
        geometry = await sceneGeometry(page);
        assert.equal(geometry.duration, '0s');
        assert.ok(Math.abs(geometry.markerX - geometry.selectedX) <= 1, 'Reduced motion selects without interpolation');
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.evaluate(() => {
            sceneFixture.state.scenes = sceneFixture.state.scenes.slice(0, 3);
            sceneFixture.state.scenes[2].name = 'A renamed scene'; sceneFixture.controls.render();
        });
        await page.waitForFunction(() => !document.querySelector('.bp-scene-tabs').classList.contains('has-overflow-start')
            && !document.querySelector('.bp-scene-tabs').classList.contains('has-overflow-end'));
        geometry = await sceneGeometry(page);
        assert.equal(geometry.count, 3); assert.equal(geometry.mask, 'none');
        assert.ok(Math.abs(geometry.markerWidth - geometry.selectedWidth) <= 1, 'Renamed/resized tabs update the marker');
        assert.ok(geometry.documentWidth <= geometry.viewport + 1);
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.evaluate(() => {
            sceneFixture.transitions.length = 0;
            sceneFixture.state.categoryID = 220;
            sceneFixture.state.sceneID = 1;
            sceneFixture.controls.render();
        });
        await page.waitForTimeout(280);
        assert.deepEqual(await page.evaluate(() => sceneFixture.transitions), [], 'A new topic initializes without sliding from the previous topic');
        await page.evaluate(() => { sceneFixture.state.scenes = []; sceneFixture.controls.render(); });
        assert.equal(await page.locator('.bp-scene-tabs').getAttribute('data-ui-ready'), null, 'Empty catalog clears the marker');
        reports.push({ engine, width, type: 'scene', initial, motion, final: geometry });
    });
}
