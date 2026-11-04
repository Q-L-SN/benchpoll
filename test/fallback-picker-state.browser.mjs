import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

let browser, bundle;
const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
before(async () => {
    const global = await read('public/js/global.js');
    // Exercise the real dialog lifecycle without starting the workspace or a server.
    const dialogStart = global.indexOf('const openDialogs = [];');
    const dialogEnd = global.indexOf('class globalDialogAction', dialogStart);
    assert.ok(dialogStart >= 0 && dialogEnd > dialogStart, 'The fixture must extract the complete dialog implementation');
    const dialogs = global.slice(dialogStart, dialogEnd);
    const result = await build({ stdin: { resolveDir: root, contents: `
        import { createFallbackPicker } from './public/js/workspace/fallback-picker.js';
        import { createFamilyView } from './public/js/workspace/family-view.js';
        import { handleCustomSelectKeydown } from './public/js/shared/ui-components.js';
        import './public/js/shared/help-popover.js?v=help-popovers-20261008';
        ${dialogs}
        customElements.define('global-dialog', globalDialog);
        globalThis.setupFallbackReview = () => {
            const primary = { ID: 1, conditionID: 1, benchmarkID: 101, name: 'Entrance', conditionName: 'Default' };
            const member = ID => ({ conditionID: ID, benchmarkID: 100 + ID, name: 'Benchmark ' + ID, conditionName: 'Default' });
            const state = {
                current: { familyID: 10, entries: [member(2), member(3)] }, inspected: [], mutations: [],
                catalogue: { featured: [
                    { familyID: 10, familyEntries: [member(2), member(3)] },
                    { familyID: 11, familyEntries: [member(4), member(2)] }
                ], items: [], loaded: true, hasMore: false }
            };
            const composition = { configuredPieCount: 3, families: [
                { familyID: 10, entries: [member(2), member(3)], weightBasisPoints: 6000 },
                { familyID: 11, entries: [member(4), member(2)], weightBasisPoints: 3000 },
                { entries: [], weightBasisPoints: 1000 }
            ] };
            const getMemberURL = member => '/benchmarks/' + (member.conditionID ?? member.ID);
            const inlineFallbackChart = document.getElementById('chain');
            const inlineFallbackToggle = document.getElementById('inline-fallback-toggle');
            const picker = createFallbackPicker({
                catalogue: { view: () => state.catalogue, load() {} },
                getScope: () => 'fixture-context', getPrimary: () => primary, getComposition: () => composition,
                getCurrent: () => state.current, canApply: () => true, getMemberURL,
                onApply: (primary, choice, action) => {
                    state.mutations.push({ primaryID: primary.ID, action, community: choice.community === true,
                        conditionIDs: choice.entries.map(entry => entry.conditionID) });
                    state.current = choice.community ? null : { familyID: choice.familyID, entries: choice.entries };
                    return true;
                },
                onCustomize: () => { state.mutations.push('customize'); return true; },
                onInspectVersion: event => { event.preventDefault(); state.inspected.push(event.currentTarget.getAttribute('href')); }
            });
            const family = createFamilyView({ container: inlineFallbackChart, getMemberURL,
                onMove: (...args) => { state.mutations.push(args); }, onRemove() {} });
            inlineFallbackToggle.addEventListener('click', () => picker.open(primary,
                { action: 'replace', getReturnFocus: () => inlineFallbackToggle }));
            state.refreshCatalogue = () => {
                state.catalogue.items.push({ familyID: 12, familyEntries: [member(5)] },
                    { familyID: 13, familyEntries: [member(4), member(2)] });
                picker.refresh();
            };
            state.render = change => family.renderPersonal({ primary, entries: [member(2), member(3)], active: true, disabled: false, ...change });
            globalThis.review = state;
        };
    ` }, bundle: true, format: 'iife', write: false, logLevel: 'silent' });
    bundle = result.outputFiles[0].text;
    browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); });

async function pageFor(t) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await page.close(); assert.deepEqual(errors, [], 'The browser fixture must not raise runtime errors'); });
    await page.route('**/*', route => route.abort());
    await page.setContent('<button id="inline-fallback-toggle">Fallback</button><div id="chain"></div>');
    await page.addStyleTag({ content: await read('public/css/global.css') });
    for (const path of ['tokens', 'components', 'tooltip', 'fallback', 'fallback-picker']) {
        await page.addStyleTag({ content: await read(`public/css/ui/${path}.css`) });
    }
    await page.addScriptTag({ content: bundle });
    await page.evaluate(() => globalThis.setupFallbackReview());
    return page;
}

