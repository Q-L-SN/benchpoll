import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { benchmarks, familyEntries } from './fixtures.mjs';

const output = fileURLToPath(new URL('../../artifacts/fallback-chain-polish-20261006/ui/', import.meta.url));
await mkdir(output, { recursive: true });
const liveURL = process.env.FALLBACK_CHAIN_POLISH_URL;
const results = [];
const rule = { primaryConditionID: 1, familyID: 19, mode: 'ordered',
    entries: familyEntries([{ kind: 'other_versions' }, { conditionID: 2 }, { kind: 'other_versions' }, { conditionID: 3 }]) };
const long = { primaryConditionID: 1, familyID: 30, mode: 'ordered', entries: Array.from({ length: 40 }, (_, index) => ({
    ...benchmarks[1], ID: index + 1001, conditionID: index + 1001, benchmarkID: index + 2001,
    name: `Alternative benchmark ${index + 1}`, conditionName: `Version ${index + 1}`, conditionKey: `v-${index + 1}`, isDefaultCondition: false })) };
const single = { primaryConditionID: 1, familyID: 31, mode: 'ordered', entries: familyEntries([{ conditionID: 2 }]) };
const composition = [{ primaryConditionID: 1, families: [rule, long, single].map((value, index) => ({ ...value,
    weightBasisPoints: [6000, 3000, 1000][index], overallWeightBasisPoints: [1560, 780, 260][index] })) }];
const saves = app => app.state.requests.filter(request => request.path === '/api/save_personal_pie').length;
const ordinary = (page, ID) => page.locator(`.bp-benchmark-row:not(.is-family)[data-condition-id="${ID}"]`);
const family = (page, ID) => page.locator('.bp-benchmark-row.is-family').filter({
    has: page.locator(`[data-family-member-key="${ID}"]`) }).first();
