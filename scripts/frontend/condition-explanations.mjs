import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';
import { catalog } from './fixtures.mjs';

const output = 'artifacts/condition-explanations-20261005/ui';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];
try {
    for (const width of [1440, 390, 320]) {
        const preview = await startPreview({ secondaryBenchmark: true });
        const page = await browser.newPage({ viewport: { width, height: 950 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.setDefaultTimeout(12000);
        try {
            await page.goto(`${preview.url}/contribute/benchmarks/new`);
            await page.locator('[data-evaluation-name]').fill('Condition explanation fixture');
            const name = page.locator('[data-condition-input]').first();
            const explanation = page.locator('[data-field="differenceExplanation"]').first();
            assert.equal(await name.getAttribute('maxlength'), '60');
            await explanation.fill('Full held-out dataset. The other condition uses a development subset.');
            assert.equal(await explanation.getAttribute('maxlength'), '10000');
            await name.evaluate(input => {
                input.value = 'x'.repeat(61);
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });
            assert.equal(await name.getAttribute('aria-invalid'), 'true');
            assert.equal(await name.evaluate(input => input.checkValidity()), false);
            assert.match(await page.locator('.field-validation-error').textContent(), /60 characters/);
            await name.fill('default');
            assert.equal(await name.getAttribute('aria-invalid'), null);
            assert.equal(await page.locator('.field-validation-error').count(), 0);
            await page.screenshot({ path: `${output}/create-${width}.png`, fullPage: true });
            const sent = page.waitForRequest(request => request.url().endsWith('/api/submit_contribution'));
            await page.locator('#submit-contribution').click();
            const body = (await sent).postDataJSON();
            assert.equal(body.benchmarks[0].conditions[0].differenceExplanation, await explanation.inputValue());

            const longName = 'Imported condition name '.repeat(5).trim();
            const publishedExplanation = 'Published condition: the full held-out split.';
            await page.route('**/api/get_contribution_target', async route => {
                const form = catalog().benchmarks[0];
                form.notes = 'Saved object note';
                form.conditions[0].name = longName;
                form.conditions[0].isDefault = false;
                form.conditions[0].differenceExplanation = publishedExplanation;
                return route.fulfill({ json: { targetKind: 'benchmark', targetID: 101, form } });
            });
            await page.goto(`${preview.url}/contribute/benchmarks/101/edit`);
            const editName = page.locator('[data-condition-input]').first();
            const editExplanation = page.locator('[data-field="differenceExplanation"]').first();
            assert.equal(await editName.inputValue(), longName);
            assert.equal(await editName.getAttribute('maxlength'), String(longName.length));
            assert.equal(await editExplanation.inputValue(), publishedExplanation);
            await editExplanation.fill('A different, independently scored held-out split.');
            const restore = page.locator('[data-restore-path$=".differenceExplanation"]');
            await restore.waitFor();
            const control = await editExplanation.boundingBox();
            const button = await restore.boundingBox();
            assert.ok(button.x >= control.x && button.x + button.width <= control.x + control.width + 1);
            await restore.click();
            assert.equal(await editExplanation.inputValue(), publishedExplanation);
            await editName.fill('y'.repeat(61));
            await editExplanation.click();
            assert.equal(await editName.getAttribute('aria-invalid'), 'true');
            assert.equal(await page.locator('global-dialog[open]').count(), 0, 'Length validation must not open a modal');
            await page.locator('[data-restore-path$=".name"]').click();
            assert.equal(await editName.inputValue(), longName);
            await editExplanation.fill('Corrected explanation without changing the historical name.');
            assert.equal(await page.locator('#contribution-form').evaluate(form => form.checkValidity()), true);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
            await page.screenshot({ path: `${output}/change-${width}.png`, fullPage: true });
            const changed = page.waitForRequest(request => request.url().endsWith('/api/submit_contribution'));
            await page.locator('#submit-contribution').click();
            const editBody = (await changed).postDataJSON();
            assert.equal(editBody.proposed.conditions[0].name, longName);
            assert.equal(editBody.proposed.conditions[0].differenceExplanation, await editExplanation.inputValue());
            await page.goto(preview.url);
            await page.locator('#benchmark-rows .bp-benchmark-information-link').first().click();
            await page.locator('#benchmark-information-differences:not([hidden])').waitFor();
            assert.equal(await page.locator('#benchmark-information-difference-explanation').textContent(), catalog().benchmarks[0].conditions[0].differenceExplanation);
            assert.deepEqual(errors, []);
            checks.push({ width, create: true, explanationOnlyChange: true, longNamePreserved: true,
                restores: true, inlineErrors: true, publicInformation: true, browserErrors: errors });
        } finally { await page.close(); await preview.close(); }
    }
} finally { await browser.close(); }
await writeFile(`${output}/checks.json`, JSON.stringify({ passed: true, checks }, null, 2));
console.log(JSON.stringify({ passed: true, checks }));
