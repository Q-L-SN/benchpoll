import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';
import { catalog } from './fixtures.mjs';

const output = 'artifacts/ui-routing-20261001';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const settle = locator => locator.evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
});
try {
    for (const width of [1440, 390, 320]) {
        const app = await startPreview();
        const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width < 760, isMobile: width < 760 });
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        try {
            await page.goto(app.url);
            await page.locator('.bp-benchmark-row').first().waitFor();
            const picker = page.locator('.bp-template-picker').first();
            await picker.locator('.bp-template-control').click();
            const selected = picker.locator('[aria-selected="true"]');
            const other = picker.locator('[aria-selected="false"]').first();
            await other.waitFor({ state: 'visible' });
            if (width > 760) await other.hover();
            if (width < 760) await picker.locator('.bp-template-menu').evaluate(async element => {
                await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
            });
            const style = element => getComputedStyle(element).backgroundColor;
            assert.notEqual(await selected.evaluate(style), await other.evaluate(style));
            const selectedBounds = await selected.boundingBox(), otherBounds = await other.boundingBox();
            assert.equal(await other.evaluate(element => {
                const rect = element.getBoundingClientRect();
                return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
            }), true, 'Another mobile control covers the context menu');
            assert.ok(otherBounds.y - selectedBounds.y - selectedBounds.height >= 2, 'Menu rows overlap');
            assert.equal(await picker.locator('input').count(), 0);
            const menuBounds = await picker.locator('.bp-template-menu').boundingBox();
            assert.ok(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= width + 1);
            await page.screenshot({ path: `${output}/template-${width}.png`, fullPage: true });
            if (width > 760) {
                await other.focus();
                await page.keyboard.press('Escape');
                assert.equal(await picker.getAttribute('data-open'), null);
                await page.waitForFunction(() => getComputedStyle(document.querySelector('.bp-template-menu')).visibility === 'hidden');
            }

            for (const endpoint of ['get_weighted_workspace', 'get_discussion']) {
                await page.route(`**/api/${endpoint}`, async route => {
                    const response = await route.fetch(), data = await response.json();
                    Object.assign(data.context, { dimensions: [], contextValues: {}, contextDisplayValues: {} });
                    await route.fulfill({ response, json: data });
                });
            }
            await page.goto(app.url);
            await page.locator('.bp-benchmark-row').first().waitFor();
            assert.equal(await page.locator('.bp-template-picker').count(), 0);
            await page.locator('#discussion-entry').click();
            await page.locator('#discussion-panel[aria-hidden="false"]').waitFor();
            await page.locator('.discussion-post').first().waitFor();
            assert.equal(await page.locator('#context-filter-label').isVisible(), false);
            await page.locator('#discussion-compose-toggle').click();
            assert.equal(await page.locator('#posting-context').isVisible(), false);
            await settle(page.locator('#discussion-compose-fields'));
            await page.screenshot({ path: `${output}/no-context-discussion-${width}.png`, fullPage: true });

            const formCatalog = catalog();
            const benchmark = formCatalog.benchmarks[0];
            benchmark.conditions = [
                { ...benchmark.conditions[0], scoreCount: 100, lowCoverage: false },
                { ...benchmark.conditions[0], ID: 91, name: 'Extended', scoreCount: 21, lowCoverage: false },
                { ...benchmark.conditions[0], ID: 92, name: 'Rare', scoreCount: 20, lowCoverage: true }
            ];
            await page.route('**/api/get_contribution_catalog', route => route.fulfill({ json: formCatalog }));
            await page.goto(app.url + '/contribute/scores/new');
            const input = page.locator('[data-result-object-query]').first();
            await input.fill(benchmark.name);
            await page.locator('[role="listbox"][aria-label="Existing benchmarks"]').waitFor();
            await page.waitForFunction(() => !document.querySelector('[data-result-object-query]')?.hasAttribute('aria-busy'));
            const suggestion = page.locator('[role="listbox"][aria-label="Existing benchmarks"]');
            assert.equal(await suggestion.locator('.condition-score-count').allTextContents().then(counts => counts.join(',')), '100 scores,21 scores,20 scores');
            const fold = suggestion.locator('.condition-suggestion-fold');
            assert.equal(await fold.getAttribute('open'), null);
            assert.equal(await suggestion.locator('[data-condition-id="92"]').isVisible(), false);
            await fold.locator('summary').click();
            await settle(fold);
            await suggestion.locator('[data-condition-id="92"]').click();
            const conditionPicker = page.locator('[data-catalog-picker="benchmark-condition"]');
            assert.equal(await conditionPicker.locator('.picker-summary span').textContent(), 'Rare');
            await conditionPicker.locator('summary.picker-summary').click();
            await page.waitForFunction(() => !document.querySelector('[data-catalog-picker="benchmark-condition"]')?.hasAttribute('aria-busy'));
            assert.equal(await conditionPicker.locator('.condition-suggestion-fold').getAttribute('open'), null);
            assert.equal(await conditionPicker.locator('.condition-score-count').count(), 3);
            await page.screenshot({ path: `${output}/score-conditions-${width}.png`, fullPage: true });
            await page.goto(app.url + '/contribute/benchmarks/new');
            await page.locator('[data-evaluation-name]').fill(benchmark.name);
            await page.locator('.condition-suggestion-fold summary').waitFor();
            assert.equal(await page.locator('.condition-suggestion-fold').getAttribute('open'), null);
            assert.equal(await page.locator('.evaluation-suggestions .condition-score-count').count(), 3);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            assert.deepEqual(errors, []);
            console.log(`PASS ${width}px menu contrast/gaps, no-context discussion, score counts, collapsed suggestions, and condition identity`);
        } catch (error) {
            await page.screenshot({ path: `${output}/failure-${width}.png`, fullPage: true });
            console.error(page.url(), errors);
            throw error;
        } finally { await context.close(); await app.close(); }
    }
    const app = await startPreview();
    const page = await browser.newPage();
    try {
        await page.goto(app.url);
        assert.deepEqual(await page.evaluate(async () => {
            const { setVisible, mountDisclosureMotion } = await import('/js/shared/motion.js');
            const box = document.createElement('div'); box.style.height = '100px'; document.body.append(box);
            setVisible(box, false, { collapse: true }); setVisible(box, true, { collapse: true });
            await setVisible(box, false, { collapse: true });
            const hidden = box.hidden;
            await setVisible(box, true, { collapse: true });
            const height = box.getBoundingClientRect().height;
            const disclosure = document.createElement('details');
            disclosure.innerHTML = '<summary>More</summary><div style="height:100px">Options</div>';
            box.append(disclosure); mountDisclosureMotion(box, 'details');
            const summary = disclosure.querySelector('summary'); summary.click(); summary.click(); summary.click();
            await Promise.all(disclosure.getAnimations().map(animation => animation.finished.catch(() => {})));
            const open = disclosure.open; summary.click();
            await Promise.all(disclosure.getAnimations().map(animation => animation.finished.catch(() => {})));
            const closed = !disclosure.open; box.remove();
            return { hidden, height, open, closed };
        }), { hidden: true, height: 100, open: true, closed: true });
        console.log('PASS interrupted show/hide and disclosure animations settle to the latest state');
        await page.goto(app.url + '/how-it-works');
        const rules = page.locator('.bp-how-rule-answers');
        await page.getByRole('button', { name: 'Expand all', exact: true }).click();
        await settle(rules);
        assert.equal(await rules.locator('details').evaluateAll(rows => rows.every(row => row.open)), true);
        await page.getByRole('button', { name: 'Collapse all', exact: true }).click();
        await settle(rules);
        assert.equal(await rules.locator('details[open]').count(), 0);
        const coverage = rules.locator('details').filter({ hasText: 'Why are some benchmark conditions collapsed?' });
        await coverage.locator('summary').click(); await settle(coverage);
        assert.match(await coverage.textContent(), /20%/);
        await coverage.locator('summary').click(); await settle(coverage);
        assert.equal(await coverage.getAttribute('open'), null);
        console.log('PASS animated FAQ expand/collapse and detailed coverage rules');
    } finally { await page.close(); await app.close(); }
} finally { await browser.close(); }
