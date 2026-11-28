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
        app.state.communityEstimationVotes = [{ targetConditionID: 1, sourceConditionID: 3, supportCount: 3, opposeCount: 1 }];
        const bridgeSetting = { harness: 'bridge' };
        app.state.comparisonModels = [calibrationModel(1, { 2: 100, 901: 85, 902: 50, 903: 88 }),
            calibrationModel(3, { 1: 70, 2: 80, 3: 40 }, { harness: 'other' }), ...pairedModels(1, 901, 85, -10),
            calibrationModel(4, { 2: 100, 3: 100, 903: 50 }, bridgeSetting),
            calibrationModel(5, { 903: 50, 902: 80 }, bridgeSetting),
            calibrationModel(6, { 902: 80, 1: 75 }, bridgeSetting),
            calibrationModel(7, { 2: 55 }),
            ...[30, 40, 50, 60, 70, 80].map((value, index) => calibrationModel(1201 + index, { 1: value, 3: value + 10 })),
            ...[-9, -7, -5, -3, -1, 1, 3, 5, 7, 9].map((step, index) => calibrationModel(1101 + index,
                { 1: 60 + step, 902: 50 + step }))];
        app.state.publicWeights = [{ conditionID: 1, weightBasisPoints: 4000 }, { conditionID: 2, weightBasisPoints: 4000 },
            { conditionID: 3, weightBasisPoints: 2000 }];
        app.state.personalEntries = weightedEntries(app.state.publicWeights);
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => sessionStorage.setItem('benchpoll-workspace-preferences-v1', '{"scoreMode":"range"}'));
        if (built) await page.route(app.url + '/1', async route => route.fulfill({ contentType: 'text/html',
            body: await readFile('private/home-built.html', 'utf8') }));
        const initial = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace'));
        await page.goto(app.url + '/1');
        const response = await initial;
        assert.equal(response.request().postDataJSON().scoreMode, undefined);
        const data = await response.json();
        await page.waitForSelector('.bp-model-row');
        if (width < 760) await page.locator('[data-mobile-panel="models"]').click();
        if (built) assert.ok(await page.locator('script[src^="/build/home/"]').count());

        assert.equal(await page.locator('[data-score-mode], #estimation-method-control, .bp-score-uncertain').count(), 0);
        if (width > 1000) {
            const layout = await page.evaluate(() => {
                const rect = selector => document.querySelector(selector).getBoundingClientRect();
                return { heading: rect('.bp-page-heading').toJSON(), actions: rect('.bp-context-actions').toJSON(),
                    account: rect('.bp-config-header-account').toJSON() };
            });
            assert.ok(layout.actions.top < layout.heading.bottom && layout.actions.bottom > layout.heading.top);
            assert.ok(layout.heading.right <= layout.actions.left && layout.actions.right <= layout.account.left);
            const wrapsWhenNarrow = await page.locator('.bp-workspace-heading-content').evaluate(content => {
                content.style.maxWidth = '280px';
                const { bottom } = content.querySelector('.bp-page-heading').getBoundingClientRect();
                const { top } = content.querySelector('.bp-context-actions').getBoundingClientRect();
                content.style.removeProperty('max-width');
                return top >= bottom;
            });
            assert.equal(wrapsWhenNarrow, true);
        }
        if (width < 760) {
            await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.querySelector('.bp-model-head')).top)
                - document.querySelector('.bp-model-controls').getBoundingClientRect().height) < 1);
        }
        await mkdir(output, { recursive: true });

        assert.equal(data.estimationAlgorithm, 'current');
        assert.equal(data.scoreMode, 'available');
        const estimated = data.modelLeaderboards.public.find(row => row.modelID === 1);
        assert.equal(estimated.coverage, 40);
        assert.equal(estimated.availableInference.unresolvedFraction, 0);
        assert.equal(estimated.inferredScores.length, 2);
        const [estimate, treemap] = estimated.inferredScores;
        assert.deepEqual([treemap.conditionID, treemap.estimationMethod, treemap.originalWeight], [3, 'treemap-chain', 20]);
        assert.equal(estimated.lower, Number((40 + .4 * estimate.normalizedScore + .2 * treemap.normalizedScore).toFixed(2)));
        assert.ok(treemap.sources.every(source => source.calibrationPaths[0].at(-1).supportRate === .75));
        const tileScore = String(Number(treemap.normalizedScore.toFixed(2)));
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
            const icon = page.locator('.bp-model-coverage-overlay [data-object-id="1"] .bp-estimate-icon-link');
            assert.equal(await icon.getAttribute('href'), '/how-it-works#calibration');
            const treemapTile = page.locator('.bp-model-coverage-overlay [data-object-id="3"].is-treemap-estimate');
            assert.equal(await treemapTile.locator('[data-estimated-score]').textContent(), tileScore);
            assert.equal(await treemapTile.locator('.bp-estimate-icon-link').getAttribute('href'), '/how-it-works#treemap-estimates');
            assert.match(await treemapTile.getAttribute('data-tooltip'), /Treemap estimate on 100% of the weight/);
        }
        await row.click();
        await page.waitForSelector('#model-scores-dialog:not([hidden])');
        const summary = await page.locator('#model-scores-summary').innerText();
        const evidence = page.locator('#model-scores-list .bp-model-inferred-row[data-estimation-method="joint-versions"]');
        const treemapEvidence = page.locator('#model-scores-list .bp-model-inferred-row[data-estimation-method="treemap-chain"]');
        assert.match(summary, /Measured results cover 40%/);
        assert.match(summary, /20\.00% uses calibrated version chains across the treemap/);
        assert.doesNotMatch(summary, /adjustment|penalty|fallback chain/);
        assert.equal(await evidence.count(), 1);
        const versionMethod = evidence.getByRole('link', { name: 'Version estimate. How it works', exact: true });
        assert.equal(await versionMethod.getAttribute('href'), '/how-it-works#calibration');
        assert.equal(await versionMethod.locator('.fa-code-branch').count(), 1);
        assert.equal(await evidence.getByRole('link', { name: /General knowledge, Default benchmark version/ }).count(), 1);
        assert.equal(await evidence.locator('.bp-model-score-detail-value').textContent(), '62.32');
        assert.match(await evidence.innerText(), /40\.00% of total weight/);
        assert.equal(await evidence.getByText('24.93 points added to total', { exact: true }).count(), 1);
        assert.equal(await evidence.getByText(/points added to total/).count(), 1);
        assert.equal(await treemapEvidence.getByText('Treemap estimate', { exact: true }).count(), 1);
        assert.equal(await treemapEvidence.locator('.bp-model-estimate-method').getAttribute('href'), '/how-it-works#treemap-estimates');
        assert.equal(await treemapEvidence.locator('.bp-model-score-detail-value').textContent(), treemap.normalizedScore.toFixed(2));
        assert.equal(await treemapEvidence.getByText(`${treemap.contribution.toFixed(2)} points added to total`, { exact: true }).count(), 1);
        assert.match(await treemapEvidence.innerText(), /75% support/);
        assert.match(await treemapEvidence.innerText(), /Share of estimate/);
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
            const tile = page.locator('.bp-model-coverage-figure [data-object-id="3"].is-treemap-estimate');
            assert.equal(await tile.locator('[data-estimated-score]').textContent(), tileScore);
            assert.equal(await tile.locator('.bp-estimate-icon-link').getAttribute('href'), '/how-it-works#treemap-estimates');
            assert.match(await page.locator('.bp-model-coverage-figure figcaption').textContent(), /Tap an estimate icon/);
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

        await page.locator('.bp-model-row').filter({ has: page.getByText('Model 7', { exact: true }) }).click();
        const peer = page.locator('#model-scores-list .bp-model-inferred-row[data-estimation-method="peer-median"][data-condition-id="3"]');
        await peer.getByText('Peer median', { exact: true }).waitFor();
        const peerLink = peer.getByRole('link', { name: 'Peer median. How it works', exact: true });
        assert.equal(await peerLink.getAttribute('href'), '/how-it-works#peer-median');
        await peerLink.hover();
        const tooltip = page.locator('#bp-help-popover');
        await tooltip.waitFor({ state: 'visible' });
        assert.match(await tooltip.innerText(), /A version estimate converts[\s\S]*A treemap estimate follows[\s\S]*A peer median uses[\s\S]*Click to read more in How it works/);
        assert.match(await peer.innerText(), /Median from \d+ other models on this version/);
        if (width < 760) {
            assert.equal(await page.locator('.bp-model-coverage-figure [data-object-id="3"].is-peer-median').count(), 1);
            const icon = page.locator('.bp-model-coverage-figure [data-object-id="3"] .bp-estimate-icon-link');
            assert.equal(await icon.getAttribute('href'), '/how-it-works#peer-median');
            assert.equal(await icon.locator('text').textContent(), '\uf0c0');
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(app.state.requests.some(request => /save_personal_pie|vote|update/.test(request.path)), false);
        if (width < 760) {
            await page.locator('.bp-model-coverage-figure [data-object-id="3"] .bp-estimate-icon-link').click();
            await page.waitForURL('**/how-it-works#peer-median');
            assert.equal(await page.locator('#peer-median').count(), 1);
        } else {
            await page.locator('.bp-model-scores-close').click();
            await row.hover();
            const icon = page.locator('.bp-model-coverage-overlay [data-object-id="3"] .bp-estimate-icon-link');
            await icon.hover();
            await page.waitForFunction(() => document.getElementById('bp-help-popover').textContent.includes('Click to read more in How it works'));
            await icon.click();
            await page.waitForURL('**/how-it-works#treemap-estimates');
        }
        assert.deepEqual(errors, []);
    });
}
