import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';

const output = 'artifacts/arena-workspace-20261003/ui';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];
try {
    for (const width of [1440, 390, 320]) {
        const preview = await startPreview();
        const page = await browser.newPage({ viewport: { width, height: 950 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.setDefaultTimeout(12000);
        try {
            await page.goto(preview.url);
            await page.locator('#model-comparison-toggle:not([disabled])').waitFor({ state: 'attached' });
            assert.equal(await page.locator('#benchmark-rows .bp-benchmark-edit').count(), 0);
            if (width < 761) await page.locator('button[data-mobile-panel="mix"]').click();
            const discussion = page.locator('#benchmark-rows .bp-benchmark-information-link').first();
            await discussion.click();
            await page.locator('#benchmark-information-change:not([hidden])').waitFor();
            assert.equal(await page.locator('#benchmark-information-name').textContent(), 'General knowledge');
            assert.equal(await page.locator('#benchmark-information-condition').textContent(), 'default');
            assert.match(await page.locator('#benchmark-information-description').textContent(), /reproducible/);
            assert.equal(await page.locator('#benchmark-information-updated').getAttribute('datetime'), '2026-10-03T06:00:00.000Z');
            assert.match(await page.locator('#benchmark-information-change').getAttribute('href'), /benchmarks\/101\/edit/);
            assert.equal(preview.state.requests.filter(item => item.path === '/api/get_discussion').at(-1).body.conditionID, 1);
            await page.waitForTimeout(400);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
            await page.screenshot({ path: `${output}/information-${width}.png`, fullPage: true });
            await page.locator('#discussion-close').click();

            if (width === 1440) {
                const indicator = () => page.locator('.bp-mode-switch').evaluate(node =>
                    new DOMMatrix(getComputedStyle(node, '::before').transform).m41);
                const publicX = await indicator();
                await page.locator('#pie-mode-personal').click();
                await page.waitForTimeout(70);
                const middleX = await indicator();
                assert.ok(middleX > 0 && middleX < publicX, 'Weight-source indicator must slide through an intermediate position');
                await page.waitForTimeout(420);
                assert.equal(await indicator(), 0);
                await page.emulateMedia({ reducedMotion: 'reduce' });
                await page.locator('#pie-mode-public').click();
                assert.ok(await page.locator('.bp-mode-switch').evaluate(node =>
                    parseFloat(getComputedStyle(node, '::before').transitionDuration) < 0.001));
            }

            await page.goto(`${preview.url}/contribute/benchmarks/new`);
            const name = page.locator('[data-evaluation-name]');
            await name.fill('New metadata benchmark');
            const description = page.locator('[data-bind="evaluation"][data-field="description"]');
            await description.fill('A public introduction, separate from stored notes.');
            await page.locator('[data-field="requestOfficialSync"]').check();
            await page.locator('[data-field="officialSyncURL"]').fill('https://huggingface.co/datasets/official/scores');
            await page.locator('[data-field="officialSyncInstructions"]').fill('Use the latest published table.');
            assert.equal(await page.locator('#contribution-tree').count(), 0);
            await page.getByRole('button', { name: 'Submit contribution', exact: true }).click();
            await page.locator('#submit-success-dialog:not([hidden])').waitFor();
            const submitted = preview.state.requests.filter(item => item.path === '/api/submit_contribution').at(-1).body;
            assert.equal(submitted.benchmarks[0].description, 'A public introduction, separate from stored notes.');
            assert.equal(submitted.benchmarks[0].requestOfficialSync, true);
            assert.equal(submitted.benchmarks[0].officialSyncInstructions, 'Use the latest published table.');

            await page.goto(`${preview.url}/contribute/benchmarks/101/edit`);
            await description.fill('Changed public introduction');
            const restore = page.getByRole('button', { name: 'Restore Introduction', exact: true });
            await restore.waitFor();
            const inputBox = await description.boundingBox();
            const restoreBox = await restore.boundingBox();
            assert.ok(restoreBox.y + restoreBox.height <= inputBox.y || restoreBox.x >= inputBox.x + inputBox.width,
                'Restore control must not cover the input');
            await restore.click();
            assert.equal(await description.inputValue(), 'A reproducible benchmark of model capabilities.');
            assert.equal(await restore.count(), 0);
            await description.fill('Changed public introduction');
            await page.locator('[data-field="requestOfficialSync"]').check();
            const syncRestore = page.getByRole('button', { name: 'Restore Official-source score sync request', exact: true });
            await syncRestore.click();
            assert.equal(await page.locator('[data-field="requestOfficialSync"]').isChecked(), false);
            await page.waitForTimeout(300);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
            await page.screenshot({ path: `${output}/change-form-${width}.png`, fullPage: true });
            assert.deepEqual(errors, []);
            checks.push({ width, informationRail: true, publicIntroduction: true, syncRequest: true,
                noCategoryTree: true, restoreGeometry: true, browserErrors: errors });
        } finally { await page.close(); await preview.close(); }
    }

    const preview = await startPreview({ authenticated: false });
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    try {
        await page.goto(preview.url);
        const buttons = page.locator('#benchmark-rows .bp-benchmark-information-link');
        await buttons.first().waitFor();
        assert.equal(await page.locator('#benchmark-rows .bp-benchmark-edit').count(), 0);
        await page.route('**/api/get_benchmark_information', async route => {
            const response = await route.fetch();
            const data = await response.json();
            data.description = '<script>window.untrustedIntroduction = true</script>';
            if (data.conditionID === 1) await new Promise(resolve => setTimeout(resolve, 350));
            await route.fulfill({ response, json: data });
        });
        await buttons.nth(0).click();
        await buttons.nth(1).click();
        await page.locator('#benchmark-information-name').filter({ hasText: 'Advanced reasoning' }).waitFor();
        await page.waitForTimeout(450);
        assert.equal(await page.locator('#benchmark-information-name').textContent(), 'Advanced reasoning');
        assert.match(await page.locator('#benchmark-information-description').textContent(), /<script>/);
        assert.equal(await page.evaluate(() => window.untrustedIntroduction), undefined);
        checks.push({ guestInformation: true, staleResponsesIgnored: true, descriptionIsPlainText: true });
    } finally { await page.close(); await preview.close(); }
} finally { await browser.close(); }
await writeFile(`${output}/results.json`, JSON.stringify({ passed: true, checks }, null, 2));
console.log(JSON.stringify({ passed: true, checks }));
