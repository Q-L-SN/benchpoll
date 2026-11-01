import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startPreview } from './server.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const output = fileURLToPath(new URL('../../artifacts/family-lifecycle-20261005/ui/', import.meta.url));
await mkdir(output, { recursive: true });
const liveURL = process.env.FAMILY_TEST_URL;
const results = [];
for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({ headless: true, env: { ...process.env,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
        NO_PROXY: '*', no_proxy: '*' } });
    try {
        for (const width of engineName === 'chromium' ? [1440, 390, 320] : [390]) {
            const app = await startPreview({ saveDelay: 450 });
            const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width < 500, isMobile: width < 500 });
            const page = await context.newPage();
            page.setDefaultTimeout(20000);
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            if (liveURL) await page.route('**/api/**', async route => {
                const url = new URL(route.request().url());
                const response = await route.fetch({ url: app.url + url.pathname + url.search });
                await route.fulfill({ response });
            });
            const press = async locator => width < 500 ? locator.tap() : locator.click();
            const enabled = page.locator('#inline-fallback-toggle');
            const chart = page.locator('#inline-fallback-chart');
            const row = ID => page.locator(`.bp-benchmark-row:not(.is-family)[data-condition-id="${ID}"]`);
            const IDs = () => chart.locator('.bp-family-member').evaluateAll(rows => rows.map(row => Number(row.dataset.conditionId)));
            const saved = async (expected = null, enabledExpected = true) => {
                const intended = expected ?? await IDs();
                const deadline = Date.now() + 20000;
                while (JSON.stringify(app.state.fallbackRules[0]?.entries.map(entry => entry.conditionID) ?? []) !== JSON.stringify(intended)) {
                    if (Date.now() >= deadline) throw new Error('Latest fallback order was not persisted');
                    await delay(30);
                }
                await page.waitForFunction(() => /^(Saved|Last updated)/.test(document.querySelector('#last-updated').textContent));
                assert.equal((await enabled.getAttribute('aria-expanded')) === 'true', enabledExpected);
                if (enabledExpected) assert.deepEqual(await IDs(), intended);
            };
            try {
                await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded' });
                await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
                await press(page.locator('#pie-mode-personal'));
                await press(page.locator('#inline-fallback-toggle'));
                assert.equal((await enabled.getAttribute('aria-expanded')) === 'true', true);
                await press(page.getByRole('button', { name: 'About Fallback', exact: true }));
                assert.equal((await enabled.getAttribute('aria-expanded')) === 'true', true, 'Help never toggles the fallback');
                app.state.saveFailure = 503;
                await press(row(2).locator('.bp-benchmark-add')); await press(row(3).locator('.bp-benchmark-add'));
                await page.locator('#inline-fallback-save-error').waitFor();
                assert.equal((await enabled.getAttribute('aria-expanded')) === 'true', true, 'Failure keeps the switch enabled');
                assert.deepEqual(await IDs(), [2, 3], 'Failure keeps unsaved fallback entries');
                assert.deepEqual(app.state.fallbackRules, [], 'Failure never pretends to persist');
                const loads = app.state.requests.filter(request => request.path === '/api/get_weighted_workspace').length;
                await press(page.locator('#workspace-refresh'));
                await page.locator('#inline-fallback-save-error').waitFor();
                assert.equal(app.state.requests.filter(request => request.path === '/api/get_weighted_workspace').length, loads,
                    'Refresh cannot discard unsaved fallback edits');
                app.state.saveFailure = null;
                await press(page.locator('#inline-fallback-save-retry'));
                await saved();
                assert.deepEqual(await IDs(), [2, 3]);
                await page.locator('#benchmark-search').fill('Mathematics');
                await press(row(4).locator('.bp-benchmark-add')); await saved();
                assert.deepEqual(await IDs(), [2, 3, 4]);
                await press(chart.getByRole('button', { name: 'Remove Mathematics from fallback', exact: true }));
                await press(chart.getByRole('button', { name: 'Move Code generation earlier', exact: true }));
                await saved();
                assert.deepEqual(await IDs(), [3, 2]);
                await press(chart.getByRole('button', { name: 'Remove Code generation from fallback', exact: true }));
                await press(chart.getByRole('button', { name: 'Remove Advanced reasoning from fallback', exact: true }));
                await saved([]);
                assert.equal((await enabled.getAttribute('aria-expanded')) === 'true', true, 'Empty draft stays open for new additions');
                await press(row(4).locator('.bp-benchmark-add')); await saved();
                await press(page.locator('#inline-fallback-toggle'));
                await page.locator('#inline-fallback-settings').waitFor({ state: 'hidden' });
                assert.deepEqual(app.state.fallbackRules[0].entries.map(entry => entry.conditionID), [4], 'Collapse preserves the rule');
                assert.equal(await enabled.getAttribute('aria-expanded'), 'false');
                assert.deepEqual(errors, []);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                await page.screenshot({ path: output + `${liveURL ? 'live-' : ''}${engineName}-${width}.png`, fullPage: true });
                results.push({ engine: engineName, width, passed: true });
                console.log('PASS ' + engineName + '-' + width);
            } catch (error) {
                results.push({ engine: engineName, width, passed: false, error: error.message, errors });
                console.error('FAIL ' + engineName + '-' + width + ': ' + error.message);
                await page.screenshot({ path: output + `${liveURL ? 'live-' : ''}${engineName}-${width}-failure.png`, fullPage: true });
            } finally { await context.close(); await app.close(); }
        }
    } finally { await browser.close(); }
}
await writeFile(output + `${liveURL ? 'live-' : ''}checks.json`, JSON.stringify(results, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
