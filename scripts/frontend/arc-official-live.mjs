import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { fieldDisplayValue, normalizeScoreFields } from '../../public/js/shared/score-fields.js';

const root = 'artifacts/arc-official-20261006';
const output = `${root}/live`;
const state = JSON.parse(await readFile(`${root}/production-after.json`, 'utf8'));
const receipt = JSON.parse(await readFile(`${root}/applied.json`, 'utf8'));
assert.equal(receipt.transactionState, 'committed');
assert.equal(receipt.applied, true);
const imported = new Set(receipt.receipt.map(row => row.resultID));
assert.equal(imported.size, 509);
const activeModels = new Map(state.tables.models.filter(model => model.is_active).map(model => [Number(model.ID), model]));
const catalog = state.tables.score_fields.filter(field => field.is_active).map(field => ({
    ID: Number(field.ID), name: field.name, type: field.field_type,
    allowEmpty: Boolean(field.allow_empty), excludeMissing: Boolean(field.exclude_missing),
    excludeEmpty: Boolean(field.exclude_empty),
    options: state.tables.score_field_options.filter(option => option.is_active && option.field_ID === field.ID)
        .map(option => ({ ID: Number(option.ID), label: option.label, excluded: Boolean(option.excluded) }))
}));
const targets = [
    { benchmarkID: 1027, conditionID: 10135, name: 'ARC-AGI-1' },
    { benchmarkID: 1057, conditionID: 1009, name: 'ARC-AGI-2' }
];
const checks = [];
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true,
    args: ['--host-resolver-rules=MAP benchpoll.com 18.226.222.18'],
    env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' }
});

