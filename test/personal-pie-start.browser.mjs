import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
import { familyEntries } from '../scripts/frontend/fixtures.mjs';

const built = process.env.BP_TEST_BUILT === '1';
const output = 'artifacts/personal-pie-start-20261104';
await mkdir(output, { recursive: true });
async function setup(t, engine, width, options = {}) {
    const fixture = await startPreview({ communityVersions: true, ...options });
    const browser = await engine.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await browser.close(); await fixture.close(); assert.deepEqual(errors, []); });
    await page.addInitScript(() => localStorage.setItem('benchpoll:config-sidebar-collapsed', 'true'));
    if (built) await page.route(fixture.url + '/', async route => route.fulfill({ contentType: 'text/html', body: await readFile('private/home-built.html', 'utf8') }));
    await page.goto(fixture.url);
    await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
    const settled = () => page.waitForFunction(() => document.getElementById('model-card').getAttribute('aria-busy') === 'false');
    const saves = () => fixture.state.requests.filter(request => request.path === '/api/save_personal_pie');
    const save = async action => {
        await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie') && response.status() === 200), action()]);
        await settled();
    };
    return { fixture, page, save, saves, settled, overlay: page.locator('#personal-pie-start') };
}

for (const [engine, width] of built ? [[chromium, 390], [webkit, 390]] : [[chromium, 1440], [chromium, 320], [webkit, 390]]) {
    test(`personal weight starting points ${engine.name()} ${width} ${built ? 'built' : 'source'}`, async t => {
        const { fixture, page, save, saves, overlay } = await setup(t, engine, width, { personalEntries: [] });
        await page.locator('#personal-pie-create').click();
        await overlay.locator('#personal-pie-start-public').waitFor();
        assert.equal(await overlay.getAttribute('data-step'), 'choose');
        assert.equal(saves().length, 0, 'Opening the chooser creates no weights');
        const layout = await overlay.evaluate(root => {
            const bounds = root.getBoundingClientRect(), buttons = [...root.querySelectorAll('.bp-pie-start-choices:not([hidden]) > button')].map(node => node.getBoundingClientRect());
            return { insideStage: root.parentElement.classList.contains('bp-pie-stage'), top: buttons[0].toJSON(), bottom: buttons[1].toJSON(), bounds: bounds.toJSON(),
                inert: root.parentElement.querySelector('.bp-pie-start-background').inert };
        });
        assert.ok(layout.insideStage && layout.inert);
        assert.ok(layout.top.bottom < layout.bottom.top && Math.abs(layout.top.x + layout.top.width / 2 - (layout.bounds.x + layout.bounds.width / 2)) < 2, JSON.stringify(layout));
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-choose-${built ? 'built' : 'source'}.png` });
        await save(() => overlay.getByRole('button', { name: 'From public weights', exact: true }).click());
        assert.equal(await overlay.isVisible(), false);
        assert.ok(fixture.state.personalEntries.length > 1);
        assert.ok(fixture.state.personalEntries.every(entry => entry.followCommunityVersion));
        assert.equal(fixture.state.personalEntries.reduce((sum, entry) => sum + entry.weightBasisPoints, 0), 10000);
        assert.deepEqual(fixture.state.fallbackRules, []);
        const before = structuredClone(fixture.state.personalEntries);
        await page.reload();
        await page.locator('#pie-mode-personal[aria-selected="true"]').waitFor();
        await page.waitForFunction(count => document.querySelectorAll('#weight-pie > g[data-object-id]').length === count, before.length);
        const undo = await page.locator('#workspace-undo').boundingBox(), reset = await page.locator('#workspace-reset').boundingBox();
        assert.ok(reset.x >= undo.x + undo.width, 'Reset sits to the right of Undo');
        await page.locator('#workspace-reset').click();
        await overlay.getByRole('button', { name: 'From blank', exact: true }).click();
        assert.equal(await overlay.getAttribute('data-step'), 'confirm');
        assert.equal(saves().length, 1, 'Choosing a reset source does not discard anything');
        assert.deepEqual(fixture.state.personalEntries, before);
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-confirm-${built ? 'built' : 'source'}.png` });
        await overlay.getByRole('button', { name: 'Keep my weights', exact: true }).click();
        assert.equal(await overlay.isVisible(), false); assert.deepEqual(fixture.state.personalEntries, before);
        await page.locator('#workspace-reset').click();
        await overlay.getByRole('button', { name: 'From blank', exact: true }).click();
        await save(() => overlay.locator('#personal-pie-start-confirm').click());
        assert.deepEqual(fixture.state.personalEntries, []); assert.deepEqual(fixture.state.fallbackRules, []);
        await save(() => page.locator('#workspace-undo').click());
        assert.deepEqual(fixture.state.personalEntries, before, 'The reset is one undoable edit');
        if (width < 760) {
            for (const name of ['models', 'discussion', 'mix']) {
                await page.locator(`button[data-mobile-panel="${name}"]`).click();
                await page.waitForFunction(name => document.querySelector('.bp-workspace').dataset.mobilePanel === name
                    && [...document.querySelectorAll('#workspace-undo, #workspace-reset')].every(button => button.inert === (name !== 'mix')), name);
                const controls = await page.locator('#workspace-undo, #workspace-reset').evaluateAll(nodes => nodes.map(node => ({
                    width: node.getBoundingClientRect().width, opacity: getComputedStyle(node).opacity, visibility: getComputedStyle(node).visibility
                })));
                assert.deepEqual(controls[0], controls[1], 'Undo and Reset use the same collapse/opacity progress');
                assert.equal(controls[0].width, name === 'mix' ? 44 : 0);
            }
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    });
}

