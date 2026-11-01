import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const output = 'D:/Codex-artifacts/website1/ui-discussion-20261012/live';
await mkdir(output, { recursive: true });
const report = { checkedAt: new Date().toISOString(), businessWrites: 0, cases: [], browsers: [] };
for (const scoreMode of ['range', 'available']) {
    const start = performance.now();
    const response = await fetch('https://benchpoll.com/api/get_weighted_workspace', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scoreMode, availableInferenceVersion: 2 }), signal: AbortSignal.timeout(60000) });
    assert.equal(response.status, 200); const data = await response.json();
    report.cases.push({ scoreMode, status: response.status, milliseconds: performance.now() - start,
        benchmarks: data.benchmarks.length, models: data.modelLeaderboards.public.length });
}
const browser = await chromium.launch({ headless: true });
try {
    for (const width of [1440, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760 });
        const page = await context.newPage(); page.setDefaultTimeout(60000);
        const errors = [], writes = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => { if (/\/api\/(?:save|create|delete|submit|vote)_/.test(request.url())) writes.push(request.url()); });
        try {
            await page.goto('https://benchpoll.com/Intelligence');
            await page.locator('.bp-benchmark-row').first().waitFor();
            const row = page.locator('.bp-benchmark-row .bp-benchmark-information-link').first();
            await row.click(); await page.locator('#benchmark-information-name').waitFor();
            await page.waitForFunction(() => document.getElementById('benchmark-information-status').textContent !== 'Loading benchmark information...');
            assert.equal(await page.locator('#discussion-brand-slot .bp-brand').isVisible(), true);
            assert.equal(await page.locator('#workspace-brand-slot .bp-brand').count(), 0);
            await page.screenshot({ path: join(output, `information-${width}.png`), fullPage: true });
            await page.locator('#discussion-close').click();
            assert.equal(await page.locator('.bp-sidebar > .bp-brand').isVisible(), true);
            await page.goto('https://benchpoll.com/contribute/feedback');
            await page.locator('#contribution-back').waitFor({ state: 'attached' });
            assert.equal(await page.locator('.contribution-breadcrumb').count(), 0);
            const alignment = await page.locator('.contribution-sidebar-actions .bp-sidebar-action').evaluateAll(nodes =>
                nodes.map(node => getComputedStyle(node).justifyContent));
            assert.ok(alignment.every(value => value === 'flex-start'), JSON.stringify(alignment));
            const text = page.locator('.feedback-editor textarea');
            const textareaVisible = await text.isVisible();
            if (textareaVisible) assert.ok((await text.boundingBox()).height >= 340);
            await page.screenshot({ path: join(output, `form-${width}.png`), fullPage: true });
            if (width < 760) await page.locator('#contribution-taxonomy-toggle').click();
            await page.locator('#contribution-back').click();
            await page.waitForURL('https://benchpoll.com/Intelligence');
            assert.deepEqual(errors, []); assert.deepEqual(writes, []);
            report.browsers.push({ width, passed: true, textareaVisible, alignment });
        } finally { await context.close(); }
    }
} finally { await browser.close(); }
await writeFile(join(output, 'verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
