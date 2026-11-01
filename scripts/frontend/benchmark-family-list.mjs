import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';
import { benchmarks, familyEntries } from './fixtures.mjs';

const output = fileURLToPath(new URL('../../artifacts/fallback-chain-polish-20261006/family-list/', import.meta.url));
const selectedCase = process.env.CHAIN_TEST_CASE;
await mkdir(output, { recursive: true });
const results = [];
const browser = await chromium.launch({ headless: true });
const rule = (IDs, familyID) => ({ primaryConditionID: 1, familyID, mode: 'ordered',
    entries: familyEntries(IDs.map(conditionID => ({ conditionID }))) });
const familyRow = (page, key) => page.locator(`.bp-benchmark-row[data-family-key="${key}"]`);
const saves = app => app.state.requests.filter(request => request.path === '/api/save_personal_pie');
async function idle(page) {
    await page.waitForFunction(() => document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false'
        && !/Saving/.test(document.querySelector('#last-updated')?.textContent ?? ''));
}
async function check(name, options, action) {
    if (selectedCase && selectedCase !== name) return;
    const app = await startPreview(options);
    const context = await browser.newContext({ viewport: { width: options.width ?? 1440, height: 950 },
        reducedMotion: options.reducedMotion ?? 'no-preference' });
    await context.addInitScript(() => {
        window.focusTrace = [];
        document.addEventListener('focusin', event => window.focusTrace.push({ at: performance.now(), element: event.target.outerHTML.slice(0, 260) }));
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
        await page.goto(app.url, { waitUntil: 'domcontentloaded' }); await idle(page);
        await page.locator('.bp-benchmark-fallbacks[data-entrance-id="1"] .bp-benchmark-fallback-toggle').click();
        await page.locator('.bp-benchmark-family-chain').first().waitFor();
        await action(page, app);
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await page.screenshot({ path: output + name + '.png', fullPage: true, animations: 'disabled' });
        results.push({ name, passed: true }); console.log('PASS ' + name);
    } catch (error) {
        results.push({ name, passed: false, error: error.stack, browserErrors: errors,
            focusTrace: await page.evaluate(() => window.focusTrace), focusState: await page.evaluate(() => {
                const target = document.getElementById('discussion-close');
                const parents = []; let current = target;
                while (current) { parents.push({ tag: current.tagName, id: current.id, inert: current.inert, hidden: current.hidden,
                    visibility: getComputedStyle(current).visibility, display: getComputedStyle(current).display,
                    width: current.getBoundingClientRect().width }); current = current.parentElement; }
                target.focus(); return { parents, activeAfterFocus: document.activeElement.outerHTML };
            }), informationRequests: app.state.requests.filter(request => request.path === '/api/get_benchmark_information') });
        await page.screenshot({ path: output + name + '-failure.png', fullPage: true });
        console.error('FAIL ' + name + ': ' + error.stack);
    } finally { await context.close(); await app.close(); }
}
try {
    await check('keyboard-and-rerender', { rankingStress: true, secondaryBenchmark: true,
        families: [rule([2, 901], 20), rule([901, 2], 21)], reducedMotion: 'reduce' }, async (page, app) => {
        const link = familyRow(page, '[1,2,901]').locator('.bp-fallback-step-name').first();
        await link.focus(); await page.keyboard.press('Enter');
        await page.locator('#benchmark-information-name').filter({ hasText: 'Advanced reasoning' }).waitFor();
        assert.equal(await page.locator('#benchmark-information-name').innerText(), 'Advanced reasoning');
        await page.waitForFunction(() => document.querySelector('#discussion-panel').contains(document.activeElement), null, { timeout: 2000 });
        assert.equal(await page.locator('#discussion-panel').evaluate(node => node.contains(document.activeElement)), true,
            'Rail retains keyboard focus: ' + await page.evaluate(() => document.activeElement.outerHTML));
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.body.classList.contains('discussion-open'));
        assert.equal(await link.evaluate(node => node === document.activeElement), true);
        assert.equal(saves(app).length, 0);
        const count = await page.locator('.bp-benchmark-row:not(.is-family)').count();
        await page.locator('#benchmark-rows > .bp-ranking-page-footer button').evaluate(node => node.click());
        await page.waitForFunction(previous => document.querySelectorAll('.bp-benchmark-row:not(.is-family)').length > previous, count);
        assert.equal(await link.evaluate(node => node === document.activeElement), true, 'Rerender restores the precise chain-step focus');
        await page.locator('#pie-mode-personal').click(); await idle(page);
        await familyRow(page, '[1,2,901]').locator('.bp-benchmark-add').focus();
        const saved = page.waitForResponse(response => response.url().includes('/api/save_personal_pie') && response.ok());
        await page.keyboard.press('Space'); await saved; await idle(page);
        assert.equal(saves(app).length, 1);
        assert.equal(app.state.fallbackRules[0].familyID, 20);
        assert.equal(await familyRow(page, '[1,2,901]').locator('.bp-benchmark-applied').count(), 1);
        assert.equal(await familyRow(page, '[1,2,901]').locator('.bp-benchmark-family-select').evaluate(node => node === document.activeElement), true);
    });
    const long = { primaryConditionID: 1, familyID: 30, mode: 'ordered', entries: Array.from({ length: 40 }, (_, i) => ({
        ...benchmarks[1], ID: i + 1001, conditionID: i + 1001, benchmarkID: i + 2001,
        name: i ? `Alternative ${i + 1}` : 'AnExtremelyLongUnbrokenBenchmarkNameForResponsiveLayout'.repeat(3),
        conditionName: `Detailed version ${i + 1}`, conditionKey: `detail-${i + 1}`, isDefaultCondition: false })) };
    for (const width of [1440, 390, 320]) await check('long-chain-' + width, { width, families: [long] }, async (page, app) => {
        const key = JSON.stringify([1, ...long.entries.map(entry => entry.conditionID)]);
        const chain = familyRow(page, key).locator('.bp-benchmark-family-chain');
        assert.equal(await chain.locator('.bp-fallback-step').count(), 40);
        assert.equal(await chain.evaluate(node => node.scrollWidth > node.clientWidth && node.clientHeight < 175
            && node.closest('.bp-benchmark-row').scrollWidth <= node.closest('.bp-benchmark-row').clientWidth + 1), true);
        await page.locator('#pie-mode-personal').click(); await idle(page);
        await page.locator('#weight-pie > g[data-object-id="1"]').dispatchEvent('click');
        const before = JSON.stringify(app.state.personalEntries);
        const count = saves(app).length;
        await chain.hover(); await page.mouse.wheel(0, 160); await delay(600);
        assert.equal(JSON.stringify(app.state.personalEntries), before, 'Reading a chain must not adjust the selected Pie');
        assert.equal(saves(app).length, count);
        await chain.evaluate(node => { node.scrollLeft = node.scrollWidth; });
        assert.ok(await chain.evaluate(node => node.scrollLeft > 0));
        await chain.locator('.bp-fallback-step-name').last().focus();
        assert.equal(await chain.locator('.bp-fallback-step-name').last().evaluate(node => {
            const link = node.getBoundingClientRect(); const parent = node.closest('ol').getBoundingClientRect();
            return link.right <= parent.right + 1 && link.left >= parent.left - 1;
        }), true, 'Every step remains reachable through the internal horizontal scroll');
    });
} finally {
    await browser.close();
    await writeFile(output + 'checks.json', JSON.stringify(results, null, 2));
}
if (results.some(result => !result.passed)) process.exitCode = 1;
