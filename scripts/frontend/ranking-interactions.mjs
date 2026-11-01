import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';
import { weightedEntries, benchmarks } from './fixtures.mjs';

const output = 'artifacts/ranking-interactions-20261002';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];
const settle = page => page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(animation => animation.effect.getTiming().iterations !== Infinity)
        .map(animation => animation.finished.catch(() => {})));
});
try {
    for (const width of [1440, 390, 320]) {
        const app = await startPreview({ secondaryBenchmark: true, sparseBenchmark: true, saveDelay: 900 });
        const page = await browser.newPage({ viewport: { width, height: 1000 }, isMobile: width < 760, hasTouch: width < 760 });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route(url => ['/api/get_weighted_workspace', '/api/save_personal_pie'].includes(url.pathname), async route => {
            const response = await route.fetch();
            const data = await response.json();
            const fields = Array.from({ length: 100 }, (_, i) => ({ ID: i + 100, name: `Synthetic field ${i + 100}`,
                type: 'text', allowEmpty: true, excludeMissing: true, excludeEmpty: false, options: [] }));
            data.comparison.fields.push(...fields);
            data.comparison.availableKeys.push(...fields.map(field => `field:${field.ID}`));
            await route.fulfill({ response, json: data });
        });
        try {
            await page.goto(app.url);
            await page.locator('.bp-benchmark-row').first().waitFor();
            const other = page.locator('[aria-controls="benchmark-other-rows"]');
            const low = page.locator('[aria-controls="benchmark-low-rows"]');
            assert.equal(await other.getAttribute('aria-expanded'), 'false');
            assert.equal(await low.isVisible(), false);
            assert.equal(app.state.requests.some(request => request.path === '/api/get_ranking_page' && request.body.group === 'lowCoverage'), false);
            await other.click();
            await page.locator('#benchmark-other-rows [data-condition-id="901"]').waitFor();
            assert.equal(await low.getAttribute('aria-expanded'), 'false');
            assert.equal(await page.locator('#benchmark-low-rows [data-condition-id="900"]').count(), 0);
            await low.click();
            await page.locator('#benchmark-low-rows [data-condition-id="900"]').waitFor();
            assert.equal(await low.evaluate(node => Boolean(node.closest('#benchmark-other-rows'))), true);
            await settle(page); await page.screenshot({ path: `${output}/nested-${width}.png`, fullPage: true });
            await page.locator('#pie-mode-personal').click();
            const saved = page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie'));
            await page.locator('#benchmark-low-rows [data-condition-id="900"]').click();
            assert.equal(await page.locator('#benchmark-rows > [data-condition-id="900"]').isVisible(), true,
                'A newly weighted sparse condition must move outside disclosures immediately');
            await saved;
            await page.locator('#weight-pie g[data-object-id="900"]').click();
            assert.equal(await page.locator('#benchmark-rows > [data-condition-id="900"]').count(), 1);
            if (width < 760) await page.locator('[data-mobile-panel="models"]').click();
            await page.locator('#model-comparison-toggle').click();
            const keys = page.locator('#model-comparison-keys');
            assert.equal(await keys.locator('input').count(), 104);
            assert.equal(await keys.evaluate(node => node.clientHeight <= 184 && node.scrollHeight > node.clientHeight), true);
            await keys.locator('input').last().focus();
            assert.equal(await keys.evaluate(node => node.scrollTop > 0), true);
            await page.locator('.bp-filter-search').fill('synthetc field 119');
            assert.match(await page.locator('.bp-filter-search-results').innerText(), /Synthetic field 119/);
            await settle(page); await page.screenshot({ path: `${output}/filters-${width}.png`, fullPage: true });
            await page.locator('#model-comparison-close').click();
            await page.locator('.bp-model-row').first().click();
            assert.equal(await page.getByRole('button', { name: 'Used in this ranking', exact: true }).getAttribute('aria-pressed'), 'true');
            assert.equal(await page.locator('#model-scores-list .bp-model-score-detail-row').count(), 5);
            assert.equal(app.state.requests.some(request => request.path === '/api/get_approved_benchmark_results'), false,
                'Calculation is shown immediately without fetching unrelated scores');
            await settle(page); await page.screenshot({ path: `${output}/calculation-${width}.png`, fullPage: true });
            assert.equal(await page.locator('.bp-model-configuration-link').first().evaluate(node => getComputedStyle(node).display), 'grid');
            await page.locator('.bp-model-configuration-link').first().click();
            await page.locator('.bp-model-score-sample').first().waitFor();
            assert.equal(await page.locator('#model-scores-list .bp-model-score-detail-row').count(), 1);
            await page.getByRole('button', { name: 'All scores', exact: true }).click();
            await page.locator('.bp-model-score-sample').nth(9).waitFor();
            assert.equal(await page.locator('#model-scores-list .bp-model-score-detail-row').count(), 5);
            await page.getByRole('button', { name: 'Used in this ranking', exact: true }).click();
            assert.equal(await page.locator('.bp-model-score-sample').count(), 0);
            await page.route('**/api/get_model_score_configurations', async route => {
                const modelID = route.request().postDataJSON().modelIDs[0];
                await route.fulfill({ json: { configurations: [
                    { modelID, modelName: 'Aster Pro', configurationName: '', scoreFields: [], scoreCount: 10 },
                    { modelID, modelName: 'Aster Pro', configurationName: 'Harness=Agent A',
                        scoreFields: [{ fieldID: 1, value: 11 }], scoreCount: 10 }
                ] } });
            });
            await page.getByRole('button', { name: 'All scores', exact: true }).click();
            await page.getByRole('button', { name: /Harness=Agent A/ }).waitFor();
            await page.getByRole('button', { name: /Harness=Agent A/ }).click();
            await page.locator('.bp-model-score-sample').nth(9).waitFor();
            assert.deepEqual(app.state.requests.filter(request => request.path === '/api/get_approved_benchmark_results').at(-1).body.scoreFields,
                [{ fieldID: 1, value: 11 }], 'All scores includes configurations excluded from the current ranking');
            await page.getByRole('button', { name: 'Used in this ranking', exact: true }).click();
            await page.locator('#model-scores-dialog .dialog-close-button').click();
            assert.equal(await page.locator('.bp-score-uncertain').first().evaluate(node => getComputedStyle(node).borderRadius), '0px');
            assert.match(await page.locator('.bp-score-fill').first().evaluate(node => getComputedStyle(node).clipPath), /round 5px/);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            assert.deepEqual(errors, []);
            checks.push({ width, nested: true, optimistic: true, evidence: true, boundedFields: true, errors });
        } finally { await page.close(); await app.close(); }
    }
    for (const basisPoints of [299.9, 300]) {
        const publicWeights = benchmarks.filter(item => item.publicWeight).map(item => ({ conditionID: item.conditionID,
            weightBasisPoints: item.publicWeight * 100 - (item.conditionID === 1 ? basisPoints : 0) }));
        publicWeights.push({ conditionID: 900, weightBasisPoints: basisPoints });
        const app = await startPreview({ sparseBenchmark: true, publicWeights, personalEntries: weightedEntries([]) });
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
        try {
            await page.goto(app.url); await page.locator('.bp-benchmark-row').first().waitFor();
            assert.equal(await page.locator('#benchmark-rows > [data-condition-id="900"]').count(), basisPoints >= 300 ? 1 : 0);
            checks.push({ publicBasisPoints: basisPoints, passed: true });
        } finally { await page.close(); await app.close(); }
    }
    await writeFile(`${output}/frontend-checks.json`, JSON.stringify(checks, null, 2));
    console.log(JSON.stringify(checks));
} finally { await browser.close(); }
