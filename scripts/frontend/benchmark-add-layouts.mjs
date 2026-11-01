import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { familyEntries } from './fixtures.mjs';

const output = process.env.BENCHMARK_LAYOUTS_OUTPUT ?? fileURLToPath(new URL('../../artifacts/benchmark-add-layouts-20261006/ui/', import.meta.url));
await mkdir(output, { recursive: true });
const liveURL = process.env.BENCHMARK_LAYOUTS_URL;
const results = [];
const entries = familyEntries([{ kind: 'other_versions' }, { conditionID: 2 }, { kind: 'other_versions' }, { conditionID: 3 }]);
const rule = { primaryConditionID: 1, familyID: 19, mode: 'ordered', entries };
const familyComposition = [{ primaryConditionID: 1, families: [{ ...rule, weightBasisPoints: 10000, overallWeightBasisPoints: 2600 }] }];
const ordinary = (page, ID) => page.locator(`.bp-benchmark-row:not(.is-family)[data-condition-id="${ID}"]`);
const family = page => page.locator('.bp-benchmark-featured-configs .bp-benchmark-row.is-family').first();
const saves = app => app.state.requests.filter(request => request.path === '/api/save_personal_pie');
async function idle(page) {
    await page.waitForFunction(() => document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false'
        && !/Saving/.test(document.querySelector('#last-updated')?.textContent ?? ''));
}
async function choose(page, kind, value) {
    await page.locator('#workspace-style-toggle').click();
    const menu = page.locator('#workspace-style-menu');
    await menu.waitFor({ state: 'visible' });
    await menu.locator('#workspace-style-target').selectOption(kind);
    const group = menu.locator(`[data-style-kind="${kind}"]`);
    const bounds = await menu.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1);
    await group.locator(`[data-layout-option="${value}"]`).click();
    assert.equal(await menu.isVisible(), true, 'Keep the preview menu open for comparison');
    assert.equal(await page.locator(kind === 'contribution' ? 'body' : '#benchmark-card').getAttribute(`data-${kind}-layout`), value);
    assert.equal(await group.locator(`[data-layout-option="${value}"]`).getAttribute('aria-checked'), 'true');
    await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'
        || animation.effect?.getComputedTiming().iterations === Infinity));
}
async function geometry(row) {
    return row.evaluate(node => {
        const rect = element => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }; };
        return { row: rect(node), identity: rect(node.querySelector('.bp-benchmark-identity')),
            action: rect(node.querySelector('[data-benchmark-control="add"]')) };
    });
}

