import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startConfigSidebarPreview } from './helpers/config-sidebar-fixture-20261022.mjs';
import { weightedEntries } from '../scripts/frontend/fixtures.mjs';
import { ESTIMATION_ALGORITHMS } from '../public/js/shared/estimation-algorithms.js';

const built = process.env.BP_TEST_BUILT === '1';
const output = 'artifacts/estimation-lab-20261103';
const model = (ID, values) => ({ ID, modelID: ID, name: `Model ${ID}`, modelName: `Model ${ID}`,
    condition: { parameters: {}, scoreFields: [] },
    results: new Map(Object.entries(values).map(([key, normalizedScore]) => [key, { normalizedScore }])) });
for (const [engine, width] of built ? [[chromium, 390]] : [[chromium, 1440], [chromium, 390], [chromium, 320], [webkit, 390]]) {
    test(`test algorithms ${engine.name()} ${width} ${built ? 'built' : 'source'}`, { timeout: 60000 }, async t => {
        const app = await startConfigSidebarPreview(), browser = await engine.launch({ headless: true });
        t.after(async () => { await browser.close(); await app.close(); });
        app.state.comparisonModels = [model(1, { 1: 100 }), model(2, { 1: 60, 2: 60 }), model(3, { 1: 80, 2: 80 })];
        app.state.publicWeights = [{ conditionID: 1, weightBasisPoints: 5000 }, { conditionID: 2, weightBasisPoints: 5000 }];
        app.state.personalEntries = weightedEntries(app.state.publicWeights);
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        let delayed = false;
        await page.route('**/api/get_weighted_workspace', async route => {
            const response = await route.fetch();
            if (delayed && route.request().postDataJSON().estimationAlgorithm === 'missing-linear') {
                await new Promise(resolve => setTimeout(resolve, 350));
            }
            await route.fulfill({ response });
        });
        if (built) await page.route('**/intelligence', async route => route.fulfill({ contentType: 'text/html',
            body: await readFile('private/home-built.html', 'utf8') }));
        await page.goto(app.url + '/intelligence');
        await page.waitForSelector('.bp-model-row');
        if (width < 760) await page.locator('[data-mobile-panel="models"]').click();
        const control = page.locator('#estimation-algorithm'), first = page.locator('.bp-model-row .bp-model-name').first();
        const choose = async algorithm => {
            await page.getByRole('combobox', { name: 'Test estimation algorithm', exact: true }).click();
            await page.getByRole('option', { name: ESTIMATION_ALGORITHMS.find(item => item.ID === algorithm).label, exact: true }).click();
        };
        assert.equal(await control.inputValue(), 'current');
        assert.equal(await first.textContent(), 'Model 3');
        if (built) assert.ok(await page.locator('script[src^="/build/home/"]').count());
        const select = async algorithm => {
            const response = page.waitForResponse(res => res.url().endsWith('/api/get_weighted_workspace')
                && (res.request().postDataJSON().estimationAlgorithm ?? 'current') === algorithm, { timeout: 6000 });
            const [ready] = await Promise.all([response, choose(algorithm)]);
            const payload = await ready.json();
            await page.waitForSelector('#model-card[aria-busy="false"]');
            await page.waitForFunction(name => document.querySelector('.bp-model-row .bp-model-name')?.textContent === name,
                payload.modelLeaderboards.public[0].name);
            assert.equal(payload.estimationAlgorithm, algorithm);
            return payload;
        };
        for (const { ID } of ESTIMATION_ALGORITHMS.slice(1)) {
            const data = await select(ID);
            const sparse = data.modelLeaderboards.public.find(row => row.modelID === 1);
            assert.equal(sparse.availableInference.observedContribution, 50);
            assert.equal(sparse.coverage, 50);
            assert.ok(sparse.lower >= 50 && sparse.lower <= 100);
            if (ID === 'missing-raw') assert.equal(await first.textContent(), 'Model 1');
        }
        await page.locator('.bp-model-row').first().click();
        await page.waitForSelector('#model-scores-dialog:not([hidden])');
        const detail = await page.locator('#model-scores-summary').innerText();
        assert.match(detail, /Before adjustment:/); assert.match(detail, /After adjustment:/);
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Score range', exact: true }).click();
        await page.waitForSelector('#estimation-test-control[hidden]', { state: 'attached' });
        await page.waitForSelector('#model-card[aria-busy="false"]');
        await page.getByRole('button', { name: 'Estimated score', exact: true }).click();
        await page.waitForSelector('#estimation-test-control:not([hidden])');
        assert.equal(await control.inputValue(), 'missing-midpoint');
        await page.waitForSelector('#model-card[aria-busy="false"]');
        delayed = true;
        const slow = page.waitForRequest(req => req.url().endsWith('/api/get_weighted_workspace')
            && req.postDataJSON().estimationAlgorithm === 'missing-linear');
        await choose('missing-linear'); await slow;
        await select('missing-raw');
        await page.waitForTimeout(400);
        assert.equal(await control.inputValue(), 'missing-raw'); assert.equal(await first.textContent(), 'Model 1');
        await page.reload(); await page.waitForSelector('.bp-model-row');
        if (width < 760) await page.locator('[data-mobile-panel="models"]').click();
        assert.equal(await control.inputValue(), 'missing-raw'); assert.equal(await first.textContent(), 'Model 1');
        await select('current'); assert.equal(await first.textContent(), 'Model 3');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(app.state.requests.some(request => /save_personal_pie|vote|update/.test(request.path)), false);
        assert.deepEqual(errors, []);
        await mkdir(output, { recursive: true });
        await page.screenshot({ path: `${output}/${engine.name()}-${width}${built ? '-built' : ''}.png` });
        await page.getByRole('combobox', { name: 'Test estimation algorithm', exact: true }).click();
        assert.equal(await page.getByRole('option').count(), 6);
        await page.screenshot({ path: `${output}/${engine.name()}-${width}${built ? '-built' : ''}-algorithms.png` });
    });
}
