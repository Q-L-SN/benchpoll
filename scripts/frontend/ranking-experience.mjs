import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { models, weightedEntries, familyEntries } from './fixtures.mjs';

const output = 'artifacts/percentile-ranking-20261007/ranking-ui';
await mkdir(output, { recursive: true });
const liveURL = process.env.RANKING_EXPERIENCE_URL;
const checks = [];
const ordinary = (page, ID) => page.locator(`.bp-benchmark-row:not(.is-family)[data-condition-id="${ID}"]`);
const weights = [{ conditionID: 1, weightBasisPoints: 5000 }, { conditionID: 2, weightBasisPoints: 5000 }];
const values = [{ 1: 95, 2: 15 }, { 1: 40, 2: 90 }, { 1: 80 }];
const comparisonModels = models.slice(0, 3).map((model, index) => ({ ...model, modelName: model.name,
    condition: { parameters: {}, scoreFields: [] },
    results: new Map(Object.entries(values[index]).map(([key, normalizedScore]) => [key, { normalizedScore }])) }));
const rule = { primaryConditionID: 1, familyID: 20, mode: 'ordered', entries: familyEntries([{ conditionID: 3 }]) };

async function ready(page) {
    await page.waitForFunction(() => document.querySelector('#model-ranking-status')?.dataset.phase === 'ready'
        && document.querySelectorAll('.bp-model-row').length > 0);
}
async function wheel(page, count) {
    await ordinary(page, 1).locator('.bp-benchmark-personal-weight').evaluate((node, count) => {
        for (let i = 0; i < count; i++) node.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
    }, count);
}
async function check(browser, engine, name, width, options, action) {
    const app = await startPreview(options);
    const context = await browser.newContext({ viewport: { width, height: 960 }, isMobile: width < 500,
        hasTouch: width < 500, reducedMotion: name === 'reduced-motion' ? 'reduce' : 'no-preference' });
    const page = await context.newPage(); page.setDefaultTimeout(liveURL ? 60000 : 15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (liveURL) await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        await route.fulfill({ response: await route.fetch({ url: app.url + url.pathname + url.search }) });
    });
    try {
        await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded' });
        await ready(page);
        await action(page, app);
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await page.screenshot({ path: `${output}/${liveURL ? 'live-' : ''}${engine}-${name}-${width}.png`, fullPage: true, animations: 'disabled' });
        checks.push({ engine, name, width, passed: true });
        console.log(`PASS ${engine}-${name}-${width}`);
    } catch (error) {
        await page.screenshot({ path: `${output}/${engine}-${name}-${width}-failure.png`, fullPage: true });
        checks.push({ engine, name, width, passed: false, error: error.stack, errors });
        console.error(`FAIL ${engine}-${name}-${width}: ${error.stack}`);
    } finally { await context.close(); await app.close(); }
}

