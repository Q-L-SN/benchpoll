import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { benchmarkConditionGroup } from '../../public/js/shared/benchmark-condition-groups.js';

const baseURL = process.env.BENCHPOLL_VERIFY_URL ?? 'https://benchpoll.com';
const output = 'artifacts/primary-benchmark-conditions-20261002';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];
try {
    for (const width of [1440, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 }, isMobile: width < 760, hasTouch: width < 760 });
        const errors = [];
        const requests = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => {
            if (request.url().endsWith('/api/get_ranking_page')) requests.push(request.postDataJSON());
        });
        try {
            const initial = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace'), { timeout: 120000 });
            await page.goto(baseURL, { waitUntil: 'commit', timeout: 60000 });
            const response = await initial;
            assert.equal(response.status(), 200);
            const payload = await response.json();
            const pagination = payload.rankingPagination.benchmarks;
            assert.ok(payload.benchmarks.every(row => benchmarkConditionGroup(row) === 'primary'));
            assert.equal(pagination.other.nextOffset, 0);
            assert.equal(pagination.lowCoverage.nextOffset, 0);
            await page.locator('.bp-benchmark-row').first().waitFor({ timeout: 30000 });
            const other = page.locator('[aria-controls="benchmark-other-rows"]');
            const lower = page.locator('[aria-controls="benchmark-low-rows"]');
            assert.equal(await other.getAttribute('aria-expanded'), 'false');
            assert.equal(await lower.getAttribute('aria-expanded'), 'false');
            assert.ok(requests.every(request => request.group === 'primary'));
            const pages = {};
            for (const group of ['other', 'lowCoverage']) {
                const result = await page.request.post(`${baseURL}/api/get_ranking_page`, { data: {
                    snapshotID: payload.rankingPagination.snapshotID, list: 'benchmarks', group
                } });
                assert.equal(result.status(), 200);
                pages[group] = await result.json();
                assert.equal(pages[group].total, pagination[group].total);
                assert.ok(pages[group].items.length > 0);
                assert.ok(pages[group].items.every(row => benchmarkConditionGroup(row) === group));
            }
            const candidate = pages.other.items.find(row => pages.lowCoverage.items.some(item => item.benchmarkID === row.benchmarkID))
                ?? pages.other.items[0];
            const query = candidate.name;
            const searched = page.waitForResponse(item => item.url().endsWith('/api/get_ranking_page')
                && item.request().postDataJSON()?.query === query, { timeout: 30000 });
            await page.locator('#benchmark-search').fill(query);
            assert.equal((await searched).status(), 200);
            await page.waitForFunction(() => document.querySelector('[aria-controls="benchmark-other-rows"]')?.getAttribute('aria-expanded') === 'false');
            const opened = page.waitForResponse(item => item.url().endsWith('/api/get_ranking_page')
                && item.request().postDataJSON()?.group === 'other', { timeout: 30000 });
            await other.click();
            const openedData = await (await opened).json();
            assert.ok(openedData.items.every(row => benchmarkConditionGroup(row) === 'other'));
            await page.locator('#benchmark-other-rows .bp-benchmark-row').first().waitFor({ timeout: 30000 });
            if (await lower.count()) {
                assert.equal(await lower.getAttribute('aria-expanded'), 'false');
                const sparseOpened = page.waitForResponse(item => item.url().endsWith('/api/get_ranking_page')
                    && item.request().postDataJSON()?.group === 'lowCoverage', { timeout: 30000 });
                await lower.click();
                const sparseData = await (await sparseOpened).json();
                assert.ok(sparseData.items.every(row => benchmarkConditionGroup(row) === 'lowCoverage'));
                await page.locator('#benchmark-low-rows .bp-benchmark-row').first().waitFor({ timeout: 30000 });
            }
            const groupOrder = await page.locator('.bp-benchmark-low-toggle').allTextContents();
            assert.match(groupOrder[0], /other test condition/i);
            if (groupOrder.length > 1) assert.match(groupOrder[1], /lower-coverage/i);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            await page.screenshot({ path: `${output}/live-${width}.png`, fullPage: width < 760 });
            assert.deepEqual(errors, []);
            checks.push({ width, primary: pagination.primary.total, other: pagination.other.total,
                lowCoverage: pagination.lowCoverage.total, query, groupOrder, passed: true });
        } finally { await page.close(); }
    }
    await writeFile(`${output}/live-checks.json`, JSON.stringify(checks, null, 2));
    console.log(JSON.stringify(checks));
} finally { await browser.close(); }