async function idle(page) {
    await page.waitForFunction(() => document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false'
        && !/Saving/.test(document.querySelector('#last-updated')?.textContent ?? ''));
}
async function edges(chain, expected) {
    await chain.evaluate(node => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await chain.page().waitForFunction(({ key, expected }) => {
        const node = [...document.querySelectorAll('.bp-benchmark-row.is-family')].find(row => row.dataset.familyKey === key)
            ?.querySelector('.bp-benchmark-family-identity');
        return node && node.classList.contains('can-scroll-left') === expected.left
            && node.classList.contains('can-scroll-right') === expected.right;
    }, { key: await chain.evaluate(node => node.closest('.bp-benchmark-row').dataset.familyKey), expected });
    const appearance = await chain.evaluate(node => ({
        left: getComputedStyle(node.parentElement, '::before').opacity,
        right: getComputedStyle(node.parentElement, '::after').opacity,
        pointerEvents: getComputedStyle(node.parentElement, '::after').pointerEvents
    }));
    assert.equal(appearance.pointerEvents, 'none');
    await chain.page().waitForFunction(({ key, expected }) => {
        const node = [...document.querySelectorAll('.bp-benchmark-row.is-family')].find(row => row.dataset.familyKey === key)
            ?.querySelector('.bp-benchmark-family-identity');
        return node && getComputedStyle(node, '::before').opacity === String(Number(expected.left))
            && getComputedStyle(node, '::after').opacity === String(Number(expected.right));
    }, { key: await chain.evaluate(node => node.closest('.bp-benchmark-row').dataset.familyKey), expected });
}
async function choose(page, value) {
    await page.locator('#workspace-style-toggle').click();
    await page.locator('#workspace-style-target').selectOption('chain');
    await page.locator(`[data-style-kind="chain"] [data-layout-option="${value}"]`).click();
    await page.keyboard.press('Escape');
}
async function labels(scope, count) {
    assert.equal(await scope.locator('.bp-auto-version-button').count(), count);
    assert.equal(await scope.locator('.bp-auto-version-button small, .bp-auto-version-button .bp-auto-version-badge').count(), 0);
    assert.deepEqual(await scope.locator('.bp-auto-version-button').allInnerTexts(), Array(count).fill('All other versions'));
}

for (const [engine, launcher, widths] of [['chromium', chromium, [1440, 390, 320]], ['webkit', webkit, [390]]]) {
    const browser = await launcher.launch({ headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    try {
        for (const width of widths) {
            const app = await startPreview({ families: [rule, long, single], fallbackRules: [rule], publicFamilyComposition: composition,
                secondaryBenchmark: true, sparseBenchmark: true });
            const context = await browser.newContext({ viewport: { width, height: 940 }, isMobile: width < 500, hasTouch: width < 500 });
            const page = await context.newPage(); page.setDefaultTimeout(20000);
            const errors = []; page.on('pageerror', error => errors.push(error.message));
            if (liveURL) await page.route('**/api/**', async route => {
                const url = new URL(route.request().url());
                await route.fulfill({ response: await route.fetch({ url: app.url + url.pathname + url.search }) });
            });
            try {
                await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded', timeout: liveURL ? 45000 : 20000 });
                await idle(page); await page.evaluate(() => document.fonts.ready);
                assert.equal(await page.locator('#benchmark-card').getAttribute('data-add-layout'), 'label');
                assert.equal(await page.locator('#benchmark-card').getAttribute('data-chain-layout'), 'inline');
                assert.equal(await page.locator('body').getAttribute('data-contribution-layout'), 'heading');
                const dynamic = family(page, 'other:0');
                await labels(dynamic, 2);
                assert.equal(await dynamic.locator('.is-entrance-attached-group .bp-fallback-attachment').count(), 0);
                assert.equal(await dynamic.locator('.has-attached-version-group .bp-fallback-attachment').count(), 1);
                assert.match(await dynamic.locator('.bp-auto-version-button').first().getAttribute('aria-label'), /General knowledge/);
                await dynamic.locator('.bp-auto-version-button').first().click();
                await page.locator('#version-group-dialog .bp-version-group-body[aria-busy="false"]').waitFor();
                assert.equal(await page.locator('.bp-version-group-introduction strong').innerText(), 'General knowledge');
                assert.equal(await page.locator('.bp-version-group-rules').isVisible(), true);
                await page.locator('#version-group-dialog .dialog-close-button').click();

                const chain = family(page, '1001').locator('.bp-benchmark-family-chain');
                await chain.scrollIntoViewIfNeeded();
                await chain.evaluate(node => { node.scrollLeft = 0; });
                await edges(chain, { left: false, right: true });
                await family(page, '1001').screenshot({ path: `${output}${liveURL ? 'live-' : ''}${engine}-${width}-start.png`, animations: 'disabled' });
                await chain.evaluate(node => { node.scrollLeft = (node.scrollWidth - node.clientWidth) / 2; });
                await edges(chain, { left: true, right: true });
                await family(page, '1001').screenshot({ path: `${output}${liveURL ? 'live-' : ''}${engine}-${width}-middle.png`, animations: 'disabled' });
                await chain.evaluate(node => { node.scrollLeft = node.scrollWidth; });
                await edges(chain, { left: true, right: false });
                await family(page, '1001').screenshot({ path: `${output}${liveURL ? 'live-' : ''}${engine}-${width}-end.png`, animations: 'disabled' });
                await chain.locator('.bp-fallback-step-name').first().focus();
                await edges(chain, { left: false, right: true });
                await choose(page, 'vertical');
                assert.equal(await chain.evaluate(node => getComputedStyle(node.parentElement, '::after').content), 'none');
                await choose(page, 'inline');
                await chain.evaluate(node => { node.scrollLeft = 0; }); await edges(chain, { left: false, right: true });
                await page.setViewportSize({ width: 1024, height: 940 });
                await edges(chain, { left: false, right: true });
                await page.setViewportSize({ width, height: 940 });
                await page.emulateMedia({ reducedMotion: 'reduce' });
                assert.equal(await chain.evaluate(node => getComputedStyle(node.parentElement, '::before').transitionDuration), '0s');
                await page.locator('#workspace-refresh').click(); await idle(page);
                await edges(chain, { left: false, right: true });
                const fitting = page.locator('.bp-benchmark-row.is-family').filter({
                    has: page.locator('.bp-fallback-step-name[data-family-member-key="2"]') }).filter({ hasNot: page.locator('[data-family-member-key="3"]') });
                await fitting.locator('.bp-benchmark-family-identity').evaluate(node => { node.style.width = '200px'; });
                await edges(fitting.locator('.bp-benchmark-family-chain'), { left: false, right: false });
                await fitting.locator('.bp-benchmark-family-identity').evaluate(node => { node.style.width = ''; });

                await ordinary(page, 1).locator('.bp-benchmark-public-weight').click();
                await page.locator('#public-fallback-toggle').click();
                const summary = page.locator('#inline-fallback-chart .bp-family-summary').first();
                await summary.click();
                const publicList = page.locator('#inline-fallback-chart .bp-family-expanded-chain').first();
                await labels(publicList, 2);
                assert.deepEqual(await publicList.locator('.bp-family-attachment > span').allTextContents(), ['General knowledge', 'Advanced reasoning']);
                assert.equal(await publicList.locator('.bp-family-attachment .fa-link').count(), 2);

                await page.locator('#pie-mode-personal').click(); await idle(page);
                await ordinary(page, 2).locator('.bp-benchmark-personal-weight').click();
                await ordinary(page, 1).locator('.bp-benchmark-personal-weight').click();
                assert.equal(await page.locator('#discussion-panel').isVisible(), false);
                await page.locator('#inline-fallback-toggle').click();
                const personalList = page.locator('#inline-fallback-chart .bp-family-chain');
                await labels(personalList, 2);
                assert.deepEqual(await personalList.locator('.bp-family-attachment > span').allTextContents(), ['General knowledge', 'Advanced reasoning']);
                assert.equal(await personalList.locator('.bp-family-attachment .fa-link').count(), 2);
                const saved = saves(app);
                const snapshot = JSON.stringify(app.state.personalEntries);
                await chain.scrollIntoViewIfNeeded(); await chain.hover();
                if (engine === 'webkit' && width < 500) await chain.dispatchEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
                else await page.mouse.wheel(0, 100);
                await page.waitForTimeout(600);
                assert.equal(saves(app), saved);
                assert.equal(JSON.stringify(app.state.personalEntries), snapshot);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                assert.deepEqual(errors, []);
                await page.locator('#pie-card').screenshot({ path: `${output}${liveURL ? 'live-' : ''}${engine}-${width}-personal-list.png`, animations: 'disabled' });
                results.push({ engine, width, passed: true }); console.log(`PASS ${engine}-${width}`);
            } catch (error) {
                await page.screenshot({ path: `${output}${liveURL ? 'live-' : ''}${engine}-${width}-failure.png`, fullPage: true });
                results.push({ engine, width, passed: false, error: error.stack, errors }); console.error(`FAIL ${engine}-${width}: ${error.stack}`);
            } finally { await context.close(); await app.close(); }
        }
    } finally { await browser.close(); }
}
await writeFile(`${output}${liveURL ? 'live-' : ''}checks.json`, JSON.stringify(results, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
