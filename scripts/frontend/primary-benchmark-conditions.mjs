import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';

const output = 'artifacts/primary-benchmark-conditions-20261002';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];
try {
    for (const width of [1440, 390, 320]) {
        const app = await startPreview({ secondaryBenchmark: true, sparseBenchmark: true });
        const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width < 760, hasTouch: width < 760 });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        try {
            await page.goto(app.url);
            await page.locator('.bp-benchmark-row').first().waitFor();
            const other = page.locator('[aria-controls="benchmark-other-rows"]');
            const lower = page.locator('[aria-controls="benchmark-low-rows"]');
            assert.equal(await other.getAttribute('aria-expanded'), 'false');
            assert.equal(await lower.getAttribute('aria-expanded'), 'false');
            assert.equal(app.state.requests.some(request => request.path === '/api/get_ranking_page' && request.body.group !== 'primary'), false);
            await other.click();
            await page.locator('#benchmark-other-rows [data-condition-id="901"]').waitFor();
            assert.equal(await lower.getAttribute('aria-expanded'), 'false');
            await lower.click();
            await page.locator('#benchmark-low-rows [data-condition-id="900"]').waitFor();
            const groups = await page.locator('.bp-benchmark-low-toggle').allTextContents();
            assert.match(groups[0], /other test condition/);
            assert.match(groups[1], /lower-coverage/);
            await page.screenshot({ path: `${output}/groups-${width}.png`, fullPage: true });
            await page.locator('#pie-mode-personal').click();
            const saved = page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie'));
            await page.locator('#benchmark-low-rows [data-condition-id="900"]').click();
            await page.locator('#weight-pie g[data-object-id="900"]').waitFor();
            await saved;
            assert.equal(await page.locator('[aria-controls="benchmark-low-rows"]').count(), 0);
            await page.locator('#weight-pie [data-object-id="1"] .bp-pie-slice').click();
            await page.locator('#weight-pie [data-object-id="900"] .bp-pie-slice').click();
            await page.locator('#benchmark-rows > [data-condition-id="900"]').waitFor();
            assert.equal(await page.locator('#benchmark-low-rows [data-condition-id="900"]').count(), 0);
            await page.locator('#benchmark-search').fill('Experimental');
            await page.waitForResponse(response => response.url().endsWith('/api/get_ranking_page') && response.request().postDataJSON().query === 'Experimental');
            assert.equal(await page.locator('[aria-controls="benchmark-low-rows"]').count(), 0);
            await page.locator('#benchmark-rows > [data-condition-id="900"]').waitFor();
            assert.equal(await page.locator('.bp-benchmark-row').count(), 1);
            await page.goto(`${app.url}/contribute?mode=new_benchmark`);
            await page.locator('[data-evaluation-name]').fill('Primary condition fixture');
            await page.locator('[data-action="add-profile"]').click();
            await page.locator('[data-condition-input]').nth(1).fill('overall');
            await page.locator('[data-action="set-primary-condition"]').nth(1).check();
            assert.equal(await page.locator('[name="primary-condition"]:checked').count(), 1);
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: `${output}/form-${width}.png`, fullPage: true });
            await page.locator('[data-action="remove-profile"]').nth(1).click();
            await page.waitForFunction(() => document.querySelectorAll('[data-condition-input]').length === 1);
            assert.equal(await page.locator('[name="primary-condition"]:checked').count(), 1);
            await page.locator('#submit-contribution').click();
            await page.waitForResponse(response => response.url().endsWith('/api/submit_contribution'));
            const submission = app.state.requests.find(request => request.path === '/api/submit_contribution');
            assert.ok(submission);
            assert.equal(submission.body.benchmarks[0].conditions.filter(condition => condition.isPrimary).length, 1);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            assert.deepEqual(errors, []);
            checks.push({ width, groups, passed: true });
        } finally { await context.close(); await app.close(); }
    }
    const app = await startPreview({ secondaryBenchmark: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    try {
        await page.goto(`${app.url}/contribute?mode=edit_benchmark&targetBenchmarkID=101`);
        await page.locator('[name="primary-condition"]').nth(1).check();
        await page.locator('[data-restore-path="evaluation.primaryCondition"]').click();
        assert.equal(await page.locator('[name="primary-condition"]').first().isChecked(), true);
        checks.push({ editPrimaryRestore: true });
    } finally { await page.close(); await app.close(); }
    const duplicateApp = await startPreview({ secondaryBenchmark: true, sparseBenchmark: true });
    const duplicatePage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    try {
        await duplicatePage.route('**/api/get_contribution_target', async route => {
            const response = await route.fetch();
            const payload = await response.json();
            payload.form.conditions[2].name = payload.form.conditions[1].name;
            await route.fulfill({ response, json: payload });
        });
        await duplicatePage.goto(`${duplicateApp.url}/contribute?mode=edit_benchmark&targetBenchmarkID=101`);
        await duplicatePage.locator('[name="primary-condition"]').nth(2).check();
        const submitted = duplicatePage.waitForResponse(response => response.url().endsWith('/api/submit_contribution'));
        await duplicatePage.locator('#submit-contribution').click();
        assert.equal((await submitted).status(), 200);
        const request = duplicateApp.state.requests.find(request => request.path === '/api/submit_contribution');
        const conditions = request.body.proposed.conditions;
        assert.deepEqual(conditions.map(condition => condition.ID), [1, 901, 900]);
        assert.equal(conditions.filter(condition => condition.isPrimary).length, 1);
        assert.equal(conditions[2].isPrimary, true);
        assert.equal(conditions[1].name, conditions[2].name);
        checks.push({ unchangedDuplicateLabelsKeepIDs: true });
    } finally { await duplicatePage.close(); await duplicateApp.close(); }
    await writeFile(`${output}/frontend-checks.json`, JSON.stringify(checks, null, 2));
    console.log(JSON.stringify(checks));
} finally { await browser.close(); }
