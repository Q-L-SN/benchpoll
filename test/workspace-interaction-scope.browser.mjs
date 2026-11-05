import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';

const built = process.env.BP_TEST_BUILT === '1';
const output = process.env.BP_INTERACTION_ARTIFACTS ?? '/tmp/benchpoll-workspace-interaction-scope';
await mkdir(output, { recursive: true });
const scenes = [{ ID: 101, name: 'General', slug: 'general', isDefault: true },
    { ID: 102, name: 'Research', slug: 'research', isDefault: false }];

async function setup(t, engine, width, sceneFixture = false) {
    const app = await startPreview({ communityVersions: true, secondaryBenchmark: true, rankingStress: true });
    const browser = await engine.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width < 760,
        isMobile: width < 760, reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await browser.close(); await app.close(); assert.deepEqual(errors, []); });
    await page.addInitScript(() => {
        localStorage.setItem('benchpoll:config-sidebar-collapsed', 'true');
        localStorage.setItem('benchpoll-workspace-display-v1', 'standard');
    });
    if (sceneFixture) {
        await page.route('**/api/get_topic', async route => {
            const response = await route.fetch(), data = await response.json();
            await route.fulfill({ json: { ...data, scenes, dimensions: [], defaultContextID: 101, rootContextID: 101 } });
        });
        await page.route('**/api/get_weighted_workspace', async route => {
            const response = await route.fetch(), data = await response.json();
            const sceneID = Number(route.request().postDataJSON().contextValues?.scene) || 101;
            Object.assign(data.context, { scenes, dimensions: [], ID: sceneID, sceneID, defaultContextID: 101,
                contextValues: { scene: String(sceneID) } });
            if (sceneID === 102) data.versionComposition.forEach(group => { group.name += ' in Research'; });
            await route.fulfill({ json: data });
        });
    }
    if (built) await page.route(app.url + '/', async route => route.fulfill({ contentType: 'text/html',
        body: await readFile(new URL('../private/home-built.html', import.meta.url), 'utf8') }));
    await page.goto(app.url);
    await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
    return { page, app };
}

