import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { models, benchmarks, familyEntries } from './fixtures.mjs';

const engines = [['chromium', chromium, [1440, 390, 320]], ['webkit', webkit, [390]]];
const modes = ['single', 'group', 'guest', 'fallback'];
const selectedCase = process.env.MODEL_PANEL_TEST_CASE;
const cases = engines.flatMap(([engine, , widths]) => widths.flatMap(width => modes.map(mode => `${engine}-${width}-${mode}`)));
if (selectedCase) assert.ok(cases.includes(selectedCase), `Unknown model panel case: ${selectedCase}`);
const output = 'artifacts/benchmark-add-layouts-20261006/ui' + (selectedCase ? `/focused-${selectedCase}` : '');
await mkdir(output, { recursive: true });
const liveURL = process.env.BENCHMARK_LAYOUTS_URL;
const results = [];
const groupedModels = [0, 1].map(index => ({ ...models[index], modelName: models[index].name,
    condition: { name: '', parameters: {}, scoreFields: [] },
    results: new Map(benchmarks.map(item => [String(item.conditionID), { normalizedScore: 80 - index * 10 }])) }));

for (const [engine, launcher, widths] of engines) {
    if (selectedCase && !selectedCase.startsWith(`${engine}-`)) continue;
    const browser = await launcher.launch({ headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    try {
        for (const width of widths) for (const mode of modes) {
            if (selectedCase && selectedCase !== `${engine}-${width}-${mode}`) continue;
            const rule = { primaryConditionID: 1, familyID: 7, mode: 'ordered', entries: familyEntries([{ conditionID: 2 }, { conditionID: 3 }]) };
            const options = mode === 'group' ? { comparisonModels: groupedModels, comparisonLast: { mode: 'best', keys: [], filters: [] } }
                : mode === 'fallback' ? { comparisonModels: [{ ...groupedModels[0], results: new Map([['2', { normalizedScore: 80 }], ['3', { normalizedScore: 99 }]]) }],
                    publicWeights: [{ conditionID: 1, weightBasisPoints: 10000 }], families: [rule],
                    publicFamilyComposition: [{ primaryConditionID: 1, families: [{ ...rule, weightBasisPoints: 10000, overallWeightBasisPoints: 10000 }] }] }
                : { authenticated: mode !== 'guest' };
            const app = await startPreview(options);
            const context = await browser.newContext({ viewport: { width, height: 940 }, isMobile: width < 500, hasTouch: width < 500 });
            const page = await context.newPage(); page.setDefaultTimeout(20000);
            const errors = []; page.on('pageerror', error => errors.push(error.message));
            if (liveURL) await page.route('**/api/**', async route => {
                const url = new URL(route.request().url());
                await route.fulfill({ response: await route.fetch({ url: app.url + url.pathname + url.search }) });
            });
            try {
                await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded', timeout: liveURL ? 45000 : 20000 });
                await page.locator('.bp-model-row').first().waitFor({ state: 'attached' });
                if (width < 500) await page.locator('[data-mobile-panel="models"]').click();
                assert.equal(await page.locator('#model-rows a, #model-rows .bp-model-action-cell, #model-rows .fa-circle-info').count(), 0);
                await page.locator('.bp-model-row').first().click();
                await page.locator('#model-scores-dialog').waitFor();
                const actions = page.locator('#model-scores-change-controls');
                if (mode === 'guest') assert.equal(await actions.isVisible(), false);
                else if (mode === 'group') {
                    await actions.locator('summary').click();
                    assert.equal(await actions.locator('a').count(), 2);
                    assert.deepEqual(await actions.locator('a').evaluateAll(nodes => nodes.map(node => node.getAttribute('href'))),
                        ['/contribute/models/301/edit', '/contribute/models/302/edit']);
                    await actions.locator('summary').click();
                } else {
                    assert.equal((await actions.textContent()).trim(), 'Change information');
                    assert.equal(await actions.locator('a').getAttribute('href'), '/contribute/models/301/edit');
                    assert.equal(await actions.locator('a .fa-pen-to-square').count(), 1);
                }
                if (mode === 'fallback') {
                    const toggle = page.locator('.bp-model-fallback-toggle');
                    assert.match(await toggle.textContent(), /General knowledge/);
                    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
                    assert.equal(await page.locator('.bp-model-fallback-path').isVisible(), false);
                    await toggle.click();
                    await page.locator('.bp-model-fallback-path').waitFor();
                    assert.deepEqual(await page.locator('.bp-model-fallback-path > li').evaluateAll(nodes => nodes.map(node => Number(node.dataset.conditionId))), [2]);
                    assert.doesNotMatch(await page.locator('.bp-model-fallback-path').textContent(), /Code generation/);
                    await toggle.click();
                    await page.locator('.bp-model-fallback-path').waitFor({ state: 'hidden' });
                }
                await page.getByRole('button', { name: 'All scores', exact: true }).click();
                await page.waitForFunction(() => document.querySelector('.bp-model-configuration-link, .bp-model-score-sample'));
                if (await page.locator('.bp-model-configuration-link').count()) await page.locator('.bp-model-configuration-link').first().click();
                await page.locator('.bp-model-score-sample').first().waitFor();
                assert.equal(await page.locator('.bp-model-score-sample .bp-row-edit-action:visible').count() > 0, mode !== 'guest');
                if (mode !== 'guest') {
                    assert.equal(await actions.locator('a').count(), 1);
                    assert.match(await actions.locator('a').getAttribute('href'), /^\/contribute\/models\/[1-9]\d*\/edit$/);
                }
                const scroll = page.locator('#model-scores-list');
                assert.equal(await scroll.evaluate(node => node.scrollWidth <= node.clientWidth + 1 && node.clientHeight > 90), true);
                assert.deepEqual(errors, []);
                await page.screenshot({ path: `${output}/${liveURL ? 'live-' : ''}${engine}-${width}-model-${mode}.png`, animations: 'disabled' });
                results.push({ engine, width, mode, passed: true }); console.log(`PASS ${engine}-${width}-${mode}`);
            } catch (error) {
                results.push({ engine, width, mode, passed: false, error: error.stack, errors });
                await page.screenshot({ path: `${output}/${liveURL ? 'live-' : ''}${engine}-${width}-model-${mode}-failure.png` });
                console.error(`FAIL ${engine}-${width}-${mode}: ${error.stack}`);
            } finally { await context.close(); await app.close(); }
        }
    } finally { await browser.close(); }
}
await writeFile(`${output}/${liveURL ? 'live-' : ''}model-checks.json`, JSON.stringify(results, null, 2));
assert.equal(results.length, selectedCase ? 1 : cases.length, 'Every selected case must run');
if (results.some(result => !result.passed)) process.exitCode = 1;
