import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { benchmarks, models } from './fixtures.mjs';

const output = new URL('../../artifacts/frontend/comparison-experiment/', import.meta.url);
await mkdir(output, { recursive: true });
const liveURL = process.argv[2]?.startsWith('http') ? process.argv[2] : null;
const fields = [
    { ID: 1, name: 'Agent harness', type: 'text', revision: 1, allowEmpty: false, excludeMissing: true, excludeEmpty: false, options: [] },
    { ID: 20, name: 'Reasoning effort', type: 'enum', revision: 1, allowEmpty: false, excludeMissing: true, excludeEmpty: false,
        options: [{ ID: 201, label: 'high', excluded: false }, { ID: 202, label: 'max', excluded: false }] }
];
const comparisonModels = Array.from({ length: 8 }, (_, index) => {
    const model = models[index < 4 ? 0 : 1];
    const effort = index % 2 ? 202 : 201;
    const harness = index % 4 < 2 ? 'Agent X' : 'Agent Y';
    return { ...model, ID: 201 + index, modelName: model.name, vendor: index < 4 ? 'OpenAI' : 'Anthropic',
        name: `${model.name} / reasoning_effort=${effort} / agent_harness=${harness}`,
        condition: { parameters: { 'field:1': harness, 'field:20': effort }, scoreFields: [
            { fieldID: 1, value: harness }, { fieldID: 20, value: effort }
        ] }, results: new Map(benchmarks.map(item => [String(item.conditionID), { normalizedScore: 50 + index * 4 }])) };
});
const advanced = { mode: 'best', keys: ['field:1'], filters: [{ key: 'model', operator: 'eq', value: 301 }] };
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const results = [];

async function account(page, width, enabled) {
    if (width < 768) await page.locator('#taxonomy-toggle').click();
    await page.locator('#user-profile').click();
    await page.locator('#experimental-comparison').setChecked(enabled);
    await page.locator('#user-account-dialog .dialog-close-button').click();
    if (width < 768) await page.locator('#taxonomy-close').click();
}
async function settled(page, count) {
    await page.waitForFunction(count => document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false'
        && document.querySelectorAll('.bp-model-row').length === count, count);
}
async function snapshot(page, name) {
    await page.screenshot({ path: fileURLToPath(new URL(name, output)), fullPage: true, animations: 'disabled' });
}
async function checkLabels(page, { model, reasoning, harness }) {
    const labels = await page.locator('.bp-model-name').evaluateAll(nodes => nodes.map(node => ({
        text: node.textContent, parts: [...node.children].map(part => ({ key: part.dataset.entryPart,
            title: part.title, text: part.textContent, icon: part.querySelector('i')?.className ?? null,
            translated: part.querySelector('[translate="no"]') !== null }))
    })));
    assert.ok(labels.length);
    for (const label of labels) {
        assert.equal(label.parts.some(part => part.key === 'model'), model);
        assert.equal(label.parts.some(part => part.key === 'field:20'), reasoning);
        assert.equal(label.parts.some(part => part.key === 'field:1'), harness);
        assert.equal(/reasoning_effort=|agent_harness=|Agent harness=|Reasoning effort=| \/ /.test(label.text), false);
        if (model) {
            assert.equal(label.parts[0].key, 'model');
            assert.equal(label.parts[0].icon, null);
            assert.equal(label.parts[0].translated, true);
        }
        if (reasoning) assert.match(label.parts.find(part => part.key === 'field:20').icon, /fa-brain/);
        if (harness) assert.match(label.parts.find(part => part.key === 'field:1').icon, /fa-puzzle-piece/);
    }
    assert.equal(await page.locator('.bp-model-row .bp-vendor-mark').count(), model ? labels.length : 0);
    assert.equal(await page.locator('.bp-model-display-parameter > span').evaluateAll(nodes =>
        nodes.every(node => node.scrollWidth <= node.clientWidth + 1)), true, 'Short parameter values use available row width');
}

