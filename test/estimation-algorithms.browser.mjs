import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
import { calibrationModel, pairedModels } from './helpers/fallback-pairs.mjs';
import { weightedEntries } from '../scripts/frontend/fixtures.mjs';

const built = process.env.BP_TEST_BUILT === '1';
const output = process.env.BP_ESTIMATION_OUTPUT ?? '/tmp/benchpoll-estimation-method';
const engines = built ? [[chromium, 390]] : [[chromium, 1440], [chromium, 390], [chromium, 320], [webkit, 390]];
for (const [engine, width] of engines) {
    test(`version-based estimation ${engine.name()} ${width} ${built ? 'built' : 'source'}`, { timeout: 60000 }, async t => {
        const app = await startPreview({ estimationSources: true, secondaryBenchmark: true });
        const browser = await engine.launch({ headless: true });
        t.after(async () => { await browser.close(); await app.close(); });
        app.state.comparisonModels = [calibrationModel(1, { 2: 100, 901: 85 }), calibrationModel(3, { 1: 70, 2: 80, 3: 40 }),
            ...pairedModels(1, 901, 85, -10)];
        app.state.publicWeights = [{ conditionID: 1, weightBasisPoints: 4000 }, { conditionID: 2, weightBasisPoints: 4000 },
            { conditionID: 3, weightBasisPoints: 2000 }];
        app.state.personalEntries = weightedEntries(app.state.publicWeights);
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => sessionStorage.setItem('benchpoll-estimation-test-v1', 'missing-midpoint'));
        if (built) await page.route(app.url + '/1', async route => route.fulfill({ contentType: 'text/html',
            body: await readFile('private/home-built.html', 'utf8') }));
        const waitForRanking = mode => page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace')
            && response.request().postDataJSON().scoreMode === mode);
        const initial = waitForRanking('available');
        await page.goto(app.url + '/1');
        const data = await (await initial).json();
        await page.waitForSelector('.bp-model-row');
        if (width < 760) await page.locator('[data-mobile-panel="models"]').click();
        if (built) assert.ok(await page.locator('script[src^="/build/home/"]').count());

        const method = page.getByRole('combobox', { name: 'Estimation method', exact: true });
        const option = page.getByRole('option', { name: 'Version-based estimation', exact: true });
        assert.equal(await method.isVisible(), true);
        assert.equal(await page.locator('#estimation-algorithm').inputValue(), 'current');
        assert.equal(await method.locator('.bp-ui-select-value').evaluate(node => node.scrollWidth <= node.clientWidth), true);
        await method.click();
        assert.equal(await page.getByRole('option').count(), 1);
        await mkdir(output, { recursive: true });
        await page.screenshot({ path: `${output}/${engine.name()}-${width}${built ? '-built' : ''}-method.png` });
        await option.click();

        assert.equal(data.estimationAlgorithm, 'current');
        const estimated = data.modelLeaderboards.public.find(row => row.modelID === 1);
        assert.equal(estimated.lower, 70);
        assert.equal(estimated.coverage, 40);
        assert.ok(Math.abs(estimated.availableInference.unresolvedFraction - .2) < 1e-9);
        assert.deepEqual(estimated.inferredScores.map(item => [item.sourceConditionID, item.sourceScore, item.normalizedScore,
            item.referenceCount, item.originalWeight, item.effectiveWeight]), [[901, 85, 75, 5, 40, 40]]);
        const row = page.locator('.bp-model-row').filter({ has: page.getByText('Model 1', { exact: true }) });
        await row.click();
        await page.waitForSelector('#model-scores-dialog:not([hidden])');
        const summary = await page.locator('#model-scores-summary').innerText();
        const evidence = await page.locator('#model-scores-list .bp-model-inferred-row').innerText();
        assert.match(summary, /measured results cover 40%/);
        assert.match(summary, /20\.00% of the weight has no reliable estimate and counts as 0 at its full weight/);
        assert.doesNotMatch(summary, /adjustment|penalty|fallback chain/);
        assert.match(evidence, /Extended/);
        assert.match(evidence, /85 measured/);
        assert.match(evidence, /5 paired models/);
        assert.match(evidence, /Validation error 0\.00 points/);
        assert.match(evidence, /30\.00 points added to total/);
        await page.keyboard.press('Escape');

        const rangeResponse = waitForRanking('range');
        await page.getByRole('button', { name: 'Score range', exact: true }).click();
        const rangeData = await (await rangeResponse).json();
        await page.waitForSelector('#estimation-method-control[hidden]', { state: 'attached' });
        const range = rangeData.modelLeaderboards.public.find(row => row.modelID === 1);
        assert.deepEqual([range.lower, range.upper, range.coverage, range.inferredScores], [40, 100, 40, []]);
        const availableResponse = waitForRanking('available');
        await page.getByRole('button', { name: 'Estimated score', exact: true }).click();
        await availableResponse;
        await method.waitFor({ state: 'visible' });
        assert.equal(await page.locator('#estimation-algorithm').inputValue(), 'current');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(app.state.requests.some(request => /save_personal_pie|vote|update/.test(request.path)), false);
        assert.deepEqual(errors, []);
    });
}
