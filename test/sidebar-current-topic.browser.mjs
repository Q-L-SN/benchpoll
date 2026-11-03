import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startConfigSidebarPreview } from './helpers/config-sidebar-fixture-20261022.mjs';

for (const engine of [chromium, webkit]) for (const width of [390, 1440]) test(`${engine.name()} sidebar opens at current topic without scrolling animation at ${width}`, async t => {
    const app = await startConfigSidebarPreview(), browser = await engine.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'no-preference' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await browser.close(); await app.close(); assert.deepEqual(errors, []); });
    app.state.navigationEmpty = true;
    app.topics.push(...Array.from({ length: 60 }, (_, i) => ({ ID: 2000 + i, name: 'Directory topic ' + i, slug: 'directory-topic-' + i, popularity: 1 })));
    await page.addInitScript(() => localStorage.setItem('benchpoll:config-sidebar-collapsed', 'true'));
    await page.goto(app.url + '/directory-topic-48');
    await page.waitForSelector('#tree-content [data-category-id="2048"]', { state: 'attached' });
    await page.waitForFunction(() => document.querySelector('#tree-content [data-category-id="2048"]')?.getAttribute('aria-current') === 'page');
    assert.equal(await page.locator('#personal-pie-create').innerText(), 'Rank AI your way');
    await page.evaluate(() => {
        const viewport = document.querySelector('.bp-taxonomy'); viewport.scrollTop = 0;
        document.getElementById('config-sidebar').addEventListener('sidebar:beforeopen', () => {
            window.openingScroll = viewport.scrollTop; window.scrollFrames = [];
            let count = 0;
            const record = () => { window.scrollFrames.push(viewport.scrollTop); if (++count < 24) requestAnimationFrame(record); };
            requestAnimationFrame(record);
        });
    });
    await page.locator(width <= 760 ? '#taxonomy-toggle' : '#config-sidebar-toggle').click();
    await page.waitForFunction(() => window.scrollFrames?.length >= 24);
    const position = await page.evaluate(() => {
        const card = document.querySelector('#tree-content [aria-current="page"]').getBoundingClientRect();
        const viewport = document.querySelector('.bp-taxonomy').getBoundingClientRect();
        return { opening: window.openingScroll, frames: window.scrollFrames, visible: card.top >= viewport.top - 1 && card.bottom <= viewport.bottom + 1 };
    });
    assert.ok(position.opening > 1000, 'the scroll offset is already set before opening');
    assert.ok(position.frames.every(value => Math.abs(value - position.opening) < 1), 'the opening frames have a fixed scroll offset');
    assert.equal(position.visible, true);
    await mkdir('artifacts/scene-community-20261103', { recursive: true });
    await page.screenshot({ path: `artifacts/scene-community-20261103/sidebar-current-${engine.name()}-${width}.png` });
});
