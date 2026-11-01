import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { benchmarkConditionGroup } from '../../public/js/shared/benchmark-condition-groups.js';

const baseURL = process.env.BENCHPOLL_VERIFY_URL ?? 'https://benchpoll.com';
const output = 'artifacts/ranking-interactions-20261002';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];
const settle = page => page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(animation => animation.effect.getTiming().iterations !== Infinity)
        .map(animation => animation.finished.catch(() => {})));
});
try {
    for (const width of [1440, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 }, isMobile: width < 760, hasTouch: width < 760 });
        const errors = [];
        const requests = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => {
            if (request.url().includes('/api/')) requests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
        });
        try {
            const loaded = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace'), { timeout: 120000 });
            await page.goto(baseURL, { waitUntil: 'commit', timeout: 60000 });
            const response = await loaded;
            assert.equal(response.status(), 200);
            const payload = await response.json();
            assert.ok(payload.benchmarks.every(row => benchmarkConditionGroup(row) === 'primary'));
            const searched = await page.request.post(`${baseURL}/api/get_ranking_page`, { data: {
                snapshotID: payload.rankingPagination.snapshotID, list: 'benchmarks', group: 'primary',
                query: 'termnal bench 4.0'
            } });
            assert.equal(searched.status(), 200);
            assert.ok((await searched.json()).items.some(row => /Terminal.Bench 4\.0/.test(row.name)),
                'Production search handles reordered terms and a typo without changing the version');
            await page.locator('.bp-benchmark-row').first().waitFor({ timeout: 30000 });
            const other = page.locator('[aria-controls="benchmark-other-rows"]');
            const low = page.locator('[aria-controls="benchmark-low-rows"]');
            assert.equal(await other.getAttribute('aria-expanded'), 'false');
            assert.equal(await low.isVisible(), false);
            assert.equal(requests.some(item => item.path === '/api/get_ranking_page' && item.body.group === 'lowCoverage'), false);
            await other.click();
            await page.locator('#benchmark-other-rows .bp-benchmark-row').first().waitFor();
            assert.equal(await low.evaluate(node => Boolean(node.closest('#benchmark-other-rows'))), true);
            assert.equal(await low.getAttribute('aria-expanded'), 'false');
            await low.click();
            await page.locator('#benchmark-low-rows .bp-benchmark-row').first().waitFor();
            await settle(page);
            await page.screenshot({ path: `${output}/live-nested-${width}.png`, fullPage: width < 760 });
            if (width < 760) await page.locator('[data-mobile-panel="models"]').click();
            await page.locator('.bp-model-row').first().waitFor();
            const ranked = payload.modelLeaderboards.public[0];
            assert.ok(ranked.calculationScores.length);
            await page.locator('.bp-model-row').first().click();
            const used = page.getByRole('button', { name: 'Used in this ranking', exact: true });
            assert.equal(await used.getAttribute('aria-pressed'), 'true');
            assert.equal(await page.locator('#model-scores-list .bp-model-score-detail-row').count(), ranked.calculationScores.length);
            assert.equal(requests.some(item => item.path === '/api/get_approved_benchmark_results'), false);
            assert.equal(await page.locator('.bp-model-configuration-link').first().evaluate(node => getComputedStyle(node).display), 'grid');
            await settle(page);
            await page.screenshot({ path: `${output}/live-calculation-${width}.png`, fullPage: width < 760 });
            const source = page.waitForResponse(item => item.url().endsWith('/api/get_approved_benchmark_results'), { timeout: 30000 });
            await page.locator('.bp-model-configuration-link').first().click();
            assert.equal((await source).status(), 200);
            await page.locator('.bp-model-score-sample').first().waitFor();
            assert.equal(await page.locator('#model-scores-list .bp-model-score-detail-row').count(), 1);
            const all = page.waitForResponse(item => item.url().endsWith('/api/get_model_score_configurations'), { timeout: 30000 });
            await page.getByRole('button', { name: 'All scores', exact: true }).click();
            const allResponse = await all;
            assert.equal(allResponse.status(), 200);
            const configurations = (await allResponse.json()).configurations;
            assert.ok(configurations.length);
            if (configurations.length > 1) {
                await page.locator('.bp-model-configuration-link').first().waitFor();
                const scores = page.waitForResponse(item => item.url().endsWith('/api/get_approved_benchmark_results'), { timeout: 30000 });
                await page.locator('.bp-model-configuration-link').first().click();
                assert.equal((await scores).status(), 200);
            }
            await page.locator('.bp-model-score-sample').first().waitFor();
            await settle(page);
            await page.screenshot({ path: `${output}/live-all-scores-${width}.png`, fullPage: width < 760 });
            await used.click();
            assert.equal(await page.locator('.bp-model-score-sample').count(), 0);
            await page.locator('#model-scores-dialog .dialog-close-button').click();
            await page.locator('#model-comparison-toggle').click();
            assert.equal(await page.locator('#model-comparison-keys').evaluate(node => node.clientHeight <= 184), true);
            await page.locator('#model-comparison-close').click();
            const gray = page.locator('.bp-score-uncertain');
            assert.ok(await gray.count());
            assert.equal(await gray.first().evaluate(node => getComputedStyle(node).borderRadius), '0px');
            assert.match(await page.locator('.bp-score-fill').first().evaluate(node => getComputedStyle(node).clipPath), /round 5px/);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            assert.deepEqual(errors, []);
            checks.push({ width, calculationScores: ranked.calculationScores.length, configurations: configurations.length,
                groups: payload.rankingPagination.benchmarks, passed: true, errors });
        } finally { await page.close(); }
    }
    await writeFile(`${output}/live-checks.json`, JSON.stringify(checks, null, 2));
    console.log(JSON.stringify(checks));
} finally { await browser.close(); }
