import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { createWriteRouteHarness } from '../review-write-replay-20261008.mjs';

const output = 'artifacts/review-20261008/write-replay-browser';
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const results = [];
await mkdir(output, { recursive: true });
for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch({ headless: true, env });
    try {
        for (const width of [1440, 390]) for (const scenario of ['feedback-retry', 'feedback-reload', 'message-retry', 'option-retry']) {
            for (let repetition = 1; repetition <= 2; repetition++) {
                const app = await startPreview({ userID: '1', isSenior: false });
                const page = await browser.newPage({ viewport: { width, height: 960 } });
                page.setDefaultTimeout(9000);
                const record = { engine, width, scenario, repetition, errors: [], requests: [], passed: false };
                results.push(record);
                const route = scenario === 'message-retry' ? 'send_admin_message' : 'submit_contribution';
                const harness = await createWriteRouteHarness({ route });
                const fields = [{ ID: 7, name: 'Harness', type: 'enum', revision: 1, allowEmpty: false,
                    excludeMissing: true, excludeEmpty: false, options: [{ ID: 30, label: 'Agent A', revision: 1, excluded: false }] }];
                try {
                    page.on('pageerror', error => record.errors.push(error.message));
                    await page.route(`**/api/${route}`, async intercepted => {
                        const request = intercepted.request(), body = request.postDataJSON();
                        const key = request.headers()['idempotency-key'];
                        record.requests.push({ key, body });
                        try {
                            const response = await harness.invoke(body, key);
                            if (scenario === 'option-retry' && !fields[0].options.some(option => option.label === body.label)) {
                                const ID = harness.records.find(row => row.table === 'moderation_logs').ID;
                                fields[0].options.push({ ID: null, requestID: ID, label: body.label, pending: true, excluded: false });
                            }
                            if (record.requests.length === 1) return intercepted.abort('failed');
                            return intercepted.fulfill(response.status === 204 ? { status: 204 }
                                : { status: response.status, json: response.body });
                        } catch (error) { return intercepted.fulfill({ status: error.status ?? 500, json: error.body ?? { error: error.message } }); }
                    });
                    let input, submit;
                    if (scenario === 'option-retry') {
                        await page.route('**/__review-write-options', intercepted => intercepted.fulfill({ contentType: 'text/html',
                            body: '<!doctype html><html><body><main id="editor"></main></body></html>' }));
                        await page.route('**/api/get_contribution_catalog', intercepted => intercepted.fulfill({ json: { scoreFields: fields } }));
                        await page.goto(`${app.url}/__review-write-options`);
                        await page.evaluate(async initial => {
                            const { mountScoreFields } = await import('/js/contribution/score-fields.js?v=write-replay-20261008');
                            const { pageAccountWriteScope } = await import('/js/shared/account-identity.js');
                            pageAccountWriteScope.bind('1');
                            let fields = initial;
                            window.assignments = [{ fieldID: 7, value: 30 }];
                            mountScoreFields(document.getElementById('editor'), { assignments: window.assignments,
                                getFields: () => fields, onChange() {}, refresh: async () => {
                                    fields = (await (await fetch('/api/get_contribution_catalog', { method: 'POST' })).json()).scoreFields;
                                } });
                        }, fields);
                        await page.locator('.score-field-value summary').click();
                        input = page.getByRole('searchbox', { name: 'Harness options' });
                        await input.fill('Agent B');
                        submit = page.getByRole('button', { name: /Propose.*Agent B/ });
                    } else if (scenario === 'message-retry') {
                        await page.goto(`${app.url}/censor`);
                        await page.locator('#compose-message-button').click();
                        input = page.locator('#message-compose-body');
                        await input.fill('One message with a lost response.');
                        submit = page.locator('#message-compose-form [type="submit"]');
                    } else {
                        await page.goto(`${app.url}/contribute/feedback`);
                        input = page.locator('[data-bind="feedback"][data-field="details"]');
                        await input.fill('One contribution with a lost response.');
                        submit = page.locator('#submit-contribution');
                    }
                    const original = await input.inputValue();
                    await submit.click();
                    if (scenario === 'option-retry') await page.locator('.score-field-error').filter({ hasText: /fetch|Network|Load|failed|submitted|could not/i }).waitFor();
                    else if (scenario === 'message-retry') await page.locator('global-dialog:not([hidden]) global-dialog-action.main').waitFor();
                    else await page.locator('#submit-error-dialog:not([hidden])').waitFor();
                    assert.equal(harness.summary().recordCount, 1, 'The lost response happened after one committed write');
                    assert.equal(await input.inputValue(), original);
                    if (scenario === 'feedback-reload') {
                        await page.reload();
                        await input.waitFor(); await input.fill(original);
                    } else if (scenario === 'message-retry') await page.locator('global-dialog:not([hidden]) global-dialog-action.main').click();
                    else if (scenario !== 'option-retry') await page.locator('#submit-error-dialog .dialog-close-button').click();
                    await submit.click();
                    if (scenario === 'message-retry') await page.locator('#message-compose-overlay').waitFor({ state: 'hidden' });
                    else if (scenario === 'option-retry') await page.waitForFunction(() => Boolean(window.assignments[0].optionRequestID));
                    else await page.locator('#submit-success-dialog:not([hidden])').waitFor();
                    assert.equal(record.requests.length, 2);
                    assert.equal(record.requests[0].key, record.requests[1].key, 'Retry preserves the original identity');
                    assert.equal(harness.summary().recordCount, 1, 'No duplicate business records');
                    assert.deepEqual(record.errors, []);
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                    if (scenario === 'feedback-retry') {
                        await page.locator('#submit-success-dialog .dialog-close-button').click();
                        await page.waitForURL(`${app.url}/`);
                        await page.goto(`${app.url}/contribute/feedback`);
                        await input.fill(original);
                        await submit.click(); await page.locator('#submit-success-dialog:not([hidden])').waitFor();
                        assert.equal(harness.summary().recordCount, 2, 'A later intentional submission is not permanently deduplicated');
                        assert.notEqual(record.requests[1].key, record.requests[2].key);
                    }
                    record.recordCount = harness.summary().recordCount;
                    if (repetition === 1 && scenario === 'feedback-retry') await page.screenshot({ path: `${output}/${engine}-${width}.png`, fullPage: true });
                    record.passed = true;
                } catch (error) {
                    record.error = error.stack;
                    record.visibleText = (await page.locator('body').innerText()).slice(-2000);
                    await page.screenshot({ path: `${output}/${engine}-${width}-${scenario}-${repetition}-failure.png`, fullPage: true });
                } finally {
                    console.log(JSON.stringify({ engine, width, scenario, repetition, passed: record.passed, error: record.error }));
                    await page.close(); await app.close();
                }
            }
        }
    } finally { await browser.close(); }
}
await writeFile(`${output}/results.json`, JSON.stringify({ passed: results.filter(result => result.passed).length,
    total: results.length, scope: 'Actual browser clients and actual route callbacks with SQL-backed behavior simulated in memory. Role/session fixture, not production OAuth. No production mutation.', results }, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
