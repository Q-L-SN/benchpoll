import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';
import { familyEntries } from './fixtures.mjs';

const liveURL = process.env.FAMILY_TEST_URL;
const selectedCase = process.env.FAMILY_TEST_CASE;
const output = fileURLToPath(new URL('../../artifacts/ordered-families-20261004/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
const rule = (IDs, familyID = null) => ({ primaryConditionID: 1, familyID, mode: 'ordered', entries: familyEntries(IDs.map(conditionID => ({ conditionID }))) });
const composition = [
    [[2, 3], 8000], [[3], 1000], [[], 400], [[4], 200], [[5], 200], [[6], 200]
].map(([IDs, weightBasisPoints], index) => ({ ...rule(IDs, IDs.length ? index + 1 : null), weightBasisPoints, overallWeightBasisPoints: weightBasisPoints }));
async function check(name, options, action) {
    if (selectedCase && name !== selectedCase) return;
    const app = await startPreview(options);
    const context = await browser.newContext({ viewport: { width: options.width ?? 1440, height: 1000 },
        reducedMotion: options.reducedMotion ?? 'no-preference' });
    const page = await context.newPage();
    page.setDefaultTimeout(liveURL ? 60000 : 10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (liveURL) await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        const response = await route.fetch({ url: app.url + url.pathname + url.search });
        await route.fulfill({ response });
    });
    try {
        await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded' });
        await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
        await action({ page, app });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'No horizontal overflow');
        assert.deepEqual(errors, [], 'No browser exceptions');
        await page.screenshot({ path: output + `${liveURL ? 'live-' : ''}${name}.png`, fullPage: true, animations: 'disabled' });
        results.push({ name, passed: true }); console.log('PASS ' + name);
    } catch (error) {
        results.push({ name, passed: false, error: error.message, browserErrors: errors });
        await page.screenshot({ path: output + name + '-failure.png', fullPage: true, animations: 'disabled' });
        console.error('FAIL ' + name + ': ' + error.message);
    } finally { await context.close(); await app.close(); }
}
const row = (page, ID) => page.locator(`.bp-benchmark-row:not(.is-family)[data-condition-id="${ID}"]`);
const ids = async page => page.locator('.bp-family-member').evaluateAll(nodes => nodes.map(node => Number(node.dataset.conditionId)));
async function savedOrder(page, IDs, app) {
    const deadline = Date.now() + 15000;
    while (JSON.stringify(app.state.fallbackRules[0]?.entries.map(entry => entry.conditionID) ?? []) !== JSON.stringify(IDs)) {
        if (Date.now() > deadline) throw new Error('Latest edited order was not persisted');
        await delay(30);
    }
    await page.waitForFunction(expected => {
        const text = document.querySelector('#last-updated')?.textContent ?? '';
        return /Saved|Last updated/.test(text) && JSON.stringify([...document.querySelectorAll('.bp-family-member')].map(row => Number(row.dataset.conditionId))) === JSON.stringify(expected);
    }, IDs);
}
try {
    for (const width of [1440, 390, 320]) {
        await check('ordered-editor-' + width, { width, saveDelay: 600 }, async ({ page, app }) => {
            await page.locator('#pie-mode-personal').click();
            await page.locator('#inline-fallback-toggle').click();
            const chart = page.locator('#inline-fallback-chart');
            await chart.waitFor();
            assert.equal(await chart.evaluate(node => node.classList.contains('is-target-active') && node.classList.contains('bp-weight-setup-glow')), true);
            assert.equal(await page.locator('#inline-fallback-toggle').getAttribute('aria-expanded'), 'true');
            await row(page, 2).locator('.bp-benchmark-add').click(); await row(page, 3).locator('.bp-benchmark-add').click();
            assert.deepEqual(await ids(page), [2, 3]);
            await page.waitForResponse(response => response.url().includes('/api/save_personal_pie') && response.ok());
            await page.waitForFunction(() => document.querySelector('.bp-benchmark-fallbacks[data-entrance-id="1"]'));
            assert.equal(app.state.fallbackRules[0].mode, 'ordered');
            assert.equal(Object.hasOwn(app.state.fallbackRules[0].entries[0], 'weightBasisPoints'), false);
            await chart.getByRole('button', { name: 'Move Code generation earlier', exact: true }).click();
            assert.deepEqual(await ids(page), [3, 2]);
            // Keep editing while the preceding save is in flight.
            await page.waitForRequest(request => request.url().includes('/api/save_personal_pie'));
            await chart.getByRole('button', { name: 'Remove Advanced reasoning from fallback', exact: true }).click();
            assert.deepEqual(await ids(page), [3]);
            await savedOrder(page, [3], app);
            await page.waitForFunction(() => !document.querySelector('#last-updated')?.textContent?.includes('Saving'));
            assert.equal(await chart.evaluate(node => node.classList.contains('bp-weight-setup-glow')), false);
            await chart.getByRole('button', { name: 'Remove Code generation from fallback', exact: true }).click();
            assert.equal(await chart.evaluate(node => node.classList.contains('bp-weight-setup-glow')), true);
            await row(page, 4).locator('.bp-benchmark-add').click();
            assert.deepEqual(await ids(page), [4]);
            await savedOrder(page, [4], app);
            assert.deepEqual(app.state.fallbackRules[0].entries.map(entry => entry.conditionID), [4]);
            assert.equal(app.state.personalEntries.filter(entry => entry.conditionID === 1).length, 1);
        });
        await check('public-composition-' + width, { width, authenticated: false,
            publicWeights: [{ conditionID: 1, weightBasisPoints: 10000 }],
            publicFamilyComposition: [{ primaryConditionID: 1, families: composition }],
            families: composition.filter(value => value.entries.length) }, async ({ page, app }) => {
            await page.locator('#weight-pie g[data-object-id="1"]').click();
            await page.locator('#public-fallback-toggle').click();
            const chart = page.locator('#inline-fallback-chart');
            await chart.waitFor();
            assert.equal(await chart.locator('.bp-family-composition-segment').count(), 4);
            assert.match(await chart.innerText(), /No fallback/);
            const other = chart.locator('.bp-family-other-toggle');
            assert.equal(await other.getAttribute('aria-expanded'), 'false');
            assert.match(await other.innerText(), /Other fallback configurations \(3\)/);
            assert.match(await other.innerText(), /6%/);
            await other.click();
            await chart.locator('.bp-family-other-list').waitFor();
            assert.equal(await chart.locator('.bp-family-other-list .bp-family-composition-row').count(), 3);
            assert.equal(await chart.locator('.bp-family-action').count(), 0);
            await page.locator('#public-fallback-toggle').click(); await chart.waitFor({ state: 'hidden' });
            await page.locator('#public-fallback-toggle').click();
            assert.equal(await other.getAttribute('aria-expanded'), 'true');
            assert.equal(app.state.requests.filter(value => value.path === '/api/save_personal_pie').length, 0);
        });
    }
    await check('search-reuse-and-replace', { families: [rule([2, 3], 20), rule([3, 2], 21)] }, async ({ page, app }) => {
        await page.locator('#pie-mode-personal').click();
        const before = app.state.personalEntries.find(entry => entry.conditionID === 1).weightBasisPoints;
        await page.locator('#benchmark-search').fill('Code generation');
        await page.locator('.bp-benchmark-fallbacks[data-entrance-id="1"] .bp-benchmark-fallback-toggle').click();
        const family = page.locator('.bp-benchmark-row[data-family-key="[1,2,3]"]');
        await family.waitFor(); await family.locator('.bp-benchmark-add').click();
        await page.waitForResponse(response => response.url().includes('/api/save_personal_pie') && response.ok());
        assert.equal(app.state.fallbackRules[0].familyID, 20);
        assert.equal(app.state.personalEntries.filter(entry => entry.conditionID === 1).length, 1);
        assert.equal(app.state.personalEntries.find(entry => entry.conditionID === 1).weightBasisPoints, before);
        await page.locator('.bp-benchmark-row[data-family-key="[1,3,2]"] .bp-benchmark-add').click();
        await page.waitForResponse(response => response.url().includes('/api/save_personal_pie') && response.ok());
        assert.equal(app.state.fallbackRules[0].familyID, 21);
        assert.equal(app.state.personalEntries.find(entry => entry.conditionID === 1).weightBasisPoints, before);
        assert.equal(await page.locator('#weight-pie g[data-object-id="1"]').count(), 1);
    });
    await check('drag-reorder', { fallbackRules: [rule([2, 3, 4], 1)] }, async ({ page, app }) => {
        await page.locator('#pie-mode-personal').click();
        await page.locator('#inline-fallback-toggle').click();
        const chart = page.locator('#inline-fallback-chart');
        await chart.waitFor();
        await page.locator('#inline-fallback-settings').evaluate(async node => {
            for (const animation of node.getAnimations({ subtree: true })) await animation.finished;
        });
        const from = await chart.locator('[data-condition-id="2"] .bp-family-drag').boundingBox();
        const to = await chart.locator('[data-condition-id="4"]').boundingBox();
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
        await page.mouse.down();
        await page.mouse.move(from.x + from.width / 2, to.y + to.height - 4, { steps: 12 });
        await page.mouse.up();
        assert.deepEqual(await ids(page), [3, 4, 2]);
        await savedOrder(page, [3, 4, 2], app);
        assert.deepEqual(app.state.fallbackRules[0].entries.map(entry => entry.conditionID), [3, 4, 2]);
    });
    await check('guest-keyboard-reduced-motion', { authenticated: false, width: 390, reducedMotion: 'reduce' }, async ({ page, app }) => {
        await page.locator('#personal-pie-create').click(); await row(page, 1).locator('.bp-benchmark-add').click();
        await page.locator('#inline-fallback-toggle').click(); await row(page, 2).locator('.bp-benchmark-add').click(); await row(page, 3).locator('.bp-benchmark-add').click();
        const up = page.getByRole('button', { name: 'Move Code generation earlier', exact: true });
        await up.focus(); await page.keyboard.press('Enter');
        assert.deepEqual(await ids(page), [3, 2]);
        assert.equal(await page.locator('#inline-fallback-chart').evaluate(node => getComputedStyle(node, '::after').animationName), 'none');
        await page.waitForResponse(response => response.url().includes('/api/get_weighted_workspace') && response.ok());
        assert.equal(app.state.requests.filter(value => value.path === '/api/save_personal_pie').length, 0);
    });
} finally {
    await browser.close();
    await writeFile(output + `${liveURL ? 'live-' : ''}${selectedCase ? selectedCase + '-' : ''}results.json`, JSON.stringify(results, null, 2));
}
assert.ok(results.length > 0, 'No matching test case');
if (results.some(result => !result.passed)) process.exitCode = 1;
