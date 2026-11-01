import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { familyEntries } from './fixtures.mjs';

const liveURL = process.env.BENCHMARK_ROW_TEST_URL;
const checkFilter = process.env.BENCHMARK_ROW_CHECK;
const output = fileURLToPath(new URL('../../artifacts/fallback-chain-polish-20261006/row-actions/', import.meta.url));
await mkdir(output, { recursive: true });
const results = [];
const ordinary = (page, ID) => page.locator(`.bp-benchmark-row:not(.is-family)[data-condition-id="${ID}"]`);
const family = page => page.locator('.bp-benchmark-row.is-family[data-family-key="[1,2,3]"]');
const rule = { primaryConditionID: 1, familyID: 20, mode: 'ordered', entries: familyEntries([{ conditionID: 2 }, { conditionID: 3 }]) };
const alternate = { primaryConditionID: 1, familyID: 21, mode: 'ordered', entries: familyEntries([{ conditionID: 3 }]) };
const saves = app => app.state.requests.filter(request => request.path === '/api/save_personal_pie');
const information = app => app.state.requests.filter(request => request.path === '/api/get_benchmark_information');
const snapshot = app => JSON.stringify([app.state.personalEntries, app.state.fallbackRules]);
async function idle(page) {
    await page.waitForFunction(() => document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false'
        && !/Saving/.test(document.querySelector('#last-updated')?.textContent ?? ''));
}
async function close(page) {
    await page.locator('#discussion-close').click();
    await page.locator('#discussion-panel').waitFor({ state: 'hidden' });
}
async function inspect(page, app, conditionID, action) {
    const before = snapshot(app); const saveCount = saves(app).length; const requests = information(app).length;
    await action();
    await page.waitForFunction(() => document.body.classList.contains('discussion-open'));
    await page.locator('#benchmark-information-weights').waitFor();
    await page.waitForFunction(() => document.querySelector('#benchmark-information').getAttribute('aria-busy') === 'false');
    assert.equal(information(app).length, requests + 1, 'One inspection request per activation');
    assert.equal(information(app).at(-1).body.conditionID, conditionID);
    assert.equal(snapshot(app), before, 'Inspection never modifies allocations or fallback');
    assert.equal(saves(app).length, saveCount);
    await close(page);
}
async function select(page, app, conditionID, action, { focused = true, configuration = false } = {}) {
    const before = snapshot(app); const saveCount = saves(app).length; const requests = information(app).length;
    await action();
    await page.waitForFunction(({ ID, focused, configuration }) => {
        const view = document.querySelector('.bp-left-workspace').dataset.workspaceView;
        return view === (focused ? 'focus' : 'leaderboard')
            && document.querySelector(`.bp-benchmark-row${configuration ? '.is-family' : ':not(.is-family)'}.selected[data-condition-id="${ID}"]`);
    }, { ID: conditionID, focused, configuration });
    assert.equal(await page.locator('#discussion-panel').isVisible(), false, 'Selection never opens information');
    assert.equal(information(app).length, requests);
    assert.equal(saves(app).length, saveCount);
    assert.equal(snapshot(app), before, 'Selection never changes allocations');
}
async function check(browser, engine, name, options, action) {
    if (checkFilter && `${engine}-${name}` !== checkFilter) return;
    const app = await startPreview(options);
    const context = await browser.newContext({ viewport: { width: options.width ?? 1440, height: 950 },
        isMobile: (options.width ?? 1440) < 500, hasTouch: (options.width ?? 1440) < 500,
        reducedMotion: options.reducedMotion ?? process.env.BENCHMARK_ROW_MOTION ?? 'no-preference' });
    const page = await context.newPage(); page.setDefaultTimeout(liveURL ? 45000 : 15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const responses = []; const failedRequests = [];
    page.on('response', response => {
        if (response.url().includes('/api/')) responses.push({ url: response.url(), status: response.status() });
    });
    page.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
    if (liveURL) await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        const response = await route.fetch({ url: app.url + url.pathname + url.search });
        await route.fulfill({ response });
    });
    try {
        await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded', timeout: liveURL ? 90000 : 15000 }); await idle(page);
        await page.evaluate(() => document.fonts.ready);
        await action(page, app);
        assert.equal(await page.locator('#benchmark-rows .bp-benchmark-row:not(.is-family) .fa-check, #benchmark-rows .fa-comment, #benchmark-rows .bp-benchmark-discuss').count(), 0);
        assert.equal(await page.locator('#benchmark-rows .is-family .bp-personal-weight-remove').count(), 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.equal(await page.locator('.bp-benchmark-row').evaluateAll(rows => rows.every(row => {
            if (row.closest('[hidden], [inert]')) return true;
            const identity = row.querySelector('.bp-benchmark-identity').getBoundingClientRect();
            const weight = row.querySelector('.bp-benchmark-weight:not([hidden])')?.getBoundingClientRect();
            const controls = row.querySelector('.bp-benchmark-action-cell')?.getBoundingClientRect();
            return row.scrollWidth <= row.clientWidth + 1
                && (!weight || identity.right <= weight.left + 1 || identity.bottom <= weight.top + 1)
                && (!controls || !weight || weight.right <= controls.left + 1 || weight.bottom <= controls.top + 1);
        })), true, 'Information, weights and real actions fit');
        assert.deepEqual(errors, []);
        await page.screenshot({ path: output + `${liveURL ? 'live-' : ''}${engine}-${name}.png`, fullPage: true, animations: 'disabled' });
        results.push({ engine, name, passed: true }); console.log(`PASS ${engine}-${name}`);
    } catch (error) {
        const hitState = await page.evaluate(() => {
            const cell = document.querySelector('.bp-benchmark-row:not(.is-family)[data-condition-id="2"] .bp-benchmark-public-weight');
            const rectangle = cell?.getBoundingClientRect();
            const point = rectangle && { x: rectangle.x + rectangle.width / 2, y: rectangle.y + rectangle.height / 2 };
            const hit = point && document.elementFromPoint(point.x, point.y);
            const ancestors = [];
            for (let node = cell; node; node = node.parentElement) {
                const css = getComputedStyle(node);
                ancestors.push({ tag: node.tagName, class: node.className, inert: node.inert, hidden: node.hidden,
                    pointerEvents: css.pointerEvents, visibility: css.visibility, transform: css.transform,
                    overflow: css.overflow, opacity: css.opacity, clip: css.clipPath, contain: css.contain,
                    animations: node.getAnimations().map(animation => ({ state: animation.playState, time: animation.currentTime })),
                    rect: node.getBoundingClientRect().toJSON() });
            }
            return { point, hit: hit?.outerHTML.slice(0, 200), ancestors, scrollY, height: innerHeight,
                view: document.querySelector('.bp-left-workspace').dataset.workspaceView, focus: document.activeElement.outerHTML.slice(0, 200) };
        });
        await page.screenshot({ path: output + `${liveURL ? 'live-' : ''}${engine}-${name}-failure.png`, fullPage: true });
        results.push({ engine, name, passed: false, error: error.stack, browserErrors: errors, responses,
            failedRequests, requests: app.state.requests, personalEntries: app.state.personalEntries,
            statusMessage: await page.locator('#last-updated').textContent(), hitState });
        console.error(`FAIL ${engine}-${name}: ${error.stack}`);
    } finally { await context.close(); await app.close(); }
}

