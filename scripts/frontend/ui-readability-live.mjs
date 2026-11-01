import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, reducedMotion: 'reduce' });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
    const response = await page.goto('https://benchpoll.com/', { waitUntil: 'networkidle' });
    assert.equal(response.status(), 200);
    await page.locator('#model-comparison-toggle:not([disabled])').waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.fonts.check('16px Manrope')), true);
    assert.equal(await page.locator('.bp-type-trigger, .bp-type-dialog').count(), 0);
    await page.reload({ waitUntil: 'networkidle' });
    assert.match(await page.locator('body').evaluate(el => getComputedStyle(el).fontFamily), /Manrope/);
    assert.match(await page.locator('.bp-page-heading h1').evaluate(el => getComputedStyle(el).fontFamily), /Manrope/);
    assert.equal(await page.locator('.bp-page-heading h1').evaluate(el => getComputedStyle(el).fontWeight), '800');
    await page.screenshot({ path: 'artifacts/ui-readability/live-desktop.png' });
    let inspectedScores = false;
    if (await page.locator('.bp-model-row').count()) {
        await page.locator('.bp-model-row').first().click();
        await page.locator('.bp-model-score-detail-row').first().waitFor();
        if (!await page.locator('.bp-model-score-sample').count()) {
            await page.locator('#model-scores-list .bp-inline-link').first().click();
        }
        await page.locator('.bp-model-score-sample').first().waitFor();
        assert.ok((await page.locator('.bp-model-score-sample-value').first().innerText()).length > 0);
        await page.screenshot({ path: 'artifacts/ui-readability/live-scores.png' });
        inspectedScores = true;
        await page.locator('#model-scores-dialog .dialog-close-button').click();
    }
    for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        const pie = await page.locator('#pie-card').boundingBox();
        const column = await page.locator('.bp-left-workspace').boundingBox();
        assert.ok(Math.abs(pie.width - column.width) < 2);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.screenshot({ path: `artifacts/ui-readability/live-mobile-${width}.png` });
    }
    await page.goto('https://benchpoll.com/how-it-works', { waitUntil: 'networkidle' });
    await page.locator('#how-expand-rules').click();
    assert.equal(await page.locator('.bp-how-rule-answers details[open]').count(), 10);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ live: true, fonts: true, mobileWidths: [390, 320], inspectedScores, errors }));
} finally { await browser.close(); }
