import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.BENCHPOLL_VERIFY_URL || 'https://benchpoll.com';
const output = 'artifacts/contribution-polish-20261004/live';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];
try {
    for (const width of [1440, 390, 320]) {
        const page = await browser.newPage({ viewport: { width, height: 950 }, isMobile: width < 761, hasTouch: width < 761 });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.setDefaultTimeout(45000);
        try {
            await page.goto(base, { waitUntil: 'commit', timeout: 60000 });
            await page.locator('#benchmark-rows .bp-benchmark-information-link').first().waitFor({ state: 'attached' });
            if (width < 761) await page.locator('button[data-mobile-panel="mix"]').click();
            const information = page.waitForResponse(response => response.url().endsWith('/api/get_benchmark_information'));
            await page.locator('#benchmark-rows .bp-benchmark-information-link').first().click();
            const infoResponse = await information;
            assert.equal(infoResponse.status(), 200);
            const info = await infoResponse.json();
            await page.locator('#benchmark-scores-open:not([hidden])').waitFor();
            await page.waitForTimeout(400);
            assert.equal(await page.locator('.discussion-heading #category-path').count(), 0);
            assert.equal(await page.locator('#benchmark-discussion-view #category-path').count(), 1);
            if (info.scoresUpdatedAt) assert.match(await page.locator('#benchmark-information-age').textContent(), /^\(.+\)$/);
            await page.screenshot({ path: `${output}/information-${width}.png` });
            const firstPage = page.waitForResponse(response => response.url().endsWith('/api/get_benchmark_scores'));
            await page.locator('#benchmark-scores-open').click();
            const firstResponse = await firstPage;
            assert.equal(firstResponse.status(), 200);
            const first = await firstResponse.json();
            await page.waitForFunction(count => document.querySelectorAll('.benchmark-score-row').length === count, first.scores.length);
            assert.equal(first.benchmarkID, info.benchmarkID);
            assert.equal(first.conditionID, info.conditionID);
            assert.equal(await page.locator('#discussion-composer').isVisible(), false);
            if (first.scores.length) {
                assert.match(await page.locator('.benchmark-score-value').first().textContent(), new RegExp(String(first.scores[0].rawScore).replace('.', '\\.')));
            }
            await page.waitForTimeout(250);
            await page.screenshot({ path: `${output}/scores-${width}.png` });
            if (first.nextBeforeID) {
                const nextResponse = page.waitForResponse(response => response.url().endsWith('/api/get_benchmark_scores'));
                await page.locator('#benchmark-scores-more').click();
                const secondResponse = await nextResponse;
                assert.equal(secondResponse.status(), 200);
                const second = await secondResponse.json();
                await page.waitForFunction(count => document.querySelectorAll('.benchmark-score-row').length === count, first.scores.length + second.scores.length);
                assert.ok(second.scores.every(score => score.ID < first.nextBeforeID));
            }
            if (first.conditions.length > 1) {
                const alternate = first.conditions.find(condition => condition.ID !== first.conditionID);
                const changedResponse = page.waitForResponse(response => response.url().endsWith('/api/get_benchmark_scores'));
                await page.locator('#benchmark-scores-condition').selectOption(String(alternate.ID));
                const changed = await changedResponse;
                assert.equal(changed.status(), 200);
                const data = await changed.json();
                assert.equal(data.conditionID, alternate.ID);
                await page.waitForFunction(count => document.querySelectorAll('.benchmark-score-row').length === count, data.scores.length);
            }
            await page.locator('#benchmark-scores-back').click();
            assert.equal(await page.locator('#discussion-composer').isVisible(), true);
            await page.locator('#discussion-close').click();
            await page.goto(`${base}/contribute/benchmarks/new`, { waitUntil: 'commit' });
            await page.locator('#contribution-page-help').click();
            const guide = page.locator('#contribution-guide-dialog');
            await guide.waitFor();
            assert.equal(await guide.locator('section').count(), 5);
            await page.waitForTimeout(250);
            await page.screenshot({ path: `${output}/guide-${width}.png` });
            await guide.locator('global-dialog-action').click();
            assert.equal(await guide.isVisible(), false);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            assert.deepEqual(errors, []);
            checks.push({ width, benchmarkID: info.benchmarkID, conditionID: info.conditionID,
                scores: first.scores.length, conditionCount: first.conditions.length, guide: true, browserErrors: errors });
            console.log(`PASS public benchmark browser and contribution guide at ${width}px`);
        } finally { await page.close(); }
    }
} finally { await browser.close(); }
await writeFile(`${output}/results.json`, JSON.stringify({ passed: true, readOnly: true, checks }, null, 2));
console.log(JSON.stringify({ passed: true, readOnly: true, checks }));
