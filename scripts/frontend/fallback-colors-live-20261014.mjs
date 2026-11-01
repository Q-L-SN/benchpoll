import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const output = process.env.FIXED_APPEARANCE_LIVE_OUTPUT ?? 'D:/Codex-artifacts/website1/showcase-view-20261012/fixed-appearance-20261015/live';
await mkdir(output, { recursive: true });
const reports = [];
for (const width of [1440, 390]) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760 });
    const page = await context.newPage(); page.setDefaultTimeout(45000);
    const errors = [], requests = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(request.url()); });
    await page.route('https://benchpoll.com/api/**', route => {
        if (/\/api\/(?:save_|create_|delete_|submit_|update_)/.test(route.request().url())) { writes.push(route.request().url()); return route.abort(); }
        return route.continue();
    });
    await context.addInitScript(() => {
        localStorage.setItem('benchpoll-workspace-display-v1', 'standard');
        localStorage.setItem('benchpoll-fallback-appearance-v1', 'flow');
        localStorage.setItem('benchpoll-score-bar-colors-v1', 'uniform');
        sessionStorage.setItem('benchpoll-workspace-preferences-v1', JSON.stringify({ mode: 'public', scoreMode: 'available' }));
    });
    try {
        const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/get_weighted_workspace' && response.status() === 200);
        await page.goto('https://benchpoll.com/Intelligence');
        const workspace = await (await response).json();
        await page.waitForFunction(() => document.getElementById('model-ranking-status')?.dataset.phase === 'ready' && document.querySelectorAll('.bp-model-row').length > 0);
        await page.evaluate(() => document.fonts.ready);
        if (width < 760) await page.locator('button[data-mobile-panel="models"]').click();
        await page.waitForTimeout(400);
        assert.equal(await page.locator('.bp-score-colors-toggle,.bp-fallback-style-control').count(), 0);
        assert.equal(await page.locator('html').getAttribute('data-fallback-appearance'), null);
        const vendors = await page.locator('.bp-score-known').evaluateAll(nodes => nodes.map(node => {
            const color = getComputedStyle(node).backgroundColor;
            const probe = document.createElement('span'); probe.style.color = getComputedStyle(node.parentElement).getPropertyValue('--score-vendor-color');
            node.append(probe); const expected = getComputedStyle(probe).color; probe.remove();
            return { color, expected };
        }));
        assert.ok(vendors.length); assert.ok(vendors.every(({ color, expected }) => color === expected), JSON.stringify(vendors));
        await page.screenshot({ path: join(output, `${width}-vendor-colors.png`) });
        if (width < 760) await page.locator('button[data-mobile-panel="mix"]').click();
        const group = workspace.publicPie.familyComposition.find(group => group.families.some(family => family.entries.length)) ?? workspace.publicPie.familyComposition[0];
        await page.locator(`#weight-pie g[data-object-id="${group.primaryConditionID}"]`).press('Enter');
        await page.locator('#public-fallback-toggle').click();
        const picker = page.locator('#fallback-picker'); await picker.waitFor();
        assert.equal(await picker.getByRole('combobox', { name: 'Fallback chain style' }).count(), 0);
        await page.waitForTimeout(180);
            const nodes = await picker.locator('.bp-fallback-chain-step').evaluateAll(rows => rows.map(row => {
                const name = row.querySelector('.bp-benchmark-link-name, .bp-auto-version-label strong') ?? row.querySelector('.bp-benchmark-information-link');
                const range = document.createRange(); range.selectNodeContents(name);
                const text = [...range.getClientRects()].find(box => box.width > 0 && box.height > 0), box = row.getBoundingClientRect();
                return { name: name.textContent, delta: parseFloat(getComputedStyle(row, '::after').top) - text.top - text.height / 2 + box.top };
            }));
            assert.ok(nodes.length); assert.ok(nodes.every(node => Math.abs(node.delta) < 1.1), JSON.stringify(nodes));
        await page.screenshot({ path: join(output, `${width}-rail.png`) });
        assert.deepEqual(errors, []); assert.deepEqual(writes, []);
        reports.push({ width, vendors, nodes: nodes.length, errors, writes, requests: requests.length });
        console.log(JSON.stringify({ width, passed: true, nodes: nodes.length }));
    } catch (error) { await page.screenshot({ path: join(output, `${width}-failure.png`) }).catch(() => {}); throw error; }
    finally { await page.unrouteAll({ behavior: 'ignoreErrors' }); await context.close(); await browser.close(); }
}
await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