test('resetting removes version/fallback choices only after confirmation and Undo restores them', async t => {
    const rules = [{ primaryConditionID: 1, mode: 'ordered', selectionSource: 'custom', entries: familyEntries([{ conditionID: 2 }, { conditionID: 3 }]) }];
    const { fixture, page, save, saves, overlay } = await setup(t, chromium, 1440, { fallbackRules: rules });
    await page.locator('#pie-mode-personal').click();
    const original = structuredClone(fixture.state.personalEntries);
    await page.locator('#workspace-reset').click();
    await overlay.getByRole('button', { name: 'From public weights', exact: true }).click();
    assert.equal(saves().length, 0); assert.deepEqual(fixture.state.fallbackRules, rules);
    await page.locator('#pie-mode-public').click();
    await overlay.waitFor({ state: 'hidden' });
    assert.equal(saves().length, 0, 'Leaving the editor cancels a pending reset');
    await page.locator('#pie-mode-personal').click();
    await page.locator('#workspace-reset').click();
    await overlay.getByRole('button', { name: 'From public weights', exact: true }).click();
    await save(() => overlay.locator('#personal-pie-start-confirm').click());
    assert.deepEqual(fixture.state.fallbackRules, []);
    assert.ok(fixture.state.personalEntries.every(entry => entry.followCommunityVersion === true));
    await save(() => page.locator('#workspace-undo').click());
    assert.deepEqual(fixture.state.personalEntries, original);
    const choices = rows => rows.map(row => ({ primaryConditionID: row.primaryConditionID, mode: row.mode,
        selectionSource: row.selectionSource, entries: row.entries.map(entry => entry.conditionID) }));
    assert.deepEqual(choices(fixture.state.fallbackRules), choices(rules));
    await save(() => page.locator('#workspace-redo').click());
    assert.deepEqual(fixture.state.fallbackRules, []);
});

