import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { validateWorkspacePayload } from '../../public/js/workspace/contracts.js';
import { validateModelScoreConfigurationIndex } from '../../public/js/workspace/model-scores.js';
import { coverageMultiplier } from '../../public/js/shared/coverage-penalty.js';
import { partitionNavigationDiagnostics } from './browser-diagnostics.mjs';

const origin = process.argv[2] || 'https://benchpoll.com';
const output = resolve(process.env.TOPIC_IDENTITY_LIVE_OUTPUT || 'D:/Codex-artifacts/website1/topic-identity-ui-20261026/live');
await mkdir(output, { recursive: true });
const report = { verified: false, origin, checks: [], errors: [], diagnostics: [] };
const proxyFree = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const close = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

async function post(page, path, data) {
    const response = await page.evaluate(async ({ path, data }) => {
        const result = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data), signal: AbortSignal.timeout(60000) });
        return { status: result.status, data: await result.json() };
    }, { path, data });
    assert.equal(response.status, 200, `${path}: ${response.status}`);
    return response.data;
}

try {
    for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
        const engineOnly = process.argv.find(value => value.startsWith('--engine='))?.slice(9);
        if (engineOnly && engineOnly !== name) continue;
        const browser = await engine.launch({ headless: true, env: proxyFree });
        try {
            for (const width of [1440, 390]) {
                const context = await browser.newContext({ viewport: { width, height: 940 }, isMobile: width < 761, hasTouch: width < 761,
                    ignoreHTTPSErrors: new URL(origin).hostname === '127.0.0.1' });
                await context.addInitScript(() => {
                    window.__topicIdentityDOMErrors = [];
                    window.addEventListener('error', event => window.__topicIdentityDOMErrors.push(event.message));
                    window.addEventListener('unhandledrejection', event => window.__topicIdentityDOMErrors.push(String(event.reason)));
                });
                const page = await context.newPage();
                page.setDefaultTimeout(60000);
                const failures = [], details = [], errors = [], pending = [];
                let phase = 'initial home';
                page.on('pageerror', error => {
                    const entry = { name, width, phase, receivedAt: Date.now(), url: page.url(), message: error.message, stack: error.stack };
                    errors.push(entry);
                    pending.push(page.evaluate(() => window.__topicIdentityDOMErrors).then(events => { entry.domEvents = events; }).catch(() => {}));
                });
                page.on('requestfailed', request => failures.push({ name, width, phase, receivedAt: Date.now(),
                    endpoint: new URL(request.url()).pathname, url: request.url(), failure: request.failure()?.errorText }));
                page.on('request', request => { if (request.url().endsWith('/api/get_approved_benchmark_results')) details.push(request.postDataJSON()); });
                try {
                    await page.goto(origin, { waitUntil: 'domcontentloaded' });
                    await page.locator('.th-card.is-featured[data-preview-state="loaded"]').waitFor();
                    assert.ok(await page.locator('.th-card.is-featured .th-topic-summary').textContent());
                    assert.equal(await page.locator('.th-card.is-featured .bp-topic-byline-prefix').textContent(), 'by');
                    await page.evaluate(() => scrollTo(0, document.getElementById('home-hero').getBoundingClientRect().bottom + scrollY + 24));
                    await page.waitForFunction(() => !document.getElementById('topics-filters').hidden);
                    const previewResponse = page.waitForResponse(response => response.url().endsWith('/api/get_topic_preview') && response.request().postDataJSON()?.availableInferenceVersion === 5);
                    await page.getByRole('combobox', { name: 'Coverage penalty', exact: true }).click();
                    await page.getByRole('option', { name: 'Rational (a=5)', exact: true }).click();
                    assert.equal((await previewResponse).status(), 200);
                    await page.locator('.th-card.is-featured[data-preview-state="loaded"]').waitFor();
                    const href = await page.locator('.th-card.is-featured .th-topic-link').getAttribute('href');
                    await page.screenshot({ path: join(output, `${name}-${width}-home.png`) });
                    phase = 'open model';
                    await page.locator('.th-card.is-featured .th-topic-link').click();
                    await page.waitForURL(new URL(href, origin).href);
                    await page.waitForFunction(() => document.querySelectorAll('#model-rows .bp-model-row').length > 0);
                    phase = 'configuration';
                    assert.equal(await page.locator('#workspace-coverage-penalty').inputValue(), 'rational');
                    assert.ok(await page.locator('#workspace-topic-summary').textContent());
                    assert.equal(await page.locator('#bp-breadcrumb .bp-topic-byline-prefix').textContent(), 'by');
                    if (width < 761) await page.getByRole('button', { name: 'Model ranking', exact: true }).click();
                    if (name === 'chromium' && width === 1440) {
                        const request = { categoryID: 54, contextValues: {}, scoreMode: 'available', initialMode: 'public',
                            comparison: { mode: 'best', keys: ['model'], filters: [] } };
                        const rational = validateWorkspacePayload(await post(page, '/api/get_weighted_workspace', { ...request, availableInferenceVersion: 5 }));
                        const power = validateWorkspacePayload(await post(page, '/api/get_weighted_workspace', { ...request, availableInferenceVersion: 4 }));
                        const previous = new Map(power.modelLeaderboards.public.map(model => [model.ID, model]));
                        let compared = 0;
                        for (const model of rational.modelLeaderboards.public) {
                            const trace = model.availableInference;
                            if (!trace) continue;
                            close(trace.coverageFactor, coverageMultiplier(trace.coverageFraction, 'rational'));
                            if (previous.has(model.ID)) {
                                close(trace.unpenalizedScore, previous.get(model.ID).availableInference.unpenalizedScore);
                                compared++;
                            }
                        }
                        assert.ok(compared > 0);
                        report.formulas = { verified: true, compared };
                    }
                    await page.locator('#model-rows .bp-model-row').first().click();
                    await page.locator('#model-scores-dialog').waitFor({ state: 'visible' });
                    const indexResponse = page.waitForResponse(response => response.url().endsWith('/api/get_model_score_configurations'));
                    await page.getByRole('button', { name: 'All scores', exact: true }).click();
                    const response = await indexResponse;
                    assert.equal(response.request().postDataJSON().includeVersions, true);
                    assert.equal(response.status(), 200);
                    const index = validateModelScoreConfigurationIndex(await response.json(), response.request().postDataJSON().modelIDs);
                    const rows = page.locator('#model-scores-list > .bp-model-score-configuration');
                    await rows.first().waitFor();
                    const before = details.length;
                    await rows.first().locator(':scope > summary').click();
                    await rows.first().locator('.bp-model-score-detail-row').first().waitFor({ state: 'visible' });
                    assert.equal(details.length, before, 'Opening a configuration should not fetch full evidence');
                    const group = index.configurations[0].scoreGroups[0];
                    await page.locator('#model-scores-search').fill(group.benchmarkName);
                    await page.waitForFunction(() => [...document.querySelectorAll('#model-scores-list > details')].some(row => !row.hidden && row.open));
                    assert.equal(details.length, before, 'Searching should use the compact index');
                    await page.locator('#model-scores-search').fill(index.configurations[0].modelName);
                    await page.waitForFunction(() => [...document.querySelectorAll('#model-scores-list > details')].filter(row => !row.hidden).every(row => !row.open));
                    await page.locator('#model-scores-search').fill(group.benchmarkName);
                    const version = page.locator('#model-scores-list > details:not([hidden]) .bp-model-score-detail-row:not([hidden])').first();
                    const sourceResponse = page.waitForResponse(response => response.url().endsWith('/api/get_approved_benchmark_results'));
                    await version.locator(':scope > summary .bp-model-score-aggregate').click();
                    assert.equal((await sourceResponse).status(), 200);
                    await version.locator('.bp-model-score-sample').first().waitFor({ state: 'visible' });
                    await page.screenshot({ path: join(output, `${name}-${width}-all-scores.png`) });
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
                    await Promise.all(pending);
                    const partitioned = partitionNavigationDiagnostics(errors, failures);
                    report.diagnostics.push({ name, width, ...partitioned });
                    report.errors.push(...partitioned.errors);
                    assert.deepEqual(partitioned.errors, []);
                    report.checks.push({ name, width, indexedConfigurations: index.configurations.length,
                        indexedVersions: index.configurations.reduce((sum, item) => sum + item.scoreGroups.length, 0), fullEvidenceRequests: details.length - before });
                } finally { await context.close(); }
            }
        } finally { await browser.close(); }
    }
    assert.deepEqual(report.errors, []);
    report.verified = true;
} finally { await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify({ verified: report.verified, checks: report.checks.length, formulas: report.formulas, output }));
