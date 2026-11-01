import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { AA_DISPLAY_RESTRICTION } from '../public/js/shared/aa-ranking-policy.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const comparison = { keys: ['model', 'field:20', 'field:1'], fields: [
    { ID: 20, name: 'Reasoning effort', type: 'text' }, { ID: 1, name: 'Agent harness', type: 'text' }
] };
const longValues = ['Extended reasoning with repeated verification, independent cross-checks and a generous 131072 token budget',
    'ResearchAgent harness with browser tools, isolated execution, iterative planning, review passes and experimental configuration version 2026.10 tail-needle'];
const models = [longValues, ['Low', 'Basic']].map((values, index) => ({
    ID: 71 + index, modelID: 71 + index, modelName: index ? 'Short Model' : 'Gemini 4 Argon',
    name: index ? 'Short Model' : 'Gemini 4 Argon', rank: index + 1, lower: 80 - index * 10,
    upper: 90 - index * 10, coverage: 87, missingWeight: 0, calculationScores: [],
    condition: { scoreFields: [{ fieldID: 20, value: values[0] }, { fieldID: 1, value: values[1] }] }
}));
const styles = ['/css/global.css', '/css/ui/tokens.css', '/css/ui/shell.css', '/css/ui/workspace.css',
    '/css/ui/evidence.css', '/css/model-comparison.css', '/css/site-palette.css', '/css/typography.css',
    '/vendor/fontawesome/css/all.min.css'];
const harness = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Parameter scrolling QA</title>
${styles.map(href => `<link rel="stylesheet" href="${href}">`).join('\n')}
<style>body { margin: 0; } #qa { width: calc(100% - 32px); max-width: 560px; margin: 24px auto; }
#model-rows { max-height: none; } #resize-probe { width: 80px; margin-top: 24px; }</style>
<body class="bp-home"><main id="qa"><section id="model-card" class="bp-model-card">
<div class="bp-model-viewport"><div id="model-ranking-status" hidden></div><div id="model-rows" class="bp-model-rows"></div></div>
</section><div id="resize-probe"></div></main>
<global-dialog id="model-scores-dialog" class="bp-model-scores-dialog" hidden>
<div id="model-scores-title" slot="title"></div><div slot="body" class="bp-model-scores-body">
<div id="model-scores-summary" class="bp-model-scores-summary"></div><div class="bp-model-evidence-toolbar">
<div id="model-scores-change-controls" class="bp-model-change-controls" hidden></div>
<label class="bp-model-scores-search"><input id="model-scores-search" type="search" aria-label="Search scores"></label></div>
<div id="model-scores-list" class="bp-model-scores-list" aria-live="polite"></div></div></global-dialog>
<script type="module">
import '/js/global.js';
import { createModelListView } from '/js/workspace/model-list.js';
import { createModelScoresView } from '/js/workspace/model-scores.js';
import { renderComparisonName } from '/js/shared/comparison-display.js';
const models = ${JSON.stringify(models)}, comparison = ${JSON.stringify(comparison)};
const state = { authenticated: false, loadSequence: 1, categoryID: 1, selectedContextValues: {}, mode: 'public',
    scoreMode: 'available', workspaceDisplay: 'list', rankingVersion: 1, comparison,
    modelLeaderboards: { public: models }, rankingPageLoading: {}, rankingPageError: {},
    publicEntries: [], personalEntries: [], benchmarkDetailsByID: new Map() };
const byID = id => document.getElementById(id);
const scores = createModelScoresView({ state, modelScoresDialog: byID('model-scores-dialog'),
    modelScoresTitle: byID('model-scores-title'), modelScoresSummary: byID('model-scores-summary'),
    modelScoresList: byID('model-scores-list'), getMemberURL: () => '/', onInspectVersion() {} });
window.activations = 0;
const rows = createModelListView({ state, modelRows: byID('model-rows'), onNeedMore() {},
    openApprovedModelResults(model) { window.activations++; scores.openApprovedModelResults(model); } });