for (const [engine, launcher, widths] of [['chromium', chromium, [1440, 390, 320]], ['webkit', webkit, [390]]]) {
    const browser = await launcher.launch({ headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    try {
        for (const width of widths) await check(browser, engine, 'inspection-' + width, { width, families: [rule, alternate], saveDelay: 400 }, async (page, app) => {
            assert.equal(await page.locator('.bp-benchmark-action-cell').count(), 0, 'Public has no empty action cells');
            assert.equal(await page.locator('.bp-benchmark-head .bp-benchmark-public-order').isVisible(), true, 'Public header remains visible');
            await inspect(page, app, 2, () => ordinary(page, 2).locator('.bp-benchmark-name').click());
            for (const selector of ['.bp-benchmark-rank', '.bp-benchmark-personal-weight', '.bp-benchmark-public-weight', '.bp-benchmark-score-count']) {
                await select(page, app, 2, () => ordinary(page, 2).locator(selector).click());
                await select(page, app, 2, () => ordinary(page, 2).locator(selector).click(), { focused: false });
            }
            await select(page, app, 2, () => ordinary(page, 2).click({ position: { x: 2, y: 2 } }));
            await inspect(page, app, 2, () => ordinary(page, 2).locator('.bp-benchmark-name').click());
            const unweightedView = await page.locator('.bp-left-workspace').getAttribute('data-workspace-view');
            const infoCount = information(app).length;
            await ordinary(page, 8).locator('.bp-benchmark-score-count').click();
            assert.equal(await page.locator('.bp-left-workspace').getAttribute('data-workspace-view'), unweightedView);
            assert.equal(information(app).length, infoCount);
            assert.equal(await page.locator('#discussion-panel').isVisible(), false);
            await inspect(page, app, 8, () => ordinary(page, 8).locator('.bp-benchmark-name').click());
            await page.locator('#pie-mode-personal').click(); await idle(page);
            assert.equal(await ordinary(page, 2).locator('.bp-benchmark-add').count(), 0);
            assert.equal(await ordinary(page, 2).locator('.bp-personal-weight-remove').count(), 1);
            await select(page, app, 2, () => ordinary(page, 2).locator('.bp-benchmark-public-weight').click(), { focused: false });
            await select(page, app, 3, () => ordinary(page, 3).locator('.bp-benchmark-score-count').click());
            assert.equal(await ordinary(page, 2).evaluate(node => node.classList.contains('is-muted')), true);
            await select(page, app, 2, () => ordinary(page, 2).locator('.bp-benchmark-personal-weight').click());
            assert.equal(await page.locator('#pie-adjustment-status').isVisible(), true);
            await inspect(page, app, 5, () => ordinary(page, 5).locator('.bp-benchmark-name').click());
            await ordinary(page, 2).locator('.bp-benchmark-information-link').focus();
            await inspect(page, app, 2, () => page.keyboard.press('Enter'));
            assert.equal(await ordinary(page, 2).locator('.bp-benchmark-information-link').evaluate(node => node === document.activeElement), true);

            await page.locator('.bp-benchmark-fallbacks[data-entrance-id="1"] .bp-benchmark-fallback-toggle').click();
            await family(page).waitFor();
            await inspect(page, app, 3, () => family(page).locator('.bp-fallback-step-name').last().click());
            assert.equal(saves(app).length, 0);

            const appliedResponse = page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie') && response.ok());
            await family(page).locator('.bp-benchmark-add').click(); await appliedResponse; await idle(page);
            await family(page).locator('.bp-benchmark-applied').waitFor();
            await family(page).screenshot({ path: output + `${liveURL ? 'live-' : ''}${engine}-${width}-applied.png`, animations: 'disabled' });
            assert.equal(await family(page).locator('.bp-personal-weight-remove, .bp-benchmark-add').count(), 0);
            assert.equal(await ordinary(page, 1).locator('.bp-personal-weight-remove').count(), 1);
            await select(page, app, 2, () => ordinary(page, 2).locator('.bp-benchmark-personal-weight').click());
            await select(page, app, 1, () => family(page).locator('.bp-benchmark-public-weight').click(), { configuration: true });
            await select(page, app, 1, () => family(page).locator('.bp-benchmark-applied').click(), { focused: false, configuration: true });
            const next = page.locator('.bp-benchmark-row.is-family[data-family-key="[1,3]"]');
            const replacementResponse = page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie') && response.ok());
            await next.locator('.bp-benchmark-add').click(); await replacementResponse; await idle(page);
            await next.locator('.bp-benchmark-applied').waitFor();
            assert.equal(await family(page).locator('.bp-benchmark-applied').count(), 0);
            assert.equal(await family(page).locator('.bp-benchmark-add').count(), 1, 'Check follows the applied configuration');

            const saved = page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie') && response.ok());
            await Promise.all([saved, ordinary(page, 5).locator('.bp-benchmark-add').click()]); await idle(page);
            assert.equal(await page.locator('#discussion-panel').isVisible(), false, 'Add does not open information');
            assert.equal(await ordinary(page, 5).locator('.bp-benchmark-add').count(), 0);
            assert.equal(await ordinary(page, 5).locator('.bp-personal-weight-remove').count(), 1);
            const removed = page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie') && response.ok());
            await Promise.all([removed, ordinary(page, 5).locator('.bp-personal-weight-remove').click()]); await idle(page);
            assert.equal(app.state.personalEntries.some(entry => entry.conditionID === 5), false);
            assert.equal(await page.locator('#discussion-panel').isVisible(), false, 'Remove does not open information');
            await page.locator('#pie-mode-public').click(); await idle(page);
            assert.equal(await page.locator('.bp-benchmark-action-cell').count(), 0);
            assert.equal(await page.locator('.bp-benchmark-head .bp-benchmark-public-order').isVisible(), true);
        });
        await check(browser, engine, 'fallback-draft', { width: engine === 'webkit' ? 390 : 320 }, async (page, app) => {
            await page.locator('#pie-mode-personal').click(); await idle(page);
            await page.locator('#weight-pie > g[data-object-id="1"]').dispatchEvent('click');
            await page.locator('#inline-fallback-toggle').click();
            await inspect(page, app, 5, () => ordinary(page, 5).locator('.bp-benchmark-name').click());
            assert.equal((await page.locator('#inline-fallback-toggle').getAttribute('aria-expanded')) === 'true', true);
            assert.equal(await page.locator('#inline-fallback-chart').evaluate(node => node.classList.contains('is-target-active')), true);
            const saved = page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie') && response.ok());
            await Promise.all([saved, ordinary(page, 2).locator('.bp-benchmark-add').click()]); await idle(page);
            assert.equal(await ordinary(page, 2).locator('.bp-benchmark-add').count(), 0);
            await select(page, app, 2, () => ordinary(page, 2).locator('.bp-benchmark-personal-weight').click());
            await inspect(page, app, 2, () => ordinary(page, 2).locator('.bp-benchmark-name').click());
            assert.equal(app.state.fallbackRules[0].entries[0].conditionID, 2);
            assert.equal((await page.locator('#inline-fallback-toggle').getAttribute('aria-expanded')) === 'true', true);
            assert.equal(await page.locator('#inline-fallback-chart').evaluate(node => node.classList.contains('is-target-active')), false);
            assert.equal(await ordinary(page, 5).locator('.bp-benchmark-add').count(), 1);
        });
        await check(browser, engine, 'guest-inspection', { width: 390, authenticated: false }, async (page, app) => {
            await select(page, app, 2, () => ordinary(page, 2).locator('.bp-benchmark-score-count').click());
            await inspect(page, app, 2, () => ordinary(page, 2).locator('.bp-benchmark-name').click());
            assert.equal(await page.locator('.bp-benchmark-action-cell').count(), 0);
            assert.equal(saves(app).length, 0);
        });
        await check(browser, engine, 'version-label', { width: 390, secondaryBenchmark: true,
            publicWeights: [{ conditionID: 1, weightBasisPoints: 8000 }, { conditionID: 901, weightBasisPoints: 2000 }] }, async (page, app) => {
            await select(page, app, 901, () => ordinary(page, 901).locator('.bp-benchmark-condition').click());
            await select(page, app, 901, () => ordinary(page, 901).locator('.bp-benchmark-condition').click(), { focused: false });
            await inspect(page, app, 901, () => ordinary(page, 901).locator('.bp-benchmark-name').click());
            assert.equal(await ordinary(page, 901).locator('a .bp-benchmark-condition, a .bp-benchmark-score-count').count(), 0);
        });
        if (engine === 'chromium') {
            await check(browser, engine, 'keyboard-rerender', { width: 1440, rankingStress: true, reducedMotion: 'reduce' }, async (page, app) => {
                await ordinary(page, 2).focus();
                await select(page, app, 2, () => page.keyboard.press('Enter'));
                assert.equal(await ordinary(page, 2).evaluate(node => node === document.activeElement), true);
                await select(page, app, 2, () => page.keyboard.press('Space'), { focused: false });
                await ordinary(page, 2).locator('.bp-benchmark-information-link').focus();
                await page.keyboard.press('Enter'); await page.locator('#benchmark-information-weights').waitFor();
                const count = await page.locator('.bp-benchmark-row:not(.is-family)').count();
                await page.locator('#benchmark-rows > .bp-ranking-page-footer button').evaluate(node => node.click());
                await page.waitForFunction(previous => document.querySelectorAll('.bp-benchmark-row:not(.is-family)').length > previous, count);
                assert.equal(await page.locator('#discussion-panel').evaluate(node => node.contains(document.activeElement)), true);
                await page.keyboard.press('Escape');
                await page.locator('#discussion-panel').waitFor({ state: 'hidden' });
                assert.equal(await ordinary(page, 2).locator('.bp-benchmark-information-link').evaluate(node => node === document.activeElement), true);
                assert.equal(saves(app).length, 0);
            });
            await check(browser, engine, 'private-inspection', { width: 390, isPrivate: true }, async (page, app) => {
                await inspect(page, app, 2, () => ordinary(page, 2).locator('.bp-benchmark-name').click());
                assert.equal(app.state.requests.filter(request => request.path === '/api/get_discussion').length, 0);
                assert.equal(saves(app).length, 0);
            });
        }
    } finally { await browser.close(); }
}
await writeFile(output + `${liveURL ? 'live-' : ''}checks.json`, JSON.stringify(results, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