for (const [engine, width] of [[chromium, 1440], [chromium, 320], [webkit, 390]]) {
    test(`${engine.name()} ${width}: inline settings remember expansion and follow benchmark and scene changes ${built ? 'built' : 'source'}`, async t => {
        const { page, app } = await setup(t, engine, width, true);
        const panel = page.locator('#benchmark-settings');
        const toggle = page.locator('#inline-fallback-toggle');
        await page.locator('#public-fallback-toggle').click();
        await panel.waitFor();
        assert.equal(await panel.evaluate(node => node.localName), 'section');
        assert.equal(await page.locator('.bp-workspace').evaluate(node => node.inert), false);
        await page.locator('#weight-pie [data-object-id="2"]').click();
        assert.equal(await page.locator('#public-fallback-toggle').getAttribute('aria-expanded'), 'true');
        assert.match(await panel.locator('.bp-benchmark-settings-title').textContent(), /Advanced reasoning/);
        await page.locator('#pie-mode-personal').click();
        await panel.waitFor();
        assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
        await page.locator('#weight-pie [data-object-id="1"]').click();
        assert.match(await panel.locator('.bp-benchmark-settings-title').textContent(), /General knowledge/);
        assert.equal(await panel.locator('.bp-version-choice[data-condition-id="2"]').count(), 0);
        assert.equal(await panel.locator('.bp-version-choice[data-condition-id="1"]').isEnabled(), true);
        for (const expanded of [true, false]) {
            if (!expanded) await toggle.click();
            for (const scene of [102, 101]) {
                await page.locator(`#scene-tab-${scene}`).click();
                await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
                assert.equal(await toggle.getAttribute('aria-expanded'), String(expanded));
                assert.equal(await panel.isVisible(), expanded);
                if (expanded) {
                    const title = await panel.locator('.bp-benchmark-settings-title').textContent();
                    assert.equal(title.includes('in Research'), scene === 102);
                }
                await page.locator('#weight-pie [data-object-id="2"]').click();
                assert.equal(await panel.isVisible(), expanded);
            }
        }
        assert.equal(app.state.requests.filter(request => request.path === '/api/save_personal_pie').length, 0,
            'Opening, collapsing and changing the inspected context never saves weights');
        await toggle.click();
        await panel.waitFor();
        await page.locator('#pie-home-slot').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-${built ? 'built' : 'source'}-inline.png` });
        const preferences = await page.evaluate(() => JSON.parse(sessionStorage.getItem('benchpoll-workspace-preferences-v1')));
        assert.equal(preferences.benchmarkSettingsExpanded, true);
        await page.goto(app.url);
        await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
        assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
        await panel.waitFor();
    });

    test(`${engine.name()} ${width}: name-only inspection and chart-only weight scrolling ${built ? 'built' : 'source'}`, async t => {
        const { page, app } = await setup(t, engine, width);
        await page.locator('#pie-mode-personal').click();
        await page.locator('#pie-mode-personal[aria-selected="true"][aria-busy="false"]').waitFor();
        await page.locator('#model-card[aria-busy="false"]').waitFor();
        const row = page.locator('.bp-benchmark-row[data-condition-id="1"]');
        await row.scrollIntoViewIfNeeded();
        const gap = await row.evaluate(row => {
            const link = row.querySelector('.bp-benchmark-information-link').getBoundingClientRect();
            const count = row.querySelector('.bp-benchmark-score-count').getBoundingClientRect();
            const point = { x: (link.right + count.left) / 2, y: count.top + count.height / 2 };
            return { ...point, linked: Boolean(document.elementFromPoint(point.x, point.y)?.closest('a')), gap: count.left - link.right };
        });
        assert.ok(gap.gap >= 2 && !gap.linked, JSON.stringify(gap));
        await page.mouse.click(gap.x, gap.y);
        assert.equal(await page.locator('#discussion-panel').getAttribute('aria-hidden'), 'true');
        const name = row.locator('.bp-benchmark-information-link');
        await name.click();
        await page.locator('#benchmark-information-name:not(:empty)').waitFor();
        assert.equal(await page.locator('#discussion-panel').getAttribute('aria-hidden'), 'false');
        await page.locator('#benchmark-scores-back').focus(); await page.keyboard.press('Escape');
        await page.locator('#discussion-panel[aria-hidden="true"]').waitFor({ state: 'attached' });
        await name.focus(); await name.press('Enter');
        await page.locator('#discussion-panel[aria-hidden="false"]').waitFor();
        await page.locator('#benchmark-scores-back').focus(); await page.keyboard.press('Escape');
        const tile = page.locator('#weight-pie [data-object-id="1"]');
        await tile.click();
        const hint = page.locator('#pie-adjustment-hint'); await hint.waitFor();
        assert.match(await hint.textContent(), width < 760 ? /Drag up or down on the chart/ : /Scroll on the chart/);
        const geometry = await hint.evaluate(node => ({ bottom: node.getBoundingClientRect().bottom,
            chartTop: document.getElementById('weight-pie').getBoundingClientRect().top,
            color: getComputedStyle(node).color, position: getComputedStyle(node).position,
            background: getComputedStyle(node).backgroundColor }));
        assert.ok(geometry.bottom <= geometry.chartTop + 1, JSON.stringify(geometry));
        assert.equal(geometry.color, 'rgb(255, 255, 255)');
        assert.equal(geometry.position, 'static');
        assert.notEqual(geometry.background, 'rgba(0, 0, 0, 0)');
        assert.equal(await page.locator('#pie-adjustment-status, #pie-adjustment-dismiss').count(), 0);
        const initial = Number(await tile.getAttribute('data-weight'));
        const wheel = selector => page.locator(selector).evaluate(node => {
            const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120 });
            node.dispatchEvent(event); return event.defaultPrevented;
        });
        for (const selector of ['.bp-benchmark-row[data-condition-id="1"]', '.bp-pie-mode-row', '#pie-adjustment-hint', '.bp-model-viewport']) {
            assert.equal(await wheel(selector), false, `${selector} keeps ordinary wheel behavior`);
        }
        await page.waitForTimeout(100);
        assert.equal(Number(await tile.getAttribute('data-weight')), initial);
        assert.equal(await wheel('#weight-pie'), true);
        await page.waitForFunction(initial => Number(document.querySelector('#weight-pie [data-object-id="1"]').dataset.weight) !== initial, initial);
        await page.waitForFunction(() => !document.getElementById('workspace-undo').disabled);
        const nativeMenu = await tile.evaluate(node => {
            const event = new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true });
            node.dispatchEvent(event); return !event.defaultPrevented;
        });
        assert.equal(nativeMenu, true);
        assert.equal(await page.locator('.bp-left-workspace').getAttribute('data-workspace-view'), 'focus');
        assert.ok(app.state.requests.some(request => request.path === '/api/save_personal_pie'));
        await page.locator('#workspace-undo').click();
        await page.waitForFunction(initial => Number(document.querySelector('#weight-pie [data-object-id="1"]').dataset.weight) === initial, initial);
        await hint.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-${built ? 'built' : 'source'}-hint.png` });
    });
}
