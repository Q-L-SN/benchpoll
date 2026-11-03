import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { AA_DISPLAY_RESTRICTION } from '../public/js/shared/aa-ranking-policy.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const modelID = 71;
const configurations = ['High', 'Low', 'Medium', 'Minimal', 'Extended', 'Disabled'].map((label, index) => ({
    modelID, modelName: 'Evidence Model', configurationName: `Reasoning effort=${label}, Harness=Codex`,
    scoreFields: [{ fieldID: 20, value: index + 1 }], scoreCount: 4
}));
const beta = { ...configurations[0], modelID: 72, modelName: 'Second Model' };

function evidence(configuration) {
    const value = configuration.scoreFields[0].value;
    const groups = [[101, 'Mathematics', value === 1 ? 'v2' : 'v1'],
        [102, value === 6 ? 'Hidden Benchmark' : 'Language', value === 6 ? 'Remote 2026' : 'v10']];
    return { model: { ...configuration, vendorName: 'Evidence Lab' }, displayPolicy: AA_DISPLAY_RESTRICTION,
        displayRestriction: null, scoreGroups: groups.map(([ID, name, version], index) => {
        const raw = index ? [51] : [80, 60, 80];
        return { benchmarkID: ID - 100, benchmarkName: name, benchmarkConditionID: ID,
            benchmarkConditionName: version, benchmarkConditionIsDefault: false, usesPercentageScale: true,
            scoreMin: null, scoreMax: null, scoreDirection: 'higher', targetValue: null,
            evidenceHash: 'a'.repeat(64), sampleCount: raw.length, distinctScoreCount: index ? 1 : 2,
            medianRawScore: index ? 51 : 70, medianNormalizedScore: index ? 51 : 70,
            samples: raw.map((rawScore, sample) => ({ ID: configuration.modelID * 10000 + value * 100 + index * 10 + sample,
                rawScore, normalizedScore: rawScore, sourceURL: sample === 1 ? null : `https://example.org/evidence/${value}/${sample}`,
                sourceTitle: sample === 2 ? 'Independent report' : 'Official report with a long descriptive source title',
                sourceType: 'official', createdAt: '2026-10-22T12:00:00Z', excludedAsDuplicate: sample === 2 })) };
    }) };
}

const harness = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>All scores QA</title>
<link rel="stylesheet" href="/css/global.css"><link rel="stylesheet" href="/css/ui/tokens.css">
<link rel="stylesheet" href="/css/ui/shell.css"><link rel="stylesheet" href="/css/ui/workspace.css">
<link rel="stylesheet" href="/css/ui/evidence.css"><link rel="stylesheet" href="/css/workspace-layout.css">
<link rel="stylesheet" href="/css/model-comparison.css"><link rel="stylesheet" href="/css/site-palette.css">
<link rel="stylesheet" href="/css/typography.css">
<link rel="stylesheet" href="/vendor/fontawesome/css/all.min.css">
<body class="bp-home"><button id="workspace-refresh" type="button">Refresh</button>
<global-dialog id="model-scores-dialog" class="bp-model-scores-dialog" hidden>
<div id="model-scores-title" slot="title"></div><div slot="body" class="bp-model-scores-body">
<div id="model-scores-summary" class="bp-model-scores-summary"></div><div class="bp-model-evidence-toolbar">
<div id="model-scores-change-controls" class="bp-model-change-controls" hidden></div>
<label class="bp-model-scores-search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input id="model-scores-search" type="search"></label></div>
<div id="model-scores-list" class="bp-model-scores-list" aria-live="polite"></div></div></global-dialog>
<script type="module">
import '/js/global.js';
import { createModelScoresView } from '/js/workspace/model-scores.js';
if (new URLSearchParams(location.search).has('legacy')) {
    const control = document.createElement('button'); control.id = 'model-scores-expand';
    document.querySelector('.bp-model-evidence-toolbar').append(control);
}
const configurations = ${JSON.stringify(configurations)};
const models = [${JSON.stringify(configurations[0])}, ${JSON.stringify(beta)}].map((item, index) => ({
    ...item, ID: item.modelID, name: item.modelName, lower: 70, coverage: 100, missingWeight: 0,
    condition: { scoreFields: item.scoreFields }, calculationScores: [{ conditionID: 101, normalizedScore: 70,
        fallbackFor: null,
        effectiveWeight: 100, contribution: 70, matchedCount: null, memberIDs: [item.modelID],
        memberEvidence: [{ ID: item.modelID, hash: 'a'.repeat(64) }] }]
}));
const state = { authenticated: true, userID: '11', loadSequence: 1,
    comparison: { keys: ['model'], models: models.map(item => ({ ID: item.modelID, name: item.modelName })),
        fields: [{ ID: 20, name: 'Reasoning effort', type: 'enum', options: configurations.map((item, index) =>
            ({ ID: index + 1, label: item.configurationName.split('=')[1].split(',')[0] })) }] },
    benchmarkDetailsByID: new Map([[101, { benchmarkID: 1, conditionID: 101, name: 'Mathematics', conditionName: 'v2' }]]),
    personalEntries: [], publicEntries: [] };
const view = createModelScoresView({ state, modelScoresDialog: document.getElementById('model-scores-dialog'),
    modelScoresTitle: document.getElementById('model-scores-title'), modelScoresSummary: document.getElementById('model-scores-summary'),
    modelScoresList: document.getElementById('model-scores-list'), getMemberURL: member => '/benchmark/' + member.benchmarkID + '/' + member.conditionID,
    onInspectVersion: event => { event.preventDefault(); window.inspectedVersion = event.currentTarget.href; } });
