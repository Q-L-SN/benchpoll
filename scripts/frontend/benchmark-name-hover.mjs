import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { familyEntries } from './fixtures.mjs';

const liveURL = process.env.BENCHMARK_NAME_HOVER_URL;
const output = fileURLToPath(new URL('../../artifacts/benchmark-name-hover-20261006/', import.meta.url));
const results = [];
const ordinary = (page, ID) => page.locator(`.bp-benchmark-row:not(.is-family)[data-condition-id="${ID}"]`);
const decoration = locator => locator.evaluateAll(nodes => nodes.map(node => getComputedStyle(node).textDecorationLine));
const allNames = page => page.locator('#benchmark-rows .bp-benchmark-information-link');
const rule = { primaryConditionID: 1, familyID: 20, mode: 'ordered', entries: familyEntries([{ conditionID: 2 }, { conditionID: 3 }]) };
await mkdir(output, { recursive: true });

for (const [engine, launcher, widths] of [['chromium', chromium, [1440, 390, 320]], ['webkit', webkit, [1440, 390]]]) {
    const browser = await launcher.launch({ headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    try {
        for (const width of widths) {
            const touch = width < 500;
            const app = await startPreview({ families: [rule] });
            const context = await browser.newContext({ viewport: { width, height: 950 }, isMobile: touch, hasTouch: touch });
            const page = await context.newPage();
            page.setDefaultTimeout(liveURL ? 45000 : 15000);
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            if (liveURL) await page.route('**/api/**', async route => {
                const url = new URL(route.request().url());
                const response = await route.fetch({ url: app.url + url.pathname + url.search });
                await route.fulfill({ response });
            });
            try {
                await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded', timeout: liveURL ? 90000 : 15000 });
                await page.waitForFunction(() => document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false');
                await page.evaluate(() => document.fonts.ready);
                await page.mouse.move(0, 0);
                assert.equal(await page.evaluate(() => matchMedia('(hover: hover)').matches), !touch);
                assert.ok((await decoration(allNames(page))).every(value => value === 'none'), 'Idle names have no underline');

                if (touch) {
                    await ordinary(page, 2).locator('.bp-benchmark-public-weight').tap();
                    assert.ok((await decoration(allNames(page))).every(value => value === 'none'), 'Touch selection leaves no sticky underline');
                    await ordinary(page, 2).locator('.bp-benchmark-name').tap();
                    await page.locator('#benchmark-information-weights').waitFor();
                    await page.locator('#discussion-close').tap();
                    await page.locator('#discussion-panel').waitFor({ state: 'hidden' });
                    assert.ok((await decoration(allNames(page))).every(value => value === 'none'), 'Touch inspection return leaves names plain');
                } else {
                    await ordinary(page, 2).locator('.bp-benchmark-public-weight').hover();
                    assert.deepEqual(await decoration(ordinary(page, 2).locator('.bp-benchmark-name')), ['underline']);
                    assert.deepEqual(await decoration(ordinary(page, 3).locator('.bp-benchmark-name')), ['none'], 'Other rows remain plain');
                    await page.screenshot({ path: output + `${liveURL ? 'live-' : ''}${engine}-${width}-hover.png`, fullPage: true, animations: 'disabled' });
                    await page.mouse.move(0, 0);
                    assert.ok((await decoration(allNames(page))).every(value => value === 'none'), 'Leaving the row removes underline');
                    await page.keyboard.press('Tab');
                    await ordinary(page, 2).locator('.bp-benchmark-name').focus();
                    assert.deepEqual(await decoration(ordinary(page, 2).locator('.bp-benchmark-name')), ['underline'], 'Keyboard name focus is discoverable');
                    await ordinary(page, 3).focus();
                    assert.deepEqual(await decoration(ordinary(page, 3).locator('.bp-benchmark-name')), ['underline'], 'Keyboard row focus is discoverable');
                    await ordinary(page, 3).evaluate(node => node.blur());
                }

                await page.locator('.bp-benchmark-fallbacks[data-entrance-id="1"] .bp-benchmark-fallback-toggle').click();
                const family = page.locator('.bp-benchmark-row.is-family[data-family-key="[1,2,3]"]');
                await family.waitFor();
                await page.mouse.move(0, 0);
                assert.ok((await decoration(family.locator('.bp-fallback-step-name'))).every(value => value === 'none'));
                if (touch) {
                    await family.locator('.bp-benchmark-public-weight').tap();
                    assert.ok((await decoration(family.locator('.bp-fallback-step-name'))).every(value => value === 'none'));
                } else {
                    await family.locator('.bp-benchmark-public-weight').hover();
                    assert.ok((await decoration(family.locator('.bp-fallback-step-name'))).every(value => value === 'underline'), 'Row hover reveals fallback names');
                    assert.deepEqual(await decoration(ordinary(page, 1).locator('.bp-benchmark-name')), ['none'], 'Parent benchmark stays plain');
                    await page.mouse.move(0, 0);
                    assert.ok((await decoration(allNames(page))).every(value => value === 'none'));
                }
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                assert.equal(app.state.requests.filter(request => request.path === '/api/save_personal_pie').length, 0);
                assert.deepEqual(errors, []);
                await page.screenshot({ path: output + `${liveURL ? 'live-' : ''}${engine}-${width}-idle.png`, fullPage: true, animations: 'disabled' });
                results.push({ engine, width, touch, passed: true });
                console.log(`PASS ${engine}-${width}`);
            } catch (error) {
                results.push({ engine, width, touch, passed: false, error: error.stack, browserErrors: errors });
                await page.screenshot({ path: output + `${liveURL ? 'live-' : ''}${engine}-${width}-failure.png`, fullPage: true });
                console.error(error.stack);
            } finally {
                await context.close();
                await app.close();
            }
        }
    } finally {
        await browser.close();
    }
}
await writeFile(output + `${liveURL ? 'live-' : ''}checks.json`, JSON.stringify(results, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
