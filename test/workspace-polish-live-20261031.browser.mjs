import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, devices } from 'playwright';

const output = 'D:/Codex-artifacts/website1/mobile-workspace-20261031/live';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
try {
    for (const width of [393, 1920]) {
        const context = await browser.newContext({ ...(width < 760 ? devices['iPhone 16'] : {}),
            viewport: { width, height: width < 760 ? 852 : 1000 }, reducedMotion: 'reduce' });
        try {
            const page = await context.newPage(), errors = [], writes = [];
            page.setDefaultTimeout(60000);
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/api/**', route => {
                const path = new URL(route.request().url()).pathname;
                if (/\/(?:save|create|delete|update|submit|cast|withdraw|accept)_/.test(path)) {
                    writes.push(path);
                    return route.abort();
                }
                return route.continue();
            });
            await page.goto('https://benchpoll.com/', { waitUntil: 'domcontentloaded' });
            await page.locator('.th-card[data-preview-state="loaded"] .th-model').first().waitFor();
            const href = await page.locator('.th-card-title a').first().getAttribute('href');
            const grid = await page.locator('#topics-grid').boundingBox();
            assert.ok(grid.width <= 1201);
            assert.ok(Math.abs(2 * grid.x + grid.width - width) < 1);
            await page.evaluate(() => scrollTo(0, document.getElementById('topics').offsetTop + 300));
            await page.locator('#topics-filters:not([hidden])').waitFor();
            await page.locator('#topics-score-toggle').click();
            const mode = await page.locator('#topics-score-toggle').getAttribute('aria-pressed');
            await page.locator('#topics-view-toggle').click();
            assert.equal(await page.locator('#topics-score-toggle').isVisible(), false);
            await page.waitForFunction(() => [...document.querySelectorAll('.th-card')].filter(card => {
                const bounds = card.getBoundingClientRect();
                return bounds.top < innerHeight && bounds.bottom > 150;
            }).every(card => card.dataset.previewState === 'loaded' && card.querySelector('.th-tile')));
            await page.screenshot({ path: `${output}/home-weights-${width}.png` });
            await page.locator('#topics-view-toggle').click();
            assert.equal(await page.locator('#topics-score-toggle').isVisible(), true);
            assert.equal(await page.locator('#topics-score-toggle').getAttribute('aria-pressed'), mode);
            await page.goto(new URL(href, 'https://benchpoll.com').href, { waitUntil: 'domcontentloaded' });
            await page.locator('#weight-pie[data-chart="treemap"] .bp-weight-tile').first().waitFor();
            const chart = await page.locator('.bp-pie-stage').boundingBox();
            assert.ok(chart.width > 150 && Math.abs(chart.width - chart.height) < 1);
            const count = page.locator('.bp-benchmark-row .bp-evidence-count').first();
            assert.match((await count.textContent()).trim(), /^\d+$/);
            assert.match(await count.getAttribute('aria-label'), /approved scores?/);
            if (width < 760) {
                await page.locator('#model-index-tab').click();
                await page.evaluate(() => scrollTo(0, 350));
                await page.waitForTimeout(150);
                const geometry = await page.evaluate(() => {
                    const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
                    return { header: box('#config-sidebar'), workspace: box('.bp-workspace'),
                        scrollX, viewport: innerWidth, rootWidth: document.documentElement.scrollWidth };
                });
                assert.ok(Math.abs(geometry.header.y) < 1);
                assert.ok(Math.abs(geometry.workspace.x * 2 + geometry.workspace.width - width) < 1);
                assert.equal(geometry.scrollX, 0);
                assert.ok(geometry.rootWidth <= geometry.viewport + 1);
            } else {
                await page.locator('#discussion-entry').click();
                await page.waitForFunction(() => document.querySelector('#config-sidebar-toggle').getBoundingClientRect().width < 1);
                await page.locator('#discussion-close').click();
            }
            await page.screenshot({ path: `${output}/configuration-${width}.png` });
            assert.deepEqual(errors, []);
            assert.deepEqual(writes, []);
            results.push({ width, compactGrid: true, scoreModeRetained: true, squareTreemap: true,
                evidenceCounts: true, pageErrors: errors.length, attemptedMutations: writes.length });
            console.log(JSON.stringify(results.at(-1)));
        } finally { await context.close(); }
    }
} finally { await browser.close(); }
await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
