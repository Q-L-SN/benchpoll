import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';
import { weightedEntries, models, benchmarks } from './fixtures.mjs';

const app = await startPreview({ personalEntries: weightedEntries([{ conditionID: 1, weightBasisPoints: 10000 }]) });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, reducedMotion: 'reduce' });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const output = 'artifacts/ui-readability';
await mkdir(output, { recursive: true });
try {
    await page.goto(app.url);
    await page.locator('.bp-model-row').first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.locator('#beta-feedback-link').hover();
    assert.equal(await page.locator('#beta-feedback-link').evaluate(el => getComputedStyle(el).textDecorationLine), 'none');
    assert.equal(await page.locator('#beta-feedback-link span').evaluate(el => getComputedStyle(el).textDecorationLine), 'underline');
    assert.equal(await page.locator('.bp-type-trigger, .bp-type-dialog').count(), 0);
    await page.evaluate(() => localStorage.setItem('benchpoll-typography-v1', JSON.stringify({ body: 'dm-sans', headline: 'newsreader' })));
    await page.screenshot({ path: `${output}/typography.png` });
    await page.reload();
    await page.locator('.bp-model-row').first().waitFor();
    assert.match(await page.locator('body').evaluate(el => getComputedStyle(el).fontFamily), /Manrope/);
    assert.match(await page.locator('.bp-page-heading h1').evaluate(el => getComputedStyle(el).fontFamily), /Manrope/);
    assert.equal(await page.locator('.bp-page-heading h1').evaluate(el => getComputedStyle(el).fontWeight), '800');
    assert.equal(await page.locator('.bp-type-trigger, .bp-type-dialog').count(), 0);
    await page.locator('#pie-mode-personal').click();
    await page.locator('#pie-adjustment-status').waitFor();
    assert.match(await page.locator('#pie-adjustment-instruction').innerText(), /Add another benchmark/);
    const before = app.state.requests.filter(r => r.path.includes('save_personal')).length;
    await page.locator('#weight-pie').hover();
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(500);
    assert.equal(app.state.requests.filter(r => r.path.includes('save_personal')).length, before);
    await page.screenshot({ path: `${output}/single-benchmark.png` });
    for (const width of [1440, 768, 760, 430, 390, 320]) {
        await page.setViewportSize({ width, height: 950 });
        await page.goto(app.url);
        await page.locator('.bp-model-row').first().waitFor({ state: 'attached' });
        await page.evaluate(() => document.fonts.ready);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        if (width <= 760) {
            const card = await page.locator('#pie-card').boundingBox();
            const shell = await page.locator('.bp-left-workspace').boundingBox();
            assert.ok(Math.abs(card.width - shell.width) < 2, `Pie must fill mobile column at ${width}: ${card.width}/${shell.width}`);
        }
        await page.screenshot({ path: `${output}/home-${width}.png` });
        if (width <= 760) await page.locator('[data-mobile-panel="models"]').click();
        await page.locator('.bp-model-row').first().click();
        await page.locator('.bp-model-score-sample').first().waitFor();
        assert.equal(await page.locator('.bp-model-score-sample').count(), 10);
        assert.match(await page.locator('.bp-model-score-sample-value').first().innerText(), /88%/);
        assert.equal(await page.locator('.bp-model-score-sample .bp-row-edit-action').first().getAttribute('href'), '/contribute/scores/501/edit');
        await page.locator('#model-scores-search').fill('Mathematics');
        assert.equal(await page.locator('.bp-model-score-detail-row:visible').count(), 1);
        await page.locator('#model-scores-search').fill('');
        await page.locator('#model-scores-expand').click();
        assert.equal(await page.locator('#model-scores-list details[open]').count(), 0);
        await page.locator('#model-scores-expand').click();
        const list = page.locator('#model-scores-list');
        assert.ok(await list.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
        await page.screenshot({ path: `${output}/scores-${width}.png` });
        await page.locator('.bp-model-score-sample').last().scrollIntoViewIfNeeded();
        const last = await page.locator('.bp-model-score-sample-value').last().boundingBox();
        assert.ok(last.x >= 0 && last.x + last.width <= width);
    }
    for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 950 });
        await page.goto(`${app.url}/how-it-works`);
        await page.evaluate(() => document.fonts.ready);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.screenshot({ path: `${output}/guide-${width}.png`, fullPage: width < 760 });
        await page.locator('#how-expand-rules').click();
        assert.equal(await page.locator('.bp-how-rule-answers details[open]').count(), 10);
        await page.locator('#how-expand-rules').click();
        assert.equal(await page.locator('.bp-how-rule-answers details[open]').count(), 0);
    }
    app.state.comparisonModels = [0, 1].map(index => ({ ...models[index], modelID: 301, modelName: 'Aster Pro',
        condition: { name: '', parameters: {}, scoreFields: [] },
        results: new Map(benchmarks.map(item => [String(item.conditionID), { normalizedScore: 50 + index * 10 }])) }));
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.goto(app.url);
    await page.locator('.bp-model-row').first().click();
    await page.locator('.bp-model-configuration-link').first().waitFor();
    assert.match(await page.locator('#model-scores-summary').innerText(), /2 recorded configurations/);
    await page.locator('#model-scores-expand').click();
    assert.equal(await page.locator('#model-scores-list details[open]').count(), 0);
    await page.locator('#model-scores-expand').click();
    await page.screenshot({ path: `${output}/comparison-scores.png` });
    await page.locator('.bp-model-configuration-link').first().click();
    await page.locator('.bp-model-score-sample').first().waitFor();
    await page.getByRole('button', { name: 'Back to comparison' }).click();
    await page.locator('.bp-model-configuration-link').first().waitFor();
    assert.deepEqual(errors, []);
    console.log('Readability checks passed: fixed Manrope typography, mobile pie width, single-benchmark guidance, source details/search/expand, guide rules, and Beta underline.');
} finally { await browser.close(); await app.close(); }