async function post(page, path, body) {
    return page.evaluate(async ({ path, body }) => {
        const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
        const data = await response.json();
        if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${JSON.stringify(data)}`);
        return data;
    }, { path, body });
}

try {
    for (const width of [1440, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 940 },
            isMobile: width < 500, hasTouch: width < 500 });
        const page = await context.newPage(); page.setDefaultTimeout(60000);
        const errors = [], blockedWrites = [], failures = [], consoleErrors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('requestfailed', request => failures.push({ url: request.url(), failure: request.failure()?.errorText }));
        page.on('response', response => {
            if (response.status() >= 400) failures.push({ url: response.url(), status: response.status() });
        });
        page.on('console', message => {
            if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 1500));
        });
        await page.route('**/api/**', route => {
            const path = new URL(route.request().url()).pathname;
            if (/^\/api\/(?:get_|load_benchmarks)/.test(path)) return route.continue();
            blockedWrites.push(path); return route.abort();
        });
        try {
            await page.goto('https://benchpoll.com/Intelligence', { waitUntil: 'domcontentloaded', timeout: 90000 });
            await page.waitForFunction(() => document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false');
            if (width < 500 && await page.locator('button[data-mobile-panel="mix"]').isVisible()) {
                await page.locator('button[data-mobile-panel="mix"]').click();
            }
            for (const target of targets) {
                const expected = state.tables.benchmark_results.filter(row => row.status === 'accepted'
                    && Number(row.benchmark_ID) === target.benchmarkID && Number(row.benchmark_condition_ID) === target.conditionID
                    && activeModels.has(Number(row.model_ID)));
                const byID = new Map(expected.map(row => [Number(row.ID), row]));
                const first = await post(page, '/api/get_benchmark_scores', {
                    benchmarkID: target.benchmarkID, conditionID: target.conditionID
                });
                const selected = first.conditions.find(condition => condition.ID === target.conditionID);
                assert.equal(selected.scoreCount, expected.length);
                const pages = [first];
                while (pages.at(-1).nextBeforeID !== null) {
                    assert.ok(pages.length < 100, 'A non-terminating score cursor is not accepted');
                    const beforeID = pages.at(-1).nextBeforeID;
                    const next = await post(page, '/api/get_benchmark_scores', {
                        benchmarkID: target.benchmarkID, conditionID: target.conditionID, beforeID
                    });
                    assert.ok(next.scores.every(score => score.ID < beforeID));
                    pages.push(next);
                }
                const scores = pages.flatMap(data => data.scores);
                assert.equal(new Set(scores.map(score => score.ID)).size, scores.length);
                assert.equal(scores.length, expected.length);
                for (const score of scores) {
                    const original = byID.get(score.ID);
                    assert.ok(original, `Unexpected public score ${score.ID}`);
                    assert.equal(score.rawScore, Number(original.raw_score));
                    assert.equal(score.sourceURL, original.source_url);
                    assert.equal(score.sourceTitle, original.source_title);
                    assert.equal(score.modelID, Number(original.model_ID));
                    assert.equal(score.modelName, activeModels.get(score.modelID).name);
                    const fields = normalizeScoreFields(original.score_fields, catalog).map(item => {
                        const field = catalog.find(field => field.ID === item.fieldID);
                        return { name: field.name, value: fieldDisplayValue(field, item.value) };
                    });
                    assert.deepEqual(score.fields, fields);
                }
                const importedHere = scores.filter(score => imported.has(score.ID)).length;
                assert.equal(importedHere, receipt.mutations.filter(row => imported.has(row.ID)
                    && Number(row.after.benchmark_condition_ID) === target.conditionID).length);

                await page.locator('#benchmark-search').fill(target.name);
                const row = page.locator(`.bp-benchmark-row:not(.is-family)[data-condition-id="${target.conditionID}"]`);
                await row.waitFor({ state: 'visible' });
                await row.locator('.bp-benchmark-information-link').click();
                await page.waitForFunction(ID => document.body.classList.contains('discussion-open')
                    || document.querySelector(`.bp-benchmark-row.selected[data-condition-id="${ID}"]`), String(target.conditionID));
                if (!await page.evaluate(() => document.body.classList.contains('discussion-open'))) {
                    await row.locator('.bp-benchmark-information-link').click();
                }
                await page.waitForFunction(() => document.querySelector('#benchmark-information')?.getAttribute('aria-busy') === 'false');
                assert.equal((await page.locator('#benchmark-information-name').textContent()).trim(), target.name);
                assert.equal((await page.locator('#benchmark-information-condition').textContent()).trim(), selected.name);
                assert.match(await page.locator('#benchmark-information-age').textContent(), /^\(Today\)$/i);
                const benchmark = state.tables.benchmarks.find(row => Number(row.ID) === target.benchmarkID);
                assert.ok(benchmark.scores_updated_at);
                const information = await post(page, '/api/get_benchmark_information', { conditionID: target.conditionID });
                assert.ok(information.scoresUpdatedAt);
                assert.equal(information.differenceExplanation, state.tables.benchmark_conditions
                    .find(condition => Number(condition.ID) === target.conditionID).difference_explanation ?? '');
                await page.screenshot({ path: `${output}/information-${target.name}-${width}.png`, animations: 'disabled' });
                await page.locator('#benchmark-scores-open').click();
                await page.waitForFunction(count => document.querySelectorAll('.benchmark-score-row').length === count
                    && document.querySelector('#benchmark-scores-list')?.getAttribute('aria-busy') === 'false', first.scores.length);
                assert.equal(await page.locator('#benchmark-scores-condition').inputValue(), String(target.conditionID));
                assert.equal((await page.locator('#benchmark-scores-count').textContent()).trim(), `${scores.length.toLocaleString('en')} approved scores`);
                assert.equal(await page.locator('.benchmark-score-row').first().getAttribute('data-score-id'), String(first.scores[0].ID));
                assert.ok((await page.locator('.benchmark-score-value').first().textContent()).includes(String(first.scores[0].rawScore)));
                if (first.scores[0].fields.length) {
                    await page.locator('.benchmark-score-row').first().locator('summary').click();
                    assert.ok(await page.locator('.benchmark-score-row').first().locator('dl').isVisible());
                }
                await page.screenshot({ path: `${output}/scores-${target.name}-${width}.png`, animations: 'disabled' });
                if (first.nextBeforeID) {
                    await page.locator('#benchmark-scores-more').click();
                    await page.waitForFunction(count => document.querySelectorAll('.benchmark-score-row').length === count,
                        first.scores.length + pages[1].scores.length);
                }
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                await page.locator('#discussion-close').click();
                await page.locator('#discussion-panel').waitFor({ state: 'hidden' });
                checks.push({ width, name: target.name, conditionID: target.conditionID,
                    importedVerified: importedHere, totalApproved: scores.length, pages: pages.length,
                    runFieldsAndSources: true, freshUpdateDate: true, browserErrors: errors.length });
                console.log(`PASS ${target.name} at ${width}px: ${importedHere} official imports, ${scores.length} public scores`);
            }
            assert.deepEqual(errors, []); assert.deepEqual(blockedWrites, []);
        } catch (error) {
            checks.push({ width, passed: false, error: error.stack, errors, blockedWrites, failures, consoleErrors, url: page.url() });
            await page.screenshot({ path: `${output}/failure-${width}.png`, fullPage: true });
            throw error;
        } finally { await context.close(); }
    }
} finally {
    await browser.close();
    await writeFile(`${output}/results.json`, JSON.stringify({ readOnly: true, passed: checks.length === 4
        && checks.every(check => !Object.hasOwn(check, 'error')), checks }, null, 2) + '\n');
}
