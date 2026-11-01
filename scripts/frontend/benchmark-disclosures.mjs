import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createRankingPager } from '../../ranking-pagination.js';
import { startPreview } from './server.mjs';
import { workspace } from './fixtures.mjs';

const output = fileURLToPath(new URL('../../artifacts/fallback-chain-20261006/ui/', import.meta.url));
await mkdir(output, { recursive: true });
const liveURL = process.env.BENCHMARK_DISCLOSURES_URL;
const filter = process.env.BENCHMARK_DISCLOSURES_CHECK;
const results = [];
const other = page => page.locator('[aria-controls="benchmark-other-rows"]');
const lower = page => page.locator('[aria-controls="benchmark-low-rows"]');
const version = (page, ID) => page.locator(`.bp-benchmark-row:not(.is-family)[data-condition-id="${ID}"]`);
const pageRequests = requests => requests.filter(request => request.path === '/api/get_ranking_page' && request.body.list === 'benchmarks');

async function idle(page) {
    await page.waitForFunction(() => document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false'
        && !/Saving/.test(document.querySelector('#last-updated')?.textContent ?? ''));
}

async function assertDirectLower(page) {
    assert.equal(await other(page).count(), 0);
    assert.equal(await page.locator('#benchmark-rows > .bp-benchmark-low-controls > [aria-controls="benchmark-low-rows"]').count(), 1);
    assert.equal(await page.locator('#benchmark-other-rows').count(), 0);
}

async function check(browser, engine, name, width, options, action) {
    if (filter && `${engine}-${name}-${width}` !== filter) return;
    const app = await startPreview(options);
    const pager = options.lowCoverageCount ? createRankingPager() : null;
    const requests = [];
    const context = await browser.newContext({ viewport: { width, height: 940 }, isMobile: width < 500, hasTouch: width < 500 });
    const page = await context.newPage();
    page.setDefaultTimeout(18000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
        const request = route.request();
        const url = new URL(request.url());
        const body = request.postDataJSON() ?? {};
        requests.push({ path: url.pathname, body });
        if (pager && url.pathname === '/api/get_weighted_workspace') {
            const data = workspace(app.state, body, { paginate: false });
            const sparse = data.benchmarks.find(row => row.conditionID === 900);
            for (let index = 1; index < options.lowCoverageCount; index++) data.benchmarks.push({ ...sparse,
                ID: 900 + index, conditionID: 900 + index, conditionKey: `experimental-${index}`,
                conditionName: `Experimental ${index}`, rank: 8 });
            return route.fulfill({ json: pager.create(data, { userID: app.state.userID, initialMode: body.initialMode ?? 'public',
                query: body.benchmarkQuery ?? '', pinPersonal: body.pinPersonal ?? false }) });
        }
        if (pager && url.pathname === '/api/get_ranking_page') {
            return route.fulfill({ json: pager.getPage({ ...body, userID: app.state.userID }) });
        }
        if (!liveURL) return route.continue();
        return route.fulfill({ response: await route.fetch({ url: app.url + url.pathname + url.search }) });
    });
    try {
        await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded', timeout: liveURL ? 45000 : 18000 });
        await idle(page);
        await action(page, requests);
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await page.screenshot({ path: `${output}${liveURL ? 'live-' : ''}${engine}-${name}-${width}.png`, fullPage: true, animations: 'disabled' });
        results.push({ engine, name, width, passed: true });
        console.log(`PASS ${engine}-${name}-${width}`);
    } catch (error) {
        await page.screenshot({ path: `${output}${liveURL ? 'live-' : ''}${engine}-${name}-${width}-failure.png`, fullPage: true });
        results.push({ engine, name, width, passed: false, error: error.stack, errors, requests });
        console.error(`FAIL ${engine}-${name}-${width}: ${error.stack}`);
    } finally { await context.close(); await app.close(); }
}

