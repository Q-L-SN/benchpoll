import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const baselinePath = process.argv.find(value => value.startsWith('--baseline='))?.slice('--baseline='.length);
const baselineModule = baselinePath ? await readFile(baselinePath, 'utf8') : null;
const output = resolve(process.argv.find(value => value.startsWith('--output='))?.slice('--output='.length)
    ?? process.env.REVIEW_OUTPUT ?? 'artifacts/review-20261008/field-transitions');
await mkdir(output, { recursive: true });
const reports = [];
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch({ headless: true, env });
    try {
        for (const width of [1440, 390]) {
            for (const scenario of ['edit-approved-option', 'propose-after-approval', 'approved-option-race']) {
                const app = await startPreview();
                const page = await browser.newPage({ viewport: { width, height: 960 } });
                const errors = [];
                const submissions = [];
                page.on('pageerror', error => errors.push(error.message));
                page.setDefaultTimeout(3000);
                const approved = { ID: 7, requestID: 99, name: 'Harness', type: 'enum', revision: 1,
                    allowEmpty: false, excludeMissing: true, excludeEmpty: false,
                    options: [{ ID: 30, requestID: 99, pendingIndex: 0, label: 'Agent A', excluded: false, revision: 1 }] };
                try {
                    await page.route('**/__review-field-transition', route => route.fulfill({
                        contentType: 'text/html', body: '<!doctype html><html><head><title>Field transition</title></head><body><main id="editor"></main></body></html>'
                    }));
                    if (baselineModule) await page.route('**/js/contribution/score-fields.js', route => route.fulfill({
                        contentType: 'text/javascript', body: baselineModule
                    }));
                    await page.route('**/api/get_contribution_catalog', route => route.fulfill({ json: { scoreFields: [approved] } }));
                    await page.route('**/api/submit_contribution', async route => {
                        const body = route.request().postDataJSON();
                        submissions.push(body);
                        approved.options.push(scenario === 'approved-option-race'
                            ? { ID: 40, requestID: 101, label: body.label, excluded: false, revision: 1 }
                            : { ID: null, requestID: 100, pending: true, label: body.label, excluded: false });
                        await route.fulfill({ json: { ID: 100, status: 'pending' } });
                    });
                    await page.goto(`${app.url}/__review-field-transition`);
                    const initialField = scenario === 'approved-option-race' ? approved
                        : { ID: null, requestID: 99, pending: true, name: 'Harness', type: 'enum',
                            allowEmpty: false, excludeMissing: true, excludeEmpty: false,
                            options: [{ ID: null, pendingIndex: 0, label: 'Agent A', excluded: false }] };
                    await page.evaluate(async initialField => {
                        const { mountScoreFields } = await import('/js/contribution/score-fields.js');
                        const { pageAccountWriteScope } = await import('/js/shared/account-identity.js');
                        pageAccountWriteScope.bind('1');
                        let fields = [initialField];
                        window.reviewAssignments = [initialField.ID ? { fieldID: initialField.ID, value: 30 }
                            : { fieldRequestID: 99, optionIndex: 0 }];
                        mountScoreFields(document.getElementById('editor'), { assignments: window.reviewAssignments,
                            getFields: () => fields, onChange() {}, refresh: async () => {
                                fields = (await (await fetch('/api/get_contribution_catalog', { method: 'POST' })).json()).scoreFields;
                            } });
                    }, initialField);
                    await page.locator('.score-field-value summary').click();
                    await page.getByRole('link', { name: 'Change option', exact: true }).waitFor({ state: 'attached' });
                    if (scenario === 'edit-approved-option') {
                        const values = await page.getByRole('link', { name: 'Change option', exact: true }).evaluate(link => {
                            const token = new URLSearchParams(new URL(link.href).hash.slice(1)).get('entry');
                            return JSON.parse(localStorage.getItem(`benchpoll:contribution-entry:${token}`)).values;
                        });
                        assert.equal(values.fieldID, '7', 'Approved option edit must include the real parent field ID');
                        assert.equal(values.fieldOptionID, '30');
                    } else {
                        await page.getByRole('searchbox', { name: 'Harness options' }).fill('Agent B');
                        await page.getByRole('button', { name: /Propose.*Agent B/ }).click();
                        await page.waitForFunction(() => window.reviewAssignments[0].optionRequestID !== undefined
                            || window.reviewAssignments[0].value === 40 || window.reviewAssignments[0].newOption === 'Agent B');
                        assert.equal(submissions.length, 1, 'An approved field must submit a new option request');
                        assert.equal(submissions[0].fieldID, 7);
                        const assignment = await page.evaluate(() => window.reviewAssignments[0]);
                        if (scenario === 'approved-option-race') {
                            assert.equal(assignment.value, 40, 'Already-approved options must use their public ID, not another user\'s request');
                            assert.equal(Object.hasOwn(assignment, 'optionRequestID'), false);
                        } else assert.equal(assignment.optionRequestID, 100);
                    }
                    assert.deepEqual(errors, []);
                    reports.push({ engine, width, scenario, passed: true });
                    console.log(`PASS ${engine} ${width} ${scenario}`);
                } catch (error) {
                    reports.push({ engine, width, scenario, passed: false, error: error.stack, errors, submissions });
                    console.error(`FAIL ${engine} ${width} ${scenario}: ${error.message}`);
                } finally { await page.close(); await app.close(); }
            }
        }
    } finally { await browser.close(); }
}
await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
if (reports.some(report => !report.passed)) process.exitCode = 1;
