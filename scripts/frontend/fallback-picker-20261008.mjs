import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { familyEntries, weightedEntries } from './fixtures.mjs';

const liveURL = process.env.FALLBACK_PICKER_URL;
const builtRoot = process.env.HOME_BUILT_ROOT;
const builtHTML = builtRoot ? await readFile(join(builtRoot, 'home-built.html'), 'utf8') : null;
const stage = process.env.FALLBACK_PICKER_STAGE ? resolve(process.env.FALLBACK_PICKER_STAGE) : null;
const manifest = stage ? JSON.parse(await readFile(join(stage, 'manifest.json'), 'utf8')) : null;
assert.ok(!stage || liveURL, 'Verify staged files against the installed dependency versions');
const output = resolve(process.env.FALLBACK_PICKER_OUTPUT ?? `artifacts/fallback-picker-20261008/browser${stage ? '-staged' : liveURL ? '-live' : ''}`);
await mkdir(output, { recursive: true });
const results = [];
const primaryID = 1;
const orders = [[2], [3], [4], [5], [6], [7], [8], [{ kind: 'other_versions' }, 2, 3, 4, 5, 6, 7, 8],
    [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2], [2, 3]];
const rules = orders.map((IDs, index) => ({ primaryConditionID: primaryID, familyID: 100 + index, mode: 'ordered',
    entries: familyEntries(IDs.map(value => typeof value === 'number' ? { conditionID: value } : value)) }));
