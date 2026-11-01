import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { familyEntries } from './fixtures.mjs';

const output = fileURLToPath(new URL('../../artifacts/fallback-chain-polish-20261006/fallback-settings/', import.meta.url));
await mkdir(output, { recursive: true });
const liveURL = process.env.FALLBACK_SETTINGS_URL;
const filter = process.env.FALLBACK_SETTINGS_CHECK;
const results = [];
const auto = { kind: 'other_versions' };
const automaticRule = { primaryConditionID: 1, familyID: 18, mode: 'ordered', entries: familyEntries([auto]) };
const explicitRule = { primaryConditionID: 1, familyID: 20, mode: 'ordered', entries: familyEntries([{ conditionID: 2 }, { conditionID: 3 }]) };
const publicFamilyComposition = [{ primaryConditionID: 1, families: [
    { ...automaticRule, weightBasisPoints: 6000, overallWeightBasisPoints: 1560 },
    { ...explicitRule, weightBasisPoints: 4000, overallWeightBasisPoints: 1040 }
] }];
const ordinary = (page, ID) => page.locator(`.bp-benchmark-row:not(.is-family)[data-condition-id="${ID}"]`);
const saves = app => app.state.requests.filter(request => request.path === '/api/save_personal_pie');
const inspections = app => app.state.requests.filter(request => request.path === '/api/get_benchmark_information');
const snapshot = app => JSON.stringify([app.state.personalEntries, app.state.fallbackRules]);
const chart = page => page.locator('#inline-fallback-chart');
async function idle(page) {
    await page.waitForFunction(() => document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false'
        && !/Saving/.test(document.querySelector('#last-updated')?.textContent ?? ''));
}
async function expanded(page, expected) {
    await page.waitForFunction(value => document.querySelector('#inline-fallback-toggle').getAttribute('aria-expanded') === String(value), expected);
    await page.locator('#inline-fallback-settings').waitFor({ state: expected ? 'visible' : 'hidden' });
    assert.equal((await page.locator('#inline-fallback-toggle').textContent()).trim(), 'Fallback');
    assert.equal(await page.locator('#inline-fallback-count, #inline-fallback-toggle small').count(), 0);
}
async function closeDiscussion(page) {
    await page.locator('#discussion-close').click();
    await page.locator('#discussion-panel').waitFor({ state: 'hidden' });
}
async function inspect(page, app, ID, action) {
    const saved = snapshot(app); const before = inspections(app).length;
    const loaded = page.waitForResponse(response => response.url().includes('/api/get_benchmark_information') && response.ok());
    await Promise.all([loaded, action()]);
    await page.locator('#benchmark-information-weights').waitFor();
    assert.equal(inspections(app).length, before + 1);
    assert.equal(inspections(app).at(-1).body.conditionID, ID);
    assert.equal(snapshot(app), saved);
    await closeDiscussion(page);
}
async function select(page, app, ID, selector = '.bp-benchmark-personal-weight') {
    const before = inspections(app).length;
    await ordinary(page, ID).locator(selector).click();
    await page.waitForFunction(id => document.querySelector(`.bp-benchmark-row:not(.is-family)[data-condition-id="${id}"]`)?.classList.contains('selected')
        && document.querySelector('.bp-left-workspace').dataset.workspaceView === 'focus', ID);
    assert.equal(await page.locator('#discussion-panel').isVisible(), false);
    assert.equal(inspections(app).length, before);
}
async function dialogReady(page) {
    await page.locator('#version-group-dialog:not([hidden]) .bp-version-group-body[aria-busy="false"]').waitFor();
    assert.equal(await page.locator('#version-group-dialog .bp-version-group-rules').isVisible(), true);
    assert.equal(await page.locator('#discussion-panel').isVisible(), false);
}
async function closeDialog(page) {
    await page.locator('#version-group-dialog .dialog-close-button').click();
    await page.locator('#version-group-dialog').waitFor({ state: 'hidden' });
}
async function check(browser, engine, name, width, options, action) {
    if (filter && `${engine}-${name}-${width}` !== filter) return;
    const app = await startPreview(options);
    const context = await browser.newContext({ viewport: { width, height: 940 }, isMobile: width < 500, hasTouch: width < 500 });
    const page = await context.newPage(); page.setDefaultTimeout(18000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    if (liveURL) {
        await page.route('**/Language-models/**', async route => {
            if (route.request().resourceType() !== 'document') return route.continue();
            await route.fulfill({ response: await route.fetch({ url: new URL('/Intelligence', liveURL).href }) });
        });
        await page.route('**/api/**', async route => {
            const url = new URL(route.request().url());
            await route.fulfill({ response: await route.fetch({ url: app.url + url.pathname + url.search }) });
        });
    }
    try {
        await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded' }); await idle(page);
        await page.evaluate(() => document.fonts.ready);
        await action(page, app);
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.equal(await page.locator('#benchmark-rows .fa-comment, #benchmark-rows .fa-check, #inline-fallback-enabled').count(), 0);
        await page.screenshot({ path: `${output}${liveURL ? 'live-' : ''}${engine}-${name}-${width}.png`, fullPage: true, animations: 'disabled' });
        results.push({ engine, name, width, passed: true }); console.log(`PASS ${engine}-${name}-${width}`);
    } catch (error) {
        await page.screenshot({ path: `${output}${liveURL ? 'live-' : ''}${engine}-${name}-${width}-failure.png`, fullPage: true });
        results.push({ engine, name, width, passed: false, error: error.stack, errors, requests: app.state.requests });
        console.error(`FAIL ${engine}-${name}-${width}: ${error.stack}`);
    } finally { await context.close(); await app.close(); }
}

for (const [engine, launcher, widths] of [['chromium', chromium, [1440, 390, 320]], ['webkit', webkit, [390]]]) {
    const browser = await launcher.launch({ headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    try {
        for (const width of widths) await check(browser, engine, 'interaction', width, {
            fallbackRules: [automaticRule], families: [automaticRule, explicitRule], publicFamilyComposition,
            secondaryBenchmark: true, sparseBenchmark: true, saveDelay: 500
        }, async (page, app) => {
            const initial = snapshot(app);
            await select(page, app, 2);
            await inspect(page, app, 2, () => ordinary(page, 2).locator('.bp-benchmark-name').click());
            await inspect(page, app, 8, () => ordinary(page, 8).locator('.bp-benchmark-name').click());
            const featured = page.locator(`.bp-benchmark-row.is-family[data-family-key='[1,"other_versions"]']`);
            await featured.waitFor();
            assert.equal(await featured.locator('.bp-benchmark-family-chain .bp-fallback-step').count(), 1);
            assert.equal(await featured.locator('.bp-benchmark-family-chain .bp-fallback-connector').count(), 0);
            assert.equal(await featured.locator('.bp-auto-version-button').getAttribute('data-family-member-key'), 'other:0');
            const explicitChain = page.locator(`.bp-benchmark-row.is-family[data-family-key='[1,2,3]'] .bp-benchmark-family-chain`);
            assert.deepEqual(await explicitChain.locator('[data-family-member-key]').evaluateAll(nodes => nodes.map(node => node.dataset.familyMemberKey)), ['2', '3']);
            assert.equal(await explicitChain.locator('.bp-fallback-connector').count(), 1);
            assert.doesNotMatch(await explicitChain.textContent(), /General knowledge|Default/);
            const familyHeight = await featured.evaluate(row => row.getBoundingClientRect().height);
            assert.ok(familyHeight <= (width < 500 ? 58 : 50), `Compact family height: ${familyHeight}`);
            assert.equal(await featured.locator('.bp-benchmark-family-meta, .bp-benchmark-config-metrics').count(), 0);
            await featured.locator('.bp-benchmark-public-weight').click();
            assert.equal(await page.locator('#discussion-panel').isVisible(), false);
            await featured.locator('.bp-benchmark-public-weight').click();
            assert.equal(await page.locator('#discussion-panel').isVisible(), false, 'Repeated row selection does not inspect');
            await inspect(page, app, 1, () => ordinary(page, 1).locator('.bp-benchmark-name').click());
            await featured.locator('.bp-auto-version-button').click(); await dialogReady(page);
            assert.deepEqual(await page.locator('.bp-version-priority-list > li').evaluateAll(rows => rows.map(row => Number(row.dataset.conditionId))), [900, 901]);
            await page.screenshot({ path: `${output}${liveURL ? 'live-' : ''}${engine}-priorities-${width}.png`, fullPage: true, animations: 'disabled' });
            await inspect(page, app, 900, () => page.locator('.bp-version-priority-list a').first().click());
            assert.equal(await page.locator('#version-group-dialog').isVisible(), false);
            await page.locator('#pie-mode-personal').click(); await idle(page); await expanded(page, false);
            assert.equal(snapshot(app), initial);
            await select(page, app, 2, '.bp-benchmark-rank');
            await inspect(page, app, 2, () => ordinary(page, 2).locator('.bp-benchmark-name').click());
            await inspect(page, app, 5, () => ordinary(page, 5).locator('.bp-benchmark-name').click());
            await select(page, app, 1);
            await page.locator('#inline-fallback-toggle').click(); await expanded(page, true);
            assert.equal(await chart(page).evaluate(node => node.classList.contains('is-target-active')), true);
            await chart(page).locator('.bp-auto-version-button').click(); await dialogReady(page);
            await page.waitForFunction(() => document.getElementById('version-group-dialog').contains(document.activeElement));
            await page.keyboard.press('Tab');
            assert.equal(await page.locator('#version-group-dialog').evaluate(node => node.contains(document.activeElement)), true);
            await page.keyboard.press('Escape');
            await page.locator('#version-group-dialog').waitFor({ state: 'hidden' });
            await page.waitForFunction(() => document.activeElement?.classList.contains('bp-auto-version-button'));
            await page.locator('#inline-fallback-toggle').click(); await expanded(page, false);
            assert.equal(snapshot(app), initial, 'Collapsing preserves the active fallback');
            assert.equal(saves(app).length, 0, 'Viewing and selecting never save weights');
            await select(page, app, 3); await expanded(page, false);
            await page.locator('#inline-fallback-toggle').click(); await expanded(page, true);
            await select(page, app, 1); await expanded(page, true);
            assert.equal(await chart(page).locator('.bp-auto-version-button').count(), 1);
            await page.goto((liveURL ? new URL('/Language-models/Reasoning', liveURL).href : app.url + '/Language-models/Reasoning'), { waitUntil: 'domcontentloaded' });
            await idle(page); await expanded(page, true);
            await page.locator('#inline-fallback-toggle').click(); await expanded(page, false);
            await page.reload({ waitUntil: 'domcontentloaded' }); await idle(page); await expanded(page, false);
            await page.locator('#inline-fallback-toggle').click(); await expanded(page, true);
            await page.locator('.bp-benchmark-low-toggle[aria-controls="benchmark-other-rows"]').click();
            const saved = page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie') && response.ok());
            await ordinary(page, 901).locator('.bp-benchmark-add').click();
            await chart(page).locator('.bp-auto-version-button').click();
            await saved; await dialogReady(page);
            assert.deepEqual(await page.locator('.bp-version-priority-list > li').evaluateAll(rows => rows.map(row => Number(row.dataset.conditionId))), [900]);
            await closeDialog(page);
            await chart(page).locator('[data-condition-id="other:0"]').getByRole('button', { name: /Move .+ later/ }).click();
            await chart(page).locator('.bp-auto-version-button').click(); await dialogReady(page);
            assert.deepEqual(await page.locator('.bp-version-priority-list > li').evaluateAll(rows => rows.map(row => Number(row.dataset.conditionId))), [900]);
            await closeDialog(page); await idle(page);
            await page.locator('#workspace-undo').click(); await idle(page);
            assert.equal(await chart(page).locator('.bp-family-member').first().getAttribute('data-condition-id'), 'other:0');
            await page.locator('#inline-fallback-toggle').click(); await expanded(page, false);
            assert.equal(app.state.fallbackRules[0].entries.length, 2);
        });
        if (engine === 'chromium') {
            await check(browser, engine, 'save-retry', 390, { saveFailure: 503, saveDelay: 50 }, async (page, app) => {
                await page.locator('#pie-mode-personal').click(); await idle(page);
                await page.locator('#inline-fallback-toggle').click();
                await page.locator('#inline-fallback-add-other-versions').click();
                await chart(page).locator('.bp-auto-version-button').click();
                await page.locator('#version-group-dialog [role="alert"]').waitFor();
                assert.equal(await page.locator('.bp-version-priority-empty').count(), 0, 'Failure is not an empty candidate list');
                app.state.saveFailure = null;
                await page.locator('.bp-version-group-retry').click(); await dialogReady(page);
                assert.equal(await page.locator('.bp-version-priority-list > li').count(), 2);
                await closeDialog(page); await expanded(page, true);
                assert.equal(app.state.fallbackRules[0].entries[0].kind, 'other_versions');
            });
            await check(browser, engine, 'guest', 390, { authenticated: false, saveDelay: 50 }, async (page, app) => {
                await page.locator('#personal-pie-create').click();
                await ordinary(page, 1).locator('.bp-benchmark-add').click(); await idle(page);
                await page.locator('#inline-fallback-toggle').click();
                await page.locator('#inline-fallback-add-other-versions').click();
                await chart(page).locator('.bp-auto-version-button').click(); await dialogReady(page);
                assert.equal(await page.locator('.bp-version-priority-list > li').count(), 2);
                assert.equal(saves(app).length, 0);
                await closeDialog(page); await page.reload({ waitUntil: 'domcontentloaded' }); await idle(page);
                await expanded(page, true);
                assert.equal(await chart(page).locator('.bp-auto-version-button').count(), 1);
            });
        }
    } finally { await browser.close(); }
}
await writeFile(`${output}${liveURL ? 'live-' : ''}checks.json`, JSON.stringify(results, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
