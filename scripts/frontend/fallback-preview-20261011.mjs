import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { familyEntries, weightedEntries } from './fixtures.mjs';

const output = resolve(process.env.FALLBACK_PREVIEW_OUTPUT ?? 'artifacts/fallback-preview-20261011/browser');
const builtRoot = process.env.HOME_BUILT_ROOT;
const builtHTML = builtRoot ? await readFile(join(builtRoot, 'private/home-built.html'), 'utf8') : null;
await mkdir(output, { recursive: true });
const results = [];
const initialRule = { primaryConditionID: 1, familyID: 100, mode: 'ordered',
    entries: familyEntries([{ conditionID: 2 }, { kind: 'other_versions' }, { conditionID: 3 }]) };
const shared = { primaryConditionID: 1, familyID: 101, mode: 'ordered', entries: familyEntries([{ conditionID: 4 }, { conditionID: 5 }]) };
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const ready = page => page.waitForFunction(() => document.querySelector('#model-ranking-status')?.dataset.phase === 'ready'
    && document.querySelectorAll('.bp-model-row').length);
const writes = app => app.state.requests.filter(request => request.path === '/api/save_personal_pie').length;
const order = app => app.state.fallbackRules.find(rule => rule.primaryConditionID === 1)?.entries.map(entry => entry.kind ?? entry.conditionID) ?? [];
async function saved(page, predicate) {
    for (let attempt = 0; attempt < 600 && !predicate(); attempt++) await delay(25);
    assert.ok(predicate(), 'Saved changes must reach the fixture'); await ready(page);
}
async function selectSlice(page, ID) {
    if (await page.locator('button[data-mobile-panel="mix"]').isVisible()) await page.locator('button[data-mobile-panel="mix"]').click();
    await page.locator(`#weight-pie g[data-object-id="${ID}"]`).click();
    const adjustment = page.locator('#pie-adjustment-dismiss');
    if (await adjustment.isVisible() && await adjustment.isEnabled()) await adjustment.click();
}
async function fit(page) {
    const bounds = await page.locator('#inline-fallback-settings').evaluate(node => {
        const box = node.getBoundingClientRect();
        const controls = [...node.querySelectorAll('button')].filter(button => !button.closest('[hidden], [inert]'));
        return { left: box.left, right: box.right, width: innerWidth,
            overflow: document.documentElement.scrollWidth - innerWidth,
            controlOverflow: controls.filter(button => button.scrollWidth > button.clientWidth + 1).map(button => button.id),
            previewHeight: node.querySelector('.bp-fallback-preview-sequence').clientHeight,
            nestedButtons: node.querySelectorAll('button button').length };
    });
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.width + 1, JSON.stringify(bounds));
    assert.ok(bounds.overflow <= 1, JSON.stringify(bounds)); assert.deepEqual(bounds.controlOverflow, []);
    assert.equal(bounds.nestedButtons, 0); assert.ok(bounds.previewHeight <= 244); return bounds;
}

