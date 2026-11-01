import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { familyEntries } from './fixtures.mjs';

const liveURL = process.env.FALLBACK_CATALOGUE_TEST_URL;
const output = fileURLToPath(new URL('../../artifacts/fallback-catalogue-20261005/ui/', import.meta.url));
await mkdir(output, { recursive: true });
const results = [];
const rule = (IDs, ID) => ({ primaryConditionID: 1, familyID: ID, mode: 'ordered',
    entries: familyEntries(IDs.map(conditionID => ({ conditionID }))) });
const ordinary = (page, ID) => page.locator(`.bp-benchmark-row:not(.is-family)[data-condition-id="${ID}"]`);
const configurations = page => page.locator('.bp-benchmark-fallbacks[data-entrance-id="1"]');
const family = (page, key) => page.locator(`.bp-benchmark-row.is-family[data-family-key="${key}"]`);
const saves = app => app.state.requests.filter(request => request.path === '/api/save_personal_pie');
const weights = app => app.state.personalEntries.map(({ conditionID, weightBasisPoints }) => ({ conditionID, weightBasisPoints }));
async function checkRowLayout(page) {
    assert.equal(await page.locator('.bp-benchmark-row').evaluateAll(rows => rows.every(row => {
        if (row.closest('[hidden], [inert]')) return true;
        const name = row.querySelector('.bp-benchmark-identity')?.getBoundingClientRect();
        const weight = row.querySelector('.bp-benchmark-weight')?.getBoundingClientRect();
        const actions = row.querySelector('.bp-benchmark-action-cell')?.getBoundingClientRect();
        const weights = [...row.querySelectorAll('.bp-benchmark-weight:not([hidden])')];
        const contentsFit = weights.every(value => {
            const box = value.getBoundingClientRect();
            const range = document.createRange(); range.selectNodeContents(value);
            const text = range.getBoundingClientRect();
            return text.left >= box.left - 1 && text.right <= box.right + 1;
        });
        return name && weight && contentsFit
            && (name.right <= weight.left + 1 || name.bottom <= weight.top + 1)
            && (!actions || weight.right <= actions.left + 1 || weight.bottom <= actions.top + 1)
            && row.scrollWidth <= row.clientWidth + 1;
    })), true, 'Names, weights and controls never overlap');
}
async function idle(page) {
    await page.waitForFunction(() => document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false'
        && !/Saving/.test(document.querySelector('#last-updated')?.textContent ?? ''));
}
async function saved(page, app, IDs) {
    await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('#inline-fallback-chart .bp-family-member')]
        .map(row => Number(row.dataset.conditionId))) === JSON.stringify(expected), IDs);
    for (let i = 0; i < 500; i++) {
        if (JSON.stringify(app.state.fallbackRules[0]?.entries.map(entry => entry.conditionID) ?? []) === JSON.stringify(IDs)) break;
        if (i === 499) throw new Error('Latest fallback edit was not saved');
        await delay(25);
    }
    await idle(page);
}

async function check(engine, engineName, name, options, action) {
    const app = await startPreview(options);
    const context = await engine.newContext({ viewport: { width: options.width ?? 1440, height: 950 },
        hasTouch: (options.width ?? 1440) < 500, isMobile: (options.width ?? 1440) < 500,
        reducedMotion: options.reducedMotion ?? 'no-preference' });
    const page = await context.newPage(); page.setDefaultTimeout(liveURL ? 90000 : 20000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    if (liveURL) await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        const response = await route.fetch({ url: app.url + url.pathname + url.search });
        await route.fulfill({ response });
    });
    try {
        await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded' }); await idle(page);
        await page.evaluate(() => document.fonts.ready);
        await action(page, app);
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await checkRowLayout(page);
        await page.screenshot({ path: output + `${liveURL ? 'live-' : ''}${engineName}-${name}.png`, fullPage: true, animations: 'disabled' });
        results.push({ engine: engineName, name, passed: true }); console.log('PASS ' + engineName + '-' + name);
    } catch (error) {
        results.push({ engine: engineName, name, passed: false, error: error.stack, browserErrors: errors });
        await page.screenshot({ path: output + `${liveURL ? 'live-' : ''}${engineName}-${name}-failure.png`, fullPage: true });
        console.error('FAIL ' + engineName + '-' + name + ': ' + error.stack);
    } finally { await context.close(); await app.close(); }
}

