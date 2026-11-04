import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';

const output = 'D:/Codex-artifacts/website1/workspace-controls-20261031';
const browsers = new Map();
before(async () => {
    const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
    for (const engine of [chromium, webkit]) browsers.set(engine.name(), await engine.launch({ headless: true, env }));
    await mkdir(output, { recursive: true });
});
after(async () => { for (const browser of browsers.values()) await browser.close(); });

async function mobilePanel(page, width, panel) {
    if (width <= 760) await page.locator(`.bp-mobile-panels button[data-mobile-panel="${panel}"]`).click();
}

for (const engine of ['chromium', 'webkit']) for (const width of [320, 390, 760, 1440]) {
    test(`${engine} ${width}: one contribution control, compact evidence and square editable treemap`, async t => {
        const app = await startPreview({ aaBenchmarks: true });
        const page = await browsers.get(engine).newPage({ viewport: { width, height: 960 },
            hasTouch: width <= 760, reducedMotion: 'reduce' });
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        t.after(async () => { await page.close(); await app.close(); assert.deepEqual(errors, []); });
        await page.route('**/api/get_weighted_workspace', async route => {
            const response = await route.fetch(), data = await response.json();
            for (const entry of data.benchmarks) if (entry.conditionID === 1) {
                entry.name = 'MMLU';
                entry.conditionName = 'Extended multilingual version with long source details and additional evaluation settings';
                entry.conditionKey = 'extended';
                entry.isDefaultCondition = false;
            }
            await route.fulfill({ response, json: data });
        });
        await page.goto(app.url + '/Intelligence');
        await page.locator('#weight-pie[data-chart="treemap"] .bp-weight-tile').first().waitFor();
        await page.evaluate(() => document.fonts.ready);
        const chart = await page.locator('.bp-pie-stage').evaluate(node => {
            const stage = node.getBoundingClientRect(), svg = node.querySelector('svg').getBoundingClientRect();
            return { width: stage.width, height: stage.height, svgWidth: svg.width, svgHeight: svg.height,
                chartWidth: node.querySelector('svg').viewBox.baseVal.width,
                chartHeight: node.querySelector('svg').viewBox.baseVal.height };
        });
        assert.ok(chart.width > 150 && Math.abs(chart.height - chart.width) <= 1, JSON.stringify(chart));
        assert.ok(Math.abs(chart.svgWidth - chart.svgHeight) <= 1, JSON.stringify(chart));
        assert.ok(Math.abs(chart.chartWidth - chart.chartHeight) <= 1, JSON.stringify(chart));
        const evidence = await page.locator('.bp-benchmark-row[data-condition-id="1"]').evaluate(row => {
            const name = row.querySelector('.bp-benchmark-link-name'), count = row.querySelector('.bp-benchmark-score-count');
            const version = row.querySelector('.bp-benchmark-condition'), identity = row.querySelector('.bp-benchmark-identity');
            const rect = node => node.getBoundingClientRect().toJSON();
            return { name: rect(name), link: rect(row.querySelector('.bp-benchmark-information-link')),
                count: rect(count), version: rect(version), identity: rect(identity),
                text: version.textContent, overflow: row.scrollWidth > row.clientWidth + 1 };
        });
        assert.ok(evidence.count.left - evidence.name.right <= 8 && evidence.count.left >= evidence.name.right, JSON.stringify(evidence));
        assert.ok(evidence.count.left >= evidence.link.right, 'The evidence hit area must not overlap the information link');
        assert.ok(Math.abs(evidence.count.top + evidence.count.height / 2 - evidence.name.top - evidence.name.height / 2) <= 1, JSON.stringify(evidence));
        assert.ok(evidence.version.top >= evidence.name.bottom - 1, JSON.stringify(evidence));
        assert.ok(evidence.version.width >= evidence.identity.width - 1, JSON.stringify(evidence));
        assert.match(evidence.text, /additional evaluation settings/);
        assert.equal(evidence.overflow, false);
        await page.locator('.bp-benchmark-row[data-condition-id="1"] .bp-benchmark-information-link').click();
        await page.locator('#discussion-close').click();
        await page.locator('#pie-mode-personal').click();
        const aaAdd = page.locator('.bp-benchmark-row[data-condition-id="9901"] .bp-benchmark-add');
        await aaAdd.waitFor();
        assert.equal(await aaAdd.getAttribute('aria-disabled'), 'true');
        assert.equal(await aaAdd.getAttribute('data-tooltip'), null);
        await mobilePanel(page, width, 'models');
        const action = page.locator('#contribute-data-button');
        await action.waitFor();
        assert.equal(await page.locator('#contribute-data-button').count(), 1);
        assert.equal(await action.getAttribute('aria-label'), 'Contribute scores');
        assert.equal(await action.getAttribute('data-tooltip'), 'Contribute scores');
        const destination = new URL(await action.getAttribute('href'), app.url);
        assert.equal(destination.pathname, '/contribute');
        assert.equal(destination.searchParams.get('mode'), 'benchmark_result');
        const layout = await page.evaluate(() => {
            const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
            return { action: rect('#contribute-data-button'), mode: rect('.bp-scoring-switch'),
                reasoning: rect('[data-quick-comparison="reasoning"]'), harness: rect('[data-quick-comparison="harness"]'),
                help: rect('#quick-comparison-help'), search: rect('#ranking-model-search button'),
                heading: rect('#model-leaderboard-heading'), card: rect('#model-card'),
                border: getComputedStyle(document.querySelector('#contribute-data-button')).borderWidth,
                labelDisplay: getComputedStyle(document.querySelector('#contribute-data-button > span')).display,
                overflow: document.documentElement.scrollWidth > innerWidth + 1 };
        });
        assert.equal(layout.border, '1px');
        assert.equal(layout.overflow, false, JSON.stringify(layout));
        if (width <= 760) {
            assert.equal(layout.labelDisplay, 'none');
            assert.equal(layout.action.width, 44);
            assert.equal(layout.action.height, 44);
            for (const key of ['mode', 'reasoning', 'harness', 'help', 'search']) {
                assert.ok(Math.abs(layout[key].top + layout[key].height / 2 - layout.action.top - layout.action.height / 2) < 2, `${key}: ${JSON.stringify(layout)}`);
            }
            assert.ok(layout.action.left >= layout.search.right && layout.action.right <= layout.card.right, JSON.stringify(layout));
            assert.equal(layout.heading.height, 0);
            assert.equal(await page.locator('[data-score-mode="available"] > span').isVisible(), width >= 390,
                'Scoring labels stay readable at 390px; only genuinely narrow toolbars use icons');
        } else {
            assert.notEqual(layout.labelDisplay, 'none');
            assert.ok(layout.action.width > 100);
            assert.ok(layout.action.bottom < layout.mode.top, JSON.stringify(layout));
            assert.ok(layout.heading.height > 0);
        }
        await page.mouse.move(0, 0);
        await page.keyboard.press('Escape');
        await action.focus();
        assert.equal(await action.evaluate(node => node === document.activeElement), true);
        if (width <= 760) {
            await page.waitForFunction(() => document.querySelector('#bp-help-popover')?.textContent === 'Contribute scores');
        } else {
            assert.equal(await page.locator('#bp-help-popover').isVisible(), false,
                'The shared tooltip policy suppresses redundant labels on full text buttons');
        }
        await page.keyboard.press('Escape');
        await page.locator('[data-score-mode="range"]').click();
        await page.waitForFunction(() => document.querySelector('[data-score-mode="range"]').getAttribute('aria-pressed') === 'true');
        await page.locator('[data-score-mode="available"]').click();
        await page.waitForFunction(() => document.querySelector('[data-score-mode="available"]').getAttribute('aria-pressed') === 'true');
        await page.screenshot({ path: `${output}/${engine}-${width}-toolbar.png`, fullPage: true });
        console.log(JSON.stringify({ engine, width, chart, action: layout.action, mode: layout.mode, overflow: layout.overflow }));
    });
}

