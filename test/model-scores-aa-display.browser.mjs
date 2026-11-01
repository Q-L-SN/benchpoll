import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
import { AA_DISPLAY_RESTRICTION, isAACondition } from '../public/js/shared/aa-ranking-policy.js';
import { aaResultReason } from '../aa-archive-policy.js';
import { scoreEvidenceHash } from '../score-evidence.js';
import { fields, high, low, scale, resultRow, mixedRows, scoreAPI } from './helpers/model-scores-aa-display.mjs';

const output = resolve('D:/Codex-artifacts/website1/model-scores-aa-display-20261031');
await mkdir(output, { recursive: true });
const app = await startPreview();
const browser = await chromium.launch({ headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
const configs = page => page.locator('.bp-model-score-configuration');
const versions = page => page.locator('.bp-model-configuration-evidence > details');
const search = page => page.locator('#model-scores-search');
const notice = page => page.locator(`[data-display-restriction="${AA_DISPLAY_RESTRICTION}"]`);
const summary = page => page.locator('#model-scores-summary');
const indexPath = '/get_model_score_configurations', sourcePath = '/get_approved_benchmark_results';
let passed = 0;

function harness(comparison, evidenceHash) {
    return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Score display policy QA</title>
${['global', 'ui/tokens', 'ui/shell', 'ui/workspace', 'ui/evidence', 'workspace-layout', 'model-comparison', 'site-palette', 'typography']
        .map(name => `<link rel="stylesheet" href="/css/${name}.css">`).join('')}
<link rel="stylesheet" href="/vendor/fontawesome/css/all.min.css">
<body class="bp-home"><button id="workspace-refresh">Refresh</button>
<global-dialog id="model-scores-dialog" class="bp-model-scores-dialog" hidden>
<div id="model-scores-title" slot="title"></div><div slot="body" class="bp-model-scores-body">
<div id="model-scores-summary" class="bp-model-scores-summary"></div><div class="bp-model-evidence-toolbar">
<div id="model-scores-change-controls" hidden></div><label class="bp-model-scores-search"><input id="model-scores-search" type="search"></label></div>
<div id="model-scores-list" class="bp-model-scores-list" aria-live="polite"></div></div></global-dialog>
<script type="module">
import '/js/global.js';
import { createModelScoresView } from '/js/workspace/model-scores.js';
const model = { ID: 71, modelID: 71, modelName: 'Evidence Model', name: 'Evidence Model',
    condition: { scoreFields: ${JSON.stringify(high)} }, lower: 70, coverage: 100, missingWeight: 0,
    calculationScores: [{ conditionID: 10, normalizedScore: 70, fallbackFor: null, effectiveWeight: 100,
        contribution: 70, matchedCount: null, memberIDs: [71], memberEvidence: [{ ID: 71, hash: ${JSON.stringify(evidenceHash)} }] }] };
const state = { authenticated: false, userID: null, loadSequence: 1,
    comparison: { fields: ${JSON.stringify(fields)}, models: [{ ID: 71, name: 'Evidence Model' }], ...${JSON.stringify(comparison)} },
    benchmarkDetailsByID: new Map([[10, { benchmarkID: 1, conditionID: 10, name: 'Mathematics', conditionName: 'Official' }]]),
    personalEntries: [], publicEntries: [] };
const view = createModelScoresView({ state, modelScoresDialog: document.getElementById('model-scores-dialog'),
    modelScoresTitle: document.getElementById('model-scores-title'), modelScoresSummary: document.getElementById('model-scores-summary'),
    modelScoresList: document.getElementById('model-scores-list'), getMemberURL: item => '/benchmark/' + item.benchmarkID + '/' + item.conditionID });
window.qa = { state, model, view }; view.openApprovedModelResults(model);
</script></html>`;
}

async function run(name, rows, check, { width = 1440, comparison = { mode: 'best', keys: ['model'] }, index, sources } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    const errors = [], requests = [], api = scoreAPI(rows);
    const evidenceHash = scoreEvidenceHash(scale, rows.filter(row => row.benchmarkConditionID === 10
        && JSON.stringify(row.scoreFields) === JSON.stringify(high) && !isAACondition(row)
        && !aaResultReason({ ...row, source_url: row.sourceURL, source_title: row.sourceTitle }, undefined, fields)));
    const controls = { index, sources };
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/__model-aa', route => route.fulfill({ contentType: 'text/html', body: harness(comparison, evidenceHash) }));
    await page.route('**/api/get_*', async route => {
        const path = new URL(route.request().url()).pathname.replace(/^\/api/, '');
        if (![indexPath, sourcePath].includes(path)) return route.fallback();
        const body = route.request().postDataJSON();
        requests.push({ path, body });
        try {
            let payload = await api.request(path, body);
            const transform = path === indexPath ? controls.index : controls.sources;
            if (transform) payload = await transform(payload, body);
            await route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
        } catch (error) {
            await route.fulfill({ status: error.status ?? 500, contentType: 'application/json',
                body: JSON.stringify(error.body ?? { error: String(error) }) });
        }
    });
    try {
        await page.goto(app.url + '/__model-aa');
        await page.waitForFunction(() => Boolean(window.qa));
        await check({ page, controls, requests, evidenceHash });
        assert.deepEqual(errors, []);
        passed++;
        console.log('PASS ' + name);
    } catch (error) {
        await page.screenshot({ path: resolve(output, name + '-failure.png'), fullPage: true });
        throw error;
    } finally { await context.close(); }
}

async function allScores(page) {
    await page.getByRole('button', { name: 'All scores', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('model-scores-list').getAttribute('aria-busy') === 'false');
}

async function assertNotice(page, visible = true) {
    assert.equal(await notice(page).count(), visible ? 1 : 0);
    if (!visible) return;
    assert.equal(await notice(page).textContent(), 'Artificial Analysis benchmarks and scores are hidden to respect their data-use terms.');
    assert.equal(await notice(page).evaluate(node => node === node.parentElement.lastElementChild), true);
    assert.equal(await notice(page).isVisible(), true);
}

try {
    for (const width of [1440, 390, 320]) await run('mixed-' + width, mixedRows(), async ({ page, requests }) => {
        await allScores(page);
        assert.equal(await configs(page).count(), 1);
        assert.equal(await summary(page).textContent(), '1 recorded configurations, 4 approved scores');
        await configs(page).first().locator(':scope > summary').click();
        assert.equal(await versions(page).count(), 2);
        assert.doesNotMatch(await page.locator('#model-scores-list').textContent(), /AA-Intelligence|Recorded run|CDN release/);
        await assertNotice(page);
        const official = page.locator('.bp-model-configuration-evidence > [data-condition-id="10"]');
        await official.locator(':scope > summary').click();
        await official.locator('.bp-model-score-sample').first().waitFor();
        assert.equal(await official.locator('.bp-model-score-sample').count(), 3);
        assert.equal(await official.locator('.bp-model-score-detail-value').textContent(), '70%');
        assert.deepEqual(await official.locator('.bp-model-score-source').evaluateAll(nodes => nodes.map(node => node.getAttribute('href'))),
            Array(3).fill('https://example.org/independent'));
        assert.equal(requests.filter(request => request.path === sourcePath).length, 1);
        await page.screenshot({ path: resolve(output, 'mixed-' + width + '.png'), fullPage: true });
        for (const query of ['AA', 'AA-Intelligence', 'Recorded run']) {
            await search(page).fill(query);
            assert.equal(await configs(page).filter({ visible: true }).count(), 0);
            assert.equal(await page.getByText('No matching configurations or benchmark versions.', { exact: true }).isVisible(), true);
            await assertNotice(page);
        }
        await page.screenshot({ path: resolve(output, 'search-aa-' + width + '.png'), fullPage: true });
        await search(page).fill('Independent v2');
        assert.equal(await versions(page).filter({ visible: true }).count(), 1);
        await search(page).fill('');
        assert.equal(await versions(page).count(), 2);
        assert.equal(requests.filter(request => request.path === sourcePath).length, 1, 'Search cannot trigger source reads');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    }, { width });

    for (const [name, rows, omitted, count] of [['empty', [], false, 0],
        ['restricted-only', [resultRow(1, { conditionKey: 'aa-hidden' })], true, 0],
        ['independent-only', [resultRow(1)], false, 1]]) await run(name, rows, async ({ page }) => {
        await allScores(page);
        assert.equal(await configs(page).count(), count);
        await assertNotice(page, omitted);
        await search(page).fill('AA');
        assert.equal(await configs(page).filter({ visible: true }).count(), 0);
        await assertNotice(page, omitted);
    });

    const unrelated = [resultRow(1), resultRow(2, { scoreFields: low, conditionKey: 'aa-hidden' }),
        resultRow(3, { scoreFields: [{ fieldID: 20, value: 3 }, { fieldID: 21, value: 'Codex' }], conditionKey: 'aa-excluded' }),
        resultRow(4, { scoreFields: [{ fieldID: 21, value: 'Codex' }], conditionKey: 'aa-missing-effort' }),
        resultRow(5, { scoreFields: [{ fieldID: 20, value: null }, { fieldID: 21, value: 'Codex' }], conditionKey: 'aa-empty-effort' })];
    for (const comparison of [{ mode: 'best', keys: ['model', 'field:20', 'field:21'] },
        { mode: 'matched', keys: ['model'], filters: [{ key: 'field:20', operator: 'eq', value: 1 },
            { key: 'field:21', operator: 'eq', value: 'Codex' }] }]) {
        await run('restricted-fields-' + comparison.mode, unrelated, async ({ page }) => {
            await allScores(page);
            assert.equal(await configs(page).count(), 1);
            assert.equal(await summary(page).textContent(), '1 recorded configurations, 1 approved scores');
            await assertNotice(page, false);
            await search(page).fill('AA');
            await assertNotice(page, false);
        }, { comparison });
    }

    await run('cached-restricted-versions', [resultRow(1)], async ({ page, requests }) => {
        await allScores(page);
        await configs(page).first().locator(':scope > summary').click();
        await versions(page).first().locator(':scope > summary').click();
        await page.locator('.bp-model-score-sample').first().waitFor();
        assert.equal(await versions(page).count(), 1);
        assert.equal(await summary(page).textContent(), '1 recorded configurations, 1 approved scores');
        await assertNotice(page);
        await versions(page).first().locator(':scope > summary').click();
        await versions(page).first().locator(':scope > summary').click();
        assert.equal(requests.filter(request => request.path === sourcePath).length, 1);
        assert.equal(await page.locator('.bp-model-score-sample').count(), 1);
        await search(page).fill('AA');
        assert.equal(await configs(page).filter({ visible: true }).count(), 0);
        await assertNotice(page);
    }, { sources: payload => ({ ...payload, scoreGroups: [...payload.scoreGroups,
        { ...payload.scoreGroups[0], benchmarkConditionID: 11, conditionKey: 'aa-cached', benchmarkConditionName: 'Cached run' },
        { ...payload.scoreGroups[0], benchmarkConditionID: 12, benchmarkName: 'AA-Cached' },
        { ...payload.scoreGroups[0], benchmarkConditionID: 13, benchmarkConditionName: 'Artificial Analysis cached' },
        { ...payload.scoreGroups[0], benchmarkConditionID: 14, displayRestriction: AA_DISPLAY_RESTRICTION },
        { ...payload.scoreGroups[0], benchmarkConditionID: 15, scoreSource: 'Artificial Analysis' },
        { ...payload.scoreGroups[0], benchmarkID: 1687, benchmarkConditionID: 9399,
            conditionKey: 'crawl-6c6f1535abb4a0c68af896bc' }] }) });

    await run('unversioned-source-rejected', mixedRows(), async ({ page, controls }) => {
        await allScores(page);
        await configs(page).first().locator(':scope > summary').click();
        await page.locator('.bp-model-configuration-evidence > [data-condition-id="10"] > summary').click();
        await page.getByText('Approved scores could not be loaded.', { exact: true }).waitFor();
        assert.equal(await page.locator('.bp-model-score-sample').count(), 0);
        controls.sources = undefined;
        await page.getByRole('button', { name: 'Retry', exact: true }).click();
        await page.locator('.bp-model-score-sample').first().waitFor();
        assert.equal(await page.locator('.bp-model-score-sample').count(), 3);
    }, { sources: payload => { delete payload.displayPolicy; return payload; } });

    await run('unversioned-index-rejected', mixedRows(), async ({ page }) => {
        await page.getByRole('button', { name: 'All scores', exact: true }).click();
        await page.getByText('All scores could not be loaded.', { exact: true }).waitFor();
        assert.equal(await configs(page).count(), 0);
        assert.equal(await page.locator('.bp-model-score-sample').count(), 0);
    }, { index: payload => { delete payload.displayPolicy; return payload; } });

    await run('lazy-all-restricted', [resultRow(1)], async ({ page }) => {
        await allScores(page);
        await configs(page).first().locator(':scope > summary').click();
        await versions(page).first().locator(':scope > summary').click();
        await page.waitForFunction(() => document.getElementById('model-scores-summary').textContent === '0 recorded configurations, 0 approved scores');
        assert.equal(await configs(page).count(), 0);
        await assertNotice(page);
        await search(page).fill('AA');
        await assertNotice(page);
    }, { sources: payload => ({ ...payload, displayRestriction: AA_DISPLAY_RESTRICTION, scoreGroups: [] }) });

    await run('ranking-evidence-contract', mixedRows(), async ({ page, requests, evidenceHash }) => {
        await page.locator('.bp-model-configuration-link').click();
        await page.locator('.bp-model-score-sample').first().waitFor();
        assert.equal(await page.locator('.bp-model-score-sample').count(), 3);
        assert.deepEqual(requests.at(-1).body.expectedEvidence, { conditionID: 10, hash: evidenceHash });
        await assertNotice(page, false);
        await allScores(page);
        assert.equal(await summary(page).textContent(), '1 recorded configurations, 4 approved scores');
        assert.equal(await page.locator('.bp-model-score-sample').count(), 0);
        await assertNotice(page);
    });
    console.log(JSON.stringify({ passed, output }));
} finally {
    await browser.close();
    await app.close();
}
