import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const output = process.env.COVERAGE_PREVIEW_OUTPUT || '/workspace/benchpoll-work/coverage-preview';
const publicRoot = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const fixture = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/vendor/fontawesome/css/all.min.css"><link rel="stylesheet" href="/css/global.css">
<link rel="stylesheet" href="/css/ui/tokens.css"><link rel="stylesheet" href="/css/ui/workspace.css">
<link rel="stylesheet" href="/css/ui/evidence.css"><link rel="stylesheet" href="/css/ui/chart-workspace.css"><link rel="stylesheet" href="/css/site-palette.css">
<style>body{margin:0;padding:20px;font-family:Arial,sans-serif}.layout{display:flex;gap:24px;max-width:100%}.bp-pie-card{width:500px;flex-shrink:0}.rows{width:300px}.rows>div{padding:25px;margin-bottom:12px;background:#eee;cursor:pointer}.reference{position:absolute;left:-10000px;width:500px;height:500px}@media(max-width:600px){body{padding:10px}.layout{display:block}.bp-pie-card{width:100%}.rows{width:100%}}</style>
<script type="module" src="/js/global.js"></script></head><body>
<main class="layout"><div class="bp-pie-card"><div class="bp-pie-stage"><svg id="weight-pie"></svg></div></div><div class="rows"><div id="row-a">Model A</div><div id="row-b">Model B</div></div></main>
<div class="reference"><svg id="reference" style="width:100%;height:100%"></svg></div>
<global-dialog id="model-scores-dialog" class="bp-model-scores-dialog" hidden><div id="model-scores-title" slot="title">Scores</div>
<div slot="body" class="bp-model-scores-body"><div id="model-scores-summary" class="bp-model-scores-summary"></div>
<div class="bp-model-evidence-toolbar"><div id="model-scores-change-controls" hidden></div><label><input id="model-scores-search" type="search"></label></div>
<div id="model-scores-list" class="bp-model-scores-list"></div></div><div slot="actions"><global-dialog-action class="dialog-close-button">Close</global-dialog-action></div></global-dialog>
</body></html>`;
let browser, server, url;

before(async () => {
    await mkdir(output, { recursive: true });
    server = createServer(async (request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (pathname === '/__coverage') { response.writeHead(200, { 'content-type': 'text/html' }); response.end(fixture); return; }
        if (pathname.startsWith('/api/')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); return; }
        const path = resolve(publicRoot, `.${pathname}`);
        if (!path.startsWith(publicRoot + sep)) { response.writeHead(404); response.end(); return; }
        try {
            const data = await readFile(path);
            response.writeHead(200, { 'content-type': ({ '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' })[extname(path)] || 'application/octet-stream' });
            response.end(data);
        } catch { response.writeHead(404); response.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true,
        ...(process.env.COVERAGE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COVERAGE_CHROMIUM_EXECUTABLE } : {}) });
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

async function setup(t, width = 1360) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
    await page.goto(url + '/__coverage');
    await page.waitForFunction(() => customElements.get('global-dialog'));
    await page.evaluate(async () => {
        await customElements.whenDefined('global-dialog');
        const { createPieRenderer } = await import('/js/workspace/pie-renderer.js');
        const { createModelCoveragePreview } = await import('/js/workspace/model-coverage-preview.js');
        const { mergeBenchmarkWeights } = await import('/js/workspace/expanded-weights.js');
        const { createModelScoresView } = await import('/js/workspace/model-scores.js');
        const state = { authenticated: false, userID: null, mode: 'public', categoryID: 1, selectedContextValues: {},
            scoreMode: 'range', selectedObjectID: -10, selectedFamilyKey: 'original', workspaceView: 'focus', topicsExpanded: false,
            loadSequence: 1, rankingVersion: 1, comparison: { keys: ['model'], fields: [] },
            limits: { totalBasisPoints: 10000 }, pieOrderByObjectID: new Map([[11, 0], [21, 1], [31, 2]]),
            visualPieWeights: new Map(), visualPieEntries: new Map(), pieAnimationFrame: null,
            benchmarkDetailsByID: new Map(), personalEntries: [], publicEntries: [] };
        const entry = (conditionID, benchmarkID, weightBasisPoints, name) =>
            ({ ID: conditionID, conditionID, benchmarkID, weightBasisPoints, name, conditionName: 'Default' });
        const expanded = [entry(11, 1, 2500, 'Alpha test'), entry(12, 1, 1500, 'Alpha test'),
            entry(21, 2, 3000, 'Beta test'), entry(31, 3, 3000, 'Gamma test')];
        const original = [{ type: 'topic', conditionID: -10, name: 'Nested topic', weightBasisPoints: 7000 }, expanded[3]];
        state.publicEntries = original;
        state.benchmarkDetailsByID.set(11, expanded[0]);
        const adopted = (conditionID, weightBasisPoints, coveredWeightBasisPoints, normalizedScore) =>
            ({ conditionID, weightBasisPoints, coveredWeightBasisPoints, normalizedScore, coverage: coveredWeightBasisPoints / weightBasisPoints * 100 });
        const modelA = { ID: 1, name: 'Model A', lower: 50, upper: 50, coverage: 55, missingWeight: 45, availableInference: null,
            inferredScores: [], calculationScores: [{ conditionID: 11, fallbackFor: null, normalizedScore: 68.5,
                effectiveWeight: 25, contribution: 17.125, matchedCount: null, memberIDs: [1], memberWeights: [{ ID: 1, weight: 1 }],
                memberEvidence: [{ ID: 1, hash: 'a'.repeat(64) }] }],
            members: [{ ID: 1, modelID: 1, name: 'Model A', condition: { scoreFields: [] } }],
            coverageEntries: [adopted(11, 2500, 2500, 68.5), adopted(12, 1500, 0, null),
                adopted(21, 3000, 0, null), adopted(31, 3000, 3000, 0)] };
        const modelB = { ...modelA, ID: 2, name: 'Model B',
            coverageEntries: [adopted(11, 2500, 0, null), adopted(12, 1500, 1500, 90),
                adopted(21, 3000, 3000, 80), adopted(31, 3000, 0, null)] };
        const pieSvg = document.querySelector('#weight-pie');
        const renderer = createPieRenderer({ state, pieSvg, orderedPieEntries: values => values,
            currentPieEntries: () => original, selectedObjectIndex: entries => entries.findIndex(item => item.conditionID === state.selectedObjectID),
            renderInlineFallback() {}, fallbackRuleFor: () => null, publicFallbackRuleFor: () => null, onSelect() {} });
        renderer.renderPie();
        const referenceState = { ...state, selectedObjectID: null, visualPieWeights: new Map(), visualPieEntries: new Map(), pieAnimationFrame: null };
        const reference = createPieRenderer({ state: referenceState, pieSvg: document.querySelector('#reference'),
            orderedPieEntries: values => values, currentPieEntries: () => mergeBenchmarkWeights(expanded), selectedObjectIndex: () => -1,
            renderInlineFallback() {}, fallbackRuleFor: () => null, publicFallbackRuleFor: () => null, onSelect() {} });
        reference.renderPie();
        const preview = createModelCoveragePreview({ state, pieSvg, getExpandedEntries: () => expanded });
        preview.bindRow(document.querySelector('#row-a'), modelA);
        preview.bindRow(document.querySelector('#row-b'), modelB);
        const view = createModelScoresView({ state, modelScoresDialog: document.querySelector('#model-scores-dialog'),
            modelScoresTitle: document.querySelector('#model-scores-title'), modelScoresSummary: document.querySelector('#model-scores-summary'),
            modelScoresList: document.querySelector('#model-scores-list'), getMemberURL: () => '/contribute', coveragePreview: preview });
        window.coverageQA = { state, expanded, original, modelA, modelB, preview, renderer, referenceState, view,
            visualWeights: state.visualPieWeights, visualEntries: state.visualPieEntries,
            requests: [],
            slowPreview() {
                return createModelCoveragePreview({ state, pieSvg, getExpandedEntries: () => expanded,
                    resolveModel(model, { signal }) { return new Promise(resolve => window.coverageQA.requests.push({ model, signal, resolve })); } });
            },
            captureFetch() {
                const originalFetch = window.fetch;
                window.fetch = (url, options) => {
                    if (!String(url).endsWith('/get_approved_benchmark_results')) return originalFetch(url, options);
                    return new Promise(resolve => {
                        const request = { aborted: false, resolve };
                        options.signal.addEventListener('abort', () => { request.aborted = true; });
                        window.coverageQA.requests.push(request);
                    });
                };
            } };
        await document.fonts.ready;
        window.coverageQA.visualWeights = state.visualPieWeights;
        window.coverageQA.visualEntries = state.visualPieEntries;
    });
    return page;
}

test('desktop row hover expands and merges coverage, preserves label typography, and restores all original state', async t => {
    const page = await setup(t);
    const original = await page.locator('#weight-pie').innerHTML();
    await page.locator('#row-a').hover();
    await page.waitForSelector('.bp-model-coverage-overlay:not([hidden])');
    const preview = await page.evaluate(() => {
        const svg = document.querySelector('.bp-model-coverage-overlay svg');
        const blocks = [...svg.querySelectorAll('[data-object-id]')];
        const score = svg.querySelector('[data-object-id="11"] [data-label-kind="percent"]');
        const weight = document.querySelector('#reference [data-object-id="11"] [data-label-kind="percent"]');
        return { count: blocks.length, names: blocks.map(block => block.getAttribute('aria-label')),
            faded: svg.querySelector('[data-object-id="21"]').classList.contains('is-uncovered'),
            zeroCovered: !svg.querySelector('[data-object-id="31"]').classList.contains('is-uncovered'),
            score: score.textContent, fontSize: score.getAttribute('font-size'), fontWeight: score.getAttribute('font-weight'),
            sameSize: score.getAttribute('font-size') === weight.getAttribute('font-size'),
            sameWeight: score.getAttribute('font-weight') === weight.getAttribute('font-weight'),
            distinctColor: getComputedStyle(score).fill !== getComputedStyle(weight).fill,
            interactive: Boolean(svg.querySelector('[tabindex], [role="button"]')), selected: window.coverageQA.state.selectedObjectID };
    });
    assert.equal(preview.count, 3);
    assert.equal(preview.faded, true);
    assert.equal(preview.zeroCovered, true);
    assert.equal(preview.score, '68.5');
    assert.equal(preview.sameSize, true);
    assert.equal(preview.sameWeight, true);
    assert.equal(preview.distinctColor, true);
    assert.equal(preview.interactive, false);
    assert.equal(preview.selected, -10);
    await page.screenshot({ path: `${output}/desktop-coverage.png` });
    await page.mouse.move(1200, 800);
    await page.waitForSelector('.bp-model-coverage-overlay', { state: 'detached' });
    assert.equal(await page.locator('#weight-pie').innerHTML(), original);
    assert.deepEqual(await page.evaluate(() => {
        const qa = window.coverageQA;
        return [qa.state.selectedObjectID, qa.state.selectedFamilyKey, qa.state.workspaceView, qa.state.topicsExpanded,
            qa.state.visualPieWeights === qa.visualWeights, qa.state.visualPieEntries === qa.visualEntries, qa.referenceState.selectedObjectID];
    }), [-10, 'original', 'focus', false, true, true, null]);
});

test('out of order coverage requests, pointer leave and context changes cannot paint stale previews', async t => {
    const page = await setup(t);
    await page.evaluate(() => {
        const qa = window.coverageQA;
        qa.slow = qa.slowPreview();
        void qa.slow.show(qa.modelA);
        void qa.slow.show(qa.modelB);
        qa.requests[0].resolve(qa.modelA);
    });
    await page.waitForTimeout(50);
    assert.equal(await page.locator('.bp-model-coverage-overlay:not([hidden])').count(), 0);
    assert.equal(await page.evaluate(() => window.coverageQA.requests[0].signal.aborted), true);
    await page.evaluate(() => window.coverageQA.requests[1].resolve(window.coverageQA.modelB));
    await page.waitForSelector('.bp-model-coverage-overlay:not([hidden])');
    assert.equal(await page.locator('.bp-model-coverage-overlay [data-object-id="21"] [data-adopted-score]').textContent(), '80');
    await page.evaluate(() => { const qa = window.coverageQA; qa.slow.clear(); void qa.slow.show(qa.modelA); qa.state.categoryID = 2; qa.requests[2].resolve(qa.modelA); });
    await page.waitForSelector('.bp-model-coverage-overlay', { state: 'detached' });
    assert.equal(await page.locator('#weight-pie').evaluate(svg => getComputedStyle(svg).visibility), 'visible');
    await page.evaluate(() => { const qa = window.coverageQA; void qa.slow.show(qa.modelA); qa.slow.clear(); qa.requests[3].resolve(qa.modelA); });
    await page.waitForTimeout(50);
    assert.equal(await page.locator('.bp-model-coverage-overlay').count(), 0);
});

test('actual list and chart rows bind previews and expose coverage help only on the mini pie', async t => {
    const page = await setup(t);
    await page.evaluate(async () => {
        const { createModelListView } = await import('/js/workspace/model-list.js');
        const qa = window.coverageQA;
        const host = document.createElement('section');
        host.className = 'bp-right-workspace';
        host.innerHTML = '<div class="bp-model-viewport"><div id="model-ranking-status" hidden></div><div id="actual-model-rows"></div></div>';
        document.body.append(host);
        const models = [qa.modelA, qa.modelB].map((model, index) => ({ ...model, modelID: index + 1, rank: index + 1,
            condition: { scoreFields: [] }, comparable: true }));
        Object.assign(qa.state, { workspaceDisplay: 'leaderboard', modelLeaderboards: { public: models },
            rankingPageLoading: { public: false }, rankingPageError: { public: null },
            rankingPagination: { snapshotID: 'coverage-fixture', public: { hasMore: false } }, scoreMode: 'available' });
        qa.bound = 0; qa.cleaned = 0;
        qa.list = createModelListView({ state: qa.state, modelRows: host.querySelector('#actual-model-rows'),
            openApprovedModelResults: qa.view.openApprovedModelResults, onNeedMore() {},
            onBindModelRow(row, model) {
                qa.bound++;
                const cleanup = qa.preview.bindRow(row, model);
                return () => { qa.cleaned++; cleanup(); };
            } });
        qa.list.renderModels();
    });
    const rows = page.locator('#actual-model-rows .bp-model-row');
    assert.equal(await rows.count(), 2);
    assert.equal(await rows.locator('.bp-model-coverage[data-tooltip]').count(), 2);
    assert.equal(await rows.first().getAttribute('data-tooltip'), null);
    assert.equal(await rows.locator('.bp-score-track[data-tooltip]').count(), 0);
    assert.equal(await rows.locator('.bp-score-track [data-tooltip], .bp-model-score[data-tooltip]').count(), 0);
    await rows.first().locator('.bp-score-track').hover();
    await page.waitForSelector('.bp-model-coverage-overlay:not([hidden])');
    await page.evaluate(() => { const qa = window.coverageQA; qa.state.workspaceDisplay = 'charts'; qa.list.renderModels(); });
    await page.waitForSelector('.bp-model-coverage-overlay', { state: 'detached' });
    assert.equal(await page.locator('#actual-model-rows .bp-model-column').count(), 2);
    assert.equal(await page.locator('#actual-model-rows .bp-model-column[data-tooltip]').count(), 0);
    assert.deepEqual(await page.evaluate(() => [window.coverageQA.bound, window.coverageQA.cleaned]), [4, 2]);
});

test('mobile Used in this ranking shows the same treemap in a fullscreen dialog with X and aborts source reads', async t => {
    const page = await setup(t, 390);
    await page.locator('#row-a').dispatchEvent('pointerenter', { pointerType: 'touch' });
    assert.equal(await page.locator('.bp-model-coverage-overlay').count(), 0);
    await page.evaluate(() => { const qa = window.coverageQA; qa.captureFetch(); qa.view.openApprovedModelResults(qa.modelA); });
    await page.waitForSelector('.bp-model-coverage-figure svg [data-object-id="11"]');
    await page.waitForFunction(() => {
        const bounds = document.querySelector('#model-scores-dialog').shadowRoot.querySelector('[part="content"]').getBoundingClientRect();
        return Math.abs(bounds.width - innerWidth) < .01 && Math.abs(bounds.height - innerHeight) < .01;
    });
    const layout = await page.locator('#model-scores-dialog').evaluate(dialog => {
        const bounds = dialog.shadowRoot.querySelector('[part="content"]').getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
            overflow: document.documentElement.scrollWidth > innerWidth,
            score: dialog.querySelector('.bp-model-coverage-figure [data-adopted-score]').textContent };
    });
    assert.ok(Math.abs(layout.x) < .01 && Math.abs(layout.y) < .01 && Math.abs(layout.width - 390) < .01 && Math.abs(layout.height - 900) < .01);
    assert.equal(layout.overflow, false);
    assert.equal(layout.score, '68.5');
    await page.screenshot({ path: `${output}/mobile-scores-fullscreen.png` });
    await page.locator('.bp-model-configuration-link').click();
    await page.waitForFunction(() => window.coverageQA.requests.length === 1);
    await page.getByRole('button', { name: 'Close model scores', exact: true }).click();
    await page.waitForFunction(() => window.coverageQA.requests[0].aborted);
    assert.equal(await page.locator('#model-scores-dialog').isVisible(), false);
    await page.evaluate(() => { const qa = window.coverageQA; qa.view.openApprovedModelResults(qa.modelB);
        qa.requests[0].resolve(new Response('{}', { headers: { 'content-type': 'application/json' } })); });
    await page.waitForTimeout(50);
    assert.match(await page.locator('#model-scores-title').textContent(), /Model B/);
    await page.locator('.bp-model-configuration-link').click();
    await page.waitForFunction(() => window.coverageQA.requests.length === 2);
    await page.evaluate(() => { window.coverageQA.state.loadSequence++; });
    await page.waitForFunction(() => window.coverageQA.requests[1].aborted);
    assert.equal(await page.locator('#model-scores-dialog').isVisible(), false);
});
