import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';
import { comparisonOptions } from '../../model-comparison.js';
import { assertRankingEvidence } from '../../score-evidence.js';

const output = 'artifacts/review-fixes-20261004/ui';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
async function enableAdvancedComparison(page, width = 1440) {
    await page.locator('#benchmark-card[aria-busy="false"]').waitFor({ state: 'attached' });
    if (width < 768) await page.locator('#taxonomy-toggle').click();
    await page.locator('#user-profile').click();
    await page.locator('#experimental-comparison:not([disabled])').setChecked(true);
    await page.locator('#user-account-dialog .dialog-close-button').click();
    if (width < 768) await page.locator('#taxonomy-close').click();
    await page.waitForFunction(() => {
        const toggle = document.getElementById('model-comparison-toggle');
        return toggle && !toggle.hidden && !toggle.disabled;
    });
    await page.locator('#benchmark-card[aria-busy="false"]').waitFor({ state: 'attached' });
}
try {
    const preview = await startPreview();
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    try {
        await page.goto(preview.url);
        await enableAdvancedComparison(page);
        await page.locator('#model-comparison-toggle:not([disabled])').click();
        const rows = page.locator('.bp-value-filter');
        const add = page.getByRole('button', { name: 'Add Token budget filter', exact: true });
        for (const bound of ['gt', 'lt']) {
            await add.click();
            await rows.first().locator('select').selectOption(bound);
            await rows.first().locator('input').fill(bound === 'gt' ? '100' : '200');
            await rows.first().locator('input').blur();
            await add.click();
            assert.equal(await rows.count(), 2);
            assert.deepEqual(await rows.first().locator('select option').evaluateAll(options => options.map(option => option.value)), [bound]);
            await rows.last().locator('input').fill(bound === 'gt' ? '200' : '100');
            await rows.last().locator('input').blur();
            const draft = bound === 'gt' ? '100' : '200';
            await rows.last().getByRole('button', { name: 'Remove Token budget filter' }).click();
            await page.waitForFunction(() => document.querySelectorAll('.bp-value-filter').length === 1);
            assert.deepEqual(await rows.first().locator('select option').evaluateAll(options => options.map(option => option.value)), ['eq', 'gt', 'lt', 'present', 'absent']);
            assert.equal(await rows.first().locator('input').inputValue(), draft);
            await rows.first().locator('select').selectOption('eq');
            await rows.first().locator('input').fill('150');
            await rows.first().locator('input').blur();
            await page.waitForFunction(() => document.querySelector('.bp-filter-value-input')?.getAttribute('aria-invalid') !== 'true');
            await rows.first().getByRole('button', { name: 'Remove Token budget filter' }).click();
            await page.waitForFunction(() => document.querySelectorAll('.bp-value-filter').length === 0);
        }
        console.log('PASS numeric-bound removal unlocks operators without replacing the remaining input');

        await page.locator('#model-comparison-toggle').click();
        await page.route('**/api/get_approved_benchmark_results', async route => {
            const body = route.request().postDataJSON();
            assert.equal(body.expectedEvidence.conditionID, 1);
            assert.match(body.expectedEvidence.hash, /^[a-f0-9]{64}$/);
            try { assertRankingEvidence(body.expectedEvidence, [{ benchmarkConditionID: 1, evidenceHash: '0'.repeat(64) }]); }
            catch (error) { await route.fulfill({ status: error.status, json: error.body }); }
        });
        await page.locator('.bp-model-row').first().click();
        await page.locator('#model-scores-list .bp-model-configuration-link').first().click();
        await page.getByText('Scores have changed since this ranking was calculated.', { exact: true }).waitFor();
        assert.equal(await page.locator('.bp-model-score-sample').count(), 0);
        const refresh = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace'));
        await page.getByRole('button', { name: 'Refresh ranking', exact: true }).click();
        await refresh;
        console.log('PASS stale ranking evidence is rejected with a working refresh action');
        assert.deepEqual(errors, []);
    } finally { await page.close(); await preview.close(); }

    for (const width of [1440, 390]) {
        const stale = { mode: 'best', keys: ['model'], filters: [{ key: 'field:1', operator: 'eq', value: 11 }] };
        const app = await startPreview({ comparisonLast: stale });
        const page = await browser.newPage({ viewport: { width, height: 950 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        try {
            await page.route('**/api/get_weighted_workspace', async route => {
                const body = route.request().postDataJSON();
                const fields = [{ ID: 1, name: 'Harness', type: 'enum', allowEmpty: true, excludeMissing: true,
                    options: [{ ID: 12, label: 'Agent B' }] }];
                try { comparisonOptions([], body.comparison, fields); }
                catch (error) { await route.fulfill({ status: error.status, json: error.body }); return; }
                const response = await route.fetch();
                const data = await response.json();
                data.comparison.fields.find(field => field.ID === 1).options = fields[0].options;
                await route.fulfill({ response, json: data });
            });
            await page.goto(app.url);
            await enableAdvancedComparison(page, width);
            if (width < 761) await page.getByRole('button', { name: 'Model ranking', exact: true }).click();
            await page.locator('#model-comparison-toggle:not([disabled])').waitFor();
            await page.getByText('A saved comparison uses fields or values that are no longer available. It was reset to Model only.', { exact: true }).waitFor();
            assert.equal(await page.locator('.bp-error-state').count(), 0);
            assert.deepEqual(app.state.comparisonLast, { mode: 'best', keys: ['model'], filters: [] });
            await page.locator('#model-comparison-toggle').click();
            assert.equal(await page.locator('#model-comparison-keys input[value="model"]').isChecked(), true);
            assert.equal(await page.locator('.bp-value-filter').count(), 0);
            await page.screenshot({ path: `${output}/recovered-filters-${width}.png`, fullPage: true });
            assert.deepEqual(errors, []);
            console.log(`PASS ${width}px deleted saved option recovers with a visible explanation and editable controls`);
        } finally { await page.close(); await app.close(); }
    }

    const previewAdmin = await startPreview();
    previewAdmin.state.syncConflicts = [1, 2].map(ID => ({ row_key: String(ID).repeat(64), result_ID: ID,
        incoming_hash: 'a'.repeat(64), incoming_row: { rating: 1300, model_name: 'Model', leaderboard_publish_date: '2026-10-04' },
        status: 'pending', currentScore: 1200, currentStatus: 'accepted', currentFields: [], currentNotes: 'Reviewed correction',
        modelName: '<img src=x onerror=alert(1)>', benchmarkName: 'Text Arena', conditionName: 'default', manualOverride: 'edit' }));
    const admin = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    const adminErrors = [];
    admin.on('pageerror', error => adminErrors.push(error.message));
    try {
        await admin.goto(previewAdmin.url + '/censor');
        await admin.getByRole('tab', { name: 'Source Conflicts' }).click();
        await admin.locator('#sync-list .log-item').nth(1).waitFor();
        assert.equal(await admin.locator('#sync-list img').count(), 0);
        await admin.locator('#sync-list .log-item').first().getByRole('button', { name: 'Keep manual correction' }).click();
        await admin.waitForFunction(() => document.querySelectorAll('#sync-list .log-item').length === 1);
        await admin.getByRole('button', { name: 'Accept official update' }).click();
        await admin.getByText('Official update approved, waiting for the next sync.', { exact: true }).waitFor();
        assert.equal(previewAdmin.state.requests.filter(item => item.path === '/api/resolve_score_sync_conflict').length, 2);
        await admin.screenshot({ path: `${output}/source-review-desktop.png`, fullPage: true });
        await admin.setViewportSize({ width: 390, height: 844 });
        await admin.waitForFunction(() => {
            const tab = document.querySelector('[data-workspace-view="sync"]')?.getBoundingClientRect();
            return tab && tab.left >= 0 && tab.right <= innerWidth;
        });
        assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await admin.screenshot({ path: `${output}/source-review-mobile.png`, fullPage: true });
        assert.deepEqual(adminErrors, []);
        console.log('PASS source conflict review actions, escaping, and desktop/mobile layout');
    } finally { await admin.close(); await previewAdmin.close(); }
} finally { await browser.close(); }