for (const [engine, launcher, widths] of [['chromium', chromium, [1440, 390, 320]], ['webkit', webkit, [390]]]) {
    const browser = await launcher.launch({ headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    try {
        for (const width of widths) {
            const app = await startPreview({ families: [rule], fallbackRules: [rule], publicFamilyComposition: familyComposition,
                secondaryBenchmark: true, sparseBenchmark: true, saveDelay: 100 });
            const context = await browser.newContext({ viewport: { width, height: 940 }, isMobile: width < 500, hasTouch: width < 500 });
            const page = await context.newPage(); page.setDefaultTimeout(20000);
            const errors = []; page.on('pageerror', error => errors.push(error.message));
            if (liveURL) await page.route('**/api/**', async route => {
                const url = new URL(route.request().url());
                await route.fulfill({ response: await route.fetch({ url: app.url + url.pathname + url.search }) });
            });
            try {
                await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded', timeout: liveURL ? 45000 : 20000 });
                await idle(page); await page.evaluate(() => document.fonts.ready);
                assert.equal(await page.locator('#workspace-style-toggle').isVisible(), true);
                assert.equal(await page.locator('#workspace-style-target option[value="add"]').evaluate(node => node.disabled), true);
                for (const chain of ['inline', 'numbered', 'vertical', 'wrap']) {
                    const before = saves(app).length;
                    await choose(page, 'chain', chain);
                    assert.equal(await family(page).locator('.bp-fallback-step').count(), 4);
                    assert.equal(await family(page).locator('.bp-fallback-connector').count(), 2);
                    const dynamic = family(page).locator('.is-dynamic-version-group').first();
                    assert.equal(await family(page).locator('.bp-fallback-attachment.fa-link').count(), 1);
                    assert.equal(await family(page).locator('.has-attached-version-group .bp-fallback-step').count(), 2);
                    assert.equal(await dynamic.locator('.bp-auto-version-label small, .bp-auto-version-badge').count(), 0);
                    assert.equal(await dynamic.innerText(), 'All other versions');
                    assert.equal(await dynamic.evaluate(node => getComputedStyle(node).boxShadow), 'none');
                    assert.equal(saves(app).length, before);
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                }
                await page.locator('#pie-mode-personal').click(); await idle(page);
                assert.equal(await page.locator('#workspace-style-target option[value="add"]').evaluate(node => node.disabled), false);
                const destinations = await page.locator('#contribute-button, #contribute-data-button').evaluateAll(nodes => nodes.map(node => node.href));
                for (const contribution of ['inline', 'heading', 'toolbar', 'footer']) {
                    const before = saves(app).length;
                    await choose(page, 'contribution', contribution);
                    assert.deepEqual(await page.locator('#contribute-button, #contribute-data-button').evaluateAll(nodes => nodes.map(node => node.href)), destinations);
                    const parents = await page.locator('#contribute-button, #contribute-data-button').evaluateAll(nodes => nodes.map(node => node.parentElement.id || node.parentElement.className));
                    assert.deepEqual(parents, contribution === 'toolbar' ? ['benchmark-contribution-tools', 'model-contribution-tools']
                        : contribution === 'footer' ? ['benchmark-contribution-footer', 'model-contribution-footer']
                            : contribution === 'inline' ? ['bp-benchmark-toolbar-actions', 'bp-model-toolbar'] : ['bp-benchmark-toolbar', 'bp-model-toolbar']);
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                    assert.equal(saves(app).length, before);
                    await page.screenshot({ path: `${output}${liveURL ? 'live-' : ''}${engine}-${width}-contributions-${contribution}.png`, animations: 'disabled', fullPage: true });
                }
                const geometries = {};
                for (const [index, add] of ['compact', 'label', 'rail', 'below'].entries()) {
                    const before = saves(app).length;
                    await choose(page, 'add', add);
                    const addedID = 8 - index;
                    const row = ordinary(page, addedID);
                    await row.scrollIntoViewIfNeeded();
                    geometries[add] = await geometry(row);
                    assert.equal(saves(app).length, before, 'Changing layouts never saves weights');
                    const target = row.locator('[data-benchmark-control="add"]');
                    const bounds = await target.boundingBox();
                    if (width < 500) assert.ok(bounds.height >= 44, `${add}: mobile target height`);
                    for (const chain of ['inline', 'numbered', 'vertical', 'wrap']) {
                        await choose(page, 'chain', chain);
                        await page.locator('#benchmark-card').screenshot({ path: `${output}${liveURL ? 'live-' : ''}${engine}-${width}-${add}-${chain}.png`, animations: 'disabled' });
                        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                    }
                    await Promise.all([page.waitForResponse(response => response.url().includes('/api/save_personal_pie') && response.ok()), target.click()]);
                    await idle(page);
                    assert.ok(app.state.personalEntries.some(entry => entry.conditionID === addedID));
                    await Promise.all([page.waitForResponse(response => response.url().includes('/api/save_personal_pie') && response.ok()),
                        ordinary(page, addedID).locator('[data-benchmark-control="remove"]').click()]);
                    await idle(page);
                    assert.equal(app.state.personalEntries.some(entry => entry.conditionID === addedID), false);
                }
                assert.ok(geometries.label.action.width > geometries.compact.action.width + 10);
                assert.ok(geometries.rail.row.height > geometries.compact.row.height + 5);
                assert.ok(geometries.below.action.y >= geometries.below.identity.y + geometries.below.identity.height - 1);
                assert.ok(geometries.below.action.x < geometries.compact.action.x - 30);
                await ordinary(page, 1).locator('.bp-benchmark-personal-weight').click();
                await page.locator('#inline-fallback-toggle').click();
                await page.locator('#inline-fallback-settings').waitFor();
                assert.equal((await page.locator('#inline-fallback-toggle').textContent()).trim(), 'Fallback');
                const pieIDs = app.state.personalEntries.map(entry => entry.conditionID);
                await Promise.all([page.waitForResponse(response => response.url().includes('/api/save_personal_pie') && response.ok()),
                    ordinary(page, 4).locator('[data-benchmark-control="add"]').click()]);
                await idle(page);
                assert.deepEqual(app.state.personalEntries.map(entry => entry.conditionID), pieIDs);
                assert.ok(app.state.fallbackRules.find(entry => entry.primaryConditionID === 1).entries.some(entry => entry.conditionID === 4));
                const saved = saves(app).length;
                await page.locator('#workspace-style-toggle').click();
                await page.locator('#workspace-style-target').selectOption('chain');
                await page.locator('[data-style-kind="chain"] [data-layout-option="inline"]').focus();
                await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown');
                assert.equal(await page.evaluate(() => document.activeElement.dataset.layoutOption), 'numbered');
                await page.keyboard.press('Enter');
                assert.equal(await page.locator('#benchmark-card').getAttribute('data-chain-layout'), 'numbered');
                await page.keyboard.press('Escape');
                assert.equal(await page.locator('#workspace-style-toggle').evaluate(node => node === document.activeElement), true);
                assert.equal(saves(app).length, saved);
                await page.reload({ waitUntil: 'domcontentloaded' }); await idle(page);
                assert.equal(await page.locator('#benchmark-card').getAttribute('data-add-layout'), 'below');
                assert.equal(await page.locator('#benchmark-card').getAttribute('data-chain-layout'), 'numbered');
                assert.equal(await page.locator('body').getAttribute('data-contribution-layout'), 'footer');
                await page.locator('#pie-mode-public').click(); await idle(page);
                assert.equal(await page.locator('#workspace-style-target option[value="add"]').evaluate(node => node.disabled), true);
                assert.equal(await page.locator('#benchmark-rows [data-benchmark-control="add"]').count(), 0);
                await family(page).locator('.bp-fallback-step-name').first().click();
                await page.locator('#benchmark-information-weights').waitFor();
                assert.equal(app.state.requests.filter(request => request.path === '/api/get_benchmark_information').at(-1).body.conditionID, 2);
                assert.deepEqual(errors, []);
                results.push({ engine, width, passed: true, geometries }); console.log(`PASS ${engine}-${width}`);
            } catch (error) {
                await page.screenshot({ path: `${output}${liveURL ? 'live-' : ''}${engine}-${width}-failure.png`, fullPage: true });
                results.push({ engine, width, passed: false, error: error.stack, errors }); console.error(`FAIL ${engine}-${width}: ${error.stack}`);
            } finally { await context.close(); await app.close(); }
        }
    } finally { await browser.close(); }
}
await writeFile(`${output}${liveURL ? 'live-' : ''}checks.json`, JSON.stringify(results, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
