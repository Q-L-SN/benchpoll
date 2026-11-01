import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { familyEntries, weightedEntries } from './fixtures.mjs';
import { WEIGHT_STEP_BASIS_POINTS } from '../../public/js/workspace/constants.js';

const liveURL = process.env.FALLBACK_DISCOVERY_TEST_URL;
const selectedCase = process.env.FALLBACK_DISCOVERY_TEST_CASE;
const output = fileURLToPath(new URL('../../artifacts/fallback-discovery-20261005/ui/', import.meta.url));
await mkdir(output, { recursive: true });
const results = [];
const ordinary = (page, ID) => page.locator(`.bp-benchmark-row:not(.is-family)[data-condition-id="${ID}"]`);
const catalogue = page => page.locator('.bp-benchmark-fallbacks[data-entrance-id="1"]');
const rule = (IDs, familyID) => ({ primaryConditionID: 1, familyID, mode: 'ordered',
    entries: familyEntries(IDs.map(conditionID => ({ conditionID }))) });
const saves = app => app.state.requests.filter(request => request.path === '/api/save_personal_pie');
const pageLoads = app => app.state.requests.filter(request => request.path === '/api/get_ranking_page' && request.body.list === 'fallbacks');
async function idle(page) {
    await page.waitForFunction(() => document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false'
        && !/Saving/.test(document.querySelector('#last-updated')?.textContent ?? ''));
}
async function check(browser, engine, name, options, action) {
    if (selectedCase && selectedCase !== name) return;
    const app = await startPreview(options);
    const context = await browser.newContext({ viewport: { width: options.width ?? 1440, height: 950 },
        isMobile: (options.width ?? 1440) < 500, hasTouch: (options.width ?? 1440) < 500,
        reducedMotion: options.reducedMotion ?? 'no-preference' });
    if (options.initialMode) await context.addInitScript(mode => sessionStorage.setItem('benchpoll-workspace-preferences-v1',
        JSON.stringify({ mode, scoreMode: 'range' })), options.initialMode);
    const page = await context.newPage(); page.setDefaultTimeout(liveURL ? 40000 : 15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    if (liveURL) await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        const response = await route.fetch({ url: app.url + url.pathname + url.search });
        await route.fulfill({ response });
    });
    try {
        await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded' }); await idle(page);
        await page.waitForFunction(() => document.fonts.status === 'loaded');
        await action(page, app);
        assert.deepEqual(errors, [], 'No browser errors');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'No page overflow');
        assert.equal(await page.locator('.bp-benchmark-row').evaluateAll(rows => rows.every(row => {
            if (row.closest('[hidden], [inert]')) return true;
            const identity = row.querySelector('.bp-benchmark-identity').getBoundingClientRect();
            const weights = [...row.querySelectorAll('.bp-benchmark-weight:not([hidden])')];
            const first = weights[0]?.getBoundingClientRect();
            return row.scrollWidth <= row.clientWidth + 1 && (!first || identity.right <= first.left + 1 || identity.bottom <= first.top + 1);
        })), true, 'Chain, weights and actions fit their row');
        await page.screenshot({ path: output + `${liveURL ? 'live-' : ''}${engine}-${name}.png`, fullPage: true, animations: 'disabled' });
        results.push({ engine, name, passed: true }); console.log(`PASS ${engine}-${name}`);
    } catch (error) {
        results.push({ engine, name, passed: false, error: error.stack, browserErrors: errors });
        await page.screenshot({ path: output + `${liveURL ? 'live-' : ''}${engine}-${name}-failure.png`, fullPage: true });
        console.error(`FAIL ${engine}-${name}: ${error.stack}`);
    } finally { await context.close(); await app.close(); }
}

