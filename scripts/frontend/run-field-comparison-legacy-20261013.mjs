import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { benchmarks, models } from './fixtures.mjs';
import { canonicalNumber } from '../../public/js/shared/score-fields.js';

const builtRoot = process.env.HOME_BUILT_ROOT;
const builtHTML = builtRoot ? await readFile(join(builtRoot, 'home-built.html'), 'utf8') : null;
const output = process.env.LEGACY_COMPARISON_OUTPUT ?? 'D:/Codex-artifacts/website1/showcase-view-20261012/workspace-ui-20261013/legacy-comparison';
await mkdir(output, { recursive: true });
const fields = [
    { ID: 20, name: 'Effort', type: 'enum', allowEmpty: false, excludeMissing: true, options: [{ ID: 3, label: 'high' }, { ID: 4, label: 'low' }],
        legacyFields: [{ ID: 9, name: 'Image quality preset', type: 'text' }] },
    { ID: 1, name: 'Harness', type: 'enum', allowEmpty: false, excludeMissing: true, options: [{ ID: 100, label: 'Claude Code' }, { ID: 101, label: 'Codex' }] },
    { ID: 33, name: 'Temperature', type: 'number', allowEmpty: false, options: [] }
];
const legacy = { mode: 'best', keys: ['model', 'field:9'], filters: [
    { key: 'field:9', operator: 'eq', value: 'high' }, { key: 'field:1', operator: 'eq', value: 'Claude Code' }] };
const harnessOnly = { mode: 'best', keys: ['model', 'field:1'], filters: [{ key: 'field:1', operator: 'eq', value: 'Claude Code' }] };
const comparisonModels = Array.from({ length: 8 }, (_, index) => {
    const model = models[index < 4 ? 0 : 1], effort = index % 2 ? 4 : 3, harness = index % 4 < 2 ? 100 : 101;
    return { ...model, ID: 201 + index, modelName: model.name, vendor: index < 4 ? 'OpenAI' : 'Anthropic',
        condition: { parameters: { 'field:1': harness, 'field:20': effort }, scoreFields: [{ fieldID: 1, value: harness }, { fieldID: 20, value: effort }] },
        results: new Map(benchmarks.map(item => [String(item.conditionID), { normalizedScore: 50 + index * 4 }])) };
});
const reports = [];
for (const [engine, launcher, width] of [['chromium', chromium, 1440], ['chromium', chromium, 320], ['webkit', webkit, 390]]) {
    const app = await startPreview({ comparisonFields: fields, comparisonModels, comparisonLast: legacy,
        comparisonProfiles: [{ name: 'Legacy run', comparison: legacy }, { name: 'Only Harness', comparison: harnessOnly }] });
    const browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760 });
    await context.addInitScript(() => localStorage.setItem('benchpoll-comparison-settings-v1:1', JSON.stringify({ experimental: true, basic: { keys: ['model'] } })));
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
        if (builtRoot || engine === 'webkit') await page.route(`${app.url}/**`, async route => {
            const path = new URL(route.request().url()).pathname;
            if (builtHTML && route.request().resourceType() === 'document') return route.fulfill({ body: builtHTML, contentType: 'text/html' });
            if (builtRoot && path.startsWith('/build/home/')) return route.fulfill({ body: await readFile(join(builtRoot, path.slice(1))),
                contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript' });
            const response = await route.fetch(); await route.fulfill({ response, body: await response.body() });
        });
        await page.goto(app.url);
        await page.waitForFunction(() => document.getElementById('model-ranking-status')?.dataset.phase === 'ready');
        await page.locator('#showcase-enter').click(); await page.waitForFunction(() => !document.body.classList.contains('is-showcase'));
        if (width < 760) await page.locator('button[data-mobile-panel="models"]').click();
        await page.locator('#model-comparison-toggle').click();
        assert.equal(await page.locator('#model-comparison-keys input[value="field:20"]').isChecked(), true);
        assert.equal(await page.locator('#model-comparison-keys input[value="field:9"]').count(), 0);
        assert.match(await page.getByRole('combobox', { name: 'Effort value', exact: true }).textContent(), /high/);
        assert.match(await page.getByRole('combobox', { name: 'Harness value', exact: true }).textContent(), /Claude Code/);
        const openSaved = async () => { await page.getByRole('button', { name: 'Saved configurations', exact: true }).click(); await page.locator('.bp-profile-popover').waitFor(); };
        await openSaved();
        assert.equal(await page.getByRole('button', { name: 'Legacy run', exact: true }).getAttribute('aria-pressed'), 'true');
        assert.equal(await page.getByRole('button', { name: 'Saved as Legacy run', exact: true }).isDisabled(), true);
        await page.getByRole('button', { name: 'Only Harness', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('#model-ranking-status').dataset.phase === 'ready');
        assert.equal(app.state.requests.filter(request => request.path === '/api/get_weighted_workspace').at(-1).body.comparison.filters[0].value, 100);
        await openSaved(); await page.getByRole('button', { name: 'Legacy run', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('#model-ranking-status').dataset.phase === 'ready');
        const comparison = app.state.requests.filter(request => request.path === '/api/get_weighted_workspace').at(-1).body.comparison;
        assert.deepEqual(comparison.keys, ['model', 'field:20']);
        assert.deepEqual(comparison.filters, [{ key: 'field:20', operator: 'eq', value: 3 }, { key: 'field:1', operator: 'eq', value: 100 }]);
        for (const [label, value] of [['low', 4], ['high', 3]]) {
            const effort = page.getByRole('combobox', { name: 'Effort value', exact: true });
            await effort.click();
            await page.locator('#' + await effort.getAttribute('aria-controls')).getByRole('option', { name: label, exact: true }).click();
            await page.waitForTimeout(450);
            assert.equal(app.state.requests.filter(request => request.path === '/api/get_weighted_workspace').at(-1).body.comparison.filters[0].value, value);
        }
        await page.getByRole('searchbox', { name: 'Search fields to limit' }).fill('Temperature');
        await page.getByRole('button', { name: 'Add Temperature filter', exact: true }).last().click();
        const temperature = page.getByRole('textbox', { name: 'Temperature value', exact: true });
        await temperature.fill('invalid'); await page.waitForTimeout(400);
        await page.locator('#workspace-refresh').click();
        await page.waitForFunction(() => document.querySelector('#model-ranking-status').dataset.phase === 'ready');
        assert.equal(await temperature.inputValue(), 'invalid', 'A metadata refresh keeps an incomplete edit');
        await temperature.fill('0.5'); await page.waitForTimeout(600);
        assert.equal(app.state.requests.filter(request => request.path === '/api/get_weighted_workspace').at(-1).body.comparison.filters.at(-1).value, canonicalNumber('0.5'));
        assert.deepEqual(errors, []);
        await page.screenshot({ path: join(output, `${engine}-${width}.png`), fullPage: true });
        reports.push({ engine, width, restored: true, namedReuse: true, duplicateDetected: true, partialDraftRetained: true, errors });
        console.log(JSON.stringify({ engine, width, passed: true }));
    } catch (error) {
        await page.screenshot({ path: join(output, `${engine}-${width}-failure.png`), fullPage: true });
        throw error;
    } finally { await page.unrouteAll({ behavior: 'ignoreErrors' }); await context.close(); await browser.close(); await app.close(); }
}
await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
