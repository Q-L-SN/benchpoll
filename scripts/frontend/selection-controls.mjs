import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';

const output = new URL('../../artifacts/selection-controls-20261003/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];

async function controlStyle(locator) {
    return locator.evaluate(async node => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const style = getComputedStyle(node);
        return { outline: style.outlineStyle, width: Number.parseFloat(style.outlineWidth),
            offset: Number.parseFloat(style.outlineOffset), shadow: style.boxShadow,
            border: style.borderColor, background: style.backgroundColor,
            keyboard: node.matches(':focus-visible') };
    });
}

async function noOuterRing(locator, label) {
    const style = await controlStyle(locator);
    assert.ok(style.outline === 'none' || style.width + style.offset <= 0,
        `${label}: outline extends outside the control: ${JSON.stringify(style)}`);
    assert.ok(style.shadow === 'none' || style.shadow.split(/,(?![^()]*\))/).every(shadow => {
        if (shadow.includes('inset')) return true;
        const lengths = [...shadow.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map(match => Number(match[1]));
        return lengths[0] !== 0 || lengths[1] !== 0 || lengths[2] <= 0 && lengths[3] <= 0;
    }),
        `${label}: outer focus shadow: ${style.shadow}`);
    return style;
}

async function keyboardCue(page, locator, label, key = 'Tab') {
    await locator.waitFor({ state: 'visible' });
    await page.keyboard.press(key);
    await locator.focus();
    const style = await noOuterRing(locator, label);
    assert.equal(style.keyboard, true, `${label}: keyboard focus not active`);
    assert.ok(style.width >= 2, `${label}: missing internal keyboard-focus cue`);
}

async function pointerCue(page, locator, label) {
    await page.evaluate(() => document.activeElement?.blur());
    await locator.click();
    await noOuterRing(locator, label);
}

