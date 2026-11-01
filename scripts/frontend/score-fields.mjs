import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const fields = [
    { ID: 20, name: 'Effort', type: 'enum', revision: 1, allowEmpty: false, excludeMissing: true, excludeEmpty: false,
        options: [{ ID: 101, label: 'High' }, { ID: 102, label: 'Low' }] },
    { ID: 1, name: 'Harness', type: 'enum', revision: 1, allowEmpty: true, excludeMissing: true, excludeEmpty: false,
        options: [{ ID: 11, label: 'Agent A' }, { ID: 12, label: 'Agent B' }, { ID: null, requestID: 99, label: 'Pending harness', pending: true }] },
    { ID: 3, name: 'Token budget', type: 'number', revision: 1, allowEmpty: false, excludeMissing: true, excludeEmpty: false, options: [] },
    { ID: 4, name: 'Harness version', type: 'text', revision: 1, allowEmpty: false, excludeMissing: true, excludeEmpty: false, options: [] }
];
const output = process.env.SCORE_FIELDS_OUTPUT ?? 'artifacts/frontend/fixed-score-contributions';
const liveURL = process.argv.find(value => /^https?:\/\//.test(value));
await mkdir(output, { recursive: true });
for (const [engine, width] of [['chromium', 1440], ['chromium', 390], ['chromium', 320], ['webkit', 390]]) {
    if (process.env.UI_TEST_ENGINE && process.env.UI_TEST_ENGINE !== engine) continue;
    if (process.env.UI_TEST_WIDTH && Number(process.env.UI_TEST_WIDTH) !== width) continue;
    const preview = await startPreview({ comparisonFields: fields });
    const browser = await ({ chromium, webkit })[engine].launch({ headless: true, env: { ...process.env,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    const context = await browser.newContext({ viewport: { width, height: 960 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const baseURL = liveURL ?? preview.url;
    page.setDefaultTimeout(liveURL ? 30000 : 6000);
    if (liveURL) page.setDefaultNavigationTimeout(60000);
    if (liveURL) await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        await route.fulfill({ response: await route.fetch({ url: preview.url + url.pathname + url.search }) });
    });
    if (engine === 'webkit' && !liveURL) await page.route(`${preview.url}/**`, async route => {
        const response = await route.fetch({ maxRetries: 2 });
        await route.fulfill({ response, body: await response.body() });
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const submissions = () => preview.state.requests.filter(request => request.path === '/api/submit_contribution');
    const choose = async (host, name, value) => {
        await host.getByRole('combobox', { name: `${name} value`, exact: true }).click();
        await page.getByRole('option', { name: value, exact: true }).click();
    };
    const fit = async () => {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.equal(await page.locator('.score-field-row').evaluateAll(rows => rows.every(row => {
            const label = row.querySelector(':scope > span').getBoundingClientRect();
            const control = row.querySelector('.bp-ui-select-trigger').getBoundingClientRect();
            return label.right <= control.left + 1 && control.right <= innerWidth + 1;
        })), true);
    };
    try {
        await page.goto(`${baseURL}/contribute?mode=benchmark_result&modelID=301&benchmarkID=101`);
        await page.locator('#form-surface:not([hidden])').waitFor();
        assert.equal(await page.locator('.score-field-row').count(), 2);
        assert.deepEqual(await page.locator('.score-field-row > span').allTextContents(), ['Effort', 'Harness']);
        assert.equal(await page.locator('.score-field-editor input, .score-field-editor a').count(), 0);
        await choose(page, 'Effort', 'High');
        await page.getByRole('combobox', { name: 'Harness value', exact: true }).click();
        assert.equal(await page.getByRole('option', { name: /Pending harness/ }).count(), 0);
        await page.getByRole('option', { name: 'Agent A', exact: true }).click();
        await page.locator('[data-score-value-input]').fill('82');
        await page.locator('[data-field="sourceURL"]').fill('https://example.com/approved-score');
        await page.getByRole('button', { name: 'Copy as a new score' }).click();
        const second = page.locator('[data-score-fields-editor="1"]');
        assert.equal(await second.locator('.score-field-row').count(), 2);
        await choose(second, 'Effort', 'Low');
        await choose(second, 'Harness', 'Not recorded');
        await page.locator('[data-score-value-input]').nth(1).fill('83');
        assert.equal(await page.locator('[data-score-fields-editor="0"] select[aria-label="Harness value"]').inputValue(), '11');
        await fit();
        await page.screenshot({ path: `${output}/${engine}-${width}-new.png`, fullPage: true });
        await page.getByRole('button', { name: 'Submit contribution', exact: true }).click();
        await page.locator('#submit-success-dialog:not([hidden])').waitFor();
        assert.equal(submissions().length, 1);
        const submitted = submissions()[0].body;
        assert.equal(submitted.type, 'benchmark_result');
        assert.deepEqual(submitted.results.map(result => result.scoreFields),
            [[{ fieldID: 20, value: 101 }, { fieldID: 1, value: 11 }], [{ fieldID: 20, value: 102 }]]);

        const history = [{ fieldID: 1, value: 11 }, { fieldID: 3, value: '1e3' }, { fieldID: 20, value: 101 }];
        await page.route('**/api/get_contribution_target', route => route.fulfill({ json: {
            targetKind: 'result', targetID: 501, form: { result: {
                modelID: 301, benchmarkID: 101, benchmarkConditionID: 1, scoreFields: history,
                rawScore: 88, notes: 'Saved note', source: { type: 'other', url: 'https://example.com/evidence', title: '' }
            } }
        } }));
        await page.goto(`${baseURL}/contribute/scores/501/edit`);
        await page.locator('#form-surface:not([hidden])').waitFor();
        assert.equal(await page.locator('.score-field-row').count(), 2);
        await page.getByRole('button', { name: 'Submit contribution', exact: true }).click();
        await page.locator('#submit-error-dialog:not([hidden])').waitFor();
        assert.equal(submissions().length, 1, 'Hidden historical fields must not synthesize an edit');
        await page.reload();
        await page.locator('#form-surface:not([hidden])').waitFor();
        await page.locator('[data-score-value-input]').fill('89');
        await fit();
        await page.screenshot({ path: `${output}/${engine}-${width}-edit.png`, fullPage: true });
        await page.getByRole('button', { name: 'Submit contribution', exact: true }).click();
        await page.locator('#submit-success-dialog:not([hidden])').waitFor();
        assert.equal(submissions().length, 2);
        const edited = submissions()[1].body;
        assert.equal(edited.type, 'entity_change');
        assert.deepEqual(edited.proposed.results[0].scoreFields, [{ fieldID: 1, value: 11 }, { fieldID: 20, value: 101 }]);
        assert.deepEqual(history, [{ fieldID: 1, value: 11 }, { fieldID: 3, value: '1e3' }, { fieldID: 20, value: 101 }]);

        for (const path of ['/contribute/score-fields', '/contribute/score-field-options',
            '/contribute?mode=score_field', '/contribute?mode=score_field_option']) {
            const response = await page.goto(baseURL + path);
            if (liveURL) {
                assert.equal(response.status(), 410);
                assert.equal(await page.locator('#contribution-form').count(), 0);
                continue;
            }
            // The synthetic static server serves the shell; real HTTP 410 is covered by the route contract.
            await page.locator(path.includes('?') ? '#submit-error-dialog:not([hidden])' : '#entry-missing:not([hidden])').waitFor();
            assert.equal(await page.locator('#contribution-form:visible').count(), 0);
        }
        assert.equal(submissions().length, 2);

        await page.goto(`${baseURL}/contribute/scores/new`);
        await page.locator('#form-surface:not([hidden])').waitFor();
        if (width < 760) await page.locator('#contribution-taxonomy-toggle').click();
        await page.getByRole('button', { name: 'Request bulk import', exact: true }).click();
        const feedback = page.locator('textarea[data-bind="feedback"]');
        await feedback.waitFor();
        assert.equal(await feedback.inputValue(), '');
        assert.match(await page.locator('#feedback-guidance').textContent(), /For a bulk import.*official leaderboards/);
        assert.equal(await feedback.isEditable(), true);
        assert.equal(submissions().length, 2, 'Opening the request does not submit it');
        assert.deepEqual(errors, []);
        console.log(`PASS ${engine} ${width}: fixed-choice scores, copy isolation, historical correction, withdrawn controls`);
    } catch (error) {
        await page.screenshot({ path: `${output}/${engine}-${width}-failure.png`, fullPage: true }).catch(() => {});
        console.error({ engine, width, url: page.url(), errors, message: await page.locator('#submit-error-copy').textContent().catch(() => '') });
        throw error;
    } finally { await context.close(); await browser.close(); await preview.close(); }
}