for (const [engine, launcher, widths] of [['chromium', chromium, [1440, 390, 320]], ['webkit', webkit, [390]]]) {
    const browser = await launcher.launch({ headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    try {
        for (const width of widths) {
            await check(browser, engine, 'low-only', width, { sparseBenchmark: true }, async (page, requests) => {
                await assertDirectLower(page);
                assert.equal(await lower(page).getAttribute('aria-expanded'), 'false');
                assert.equal(pageRequests(requests).some(request => request.body.group !== 'primary'), false);
                await lower(page).click();
                await version(page, 900).waitFor();
                await assertDirectLower(page);
                assert.equal(await lower(page).getAttribute('aria-expanded'), 'true');
                await lower(page).click();
                await page.locator('#benchmark-low-rows').waitFor({ state: 'hidden' });
                await lower(page).click();
                await version(page, 900).waitFor();
                assert.equal(pageRequests(requests).filter(request => request.body.group === 'lowCoverage').length, 1);
                await page.locator('#benchmark-search').fill('Experimental');
                await page.waitForFunction(() => document.querySelector('#benchmark-rows > .bp-benchmark-entry [data-condition-id="900"]'));
                assert.equal(await lower(page).count(), 0);
                assert.equal(await other(page).count(), 0);
                await page.locator('#benchmark-search').fill('');
                await lower(page).waitFor();
                await assertDirectLower(page);
                assert.equal(await lower(page).getAttribute('aria-expanded'), 'false');
            });
            await check(browser, engine, 'mixed', width, { secondaryBenchmark: true, sparseBenchmark: true }, async page => {
                assert.equal(await other(page).getAttribute('aria-expanded'), 'false');
                assert.equal(await lower(page).isVisible(), false);
                assert.equal(await page.locator('#benchmark-other-rows .bp-benchmark-low-controls [aria-controls="benchmark-low-rows"]').count(), 1);
                await other(page).click();
                await version(page, 901).waitFor();
                assert.equal(await lower(page).getAttribute('aria-expanded'), 'false');
                assert.equal(await version(page, 900).count(), 0);
                await lower(page).click();
                await version(page, 900).waitFor();
                await other(page).click();
                await page.locator('#benchmark-other-rows').waitFor({ state: 'hidden' });
                await other(page).click();
                await version(page, 900).waitFor();
                assert.equal(await lower(page).getAttribute('aria-expanded'), 'true');
                assert.equal(await page.locator('.bp-benchmark-low-toggle').count(), 2);
            });
            await check(browser, engine, 'ordinary-only', width, { secondaryBenchmark: true }, async page => {
                assert.equal(await other(page).getAttribute('aria-expanded'), 'false');
                assert.equal(await lower(page).count(), 0);
                await other(page).click();
                await version(page, 901).waitFor();
                assert.equal(await lower(page).count(), 0);
            });
            await check(browser, engine, 'no-folded-versions', width, {}, async page => {
                assert.equal(await other(page).count(), 0);
                assert.equal(await lower(page).count(), 0);
            });
            await check(browser, engine, 'low-only-pagination', width, { sparseBenchmark: true, lowCoverageCount: 85 }, async (page, requests) => {
                await assertDirectLower(page);
                await lower(page).click();
                await version(page, 900).waitFor();
                for (const count of [40, 80, 85]) {
                    await page.waitForFunction(expected => document.querySelectorAll('#benchmark-low-rows .bp-benchmark-row').length >= expected, count);
                    await assertDirectLower(page);
                    if (count < 85) {
                        await page.locator('#benchmark-rows').evaluate(node => {
                            if (node.scrollHeight > node.clientHeight + 1) node.scrollTop = node.scrollHeight;
                            else node.querySelector('[data-benchmark-group="lowCoverage"]')?.scrollIntoView({ block: 'end', behavior: 'instant' });
                        });
                    }
                }
                assert.equal(await page.locator('#benchmark-low-rows .bp-benchmark-row').count(), 85);
                assert.deepEqual(pageRequests(requests).filter(request => request.body.group === 'lowCoverage').map(request => request.body.offset), [0, 40, 80]);
                assert.equal(pageRequests(requests).some(request => request.body.group === 'other'), false);
            });
            await check(browser, engine, 'optimistic-regrouping', width, { secondaryBenchmark: true, sparseBenchmark: true, saveDelay: 600 }, async page => {
                await page.locator('#pie-mode-personal').click();
                await idle(page);
                await other(page).click();
                await version(page, 901).waitFor();
                await lower(page).click();
                await version(page, 900).waitFor();
                await version(page, 901).locator('.bp-benchmark-add').click();
                await page.waitForFunction(() => document.querySelector('#benchmark-rows > .bp-benchmark-entry [data-condition-id="901"]'));
                await assertDirectLower(page);
                assert.equal(await version(page, 900).isVisible(), true);
                await idle(page);
                await assertDirectLower(page);
                await version(page, 901).locator('.bp-personal-weight-remove').click();
                await other(page).waitFor();
                assert.equal(await page.locator('#benchmark-rows > .bp-benchmark-low-controls > [aria-controls="benchmark-low-rows"]').count(), 0);
                assert.equal(await page.locator('#benchmark-other-rows .bp-benchmark-low-controls [aria-controls="benchmark-low-rows"]').count(), 1);
                await idle(page);
                assert.equal(await other(page).count(), 1);
            });
        }
    } finally { await browser.close(); }
}

await writeFile(`${output}${liveURL ? 'live-' : ''}${filter ? filter + '-' : ''}disclosure-checks.json`, JSON.stringify(results, null, 2));
if (results.some(result => !result.passed) || results.length === 0) process.exitCode = 1;
