import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';

const liveURL = process.env.WEIGHT_SETUP_TEST_URL;
const output = fileURLToPath(new URL('../../artifacts/weight-setup-20261004/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
async function check(name, options, action) {
    const app = await startPreview(options);
    const context = await browser.newContext({ viewport: { width: options.width, height: 1000 },
        reducedMotion: options.reducedMotion ?? 'no-preference' });
    const page = await context.newPage();
    page.setDefaultTimeout(liveURL ? 60000 : 8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (liveURL) {
        await page.route('**/api/**', async route => {
            const url = new URL(route.request().url());
            const response = await route.fetch({ url: app.url + url.pathname + url.search });
            await route.fulfill({ response });
        });
    }
    try {
        await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded' });
        await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
        await action({ page, app });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.deepEqual(errors, []);
        await page.screenshot({ path: output + `${liveURL ? 'live-' : ''}${name}.png`, fullPage: true, animations: 'disabled' });
        results.push({ name, passed: true });
        console.log(`PASS ${name}`);
    } catch (error) {
        results.push({ name, passed: false, error: error.message, browserErrors: errors });
        await page.screenshot({ path: output + `${name}-failure.png`, fullPage: true, animations: 'disabled' });
        console.error(`FAIL ${name}: ${error.message}`);
    } finally {
        await context.close();
        await app.close();
    }
}
async function glow(page, selector, expected, animated = true) {
    assert.equal(await page.locator(selector).evaluate(node => node.classList.contains('bp-weight-setup-glow')), expected);
    if (expected) {
        const name = await page.locator(selector).evaluate(node => getComputedStyle(node, '::after').animationName);
        assert.equal(name, animated ? 'bp-weight-setup-glow' : 'none');
    }
}
try {
    for (const width of [1440, 390, 320]) {
        await check(`personal-empty-${width}`, { width, personalEntries: [] }, async ({ page }) => {
            const empty = page.locator('#personal-pie-empty');
            assert.equal(await empty.isVisible(), false);
            await page.locator('#personal-pie-create').click();
            await empty.waitFor();
            await glow(page, '#personal-pie-empty', true);
            assert.doesNotMatch(await empty.innerText(), /on the right/);
            assert.match(await empty.innerText(), /Select a row in the Benchmarks list/);
            const bounds = await empty.boundingBox();
            assert.ok(Math.abs(bounds.width - bounds.height) <= 1, 'Empty pie must stay circular');
            assert.equal(await empty.evaluate(node => [...node.children].every(child => {
                const parent = node.getBoundingClientRect();
                const box = child.getBoundingClientRect();
                return box.left >= parent.left && box.right <= parent.right && box.top >= parent.top && box.bottom <= parent.bottom;
            })), true, 'Empty-state text must fit');
            await page.screenshot({ path: output + `empty-glow-${width}.png`, fullPage: true, animations: 'disabled' });
            await page.locator('#personal-pie-find-benchmarks').click();
            await page.waitForFunction(() => document.activeElement?.id === 'benchmark-search');
            await page.locator('.bp-benchmark-row[data-condition-id="1"]').click();
            await empty.waitFor({ state: 'hidden' });
            await page.locator('#weight-pie g[data-object-id="1"]').waitFor();
            await glow(page, '#personal-pie-empty', false);
        });
        await check(`fallback-target-${width}`, { width }, async ({ page, app }) => {
            await page.locator('#pie-mode-personal').click();
            await page.locator('#inline-fallback-toggle').click();
            const chart = page.locator('#inline-fallback-chart');
            await chart.waitFor();
            assert.equal(await chart.evaluate(node => node.classList.contains('is-target-active')), true);
            await glow(page, '#inline-fallback-chart', true);
            assert.equal(await page.locator('#inline-fallback-toggle').getAttribute('aria-expanded'), 'true');
            await page.screenshot({ path: output + `fallback-glow-${width}.png`, fullPage: true, animations: 'disabled' });
            const saved = page.waitForResponse(response => response.url().includes('/api/save_personal_pie') && response.ok());
            await page.getByRole('button', { name: 'Add Advanced reasoning to Fallback', exact: true }).click();
            await page.waitForFunction(() => document.querySelector('.bp-family-member'));
            await glow(page, '#inline-fallback-chart', false);
            await saved;
            assert.equal(app.state.requests.filter(item => item.path === '/api/save_personal_pie').at(-1).body.fallbackRules[0].entries[0].conditionID, 2);
            await page.waitForFunction(() => !document.querySelector('#inline-fallback-toggle').disabled);
            await chart.getByRole('button', { name: 'Remove Advanced reasoning from fallback', exact: true }).click();
            await glow(page, '#inline-fallback-chart', true);
            await page.waitForFunction(() => !document.querySelector('#inline-fallback-toggle').disabled);
            await page.locator('#inline-fallback-toggle').click();
            await chart.waitFor({ state: 'hidden' });
            await glow(page, '#inline-fallback-chart', false);
            await page.locator('#pie-mode-public').click();
            await page.locator('#public-fallback-toggle').click();
            await glow(page, '#inline-fallback-chart', false);
        });
    }
    await check('guest-reduced-motion', { width: 390, authenticated: false, reducedMotion: 'reduce' }, async ({ page }) => {
        await page.locator('#personal-pie-create').click();
        await glow(page, '#personal-pie-empty', true, false);
        await page.locator('.bp-benchmark-row[data-condition-id="1"]').click();
        await page.locator('#inline-fallback-toggle').click();
        await glow(page, '#inline-fallback-chart', true, false);
        await page.getByRole('button', { name: 'Add Advanced reasoning to Fallback', exact: true }).click();
        await glow(page, '#inline-fallback-chart', false);
    });
} finally {
    await browser.close();
    await writeFile(output + `${liveURL ? 'live-' : ''}results.json`, JSON.stringify(results, null, 2));
}
if (results.some(result => !result.passed)) process.exitCode = 1;
