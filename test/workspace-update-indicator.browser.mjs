import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';

const launch = { headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' } };
const output = 'D:/Codex-artifacts/website1/workspace-update-indicator-20261101';
for (const engine of [chromium, webkit]) for (const width of [390, 1440]) {
    test(`${engine.name()} ${width}: topic update icon stays aligned, fades, and never reports failed updates as complete`, async t => {
        const app = await startPreview(), browser = await engine.launch(launch);
        t.after(async () => { await browser.close(); await app.close(); });
        const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width < 760 });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        let fail = false;
        await page.route('**/api/get_weighted_workspace', async route => {
            await new Promise(resolve => setTimeout(resolve, 300));
            if (fail) await route.fulfill({ status: 400, json: { error: 'invalid_request' } });
            else await route.continue();
        });
        await page.goto(app.url + '/Intelligence');
        const indicator = page.locator('#workspace-update-indicator');
        await page.waitForFunction(() => document.querySelector('#workspace-update-indicator')?.dataset.phase === 'complete');
        await page.waitForFunction(() => document.querySelector('#workspace-update-indicator').dataset.phase === 'idle');
        await page.locator('#workspace-refresh').click();
        await page.waitForFunction(() => document.querySelector('#workspace-update-indicator').dataset.phase === 'pending');
        const geometry = await indicator.evaluate(node => {
            const title = node.previousElementSibling.getBoundingClientRect(), box = node.getBoundingClientRect();
            const ring = node.querySelector('i'), style = getComputedStyle(ring);
            return { adjacent: box.x >= title.right && box.x - title.right < 12,
                aligned: Math.abs(box.y + box.height / 2 - title.y - title.height / 2) < 2,
                width: style.width, height: style.height, glyph: getComputedStyle(ring, '::before').content,
                overflow: document.documentElement.scrollWidth > innerWidth + 1 };
        });
        assert.equal(geometry.adjacent, true, JSON.stringify(geometry));
        assert.equal(geometry.aligned, true, JSON.stringify(geometry));
        assert.equal(geometry.width, geometry.height);
        assert.ok(['none', 'normal'].includes(geometry.glyph));
        assert.equal(geometry.overflow, false);
        assert.equal(await page.locator('#last-updated').isVisible(), false);
        await page.waitForFunction(() => document.querySelector('#workspace-update-indicator').dataset.phase === 'complete');
        await mkdir(output, { recursive: true });
        await page.screenshot({ path: `${output}/${engine.name()}-${width}.png` });
        await page.waitForFunction(() => document.querySelector('#workspace-update-indicator').dataset.phase === 'fading');
        await page.waitForFunction(() => document.querySelector('#workspace-update-indicator').dataset.phase === 'idle');
        fail = true;
        await page.locator('#workspace-refresh').click();
        await page.locator('#last-updated').waitFor();
        assert.equal(await indicator.getAttribute('data-phase'), 'idle');
        assert.match(await page.locator('#last-updated').textContent(), /Could not load/);
        assert.deepEqual(errors, []);
    });
}
