import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';
import { benchmarks, models } from './fixtures.mjs';

const browser = await chromium.launch({ headless: true });
await mkdir('artifacts/frontend', { recursive: true });
const comparisonModels = [0, 1, 2, 3].map(index => ({ ...models[index],
    name: `${index < 2 ? 'Aster Pro' : 'Cedar Sonnet'} / harness=${index % 2 ? 'b' : 'a'}`,
    modelID: index < 2 ? 301 : 302, modelName: index < 2 ? 'Aster Pro' : 'Cedar Sonnet',
    condition: { ID: index + 201, name: `harness=${index % 2 ? 'b' : 'a'}`, parameters: { harness: index % 2 ? 'b' : 'a' } },
    results: new Map(benchmarks.map(item => [String(item.conditionID), { normalizedScore: 50 + index * 10 }])) }));
async function check(width, run) {
    const app = await startPreview({ comparisonModels: comparisonModels.map(model => ({ ...model,
        condition: { ...model.condition, parameters: { ...model.condition.parameters } } })) });
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('benchpoll-welcome-seen-v1', '1'));
    try {
        await run(page, app);
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    } catch (error) {
        await page.screenshot({ path: `artifacts/frontend/model-parameters-failure-${width}.png`, fullPage: true });
        throw error;
    } finally { await context.close(); await app.close(); }
}
try {
    for (const width of [1440, 390]) {
        await check(width, async (page, app) => {
            await page.goto(app.url);
            await page.locator('.bp-model-row').first().waitFor({ state: 'attached' });
            if (width < 768) await page.locator('button[data-mobile-panel="models"]').click();
            await page.locator('.bp-model-row').first().waitFor();
            assert.equal(await page.locator('.bp-model-row').count(), 4);
            await page.getByRole('button', { name: 'Advanced comparison' }).click();
            assert.equal(await page.locator('#model-comparison-keys input:checked').count(), 0);
            await page.locator('#model-comparison-keys input[value="harness"]').check();
            await page.waitForFunction(() => document.querySelectorAll('.bp-model-row').length === 2);
            assert.equal(await page.locator('.bp-model-score').first().textContent(), '80.00');
            await page.locator('.bp-model-row').first().click();
            await page.getByText('2 recorded configurations', { exact: false }).waitFor();
            await page.screenshot({ path: `artifacts/frontend/comparison-evidence-${width}.png`, fullPage: true });
            await page.locator('#model-scores-dialog .dialog-close-button').click();
            await page.locator('#model-comparison-mode').selectOption('matched');
            assert.equal(await page.locator('#model-comparison-keys input:checked').count(), 0);
            await page.getByRole('status').filter({ hasText: 'Select at least one key to compare.' }).waitFor();
            assert.equal(await page.locator('.bp-model-row').count(), 0);
            assert.ok(app.state.requests.filter(item => item.path === '/api/get_weighted_workspace').every(item => item.body.comparison?.mode !== 'matched'));
            await page.locator('#model-comparison-keys input[value="model"]').check();
            await page.waitForFunction(() => document.querySelector('.bp-model-score')?.textContent === '75.00');
            await page.screenshot({ path: `artifacts/frontend/comparison-${width}.png`, fullPage: true });
            await page.locator('#model-comparison-keys input[value="model"]').uncheck();
            await page.waitForFunction(() => document.querySelector('#model-rows')?.textContent === 'Select at least one key to compare.');
            await page.locator('#model-comparison-mode').selectOption('best');
            assert.equal(await page.locator('#model-comparison-keys input[value="harness"]').isChecked(), true);
            assert.equal(await page.locator('#model-comparison-keys input[value="model"]').isChecked(), false);
            await page.waitForFunction(() => document.querySelector('.bp-model-score')?.textContent === '80.00');
            await page.locator('#model-comparison-keys input[value="harness"]').uncheck();
            await page.waitForFunction(() => document.querySelectorAll('.bp-model-row').length === 4);
        });
        console.log(`PASS advanced comparison ${width}`);
        await check(width, async (page, app) => {
            await page.goto(app.url + '/contribute/models/301/edit');
            await page.locator('.model-parameter-editor').waitFor();
            await page.getByRole('button', { name: 'Add parameter', exact: true }).click();
            await page.getByRole('textbox', { name: 'Parameter key', exact: true }).fill('harness');
            await page.getByRole('textbox', { name: 'Parameter value', exact: true }).fill('agent-v2');
            await page.screenshot({ path: `artifacts/frontend/model-parameters-form-${width}.png`, fullPage: true });
            await page.locator('#submit-contribution').click();
            await page.getByText('Change model parameters?', { exact: true }).waitFor();
            await page.getByRole('button', { name: 'Confirm change', exact: true }).click();
            await page.waitForFunction(() => !document.querySelector('#submit-success-dialog').hidden);
            const body = app.state.requests.find(item => item.path === '/api/submit_contribution').body;
            assert.equal(body.proposed.conditions[0].ID, 201);
            assert.deepEqual(body.proposed.conditions[0].parameters, { harness: 'agent-v2' });
            assert.equal(body.proposed.conditions[0].name, 'harness=agent-v2');
        });
        console.log(`PASS model parameter edit ${width}`);
    }
    await check(1440, async (page, app) => {
        await page.goto(app.url + '/contribute?mode=new_model&vendorName=New%20Lab&modelName=New%20Model');
        await page.locator('.model-parameter-editor').waitFor();
        await page.getByRole('button', { name: 'Add parameter', exact: true }).click();
        await page.getByRole('textbox', { name: 'Parameter key', exact: true }).fill('thinking effort');
        await page.getByRole('textbox', { name: 'Parameter value', exact: true }).fill('high');
        await page.locator('#submit-contribution').click();
        await page.waitForFunction(() => !document.querySelector('#submit-success-dialog').hidden);
        const body = app.state.requests.find(item => item.path === '/api/submit_contribution').body;
        assert.deepEqual(body.models[0].conditions[0].parameters, { thinking_effort: 'high' });
        assert.equal(body.models[0].conditions[0].isDefault, false);
    });
    console.log('PASS new model parameter submission');
    await check(1440, async (page, app) => {
        await page.goto(app.url);
        await page.locator('.bp-model-row').first().waitFor();
        await page.locator('#pie-mode-personal').click();
        await page.locator('#model-comparison-toggle').click();
        await page.locator('#weight-pie g[data-object-id="1"]').click();
        await page.locator('#weight-pie').hover();
        app.state.saveFailure = 500;
        await page.mouse.wheel(0, -100);
        await page.locator('#model-comparison-keys input[value="harness"]').check();
        await page.waitForFunction(() => document.querySelectorAll('.bp-model-row').length === 2);
        assert.equal(await page.locator('#model-comparison-keys input[value="harness"]').isChecked(), true);
        await page.getByText('Your change was not saved', { exact: true }).waitFor();
        assert.ok(app.state.requests.some(item => item.path === '/api/get_weighted_workspace' && item.body.comparison?.keys.includes('harness')));
        assert.equal(await page.locator('.bp-model-score').first().textContent(), '80.00');
    });
    console.log('PASS comparison recalculates after weight save failure');
    for (const width of [1440, 390]) {
        await check(width, async (page, app) => {
            await page.goto(app.url);
            await page.locator('.bp-model-row').first().waitFor({ state: 'attached' });
            if (width < 768) await page.locator('button[data-mobile-panel="models"]').click();
            await page.locator('#model-comparison-toggle').click();
            await page.locator('#model-comparison-keys input[value="harness"]').check();
            await page.waitForFunction(() => document.querySelectorAll('.bp-model-row').length === 2);
            for (const model of app.state.comparisonModels) {
                model.condition.parameters = { runner: model.condition.parameters.harness };
            }
            await page.locator('#workspace-refresh').click();
            await page.waitForFunction(() => document.querySelector('#model-rows')?.textContent.includes('no longer available')
                && document.querySelectorAll('.bp-benchmark-row').length > 0);
            assert.equal(await page.locator('.bp-model-row').count(), 0);
            assert.equal(await page.locator('.bp-error-state').count(), 0);
            await page.locator('#model-comparison-keys input[value="runner"]').waitFor();
            assert.equal(await page.locator('#model-comparison-keys input[value="harness"]').isChecked(), true);
            await page.screenshot({ path: `artifacts/frontend/comparison-key-recovery-${width}.png`, fullPage: true });
            await page.locator('#model-comparison-keys input[value="harness"]').click();
            await page.waitForFunction(() => document.querySelectorAll('.bp-model-row').length === 4);
            assert.equal(await page.locator('#model-comparison-keys input[value="harness"]').count(), 0);
        });
        console.log(`PASS unavailable comparison key recovery ${width}`);
    }
    await check(1440, async (page, app) => {
        await page.goto(app.url);
        await page.locator('.bp-model-row').first().waitFor();
        await page.locator('#model-comparison-toggle').click();
        await page.locator('#model-comparison-keys input[value="harness"]').check();
        await page.waitForFunction(() => document.querySelectorAll('.bp-model-row').length === 2);
        await page.locator('#model-comparison-mode').selectOption('matched');
        await page.locator('#model-comparison-keys input[value="model"]').check();
        await page.waitForFunction(() => document.querySelector('.bp-model-score')?.textContent === '75.00');
        for (const model of app.state.comparisonModels) {
            model.condition.parameters = { runner: model.condition.parameters.harness };
        }
        await page.locator('#workspace-refresh').click();
        await page.locator('#model-comparison-keys input[value="runner"]').waitFor();
        await page.locator('#model-comparison-mode').selectOption('best');
        await page.getByRole('status').filter({ hasText: 'no longer available' }).waitFor();
        assert.equal(await page.locator('.bp-model-row').count(), 0);
        await page.locator('#model-comparison-keys input[value="harness"]').click();
        await page.waitForFunction(() => document.querySelectorAll('.bp-model-row').length === 4);
    });
    console.log('PASS inactive comparison draft detects removed keys');
    await check(1440, async (page, app) => {
        await page.goto(app.url);
        await page.locator('.bp-model-row').first().waitFor();
        await page.locator('#pie-mode-personal').click();
        await page.locator('#model-comparison-toggle').click();
        await page.locator('#model-comparison-keys input[value="harness"]').check();
        await page.waitForFunction(() => document.querySelectorAll('.bp-model-row').length === 2);
        const originalEntries = structuredClone(app.state.personalEntries);
        for (const model of app.state.comparisonModels) {
            model.condition.parameters = { runner: model.condition.parameters.harness };
        }
        await page.locator('#weight-pie g[data-object-id="1"]').click();
        await page.locator('#weight-pie').hover();
        await page.mouse.wheel(0, -100);
        await page.getByRole('status').filter({ hasText: 'no longer available' }).waitFor();
        await page.getByText('Your change was not saved', { exact: true }).waitFor();
        assert.deepEqual(app.state.personalEntries, originalEntries);
        assert.equal(await page.locator('.bp-model-row').count(), 0);
        assert.ok(await page.locator('.bp-benchmark-row').count() > 0);
        await page.locator('#model-comparison-keys input[value="harness"]').click();
        await page.waitForFunction(() => document.querySelectorAll('.bp-model-row').length === 4);
    });
    console.log('PASS weight save detects unavailable comparison keys before mutation');
    await check(1440, async (page, app) => {
        await page.goto(app.url);
        await page.locator('.bp-model-row').first().waitFor();
        await page.locator('#model-comparison-toggle').click();
        app.state.workspaceDelay = 200;
        await page.locator('#model-comparison-keys input[value="harness"]').check();
        await page.locator('#model-comparison-mode').selectOption('matched');
        await page.locator('#model-comparison-keys input[value="model"]').check();
        await page.waitForFunction(() => document.querySelector('.bp-model-score')?.textContent === '75.00');
        assert.equal(await page.locator('#model-comparison-mode').inputValue(), 'matched');
        assert.equal(await page.locator('.bp-model-row').count(), 2);
        await page.locator('#model-comparison-keys input[value="model"]').uncheck();
        await page.waitForFunction(() => document.querySelector('#model-rows')?.textContent === 'Select at least one key to compare.');
        assert.equal(await page.locator('.bp-model-row').count(), 0);
    });
    console.log('PASS rapid comparison changes only display the latest selection');
} finally { await browser.close(); }