for (const [engineName, launcher, widths] of [['chromium', chromium, [1440, 390, 320]], ['webkit', webkit, [390]]]) {
    const engine = await launcher.launch({ headless: true, env: { ...process.env,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    try {
        for (const width of widths) await check(engine, engineName, 'actions-' + width,
            { width, families: [rule([2], 20), rule([3], 21)], saveDelay: 400 }, async (page, app) => {
                assert.equal(await page.locator('.bp-benchmark-row.is-family').count(), 0);
                assert.equal(await page.locator('.bp-benchmark-add').count(), 0, 'No personal Add buttons in Public');
                assert.equal(app.state.requests.filter(request => request.path === '/api/get_ranking_page' && request.body.list === 'fallbacks').length, 0);
                const group = configurations(page);
                assert.equal(await group.locator('.bp-benchmark-fallback-toggle').getAttribute('aria-expanded'), 'false');
                await group.locator('.bp-benchmark-fallback-toggle').click(); await family(page, '[1,2]').waitFor();
                assert.equal(await family(page, '[1,2]').locator('.bp-benchmark-family-chain').isVisible(), true);
                assert.equal(await family(page, '[1,2]').locator('.bp-benchmark-family-meta').count(), 0);
                assert.equal(await page.locator('#benchmark-rows > .bp-benchmark-row.is-family').count(), 0);
                assert.equal(saves(app).length, 0);
                await page.locator('#pie-mode-personal').click(); await idle(page);
                assert.equal(await page.locator('.bp-benchmark-row:not(.is-family) .bp-benchmark-add').count(),
                    await page.locator('.bp-benchmark-row:not(.is-family):not(.in-personal-pie)').count());
                const before = weights(app);
                await family(page, '[1,2]').locator('.bp-fallback-step-name').first().click();
                await page.locator('#discussion-close').click();
                await delay(500); assert.equal(saves(app).length, 0, 'Preview must not apply a configuration');
                await family(page, '[1,2]').locator('.bp-benchmark-add').focus(); await page.keyboard.press('Enter');
                await saved(page, app, [2]);
                assert.equal(await family(page, '[1,2]').locator('.bp-benchmark-family-select').evaluate(node => node === document.activeElement), true,
                    'Keyboard focus survives save and configuration revalidation');
                assert.equal(saves(app).length, 1, 'Keyboard Add activates exactly once');
                assert.equal(app.state.fallbackRules[0].familyID, 20); assert.deepEqual(weights(app), before);
                await family(page, '[1,3]').locator('.bp-fallback-step-name').first().click();
                await page.locator('#discussion-close').click(); await delay(200);
                assert.equal(app.state.fallbackRules[0].familyID, 20, 'Preview a different configuration without replacing it');
                await family(page, '[1,3]').locator('.bp-benchmark-add').click(); await saved(page, app, [3]);
                assert.deepEqual(weights(app), before); assert.equal(app.state.fallbackRules[0].familyID, 21);
                await ordinary(page, 5).locator('.bp-benchmark-name').click(); await page.locator('#discussion-close').click();
                assert.deepEqual(weights(app), before, 'An unadded row body never adds to Pie');
                await ordinary(page, 5).locator('.bp-benchmark-add').click();
                for (let i = 0; i < 200 && !app.state.personalEntries.some(entry => entry.conditionID === 5); i++) await delay(25);
                assert.equal(app.state.personalEntries.some(entry => entry.conditionID === 5), true);
                await idle(page);
                await page.locator('#weight-pie > g[data-object-id="1"]').dispatchEvent('click');
                const chart = page.locator('#inline-fallback-chart'); await chart.waitFor();
                await chart.locator('.bp-family-member-name').click();
                assert.match(await ordinary(page, 4).locator('.bp-benchmark-add').getAttribute('aria-label'), /to Fallback/);
                await ordinary(page, 4).locator('.bp-benchmark-name').click(); await page.locator('#discussion-close').click();
                assert.deepEqual(app.state.fallbackRules[0].entries.map(entry => entry.conditionID), [3]);
                await ordinary(page, 4).locator('.bp-benchmark-add').click(); await saved(page, app, [3, 4]);
                assert.equal(await ordinary(page, 4).locator('.bp-benchmark-add').count(), 0);
                await ordinary(page, 2).locator('.bp-benchmark-add').click();
                await page.locator('#workspace-undo').click(); await saved(page, app, [3, 4]);
                assert.equal(await page.locator('#workspace-redo').isVisible(), true);
                await page.locator('#workspace-redo').click(); await saved(page, app, [3, 4, 2]);
                await checkRowLayout(page);
                await page.screenshot({ path: output + `${liveURL ? 'live-' : ''}${engineName}-personal-${width}.png`,
                    fullPage: true, animations: 'disabled' });
                await page.locator('#pie-mode-public').click(); await idle(page);
                assert.equal(await page.locator('.bp-benchmark-add').count(), 0);
            });
        if (engineName === 'chromium') {
            const pairs = [2, 3, 4, 5, 6, 7, 8].flatMap(a => [2, 3, 4, 5, 6, 7, 8].filter(b => a !== b).map(b => [a, b]));
            await check(engine, engineName, 'paging-and-retry', { rankingStress: true,
                families: pairs.map((pair, index) => rule(pair, index + 20)) }, async (page, app) => {
                const count = await page.locator('.bp-benchmark-row:not(.is-family)').count();
                assert.equal(count, 40);
                let fail = true;
                await page.route('**/api/get_ranking_page', async route => {
                    if (fail && route.request().postDataJSON().list === 'fallbacks') {
                        fail = false; await route.fulfill({ status: 503, json: { error: 'temporary_failure' } });
                    } else if (liveURL) {
                        const response = await route.fetch({ url: app.url + '/api/get_ranking_page' }); await route.fulfill({ response });
                    } else await route.continue();
                });
                await configurations(page).locator('.bp-benchmark-fallback-toggle').click();
                await configurations(page).getByRole('button', { name: 'Retry', exact: true }).click();
                await page.waitForFunction(() => document.querySelectorAll('.bp-benchmark-row.is-family').length === 5);
                for (let target = 10; target <= 45; target += 5) {
                    await configurations(page).getByRole('button', { name: /^Show next \d+ configurations$/ }).click();
                    await page.waitForFunction(expected => document.querySelectorAll('.bp-benchmark-row.is-family').length === expected, Math.min(target, 42));
                }
                assert.equal(await page.locator('.bp-benchmark-row:not(.is-family)').count(), count);
                assert.equal(await page.locator('.bp-benchmark-row.is-family').evaluateAll(rows => new Set(rows.map(row => row.dataset.familyKey)).size), 42);
                await configurations(page).locator('.bp-benchmark-fallback-toggle').click();
                await page.locator('#benchmark-rows > .bp-ranking-page-footer button').click();
                await page.waitForFunction(() => document.querySelectorAll('.bp-benchmark-row:not(.is-family)').length > 40);
                assert.equal(saves(app).length, 0);
            });
        }
    } finally { await engine.close(); }
}
await writeFile(output + `${liveURL ? 'live-' : ''}checks.json`, JSON.stringify(results, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
