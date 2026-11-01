import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const normal = process.argv.includes('--normal');
const observe = process.argv.includes('--observe');
const failure = process.argv.includes('--failure');
const network = process.argv.includes('--network');
const only = process.argv.find(value => value.startsWith('--only='))?.slice(7);
const output = process.argv.find(value => value.startsWith('--output='))?.slice(9)
    ?? 'artifacts/review-20261008/moderation-account';
const endpoints = { approve: 'review_moderation_log', reject: 'review_moderation_log', preview: 'preview_moderation_sql',
    apply: 'apply_moderation_log', escalate: 'escalate_moderation_log', message: 'send_admin_message',
    read: 'mark_admin_message_read', 'sync-source': 'resolve_score_sync_conflict', 'sync-correction': 'resolve_score_sync_conflict' };
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const results = [];
await mkdir(output, { recursive: true });
for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch({ headless: true, env });
    try {
        for (const width of [1440, 390]) {
            for (const kind of Object.keys(endpoints).filter(value => !only || value === only)) {
                for (let repetition = 1; repetition <= 2; repetition++) {
                    const app = await startPreview({ userID: '1', logs: [{ ID: 901, status: 'pending',
                        content: { schemaVersion: 1, type: 'feedback', details: 'Synthetic feedback for reviewer tests.', pageURL: 'https://example.com/' },
                        created_at: '2026-10-08T01:00:00Z', userName: 'Fixture contributor' }],
                    adminMessages: [{ ID: 100, senderUserID: 3,
                        body: 'Synthetic reviewer message', createdAt: '2026-10-08T01:00:00Z', isRead: false }],
                    syncConflicts: [{ row_key: 'fixture-row', result_ID: 77, incoming_hash: 'a'.repeat(64), status: 'pending',
                        modelName: 'Fixture model', benchmarkName: 'Fixture benchmark', conditionName: 'Overall',
                        currentScore: 82, currentStatus: 'approved', manualOverride: 'corrected', currentFields: [], currentNotes: '',
                        incoming_row: { rawScore: 83 } }] });
                    const page = await browser.newPage({ viewport: { width, height: 960 } });
                    page.setDefaultTimeout(7000);
                    const record = { engine, width, kind, repetition, normal, failure, network, writes: [], errors: [], passed: false };
                    results.push(record);
                    let draft, failNext = true;
                    try {
                        page.on('pageerror', error => record.errors.push(error.message));
                        const targets = new Set([endpoints[kind], ...(kind === 'apply' ? ['preview_moderation_sql'] : [])]);
                        await page.route('**/api/**', async route => {
                            const name = new URL(route.request().url()).pathname.split('/').at(-1);
                            if (!targets.has(name)) return route.continue();
                            const write = { name, owner: app.state.userID, body: route.request().postDataJSON() };
                            record.writes.push(write);
                            if ((failure || network) && failNext && name === endpoints[kind]) {
                                failNext = false;
                                write.status = network ? 0 : 503;
                                if (network) return route.abort('failed');
                                return route.fulfill({ status: 503, json: { error: 'synthetic_failure' } });
                            }
                            const response = await route.fetch();
                            write.status = response.status();
                            write.result = await response.json().catch(() => null);
                            await route.fulfill({ response });
                        });
                        await page.goto(`${app.url}/censor`);
                        await page.locator('#log-list .log-item').first().waitFor();
                        let trigger;
                        if (kind === 'approve' || kind === 'reject') {
                            trigger = async () => {
                                await page.locator(`.log-item .action-button.${kind}`).first().click();
                                await page.locator('global-dialog:not([hidden]) global-dialog-action.main, global-dialog:not([hidden]) global-dialog-action.danger').click();
                            };
                        } else if (kind === 'preview') trigger = () => page.locator('.log-item .action-button.preview').first().click();
                        else if (kind === 'apply') {
                            await page.locator('.log-item .action-button.edit').first().click();
                            draft = page.locator('#editor-fields [name="details"]');
                            await draft.fill('Reviewer A edited-request draft');
                            trigger = async () => {
                                await page.locator('#editor-preview').click();
                                await page.waitForTimeout(300);
                                if (await page.locator('global-dialog:not([hidden])').count()) return;
                                await page.getByRole('button', { name: 'Close SQL preview', exact: true }).click();
                                await page.locator('#request-editor [type="submit"]').click();
                                await page.locator('global-dialog:not([hidden]) global-dialog-action.main').click();
                            };
                        } else if (kind === 'escalate') {
                            await page.locator('.log-item .action-button.escalate').first().click();
                            draft = page.locator('#escalate-note');
                            await draft.fill('Reviewer A escalation draft');
                            trigger = () => page.locator('#escalate-form [type="submit"]').click();
                        } else if (kind === 'message') {
                            await page.locator('#compose-message-button').click();
                            draft = page.locator('#message-compose-body');
                            await draft.fill('Reviewer A private message draft');
                            trigger = () => page.locator('#message-compose-form [type="submit"]').click();
                        } else if (kind === 'read') {
                            await page.locator('#messages-tab').click();
                            await page.getByText('Synthetic reviewer message', { exact: true }).waitFor();
                            trigger = () => page.getByRole('button', { name: 'Mark as read', exact: true }).click();
                        } else {
                            await page.locator('#sync-tab').click();
                            await page.getByText('Fixture model', { exact: true }).waitFor();
                            trigger = () => page.getByRole('button', { name: kind === 'sync-source' ? 'Accept official update' : 'Keep manual correction', exact: true }).click();
                        }
                        record.beforeDraft = draft ? await draft.inputValue() : null;
                        if (!normal && !failure && !network) app.state.userID = '2';
                        await trigger();
                        await page.waitForTimeout(550);
                        record.afterDraft = draft && await draft.count() ? await draft.inputValue() : null;
                        record.url = page.url();
                        record.visibleText = (await page.locator('body').innerText()).slice(-1800);
                        record.refreshGuidance = /account changed.*refresh/i.test(await page.locator('body').innerText());
                        record.wrongAccountWrites = record.writes.filter(write => write.owner === '2' && write.status >= 200 && write.status < 300).length;
                        if (!observe) {
                            assert.deepEqual(record.errors, [], 'No unhandled browser errors');
                            assert.equal(new URL(page.url()).pathname, '/censor', 'Failures must not navigate away');
                            if (failure || network) {
                                assert.ok(/could not|failed|try again|network/i.test(await page.locator('body').innerText()), 'Local failure guidance');
                                if (draft) assert.equal(record.afterDraft, record.beforeDraft);
                            } else if (normal) assert.ok(record.writes.some(write => write.name === endpoints[kind] && write.status === 200), 'Normal writes remain accepted');
                            else {
                                assert.equal(record.wrongAccountWrites, 0);
                                assert.equal(record.refreshGuidance, true);
                                if (draft) assert.equal(record.afterDraft, record.beforeDraft);
                                assert.ok(record.writes.every(write => write.body.expectedUserID === '1'));
                            }
                            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                            if (repetition === 1 && ['message', 'sync-source'].includes(kind)) {
                                await page.screenshot({ path: `${output}/${engine}-${width}-${kind}.png`, fullPage: true });
                            }
                            if (failure || network) {
                                const alert = page.locator('global-dialog:not([hidden]) global-dialog-action.main');
                                if (await alert.count()) await alert.click();
                                if (await page.locator('#sql-overlay:not([hidden])').count()) {
                                    await page.getByRole('button', { name: 'Close SQL preview', exact: true }).click();
                                }
                                await trigger();
                                await page.waitForTimeout(500);
                                record.recovered = record.writes.some(write => write.name === endpoints[kind] && write.status === 200);
                                assert.equal(record.recovered, true, 'The same action remains retryable after dismissing the local failure');
                                assert.deepEqual(record.errors, [], 'Recovery must not cause unhandled browser errors');
                            }
                        }
                        record.passed = observe ? record.wrongAccountWrites === 0 && record.refreshGuidance : true;
                    } catch (error) { record.error = error.message; }
                    finally {
                        console.log(JSON.stringify({ engine, width, kind, repetition, passed: record.passed,
                            wrongAccountWrites: record.wrongAccountWrites, error: record.error }));
                        await page.close();
                        await app.close();
                    }
                }
            }
        }
    } finally { await browser.close(); }
}
const passed = results.filter(result => result.passed).length;
await writeFile(`${output}/results.json`, JSON.stringify({ scope: 'Local isolated reviewer sessions. No production mutation.',
    passed, total: results.length, results }, null, 2));
console.log(JSON.stringify({ passed, total: results.length, output }));
if (!observe && passed !== results.length) process.exitCode = 1;