async function waitForReturnFocus(page) {
    await page.waitForFunction(() => document.getElementById('fallback-picker').hidden
        && document.activeElement === document.getElementById('inline-fallback-toggle'));
}

test('reopening moves the chosen configuration first and keeps remaining community shares descending', async t => {
    const page = await pageFor(t);
    await page.locator('#inline-fallback-toggle').click();
    const keys = () => page.locator('.bp-fallback-picker-column').evaluateAll(nodes => nodes.map(node => node.dataset.familyKey));
    assert.deepEqual(await keys(), ['[1,2,3]', '[1,4,2]', '[1]']);
    await page.locator('[data-family-key="[1,4,2]"] .bp-fallback-picker-card-toggle').click();
    assert.deepEqual(await keys(), ['[1,2,3]', '[1,4,2]', '[1]'], 'selection does not move cards under the pointer');
    await page.locator('.bp-fallback-picker-cancel').click();
    await page.locator('#inline-fallback-toggle').click();
    assert.deepEqual(await keys(), ['[1,4,2]', '[1,2,3]', '[1]']);
    assert.equal(await page.locator('.bp-fallback-picker-viewport').evaluate(node => node.scrollLeft), 0);
});

test('concrete fallback chains are ordered, deduplicated, and applied directly from their cards', async t => {
    const page = await pageFor(t);
    await page.getByRole('button', { name: 'Fallback', exact: true }).click();
    assert.equal(await page.getByRole('list', { name: 'Fallback orders', exact: true }).count(), 1);
    assert.equal(await page.getByRole('radio').count(), 0);
    assert.equal(await page.locator('.bp-fallback-picker-column').count(), 3);
    const current = page.locator('.bp-fallback-picker-column[data-family-key="[1,2,3]"]');
    const alternative = page.locator('.bp-fallback-picker-column[data-family-key="[1,4,2]"]');
    assert.equal(await current.getByRole('button').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await current.locator('.bp-fallback-picker-steps a').evaluateAll(links => links.map(link => link.getAttribute('href'))),
        ['/benchmarks/1', '/benchmarks/2', '/benchmarks/3']);
    assert.deepEqual(await alternative.locator('.bp-fallback-picker-steps a').evaluateAll(links => links.map(link => link.getAttribute('href'))),
        ['/benchmarks/1', '/benchmarks/4', '/benchmarks/2']);
    assert.equal(await page.locator('.bp-auto-version-button, .bp-fallback-picker-card-add').count(), 0);
    assert.deepEqual(await page.evaluate(() => ({ mutations: review.mutations, current: review.current.entries.map(entry => entry.conditionID) })),
        { mutations: [], current: [2, 3] });
    await alternative.getByRole('button').click();
    assert.equal(await alternative.getByRole('button').getAttribute('aria-pressed'), 'true');
    assert.equal(await current.getByRole('button').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#fallback-picker').isVisible(), true);
    assert.deepEqual(await page.evaluate(() => ({ mutations: review.mutations, current: review.current.entries.map(entry => entry.conditionID) })),
        { mutations: [{ primaryID: 1, action: 'replace', community: false, conditionIDs: [4, 2] }], current: [4, 2] });
});

test('following community and explicitly choosing no fallback remain distinct choices', async t => {
    const page = await pageFor(t);
    await page.evaluate(() => { review.current = null; });
    await page.getByRole('button', { name: 'Fallback', exact: true }).click();
    const summary = page.locator('.bp-fallback-picker-selection-status');
    const noneColumn = page.locator('.bp-fallback-picker-column[data-family-key="[1]"]');
    const none = noneColumn.getByRole('button');
    assert.equal(await summary.getAttribute('data-selection'), 'community');
    assert.equal(await page.locator('.bp-fallback-picker-column[data-family-key="community"]').count(), 0);
    assert.equal(await none.getAttribute('aria-pressed'), 'false');
    assert.equal(await noneColumn.locator('.bp-fallback-picker-share strong').textContent(), '10%');
    assert.deepEqual(await noneColumn.locator('.bp-fallback-picker-steps a').evaluateAll(links => links.map(link => link.getAttribute('href'))),
        ['/benchmarks/1']);
    await none.click();
    assert.equal(await summary.getAttribute('data-selection'), 'manual');
    assert.deepEqual(await page.evaluate(() => review.current.entries), []);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await waitForReturnFocus(page);
    await page.getByRole('button', { name: 'Fallback', exact: true }).click();
    assert.equal(await none.getAttribute('aria-pressed'), 'true');
    await none.click();
    assert.equal(await none.getAttribute('aria-pressed'), 'false');
    assert.equal(await summary.getAttribute('data-selection'), 'community');
    assert.deepEqual(await page.evaluate(() => ({ current: review.current, mutations: review.mutations })), { current: null, mutations: [
        { primaryID: 1, action: 'replace', community: false, conditionIDs: [] },
        { primaryID: 1, action: 'replace', community: true, conditionIDs: [] }
    ] });
});

test('a real captured pointer cannot commit after a same-entrance disabled rerender', async t => {
    const page = await pageFor(t);
    await page.evaluate(() => review.render());
    const handle = page.locator('#chain .bp-family-drag').first();
    await handle.evaluate(node => node.addEventListener('pointerdown', event => { review.pointerID = event.pointerId; }, { once: true }));
    const box = await handle.boundingBox(); assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x + box.width / 2, box.y + box.height + 40);
    assert.equal(await handle.evaluate(node => node.hasPointerCapture(review.pointerID)), true);
    await page.evaluate(() => { review.oldHandle = document.querySelector('#chain .bp-family-drag'); review.render({ disabled: true }); });
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => ({ replaced: review.oldHandle !== document.querySelector('#chain .bp-family-drag'),
        captured: review.oldHandle.hasPointerCapture(review.pointerID),
        disabled: [...document.querySelectorAll('#chain button')].every(button => button.disabled), mutations: review.mutations.length })),
    { replaced: true, captured: false, disabled: true, mutations: 0 });
});

