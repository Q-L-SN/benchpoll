import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
import { calibrationModel, pairedModels } from './helpers/fallback-pairs.mjs';
import { secondaryBenchmark, weightedEntries } from '../scripts/frontend/fixtures.mjs';

const built = process.env.BP_TEST_BUILT === '1';
const output = process.env.BP_ESTIMATION_OUTPUT ?? '/tmp/benchpoll-estimation-method';
const engines = built ? [[chromium, 390]] : [[chromium, 1440], [chromium, 390], [chromium, 320], [webkit, 390]];
for (const [engine, width] of engines) {
    test(`version-based estimation ${engine.name()} ${width} ${built ? 'built' : 'source'}`, { timeout: 60000 }, async t => {
        const app = await startPreview({ estimationSources: true, secondaryBenchmark: true });
        let browser;
        t.after(async () => { await browser?.close(); await app.close(); });
        browser = await engine.launch({ headless: true });
        const challengeVersion = 'Challenge set with long-context prompts';
        app.state.additionalBenchmarkVersions = [
            { ...secondaryBenchmark, ID: 902, conditionID: 902, conditionKey: 'challenge', conditionName: challengeVersion },
            { ...secondaryBenchmark, ID: 903, conditionID: 903, conditionKey: 'diagnostic', conditionName: 'Diagnostic' }
        ];
        const bridgeSetting = { harness: 'bridge' };
        app.state.comparisonModels = [calibrationModel(1, { 2: 100, 901: 85, 902: 50, 903: 88 }),
            calibrationModel(3, { 1: 70, 2: 80, 3: 40 }), ...pairedModels(1, 901, 85, -10),
            calibrationModel(4, { 2: 100, 3: 100, 903: 50 }, bridgeSetting),
            calibrationModel(5, { 903: 50, 902: 80 }, bridgeSetting),
            calibrationModel(6, { 902: 80, 1: 75 }, bridgeSetting),
            ...[-9, -7, -5, -3, -1, 1, 3, 5, 7, 9].map((step, index) => calibrationModel(1101 + index,
                { 1: 60 + step, 902: 50 + step }))];
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
        assert.match(await page.getByRole('button', { name: 'About the estimation method' }).getAttribute('data-help-text'), /Nominated external versions can supply an estimate/);
        assert.equal(await method.locator('.bp-ui-select-value').evaluate(node => node.scrollWidth <= node.clientWidth), true);
        await method.click();
        assert.equal(await page.getByRole('option').count(), 1);
        await mkdir(output, { recursive: true });
        await page.screenshot({ path: `${output}/${engine.name()}-${width}${built ? '-built' : ''}-method.png` });
        await option.click();

        assert.equal(data.estimationAlgorithm, 'current');
        const estimated = data.modelLeaderboards.public.find(row => row.modelID === 1);
        assert.equal(estimated.lower, 64.93);
        assert.equal(estimated.coverage, 40);
        assert.ok(Math.abs(estimated.availableInference.unresolvedFraction - .2) < 1e-9);
        assert.equal(estimated.inferredScores.length, 1);
        const [estimate] = estimated.inferredScores;
        assert.deepEqual([estimate.conditionID, estimate.selection, estimate.originalWeight, estimate.effectiveWeight], [1, 'automatic', 40, 40]);
        assert.equal(Object.hasOwn(estimate, 'sourceConditionID'), false);
        assert.equal(Object.hasOwn(estimate, 'referenceCount'), false);
        assert.equal(estimate.estimationMethod, 'joint-versions');
        assert.deepEqual(estimate.sources, [
            { sourceConditionID: 901, sourceScore: 85, referenceCount: 5 },
            { sourceConditionID: 902, sourceScore: 50, referenceCount: 10 }
        ]);
        const row = page.locator('.bp-model-row').filter({ has: page.getByText('Model 1', { exact: true }) });
        if (width >= 760) {
            await row.hover();
            const tile = page.locator('.bp-model-coverage-overlay [data-object-id="1"] [data-estimated-score]');
            assert.equal(await tile.textContent(), '62.32');
        }
        await row.click();
        await page.waitForSelector('#model-scores-dialog:not([hidden])');
        const summary = await page.locator('#model-scores-summary').innerText();
        const evidence = page.locator('#model-scores-list .bp-model-inferred-row');
        assert.match(summary, /measured results cover 40%/);
        assert.match(summary, /20\.00% of the weight has no measurement or estimate and counts as 0 at its full weight/);
        assert.doesNotMatch(summary, /adjustment|penalty|fallback chain/);
        assert.equal(await evidence.count(), 1);
        assert.equal(await evidence.getByRole('link', { name: /General knowledge, Default benchmark version/ }).count(), 1);
        assert.equal(await evidence.locator('.bp-model-score-detail-value').textContent(), '62.32');
        assert.match(await evidence.innerText(), /40\.00% of total weight/);
        assert.equal(await evidence.getByText('24.93 points added to total', { exact: true }).count(), 1);
        assert.equal(await evidence.getByText(/points added to total/).count(), 1);
        const sources = evidence.getByRole('list', { name: 'Versions used for this estimate' }).getByRole('listitem');
        assert.equal(await sources.count(), 2);
        const [extended, challenge] = [sources.nth(0), sources.nth(1)];
        const names = [
            extended.getByRole('link', { name: /General knowledge, Extended/ }),
            challenge.getByRole('link', { name: `Information and discussion for General knowledge, ${challengeVersion}`, exact: true })
        ];
        assert.deepEqual(await Promise.all(names.map(async link => new URL(await link.getAttribute('href'), app.url).searchParams.get('conditionID'))),
            ['901', '902']);
        assert.match(await extended.innerText(), /5 paired models per run setting/);
        assert.match(await challenge.innerText(), /10 paired models per run setting/);
        assert.deepEqual(await evidence.locator('dl').evaluateAll(nodes => nodes.map(dl => [...dl.querySelectorAll('dd')].map(value => value.textContent))),
            [['85.00'], ['50.00']]);
        if (width < 760) {
            assert.equal(await page.locator('.bp-model-coverage-figure [data-object-id="1"] [data-estimated-score]').textContent(), '62.32');
        }
        assert.equal(await evidence.evaluate(node => [node.parentElement, node, ...node.querySelectorAll('li, dl')]
            .every(item => item.scrollWidth <= item.clientWidth)), true);
        await evidence.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${output}/${engine.name()}-${width}${built ? '-built' : ''}-evidence.png` });
        const search = page.getByRole('searchbox', { name: 'Search scores in this ranking' });
        await search.fill('long-context prompts');
        assert.equal(await evidence.isVisible(), true);
        assert.equal(await page.locator('#model-scores-list details.bp-model-score-detail-row:visible').count(), 0);
        await page.keyboard.press('Escape');

        const bridged = data.modelLeaderboards.public.find(row => row.modelID === 4);
        assert.deepEqual([bridged.lower, bridged.coverage], [90, 60]);
        await page.locator('.bp-model-row').filter({ has: page.getByText('Model 4', { exact: true }) }).click();
        const path = evidence.locator('.bp-model-estimate-version');
        await path.waitFor({ state: 'visible' });
        assert.deepEqual(await path.getByRole('link').evaluateAll(links => links.map(link => new URL(link.href).searchParams.get('conditionID'))),
            ['903', '902', '1']);
        assert.equal((await path.innerText()).match(/1 paired model\)/g)?.length, 2);
        assert.equal(await evidence.locator('.bp-model-score-detail-value').textContent(), '75.00');
        assert.equal(await evidence.locator('dd').textContent(), '50.00');
        if (width < 760) assert.equal(await page.locator('.bp-model-coverage-figure [data-object-id="1"] [data-estimated-score]').textContent(), '75');
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