const composition = [{ primaryConditionID: primaryID, families: [
    ...rules.slice(0, 8).map(rule => ({ ...rule, weightBasisPoints: 1000, overallWeightBasisPoints: 260 })),
    { primaryConditionID: primaryID, familyID: null, entries: [], weightBasisPoints: 2000, overallWeightBasisPoints: 520 }
] }, { primaryConditionID: 4, families: [
    { primaryConditionID: 4, familyID: 200, mode: 'ordered', entries: familyEntries([{ conditionID: 5 }], 4), weightBasisPoints: 300, overallWeightBasisPoints: 42 },
    { primaryConditionID: 4, familyID: 201, mode: 'ordered', entries: familyEntries([{ conditionID: 6 }], 4), weightBasisPoints: 200, overallWeightBasisPoints: 28 },
    { primaryConditionID: 4, familyID: null, entries: [], weightBasisPoints: 9500, overallWeightBasisPoints: 1330 }
] }];
const coldRules = composition[1].families.filter(rule => rule.entries.length);
const initialEntries = () => weightedEntries([{ conditionID: 2, weightBasisPoints: 5000 }, { conditionID: 3, weightBasisPoints: 5000 }]);
const row = (page, ID) => page.locator(`.bp-benchmark-row:not(.is-family)[data-condition-id="${ID}"]`);
const picker = page => page.locator('#fallback-picker');
const column = (page, key) => picker(page).locator(`.bp-fallback-picker-column[data-family-key='${key}']`);
const confirm = page => picker(page).locator('.bp-fallback-picker-confirm');
const saveCount = app => app.state.requests.filter(request => request.path === '/api/save_personal_pie').length;
const weights = app => app.state.personalEntries.map(entry => [entry.conditionID, entry.weightBasisPoints]).sort((a, b) => a[0] - b[0]);
async function toastFits(page) {
    await page.waitForFunction(() => {
        const toast = document.querySelector('.bp-toast.is-visible')?.getBoundingClientRect();
        const hint = document.getElementById('pie-adjustment-status')?.getBoundingClientRect();
        return toast && toast.left >= 0 && toast.right <= innerWidth && toast.top >= 0
            && (!hint?.height || toast.bottom <= hint.top - 2);
    });
}
async function saved(page, predicate) {
    for (let attempt = 0; attempt < 600 && !predicate(); attempt++) await delay(25);
    assert.ok(predicate(), 'Expected isolated Pie save reached the fixture');
    await ready(page);
}
async function ready(page) {
    await page.waitForFunction(() => document.getElementById('model-ranking-status')?.dataset.phase === 'ready'
        && document.querySelectorAll('.bp-model-row').length > 0);
    await page.evaluate(() => document.fonts.ready);
}
async function choose(page, key) {
    await column(page, key).locator('input').check();
    assert.equal(await column(page, key).locator('input').isChecked(), true);
    const border = await column(page, key).evaluate(node => {
        const css = getComputedStyle(node);
        return ['Top', 'Right', 'Bottom', 'Left'].map(side => [css[`border${side}Width`], css[`border${side}Color`]]);
    });
    assert.ok(border.every(([width, color]) => width === '1px' && color === border[0][1]), JSON.stringify(border));
}
async function openFromEditor(page) {
    if (await page.locator('#inline-fallback-done').isVisible()) await page.locator('#inline-fallback-done').click();
    const adjustment = page.locator('#pie-adjustment-dismiss');
    if (await adjustment.isVisible()) await adjustment.click();
    const control = page.locator('#inline-fallback-preview');
    if (!await control.isVisible()) await page.locator('#inline-fallback-toggle').click();
    await control.press('Enter'); await picker(page).waitFor();
}
async function fit(page, mobile) {
    await page.waitForFunction(() => !document.getElementById('fallback-picker').shadowRoot.querySelector('.dialog-content')
        .getAnimations().some(animation => animation.playState === 'running'));
    const bounds = await picker(page).evaluate(dialog => {
        const content = dialog.shadowRoot.querySelector('.dialog-content').getBoundingClientRect();
        const view = dialog.querySelector('.bp-fallback-picker-viewport');
        const actions = dialog.querySelector('.bp-fallback-picker-actions').getBoundingClientRect();
        const radio = dialog.querySelector('input').getBoundingClientRect();
        const columns = [...dialog.querySelectorAll('.bp-fallback-picker-column')];
        return { x: content.x, right: content.right, y: content.y, bottom: content.bottom,
            width: innerWidth, height: innerHeight, actionBottom: actions.bottom, radioY: radio.y,
            pageOverflow: document.documentElement.scrollWidth - innerWidth,
            horizontal: view.scrollWidth - view.clientWidth, vertical: view.scrollHeight - view.clientHeight,
            count: columns.length, visibleColumns: (view.clientWidth + Number.parseFloat(getComputedStyle(columns[0].parentNode).gap))
                / (columns[0].getBoundingClientRect().width + Number.parseFloat(getComputedStyle(columns[0].parentNode).gap)),
            radii: columns.map(node => getComputedStyle(node).borderRadius) };
    });
    assert.ok(bounds.x >= 15 && bounds.right <= bounds.width - 15, JSON.stringify(bounds));
    assert.ok(bounds.y >= 15 && bounds.bottom <= bounds.height - 15, JSON.stringify(bounds));
    assert.ok(bounds.actionBottom <= bounds.bottom && bounds.radioY >= bounds.y, JSON.stringify(bounds));
    assert.ok(bounds.pageOverflow <= 1, JSON.stringify(bounds));
    assert.ok(bounds.radii.every(value => value === '4px'));
    if (mobile) assert.ok(bounds.visibleColumns >= 1.2 && bounds.visibleColumns <= 1.7, JSON.stringify(bounds));
    return bounds;
}

const cases = [['chromium', chromium, 1440, 900], ['chromium', chromium, 1024, 800],
    ['chromium', chromium, 390, 844], ['chromium', chromium, 320, 568],
    ['webkit', webkit, 1440, 900], ['webkit', webkit, 390, 844], ['webkit', webkit, 320, 568],
    ['chromium', chromium, 1440, 900, 'reduce']];
