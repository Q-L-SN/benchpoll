import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
const output = process.env.BP_GUIDE_ARTIFACTS ?? '/tmp/benchpoll-guide';
await mkdir(output, { recursive: true });

for (const engine of [chromium, webkit]) for (const width of [1440, 390, 320]) {
    test(`${engine.name()} ${width}: visual guide, examples and linked details`, async t => {
        const fixture = await startPreview();
        const browser = await engine.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        t.after(async () => { await browser.close(); await fixture.close(); assert.deepEqual(errors, []); });
        await page.goto(fixture.url + '/how-it-works');
        await page.locator('.hi-column[aria-label]').first().waitFor();
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.locator('details[open]').count(), 0);
        assert.equal(await page.locator('#how-motion').isVisible(), false);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-hero.png` });
        await page.locator('[data-priority="coding"]').click();
        assert.equal(await page.locator('[data-demo-model="a"]').getAttribute('aria-label'), 'Rank 1: Model A');
        await page.locator('[data-priority="reasoning"]').click();
        assert.equal(await page.locator('[data-demo-model="b"]').getAttribute('aria-label'), 'Rank 1: Model B');
        assert.match(await page.locator('#how-demo-status').textContent(), /Reasoning priorities/);
        await page.locator('[data-how-score="range"]').click();
        assert.equal(await page.locator('#how-score-number').textContent(), '48–88');
        assert.equal(await page.locator('.hi-coverage strong').textContent(), '60%');
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-scores.png` });
        await page.locator('[data-how-score="estimate"]').click();
        assert.equal(await page.locator('#how-score-number').textContent(), '60');
        await page.evaluate(() => { location.hash = '#calculation-details'; });
        await page.waitForFunction(() => document.getElementById('calculation-details').closest('details').open);
        assert.equal(await page.locator('#calculation-details').isVisible(), true);
        await page.evaluate(() => { location.hash = '#fallback'; });
        await page.waitForFunction(() => document.querySelector('#fallback details').open);
        assert.match(await page.locator('#fallback .hi-answer').textContent(), /first available score counts/);
        await page.locator('#fallback summary').click();
        await page.waitForFunction(() => !document.querySelector('#fallback details').open);
        await page.locator('#fallback summary').focus(); await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('#fallback details').open);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        assert.equal(await page.locator('.bp-how-content h1, .bp-how-content h2').evaluateAll(nodes => nodes.some(node => node.textContent.includes(','))), false);
    });
}

test('guide animations can be paused and stop changing the example while it is being explored', async t => {
    const fixture = await startPreview(); const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
    t.after(async () => { await browser.close(); await fixture.close(); });
    await page.goto(fixture.url + '/how-it-works');
    await page.locator('#how-motion').waitFor();
    assert.ok(await page.evaluate(() => document.getAnimations().some(animation => animation.playState === 'running')));
    await page.locator('#how-motion').click();
    assert.equal(await page.locator('#how-motion').getAttribute('aria-label'), 'Play animations');
    await page.locator('[data-priority="coding"]').click();
    await page.waitForTimeout(5700);
    assert.equal(await page.locator('[data-priority="coding"]').getAttribute('aria-pressed'), 'true');
    await page.locator('#how-motion').click();
    await page.waitForFunction(() => document.querySelector('[data-priority="reasoning"]').getAttribute('aria-pressed') === 'true', null, { timeout: 7000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => document.body.dataset.motionPaused === 'true');
    assert.equal(await page.locator('#how-motion').isVisible(), false);
});