rows.renderModels();
renderComparisonName(byID('resize-probe'), { modelName: 'Probe', condition: { scoreFields: [
    { fieldID: 20, value: 'Budget 16384 tokens' }] } }, { ...comparison, keys: ['model', 'field:20'] });
window.qa = { state, models, rows, scores };
</script></html>`;

const homeHarness = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Rotated parameters QA</title>
<link rel="stylesheet" href="/css/topics-home.css"><link rel="stylesheet" href="/css/typography.css">
<link rel="stylesheet" href="/vendor/fontawesome/css/all.min.css">
<style>.th-model-identity { margin: 80px auto; width: 260px; height: 260px; }</style>
<body><div class="th-model-identity"><span id="rotated" class="th-model-name"></span></div>
<script type="module">
import { renderComparisonName, comparisonDisplayParts } from '/js/shared/comparison-display.js';
import { modelLabelLayout, MODEL_LABEL_ANGLE } from '/js/topics-home/layout.js';
const model = ${JSON.stringify(models[0])}, comparison = ${JSON.stringify(comparison)};
const name = document.getElementById('rotated');
renderComparisonName(name, model, comparison, { fitParameters: false });
const layout = modelLabelLayout(comparisonDisplayParts(model, comparison));
name.style.cssText = 'width:' + layout.width + 'px;height:' + layout.height + 'px;left:60px;top:' + layout.top + 'px;transform:rotate(-' + MODEL_LABEL_ANGLE + 'deg)';
[...name.children].forEach((part, index) => {
    part.dataset.lines = String(layout.rows[index].lines);
    part.style.setProperty('--th-label-lines', String(layout.rows[index].lines));
    part.style.height = layout.rows[index].lines * 13 + 'px';
    const text = part.querySelector('span');
    text.replaceChildren(...text.textContent.split(/(\\s+)/).filter(Boolean).map(word => {
        if (/^\\s+$/.test(word)) return document.createTextNode(word);
        const span = document.createElement('span'); span.className = 'th-label-word'; span.textContent = word; return span;
    }));
});
window.qa = true;
</script></html>`;

async function serve() {
    const publicRoot = resolve(root, 'public');
    const server = createServer(async (request, response) => {
        try {
            const url = new URL(request.url, 'http://localhost');
            if (url.pathname === '/__parameters' || url.pathname === '/__rotated') {
                response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                response.end(url.pathname === '/__rotated' ? homeHarness : harness); return;
            }
            if (url.pathname === '/api/get_model_score_configurations') {
                let body = '';
                for await (const chunk of request) body += chunk;
                const { modelIDs } = JSON.parse(body);
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ displayPolicy: AA_DISPLAY_RESTRICTION, omittedConfigurations: [],
                    configurations: models.filter(model => modelIDs.includes(model.modelID)).map(model => ({
                    modelID: model.modelID, modelName: model.modelName, configurationName: 'Recorded run',
                    scoreFields: model.condition.scoreFields, scoreCount: 1, scoreGroups: [{ benchmarkID: 1,
                        benchmarkName: 'Fixture benchmark', benchmarkConditionID: 101, benchmarkConditionName: 'Default',
                        benchmarkConditionIsDefault: true, usesPercentageScale: true, medianRawScore: 80,
                        medianNormalizedScore: 80, sampleCount: 1, distinctScoreCount: 1 }]
                })) })); return;
            }
            const file = resolve(publicRoot, '.' + decodeURIComponent(url.pathname));
            if (!file.startsWith(publicRoot + sep)) { response.writeHead(403); response.end(); return; }
            const body = await readFile(file);
            response.writeHead(200, { 'content-type': ({ '.js': 'text/javascript', '.css': 'text/css',
                '.woff2': 'font/woff2', '.svg': 'image/svg+xml' })[extname(file)] ?? 'application/octet-stream' });
            response.end(body);
        } catch { response.writeHead(404); response.end(); }
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(done => server.close(done)) };
}

