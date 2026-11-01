import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const output = 'D:/Codex-artifacts/website1/weight-treemap-20261031/live';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
try {
    for (const width of [390, 1440]) {
        const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width < 760 });
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
            await page.screenshot({ path: `${output}/home-${width}.png` });
            await page.goto(new URL(href, 'https://benchpoll.com').href, { waitUntil: 'domcontentloaded' });
            await page.locator('#weight-pie[data-chart="treemap"] .bp-weight-tile').first().waitFor();
            await page.locator('.bp-benchmark-row .bp-evidence-count').first().waitFor();
            const chart = await page.locator('#weight-pie').evaluate(svg => {
                const blocks = [...svg.querySelectorAll(':scope > g[data-object-id]')].map(group => {
                    const rect = group.querySelector('.bp-weight-tile');
                    return { id: group.dataset.objectId, weight: Number(group.dataset.weight),
                        area: rect.width.baseVal.value * rect.height.baseVal.value,
                        description: group.dataset.tooltip };
                });
                return { blocks, circularPaths: svg.querySelectorAll('path.bp-pie-slice').length, role: svg.getAttribute('role') };
            });
            const totalArea = chart.blocks.reduce((sum, block) => sum + block.area, 0);
            const totalWeight = chart.blocks.reduce((sum, block) => sum + block.weight, 0);
            assert.equal(chart.circularPaths, 0);
            assert.equal(chart.role, 'group');
            for (const block of chart.blocks) {
                assert.ok(Math.abs(block.area / totalArea - block.weight / totalWeight) < .00001);
                assert.match(block.description, /\d+\.\d+%/);
            }
            const count = page.locator('.bp-benchmark-row .bp-evidence-count').first();
            assert.match((await count.textContent()).trim(), /^\d+$/);
            assert.match(await count.getAttribute('aria-label'), /approved scores?/);
            assert.equal(await count.locator('.fa-chart-simple').count(), 1);
            if (width >= 760) {
                const toggle = page.locator('#config-sidebar-toggle');
                await toggle.click();
                await page.waitForFunction(() => document.body.dataset.configSidebarPhase === 'idle' && !document.body.classList.contains('config-sidebar-collapsed'));
                const samples = await page.evaluate(async () => {
                    const rows = [], start = performance.now();
                    document.querySelector('#config-sidebar-toggle').click();
                    while (performance.now() - start < 380) {
                        const brand = document.querySelector('#workspace-brand-slot .bp-brand');
                        rows.push({ ms: performance.now() - start, opacity: brand ? Number(getComputedStyle(brand).opacity) : 0,
                            phase: document.body.dataset.configSidebarPhase });
                        await new Promise(resolve => setTimeout(resolve, 12));
                    }
                    return rows;
                });
                assert.ok(samples.some(row => row.opacity > .05 && row.phase !== 'idle' && row.ms < 300));
                await writeFile(`${output}/sidebar-timing.json`, JSON.stringify(samples, null, 2));
                const id = chart.blocks[0].id, group = page.locator(`#weight-pie > g[data-object-id="${id}"]`);
                await group.hover();
                await page.waitForFunction(id => new DOMMatrix(getComputedStyle(document.querySelector(`#weight-pie > g[data-object-id="${id}"] .bp-weight-tile-lift`)).transform).a > 1.01, id);
                await group.click();
                await page.waitForFunction(id => document.querySelector(`#weight-pie > g[data-object-id="${id}"]`).getAttribute('aria-pressed') === 'true', id);
                await page.mouse.move(0, 0);
            }
            await page.screenshot({ path: `${output}/configuration-${width}.png`, fullPage: true });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
            assert.deepEqual(errors, []);
            assert.deepEqual(writes, []);
            results.push({ width, blocks: chart.blocks.length, proportionalAreas: true, compactCounts: true, sidebarOverlap: width >= 760 });
            console.log(JSON.stringify(results.at(-1)));
        } finally { await context.close(); }
    }
} finally { await browser.close(); }
await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