test('catalogue refresh preserves card focus and selection while closing does not add a choice', async t => {
    const page = await pageFor(t);
    await page.getByRole('button', { name: 'Fallback', exact: true }).click();
    const alternative = page.locator('.bp-fallback-picker-column[data-family-key="[1,4,2]"] button');
    await alternative.focus();
    await page.evaluate(() => { review.previousButton = document.activeElement; review.refreshCatalogue(); });
    assert.equal(await page.locator('.bp-fallback-picker-column').count(), 4, 'A duplicate catalogue chain must not create another choice');
    assert.equal(await page.evaluate(() => review.previousButton.isConnected), false, 'The refresh must really replace the focused node');
    assert.equal(await alternative.evaluate(node => node === document.activeElement), true);
    assert.equal(await alternative.getAttribute('aria-pressed'), 'false');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await waitForReturnFocus(page);
    assert.deepEqual(await page.evaluate(() => ({ mutations: review.mutations, current: review.current.entries.map(entry => entry.conditionID) })),
        { mutations: [], current: [2, 3] });
    await page.getByRole('button', { name: 'Fallback', exact: true }).click();
    assert.equal(await page.locator('.bp-fallback-picker-column[data-family-key="[1,2,3]"] button').getAttribute('aria-pressed'), 'true');
    assert.equal(await alternative.getAttribute('aria-pressed'), 'false');
});

test('Escape dismisses the shared help layer before cancelling the chooser and restoring focus', async t => {
    const page = await pageFor(t);
    await page.getByRole('button', { name: 'Fallback', exact: true }).click();
    await page.getByRole('button', { name: 'About fallback configuration shares', exact: true }).click();
    const tooltip = page.getByRole('tooltip');
    await tooltip.waitFor();
    assert.match(await tooltip.textContent(), /Leave the choice open to follow those shares\. Choosing No fallback counts as a preference/);
    await page.keyboard.press('Escape');
    await tooltip.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#fallback-picker').isVisible(), true);
    assert.equal(await page.locator('.bp-fallback-picker-column[data-family-key="[1,2,3]"] button').getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Escape');
    await waitForReturnFocus(page);
    assert.deepEqual(await page.evaluate(() => ({ mutations: review.mutations, current: review.current.entries.map(entry => entry.conditionID) })),
        { mutations: [], current: [2, 3] });
});

test('inspecting a concrete backup closes the chooser without adopting its selected chain', async t => {
    const page = await pageFor(t);
    await page.getByRole('button', { name: 'Fallback', exact: true }).click();
    await page.getByRole('link', { name: 'Information and discussion for Benchmark 4', exact: true }).click();
    await page.locator('#fallback-picker').waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => ({ inspected: review.inspected, mutations: review.mutations,
        current: review.current.entries.map(entry => entry.conditionID) })),
    { inspected: ['/benchmarks/4'], mutations: [], current: [2, 3] });
});