for (const [engine, launcher, widths] of liveURL ? [['chromium', chromium, [390]]]
    : [['chromium', chromium, [1440, 320]], ['webkit', webkit, [390]]]) {
    if (process.argv.includes('--webkit') && engine !== 'webkit') continue;
    const browser = await launcher.launch({ headless: true, env });
    try {
        for (const width of widths) {
            const app = await startPreview({ comparisonModels, comparisonFields: fields,
                comparisonLast: advanced, comparisonProfiles: [{ name: 'Harness comparison', comparison: advanced }] });
            const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width < 500, hasTouch: width < 500 });
            const page = await context.newPage();
            page.setDefaultTimeout(12000);
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            if (liveURL) await page.route('**/api/**', async route => {
                const url = new URL(route.request().url());
                await route.fulfill({ response: await route.fetch({ url: app.url + url.pathname + url.search }) });
            });
            try {
                await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded' });
                await settled(page, 2);
                if (width < 768) await page.locator('[data-mobile-panel="models"]').click();
                assert.equal(await page.locator('#model-comparison-toggle').isVisible(), false);
                assert.equal(await page.locator('[data-quick-comparison]').count(), 2);
                assert.deepEqual(app.state.requests.find(request => request.path === '/api/get_weighted_workspace').body.comparison,
                    { mode: 'best', keys: ['model'], filters: [] });
                await checkLabels(page, { model: true, reasoning: false, harness: false });
                await page.locator('[data-quick-comparison="reasoning"]').click();
                await settled(page, 4);
                await checkLabels(page, { model: true, reasoning: true, harness: false });
                await page.locator('[data-quick-comparison="harness"]').click();
                await settled(page, 8);
                await checkLabels(page, { model: true, reasoning: true, harness: true });
                await snapshot(page, `${liveURL ? 'live-' : ''}${engine}-${width}-basic.png`);
                await page.locator('.bp-model-row').first().click();
                await page.locator('#model-scores-dialog').waitFor({ state: 'visible' });
                assert.equal(await page.locator('#model-scores-title [data-entry-part="model"]').innerText(), 'Cedar Sonnet');
                assert.equal(await page.locator('#model-scores-title .fa-brain').count(), 1);
                await page.locator('#model-scores-dialog .dialog-close-button').click();
                assert.deepEqual(app.state.comparisonLast, advanced, 'Basic controls do not replace advanced last-used configuration');

                await account(page, width, true);
                await settled(page, 2);
                await page.locator('#model-comparison-toggle').click();
                await page.locator('#model-comparison-panel').waitFor({ state: 'visible' });
                await checkLabels(page, { model: false, reasoning: false, harness: true });
                const modelInput = page.getByRole('combobox', { name: 'Model value', exact: true });
                assert.equal(await page.locator('.bp-model-limit-mark .bp-filter-vendor-mark').count(), 1);
                await modelInput.fill('Cedar');
                await modelInput.click();
                const suggestion = page.locator('.bp-model-limit-results [role="option"]').first();
                await suggestion.waitFor();
                assert.equal(await suggestion.locator('.bp-filter-vendor-mark').count(), 1);
                const visible = await suggestion.evaluate(node => {
                    const box = node.getBoundingClientRect();
                    return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('[role="option"]') === node;
                });
                assert.equal(visible, true, 'Model suggestions are not clipped by the filter panel');
                await snapshot(page, `${liveURL ? 'live-' : ''}${engine}-${width}-model-limit.png`);
                await modelInput.press('ArrowDown');
                await modelInput.press('Enter');
                await settled(page, 2);
                assert.equal(await modelInput.inputValue(), 'Cedar Sonnet');
                assert.equal(await page.locator('.bp-model-limit-results').isVisible(), false);
                await modelInput.fill('Nonexistent model');
                await modelInput.blur();
                await page.locator('.bp-filter-error').filter({ hasText: 'Choose an existing model.' }).waitFor();
                assert.equal(await modelInput.getAttribute('aria-invalid'), 'true');
                await modelInput.fill('Cedar Sonnet');
                await modelInput.blur();
                await page.locator('#model-comparison-keys input[value="model"]').check();
                await settled(page, 2);
                await checkLabels(page, { model: true, reasoning: false, harness: true });
                await page.locator('#model-comparison-keys input[value="field:20"]').check();
                await settled(page, 4);
                await checkLabels(page, { model: true, reasoning: true, harness: true });
                await snapshot(page, `${liveURL ? 'live-' : ''}${engine}-${width}-advanced.png`);
                await page.locator('#model-comparison-close').click();
                await account(page, width, false);
                await settled(page, 8);
                await checkLabels(page, { model: true, reasoning: true, harness: true });
                assert.equal(await page.locator('#model-comparison-toggle').isVisible(), false);
                assert.equal(app.state.comparisonProfiles.length, 1);
                await page.reload({ waitUntil: 'domcontentloaded' });
                await settled(page, 8);
                if (width < 768) await page.locator('[data-mobile-panel="models"]').click();
                await checkLabels(page, { model: true, reasoning: true, harness: true });

                if (width < 768) await page.locator('[data-mobile-panel="mix"]').click();
                app.state.workspaceDelay = 1200;
                await page.locator('#workspace-refresh').click();
                await page.locator('#pie-mode-personal').click();
                await page.waitForFunction(() => document.querySelector('#pie-mode-personal')?.getAttribute('aria-busy') === 'true');
                assert.equal(await page.locator('#pie-mode-public').getAttribute('aria-selected'), 'true');
                assert.equal(await page.locator('#pie-mode-personal .bp-pie-mode-loading').isVisible(), true);
                await page.waitForFunction(() => document.querySelector('.bp-pie-flip-face') !== null);
                const timing = await page.evaluate(() => {
                    const face = document.querySelector('.bp-pie-flip-face');
                    const incoming = document.querySelector('.bp-pie-flip-incoming');
                    const oldAnimation = face.getAnimations()[0];
                    const newAnimation = incoming.getAnimations()[0];
                    oldAnimation.pause(); newAnimation.pause();
                    oldAnimation.currentTime = 180; newAnimation.currentTime = 180;
                    window.__pieAnimations = [oldAnimation, newAnimation];
                    return { out: oldAnimation.effect.getTiming().duration, delay: newAnimation.effect.getTiming().delay,
                        in: newAnimation.effect.getTiming().duration, oldTransform: getComputedStyle(face).transform,
                        newOpacity: getComputedStyle(incoming).opacity };
                });
                assert.deepEqual([timing.out, timing.delay, timing.in], [360, 360, 440]);
                assert.notEqual(timing.oldTransform, 'none');
                assert.equal(timing.newOpacity, '0');
                assert.equal(await page.locator('#pie-mode-personal').getAttribute('aria-busy'), 'false');
                await page.screenshot({ path: fileURLToPath(new URL(`${engine}-${width}-flip-out.png`, output)), fullPage: true });
                await page.evaluate(() => {
                    window.__pieAnimations[0].currentTime = 540;
                    window.__pieAnimations[1].currentTime = 540;
                });
                await page.screenshot({ path: fileURLToPath(new URL(`${engine}-${width}-flip-in.png`, output)), fullPage: true });
                await page.evaluate(() => window.__pieAnimations.forEach(animation => animation.finish()));
                await page.waitForFunction(() => !document.querySelector('.bp-pie-flip-face'));
                app.state.workspaceDelay = 0;
                await page.locator('#pie-mode-public').click();
                await page.locator('#pie-mode-personal').click();
                await page.locator('#pie-mode-public').click();
                await page.waitForFunction(() => !document.querySelector('.bp-pie-flip-face')
                    && document.querySelector('#pie-mode-public')?.getAttribute('aria-selected') === 'true'
                    && document.querySelector('#pie-mode-personal')?.getAttribute('aria-busy') === 'false');
                app.state.workspaceDelay = 350;
                app.state.workspaceFailure = 400;
                await page.locator('#workspace-refresh').click();
                await page.locator('#pie-mode-personal').click();
                await page.waitForFunction(() => document.querySelector('#pie-mode-personal')?.getAttribute('aria-busy') === 'false'
                    && document.querySelectorAll('.bp-error-state').length === 2);
                assert.equal(await page.locator('#pie-mode-public').getAttribute('aria-selected'), 'true');
                assert.equal(await page.locator('#benchmark-card').getAttribute('aria-busy'), 'false');
                app.state.workspaceFailure = null;
                app.state.workspaceDelay = 0;
                await page.locator('#workspace-refresh').click();
                await settled(page, 8);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                assert.deepEqual(errors, []);
                results.push({ engine, width, passed: true, timing });
                console.log(`PASS ${liveURL ? 'live ' : ''}${engine} ${width}`);
            } catch (error) {
                await snapshot(page, `${engine}-${width}-failure.png`);
                console.error(await page.locator('.bp-model-limit-results, .bp-model-limit-value, #model-comparison-panel').evaluateAll(nodes => nodes.map(node => ({
                    class: node.className, hidden: node.hidden, box: node.getBoundingClientRect().toJSON(), parent: node.parentElement.className,
                    active: document.activeElement?.className, style: node.style.cssText
                }))));
                console.error(JSON.stringify({ errors, requests: app.state.requests.slice(-5) }, null, 2));
                throw error;
            } finally { await context.close(); await app.close(); }
        }
        if (!liveURL && engine === 'chromium') {
            const app = await startPreview({ authenticated: false, empty: true });
            const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
            const page = await context.newPage();
            try {
                await page.addInitScript(() => localStorage.setItem('benchpoll-comparison-settings-v1:guest', JSON.stringify({ experimental: true,
                    basic: { mode: 'matched', keys: ['field:1'], filters: [{ key: 'model', operator: 'eq', value: 301 }] } })));
                await page.goto(app.url);
                await page.waitForFunction(() => document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false');
                assert.equal(await page.locator('#model-comparison-toggle').isVisible(), false);
                assert.equal(await page.locator('#experimental-comparison').isDisabled(), true);
                app.state.authenticated = true;
                await page.reload();
                await page.waitForFunction(() => document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false');
                await page.locator('[data-navigation-view="configured"]').click();
                assert.equal(await page.locator('#configured-content [data-entry-key]').count(), 0);
                assert.equal(await page.locator('#configured-content').innerText().then(text => text.includes('Language models')), false);
                results.push({ guestIsolationAndEmptyConfigured: true });
                console.log('PASS guest isolation and empty Configured');
            } finally { await context.close(); await app.close(); }
        }
    } finally { await browser.close(); }
}
await writeFile(new URL(liveURL ? 'live-results.json' : 'results.json', output), JSON.stringify(results, null, 2));
