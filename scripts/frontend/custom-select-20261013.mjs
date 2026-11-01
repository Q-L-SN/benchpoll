import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { catalog } from './fixtures.mjs';

const output = process.env.CUSTOM_SELECT_OUTPUT ?? 'D:/Codex-artifacts/website1/custom-select-20261013';
const fixture = await readFile(new URL('../../test/fixtures/custom-select.html', import.meta.url), 'utf8');
const legacyUI = (await readFile(new URL('../../public/js/shared/ui-components.js', import.meta.url), 'utf8'))
    .split('\n').filter(line => !line.includes("from './custom-select.js?") && !line.includes('mountCustomSelect(root)') && !line.includes('observeCustomSelects(root)')).join('\n');
await mkdir(output, { recursive: true });
const reports = [];
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const cases = [['chromium', chromium, 1440], ['chromium', chromium, 1024], ['chromium', chromium, 390], ['chromium', chromium, 320], ['webkit', webkit, 390], ['chromium', chromium, 390, true]];

async function assertBacking(page) {
    await page.waitForFunction(() => [...document.querySelectorAll('select')].every(select =>
        select.classList.contains('bp-ui-select-native') && getComputedStyle(select).display === 'none'
        && select.tabIndex === -1 && select.getAttribute('aria-hidden') === 'true'
        && select.nextElementSibling?.matches('.bp-ui-select')));
}

async function choose(page, control, name) {
    const touch = page.viewportSize().width < 760;
    if (touch) await control.tap();
    else await control.click();
    const ID = await control.getAttribute('aria-controls');
    const option = page.locator('#' + ID).getByRole('option', { name, exact: true });
    if (touch) await option.tap();
    else await option.click();
}

async function focusCue(page, control) {
    await page.keyboard.press('Tab');
    await control.focus();
    const cue = await control.evaluate(node => {
        const css = getComputedStyle(node);
        return { focus: node.matches(':focus-visible'), outline: css.outlineStyle, width: parseFloat(css.outlineWidth),
            offset: parseFloat(css.outlineOffset), shadow: css.boxShadow };
    });
    assert.equal(cue.focus, true);
    assert.equal(cue.outline, 'solid');
    assert.equal(cue.width, 2);
    assert.ok(cue.offset < 0);
    assert.equal(cue.shadow, 'none');
    return cue;
}