for (const engine of ['chromium', 'webkit']) for (const width of [320, 390, 760, 1440]) {
    test(`${engine} ${width}: coverage follows short labels and stays protected beside scrolling parameters`, async t => {
        const app = await startPreview();
        const page = await browsers.get(engine).newPage({ viewport: { width, height: 960 }, hasTouch: width <= 760, reducedMotion: 'reduce' });
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        t.after(async () => { await page.close(); await app.close(); assert.deepEqual(errors, []); });
        await page.goto(app.url + '/Intelligence');
        await mobilePanel(page, width, 'models');
        await page.locator('#model-rows .bp-model-row').first().waitFor();
        await page.evaluate(async () => {
            const { createModelListView } = await import('/js/workspace/model-list.js');
            const comparison = { keys: ['model', 'field:20', 'field:1'], fields: [
                { ID: 20, name: 'Reasoning effort', type: 'text' }, { ID: 1, name: 'Agent harness', type: 'text' }
            ] };
            const models = [['GPT', 'Low', 'Basic'], ['GPT', 'Extended verification with a large token budget'.repeat(5), 'ResearchAgent with tools and independent passes'.repeat(5)]]
                .map(([name, effort, harness], index) => ({ ID: 71 + index, modelID: 71 + index, modelName: name, name,
                    rank: index + 1, lower: 80 - index, upper: 90, coverage: 83, missingWeight: 0, calculationScores: [],
                    condition: { scoreFields: [{ fieldID: 20, value: effort }, { fieldID: 1, value: harness }] } }));
            const state = { authenticated: true, loadSequence: 1, categoryID: 1, selectedContextValues: {}, mode: 'public',
                scoreMode: 'available', workspaceDisplay: 'list', rankingVersion: 1, comparison,
                modelLeaderboards: { public: models }, rankingPageLoading: {}, rankingPageError: {},
                publicEntries: [], personalEntries: [], benchmarkDetailsByID: new Map() };
            window.coverageActivations = 0;
            window.coverageQA = createModelListView({ state, modelRows: document.querySelector('#model-rows'),
                onNeedMore() {}, openApprovedModelResults() { window.coverageActivations++; } });
            window.coverageQA.renderModels();
        });
        await page.evaluate(() => document.fonts.ready);
        const rows = page.locator('#model-rows .bp-model-row');
        const region = rows.nth(1).locator('.bp-model-parameters');
        await page.waitForFunction(() => document.querySelectorAll('#model-rows .bp-model-parameters')[1]?.classList.contains('can-scroll-right'));
        const before = await rows.evaluateAll(nodes => nodes.map(row => {
            const box = node => node.getBoundingClientRect().toJSON();
            const name = row.querySelector('.bp-model-name'), pie = row.querySelector('.bp-model-coverage');
            const parameters = row.querySelector('.bp-model-parameters');
            return { identity: box(row.querySelector('.bp-model-name-wrap')), name: box(name), pie: box(pie),
                parameters: box(parameters), lastParameter: box(parameters.lastElementChild),
                sizes: [...parameters.querySelectorAll('.bp-model-display-parameter > span')].map(node => getComputedStyle(node).fontSize),
                canScroll: parameters.scrollWidth > parameters.clientWidth + 1, mask: getComputedStyle(pie).maskImage,
                overflow: row.scrollWidth > row.clientWidth + 1 };
        }));
        for (const row of before) {
            assert.equal(row.pie.width, 16); assert.equal(row.pie.height, 16);
            assert.equal(row.mask, 'none');
            assert.deepEqual(row.sizes, ['11px', '11px']);
            assert.ok(row.pie.left - row.name.right >= 6 && row.pie.left - row.name.right <= 8, JSON.stringify(row));
            assert.ok(row.pie.right <= row.identity.right + 1, JSON.stringify(row));
            assert.equal(row.overflow, false);
        }
        assert.equal(before[0].canScroll, false);
        assert.ok(before[0].identity.right - before[0].pie.right > 8, 'Short labels must not pin coverage to the far edge');
        assert.ok(before[0].pie.left - before[0].lastParameter.right <= 9, JSON.stringify(before[0]));
        assert.equal(before[1].canScroll, true);
        assert.ok(Math.abs(before[1].identity.right - before[1].pie.right) < 1, JSON.stringify(before[1]));
        await region.focus();
        await page.keyboard.press('End');
        await page.waitForFunction(() => {
            const node = document.querySelectorAll('#model-rows .bp-model-parameters')[1];
            return node.classList.contains('can-scroll-left') && !node.classList.contains('can-scroll-right');
        });
        const after = await rows.nth(1).locator('.bp-model-coverage').evaluate(node => node.getBoundingClientRect().toJSON());
        assert.deepEqual(after, before[1].pie);
        assert.equal(await page.evaluate(() => window.coverageActivations), 0);
        await page.keyboard.press('Home');
        await page.waitForFunction(() => !document.querySelectorAll('#model-rows .bp-model-parameters')[1].classList.contains('can-scroll-left'));
        await page.screenshot({ path: `${output}/${engine}-${width}-coverage.png`, fullPage: true });
    });
}