async function edges(region) {
    return region.evaluate(node => ({ left: node.classList.contains('can-scroll-left'),
        right: node.classList.contains('can-scroll-right'), position: node.scrollLeft,
        maximum: node.scrollWidth - node.clientWidth, mask: getComputedStyle(node).maskImage }));
}

async function waitEdges(page, region, left, right) {
    await page.waitForFunction(({ node, left, right }) => node.classList.contains('can-scroll-left') === left
        && node.classList.contains('can-scroll-right') === right, { node: await region.elementHandle(), left, right });
}

async function swipe(page, region) {
    const box = await region.boundingBox();
    const session = await page.context().newCDPSession(page);
    const x = box.x + box.width - 10, y = box.y + box.height / 2;
    try {
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (let step = 1; step <= 6; step++) {
            await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - step * Math.min(22, (box.width - 20) / 6), y }] });
        }
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally { await session.detach(); }
    await page.waitForFunction(node => node.scrollLeft > 0, await region.elementHandle());
}

async function rowGeometry(page) {
    return page.locator('.bp-model-row').evaluateAll(rows => rows.map(row => {
        const identity = row.querySelector('.bp-model-name-wrap'), pie = row.querySelector('.bp-model-coverage');
        const name = row.querySelector('.bp-model-name'), region = row.querySelector('.bp-model-parameters');
        const box = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
        return { identity: box(identity), pie: box(pie), name: box(name), region: box(region),
            pieLast: identity.lastElementChild === pie, pieMask: getComputedStyle(pie).maskImage,
            pieShrink: getComputedStyle(pie).flexShrink, scoreInTrack: row.querySelector('.bp-model-score').parentElement.matches('.bp-score-track'),
            track: box(row.querySelector('.bp-score-track')), rowOverflow: row.scrollWidth > row.clientWidth + 1,
            fontSizes: [...region.querySelectorAll('.bp-model-display-parameter > span')].map(node => getComputedStyle(node).fontSize),
            iconWidths: [...region.querySelectorAll('.bp-model-display-parameter > i')].map(node => node.getBoundingClientRect().width),
            firstIcon: box(region.querySelector('i')) };
    }));
}