for (const [name, launcher, width] of [['chromium', chromium, 1440], ['chromium', chromium, 1024],
    ['chromium', chromium, 390], ['chromium', chromium, 320], ['webkit', webkit, 1440], ['webkit', webkit, 390]]) {
    if (process.env.UI_TEST_ENGINE && process.env.UI_TEST_ENGINE !== name) continue;
    if (process.env.UI_TEST_WIDTH && Number(process.env.UI_TEST_WIDTH) !== width) continue;
    const browser = await launcher.launch({ headless: true, env });
    const app = await startPreview({ secondaryBenchmark: true, sparseBenchmark: true,
        personalEntries: weightedEntries([{ conditionID: 1, weightBasisPoints: 6000 }, { conditionID: 6, weightBasisPoints: 4000 }]),
        fallbackRules: [structuredClone(initialRule)], families: [structuredClone(initialRule), structuredClone(shared)],
        publicFamilyComposition: [{ primaryConditionID: 1, families: [
            { ...initialRule, weightBasisPoints: 6000, overallWeightBasisPoints: 1560 },
            { ...shared, weightBasisPoints: 4000, overallWeightBasisPoints: 1040 }
        ] }] });
    const context = await browser.newContext({ viewport: { width, height: width < 760 ? 844 : 900 },
        isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'no-preference' });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const preview = page.locator('#inline-fallback-preview');
    const sequence = page.locator('#inline-fallback-preview-sequence');
    const editor = page.locator('#inline-fallback-editor');
    const picker = page.locator('#fallback-picker');
    const edit = page.locator('#inline-fallback-edit'), done = page.locator('#inline-fallback-done');
    const label = `${name}-${width}`;
    try {
        await context.addInitScript(() => {
            localStorage.setItem('benchpoll-workspace-display-v1', 'standard');
            sessionStorage.setItem('benchpoll-workspace-preferences-v1', JSON.stringify({ mode: 'personal', personalFallbackExpanded: true }));
        });
        if (builtHTML) {
            await context.route('**/*', async route => {
                if (route.request().resourceType() !== 'document' || new URL(route.request().url()).pathname !== '/') return route.fallback();
                await route.fulfill({ body: builtHTML, contentType: 'text/html' });
            });
            for (const prefix of ['build/home', 'css', 'js']) await context.route(`**/${prefix}/**`, async route => {
                const path = new URL(route.request().url()).pathname;
                await route.fulfill({ body: await readFile(join(builtRoot, 'public', path)),
                    contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript' });
            });
        }
        await page.goto(app.url, { waitUntil: 'domcontentloaded' }); await ready(page);
        await page.evaluate(() => document.fonts.ready);
        await selectSlice(page, 1); await preview.waitFor();
        assert.equal(await editor.isVisible(), false); assert.equal(await done.isVisible(), false);
        assert.equal(await preview.locator('.bp-family-actions').count(), 0);
        assert.equal(await sequence.locator('.bp-family-member').count(), 3);
        assert.equal(await sequence.locator('.bp-family-order').count(), 0);
        assert.equal(await sequence.locator('.bp-fallback-chain-step').count(), 3);
        assert.equal(await sequence.locator('.fa-chevron-right').count(), 0);
        assert.equal(await sequence.locator('.fa-link').count(), 1);
        assert.equal(await sequence.locator('a').count(), 2);
        assert.ok(!(await sequence.innerText()).includes('General knowledge'), 'Entrance is already in the card heading');
        const initialWrites = writes(app), weights = structuredClone(app.state.personalEntries);
        const browseFit = await fit(page);
        await page.locator('#inline-fallback-settings').screenshot({ path: `${output}/${label}-browse.png` });
        await edit.click(); await editor.waitFor();
        assert.equal(await picker.isVisible(), false); assert.equal(await preview.isVisible(), false);
        assert.equal(writes(app), initialWrites); assert.deepEqual(app.state.personalEntries, weights);
        assert.equal(await page.locator('#inline-fallback-add-benchmark').getAttribute('aria-pressed'), 'false');
        const editorFit = await fit(page);
        await page.locator('#inline-fallback-settings').screenshot({ path: `${output}/${label}-editor.png` });
        await done.click(); await editor.waitFor({ state: 'hidden' });
        assert.equal(writes(app), initialWrites);
        await page.waitForFunction(() => document.activeElement?.id === 'inline-fallback-preview');
        await preview.press('Enter'); await picker.waitFor();
        assert.equal(await picker.locator('.bp-fallback-picker-column').first().locator('strong').first().innerText(), 'Custom');
        assert.equal(await picker.locator('.bp-fallback-picker-customize').isVisible(), true);
        await page.waitForFunction(() => !document.querySelector('#fallback-picker').shadowRoot.querySelector('.dialog-content')
            .getAnimations().some(animation => animation.playState === 'running'));
        const footerOverflow = await picker.locator('.bp-fallback-picker-actions').evaluate(node => {
            const bounds = node.getBoundingClientRect();
            return [...node.querySelectorAll('button:not([hidden])')].filter(button => {
                const box = button.getBoundingClientRect();
                return box.left < bounds.left - 1 || box.right > bounds.right + 1 || button.scrollWidth > button.clientWidth + 1;
            }).map(button => button.className);
        });
        assert.deepEqual(footerOverflow, []);
        await page.screenshot({ path: `${output}/${label}-choose.png` });
        await picker.locator('.bp-fallback-picker-customize').click(); await picker.waitFor({ state: 'hidden' });
        await editor.waitFor(); assert.equal(writes(app), initialWrites);
        assert.deepEqual(order(app), [2, 'other_versions', 3]);
        await page.locator('#inline-fallback-chart [data-family-focus="remove-3"]').click();
        await saved(page, () => order(app).length === 2);
        assert.deepEqual(order(app), [2, 'other_versions']);
        await page.locator('#workspace-undo').click();
        await saved(page, () => order(app).length === 3);
        assert.deepEqual(order(app), [2, 'other_versions', 3]);
        await page.locator('#workspace-redo').click(); await saved(page, () => order(app).length === 2);
        assert.equal(await editor.isVisible(), true, 'Autosave and undo/redo preserve explicit editing');
        assert.deepEqual(app.state.personalEntries, weights);
        await done.click(); await preview.waitFor(); await preview.press('Enter'); await picker.waitFor();
        await picker.locator('[data-family-key="[1,4,5]"] input').check();
        await picker.locator('.bp-fallback-picker-confirm').click(); await picker.waitFor({ state: 'hidden' });
        await saved(page, () => JSON.stringify(order(app)) === '[4,5]');
        assert.equal(await editor.isVisible(), false); assert.deepEqual(app.state.personalEntries, weights);
        const sharedBefore = structuredClone(app.state.families.find(rule => rule.familyID === 101));
        await edit.click();
        await page.locator('#inline-fallback-chart [data-family-focus="down-4"]').click();
        await saved(page, () => JSON.stringify(order(app)) === '[5,4]');
        assert.deepEqual(app.state.families.find(rule => rule.familyID === 101), sharedBefore, 'Editing only changes the personal copy');
        await done.click(); await preview.click(); await picker.waitFor();
        await picker.locator('[data-family-key="[1]"] input').check();
        await picker.locator('.bp-fallback-picker-confirm').click(); await picker.waitFor({ state: 'hidden' });
        await saved(page, () => order(app).length === 0);
        await preview.waitFor(); assert.equal((await sequence.innerText()).trim(), 'No fallback');
        assert.equal(await editor.isVisible(), false);
        await edit.click(); await editor.waitFor(); await fit(page);
        await page.locator('#inline-fallback-add-benchmark').click();
        await page.locator('.bp-benchmark-row:not(.is-family)[data-condition-id="3"] .bp-benchmark-add').click();
        await saved(page, () => JSON.stringify(order(app)) === '[3]');
        assert.deepEqual(app.state.personalEntries, weights);
        if (width < 760) await page.locator('button[data-mobile-panel="mix"]').click();
        await page.locator('#inline-fallback-toggle').click();
        await page.locator('#inline-fallback-settings').waitFor({ state: 'hidden' });
        await page.locator('#inline-fallback-toggle').click(); await preview.waitFor();
        assert.equal(await editor.isVisible(), false, 'Reopening starts with browsing');
        await edit.click(); await selectSlice(page, 6); await preview.waitFor();
        await editor.waitFor({ state: 'hidden' });
        assert.equal(await editor.isVisible(), false, 'Editing does not leak across slices');
        await selectSlice(page, 1); await edit.click();
        await page.locator('#pie-mode-public').click(); await ready(page);
        await page.locator('#pie-mode-personal').click(); await ready(page);
        await selectSlice(page, 1); await preview.waitFor();
        await editor.waitFor({ state: 'hidden' });
        assert.equal(await editor.isVisible(), false, 'Editing does not leak across weight modes');
        const prefs = await page.evaluate(() => JSON.parse(sessionStorage.getItem('benchpoll-workspace-preferences-v1')));
        assert.equal(prefs.personalFallbackExpanded, true); assert.equal(Object.hasOwn(prefs, 'fallbackEditorScope'), false);
        assert.deepEqual(errors, []);
        results.push({ name: label, passed: true, compiled: Boolean(builtRoot), browseFit, editorFit,
            assertions: 'Default browse, Edit/Done, chooser Customize, autosave, undo/redo, immutable shared order, no fallback, no nested fallback, slice and mode reset, layout' });
        console.log(JSON.stringify({ name: label, passed: true }));
    } catch (error) {
        await page.screenshot({ path: `${output}/${label}-failure.png` });
        results.push({ name: label, passed: false, compiled: Boolean(builtRoot), error: error.stack, pageErrors: errors }); throw error;
    } finally {
        await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
        await context.close(); await browser.close(); await app.close();
    }
}
