import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const output = 'D:/Codex-artifacts/website1/showcase-view-20261012/node-alignment-20261014/live';
await mkdir(output, { recursive: true });
const reports = [];
for (const width of [1440, 390]) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760 });
    const page = await context.newPage(); page.setDefaultTimeout(45000);
    const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://benchpoll.com/api/**', route => {
        if (/\/api\/(?:save_|create_|delete_|submit_|update_)/.test(route.request().url())) {
            writes.push(route.request().url()); return route.abort();
        }
        return route.continue();
    });
    await context.addInitScript(() => {
        localStorage.setItem('benchpoll-workspace-display-v1', 'standard');
        sessionStorage.setItem('benchpoll-workspace-preferences-v1', JSON.stringify({ mode: 'public', scoreMode: 'range' }));
    });
    try {
        const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/get_weighted_workspace' && response.status() === 200);
        await page.goto('https://benchpoll.com/Intelligence');
        const workspace = await (await response).json();
        await page.waitForFunction(() => document.getElementById('model-ranking-status')?.dataset.phase === 'ready');
        await page.evaluate(() => document.fonts.ready);
        const group = workspace.publicPie.familyComposition.find(group => group.families.some(family => family.entries.length))
            ?? workspace.publicPie.familyComposition[0];
        assert.ok(group, 'Production must contain a public Pie to check');
        if (await page.locator('button[data-mobile-panel="mix"]').isVisible()) await page.locator('button[data-mobile-panel="mix"]').click();
        await page.locator(`#weight-pie g[data-object-id="${group.primaryConditionID}"]`).press('Enter');
        await page.locator('#public-fallback-toggle').click();
        const steps = page.locator('#fallback-picker .bp-fallback-chain-step');
        await steps.first().waitFor();
        await page.waitForFunction(() => [...document.querySelectorAll('#fallback-picker .bp-fallback-chain-step')]
            .every(row => row.style.getPropertyValue('--bp-chain-node-y')));
        await page.waitForTimeout(300);
        const nodes = await steps.evaluateAll(rows => rows.map(row => {
            const name = row.querySelector('.bp-benchmark-link-name, .bp-auto-version-label strong')
                ?? row.querySelector('.bp-benchmark-information-link');
            const range = document.createRange(); range.selectNodeContents(name);
            const text = [...range.getClientRects()].find(box => box.width > 0 && box.height > 0);
            const box = row.getBoundingClientRect();
            return { name: name.textContent, nodeY: parseFloat(getComputedStyle(row, '::after').top),
                nameY: text.top + text.height / 2 - box.top };
        }));
        assert.ok(nodes.length > 0);
        for (const node of nodes) assert.ok(Math.abs(node.nodeY - node.nameY) < 1.1, JSON.stringify(node));
        await page.screenshot({ path: join(output, `${width}-public-fallback.png`) });
        assert.deepEqual(writes, []); assert.deepEqual(errors, []);
        reports.push({ width, nodes, errors, writes });
        console.log(JSON.stringify({ width, nodes: nodes.length, passed: true }));
    } catch (error) {
        await page.screenshot({ path: join(output, `${width}-failure.png`) }).catch(() => {}); throw error;
    } finally { await page.unrouteAll({ behavior: 'ignoreErrors' }); await context.close(); await browser.close(); }
}
await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