window.qa = { state, models, view };
window.refreshes = 0;
document.getElementById('workspace-refresh').addEventListener('click', () => window.refreshes++);
view.openApprovedModelResults(models[0]);
</script></html>`;

export async function serveHarness() {
    const publicRoot = resolve(root, 'public');
    const server = createServer(async (request, response) => {
        try {
            const url = new URL(request.url, 'http://localhost');
            if (url.pathname === '/__all-scores') {
                response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(harness); return;
            }
            const path = resolve(publicRoot, '.' + decodeURIComponent(url.pathname));
            if (!path.startsWith(publicRoot + sep)) { response.writeHead(403); response.end(); return; }
            const body = await readFile(path);
            response.writeHead(200, { 'content-type': ({ '.js': 'text/javascript', '.css': 'text/css',
                '.woff2': 'font/woff2', '.svg': 'image/svg+xml' })[extname(path)] ?? 'application/octet-stream' });
            response.end(body);
        } catch { response.writeHead(404); response.end(); }
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    return { url: `http://127.0.0.1:${server.address().port}/__all-scores`,
        close: () => new Promise(done => server.close(done)) };
}

const pause = ms => new Promise(done => setTimeout(done, ms));
const configRows = page => page.locator('.bp-model-score-configuration');
const visibleConfigs = page => page.locator('.bp-model-score-configuration:not([hidden])');
const search = page => page.locator('#model-scores-search');
const groups = row => row.locator('.bp-model-configuration-evidence > .bp-model-score-detail-row');

