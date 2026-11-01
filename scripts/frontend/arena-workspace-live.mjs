import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseURL = process.env.BENCHPOLL_VERIFY_URL || 'https://benchpoll.com';
const output = 'artifacts/arena-workspace-20261003/live';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];
try {
    for (const width of [1440, 390, 320]) {
        const page = await browser.newPage({ viewport: { width, height: 950 }, isMobile: width < 760, hasTouch: width < 760 });
        page.setDefaultTimeout(45000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        try {
            await page.goto(baseURL, { waitUntil: 'commit', timeout: 60000 });
            await page.locator('#benchmark-rows .bp-benchmark-information-link').first().waitFor({ state: 'attached' });
            if (width < 761) await page.locator('button[data-mobile-panel="mix"]').click();
            assert.equal(await page.locator('#benchmark-rows .bp-benchmark-edit').count(), 0);
            const information = page.waitForResponse(response => response.url().endsWith('/api/get_benchmark_information'));
            await page.locator('#benchmark-rows .bp-benchmark-information-link').first().click();
            const response = await information;
            assert.equal(response.status(), 200);
            const data = await response.json();
            await page.locator('#benchmark-information-change:not([hidden])').waitFor();
            assert.equal(await page.locator('#benchmark-information-name').textContent(), data.name);
            assert.equal(await page.locator('#benchmark-information-condition').textContent(), data.conditionName);
            const displayedDate = await page.locator('#benchmark-information-updated').getAttribute('datetime');
            assert.equal(displayedDate ? Date.parse(displayedDate) : null, data.scoresUpdatedAt ? Date.parse(data.scoresUpdatedAt) : null);
            assert.match(await page.locator('#benchmark-information-change').getAttribute('href'), new RegExp(`/benchmarks/${data.benchmarkID}/edit`));
            await page.waitForTimeout(400);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            await page.screenshot({ path: `${output}/information-${width}.png`, fullPage: width < 760 });
            await page.locator('#discussion-close').click();
            if (width < 761) await page.locator('button[data-mobile-panel="models"]').click();
            await page.locator('#model-comparison-toggle').click();
            assert.equal(await page.getByRole('button', { name: 'Apply filters', exact: true }).count(), 0);

            await page.goto(`${baseURL}/contribute/benchmarks/new`, { waitUntil: 'commit' });
            await page.locator('[data-evaluation-name]').waitFor({ state: 'attached' });
            await page.locator('#auth-missing:not([hidden])').waitFor();
            assert.equal(await page.locator('#contribution-tree').count(), 0);
            assert.equal(await page.locator('[data-field="description"]').count(), 1);
            assert.equal(await page.locator('[data-field="requestOfficialSync"]').count(), 1);
            await page.screenshot({ path: `${output}/benchmark-form-${width}.png`, fullPage: width < 760 });
            assert.deepEqual(errors, []);
            checks.push({ width, conditionID: data.conditionID, informationRail: true, optionalIntroduction: true,
                syncRequest: true, submissionRequiresLogin: true, noCategoryTree: true, noApplyButton: true, browserErrors: errors });
            console.log(`PASS live information rail and form shell at ${width}px`);
        } finally { await page.close(); }
    }
    await writeFile(`${output}/results.json`, JSON.stringify({ passed: true, readOnly: true, checks }, null, 2));
    console.log(JSON.stringify({ passed: true, readOnly: true, checks }));
} finally { await browser.close(); }