export async function runParameterOverflowBrowserQA({ output = resolve(tmpdir(), 'benchpoll-parameter-overflow') } = {}) {
    await mkdir(output, { recursive: true });
    const app = await serve();
    const browser = await chromium.launch({ headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    const results = [];
    try {
        for (const width of [1440, 390, 320]) {
            const context = await browser.newContext({ viewport: { width, height: 960 }, hasTouch: width < 500, reducedMotion: 'reduce' });
            const page = await context.newPage(), errors = [];
            page.setDefaultTimeout(10000);
            page.on('pageerror', error => errors.push(error.message));
            try {
                await page.goto(app.url + '/__parameters');
                await page.waitForFunction(() => Boolean(window.qa));
                await page.evaluate(() => document.fonts.ready);
                const rows = page.locator('.bp-model-row'), region = rows.first().locator('.bp-model-parameters');
                await waitEdges(page, region, false, true);
                const short = rows.nth(1).locator('.bp-model-parameters');
                await waitEdges(page, short, false, false);
                assert.equal((await edges(short)).mask, 'none');
                const before = await rowGeometry(page);
                for (const row of before) {
                    assert.deepEqual(row.fontSizes, ['11px', '11px']);
                    assert.ok(row.iconWidths.every(value => Math.abs(value - 12) < .1));
                    assert.ok(row.firstIcon.left >= row.region.left && row.firstIcon.right <= row.region.right, 'The leading parameter icon is fully visible');
                    assert.equal(row.pieLast, true);
                    assert.equal(row.pieMask, 'none');
                    assert.equal(row.pieShrink, '0');
                    assert.equal(row.pie.width, 16); assert.equal(row.pie.height, 16);
                    assert.ok(row.pie.right <= row.identity.right + 1, 'Coverage never leaves the identity row');
                    assert.ok(row.pie.left - row.name.right >= 6 && row.pie.left - row.name.right <= 8,
                        'Coverage follows the label with the normal gap');
                    assert.ok(row.name.right <= row.pie.left - 6, 'Parameters cannot overlap coverage');
                    assert.ok(row.track.top >= row.identity.bottom - 1, 'Scores stay below the identity row');
                    assert.equal(row.scoreInTrack, true);
                    assert.equal(row.rowOverflow, false);
                }
                assert.equal(await rows.first().locator('.bp-model-display-name').evaluate(node =>
                    node.scrollWidth > node.clientWidth + 1), false, 'Ordinary model names use the available space before clipping');
                assert.ok(Math.abs(before[0].pie.right - before[0].identity.right) < 1, 'Long scrolling parameters place coverage at the far edge');
                assert.ok(before[1].pie.right < before[1].identity.right - 6, 'Short labels do not push coverage to the far edge');
                assert.deepEqual(await region.locator('.bp-model-display-parameter').evaluateAll(nodes => nodes.map(node => node.dataset.tooltip)),
                    [`Reasoning effort: ${longValues[0]}`, `Agent harness: ${longValues[1]}`]);
                await region.hover(); await page.mouse.wheel(180, 0);
                await waitEdges(page, region, true, true);
                assert.equal(await page.evaluate(() => activations), 0);
                await region.focus(); await page.keyboard.press('End');
                await waitEdges(page, region, true, false);
                await page.mouse.move(0, 0);
                await page.keyboard.press('Escape');
                await page.screenshot({ path: resolve(output, `ranking-${width}-end.png`), fullPage: true });
                await page.keyboard.press('Home');
                await waitEdges(page, region, false, true);
                await page.keyboard.press('Enter');
                assert.equal(await page.evaluate(() => activations), 0, 'Focused scrolling region is not the ranking button');
                if (width < 500) {
                    await swipe(page, region);
                    assert.equal(await page.evaluate(() => activations), 0, 'Touch scrolling never opens the score dialog');
                }
                const after = await rowGeometry(page);
                assert.deepEqual(after.map(row => row.pie), before.map(row => row.pie), 'Scrolling cannot move or shrink coverage');
                await region.evaluate(node => { node.scrollLeft = 0; });
                await waitEdges(page, region, false, true);
                await page.mouse.move(0, 0);
                await page.keyboard.press('Escape');
                await page.evaluate(() => document.activeElement?.blur());
                await page.screenshot({ path: resolve(output, `ranking-${width}.png`), fullPage: true });
                const probe = page.locator('#resize-probe .bp-model-parameters');
                await waitEdges(page, probe, false, true);
                await page.locator('#resize-probe').evaluate(node => { node.style.width = '100%'; });
                await waitEdges(page, probe, false, false);
                assert.equal((await edges(probe)).mask, 'none', 'ResizeObserver clears masks once content fits');
                await region.click({ position: { x: 18, y: 8 } });
                assert.equal(await page.evaluate(() => activations), 1, 'Ordinary parameter clicks still open scores');
                const titleRegion = page.locator('#model-scores-title .bp-model-parameters');
                await waitEdges(page, titleRegion, false, true);
                await titleRegion.focus(); await page.keyboard.press('End');
                await waitEdges(page, titleRegion, true, false);
                await page.getByRole('button', { name: 'All scores', exact: true }).click();
                const configuration = page.locator('.bp-model-score-configuration');
                await configuration.waitFor();
                const scoreRegion = configuration.locator('.bp-model-parameters');
                await waitEdges(page, scoreRegion, false, true);
                await scoreRegion.hover(); await page.mouse.wheel(160, 0);
                await waitEdges(page, scoreRegion, true, true);
                await scoreRegion.focus(); await page.keyboard.press('End');
                await waitEdges(page, scoreRegion, true, false);
                assert.equal(await configuration.evaluate(node => node.open), false, 'Scrolling does not activate the disclosure');
                assert.deepEqual(await scoreRegion.locator('.bp-model-display-parameter > span').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).fontSize)), ['11px', '11px']);
                await page.keyboard.press('Home');
                await waitEdges(page, scoreRegion, false, true);
                await page.keyboard.press('Enter');
                await page.keyboard.press('Space');
                assert.equal(await configuration.evaluate(node => node.open), false, 'Focused scrolling region is not the disclosure trigger');
                if (width < 500) {
                    await swipe(page, scoreRegion);
                    assert.equal(await configuration.evaluate(node => node.open), false);
                }
                await page.locator('#model-scores-search').fill('Agent harness');
                await page.waitForFunction(() => document.getElementById('model-scores-list').getAttribute('aria-busy') === 'false');
                assert.equal(await page.locator('.bp-model-score-configuration:not([hidden])').count(), 1, 'Search retains tooltip-only field names');
                await page.screenshot({ path: resolve(output, `scores-${width}.png`), fullPage: true });
                const overflow = await page.evaluate(() => ({ document: document.documentElement.scrollWidth > innerWidth + 1,
                    elements: [...document.querySelectorAll('#model-scores-title, .bp-model-configuration-heading, #model-scores-list')]
                        .filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.id || node.className) }));
                assert.deepEqual(overflow, { document: false, elements: [] });
                const names = await page.evaluate(async () => {
                    const results = [];
                    for (const keys of [['model'], ['model', 'field:20', 'field:1']]) {
                        for (const text of ['Gemini 4 Argon', 'claude-fable-5-1', 'A long model name with many words and version details', 'W'.repeat(90)]) {
                            window.qa.models[0].name = window.qa.models[0].modelName = text;
                            window.qa.state.comparison.keys = keys;
                            window.qa.state.rankingVersion++;
                            window.qa.rows.renderModels();
                            await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
                            const row = document.querySelector('.bp-model-row');
                            const name = row.querySelector('.bp-model-display-name');
                            const css = getComputedStyle(name);
                            results.push({ text, keys, whitespace: css.whiteSpace,
                                height: name.getBoundingClientRect().height, lineHeight: parseFloat(css.lineHeight),
                                overflowing: name.scrollWidth > name.clientWidth + 1, mask: css.maskImage,
                                rowOverflow: row.scrollWidth > row.clientWidth + 1 });
                        }
                    }
                    return results;
                });
                for (const name of names) {
                    assert.equal(name.whitespace, 'nowrap', JSON.stringify(name));
                    assert.ok(name.height <= name.lineHeight + 1, JSON.stringify(name));
                    assert.equal(name.rowOverflow, false);
                    if (name.overflowing) assert.notEqual(name.mask, 'none', JSON.stringify(name));
                }
                await page.goto(app.url + '/__rotated');
                await page.waitForFunction(() => Boolean(window.qa));
                await page.evaluate(() => document.fonts.ready);
                assert.equal(await page.locator('#rotated > span').count(), 3);
                assert.equal(await page.locator('#rotated .bp-model-parameters').count(), 0);
                assert.deepEqual(await page.locator('#rotated .bp-model-display-parameter > span').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).fontSize)), ['11px', '11px']);
                assert.notEqual(await page.locator('#rotated').evaluate(node => getComputedStyle(node).transform), 'none');
                assert.equal(await page.locator('#rotated .bp-model-display-parameter').last().getAttribute('data-tooltip'), `Agent harness: ${longValues[1]}`);
                await page.screenshot({ path: resolve(output, `rotated-${width}.png`), fullPage: true });
                assert.deepEqual(errors, []);
                results.push({ width, passed: true, ranking: before, scroll: after[0].region });
                console.log(`PASS parameter scroll, coverage, scores and rotated labels at ${width}px`);
            } catch (error) {
                await page.screenshot({ path: resolve(output, `failure-${width}.png`), fullPage: true });
                console.error({ width, errors });
                throw error;
            } finally { await context.close(); }
        }
        await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
        return { output, cases: results.length, viewports: results.map(result => result.width) };
    } finally { await browser.close(); await app.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    console.log(JSON.stringify(await runParameterOverflowBrowserQA(), null, 2));
}