test('empty public weights keep the chooser visible on mobile and allow a blank start without saving', async t => {
    const { page, saves, overlay } = await setup(t, chromium, 320, { personalEntries: [], publicWeights: [] });
    await page.locator('#pie-empty-compact-action').click();
    await overlay.waitFor();
    assert.equal(await overlay.locator('#personal-pie-start-public').isDisabled(), true);
    assert.match(await overlay.innerText(), /No public weights/);
    await overlay.getByRole('button', { name: 'From blank', exact: true }).click();
    assert.equal(await overlay.isVisible(), false);
    assert.equal(await page.locator('#pie-mode-personal').getAttribute('aria-selected'), 'true');
    assert.equal(saves().length, 0);
});

test('guest public starts stay drafts and resetting to blank never calls the save endpoint', async t => {
    const { fixture, page, saves, overlay, settled } = await setup(t, chromium, 390, { authenticated: false, personalEntries: [] });
    await page.locator('#personal-pie-create').click();
    await overlay.locator('#personal-pie-start-public').click();
    await settled();
    await page.waitForFunction(() => document.querySelectorAll('#weight-pie > g[data-object-id]').length > 1);
    assert.equal(saves().length, 0);
    assert.ok(fixture.state.requests.some(request => request.path === '/api/get_weighted_workspace' && request.body.previewPersonalPie?.entries.length));
    await page.locator('#workspace-reset').click();
    await overlay.locator('#personal-pie-start-blank').click();
    await overlay.locator('#personal-pie-start-confirm').click();
    await settled();
    assert.equal(await page.locator('#weight-pie > g[data-object-id]').count(), 0);
    assert.equal(saves().length, 0);
});

test('private topics keep public starting weights unavailable', async t => {
    const { page, saves, overlay } = await setup(t, webkit, 390, { isPrivate: true });
    await page.locator('#workspace-reset').click();
    assert.equal(await overlay.locator('#personal-pie-start-public').isDisabled(), true);
    assert.match(await overlay.innerText(), /unavailable for private topics/);
    await overlay.locator('#personal-pie-start-blank').click();
    await overlay.getByRole('button', { name: 'Keep my weights' }).click();
    assert.equal(saves().length, 0);
});

test('a refreshed saved revision cancels an old reset confirmation', async t => {
    const { fixture, page, overlay, saves, settled } = await setup(t, chromium, 1440);
    await page.locator('#pie-mode-personal').click();
    await page.locator('#workspace-reset').click();
    await overlay.locator('#personal-pie-start-blank').click();
    fixture.state.revision++;
    await page.locator('#workspace-refresh').click();
    await settled();
    await overlay.waitFor({ state: 'hidden' });
    assert.ok(fixture.state.personalEntries.length > 0);
    assert.equal(saves().length, 0, 'An obsolete confirmation never replaces refreshed weights');
});

test('mobile Reset and Undo shrink together while the finger is still moving', async t => {
    const { page, saves } = await setup(t, chromium, 390);
    await page.locator('#pie-mode-personal').click();
    await page.locator('#workspace-reset').waitFor();
    const box = await page.locator('#weight-pie').boundingBox();
    const x = box.x + box.width - 30, y = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);
    const send = (type, dx = 0) => cdp.send('Input.dispatchTouchEvent', { type,
        touchPoints: type === 'touchEnd' ? [] : [{ x: x - dx, y, id: 1 }] });
    await send('touchStart');
    for (let step = 1; step <= 7; step++) {
        await send('touchMove', step * 34); await page.waitForTimeout(35);
        if (step === 4) {
            const controls = await page.locator('#workspace-undo, #workspace-reset').evaluateAll(nodes => nodes.map(node => ({
                width: node.getBoundingClientRect().width, opacity: Number(getComputedStyle(node).opacity)
            })));
            assert.deepEqual(controls[0], controls[1]);
            assert.ok(controls[0].width > 0 && controls[0].width < 44 && controls[0].opacity > 0 && controls[0].opacity < 1, JSON.stringify(controls));
        }
    }
    await send('touchEnd');
    await page.waitForFunction(() => document.querySelector('.bp-workspace').dataset.mobilePanel === 'models');
    assert.equal(saves().length, 0);
    await cdp.detach();
});