for (const [engine, launcher, widths] of [['chromium', chromium, [1440, 760, 390, 320]], ['webkit', webkit, [390]]]) {
    const browser = await launcher.launch({ headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    try {
        for (const width of widths) {
            await check(browser, engine, 'empty-personal-' + width, { width, personalEntries: [], initialMode: 'personal' }, async (page, app) => {
                const compact = page.locator('#pie-empty-compact');
                const stage = page.locator('#pie-card .bp-pie-stage');
                assert.equal(await compact.isVisible(), width <= 760);
                assert.equal(await stage.isVisible(), width > 760);
                if (width <= 760) {
                    assert.match(await compact.innerText(), /Use \+ in Benchmarks/);
                    assert.ok((await page.locator('#pie-card').boundingBox()).height < 100, 'Empty personal Pie stays compact');
                }
                await ordinary(page, 1).locator('.bp-benchmark-add').click(); await idle(page);
                await stage.waitFor();
                assert.equal(await compact.isVisible(), false, 'A real Pie is not compressed');
                await ordinary(page, 1).locator('.bp-personal-weight-remove').click(); await idle(page);
                assert.equal(app.state.personalEntries.length, 0);
                assert.equal(await compact.isVisible(), width <= 760, 'Deleting the last slice restores compact layout');
            });
            await check(browser, engine, 'empty-public-' + width, { width, personalEntries: [], publicWeights: [] }, async page => {
                assert.equal(await page.locator('#pie-card .bp-pie-stage').isVisible(), width > 760);
                if (width <= 760) {
                    assert.ok((await page.locator('#pie-card').boundingBox()).height < 120);
                    assert.match(await page.locator('#pie-empty-compact').innerText(), /No public weights/);
                    await page.locator('#pie-empty-compact-action').click();
                } else await page.locator('#personal-pie-create').click();
                await idle(page);
                assert.match(await page.locator('#pie-empty-compact-message').textContent(), /Use \+ in Benchmarks/);
                assert.equal(await page.locator('.bp-benchmark-add').count(), 8);
            });
            await check(browser, engine, 'chain-and-group-' + width, { width, secondaryBenchmark: true, sparseBenchmark: true,
                families: [{ primaryConditionID: 1, familyID: 25, mode: 'ordered', entries: familyEntries([{ kind: 'other_versions' }, { conditionID: 2 }]) }] },
            async (page, app) => {
                await catalogue(page).locator('.bp-benchmark-fallback-toggle').click();
                const chain = catalogue(page).locator('.bp-benchmark-family-chain'); await chain.waitFor();
                assert.equal(await chain.locator('.bp-fallback-step').count(), 2);
                assert.equal(await chain.locator('.bp-fallback-connector').count(), 1);
                assert.equal(await catalogue(page).locator('.bp-benchmark-family-toggle, .bp-benchmark-family-details').count(), 0);
                const before = JSON.stringify(app.state.personalEntries);
                await chain.locator('.bp-fallback-step-name').last().click();
                await page.locator('#benchmark-information-weights').waitFor();
                assert.equal(await page.locator('#benchmark-information-name').innerText(), 'Advanced reasoning');
                assert.equal(await page.locator('#benchmark-personal-weight').innerText(), '25%');
                assert.equal(await page.locator('#benchmark-public-weight').innerText(), '22.00%');
                await page.locator('#discussion-close').click();
                const dynamic = chain.locator('.is-dynamic-version-group');
                assert.equal(await dynamic.locator('.fa-layer-group').count(), 1);
                assert.match(await dynamic.innerText(), /All other versions/);
                await dynamic.click();
                await page.locator('#version-group-dialog .bp-version-priority-list').waitFor();
                assert.deepEqual((await page.locator('.bp-version-priority-list a').allTextContents()).sort(), ['Experimental', 'Extended']);
                const link = page.locator('.bp-version-priority-list a').filter({ hasText: 'Extended' });
                assert.equal(new URL(await link.getAttribute('href'), app.url).searchParams.get('conditionID'), '901');
                await link.click(); await page.locator('#benchmark-information-condition').filter({ hasText: 'Extended' }).waitFor();
                assert.equal(await page.locator('#version-group-dialog').isVisible(), false);
                assert.equal(await page.locator('#benchmark-public-weight').innerText(), '0.00%');
                await page.locator('#discussion-close').click();
                assert.equal(saves(app).length, 0); assert.equal(JSON.stringify(app.state.personalEntries), before);
            });
        }
        await check(browser, engine, 'featured-and-five-at-a-time', { width: engine === 'webkit' ? 390 : 1440, personalEntries: weightedEntries([
            { conditionID: 2, weightBasisPoints: 5000 }, { conditionID: 3, weightBasisPoints: 5000 }]),
        ...(() => {
            const pairs = [2, 3, 4, 5, 6, 7, 8].flatMap(a => [2, 3, 4, 5, 6, 7, 8].filter(b => b !== a).map(b => [a, b])).slice(0, 14);
            const weights = [300, 280, 260, 240, 220, 200, 180, 160, 140, 100, 90, 80, 70, 50];
            const families = pairs.map((pair, i) => rule(pair, i + 50));
            return { families, publicFamilyComposition: [{ primaryConditionID: 1, families: [
                ...families.map((family, i) => ({ ...family, weightBasisPoints: weights[i] / 2600 * 10000, overallWeightBasisPoints: weights[i] })),
                { primaryConditionID: 1, familyID: null, entries: [], overallWeightBasisPoints: 230, weightBasisPoints: 230 / 2600 * 10000 }
            ] }] };
        })() }, async (page, app) => {
            const featured = catalogue(page).locator('.bp-benchmark-featured-configs'); await featured.waitFor();
            assert.equal(await featured.locator('.is-family').count(), 8);
            assert.equal(pageLoads(app).length, 0);
            assert.deepEqual(await featured.locator('.bp-benchmark-public-weight').allTextContents(), ['3.00%', '2.80%', '2.60%', '2.40%', '2.20%', '2.00%', '1.80%', '1.60%']);
            const toggle = catalogue(page).locator('.bp-benchmark-fallback-toggle');
            await toggle.click();
            await page.waitForFunction(() => document.querySelectorAll('#benchmark-fallback-configs-1 .is-family').length === 5);
            const manual = catalogue(page).locator('#benchmark-fallback-configs-1');
            assert.deepEqual(await manual.locator('.bp-benchmark-public-weight').allTextContents(), ['1.40%', '1.00%', '0.90%', '0.80%', '0.70%']);
            assert.equal(pageLoads(app).length, 1);
            await manual.getByRole('button', { name: 'Show next 1 configurations' }).click();
            await page.waitForFunction(() => document.querySelectorAll('#benchmark-fallback-configs-1 .is-family').length === 6);
            assert.equal(pageLoads(app).length, 2);
            await manual.locator('.bp-fallback-step-name').first().focus(); await page.keyboard.press('Escape');
            await manual.waitFor({ state: 'hidden' });
            assert.equal(await featured.isVisible(), true, 'Featured configurations cannot be collapsed');
            assert.equal(await toggle.evaluate(node => node === document.activeElement), true);
            await page.locator('#pie-mode-personal').click(); await idle(page);
            const direct = ordinary(page, 1).locator('.bp-benchmark-direct-add'); await direct.waitFor();
            assert.equal(await direct.innerText(), 'Direct add (not recommended)');
            assert.equal(await direct.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
            const entry = featured.locator('.bp-fallback-step-name').last(); await entry.click();
            await page.locator('#benchmark-information-weights').waitFor();
            assert.equal(saves(app).length, 0);
            await page.locator('#discussion-close').click();
            const saved = page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie') && response.ok());
            await featured.locator('.bp-benchmark-add').first().click(); await saved; await idle(page);
            assert.equal(app.state.fallbackRules[0].familyID, 50);
            assert.equal(app.state.personalEntries.some(entry => entry.conditionID === 1), true);
        });
        await check(browser, engine, 'search-unfolding', { width: engine === 'webkit' ? 390 : 1440,
            secondaryBenchmark: true, sparseBenchmark: true }, async (page, app) => {
            assert.equal(await ordinary(page, 900).isVisible(), false);
            assert.equal(await ordinary(page, 901).isVisible(), false);
            await page.locator('#benchmark-search').fill('Experimental'); await ordinary(page, 900).waitFor();
            assert.equal(await ordinary(page, 900).evaluate(node => Boolean(node.closest('#benchmark-rows'))), true);
            await page.locator('#benchmark-search').fill('General knowledge'); await idle(page); await delay(300);
            assert.equal(await ordinary(page, 900).isVisible(), false, 'Equal benchmark-name matches keep secondary versions folded');
            await page.locator('#benchmark-search').fill('Extended'); await ordinary(page, 901).waitFor();
            assert.equal(await ordinary(page, 901).evaluate(node => Boolean(node.closest('#benchmark-rows'))), true);
            await page.locator('#benchmark-search').fill(''); await idle(page); await delay(300);
            assert.equal(await ordinary(page, 901).isVisible(), false);
            assert.equal(saves(app).length, 0);
        });
        if (engine === 'chromium') {
            await check(browser, engine, 'live-context-weights', { width: 1440, initialMode: 'personal', saveDelay: 1000 }, async (page, app) => {
                await page.locator('#weight-pie > g[data-object-id="2"]').dispatchEvent('click');
                await ordinary(page, 2).locator('.bp-benchmark-information-link').click();
                await page.locator('#benchmark-information-weights').waitFor();
                assert.equal(await page.locator('#benchmark-personal-weight').innerText(), '25%');
                const saved = page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie') && response.ok());
                await page.locator('#weight-pie > g[data-object-id="2"]').dispatchEvent('wheel', { deltaY: -120 });
                await page.locator('#benchmark-personal-weight').filter({ hasText: `${25 + WEIGHT_STEP_BASIS_POINTS / 100}%` }).waitFor();
                assert.equal(app.state.personalEntries.find(entry => entry.conditionID === 2).weightBasisPoints, 2500,
                    'The information rail updates before persistence completes');
                assert.equal(await page.locator('#benchmark-public-weight').innerText(), '22.00%');
                await page.locator('#discussion-close').click();
                await saved; await idle(page);
            });
            await check(browser, engine, 'private-chain-information', { width: 1440, isPrivate: true, families: [rule([2], 20)] }, async (page, app) => {
                await catalogue(page).locator('.bp-benchmark-fallback-toggle').click();
                await catalogue(page).locator('.bp-fallback-step-name').last().click();
                await page.locator('#benchmark-information-weights').waitFor();
                assert.equal(await page.locator('#benchmark-personal-weight').innerText(), '25%');
                assert.equal(await page.locator('#benchmark-public-weight-group').isVisible(), false);
                assert.equal(await page.locator('#benchmark-discussion-view').isVisible(), false);
                assert.equal(await page.locator('#discussion-composer').isVisible(), false);
                assert.equal(app.state.requests.filter(request => request.path === '/api/get_discussion').length, 0);
                assert.equal(saves(app).length, 0);
                await page.locator('#discussion-close').click();
            });
        }
    } finally { await browser.close(); }
}
await writeFile(output + `${liveURL ? 'live-' : ''}${selectedCase ? selectedCase + '-' : ''}checks.json`, JSON.stringify(results, null, 2));
assert.ok(results.length > 0, 'No tests selected');
if (results.some(result => !result.passed)) process.exitCode = 1;