for (const [engine, launcher, width, legacyCache = false] of cases) {
    if (process.env.UI_TEST_ENGINE && process.env.UI_TEST_ENGINE !== engine) continue;
    if (process.env.UI_TEST_WIDTH && Number(process.env.UI_TEST_WIDTH) !== width) continue;
    const app = await startPreview({ comparisonFields: [...catalog().scoreFields, {
        ID: 4, name: 'Effort', type: 'enum', revision: 1, allowEmpty: true, excludeMissing: true, excludeEmpty: false,
        options: [{ ID: 41, label: 'Low', excluded: false, revision: 1 }, { ID: 42, label: 'High', excluded: false, revision: 1 }]
    }] });
    const browser = await launcher.launch({ headless: true, env });
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760 });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [], measurements = [], label = `${engine}-${width}${legacyCache ? '-old-module-cache' : ''}`;
    page.on('pageerror', error => errors.push(error.message));
    if (engine === 'webkit') await page.route(`${app.url}/**`, async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: await response.body() });
    });
    await page.route('**/__select-field', route => route.fulfill({ body: fixture, contentType: 'text/html' }));
    if (legacyCache) await page.route('**/js/shared/ui-components.js', route => route.fulfill({ body: legacyUI, contentType: 'text/javascript' }));
    try {
        await page.goto(app.url + '/__select-field');
        await page.waitForFunction(() => window.selectFixture?.ready);
        await assertBacking(page);
        await page.evaluate(() => document.fonts.ready);
        const preset = page.getByRole('combobox', { name: 'Run preset', exact: true });
        assert.equal(await preset.getAttribute('aria-required'), 'true');
        assert.equal(await preset.getAttribute('aria-describedby'), 'preset-help');
        measurements.push({ name: 'keyboard-focus', ...await focusCue(page, preset) });
        await preset.press('ArrowDown');
        const menu = page.locator('#' + await preset.getAttribute('aria-controls'));
        const activeName = () => preset.evaluate(node => document.getElementById(node.getAttribute('aria-activedescendant'))?.textContent);
        assert.equal(await activeName(), 'Aster');
        await page.evaluate(() => {
            window.dispatchEvent(new Event('scroll'));
            window.dispatchEvent(new Event('resize'));
            window.visualViewport?.dispatchEvent(new Event('scroll'));
            window.visualViewport?.dispatchEvent(new Event('resize'));
        });
        assert.deepEqual(errors, []);
        assert.equal(await preset.getAttribute('aria-expanded'), 'true');
        await preset.press('ArrowDown'); assert.equal(await activeName(), 'Birch');
        await preset.press('End'); assert.equal(await activeName(), 'Cherry');
        await preset.press('Home'); assert.equal(await activeName(), 'Aster');
        await preset.press('b'); assert.equal(await activeName(), 'Birch');
        await preset.press('b'); assert.equal(await activeName(), 'Basil');
        await page.waitForTimeout(750);
        await preset.press('c'); await preset.press('h'); assert.equal(await activeName(), 'Cherry');
        assert.equal(await page.locator('#preset').inputValue(), '');
        assert.deepEqual(await page.evaluate(() => window.selectFixture.events), []);
        await preset.press('Enter');
        assert.equal(await page.locator('#preset').inputValue(), 'cherry');
        assert.equal(await preset.getAttribute('aria-expanded'), 'false');
        assert.deepEqual(await page.evaluate(() => window.selectFixture.events), [['input', 'preset', 'cherry'], ['change', 'preset', 'cherry']]);
        await preset.press('ArrowDown'); await preset.press('Home'); await preset.press('Escape');
        assert.equal(await page.locator('#preset').inputValue(), 'cherry');
        await preset.press('ArrowDown'); await preset.press('Home'); await preset.press('Tab');
        assert.equal(await page.locator('#preset').inputValue(), 'aster');
        assert.equal(await preset.getAttribute('aria-expanded'), 'false');
        assert.equal(await page.getByRole('combobox', { name: 'Programmatic value', exact: true }).evaluate(node => node === document.activeElement), true);

        await page.evaluate(() => { const select = document.querySelector('#programmatic'); select.value = 'two'; });
        const programmatic = page.getByRole('combobox', { name: 'Programmatic value', exact: true });
        assert.match(await programmatic.textContent(), /Two/);
        await page.evaluate(() => { document.querySelector('#programmatic').selectedIndex = 2; });
        assert.match(await programmatic.textContent(), /Three/);
        await page.evaluate(() => { document.querySelector('#programmatic').options[0].selected = true; });
        assert.match(await programmatic.textContent(), /One/);
        await page.evaluate(() => { document.querySelector('#programmatic').options.selectedIndex = 1; });
        await page.waitForFunction(() => document.querySelector('#programmatic').nextElementSibling.textContent.includes('Two'));
        await page.evaluate(() => {
            const select = document.querySelector('#programmatic');
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'three');
        });
        await page.waitForFunction(() => document.querySelector('#programmatic').nextElementSibling.textContent.includes('Three'));
        await page.locator('label[for="programmatic"]').click();
        assert.equal(await programmatic.evaluate(node => node === document.activeElement), true);
        await page.evaluate(() => document.querySelector('#preset').focus());
        assert.equal(await preset.evaluate(node => node === document.activeElement), true);
        assert.ok((await page.evaluate(() => window.selectFixture.focusEvents)).includes('focus'));
        await page.locator('#after').focus();
        await page.evaluate(() => document.querySelector('#preset').showPicker());
        assert.equal(await preset.getAttribute('aria-expanded'), 'true');
        assert.equal(await preset.evaluate(node => node === document.activeElement), true);
        await page.locator('h1').click(); assert.equal(await preset.getAttribute('aria-expanded'), 'false');
        assert.ok((await page.evaluate(() => window.selectFixture.focusEvents)).includes('blur'));

        assert.equal(await page.getByRole('combobox', { name: 'Disabled field', exact: true }).isDisabled(), true);
        await page.evaluate(() => { document.querySelector('#disabled-fieldset').disabled = false; });
        await page.getByRole('combobox', { name: 'Disabled field', exact: true }).waitFor();
        await page.waitForFunction(() => !document.querySelector('#disabled').nextElementSibling.querySelector('button').disabled);
        await page.evaluate(() => { document.querySelector('#preset').disabled = true; });
        await page.waitForFunction(() => document.querySelector('#preset').nextElementSibling.querySelector('button').disabled);
        await page.evaluate(() => { document.querySelector('#preset').disabled = false; });
        await page.waitForFunction(() => !document.querySelector('#preset').nextElementSibling.querySelector('button').disabled);
        await preset.click();
        assert.equal(await menu.getByRole('group', { name: 'Current', exact: true }).count(), 1);
        assert.equal(await menu.getByRole('option', { name: 'Blocked', exact: true }).getAttribute('aria-disabled'), 'true');
        assert.equal(await menu.getByRole('option', { name: 'Archived run', exact: true }).getAttribute('aria-disabled'), 'true');
        assert.equal(await menu.getByRole('option', { name: 'Hidden run', exact: true }).count(), 0);
        await menu.getByRole('option', { name: 'Blocked', exact: true }).click();
        assert.equal(await page.locator('#preset').inputValue(), 'aster');
        const selectedColor = await menu.getByRole('option', { name: 'Aster', exact: true }).evaluate(node => getComputedStyle(node).backgroundColor);
        await menu.getByRole('option', { name: 'Birch', exact: true }).hover();
        await page.waitForTimeout(160);
        const hoverColor = await menu.getByRole('option', { name: 'Birch', exact: true }).evaluate(node => getComputedStyle(node).backgroundColor);
        assert.notEqual(selectedColor, hoverColor);
        measurements.push({ name: 'selection-hover', selectedColor, hoverColor });
        await page.screenshot({ path: join(output, `${label}-grouped.png`), fullPage: true });
        await preset.press('Escape');

        await page.evaluate(() => {
            document.querySelector('#selection-form').addEventListener('reset', event => event.preventDefault(), { once: true });
            HTMLFormElement.prototype.reset.call(document.querySelector('#selection-form'));
        });
        assert.equal(await page.locator('#preset').inputValue(), 'aster');
        await page.locator('#reset').click();
        await page.waitForFunction(() => document.querySelector('#preset').nextElementSibling.querySelector('.bp-ui-select-value').textContent === 'Choose a preset');
        const invalid = await page.evaluate(() => document.querySelector('#selection-form').reportValidity());
        assert.equal(invalid, false);
        assert.equal(await preset.getAttribute('aria-invalid'), 'true');
        assert.equal(await page.locator('#preset + .bp-ui-select .bp-ui-select-error').isVisible(), true);
        assert.equal(await preset.evaluate(node => node === document.activeElement), true);
        await page.locator('#submit').click();
        assert.deepEqual(await page.evaluate(() => window.selectFixture.submissions), []);
        await choose(page, preset, 'Aster');
        assert.equal(await preset.getAttribute('aria-invalid'), 'false');
        await page.locator('#submit').click();
        assert.ok((await page.evaluate(() => window.selectFixture.submissions))[0].some(([key, value]) => key === 'preset' && value === 'aster'));
        await page.evaluate(() => { document.querySelector('#preset').setCustomValidity('Preset rejected'); document.querySelector('#preset').reportValidity(); });
        assert.equal(await page.locator('#preset + .bp-ui-select .bp-ui-select-error').textContent(), 'Preset rejected');
        await page.evaluate(() => { document.querySelector('#preset').setCustomValidity(''); });
        await page.waitForFunction(() => document.querySelector('#preset').nextElementSibling.querySelector('button').getAttribute('aria-invalid') === 'false');

        const multiple = page.getByRole('combobox', { name: 'Multiple values', exact: true });
        await choose(page, multiple, 'Beta');
        assert.equal(await multiple.getAttribute('aria-expanded'), 'true');
        assert.equal(await page.locator('#multiple').evaluate(node => [...node.selectedOptions].map(option => option.value).join(',')), 'a,b');
        await multiple.press('End'); await multiple.press(' ');
        assert.equal(await page.locator('#multiple').evaluate(node => [...node.selectedOptions].map(option => option.value).join(',')), 'a,b,g');
        await multiple.press('Tab');
        assert.equal(await multiple.getAttribute('aria-expanded'), 'false');
        const rerendered = page.getByRole('combobox', { name: 'Rerendered field', exact: true });
        await choose(page, rerendered, 'Two');
        assert.equal(await rerendered.evaluate(node => node === document.activeElement), true);
        await rerendered.press('ArrowDown'); await rerendered.press('Home'); await rerendered.press('Tab');
        assert.equal(await page.locator('#rerendering').inputValue(), 'one');
        assert.equal(await page.locator('#after').evaluate(node => node === document.activeElement), true);

        await page.evaluate(() => {
            const label = document.createElement('label');
            label.innerHTML = '<span>Dynamic preset</span><select id="dynamic-select"><option>Aster</option><option>Birch</option></select>';
            document.querySelector('#dynamic').append(label);
            document.querySelector('#dynamic-select').focus();
        });
        await assertBacking(page);
        const dynamic = page.getByRole('combobox', { name: 'Dynamic preset', exact: true });
        assert.equal(await dynamic.evaluate(node => node === document.activeElement), true);
        await choose(page, dynamic, 'Birch');
        await page.evaluate(() => {
            const select = document.querySelector('#dynamic-select');
            select.options[1].label = 'Renamed Birch';
            select.add(new Option('Cedar', 'cedar'));
        });
        await page.waitForFunction(() => document.querySelector('#dynamic-select').nextElementSibling.querySelector('.bp-ui-select-value').textContent === 'Renamed Birch');
        await choose(page, dynamic, 'Cedar');
        await page.evaluate(() => { document.querySelector('#dynamic-select').options[2].remove(); });
        await page.waitForFunction(() => document.querySelector('#dynamic-select').nextElementSibling.querySelector('.bp-ui-select-value').textContent === 'Aster');
        await dynamic.click();
        await page.evaluate(() => { document.querySelector('#dynamic-select').remove(); });
        await page.waitForFunction(() => !document.querySelector('#dynamic .bp-ui-select'));
        assert.equal(await page.locator('.bp-ui-select-popup[data-ui-open="true"]').count(), 0);
        await page.evaluate(() => {
            const clone = document.querySelector('#preset').parentElement.cloneNode(true);
            clone.querySelector('select').id = 'cloned-select';
            clone.querySelector('span').textContent = 'Cloned field';
            document.querySelector('#dynamic').append(clone);
        });
        await assertBacking(page);
        const cloned = page.getByRole('combobox', { name: 'Cloned field', exact: true });
        assert.equal(await cloned.count(), 1);
        assert.equal(await cloned.getAttribute('tabindex'), '0');
        await choose(page, cloned, 'Birch');
        await page.evaluate(() => {
            const select = document.querySelector('#cloned-select');
            select.required = true;
            select.setAttribute('aria-label', 'Renamed cloned field');
            select.hidden = true;
        });
        await page.waitForFunction(() => document.querySelector('#cloned-select').nextElementSibling.hidden);
        await page.evaluate(() => { document.querySelector('#cloned-select').hidden = false; });
        const renamed = page.getByRole('combobox', { name: 'Renamed cloned field', exact: true });
        await renamed.waitFor();
        assert.equal(await renamed.getAttribute('aria-required'), 'true');
        await renamed.click();
        await programmatic.click();
        assert.equal(await renamed.getAttribute('aria-expanded'), 'false');
        assert.equal(await page.locator('.bp-ui-select-popup[data-ui-open="true"]').count(), 1);
        await programmatic.press('Escape');

        const long = page.getByRole('combobox', { name: 'Long value', exact: true });
        await long.click();
        const longMenu = page.locator('#' + await long.getAttribute('aria-controls'));
        const geometry = await longMenu.evaluate(node => {
            const bounds = node.getBoundingClientRect(), value = document.querySelector('#long + .bp-ui-select .bp-ui-select-value');
            return { bounds: bounds.toJSON(), overflow: node.scrollWidth - node.clientWidth,
                pageOverflow: document.documentElement.scrollWidth - innerWidth, placement: node.dataset.placement,
                valueOverflow: getComputedStyle(value).textOverflow, rowHeight: node.querySelector('[role="option"]').getBoundingClientRect().height,
                icon: getComputedStyle(document.querySelector('#long + .bp-ui-select i'), '::before').content };
        });
        assert.ok(geometry.bounds.x >= 7 && geometry.bounds.right <= width - 7);
        assert.ok(geometry.bounds.y >= 7 && geometry.bounds.bottom <= 893);
        assert.ok(geometry.overflow <= 1 && geometry.pageOverflow <= 1);
        assert.equal(geometry.placement, 'above');
        assert.equal(geometry.valueOverflow, 'ellipsis');
        assert.ok(geometry.rowHeight >= (width < 760 ? 44 : 34));
        assert.notEqual(geometry.icon, 'none');
        measurements.push({ name: 'long-value', ...geometry });
        await page.screenshot({ path: join(output, `${label}-long.png`), fullPage: true });
        await long.press('Escape');

        await page.locator('#open-dialog').focus();
        await page.locator('#open-dialog').press('Enter');
        const dialogPreset = page.getByRole('combobox', { name: 'Dialog preset', exact: true });
        await dialogPreset.click();
        await dialogPreset.press('End'); await dialogPreset.press('Tab');
        assert.equal(await page.locator('#dialog-preset').inputValue(), 'Cherry');
        assert.equal(await page.locator('#dialog-after').evaluate(node => node === document.activeElement), true);
        await dialogPreset.click();
        const dialogMenu = page.locator('#' + await dialogPreset.getAttribute('aria-controls'));
        assert.equal(await dialogMenu.evaluate(node => {
            const rect = node.getBoundingClientRect();
            return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + 12));
        }), true);
        await page.screenshot({ path: join(output, `${label}-dialog.png`), fullPage: true });
        await dialogPreset.press('Escape');
        assert.equal(await page.locator('#custom-dialog').isVisible(), true);
        assert.equal(await dialogPreset.getAttribute('aria-expanded'), 'false');
        await dialogMenu.evaluate(node => node.removeAttribute('popover'));
        await dialogPreset.click();
        assert.equal(await dialogMenu.evaluate(node => {
            const rect = node.getBoundingClientRect();
            return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + 12));
        }), true);
        await dialogMenu.getByRole('option', { name: 'Birch', exact: true }).click();
        assert.equal(await page.locator('#dialog-preset').inputValue(), 'Birch');
        assert.equal(await page.locator('.bp-ui-select-layer').count(), 0);
        await dialogPreset.press('Escape');
        assert.equal(await page.locator('#custom-dialog').isVisible(), false);
        await page.waitForFunction(() => document.activeElement?.id === 'open-dialog');
        await page.evaluate(() => document.querySelector('#native-dialog').showModal());
        const nativePreset = page.getByRole('combobox', { name: 'Native dialog preset', exact: true });
        await page.locator('#' + await nativePreset.getAttribute('aria-controls')).evaluate(node => node.removeAttribute('popover'));
        await choose(page, nativePreset, 'Birch');
        await nativePreset.click(); await nativePreset.press('Escape');
        assert.equal(await page.locator('#native-dialog').evaluate(node => node.open), true);
        await page.locator('#native-close').click();
        await page.evaluate(() => { document.querySelector('#legacy-overlay').hidden = false; });
        const overlayPreset = page.getByRole('combobox', { name: 'Overlay preset', exact: true });
        await overlayPreset.click(); await overlayPreset.press('Escape');
        assert.equal(await page.locator('#legacy-overlay').isVisible(), true);
        await overlayPreset.press('Escape');
        assert.equal(await page.locator('#legacy-overlay').isVisible(), false);

        await page.emulateMedia({ reducedMotion: 'reduce' });
        await preset.click();
        assert.equal(await menu.evaluate(node => getComputedStyle(node).animationName), 'none');
        await preset.press('Escape');
        if (engine === 'chromium') {
            await page.emulateMedia({ forcedColors: 'active' });
            measurements.push({ name: 'forced-colors-focus', ...await focusCue(page, preset) });
            await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'no-preference' });
        }
        assert.deepEqual(errors, []);

        // Adoption checks use only the existing synthetic preview, never a production URL.
        for (const [path, name] of [['/contribute/benchmarks/new', 'Which scores are better?'], ['/censor', 'Moderation status']]) {
            await page.goto(app.url + path);
            const control = page.getByRole('combobox', { name, exact: true });
            await control.waitFor();
            await assertBacking(page);
            await control.click();
            assert.equal(await control.getAttribute('aria-expanded'), 'true');
            await page.locator('#' + await control.getAttribute('aria-controls')).getByRole('option').last().click();
            await assertBacking(page);
            await page.screenshot({ path: join(output, `${label}-${path.includes('censor') ? 'review' : path.includes('score-fields') ? 'score-fields' : 'benchmark'}.png`), fullPage: true });
        }
        await page.goto(app.url + '/contribute/scores/new');
        await page.getByRole('combobox', { name: 'Effort value', exact: true }).waitFor();
        await assertBacking(page);
        await choose(page, page.getByRole('combobox', { name: 'Effort value', exact: true }), 'High');
        await assertBacking(page);
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Effort value');
        assert.match(await page.getByRole('combobox', { name: 'Effort value', exact: true }).textContent(), /High/);
        await choose(page, page.getByRole('combobox', { name: 'Harness value', exact: true }), 'Agent B');
        await assertBacking(page);
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Harness value');
        assert.match(await page.getByRole('combobox', { name: 'Harness value', exact: true }).textContent(), /Agent B/);
        await page.screenshot({ path: join(output, `${label}-effort-harness.png`), fullPage: true });
        await page.evaluate(() => {
            localStorage.setItem('benchpoll-workspace-display-v1', 'standard');
            localStorage.setItem('benchpoll-comparison-settings-v1:1', JSON.stringify({ experimental: true }));
        });
        await page.goto(app.url + '/');
        if (width < 760) await page.locator('[data-mobile-panel="models"]').click();
        await page.locator('#benchmark-card[aria-busy="false"]').waitFor({ state: 'attached' });
        assert.equal(await page.locator('#model-comparison-toggle,#model-comparison-panel,#experimental-comparison').count(), 0);
        await assertBacking(page);
        const template = page.locator('.bp-template-control').first();
        if (width < 760) await page.locator('button[data-mobile-panel="mix"]').click();
        await template.click();
        assert.equal(await page.locator('.bp-template-menu input[type="search"]').count(), 0);
        await page.keyboard.press('Escape');
        assert.equal(app.state.requests.some(request => request.path === '/api/submit_contribution'), false);
        assert.deepEqual(errors, []);
        reports.push({ engine, width, legacyCache, passed: true, measurements });
        console.log(`PASS ${label}: native backing, form, dynamic updates, keyboard, touch, overlays and site adoption`);
    } catch (error) {
        await page.screenshot({ path: join(output, `${label}-failure.png`), fullPage: true }).catch(() => {});
        await writeFile(join(output, `${label}-failure.json`), JSON.stringify({ error: error.message, errors, measurements }, null, 2));
        throw error;
    } finally {
        await context.close();
        await browser.close();
        await app.close();
    }
}
await writeFile(join(output, 'report.json'), JSON.stringify(reports, null, 2));
console.log(`Select field verification: ${reports.length} browser cases. Artifacts: ${output}`);
