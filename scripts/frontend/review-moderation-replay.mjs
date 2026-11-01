import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { decisionCases, createModerationMutationHarness } from '../review-moderation-replay-20261008.mjs';

const output = process.env.REPLAY_BROWSER_OUTPUT ?? 'artifacts/review-20261008/moderation-replay-browser';
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const results = [];
await mkdir(output, { recursive: true });
for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch({ headless: true, env });
    try {
        for (const width of [1440, 390]) for (const scenario of decisionCases) for (let repetition = 1; repetition <= 2; repetition++) {
            const harness = await createModerationMutationHarness({ scenario });
            const log = { ...harness.log, content: JSON.parse(harness.log.content), userName: 'Isolated contributor' };
            const conflict = harness.sourceConflict();
            const app = await startPreview({ userID: '1', logs: [log], syncConflicts: [{ ...conflict,
                modelName: 'Isolated model', benchmarkName: 'Isolated source benchmark', conditionName: 'Overall',
                currentScore: 40, currentStatus: 'accepted', currentFields: [], currentNotes: null, manualOverride: 'edit' }] });
            const page = await browser.newPage({ viewport: { width, height: 960 } });
            page.setDefaultTimeout(8000);
            const record = { engine, width, scenario, repetition, errors: [], requests: [], passed: false };
            results.push(record);
            const clickAlert = () => page.locator('global-dialog:not([hidden])')
                .locator('global-dialog-action.main, global-dialog-action.danger').click();
            let submit;
            const send = async () => {
                await submit.click();
                if (['approve', 'reject', 'apply'].includes(scenario)) await clickAlert();
            };
            try {
                page.on('pageerror', error => record.errors.push(error.message));
                await page.route('**/api/preview_moderation_sql', intercepted => intercepted.fulfill({
                    json: harness.preview(intercepted.request().postDataJSON().content) }));
                await page.route(`**/api/${harness.route}`, async intercepted => {
                    const request = intercepted.request(), body = request.postDataJSON(), key = request.headers()['idempotency-key'];
                    record.requests.push({ body, key });
                    try {
                        const response = await harness.invoke(body, key);
                        if (record.requests.length === 1) return intercepted.abort('failed');
                        app.state.logs = [{ ...harness.log, content: JSON.parse(harness.log.content), userName: 'Isolated contributor' }];
                        if (scenario === 'escalate') app.state.logs[0].status = 'escalated';
                        if (scenario === 'correction') app.state.syncConflicts = [];
                        if (scenario === 'source') app.state.syncConflicts[0].status = 'accept_source';
                        return intercepted.fulfill({ status: response.status, json: response.body });
                    } catch (error) { return intercepted.fulfill({ status: error.status ?? 500, json: error.body ?? { error: error.message } }); }
                });
                await page.goto(`${app.url}/censor`);
                await page.locator('.log-item').first().waitFor();
                if (['source', 'correction'].includes(scenario)) {
                    await page.locator('[data-workspace-view="sync"]').click();
                    submit = page.getByRole('button', { name: scenario === 'source' ? 'Accept official update' : 'Keep manual correction', exact: true });
                } else if (scenario === 'escalate') {
                    await page.locator('.log-item .action-button.escalate').click();
                    await page.locator('#escalate-note').fill(harness.body.note);
                    submit = page.locator('#escalate-form [type="submit"]');
                } else if (scenario === 'apply') {
                    await page.locator('.log-item .action-button.edit').click();
                    await page.locator('#editor-fields [name="details"]').fill(harness.body.content.details);
                    await page.locator('#editor-preview').click();
                    await page.locator('#sql-preview').filter({ hasText: 'actual signed preview' }).waitFor();
                    await page.getByRole('button', { name: 'Close SQL preview', exact: true }).click();
                    submit = page.locator('#request-editor [type="submit"]');
                } else submit = page.locator(`.log-item .action-button.${scenario === 'approve' ? 'approve' : 'reject'}`);
                await send();
                if (['source', 'correction'].includes(scenario)) await page.locator('#sync-list .log-meta').filter({ hasText: 'Review could not be saved' }).waitFor();
                else { await page.locator('global-dialog:not([hidden])').filter({ hasText: /could not|failed|saved|applied|escalated/i }).waitFor(); await clickAlert(); }
                assert.equal(harness.summary().mutations, 1, 'First operation committed before the response was discarded');
                if (scenario === 'apply') assert.equal(await page.locator('#editor-fields [name="details"]').inputValue(), harness.body.content.details);
                if (scenario === 'escalate') assert.equal(await page.locator('#escalate-note').inputValue(), harness.body.note);
                await send();
                if (['approve', 'reject', 'apply'].includes(scenario)) await clickAlert(); // SMTP fixture reports a queued, not delivered email.
                if (scenario === 'apply') await page.locator('#editor-overlay').waitFor({ state: 'hidden' });
                else if (scenario === 'escalate') await page.locator('#escalate-overlay').waitFor({ state: 'hidden' });
                else if (scenario === 'source') await page.getByText('Official update approved, waiting for the next sync.', { exact: true }).waitFor();
                else if (scenario === 'correction') await page.getByText('No source changes need review.', { exact: true }).waitFor();
                else await page.getByRole('button', { name: scenario === 'approve' ? 'Approve' : 'Reject', exact: true }).waitFor({ state: 'hidden' });
                assert.equal(record.requests.length, 2);
                assert.match(record.requests[0].key, /^[0-9a-f-]{36}$/);
                assert.equal(record.requests[0].key, record.requests[1].key);
                assert.equal(harness.summary().successAudits, 1); assert.equal(harness.summary().failureAudits, 0);
                assert.equal(harness.summary().mutations, 1);
                assert.equal(harness.summary().outbox, ['approve', 'reject', 'apply'].includes(scenario) ? 1 : 0);
                assert.deepEqual(record.errors, []);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                record.summary = harness.summary(); record.passed = true;
                if (repetition === 1 && scenario === 'source') await page.screenshot({ path: `${output}/${engine}-${width}.png`, fullPage: true });
            } catch (error) {
                record.error = error.stack; record.text = (await page.locator('body').innerText()).slice(-2500);
                await page.screenshot({ path: `${output}/${engine}-${width}-${scenario}-${repetition}-failure.png`, fullPage: true });
            } finally {
                console.log(JSON.stringify({ engine, width, scenario, repetition, passed: record.passed, error: record.error }));
                await page.close(); await app.close();
            }
        }
    } finally { await browser.close(); }
}
await writeFile(`${output}/results.json`, JSON.stringify({ passed: results.filter(result => result.passed).length,
    total: results.length, results, scope: 'Real browser reviewer client and actual server callbacks. Database/role/email/SQL presentation are fixtures; no production writes.' }, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
