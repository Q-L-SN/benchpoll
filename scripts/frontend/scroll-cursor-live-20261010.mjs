import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';

const output = 'artifacts/fallback-controls-20261009/cursor-reproduction';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
try {
    for (const repeat of [1, 2]) {
        const app = await startPreview();
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
        try {
            const page = await context.newPage();
            page.setDefaultTimeout(60000);
            await context.route('**/api/**', async route => {
                const url = new URL(route.request().url());
                await route.fulfill({ response: await route.fetch({ url: app.url + url.pathname + url.search }) });
            });
            await page.addInitScript(() => {
                globalThis.cursorEvents = [];
                for (const event of ['pointermove', 'pointerout', 'blur']) {
                    addEventListener(event, e => {
                        globalThis.cursorEvents.push({ event, target: e.target?.id || e.target?.className?.baseVal || e.target?.className,
                            x: e.clientX, y: e.clientY, pointerType: e.pointerType, related: e.relatedTarget?.id || e.relatedTarget?.className });
                    }, { capture: true });
                }
            });
            await page.goto('https://benchpoll.com/Intelligence', { waitUntil: 'domcontentloaded' });
            await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
            await page.locator('#pie-mode-personal').click();
            await page.locator('#pie-mode-personal[aria-selected="true"][aria-busy="false"]').waitFor();
            await page.locator('#weight-pie g[data-object-id="1"]').click();
            const row = page.locator('.bp-benchmark-row[data-condition-id="2"]');
            const box = await row.boundingBox();
            const point = { x: box.x + 4, y: box.y + box.height / 2 };
            await page.mouse.move(point.x, point.y);
            const sample = async label => page.evaluate(({ point, label }) => {
                const hit = document.elementFromPoint(point.x, point.y);
                return { label, hit: hit?.outerHTML.slice(0, 700), inWorkspace: Boolean(hit?.closest('.bp-left-workspace')),
                    excluded: hit?.closest('.bp-inline-fallback, .bp-benchmark-fallbacks, input, textarea, select, button, a, [contenteditable="true"], global-dialog, [role="dialog"]')?.outerHTML.slice(0, 300),
                    view: document.querySelector('.bp-left-workspace').dataset.workspaceView,
                    mode: document.querySelector('#pie-mode-personal').getAttribute('aria-selected'),
                    busy: document.querySelector('#benchmark-card').getAttribute('aria-busy'),
                    cursorCount: document.querySelectorAll('.bp-weight-wheel-target').length,
                    cursor: hit && getComputedStyle(hit).cursor,
                    events: globalThis.cursorEvents.slice(-10) };
            }, { point, label });
            const samples = [await sample('immediate')];
            await page.waitForFunction(() => document.querySelector('.bp-left-workspace').dataset.workspaceView === 'focus');
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            samples.push(await sample('after-layout'));
            const next = await row.boundingBox();
            await page.mouse.move(next.x + 8, next.y + next.height / 2);
            samples.push(await sample('moved-again'));
            await page.screenshot({ path: `${output}/repeat-${repeat}.png` });
            results.push({ repeat, samples,
                scriptURLs: await page.locator('script[src]').evaluateAll(nodes => nodes.map(node => node.src)) });
            await writeFile(`${output}/report.json`, JSON.stringify(results, null, 2));
            console.log(JSON.stringify(results.at(-1)));
        } finally { await context.close(); await app.close(); }
    }
    assert.ok(results.every(result => result.samples.at(-1).cursorCount > 0), 'Cursor did not activate after a fresh pointer move');
} finally { await browser.close(); }