export async function runAllScoresBrowserQA({ output = 'D:/Codex-artifacts/website1/topic-identity-ui-20261026/all-scores' } = {}) {
    output = resolve(output);
    await mkdir(output, { recursive: true });
    const app = await serveHarness();
    const browser = await chromium.launch({ headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    const results = [];
    const run = async (name, test, options = {}) => {
        const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce', ...options });
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        const errors = [], requests = [], controls = { delay: 0, failIndex: 0, failIndexIds: new Set(), failDetails: new Set(),
            badModel: false, badFields: false, badHash: false, changed: false, single: false, empty: false, badIndex: false,
            revised: false, active: 0, maxActive: 0, indexActive: 0, maxIndexActive: 0 };
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/api/**', async route => {
            const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON();
            requests.push({ path, body });
            const send = (status, payload) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) }).catch(() => {});
            if (path === '/api/get_model_score_configurations') {
                controls.indexActive++; controls.maxIndexActive = Math.max(controls.maxIndexActive, controls.indexActive);
                try {
                    await pause(controls.delay);
                    if (controls.failIndex-- > 0 || body.modelIDs.some(ID => controls.failIndexIds.has(ID))) {
                        return await send(503, { error: 'temporarily_unavailable' });
                    }
                    const records = [...(body.modelIDs.includes(71) ? configurations : []), ...(body.modelIDs.includes(72) ? [beta] : []),
                        ...body.modelIDs.filter(ID => ID !== 71 && ID !== 72).map(ID => ({ ...configurations[0], modelID: ID, modelName: `Model ${ID}` }))];
                    const selected = controls.empty ? [] : controls.single ? records.slice(0, 1) : records;
                    return await send(200, { displayPolicy: AA_DISPLAY_RESTRICTION, omittedConfigurations: [], configurations: selected.map(record => ({ ...record,
                        ...(body.includeVersions && !controls.badIndex ? { scoreGroups: evidence(record).scoreGroups.map(group => {
                            const summary = { ...group };
                            delete summary.samples;
                            delete summary.evidenceHash;
                            return summary;
                        }) } : {}) })) });
                } finally { controls.indexActive--; }
            }
            if (path === '/api/get_approved_benchmark_results') {
                controls.active++; controls.maxActive = Math.max(controls.maxActive, controls.active);
                const value = body.scoreFields[0].value;
                const record = { ...(body.modelID === 72 ? beta : configurations[value - 1]), scoreFields: body.scoreFields };
                const payload = evidence(record);
                if (controls.badModel) payload.model.modelID = 999;
                if (controls.badFields) payload.model.scoreFields = [];
                if (controls.badHash) payload.scoreGroups[0].evidenceHash = 'b'.repeat(64);
                if (controls.revised) {
                    payload.scoreGroups = payload.scoreGroups.slice(0, 1);
                    payload.scoreGroups[0].samples[1].rawScore = 50;
                    payload.scoreGroups[0].samples[1].normalizedScore = 50;
                    payload.scoreGroups[0].medianRawScore = 65;
                    payload.scoreGroups[0].medianNormalizedScore = 65;
                }
                const failed = controls.failDetails.has(value), changed = controls.changed;
                try {
                    await pause(controls.delay);
                    if (changed) return await send(409, { error: 'ranking_evidence_changed' });
                    if (failed) return await send(503, { error: 'temporarily_unavailable' });
                    return await send(200, payload);
                } finally { controls.active--; }
            }
            return send(200, {});
        });
        try {
            await page.goto(app.url);
            await page.waitForFunction(() => Boolean(window.qa));
            await test({ page, controls, requests, context });
            assert.deepEqual(errors, [], name + ': no browser exceptions');
            results.push({ name, passed: true, requests: requests.length, maxConcurrentDetails: controls.maxActive });
            console.log('PASS ' + name);
        } catch (error) {
            await page.screenshot({ path: resolve(output, name + '-failure.png'), fullPage: true });
            console.error(JSON.stringify({ name, errors, url: page.url(), body: (await page.locator('body').innerHTML()).slice(0, 1200) }));
            throw error;
        } finally { await context.close(); }
    };
    const openAll = async page => {
        await page.getByRole('button', { name: 'All scores', exact: true }).click();
        await configRows(page).first().waitFor();
    };
    const searchDone = async page => page.waitForFunction(() => document.getElementById('model-scores-list').getAttribute('aria-busy') === 'false');
    const startSources = async (page, version) => {
        const request = page.waitForRequest(request => new URL(request.url()).pathname === '/api/get_approved_benchmark_results');
        await version.locator(':scope > summary').click();
        await request;
    };
    try {
        for (const width of [1440, 390, 320]) await run('calculation-guidance-' + width, async ({ page }) => {
            await page.evaluate(() => {
                const model = window.qa.models[0];
                Object.assign(model, { lower: 60, upper: 60, coverage: 60, missingWeight: 40,
                    availableInference: { method: 'pairwise-anchored-rational-coverage-factor', inferredFraction: .3,
                        unresolvedFraction: .1, unpenalizedScore: 68, coverageFactor: 15 / 17, appliedFactor: 15 / 17 } });
                window.qa.view.openApprovedModelResults(model);
            });
            const details = page.locator('.bp-model-calculation-details');
            await details.waitFor();
            assert.equal(await details.evaluate(node => node.open), false);
            assert.equal(await details.locator('p').isVisible(), false);
            assert.match(await page.locator('#model-scores-summary').innerText(), /30.00% of the weight uses estimated results/);
            assert.match(await page.locator('#model-scores-summary').innerText(), /10.00% of the weight has no measurement or estimate/);
            await details.locator('summary').focus();
            await page.keyboard.press('Enter');
            assert.equal(await details.locator('p').isVisible(), true);
            await page.screenshot({ path: resolve(output, 'calculation-guidance-' + width + '.png'), fullPage: true });
            assert.equal(await page.locator('#model-scores-summary').evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
            await page.keyboard.press('Enter');
            assert.equal(await details.locator('p').isVisible(), false);
            await page.evaluate(() => {
                const model = window.qa.models[0];
                delete model.availableInference;
                Object.assign(model, { lower: 32, upper: 92, coverage: 40, missingWeight: 60 });
                window.qa.view.openApprovedModelResults(model);
            });
            await page.waitForFunction(() => document.getElementById('model-scores-summary').textContent.includes('Score range 32 to 92'));
            assert.equal(await details.count(), 0);
            assert.match(await page.locator('#model-scores-summary').innerText(), /not a confidence interval/);
        }, { viewport: { width, height: 900 } });

        await run('accordion-and-evidence', async ({ page, requests }) => {
            await openAll(page);
            assert.equal(await configRows(page).count(), 6);
            assert.deepEqual(requests.find(item => item.path === '/api/get_model_score_configurations').body,
                { modelIDs: [71], includeVersions: true });
            assert.equal(requests.filter(item => item.path.endsWith('get_approved_benchmark_results')).length, 0);
            const originalURL = page.url(), originalTitle = await page.locator('#model-scores-title').textContent();
            const row = configRows(page).first(), heading = row.locator(':scope > summary');
            await heading.focus(); await page.keyboard.press('Enter');
            await groups(row).first().waitFor();
            assert.equal(await row.evaluate(node => node.open), true);
            assert.equal(page.url(), originalURL);
            assert.equal(await page.locator('#model-scores-title').textContent(), originalTitle);
            assert.equal(await configRows(page).count(), 6);
            assert.equal(await page.getByRole('button', { name: 'All scores', exact: true }).getAttribute('aria-pressed'), 'true');
            const version = groups(row).first();
            assert.match(await version.textContent(), /Median of 2 distinct score values/);
            assert.equal(await version.locator('.bp-model-score-detail-value').textContent(), '70%');
            assert.equal(requests.filter(item => item.path.endsWith('get_approved_benchmark_results')).length, 0);
            await version.locator(':scope > summary').click();
            await version.locator('.bp-model-score-sample').first().waitFor();
            assert.equal(await version.locator('.bp-model-score-sample:visible').count(), 3);
            assert.equal(await version.locator('[aria-label="Why this score is counted once"]').count(), 1);
            assert.match(await version.textContent(), /No source link/);
            const source = version.locator('a.bp-model-score-source').first();
            assert.equal(await source.getAttribute('href'), 'https://example.org/evidence/1/0');
            assert.equal(await source.getAttribute('rel'), 'noopener noreferrer');
            assert.equal(await version.locator('a.bp-row-edit-action').first().getAttribute('href'), '/contribute/scores/710100/edit');
            await heading.focus(); await page.keyboard.press('Space');
            await page.waitForFunction(() => !document.querySelector('.bp-model-score-configuration').open);
            await heading.click();
            assert.equal(requests.filter(item => item.path.endsWith('get_approved_benchmark_results')).length, 1, 'Reopening uses this view cache');
            await page.screenshot({ path: resolve(output, 'desktop-evidence.png'), fullPage: true });
            const info = version.locator('.bp-benchmark-information-link');
            assert.match(await info.getAttribute('href'), /\/benchmark\/1\/101$/);
            await info.click();
            assert.equal(await page.evaluate(() => document.getElementById('model-scores-dialog').hidden), true);
            assert.match(await page.evaluate(() => window.inspectedVersion), /\/benchmark\/1\/101$/);
        });

        await run('global-search', async ({ page, controls, requests }) => {
            controls.delay = 70;
            await openAll(page);
            await search(page).fill('High'); await searchDone(page);
            assert.equal(await visibleConfigs(page).count(), 1);
            assert.equal(await visibleConfigs(page).first().evaluate(node => node.open), false);
            assert.equal(requests.filter(item => item.path.endsWith('get_approved_benchmark_results')).length, 0);
            assert.equal(await page.locator('.bp-model-score-sample').count(), 0, 'Searching unloaded configurations does not build hidden source tables');
            await search(page).fill('Remote 2026'); await searchDone(page);
            assert.equal(await visibleConfigs(page).count(), 1);
            const remote = visibleConfigs(page).first();
            assert.equal(await remote.evaluate(node => node.open), true);
            assert.match(await remote.locator(':scope > summary').textContent(), /Disabled/);
            assert.equal(await groups(remote).filter({ visible: true }).count(), 1);
            assert.match(await groups(remote).filter({ visible: true }).textContent(), /Hidden Benchmark/);
            await search(page).fill('High Mathematics v2'); await searchDone(page);
            assert.equal(await visibleConfigs(page).count(), 1);
            assert.match(await visibleConfigs(page).first().locator(':scope > summary').textContent(), /High/);
            assert.equal(await groups(visibleConfigs(page).first()).filter({ visible: true }).count(), 1);
            await search(page).fill('High'); await searchDone(page);
            assert.equal(await visibleConfigs(page).first().evaluate(node => node.open), false);
            await visibleConfigs(page).first().locator(':scope > summary').click();
            assert.equal(await visibleConfigs(page).first().evaluate(node => node.open), true, 'A cached configuration hit can be opened manually');
            assert.equal(await groups(visibleConfigs(page).first()).filter({ visible: true }).count(), 2);
            await search(page).fill('High Mathematics v1'); await searchDone(page);
            assert.equal(await visibleConfigs(page).count(), 0);
            assert.equal(await page.getByText('No matching configurations or benchmark versions.', { exact: true }).count(), 1);
            await page.getByRole('button', { name: 'Clear search', exact: true }).click();
            assert.equal(await search(page).inputValue(), '');
            assert.equal(await search(page).evaluate(node => document.activeElement === node), true);
            assert.equal(await visibleConfigs(page).count(), 6);
            assert.equal(await page.locator('.bp-model-score-configuration[open]').count(), 0);
            assert.equal(await page.locator('.bp-model-score-detail-row[hidden]').count(), 0);
            assert.ok(controls.maxActive <= 3);
            await search(page).fill('Mathematics'); await searchDone(page);
            assert.equal(await visibleConfigs(page).count(), 6, 'A common benchmark can match every configuration without truncation');
            assert.equal(await page.locator('.bp-model-score-configuration[open]').count(), 6);
            assert.equal(requests.filter(item => item.path.endsWith('get_approved_benchmark_results')).length, 0,
                'All search queries, manual configuration opening and automatic expansion require zero full-evidence reads');
        });

        await run('grouped-scope-search-and-cache', async ({ page, controls, requests }) => {
            const setGroup = async (value, multiple = false, filters = []) => page.evaluate(({ value, multiple, filters }) => {
                qa.state.comparison.mode = 'best';
                qa.state.comparison.keys = multiple ? ['field:20'] : ['model', 'field:20'];
                qa.state.comparison.filters = filters;
                const members = multiple ? qa.models : [qa.models[0]];
                const projection = multiple ? [['field:20', true, value]] : [['model', true, 71], ['field:20', true, value]];
                qa.view.openApprovedModelResults({ ...qa.models[0], members, comparisonIdentity: JSON.stringify(projection) });
            }, { value, multiple, filters });
            await setGroup(1);
            await openAll(page);
            assert.equal(await configRows(page).count(), 1);
            assert.match(await configRows(page).first().textContent(), /High/);
            await search(page).fill('Low'); await searchDone(page);
            assert.equal(await visibleConfigs(page).count(), 0);
            await search(page).fill('Mathematics v2'); await searchDone(page);
            assert.equal(await visibleConfigs(page).count(), 1);
            await groups(visibleConfigs(page).first()).first().locator(':scope > summary').click();
            await visibleConfigs(page).first().locator('.bp-model-score-sample').first().waitFor();
            await search(page).fill('');
            controls.delay = 200;
            await setGroup(2);
            await page.getByRole('button', { name: 'All scores', exact: true }).click();
            await setGroup(1, true);
            await openAll(page);
            await pause(250);
            assert.equal(await configRows(page).count(), 2, 'A parameter-only group includes matching configurations from both models');
            assert.match(await configRows(page).nth(0).textContent(), /Evidence Model/);
            assert.match(await configRows(page).nth(1).textContent(), /Second Model/);
            assert.equal(await page.locator('.bp-model-score-sample').count(), 0, 'Evidence cached in another group is not reused');
            await search(page).fill('Low'); await searchDone(page);
            assert.equal(await visibleConfigs(page).count(), 0);
            await setGroup(2, false, [{ key: 'field:20', operator: 'eq', value: 2 }]);
            await openAll(page);
            assert.equal(await configRows(page).count(), 1);
            assert.match(await configRows(page).first().textContent(), /Low/);
            assert.ok(requests.some(item => item.path.endsWith('get_model_score_configurations') && item.body.modelIDs.length === 2));
        });

        await run('legacy-control-and-title-layout', async ({ page }) => {
            await page.goto(app.url + '?legacy=1');
            await page.waitForFunction(() => Boolean(window.qa));
            assert.equal(await page.locator('#model-scores-expand').count(), 0);
            await page.evaluate(() => {
                qa.state.comparison.keys = ['model', 'field:20'];
                qa.view.openApprovedModelResults({ ...qa.models[0], comparisonIdentity: JSON.stringify([
                    ['model', true, 71], ['field:20', true, 1]
                ]) });
            });
            const layout = await page.evaluate(() => {
                const title = document.getElementById('model-scores-title');
                const toolbar = document.querySelector('.bp-model-evidence-toolbar').getBoundingClientRect();
                const search = document.querySelector('.bp-model-scores-search').getBoundingClientRect();
                const model = title.querySelector('.bp-model-display-name').getBoundingClientRect();
                const parameter = title.querySelector('.bp-model-display-parameter').getBoundingClientRect();
                return { display: getComputedStyle(title).display, alignment: getComputedStyle(title).alignItems,
                    searchWidth: search.width, toolbarWidth: toolbar.width,
                    overlap: model.right > parameter.left && model.left < parameter.right
                        && model.bottom > parameter.top && model.top < parameter.bottom };
            });
            assert.equal(layout.display, 'flex');
            assert.equal(layout.alignment, 'baseline');
            assert.ok(Math.abs(layout.searchWidth - layout.toolbarWidth) < 2);
            assert.equal(layout.overlap, false);
        });

        await run('large-group-batches-and-retry', async ({ page, controls, requests }) => {
            await page.evaluate(() => {
                qa.state.comparison.mode = 'best';
                qa.state.comparison.keys = ['field:20'];
                qa.state.comparison.filters = [];
                const members = Array.from({ length: 70 }, (_, index) => ({ ...qa.models[0], modelID: 71 + index }));
                qa.view.openApprovedModelResults({ ...qa.models[0], members,
                    comparisonIdentity: JSON.stringify([['field:20', true, 1]]) });
            });
            controls.delay = 100; controls.failIndexIds.add(103);
            await page.getByRole('button', { name: 'All scores', exact: true }).click();
            await page.getByText('All scores could not be loaded.', { exact: true }).waitFor();
            assert.equal(await configRows(page).count(), 0, 'A failed batch never exposes partial results');
            controls.failIndexIds.clear();
            await page.getByRole('button', { name: 'Retry', exact: true }).click();
            await page.waitForFunction(() => document.querySelectorAll('.bp-model-score-configuration').length === 70);
            const batches = requests.filter(item => item.path.endsWith('get_model_score_configurations'));
            assert.ok(batches.length >= 6);
            assert.ok(batches.every(item => item.body.modelIDs.length <= 32));
            assert.ok(controls.maxIndexActive <= 3);
            await search(page).fill('Model 140'); await searchDone(page);
            assert.equal(await visibleConfigs(page).count(), 1);
            assert.match(await visibleConfigs(page).first().textContent(), /Model 140/);
        });

        await run('search-browsing-restoration', async ({ page, controls, requests }) => {
            await openAll(page);
            const row = configRows(page).first();
            await row.locator(':scope > summary').click(); await groups(row).first().waitFor();
            await groups(row).first().locator(':scope > summary').click();
            await row.locator('.bp-model-score-sample').first().waitFor();
            await search(page).fill('Low'); await searchDone(page);
            assert.equal(await visibleConfigs(page).first().evaluate(node => node.open), false);
            await visibleConfigs(page).first().locator(':scope > summary').click();
            await groups(visibleConfigs(page).first()).first().waitFor();
            await search(page).fill('');
            assert.equal(await row.evaluate(node => node.open), true);
            assert.equal(await groups(row).first().evaluate(node => node.open), true);
            assert.equal(await configRows(page).nth(1).evaluate(node => node.open), false);
            controls.delay = 300;
            const before = requests.length;
            await search(page).fill('unfindable'); await search(page).fill('');
            await pause(250);
            assert.equal(requests.length, before, 'Searching and clearing never enqueue evidence');
        });

        await run('individual-disclosures-and-single', async ({ page, controls, requests }) => {
            controls.delay = 70;
            await openAll(page);
            assert.equal(await page.locator('#model-scores-expand').count(), 0);
            for (const index of [0, 1, 2, 3, 4, 5]) await configRows(page).nth(index).locator(':scope > summary').click();
            await page.waitForFunction(() => document.querySelectorAll('.bp-model-configuration-evidence > details').length === 12);
            assert.equal(await page.locator('.bp-model-score-configuration[open]').count(), 6);
            assert.ok(controls.maxActive <= 3);
            for (const index of [0, 1, 2, 3, 4, 5]) await configRows(page).nth(index).locator(':scope > summary').click();
            assert.equal(await page.locator('.bp-model-score-configuration[open]').count(), 0);
            controls.delay = 250; await openAll(page);
            const before = requests.filter(item => item.path.endsWith('get_approved_benchmark_results')).length;
            await configRows(page).first().locator(':scope > summary').click();
            await configRows(page).first().locator(':scope > summary').click();
            await pause(350);
            assert.equal(requests.filter(item => item.path.endsWith('get_approved_benchmark_results')).length - before, 0,
                'Opening and closing configurations uses version summaries only');
            assert.equal(await page.locator('.bp-model-score-sample').count(), 0);
            controls.single = true; await openAll(page);
            assert.equal(await configRows(page).count(), 1);
            assert.equal(await configRows(page).first().evaluate(node => node.open), false, 'A single configuration stays in the All scores view');
        });

        await run('pending-index-search-and-empty', async ({ page, controls }) => {
            controls.delay = 250;
            await page.getByRole('button', { name: 'All scores', exact: true }).click();
            await search(page).fill('Remote 2026');
            await configRows(page).first().waitFor({ state: 'attached' }); await searchDone(page);
            assert.equal(await visibleConfigs(page).count(), 1, 'A query typed before the configuration index arrives still searches all versions');
            controls.delay = 0; controls.empty = true;
            await page.getByRole('button', { name: 'All scores', exact: true }).click();
            await page.getByText('No approved scores match this ranking entry.', { exact: true }).waitFor();
            assert.equal(await configRows(page).count(), 0);
            assert.equal(await page.locator('#model-scores-expand').count(), 0);
        });

        await run('failures-and-retry', async ({ page, controls }) => {
            controls.failIndex = 1;
            await page.getByRole('button', { name: 'All scores', exact: true }).click();
            await page.getByText('All scores could not be loaded.', { exact: true }).waitFor();
            await page.getByRole('button', { name: 'Retry', exact: true }).click(); await configRows(page).first().waitFor();
            controls.failDetails.add(1);
            const row = configRows(page).first();
            await row.locator(':scope > summary').click();
            await groups(row).first().locator(':scope > summary').click();
            await row.getByText('Approved scores could not be loaded.', { exact: true }).waitFor();
            controls.failDetails.clear(); await row.getByRole('button', { name: 'Retry', exact: true }).click();
            await row.locator('.bp-model-score-sample').first().waitFor();
            controls.failDetails.add(6);
            await search(page).fill('Remote 2026'); await searchDone(page);
            const remote = groups(visibleConfigs(page).first()).filter({ visible: true }).first();
            await remote.locator(':scope > summary').click();
            await remote.getByText('Approved scores could not be loaded.', { exact: true }).waitFor();
            assert.equal(await page.getByText('No matching configurations or benchmark versions.', { exact: true }).count(), 0);
            controls.failDetails.clear();
            await remote.getByRole('button', { name: 'Retry', exact: true }).click();
            await remote.locator('.bp-model-score-sample').first().waitFor();
            assert.equal(await visibleConfigs(page).count(), 1);
            assert.equal(await search(page).inputValue(), 'Remote 2026');
        });

        await run('stale-requests-and-query', async ({ page, controls }) => {
            controls.delay = 200;
            await page.getByRole('button', { name: 'All scores', exact: true }).click();
            await page.evaluate(() => qa.view.openApprovedModelResults(qa.models[1]));
            await pause(250);
            assert.match(await page.locator('#model-scores-title').textContent(), /Second Model/);
            assert.equal(await configRows(page).count(), 0);
            await openAll(page); assert.equal(await configRows(page).count(), 1);
            await configRows(page).first().locator(':scope > summary').click();
            await startSources(page, groups(configRows(page).first()).first());
            await page.evaluate(() => qa.view.openApprovedModelResults(qa.models[0]));
            await pause(250);
            assert.match(await page.locator('#model-scores-title').textContent(), /Evidence Model/);
            assert.equal(await configRows(page).count(), 0);
            await openAll(page);
            await search(page).fill('Remote 2026');
            await startSources(page, groups(visibleConfigs(page).first()).filter({ visible: true }).first());
            await search(page).fill('High'); await searchDone(page);
            await pause(250);
            assert.equal(await visibleConfigs(page).count(), 1);
            assert.match(await visibleConfigs(page).first().locator(':scope > summary').textContent(), /High/);
            assert.equal(await visibleConfigs(page).first().evaluate(node => node.open), false, 'Old responses apply only the newest query');
        });

        await run('account-and-payload-guards', async ({ page, controls }) => {
            await openAll(page); controls.delay = 200;
            await configRows(page).first().locator(':scope > summary').click();
            await startSources(page, groups(configRows(page).first()).first());
            await page.evaluate(() => { qa.state.userID = '12'; qa.state.loadSequence++; });
            await pause(250);
            assert.equal(await page.locator('.bp-model-score-sample').count(), 0, 'Old-account payloads never render');
            controls.delay = 0; controls.badModel = true;
            await page.evaluate(() => qa.view.openApprovedModelResults(qa.models[0])); await openAll(page);
            await configRows(page).first().locator(':scope > summary').click();
            await groups(configRows(page).first()).first().locator(':scope > summary').click();
            await page.getByText('Approved scores could not be loaded.', { exact: true }).waitFor();
            assert.equal(await page.locator('.bp-model-score-sample').count(), 0);
            controls.badModel = false; controls.badFields = true;
            await configRows(page).first().getByRole('button', { name: 'Retry', exact: true }).click();
            await page.getByText('Approved scores could not be loaded.', { exact: true }).waitFor();
            assert.equal(await page.locator('.bp-model-score-sample').count(), 0);
            controls.badFields = false;
            await configRows(page).first().getByRole('button', { name: 'Retry', exact: true }).click();
            await configRows(page).first().locator('.bp-model-score-sample').first().waitFor();
        });

        await run('closed-dialog-response', async ({ page, controls }) => {
            await openAll(page); controls.delay = 250;
            await configRows(page).first().locator(':scope > summary').click();
            await startSources(page, groups(configRows(page).first()).first());
            await page.evaluate(() => { document.getElementById('model-scores-dialog').hidden = true; });
            await pause(300);
            assert.equal(await page.locator('.bp-model-score-sample').count(), 0, 'Closed dialogs reject late detail responses');
            await page.evaluate(() => qa.view.openApprovedModelResults(qa.models[1]));
            assert.match(await page.locator('#model-scores-title').textContent(), /Second Model/);
        });

        await run('normal-motion-keyboard', async ({ page, controls }) => {
            controls.delay = 120;
            await openAll(page);
            const row = configRows(page).first(), heading = row.locator(':scope > summary');
            await heading.focus(); await page.keyboard.press('Enter');
            await groups(row).first().waitFor();
            await page.keyboard.press('Space');
            await page.waitForFunction(() => !document.querySelector('.bp-model-score-configuration').open);
            await heading.click();
            const version = groups(row).first();
            await version.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
            await version.locator('.bp-model-score-sample').first().waitFor();
            await search(page).fill('Remote 2026'); await searchDone(page);
            assert.equal(await visibleConfigs(page).count(), 1);
            await search(page).fill('');
            assert.equal(await row.evaluate(node => node.open), true, 'Clearing restores the intended state of an animating disclosure');
            assert.equal(await version.evaluate(node => node.open), true);
            assert.equal(await heading.evaluate(node => node.getBoundingClientRect().height >= 44), true);
        }, { reducedMotion: 'no-preference' });

        await run('used-ranking-and-guest-permissions', async ({ page, controls, requests }) => {
            await openAll(page); await configRows(page).first().locator(':scope > summary').click();
            await groups(configRows(page).first()).first().waitFor();
            await page.getByRole('button', { name: 'Used in this ranking', exact: true }).click();
            assert.equal(await configRows(page).count(), 0);
            const url = page.url(), title = await page.locator('#model-scores-title').textContent();
            const summary = await page.locator('#model-scores-summary').textContent();
            const source = page.locator('.bp-model-configuration-source');
            await source.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
            await source.locator('.bp-model-score-sample').first().waitFor();
            const sourceRequest = requests.filter(item => item.path.endsWith('get_approved_benchmark_results')).at(-1);
            assert.deepEqual(sourceRequest.body.expectedEvidence, { conditionID: 101, hash: 'a'.repeat(64) });
            assert.equal(await page.locator('#model-scores-list > details').count(), 1);
            assert.equal(page.url(), url);
            assert.equal(await page.locator('#model-scores-title').textContent(), title);
            assert.equal(await page.locator('#model-scores-summary').textContent(), summary);
            assert.equal(await page.getByRole('button', { name: 'Used in this ranking' }).getAttribute('aria-pressed'), 'true');
            assert.equal(await source.locator('.bp-row-edit-action .fa-pen-to-square').count(), 3);
            assert.notEqual(await source.locator('.bp-row-edit-action i').first().evaluate(node => getComputedStyle(node, '::before').content), '"i"');
            await search(page).fill('Independent');
            assert.equal(await page.locator('.bp-model-score-sample:not([hidden])').count(), 1);
            await search(page).fill('');
            assert.equal(await page.locator('.bp-model-score-sample:not([hidden])').count(), 3);
            const before = requests.filter(item => item.path.endsWith('get_approved_benchmark_results')).length;
            await source.locator(':scope > summary').click(); await source.locator(':scope > summary').click();
            assert.equal(requests.filter(item => item.path.endsWith('get_approved_benchmark_results')).length, before);
            controls.changed = true;
            await page.evaluate(() => qa.view.openApprovedModelResults(qa.models[0]));
            await page.locator('.bp-model-configuration-link').click();
            await page.getByText('Scores have changed since this ranking was calculated.', { exact: true }).waitFor();
            await page.getByRole('button', { name: 'Refresh ranking', exact: true }).click();
            assert.equal(await page.evaluate(() => window.refreshes), 1);
            controls.changed = false;
            await page.evaluate(() => { qa.state.authenticated = false; qa.state.userID = null; qa.view.openApprovedModelResults(qa.models[0]); });
            await openAll(page); await configRows(page).first().locator(':scope > summary').click();
            await groups(configRows(page).first()).first().waitFor();
            await groups(configRows(page).first()).first().locator(':scope > summary').click();
            await configRows(page).first().locator('.bp-model-score-sample').first().waitFor();
            assert.equal(await page.locator('.bp-row-edit-action:visible').count(), 0);
            assert.equal(await page.locator('#model-scores-change-controls').evaluate(node => node.hidden), true);
        });

        await run('ranking-fallback-retry-and-search', async ({ page, controls, requests }) => {
            await page.evaluate(() => {
                qa.state.benchmarkDetailsByID.set(102, { benchmarkID: 2, conditionID: 102, name: 'Fallback benchmark', conditionName: 'v1' });
                const score = qa.models[0].calculationScores[0];
                score.fallbackFor = 102;
                score.familyConditionIDs = [102, 101];
                qa.view.openApprovedModelResults(qa.models[0]);
            });
            const fallback = page.locator('.bp-model-fallback-toggle');
            assert.equal(await fallback.locator('i').first().getAttribute('class'), 'fa-solid fa-code-branch bp-model-fallback-indicator');
            assert.equal(await fallback.locator(':scope > .bp-ui-disclosure-chevron.fa-chevron-right').count(), 1);
            assert.equal(await fallback.evaluate(node => node.previousElementSibling?.classList.contains('bp-benchmark-information-link')), true);
            await fallback.click();
            assert.equal(await fallback.getAttribute('aria-expanded'), 'true');
            assert.equal(await fallback.locator('.bp-model-fallback-indicator').evaluate(node => getComputedStyle(node).transform), 'none');
            assert.match(await page.locator('.bp-model-fallback-path').textContent(), /Mathematics.*Used/);
            controls.failDetails.add(1);
            const source = page.locator('.bp-model-configuration-source');
            await source.locator(':scope > summary').click();
            await source.getByText('Approved scores could not be loaded.', { exact: true }).waitFor();
            assert.equal(await page.locator('.bp-model-fallback-path').isVisible(), true);
            controls.failDetails.clear(); controls.delay = 150;
            await source.getByRole('button', { name: 'Retry' }).click();
            await search(page).fill('Independent');
            await source.locator('.bp-model-score-sample').first().waitFor({ state: 'attached' });
            assert.equal(await source.isVisible(), true, 'A pending source becomes searchable when its response arrives');
            assert.equal(await source.locator('.bp-model-score-sample:visible').count(), 1);
            await search(page).fill('');
            assert.equal(await source.locator('.bp-model-score-sample:visible').count(), 3);
            assert.equal(await fallback.getAttribute('aria-expanded'), 'true');
            assert.equal(requests.filter(item => item.path.endsWith('get_approved_benchmark_results')).length, 2);
        });

        await run('ranking-source-guards', async ({ page, controls }) => {
            controls.badHash = true;
            await page.locator('.bp-model-configuration-link').click();
            await page.getByText('Scores have changed since this ranking was calculated.', { exact: true }).waitFor();
            assert.equal(await page.locator('.bp-model-score-sample').count(), 0);
            controls.badHash = false; controls.badModel = true;
            await page.evaluate(() => qa.view.openApprovedModelResults(qa.models[0]));
            await page.locator('.bp-model-configuration-link').click();
            await page.getByText('Approved scores could not be loaded.', { exact: true }).waitFor();
            controls.badModel = false; controls.delay = 200;
            await page.getByRole('button', { name: 'Retry' }).click();
            await page.getByRole('button', { name: 'All scores', exact: true }).click();
            await configRows(page).first().waitFor(); await pause(250);
            assert.equal(await page.locator('.bp-model-score-sample').count(), 0, 'A response from the ranking view cannot leak into All scores');
            await page.evaluate(() => qa.view.openApprovedModelResults(qa.models[0]));
            await page.locator('.bp-model-configuration-link').click();
            await page.evaluate(() => { qa.state.userID = '12'; qa.state.loadSequence++; });
            await pause(250);
            assert.equal(await page.locator('.bp-model-score-sample').count(), 0, 'Old-account ranking evidence is discarded');
        });

        await run('missing-index-retry-without-fanout', async ({ page, controls, requests }) => {
            controls.badIndex = true;
            await page.getByRole('button', { name: 'All scores', exact: true }).click();
            await page.getByText('All scores could not be loaded.', { exact: true }).waitFor();
            await search(page).fill('Mathematics');
            assert.equal(requests.filter(item => item.path.endsWith('get_approved_benchmark_results')).length, 0);
            controls.badIndex = false;
            await page.getByRole('button', { name: 'Retry', exact: true }).click();
            await configRows(page).first().waitFor();
            await search(page).fill('Mathematics'); await searchDone(page);
            assert.equal(await visibleConfigs(page).count(), 6);
            assert.equal(requests.filter(item => item.path.endsWith('get_approved_benchmark_results')).length, 0);
        });

        await run('explicit-sources-dedup-and-queue', async ({ page, controls, requests }) => {
            await openAll(page);
            for (const index of [0, 1, 2, 3, 4, 5]) await configRows(page).nth(index).locator(':scope > summary').click();
            assert.equal(requests.filter(item => item.path.endsWith('get_approved_benchmark_results')).length, 0);
            controls.delay = 180;
            const first = configRows(page).first();
            await groups(first).nth(0).locator(':scope > summary').click();
            await groups(first).nth(1).locator(':scope > summary').click();
            await groups(first).nth(0).locator('.bp-model-score-sample').first().waitFor();
            await groups(first).nth(1).locator('.bp-model-score-sample').first().waitFor();
            assert.equal(requests.filter(item => item.path.endsWith('get_approved_benchmark_results')).length, 1,
                'Two explicit versions share one in-flight configuration read');
            assert.equal(await groups(first).nth(0).locator('.bp-model-score-detail-value').textContent(), '70%');
            assert.equal(await groups(first).nth(1).locator('.bp-model-score-detail-value').textContent(), '51%');
            await groups(first).nth(0).locator(':scope > summary').click();
            await groups(first).nth(0).locator(':scope > summary').click();
            assert.equal(requests.filter(item => item.path.endsWith('get_approved_benchmark_results')).length, 1);
            for (const index of [1, 2, 3, 4]) await groups(configRows(page).nth(index)).first().locator(':scope > summary').click();
            for (const index of [1, 2, 3, 4]) await groups(configRows(page).nth(index)).first().locator('.bp-model-score-sample').first().waitFor();
            assert.ok(controls.maxActive <= 3);
            assert.equal(requests.filter(item => item.path.endsWith('get_approved_benchmark_results')).length, 5);
        });

        await run('current-evidence-reconciles-index', async ({ page, controls, requests }) => {
            await openAll(page);
            const row = configRows(page).first();
            await row.locator(':scope > summary').click();
            const version = groups(row).first();
            assert.equal(await version.locator('.bp-model-score-detail-value').textContent(), '70%');
            controls.revised = true;
            await version.locator(':scope > summary').click();
            await version.locator('.bp-model-score-sample').first().waitFor();
            assert.equal(await version.locator('.bp-model-score-detail-value').textContent(), '65%');
            assert.equal(await groups(row).count(), 1, 'Removed approved versions do not retain stale index summaries');
            assert.match(await row.locator(':scope > summary').textContent(), /3 scores/);
            assert.match(await page.locator('#model-scores-summary').textContent(), /23 approved scores/);
            assert.equal(await version.locator('.bp-model-score-sample-value').nth(1).textContent(), '50%');
            assert.equal(await version.locator('.bp-model-score-source').first().getAttribute('href'), 'https://example.org/evidence/1/0');
            assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.bp-model-configuration-evidence > details > summary')), true,
                'Source expansion keeps keyboard focus through the summary refresh');
            assert.equal(requests.filter(item => item.path.endsWith('get_approved_benchmark_results')).length, 1);
        });

        await run('closed-version-does-not-reopen-on-response', async ({ page, controls, requests }) => {
            await openAll(page);
            const row = configRows(page).first();
            await row.locator(':scope > summary').click();
            const version = groups(row).first();
            controls.delay = 180;
            await startSources(page, version);
            await version.locator(':scope > summary').click();
            await pause(250);
            assert.equal(await version.evaluate(node => node.open), false);
            assert.equal(await version.locator('.bp-model-score-sample').count(), 0);
            await version.locator(':scope > summary').click();
            await version.locator('.bp-model-score-sample').first().waitFor();
            assert.equal(requests.filter(item => item.path.endsWith('get_approved_benchmark_results')).length, 1);
        });

        for (const width of [390, 320]) await run('mobile-' + width, async ({ page }) => {
            await openAll(page); await search(page).fill('High Mathematics v2'); await searchDone(page);
            const version = groups(visibleConfigs(page).first()).filter({ visible: true }).first();
            await version.locator(':scope > summary').click();
            await version.locator('.bp-model-score-sample').first().waitFor();
            await page.screenshot({ path: resolve(output, 'mobile-' + width + '.png'), fullPage: true });
            const overflow = await page.evaluate(() => {
                const list = document.getElementById('model-scores-list');
                return { document: document.documentElement.scrollWidth > innerWidth + 1,
                    list: list.scrollWidth > list.clientWidth + 1,
                    controls: [...document.querySelectorAll('.bp-model-configuration-heading, .bp-model-score-detail-heading, .bp-model-score-sample')]
                        .filter(node => node.getClientRects().length).filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.className) };
            });
            assert.deepEqual(overflow, { document: false, list: false, controls: [] });
            await version.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
            assert.equal(await version.evaluate(node => node.open), false);
        }, { viewport: { width, height: 844 }, hasTouch: true });

        await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
        return { output, cases: results.length, results };
    } finally { await browser.close(); await app.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    console.log(JSON.stringify(await runAllScoresBrowserQA(), null, 2));
}
