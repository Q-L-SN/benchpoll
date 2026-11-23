import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
import { AA_DISPLAY_RESTRICTION } from '../public/js/shared/aa-ranking-policy.js';

for (const [engine, width] of [[chromium, 1440], [webkit, 320]]) {
    test(`${engine.name()} ${width}px All scores version options show inline score counts`, async t => {
        const app = await startPreview({ secondaryBenchmark: true, communityVersions: true });
        const browser = await engine.launch();
        t.after(async () => { await browser.close(); await app.close(); });
        const page = await browser.newPage({ viewport: { width, height: 820 }, hasTouch: width < 500, isMobile: width < 500 });
        page.setDefaultTimeout(10000);
        if (process.env.BP_TEST_BUILT === '1') await page.route(app.url + '/1', async route => route.fulfill({
            contentType: 'text/html', body: await readFile(new URL('../private/home-built.html', import.meta.url), 'utf8')
        }));
        await page.route('**/api/get_benchmark_scores', async route => {
            const { conditionID, benchmarkID } = route.request().postDataJSON();
            const conditions = [
                { ID: 1, name: 'Default evaluation (English)', scoreCount: 48 },
                { ID: 901, name: 'Extended evaluation with a long version name', scoreCount: 0 },
                { ID: 933, name: 'Restricted version', scoreCount: null, displayRestriction: AA_DISPLAY_RESTRICTION }
            ].map(condition => ({ usesPercentageScale: true, ...condition }));
            const recorded = conditionID === 1 ? [{ ID: 1, modelName: 'Model A', vendorName: 'Company A', rawScore: 75, fields: [] }] : [];
            await route.fulfill({ json: { benchmarkID, conditionID, conditions, scores: recorded, nextBeforeID: null,
                displayRestriction: conditions.find(condition => condition.ID === conditionID).displayRestriction ?? null } });
        });
        await page.goto(app.url + '/1');
        await page.locator('#benchmark-rows [data-condition-id="1"] .bp-benchmark-information-link').click();
        await page.getByRole('tab', { name: 'All scores' }).click();
        const trigger = page.locator('.benchmark-scores-condition [role="combobox"]');
        await trigger.getByRole('img', { name: '48 approved scores.' }).waitFor();
        assert.deepEqual(await page.locator('#benchmark-scores-condition option').allTextContents(), [
            'Default evaluation (English)', 'Extended evaluation with a long version name', 'Restricted version'
        ]);
        await trigger.click();
        const menu = page.locator(`[id="${await trigger.getAttribute('aria-controls')}"]`);
        const options = menu.getByRole('option');
        assert.equal(await options.count(), 3);
        assert.equal(await options.nth(2).locator('.bp-evidence-count').count(), 0);
        const counts = await menu.locator('.bp-evidence-count').evaluateAll(badges => badges.map(badge => {
            const glyph = badge.querySelector('.fa-chart-simple').getBoundingClientRect();
            const number = badge.querySelector('.bp-evidence-count-value');
            const value = number.getBoundingClientRect();
            return { value: number.textContent, inline: value.left >= glyph.right - 1 &&
                Math.abs((value.top + value.bottom - glyph.top - glyph.bottom) / 2) <= 1.5 };
        }));
        assert.deepEqual(counts, [{ value: '48', inline: true }, { value: '0', inline: true }]);
        assert.ok(await menu.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
        const zero = options.nth(1).getByRole('img', { name: '0 approved scores.' });
        if (width < 500) await zero.tap();
        else await zero.click();
        await page.getByText('No approved scores for this benchmark version yet.').waitFor();
        await trigger.getByRole('img', { name: '0 approved scores.' }).waitFor();
        await trigger.press('Enter');
        await trigger.press('Home');
        await trigger.press('Enter');
        await trigger.getByRole('img', { name: '48 approved scores.' }).waitFor();
        await page.locator('#benchmark-scores-list .benchmark-score-row').waitFor();
    });
}