for (const [engine, launcher, widths] of [['chromium', chromium, [1440, 390, 320]], ['webkit', webkit, [390]]]) {
    const browser = await launcher.launch({ headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    try {
        for (const width of widths) await check(browser, engine, 'fallback-target', width, {
            fallbackRules: [rule], families: [rule], secondaryBenchmark: true, sparseBenchmark: true, saveDelay: 350
        }, async (page, app) => {
            assert.equal(await ordinary(page, 900).count(), 1);
            assert.equal(await ordinary(page, 901).count(), 1);
            assert.equal(await page.locator('.bp-benchmark-low-toggle').count(), 0);
            assert.equal(await page.locator('#benchmark-version-grouping').count(), 0);
            await page.locator('#pie-mode-personal').click();
            await ready(page);
            const flip = await page.locator('.bp-pie-transition[data-kind="flip"]').count();
            assert.equal(flip, 1);
            assert.deepEqual(await page.locator('.bp-pie-stage [id]').evaluateAll(nodes => {
                const ids = nodes.map(node => node.id); return ids.filter((id, index) => ids.indexOf(id) !== index);
            }), []);
            await page.locator('.bp-pie-transition[data-kind="flip"]').waitFor({ state: 'detached' });
            await ordinary(page, 1).locator('.bp-benchmark-personal-weight').click();
            await page.locator('#inline-fallback-toggle').click();
            await page.locator('#inline-fallback-settings').waitFor();
            await page.locator('#inline-fallback-add-benchmark').click();
            assert.equal(await page.locator('#benchmark-card').evaluate(node => node.classList.contains('is-fallback-target-active')), true);
            assert.equal(await page.locator('#benchmark-rows .bp-personal-weight-remove, #benchmark-rows .bp-benchmark-applied, #benchmark-rows .has-fallback').count(), 0);
            assert.equal(await page.locator('#benchmark-personal-pin').isVisible(), false);
            const add = ordinary(page, 2).locator('.bp-benchmark-add');
            assert.equal(await add.isVisible(), true, 'A main-Pie slice can be added to Fallback');
            assert.equal(await add.evaluate(node => getComputedStyle(node).color), 'rgb(22, 101, 117)');
            assert.equal(await add.evaluate(node => getComputedStyle(node).textDecorationLine), 'none');
            const layout = await page.locator('#benchmark-card').getAttribute('data-add-layout');
            for (const candidate of ['icon', 'label', 'rail', 'below']) {
                await page.locator('#benchmark-card').evaluate((node, value) => { node.dataset.addLayout = value; }, candidate);
                assert.equal(await add.evaluate(node => getComputedStyle(node).color), 'rgb(22, 101, 117)', candidate);
                assert.equal(await add.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(233, 245, 246)', candidate);
            }
            await page.locator('#benchmark-card').evaluate((node, value) => {
                if (value === null) delete node.dataset.addLayout;
                else node.dataset.addLayout = value;
            }, layout);
            const before = app.state.personalEntries.map(entry => [entry.conditionID, entry.weightBasisPoints]);
            await add.click();
            await page.waitForFunction(() => document.querySelectorAll('#inline-fallback-chart .bp-family-member').length === 2);
            await ready(page);
            assert.deepEqual(app.state.personalEntries.map(entry => [entry.conditionID, entry.weightBasisPoints]), before);
            assert.deepEqual(app.state.fallbackRules[0].entries.map(entry => entry.conditionID), [3, 2]);
            assert.equal(await page.locator('#inline-fallback-add-benchmark').getAttribute('aria-pressed'), 'true');
            assert.equal(await page.locator('#inline-fallback-add-benchmark, #inline-fallback-add-other-versions').count(), 2);
            await page.screenshot({ path: `${output}/${liveURL ? 'live-' : ''}${engine}-adding-fallback-${width}.png`, fullPage: true, animations: 'disabled' });
            if (width < 500) {
                assert.equal(await page.locator('#inline-fallback-add-benchmark').evaluate(node => node.getBoundingClientRect().height >= 44), true);
                assert.equal(await page.locator('#benchmark-search').evaluate(node => node !== document.activeElement), true);
            }
            await ordinary(page, 1).locator('.bp-benchmark-personal-weight').click();
            assert.equal(await page.locator('#benchmark-card').evaluate(node => node.classList.contains('is-fallback-target-active')), false);
            assert.ok(await page.locator('#benchmark-rows .bp-personal-weight-remove').count() > 0);
            const unfocusedBorder = await page.locator('.bp-benchmark-search').evaluate(node => getComputedStyle(node).borderColor);
            await page.locator('#benchmark-search').focus();
            assert.equal(await page.locator('#benchmark-search').evaluate(node => getComputedStyle(node).outlineStyle), 'none');
            assert.equal(await page.locator('.bp-benchmark-search').evaluate(node => getComputedStyle(node).borderColor), unfocusedBorder);
        });
        if (engine !== 'chromium') continue;
        await check(browser, engine, 'continuous-ranking', 1440, { comparisonModels, publicWeights: weights,
            personalEntries: weightedEntries(weights), saveDelay: 900 }, async (page, app) => {
            await page.locator('#pie-mode-personal').click(); await ready(page);
            await page.locator('.bp-pie-transition[data-kind="flip"]').waitFor({ state: 'detached' });
            await ordinary(page, 1).locator('.bp-benchmark-personal-weight').click();
            const old = await page.locator('.bp-model-row').evaluateAll(rows => rows.map(row => ({ key: row.dataset.modelKey,
                rank: row.dataset.rank, text: row.textContent, width: getComputedStyle(row.querySelector('.bp-score-known')).width })));
            await page.locator('.bp-model-row').first().evaluate(row => { window.previousRankingRow = row; });
            await wheel(page, 8);
            await page.waitForFunction(() => document.getElementById('model-ranking-status').dataset.phase === 'updating');
            assert.equal(await page.locator('.bp-model-row').first().evaluate(row => row === window.previousRankingRow), true);
            assert.deepEqual(await page.locator('.bp-model-row').evaluateAll(rows => rows.map(row => row.textContent)), old.map(row => row.text));
            await page.waitForRequest(request => request.url().endsWith('/api/save_personal_pie'));
            await wheel(page, 5);
            await page.locator('#benchmark-search').fill('knowledge');
            const animations = await page.waitForFunction(() => {
                if (document.getElementById('model-ranking-status').dataset.phase !== 'ready') return false;
                const bars = [...document.querySelectorAll('.bp-score-known')].map(node => ({
                    key: node.closest('.bp-model-row').dataset.modelKey,
                    frames: node.getAnimations().map(animation => animation.effect.getKeyframes()) }));
                return bars.some(bar => bar.frames.length) ? bars : false;
            });
            const frames = await animations.jsonValue();
            assert.ok(frames.some(bar => bar.frames.some(keys => keys[0].width === old.find(row => row.key === bar.key)?.width)));
            assert.ok(await page.locator('.bp-rank-change').count() > 0);
            assert.equal(app.state.requests.filter(request => request.path === '/api/save_personal_pie').length, 2);
            assert.equal(app.state.personalEntries[0].weightBasisPoints, 7600);
            assert.equal(app.state.requests.filter(request => request.path === '/api/get_weighted_workspace').at(-1).body.benchmarkQuery, 'knowledge');
            await ready(page);
            assert.equal(await page.locator('#model-card').getAttribute('aria-busy'), 'false');
            app.state.saveFailure = 500;
            await wheel(page, 1);
            await page.waitForFunction(() => document.getElementById('model-ranking-status').dataset.phase === 'error');
            assert.equal(await page.locator('#model-card').getAttribute('aria-busy'), 'false');
            assert.equal(await page.locator('.bp-model-row').count(), 3);
        });
        await check(browser, engine, 'available-policy', 1440, { comparisonModels, publicWeights: weights,
            personalEntries: weightedEntries(weights) }, async page => {
            const response = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace')
                && response.request().postDataJSON().scoreMode === 'available');
            await page.locator('[data-score-mode="available"]').click();
            const payload = await (await response).json(); await ready(page);
            const partial = payload.modelLeaderboards.public.find(model => model.modelID === 303);
            assert.equal(partial.availableInference.observedScore, 80);
            assert.equal(partial.lower, 66.25);
            assert.equal(partial.inferredScores[0].normalizedScore, 52.5);
            assert.equal(payload.modelLeaderboards.public[0].modelID, 303);
            await page.locator('.bp-model-row').first().click();
            await page.locator('.bp-model-score-detail-row').first().waitFor();
            assert.match(await page.locator('#model-scores-dialog').textContent(), /covered|estimated/i);
        });
        await check(browser, engine, 'reduced-motion', 390, {}, async page => {
            await page.locator('#pie-mode-personal').click();
            assert.equal(await page.locator('.bp-pie-transition').count(), 0);
        });
        await check(browser, engine, 'form-focus-policy', 390, {}, async (page, app) => {
            await page.goto((liveURL ?? app.url) + '/contribute/benchmarks/new');
            const field = page.locator('[data-evaluation-name]');
            await field.fill('Draft benchmark');
            const focused = await field.evaluate(node => {
                const style = getComputedStyle(node); return { outline: style.outlineStyle, shadow: style.boxShadow };
            });
            assert.equal(focused.outline, 'none');
            assert.ok(focused.shadow === 'none' || focused.shadow.includes('inset'));
            await field.evaluate(node => node.setAttribute('aria-invalid', 'true'));
            await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-evaluation-name]')).borderColor === 'rgb(178, 77, 84)');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        });
    } finally { await browser.close(); }
}
await writeFile(`${output}/${liveURL ? 'live-' : ''}results.json`, JSON.stringify(checks, null, 2));
if (checks.some(check => !check.passed)) process.exitCode = 1;
