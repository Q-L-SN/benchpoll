import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';

const app = await startPreview();
const browser = await chromium.launch({ headless: true });
const errors = [];
await mkdir('artifacts/palette', { recursive: true });
try {
    const context = await browser.newContext({ viewport: { width: 1677, height: 938 } });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('benchpoll-welcome-seen-v1', '1'));
    await page.goto(app.url);
    await page.locator('.bp-model-row').first().waitFor();
    const snapshot = () => page.evaluate(() => ({
        palette: document.documentElement.dataset.homePalette,
        stop: getComputedStyle(document.querySelector('#weight-pie stop')).stopColor,
        bar: getComputedStyle(document.querySelector('.bp-score-known')).backgroundColor,
        pie: document.querySelector('#weight-pie').innerHTML,
        names: [...document.querySelectorAll('.bp-model-name')].map(node => node.textContent)
    }));
    const orange = await snapshot();
    assert.equal(orange.palette, 'orange');
    assert.equal(orange.bar, 'rgb(255, 112, 30)');
    await page.screenshot({ path: 'artifacts/palette/orange-desktop.png', fullPage: true });
    await page.locator('[data-palette="berry"]').click();
    const berry = await snapshot();
    assert.equal(berry.palette, 'berry');
    assert.notEqual(orange.stop, berry.stop);
    assert.notEqual(orange.bar, berry.bar);
    assert.equal(orange.pie, berry.pie, 'Switching colors must not rebuild the pie');
    assert.deepEqual(orange.names, berry.names);
    await page.screenshot({ path: 'artifacts/palette/berry-desktop.png', fullPage: true });
    await page.reload();
    assert.equal(await page.locator('html').getAttribute('data-home-palette'), 'berry');
    for (const width of [390, 760, 1024]) {
        await page.setViewportSize({ width, height: 844 });
        for (const palette of ['orange', 'berry']) {
            await page.locator(`[data-palette="${palette}"]`).click();
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            await page.screenshot({ path: `artifacts/palette/${palette}-${width}.png`, fullPage: true });
        }
    }
    await page.goto(app.url + '/contribute/benchmarks/new');
    assert.equal(await page.locator('html').getAttribute('data-home-palette'), null);
    assert.equal(await page.locator('link[href*="home-palette"],script[src*="home-palette"]').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: default, both palettes, live SVG recoloring without data mutation, persistence, responsive layouts, other-page isolation, browser errors');
} finally {
    await browser.close();
    await app.close();
}
