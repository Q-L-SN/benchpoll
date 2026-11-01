import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';
import { models, weightedEntries } from './fixtures.mjs';

const output = 'artifacts/scoring-mode-samples-20261003/ui';
await mkdir(output, { recursive: true });
const weights = [{ conditionID: 1, weightBasisPoints: 5000 }, { conditionID: 2, weightBasisPoints: 5000 }];
const values = [{ 1: 40 }, { 1: 80 }, { 2: 65 }, { 1: 70, 2: 0 }];
const comparisonModels = models.slice(0, 4).map((item, index) => ({ ...item,
    modelName: item.name, condition: { parameters: { harness: 'same' }, scoreFields: [] },
    results: new Map(Object.entries(values[index]).map(([key, normalizedScore]) => [key, { normalizedScore }])) }));
const browser = await chromium.launch({ headless: true });
const checks = [];
function evidence(rows) {
    return rows.map(row => ({ ID: row.ID, comparable: row.comparable, coverage: row.coverage,
        samples: row.calculationScores.map(score => ({ conditionID: score.conditionID, normalizedScore: score.normalizedScore,
            weightBasisPoints: score.weightBasisPoints, fallbackFor: score.fallbackFor,
            memberIDs: score.memberIDs, memberWeights: score.memberWeights, matchedCount: score.matchedCount })) }))
        .sort((a, b) => a.ID - b.ID);
}
try {
    for (const width of [1440, 390]) {
        const app = await startPreview({ comparisonModels, publicWeights: weights, personalEntries: weightedEntries(weights) });
        const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        async function scoreMode(mode) {
            const pending = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace')
                && response.request().postDataJSON().scoreMode === mode);
            await page.locator(`[data-score-mode="${mode}"]`).click();
            const response = await pending;
            assert.equal(response.status(), 200);
            const payload = await response.json();
            await page.waitForFunction(() => document.querySelectorAll('.bp-model-row').length === 4
                && !document.querySelector('.bp-loading-state'));
            return payload;
        }
        try {
            await page.goto(app.url);
            await page.locator('.bp-model-row').first().waitFor({ state: 'attached' });
            if (width < 760) await page.locator('[data-mobile-panel="models"]').click();
            for (const pieMode of ['public', 'personal']) {
                if (width < 760) await page.locator('button[data-mobile-panel="mix"]').click();
                await page.locator(`#pie-mode-${pieMode}`).click();
                if (width < 760) await page.locator('button[data-mobile-panel="models"]').click();
                await page.locator('.bp-model-row').first().waitFor();
                for (const comparisonMode of ['best', 'matched']) {
                    await page.locator('#model-comparison-toggle').click();
                    const button = page.locator(`#model-comparison-mode [data-mode="${comparisonMode}"]`);
                    if (await button.getAttribute('aria-pressed') !== 'true') {
                        const pending = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace')
                            && response.request().postDataJSON().comparison?.mode === comparisonMode);
                        await button.click();
                        assert.equal((await pending).status(), 200);
                    }
                    await page.locator('#model-comparison-close').click();
                    const available = await scoreMode('available');
                    const range = await scoreMode('range');
                    const availableRows = available.modelLeaderboards[pieMode];
                    const rangeRows = range.modelLeaderboards[pieMode];
                    assert.deepEqual(evidence(rangeRows), evidence(availableRows));
                    assert.ok(rangeRows.every(row => row.comparable));
                    assert.equal(await page.locator('.bp-model-row.is-incomparable').count(), 0);
                    const partiallyCovered = rangeRows.find(row => row.coverage === 50 && row.lower === 40);
                    assert.ok(partiallyCovered);
                    assert.equal(partiallyCovered.upper, 90);
                    assert.equal(availableRows.find(row => row.ID === partiallyCovered.ID).lower, 80);
                    const name = partiallyCovered.name;
                    await page.getByRole('button', { name: `View approved scores for ${name}`, exact: true }).click();
                    assert.equal(await page.locator('.bp-model-score-detail-row').count(), 1);
                    await page.locator('#model-scores-dialog .dialog-close-button').click();
                    await page.screenshot({ path: `${output}/${pieMode}-${comparisonMode}-${width}.png`, fullPage: true });
                    checks.push({ width, pieMode, comparisonMode, identicalSamples: true, partialEvidenceShown: true });
                }
            }
            assert.deepEqual(errors, []);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            console.log(`PASS scoring sample invariance ${width}`);
        } finally { await page.close(); await app.close(); }
    }
    await writeFile(`${output}/results.json`, JSON.stringify(checks, null, 2));
} finally { await browser.close(); }
