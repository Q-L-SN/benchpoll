import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { benchmarks, models } from './fixtures.mjs';

const output = resolve(process.env.COMPARISON_LAYOUT_OUTPUT ?? 'artifacts/frontend/comparison-layout');
await mkdir(output, { recursive: true });
const liveURL = process.argv.find(value => /^https?:\/\//.test(value));
const labelsOnly = process.argv.includes('--labels-only');
const fields = [
    { ID: 1, name: 'Agent harness', type: 'text', revision: 1, allowEmpty: false, excludeMissing: true, excludeEmpty: false, options: [] },
    { ID: 20, name: 'Reasoning effort', type: 'enum', revision: 1, allowEmpty: false, excludeMissing: true, excludeEmpty: false,
        options: [{ ID: 201, label: 'high', excluded: false }, { ID: 202, label: 'max', excluded: false }] }
];
const longHarness = 'Mini-SWE-Agent with a long descriptive configuration name and version 2026.10';
const comparisonModels = Array.from({ length: 8 }, (_, index) => {
    const model = models[index < 4 ? 0 : 1];
    const modelName = index < 4 ? model.name : 'Cedar Sonnet with an exceptionally long model name 2026.10';
    const effort = index % 2 ? 202 : 201;
    const harness = index % 4 < 2 ? 'Agent X' : longHarness;
    return { ...model, ID: 201 + index, modelName, vendor: index < 4 ? 'OpenAI' : 'Anthropic',
        name: `${modelName} / reasoning_effort=${effort} / agent_harness=${harness}`,
        condition: { parameters: { 'field:1': harness, 'field:20': effort }, scoreFields: [
            { fieldID: 1, value: harness }, { fieldID: 20, value: effort }
        ] }, results: new Map(benchmarks.map(item => [String(item.conditionID), { normalizedScore: 50 + index * 4 }])) };
});
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const reports = [];
const engines = liveURL ? [['chromium', chromium, [1440, 320]]] : [
    ['chromium', chromium, [1440, 1024, 768, 390, 320]], ['webkit', webkit, [390, 320]]
];
for (const [engine, launcher, widths] of engines) {
    const browser = await launcher.launch({ headless: true, env });
    try {
        for (const width of widths) {
            const app = await startPreview({ comparisonModels, comparisonFields: fields });
            const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width < 500, hasTouch: width < 500 });
            const page = await context.newPage();
            page.setDefaultTimeout(15000);
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(() => localStorage.setItem('benchpoll-workspace-display-v1', 'standard'));
            if (liveURL) await page.route('**/api/**', async route => {
                const url = new URL(route.request().url());
                await route.fulfill({ response: await route.fetch({ url: app.url + url.pathname + url.search }) });
            });
            try {
                await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded' });
                await page.waitForFunction(() => document.querySelectorAll('.bp-model-row').length === 2
                    && !document.querySelector('[data-quick-comparison="reasoning"]').disabled);
                if (width < 768) await page.locator('[data-mobile-panel="models"]').click();
                const controls = await page.locator('.bp-scoring-toolbar').evaluate(toolbar => {
                    const box = element => element.getBoundingClientRect();
                    const mode = box(toolbar.querySelector('.bp-scoring-switch'));
                    const help = box(toolbar.querySelector('.bp-scoring-help'));
                    const bounds = box(toolbar);
                    return [...toolbar.querySelectorAll('[data-quick-comparison]')].map(button => {
                        const rect = box(button);
                        return { text: button.textContent.trim(), label: button.getAttribute('aria-label'), title: button.title,
                            width: rect.width, height: rect.height, circle: getComputedStyle(button).borderRadius,
                            sameRow: Math.abs(rect.y + rect.height / 2 - mode.y - mode.height / 2) < 1,
                            inBounds: rect.right <= bounds.right + 1 && rect.left >= help.right - 1 };
                    });
                });
                if (!labelsOnly) {
                    assert.equal(await page.locator('.bp-scoring-switch button').evaluateAll(buttons => buttons.every(button =>
                        button.scrollWidth <= button.clientWidth + 1)), true, 'Mode labels do not overflow their buttons');
                    for (const control of controls) {
                        assert.equal(control.text, '');
                        assert.ok(control.label && control.title);
                        assert.equal(control.circle, '50%');
                        assert.ok(Math.abs(control.width - control.height) < 1);
                        assert.ok(control.width >= (width <= 760 ? 36 : 32));
                        assert.equal(control.sameRow, true, JSON.stringify({ width, control }));
                        assert.equal(control.inBounds, true);
                    }
                }
                const reasoning = page.locator('[data-quick-comparison="reasoning"]');
                await reasoning.focus();
                await page.keyboard.press('Space');
                await page.waitForFunction(() => document.querySelectorAll('.bp-model-row').length === 4);
                assert.equal(await reasoning.getAttribute('aria-pressed'), 'true');
                await page.locator('[data-quick-comparison="harness"]').click();
                await page.waitForFunction(() => document.querySelectorAll('.bp-model-row').length === 8);
                await page.evaluate(async () => {
                    await document.fonts.ready;
                    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                });
                const labels = await page.locator('.bp-model-name').evaluateAll(nodes => nodes.map(label => {
                    const model = label.querySelector('[data-entry-part="model"]');
                    const firstModelLine = model.getClientRects()[0];
                    const text = model.firstElementChild.getBoundingClientRect();
                    const pie = model.querySelector('.bp-model-coverage')?.getBoundingClientRect();
                    const parameters = [...label.querySelectorAll('.bp-model-display-parameter')].map(parameter => {
                        const icon = parameter.querySelector('i');
                        const value = parameter.querySelector('span');
                        const iconRect = icon.getBoundingClientRect(), valueRect = value.getBoundingClientRect();
                        return { text: value.textContent, fullValue: value.scrollWidth <= value.clientWidth + 1,
                            sameLine: Math.abs(iconRect.y + iconRect.height / 2 - valueRect.y - valueRect.height / 2) < 1,
                            whitespace: getComputedStyle(value).whiteSpace, ellipsis: getComputedStyle(value).textOverflow === 'ellipsis',
                            onFirstLine: Math.abs(valueRect.y + valueRect.height / 2 - firstModelLine.y - firstModelLine.height / 2) < 5,
                            scrollable: parameter.scrollWidth > parameter.clientWidth + 1,
                            width: parameter.clientWidth, pageBounded: parameter.getBoundingClientRect().right <= innerWidth + 1 };
                    });
                    const firstParameter = label.querySelector('.bp-model-display-parameter');
                    const firstLineRoom = label.getBoundingClientRect().right - firstModelLine.right;
                    const canPackFirstParameter = model.getClientRects().length === 1
                        && firstParameter.scrollWidth <= firstParameter.clientWidth + 1
                        && firstParameter.getBoundingClientRect().width + 7 <= firstLineRoom + 1;
                    return { text: model.textContent, parameters, canPackFirstParameter,
                        coverageGap: pie ? pie.left - text.right : null,
                        coverageBounded: pie ? pie.right <= label.getBoundingClientRect().right + 1 : false };
                }));
                for (const label of labels) {
                    assert.ok(Math.abs(label.coverageGap - 6) < 1, 'Coverage follows the model name before any parameters');
                    assert.equal(label.coverageBounded, true, 'Long names cannot push coverage outside the label');
                }
                for (const label of labels.filter(label => label.canPackFirstParameter)) {
                    assert.equal(label.parameters[0].onFirstLine, true, 'Parameters use remaining first-line space');
                }
                if (width >= 1024) assert.ok(labels.some(label => label.parameters.some(part => part.onFirstLine)), 'Wide labels do not force parameter line breaks');
                for (const label of labels) for (const parameter of label.parameters) {
                    assert.equal(parameter.fullValue, true, JSON.stringify(parameter));
                    assert.equal(parameter.sameLine, true, JSON.stringify(parameter));
                    assert.equal(parameter.whitespace, 'nowrap');
                    assert.equal(parameter.ellipsis, false);
                    assert.equal(parameter.pageBounded, true);
                }
                assert.ok(labels.some(label => label.parameters.some(part => part.text === longHarness)), 'Long atomic values remain complete');
                assert.equal(labels.some(label => label.parameters.some(part => part.scrollable)), false, 'Parameters never become horizontal scroll areas');
                const longValue = page.locator('.bp-model-display-parameter').filter({ hasText: longHarness }).first();
                assert.equal(await longValue.evaluate(element => { element.scrollLeft = element.scrollWidth; return element.scrollLeft; }), 0);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                assert.deepEqual(errors, []);
                await page.screenshot({ path: join(output, `${liveURL ? 'live-' : ''}${engine}-${width}.png`), fullPage: true, animations: 'disabled' });
                reports.push({ engine, width, controls, labels, passed: true });
                console.log(`PASS ${liveURL ? 'live ' : ''}${engine} ${width}`);
            } catch (error) {
                await page.screenshot({ path: join(output, `${engine}-${width}-failure.png`), fullPage: true });
                console.error(JSON.stringify({ engine, width, errors, requests: app.state.requests.slice(-4) }));
                throw error;
            } finally { await context.close(); await app.close(); }
        }
    } finally { await browser.close(); }
}
await writeFile(join(output, liveURL ? 'live-results.json' : 'results.json'), JSON.stringify(reports, null, 2));