for (const [engine, launcher, width, height, reduced] of cases) {
    if (process.env.UI_TEST_ENGINE && process.env.UI_TEST_ENGINE !== engine) continue;
    if (process.env.UI_TEST_WIDTH && !process.env.UI_TEST_WIDTH.split(',').map(Number).includes(width)) continue;
    const name = `${engine}-${width}${reduced ? '-reduce' : ''}`;
    const mobile = width < 760;
    const browser = await launcher.launch({ headless: true, env: { ...process.env,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    const app = await startPreview({ secondaryBenchmark: true, sparseBenchmark: true,
        personalEntries: initialEntries(), families: structuredClone([...rules, ...coldRules]), publicFamilyComposition: structuredClone(composition) });
    const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile,
        reducedMotion: reduced ?? 'no-preference',
        ignoreHTTPSErrors: Boolean(liveURL && ['localhost', '127.0.0.1'].includes(new URL(liveURL).hostname)) });
    const page = await context.newPage(); page.setDefaultTimeout(liveURL ? 60000 : 15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let failPage = false, expirePage = false;
    try {
        await context.addInitScript(() => localStorage.setItem('benchpoll-workspace-display-v1', 'standard'));
        if (builtHTML) {
            await context.route('**/*', async route => {
                if (route.request().resourceType() !== 'document') return route.fallback();
                const path = new URL(route.request().url()).pathname;
                if (path !== '/' && path !== new URL(liveURL ?? app.url).pathname) return route.fallback();
                await route.fulfill({ body: builtHTML, contentType: 'text/html' });
            });
            for (const prefix of ['build/home']) await context.route(`**/${prefix}/**`, async route => {
                const path = new URL(route.request().url()).pathname;
                await route.fulfill({ body: await readFile(join(builtRoot, path)),
                    contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript' });
            });
        }
        if (stage) await context.route('**/*', async route => {
            const path = new URL(route.request().url()).pathname;
            const target = path === new URL(liveURL).pathname ? 'private/home.html' : 'public' + path;
            if (route.request().method() !== 'GET' || !manifest.files.some(file => file.path === target)) { await route.fallback(); return; }
            const contentType = target.endsWith('.html') ? 'text/html' : target.endsWith('.css') ? 'text/css' : 'application/javascript';
            await route.fulfill({ status: 200, contentType, body: await readFile(join(stage, target)) });
        });
        await context.route('**/api/**', async route => {
            const url = new URL(route.request().url()); const request = route.request().postDataJSON();
            if (url.pathname === '/api/get_ranking_page' && request.list === 'fallbacks' && failPage) {
                failPage = false; await route.fulfill({ status: 503, json: { error: 'fixture_fallback_failure' } }); return;
            }
            if (url.pathname === '/api/get_ranking_page' && request.list === 'fallbacks' && expirePage) {
                expirePage = false; await route.fulfill({ status: 410, json: { error: 'ranking_snapshot_expired' } }); return;
            }
            const response = await route.fetch({ url: app.url + url.pathname + url.search });
            if (['/api/get_weighted_workspace', '/api/get_ranking_page'].includes(url.pathname) && response.ok()) {
                const payload = await response.json();
                const stretch = entry => {
                    if (entry.familyID !== 107) return;
                    for (const member of entry.familyEntries ?? []) {
                        if (member.kind) continue;
                        member.isDefaultCondition = false; member.conditionKey = 'extended';
                        member.conditionName = 'Extended protocol with a fixed answer format and tool execution disabled';
                    }
                };
                for (const entry of payload.benchmarks ?? []) for (const family of entry.featuredFallbackConfigurations ?? []) stretch(family);
                for (const family of payload.featuredFallbackConfigurations ?? []) stretch(family);
                await route.fulfill({ response, json: payload });
            } else await route.fulfill({ response });
        });
        for (let attempt = 0; ; attempt++) {
            try { await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded' }); break; }
            catch (error) {
                if (!liveURL || attempt || error.name !== 'TimeoutError' || saveCount(app)) throw error;
                await page.screenshot({ path: `${output}/${name}-navigation-timeout.png` });
                console.log(JSON.stringify({ name, navigationRetry: true }));
            }
        }
        await ready(page);
        assert.equal(await page.locator('.bp-benchmark-row.is-family, .bp-benchmark-fallbacks, .bp-benchmark-direct-add').count(), 0);
        await page.locator('#pie-mode-personal').click(); await ready(page);
        const beforeAdd = weights(app), writes = saveCount(app);
        await row(page, 1).locator('.bp-benchmark-add').click(); await picker(page).waitFor();
        await page.waitForFunction(() => !document.querySelector('.bp-fallback-picker-more').disabled);
        assert.equal(saveCount(app), writes); assert.deepEqual(weights(app), beforeAdd);
        assert.equal(await picker(page).locator('.bp-fallback-picker-heading > span').innerText(),
            'If a model has no score on this benchmark version, what should we try next?');
        assert.equal(await picker(page).locator('.bp-fallback-picker-question').innerText(), 'General knowledge');
        assert.equal(await column(page, '[1,2]').locator('.bp-fallback-picker-share').innerText(), '10%\nPublic share');
        assert.equal(await column(page, '[1]').count(), 0);
        assert.equal(await picker(page).getByText('Custom', { exact: true }).count(), 0);
        const customAdd = picker(page).locator('.bp-fallback-picker-custom-add');
        assert.equal(await customAdd.innerText(), 'Skip fallback or create my own (not recommended)');
        assert.equal(await customAdd.getAttribute('data-ui-variant'), 'quiet');
        assert.equal(await page.locator('.bp-toast.is-visible').count(), 0);
        assert.equal(await confirm(page).isDisabled(), true);
        const sequence = await fit(page, mobile);
        if (!mobile) { assert.ok(sequence.horizontal > 1); assert.ok(sequence.visibleColumns >= 4 && sequence.visibleColumns <= 5.1); }
        assert.equal(await picker(page).locator('.bp-fallback-picker-layouts').count(), 0);
        await page.screenshot({ path: `${output}/${name}-sequence.png` });
        await picker(page).locator('.bp-auto-version-button').click();
        await page.locator('#version-group-dialog .bp-version-group-rules').waitFor();
        assert.equal(saveCount(app), writes);
        await page.locator('#version-group-dialog .bp-version-group-close').click();
        await page.locator('#version-group-dialog').waitFor({ state: 'hidden' });
        assert.equal(await picker(page).isVisible(), true);
        assert.equal(await confirm(page).isDisabled(), true);
        const help = picker(page).locator('.bp-help-trigger');
        if (mobile) await help.tap(); else await help.hover();
        await page.locator('#bp-help-popover').waitFor();
        assert.match(await page.locator('#bp-help-popover').innerText(), /first result found counts, not the highest/);
        assert.equal(await help.getAttribute('title'), null);
        await page.keyboard.press('Escape'); await page.locator('#bp-help-popover').waitFor({ state: 'hidden' });
        assert.equal(await picker(page).isVisible(), true);
        await page.mouse.move(1, 1);
        if (!mobile) {
            await picker(page).locator('.bp-fallback-picker-arrow[aria-label="Next fallback order"]').click();
            await page.waitForFunction(() => document.querySelector('.bp-fallback-picker-viewport').scrollLeft > 150);
            await page.screenshot({ path: `${output}/${name}-sequence.png` });
            const long = picker(page).locator('[data-family-key]').filter({ has: page.locator('input[value=\'[1,"other_versions",2,3,4,5,6,7,8]\']') });
            await long.locator('input').focus();
            await page.waitForFunction(() => document.querySelector('.bp-fallback-picker-viewport').scrollLeft < 10);
            const list = long.locator('.bp-fallback-picker-steps');
            assert.ok(await list.evaluate(node => node.scrollHeight > node.clientHeight));
            await page.waitForFunction(() => !document.querySelector('.bp-fallback-picker-viewport').getAnimations().length);
            await page.waitForTimeout(350);
            const box = await list.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + 30);
            const left = await picker(page).locator('.bp-fallback-picker-viewport').evaluate(node => node.scrollLeft);
            await page.mouse.wheel(0, 120);
            await page.waitForFunction(() => [...document.querySelectorAll('.bp-fallback-picker-column')].find(node => node.dataset.familyKey.includes('other_versions'))
                .querySelector('.bp-fallback-picker-steps').scrollTop > 0);
            assert.equal(await picker(page).locator('.bp-fallback-picker-viewport').evaluate(node => node.scrollLeft), left);
            await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
            await page.mouse.wheel(0, 150);
            await page.waitForFunction(start => document.querySelector('.bp-fallback-picker-viewport').scrollLeft > start + 20, left);
            assert.equal(saveCount(app), writes);
        } else {
            await picker(page).locator('.bp-fallback-picker-viewport').evaluate(node => { node.scrollLeft = node.clientWidth; });
            await page.waitForFunction(() => document.querySelector('.bp-fallback-picker-columns-shell').classList.contains('can-scroll-left'));
            assert.equal(await picker(page).locator('.bp-fallback-picker-columns-shell').evaluate(node => getComputedStyle(node, '::before').pointerEvents), 'none');
        }
        await picker(page).locator('.bp-fallback-picker-viewport').evaluate(node => node.scrollTo({ left: 0, behavior: 'instant' }));
        await page.waitForFunction(() => !document.querySelector('.bp-fallback-picker-columns-shell').classList.contains('can-scroll-left'));
        await page.waitForTimeout(350);
        assert.equal(await picker(page).locator('.bp-fallback-picker-columns-shell').evaluate(node => getComputedStyle(node, '::before').opacity), '0');
        await picker(page).locator('.bp-fallback-picker-cancel').click(); await picker(page).waitFor({ state: 'hidden' });
        assert.equal(saveCount(app), writes);
        assert.equal(await page.locator('.bp-toast.is-visible').count(), 0);
        await row(page, 1).locator('.bp-benchmark-add').click(); await picker(page).waitFor();
        await choose(page, '[1,2]'); await confirm(page).click(); await picker(page).waitFor({ state: 'hidden' });
        assert.equal(await page.locator('.bp-toast.is-visible').innerText(), 'Added to your Pie.');
        await toastFits(page);
        await page.screenshot({ path: `${output}/${name}-success-toast.png`, animations: 'disabled' });
        await saved(page, () => app.state.personalEntries.some(entry => entry.conditionID === 1));
        assert.ok(app.state.personalEntries.some(entry => entry.conditionID === 1));
        assert.deepEqual(app.state.fallbackRules.find(rule => rule.primaryConditionID === 1).entries.map(entry => entry.conditionID), [2]);
        const afterAdd = weights(app), afterWrite = saveCount(app);
        await page.locator('#inline-fallback-preview').waitFor();
        await page.locator('#inline-fallback-settings').screenshot({ path: `${output}/${name}-configuration-entry.png` });
        await openFromEditor(page);
        assert.equal(await picker(page).locator('.bp-fallback-picker-column').first().getAttribute('data-family-key'), '[1,2]');
        assert.equal(await picker(page).locator('.bp-fallback-picker-column').first().locator('strong').first().innerText(), 'Custom');
        assert.equal(await customAdd.isVisible(), false);
        assert.equal(await confirm(page).isDisabled(), true);
        await choose(page, '[1,3]'); await confirm(page).click(); await picker(page).waitFor({ state: 'hidden' });
        await saved(page, () => app.state.fallbackRules[0]?.familyID === 101);
        assert.deepEqual(weights(app), afterAdd);
        assert.equal(app.state.fallbackRules[0].familyID, 101);
        assert.equal(saveCount(app), afterWrite + 1);
        await openFromEditor(page); await choose(page, '[1]'); await confirm(page).click();
        await picker(page).waitFor({ state: 'hidden' });
        await saved(page, () => app.state.fallbackRules.length === 0);
        assert.deepEqual(app.state.fallbackRules, []); assert.deepEqual(weights(app), afterAdd);
        await openFromEditor(page); await choose(page, '[1,2]');
        await picker(page).locator('.bp-fallback-picker-cancel').click();
        assert.deepEqual(app.state.fallbackRules, []);
        await page.locator('#inline-fallback-edit').click();
        await page.locator('#inline-fallback-add-benchmark').click();
        await row(page, 4).locator('.bp-benchmark-add').click();
        assert.equal(await page.locator('.bp-toast.is-visible').innerText(), 'Added to your fallback list.');
        await saved(page, () => app.state.fallbackRules[0]?.entries[0]?.conditionID === 4);
        assert.equal(await picker(page).isVisible(), false);
        assert.deepEqual(app.state.fallbackRules[0].entries.map(entry => entry.conditionID), [4]);
        assert.deepEqual(weights(app), afterAdd);
        await page.screenshot({ path: `${output}/${name}-editor.png` });
        await page.waitForFunction(() => !document.querySelector('.bp-toast').classList.contains('is-visible'));
        // Both alternatives are below the featured threshold: Add must still ask.
        await page.locator('#inline-fallback-toggle').click();
        await row(page, 4).locator('.bp-benchmark-add').click(); await picker(page).waitFor();
        await picker(page).locator('.bp-fallback-picker-column').first().waitFor();
        assert.equal(await picker(page).getByText('Custom', { exact: true }).count(), 0);
        assert.equal(await customAdd.innerText(), 'Skip fallback or create my own');
        assert.equal(await customAdd.getAttribute('data-ui-variant'), 'primary');
        assert.deepEqual(await picker(page).locator('.bp-fallback-picker-column').evaluateAll(nodes => nodes.map(node => node.dataset.familyKey)), ['[4,5]', '[4,6]']);
        const coldFit = await fit(page, mobile);
        await page.screenshot({ path: `${output}/${name}-cold-add.png` });
        await customAdd.click(); await picker(page).waitFor({ state: 'hidden' });
        assert.equal(await page.locator('.bp-toast.is-visible').innerText(), 'Added to your Pie.');
        await toastFits(page);
        await saved(page, () => app.state.personalEntries.some(entry => entry.conditionID === 4));
        assert.equal(app.state.fallbackRules.some(rule => rule.primaryConditionID === 4), false);
        assert.equal(await page.locator('#inline-fallback-settings').isVisible(), true);
        assert.equal(await page.locator('#inline-fallback-add-benchmark').getAttribute('aria-pressed'), 'false');
        await openFromEditor(page);
        assert.equal(await picker(page).locator('.bp-fallback-picker-column').first().getAttribute('data-family-key'), '[4]');
        assert.equal(await picker(page).locator('.bp-fallback-picker-column').first().locator('strong').first().innerText(), 'Custom');
        assert.equal(await customAdd.isVisible(), false);
        await picker(page).locator('.bp-fallback-picker-cancel').click();
        await picker(page).waitFor({ state: 'hidden' });
        await page.locator('#inline-fallback-edit').click();
        await page.locator('#inline-fallback-add-benchmark').click();
        await row(page, 5).locator('.bp-benchmark-add').click();
        await saved(page, () => app.state.fallbackRules.find(rule => rule.primaryConditionID === 4)?.entries[0]?.conditionID === 5);
        assert.equal(await picker(page).isVisible(), false);
        assert.equal(await page.locator('.bp-toast.is-visible').innerText(), 'Added to your fallback list.');
        await page.locator('#inline-fallback-toggle').click();
        await row(page, 8).locator('.bp-benchmark-add').click();
        assert.equal(await picker(page).isVisible(), false);
        assert.equal(await page.locator('.bp-toast.is-visible').innerText(), 'Added to your Pie.');
        await saved(page, () => app.state.personalEntries.some(entry => entry.conditionID === 8));
        if (mobile) await page.locator('button[data-mobile-panel="mix"]').click();
        await page.locator('#weight-pie g[data-object-id="1"]').click();
        if (width === 1440 && !reduced) {
            // A new snapshot exercises the chooser's own paging retry and expiry recovery.
            await page.locator('#workspace-refresh').click(); await ready(page);
            failPage = true; await openFromEditor(page);
            await picker(page).locator('.bp-fallback-picker-more').filter({ hasText: 'Retry' }).waitFor();
            assert.match(await picker(page).locator('.bp-fallback-picker-status').innerText(), /Could not load/);
            const beforeRetry = saveCount(app);
            await picker(page).locator('.bp-fallback-picker-more').click();
            await page.waitForFunction(() => document.querySelectorAll('.bp-fallback-picker-column').length >= 14);
            assert.equal(saveCount(app), beforeRetry);
            expirePage = true; await picker(page).locator('.bp-fallback-picker-more').click();
            await page.waitForFunction(() => document.querySelectorAll('.bp-fallback-picker-column').length === 16
                && !document.querySelector('.bp-fallback-picker-status').textContent);
            const keys = await picker(page).locator('.bp-fallback-picker-column').evaluateAll(nodes => nodes.map(node => node.dataset.familyKey));
            assert.equal(new Set(keys).size, keys.length);
            await picker(page).locator('.bp-fallback-picker-close').click();
        }
        assert.deepEqual(errors, []);
        results.push({ name, passed: true, ...(manifest ? { release: manifest.release } : {}), sequence,
            coldFit, pieWrites: saveCount(app), assertions: 'Add/cancel, Custom first, all pages, cold-only Add, skip/custom, toast, no nesting, shares, layouts, scroll isolation, replacement, no-fallback, editor Add, recovery' });
        console.log(JSON.stringify({ name, passed: true }));
    } catch (error) {
        await page.screenshot({ path: `${output}/${name}-failure.png` });
        results.push({ name, passed: false, error: error.stack, pageErrors: errors }); throw error;
    } finally {
        await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
        await context.close(); await browser.close(); await app.close();
    }
}
