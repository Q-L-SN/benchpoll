import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const baselinePath = process.argv.find(value => value.startsWith('--baseline='))?.slice('--baseline='.length);
const baselineModule = baselinePath ? await readFile(baselinePath, 'utf8') : null;
const output = resolve(process.argv.find(value => value.startsWith('--output='))?.slice('--output='.length)
    ?? 'artifacts/review-20261008/option-concurrency');
await mkdir(output, { recursive: true });
const reports = [];
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch({ headless: true, env });
    try {
        for (const width of [1440, 390]) {
            for (const scenario of ['later-selection', 'newer-proposal', 'stale-error', 'unrelated-draft', 'detached-editor', 'remounted-editor', 'removed-field', 'current-error']) {
                const app = await startPreview();
                const page = await browser.newPage({ viewport: { width, height: 960 } });
                page.setDefaultTimeout(5000);
                const errors = [];
                page.on('pageerror', error => errors.push(error.message));
                const fields = [{ ID: 7, requestID: 99, name: 'Harness', type: 'enum', revision: 1,
                    allowEmpty: false, excludeMissing: true, excludeEmpty: false,
                    options: [{ ID: 30, label: 'Agent A', excluded: false, revision: 1 },
                        { ID: 31, label: 'Agent Z', excluded: false, revision: 1 }] },
                { ID: 8, name: 'Token budget', type: 'number', revision: 1, allowEmpty: false,
                    excludeMissing: true, excludeEmpty: false, options: [] }];
                const gates = new Map(['Agent B', 'Agent C'].map((name, index) => [name, {
                    started: deferred(), finished: deferred(), completed: deferred(), requestID: 100 + index
                }]));
                try {
                    await page.route('**/__review-option-concurrency', route => route.fulfill({ contentType: 'text/html',
                        body: '<!doctype html><html><head><title>Option concurrency</title></head><body><main id="editor"></main></body></html>' }));
                    if (baselineModule) await page.route('**/js/contribution/score-fields.js', route => route.fulfill({ contentType: 'text/javascript', body: baselineModule }));
                    await page.route('**/api/get_contribution_catalog', route => route.fulfill({ json: { scoreFields: fields } }));
                    await page.route('**/api/submit_contribution', async route => {
                        const body = route.request().postDataJSON();
                        const gate = gates.get(body.label);
                        assert.equal(body.fieldID, 7);
                        assert.ok(gate, 'Only the expected synthetic options may be proposed');
                        gate.started.resolve();
                        const succeed = await gate.finished.promise;
                        if (succeed) fields[0].options.push({ ID: null, requestID: gate.requestID,
                            pending: true, label: body.label, excluded: false });
                        await route.fulfill(succeed ? { json: { ID: gate.requestID, status: 'pending' } }
                            : { status: 503, json: { error: 'synthetic_failure' } });
                        gate.completed.resolve();
                    });
                    await page.goto(`${app.url}/__review-option-concurrency`);
                    await page.evaluate(async initial => {
                        const { mountScoreFields } = await import('/js/contribution/score-fields.js');
                        const { pageAccountWriteScope } = await import('/js/shared/account-identity.js');
                        pageAccountWriteScope.bind('1');
                        let fields = initial;
                        window.reviewAssignments = [{ fieldID: 7, value: 30 }, { fieldID: 8, value: '123' }];
                        window.reviewRefreshes = 0;
                        window.reviewRemount = () => mountScoreFields(document.getElementById('editor'), { assignments: window.reviewAssignments,
                            getFields: () => fields, onChange() {}, refresh: async () => {
                                fields = (await (await fetch('/api/get_contribution_catalog', { method: 'POST' })).json()).scoreFields;
                                window.reviewRefreshes++;
                            } });
                        window.reviewRemount();
                    }, fields);
                    await page.locator('.score-field-value summary').click();
                    await page.waitForFunction(() => window.reviewRefreshes === 1);
                    const propose = async name => {
                        await page.getByRole('searchbox', { name: 'Harness options' }).fill(name);
                        await page.getByRole('button', { name: new RegExp(`Propose.*${name}`) }).click();
                        await gates.get(name).started.promise;
                    };
                    const finish = async (name, succeed, refreshes) => {
                        const response = page.waitForResponse(response => response.url().endsWith('/api/submit_contribution')
                            && response.request().postDataJSON().label === name);
                        gates.get(name).finished.resolve(succeed);
                        await (await response).finished();
                        await gates.get(name).completed.promise;
                        if (succeed) await page.waitForFunction(count => window.reviewRefreshes >= count, refreshes);
                        await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
                    };
                    await propose('Agent B');
                    if (scenario === 'newer-proposal') {
                        await propose('Agent C');
                        await finish('Agent C', true, 2);
                        assert.equal(await page.evaluate(() => window.reviewAssignments[0].optionRequestID), 101);
                        await finish('Agent B', true, 3);
                        assert.equal(await page.evaluate(() => window.reviewAssignments[0].optionRequestID), 101,
                            'An older proposal response must not overwrite the newer choice');
                    } else if (scenario === 'unrelated-draft') {
                        const numeric = page.getByRole('textbox', { name: 'Token budget value', exact: true });
                        await numeric.fill('9001');
                        await numeric.evaluate(input => input.setSelectionRange(2, 2));
                        await finish('Agent B', true, 2);
                        assert.equal(await page.evaluate(() => window.reviewAssignments[0].optionRequestID), 100);
                        assert.equal(await numeric.inputValue(), '9001');
                        assert.equal(await numeric.evaluate(input => document.activeElement === input), true,
                            'Completing a proposal must not remove focus from another draft input');
                        assert.equal(await numeric.evaluate(input => input.selectionStart), 2);
                    } else if (scenario === 'detached-editor' || scenario === 'remounted-editor') {
                        await page.evaluate(remount => {
                            window.reviewAssignments[0].value = 31;
                            if (remount) window.reviewRemount();
                            else document.getElementById('editor').remove();
                        }, scenario === 'remounted-editor');
                        await finish('Agent B', true, 2);
                        assert.deepEqual(await page.evaluate(() => window.reviewAssignments[0]), { fieldID: 7, value: 31 },
                            'An obsolete editor must not mutate the shared form draft');
                    } else if (scenario === 'removed-field') {
                        await page.getByRole('button', { name: 'Remove field', exact: true }).first().click();
                        await finish('Agent B', true, 2);
                        assert.deepEqual(await page.evaluate(() => window.reviewAssignments), [{ fieldID: 8, value: '123' }]);
                        assert.equal(await page.locator('.score-field-row').count(), 1);
                    } else if (scenario === 'current-error') {
                        await finish('Agent B', false, 1);
                        assert.deepEqual(await page.evaluate(() => window.reviewAssignments[0]), { fieldID: 7, value: 30 });
                        assert.equal(await page.locator('.score-field-error[role="status"]').textContent(), 'Could not submit this new value for review.');
                        assert.equal(await page.getByRole('button', { name: /Propose.*Agent B/ }).isEnabled(), true);
                    } else {
                        await page.getByRole('searchbox', { name: 'Harness options' }).fill('');
                        await page.getByRole('button', { name: 'Agent Z', exact: true }).click();
                        await finish('Agent B', scenario !== 'stale-error', 2);
                        assert.deepEqual(await page.evaluate(() => window.reviewAssignments[0]), { fieldID: 7, value: 31 },
                            'The value explicitly selected after submitting a proposal must be kept');
                        assert.equal(await page.locator('.score-field-error[role="status"]').textContent(), '',
                            'A superseded failure must not show an error for the current selection');
                    }
                    assert.deepEqual(errors, []);
                    reports.push({ engine, width, scenario, passed: true });
                    console.log(`PASS ${engine} ${width} ${scenario}`);
                } catch (error) {
                    reports.push({ engine, width, scenario, passed: false, error: error.stack, errors,
                        assignments: await page.evaluate(() => window.reviewAssignments).catch(() => null) });
                    console.error(`FAIL ${engine} ${width} ${scenario}: ${error.message}`);
                } finally {
                    for (const gate of gates.values()) gate.finished.resolve(false);
                    await page.close(); await app.close();
                }
            }
        }
    } finally { await browser.close(); }
}
await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
if (reports.some(report => !report.passed)) process.exitCode = 1;