try {
    for (const width of [1440, 390, 320]) {
        const preview = await startPreview();
        const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: 'reduce' });
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        try {
            await page.goto(preview.url);
            const template = page.locator('.bp-template-control').first();
            await template.waitFor();
            await pointerCue(page, template, 'Homepage context picker');
            const selected = page.locator('.bp-template-choice[data-selected="true"]');
            const other = page.locator('.bp-template-choice[data-selected="false"]').first();
            assert.notEqual((await controlStyle(selected)).background, (await controlStyle(other)).background);
            await keyboardCue(page, other, 'Homepage context option');
            await page.screenshot({ path: fileURLToPath(new URL(`context-${width}.png`, output)), fullPage: true });
            await page.keyboard.press('Escape');
            await keyboardCue(page, template, 'Homepage context picker keyboard');
            if (width < 761) await page.locator('[data-mobile-panel="models"]').click();
            await page.locator('#model-comparison-toggle:not([disabled])').click();
            await page.getByRole('button', { name: 'Add Thinking filter', exact: true }).click();
            const filter = page.getByRole('combobox', { name: 'Thinking filter', exact: true });
            await keyboardCue(page, filter, 'Advanced filter');
            await filter.selectOption('absent');
            await keyboardCue(page, filter, 'Advanced filter selected');
            await keyboardCue(page, page.getByRole('button', { name: 'Best performance', exact: true }), 'Comparison mode');
            await keyboardCue(page, page.getByRole('searchbox', { name: 'Search fields to limit' }), 'Advanced filter key search');
            await page.locator('.bp-filter-suggestions').getByRole('button', { name: 'Add Model filter', exact: true }).click();
            await keyboardCue(page, page.getByLabel('Model value', { exact: true }), 'Advanced model-value suggestions');
            await page.screenshot({ path: fileURLToPath(new URL(`filters-${width}.png`, output)), fullPage: true });
            await page.locator('#discussion-entry').click();
            await page.locator('#discussion-feed[aria-busy="false"]').waitFor();
            await keyboardCue(page, page.locator('#discussion-context'), 'Discussion context');

            await page.goto(`${preview.url}/contribute?mode=new_benchmark`);
            await page.locator('[data-evaluation-name]').waitFor();
            await pointerCue(page, page.locator('[data-evaluation-name]'), 'Benchmark name combobox');
            const rule = page.getByRole('combobox', { name: 'Score ranking rule', exact: true });
            await keyboardCue(page, rule, 'Contribution score ranking rule');
            await rule.selectOption('lower');
            await keyboardCue(page, rule, 'Contribution score ranking rule selected');
            assert.equal(await rule.inputValue(), 'lower');
            const tags = page.locator('[data-tag-input]').first();
            const tagRefresh = page.waitForResponse(response => response.url().endsWith('/api/get_contribution_catalog'));
            await tags.fill('Reason');
            await (await tagRefresh).finished();
            await controlStyle(tags);
            await keyboardCue(page, page.getByRole('option', { name: 'Reasoning Tab' }), 'Tag suggestion', 'ArrowLeft');
            await page.getByRole('option', { name: 'Reasoning Tab' }).click();
            await tags.focus();
            await noOuterRing(page.locator('.tag-editor'), 'Tag editor');
            await page.screenshot({ path: fileURLToPath(new URL(`benchmark-form-${width}.png`, output)), fullPage: true });

            await page.goto(`${preview.url}/contribute?mode=new_model`);
            const vendor = page.locator('.vendor-picker > summary');
            await pointerCue(page, vendor, 'Open vendor picker');
            await noOuterRing(vendor, 'Vendor picker while its search has focus');
            const vendorSearch = page.locator('.vendor-picker .picker-search input');
            await keyboardCue(page, vendorSearch, 'Vendor search');
            const vendorOption = page.locator('.vendor-picker .picker-option:not(.create-option)').first();
            await keyboardCue(page, vendorOption, 'Vendor option', 'ArrowLeft');
            await vendorOption.click();
            assert.equal(await page.locator('.vendor-picker').getAttribute('open'), null);
            assert.equal(await page.locator('[data-subject-model-name]').isVisible(), true);

            await page.goto(`${preview.url}/contribute/scores/new`);
            const model = page.locator('[data-result-model-query]').first();
            await model.fill('Aster Pro');
            await model.press('Tab');
            assert.equal(await page.locator('.has-model-selection').count(), 1);
            await keyboardCue(page, model, 'Selected model combobox');
            const benchmark = page.locator('[data-result-object-query]').first();
            await benchmark.fill('General knowledge');
            await benchmark.press('Tab');
            const condition = page.locator('[data-catalog-picker="benchmark-condition"] > summary').first();
            await keyboardCue(page, condition, 'Benchmark test condition');
            await pointerCue(page, condition, 'Open benchmark test condition');
            await page.locator('[data-catalog-picker="benchmark-condition"] .picker-option').first().click();
            const fields = page.getByRole('searchbox', { name: 'Search score fields' });
            await keyboardCue(page, fields, 'Score field-key search');
            await fields.fill('Harness');
            await page.getByRole('button', { name: 'Harness', exact: true }).click();
            const value = page.locator('.score-field-value summary');
            await pointerCue(page, value, 'Open preset field-value picker');
            await keyboardCue(page, page.getByRole('searchbox', { name: 'Harness options' }), 'Preset field-value search');
            await keyboardCue(page, page.locator('.score-field-value .picker-option').first(), 'Preset field-value option', 'ArrowLeft');
            await page.locator('.score-field-value .picker-option').first().click();
            await keyboardCue(page, page.locator('.score-field-value summary'), 'Selected preset field value');
            await model.fill('This model does not exist');
            await page.waitForFunction(() => document.activeElement?.matches('[data-result-model-query]')
                && document.activeElement.value === 'This model does not exist');
            await page.locator('h1').click();
            await page.locator('[data-result-model-query][aria-invalid="true"]').waitFor();
            assert.equal((await controlStyle(model)).border, 'rgb(200, 90, 99)');
            await noOuterRing(model, 'Invalid model choice keeps a red border without an outer halo');

            await page.goto(`${preview.url}/contribute/score-fields`);
            const type = page.getByRole('combobox', { name: 'Field type' });
            await keyboardCue(page, type, 'New score field type');
            await type.selectOption('enum');
            await keyboardCue(page, type, 'New score field type selected');

            await page.goto(`${preview.url}/censor`);
            const status = page.locator('#status-filter:not([disabled])');
            await status.waitFor();
            await keyboardCue(page, status, 'Moderation status');
            await status.selectOption('approved');
            await status.waitFor();
            await keyboardCue(page, status, 'Moderation status selected');
            await page.locator('#explorer-tab').click();
            await keyboardCue(page, page.locator('#explorer-entity'), 'Data explorer object type');
            await page.locator('#audit-tab').click();
            await keyboardCue(page, page.locator('#audit-action'), 'Audit action');
            await page.screenshot({ path: fileURLToPath(new URL(`moderation-${width}.png`, output)), fullPage: true });

            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            assert.deepEqual(errors, []);
            assert.equal(preview.state.requests.filter(request => request.path === '/api/submit_contribution').length, 0);
            checks.push({ width, passed: true, keyboardFocus: 'internal', selectionAndValidationPreserved: true });
            console.log(`Selection controls passed at ${width}px.`);
        } finally { await context.close(); await preview.close(); }
    }
    for (const environment of [
        { width: 1440, reducedMotion: 'no-preference', forcedColors: 'none' },
        { width: 390, reducedMotion: 'no-preference', forcedColors: 'none' },
        { width: 1440, reducedMotion: 'reduce', forcedColors: 'active' }
    ]) {
        const preview = await startPreview();
        const page = await browser.newPage({ viewport: { width: environment.width, height: 950 },
            reducedMotion: environment.reducedMotion, forcedColors: environment.forcedColors });
        try {
            await page.goto(preview.url);
            await keyboardCue(page, page.locator('.bp-template-control').first(), 'Context picker with motion/contrast preferences');
            if (environment.width < 761) await page.locator('[data-mobile-panel="models"]').click();
            await page.locator('#model-comparison-toggle:not([disabled])').click();
            await page.getByRole('button', { name: 'Add Thinking filter', exact: true }).click();
            await keyboardCue(page, page.getByRole('combobox', { name: 'Thinking filter' }), 'Native select with motion/contrast preferences');
            await page.goto(`${preview.url}/contribute?mode=new_model`);
            await pointerCue(page, page.locator('.vendor-picker > summary'), 'Custom picker with motion/contrast preferences');
            await keyboardCue(page, page.locator('.vendor-picker .picker-search input'), 'Picker search with motion/contrast preferences');
            if (environment.forcedColors === 'active') {
                assert.notEqual((await controlStyle(page.locator('.vendor-picker .picker-search input'))).outline, 'none');
            }
            checks.push({ ...environment, passed: true });
        } finally { await page.close(); await preview.close(); }
    }
    await writeFile(new URL('frontend-checks.json', output), JSON.stringify(checks, null, 2));
    console.log(JSON.stringify(checks));
} finally { await browser.close(); }
