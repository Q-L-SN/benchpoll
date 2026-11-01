import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const observe = process.argv.includes('--observe');
const only = process.argv.find(value => value.startsWith('--only='))?.slice(7);
const baseline = process.argv.find(value => value.startsWith('--baseline='))?.slice(11);
const baselineClient = baseline ? await readFile(`${baseline}/public/js/censor.js`, 'utf8') : null;
const output = process.argv.find(value => value.startsWith('--output='))?.slice(9)
    ?? 'artifacts/review-20261008/moderation-intent-after';
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const kinds = ['preview-order', 'preview-editor-reopen', 'preview-stale-error', 'message-reopen',
    'escalate-reopen', 'apply-reopen', 'message-list-order', 'message-read-refresh',
    'record-order', 'record-view-change', 'audit-order', 'audit-view-change', 'queue-order'];
const logs = [901, 902].map(ID => ({ ID, status: 'pending', content: { schemaVersion: 1,
    type: 'feedback', details: `Synthetic feedback ${ID}`, pageURL: 'https://example.com/' },
created_at: '2026-10-08T01:00:00Z', userName: 'Fixture contributor' }));
const message = (ID, body, isRead = false) => ({ ID, body, isRead, senderUserID: 3,
    createdAt: '2026-10-08T01:00:00Z' });
const audit = ID => ({ ID, moderation_log_ID: 900 + ID, reviewer_user_ID: 1,
    action_type: 'approve', outcome: 'success', request_type: 'feedback', request_summary: `Audit ${ID}`,
    status_before: 'pending', status_after: 'approved', duration_ms: 10,
    created_at: '2026-10-08T01:00:00Z', request_before: { ID }, request_after: null,
    executed_sql: `-- Audit ${ID}`, database_response: {} });
const results = [];
await mkdir(output, { recursive: true });
for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch({ headless: true, env });
    try {
        for (const width of [1440, 390]) {
            for (const kind of kinds.filter(value => !only || value === only)) {
                for (let repetition = 1; repetition <= 2; repetition++) {
                    const app = await startPreview({ userID: '1', logs: structuredClone(logs),
                        adminMessages: [message(100, 'Initial message')] });
                    const page = await browser.newPage({ viewport: { width, height: 960 } });
                    page.setDefaultTimeout(6000);
                    const record = { engine, width, kind, repetition, errors: [], passed: false, writes: [] };
                    results.push(record);
                    const held = [];
                    let completed = 0;
                    let queueLoads = 0;
                    const endpoint = kind.startsWith('preview') ? 'preview_moderation_sql'
                        : kind === 'message-reopen' ? 'send_admin_message'
                            : kind === 'escalate-reopen' ? 'escalate_moderation_log'
                                : kind === 'apply-reopen' ? 'apply_moderation_log'
                                    : kind === 'queue-order' ? 'review_moderation_log'
                                        : kind === 'message-list-order' ? 'list_admin_messages'
                                        : kind === 'message-read-refresh' ? 'mark_admin_message_read'
                                            : kind.startsWith('record') ? 'admin_data_record' : 'get_moderation_audit_log';
                    const waitHeld = async count => {
                        for (let attempt = 0; held.length < count && attempt < 100; attempt++) await page.waitForTimeout(20);
                        assert.ok(held.length >= count, `Expected ${count} held ${endpoint} requests, saw ${held.length}`);
                    };
                    const release = async (index, payload, status = 200) => {
                        held[index].resolve({ payload, status });
                        for (let attempt = 0; !held[index].finished && attempt < 100; attempt++) await page.waitForTimeout(20);
                        assert.equal(held[index].finished, true, 'Held response must complete');
                        await page.waitForTimeout(150);
                    };
                    const close = name => page.getByRole('button', { name, exact: true }).click();
                    const edit = async (index, draft) => {
                        await page.locator('.log-item .action-button.edit').nth(index).click();
                        await page.locator('#editor-fields [name="details"]').fill(draft);
                    };
                    try {
                        page.on('pageerror', error => record.errors.push(error.message));
                        if (baselineClient) await page.route('**/js/censor.js?*', route => route.fulfill({
                            contentType: 'text/javascript; charset=utf-8', body: baselineClient }));
                        await page.route('**/api/**', async route => {
                            const name = new URL(route.request().url()).pathname.split('/').at(-1);
                            if (name === 'admin_data_explorer') return route.fulfill({ json: {
                                entity: 'benchmarks', label: 'Benchmarks', entities: [{ key: 'benchmarks', label: 'Benchmarks' }],
                                columns: [{ key: 'id', label: 'ID' }, { key: 'name', label: 'Name' }],
                                rows: [{ id: 1, name: 'Record one' }, { id: 2, name: 'Record two' }],
                                page: 1, pageSize: 25, totalPages: 1, total: 2 } });
                            if (name === 'list_moderation_audit_logs') return route.fulfill({ json: {
                                rows: [audit(1), audit(2)], page: 1, pageSize: 25, totalPages: 1, total: 2 } });
                            if (kind === 'message-read-refresh' && name === 'list_admin_messages') {
                                const refreshed = completed++ > 0;
                                return route.fulfill({ json: { messages: [message(100, 'Initial message', refreshed),
                                    ...(refreshed ? [message(101, 'New message from refresh')] : [])] } });
                            }
                            const heldQueueLoad = kind === 'queue-order' && name === 'list_moderation_logs' && queueLoads++ > 0;
                            if (name !== endpoint && !heldQueueLoad) return route.continue();
                            const pending = { body: route.request().postDataJSON(), resolve: null, finished: false };
                            const promise = new Promise(resolve => { pending.resolve = resolve; });
                            held.push(pending);
                            const { payload, status } = await promise;
                            record.writes.push({ endpoint: name, body: pending.body, status });
                            await route.fulfill({ status, json: payload });
                            pending.finished = true;
                        });
                        await page.goto(`${app.url}/censor`);
                        await page.locator('.log-item').nth(1).waitFor();
                        if (kind === 'queue-order') {
                            await page.locator('.log-item .action-button.approve').nth(0).click();
                            await page.locator('global-dialog:not([hidden]) global-dialog-action.main').click();
                            await waitHeld(1);
                            await page.locator('.log-item .action-button.reject').nth(1).click();
                            await page.locator('global-dialog:not([hidden]) global-dialog-action.danger').click();
                            await waitHeld(2);
                            await release(0, {}); await waitHeld(3);
                            await release(1, {}); await waitHeld(4);
                            const queue = details => ({ logs: [{ ...logs[0], content: { ...logs[0].content, details } }] });
                            await release(3, queue('New queue refresh'));
                            await release(2, queue('Stale queue refresh'));
                            record.queue = await page.locator('#log-list').innerText();
                            assert.ok(record.queue.includes('New queue refresh'), 'Most recent queue refresh must remain current');
                            assert.ok(!record.queue.includes('Stale queue refresh'));
                            assert.equal(await page.locator('#status-filter').isEnabled(), true);
                        } else if (kind.startsWith('preview')) {
                            await edit(0, 'First draft');
                            await page.locator('#editor-preview').click(); await waitHeld(1);
                            await close('Close SQL preview');
                            if (kind === 'preview-editor-reopen') {
                                await close('Close editor'); await edit(0, 'Second draft');
                            } else await page.locator('#editor-fields [name="details"]').fill('Second draft');
                            await page.locator('#editor-preview').click(); await waitHeld(2);
                            await release(1, { sql: '-- Second draft', previewToken: 'second-token' });
                            await release(0, kind === 'preview-stale-error' ? { error: 'synthetic_old_failure' }
                                : { sql: '-- First draft', previewToken: 'first-token' }, kind === 'preview-stale-error' ? 503 : 200);
                            record.previewText = await page.locator('#sql-preview').textContent();
                            assert.equal(record.previewText, '-- Second draft', 'Old preview must not replace the current preview');
                            assert.equal(await page.locator('global-dialog:not([hidden])').count(), 0, 'Old failure must not interrupt new work');
                            await close('Close SQL preview');
                            await page.locator('#request-editor [type="submit"]').click();
                            const dialogText = await page.locator('global-dialog:not([hidden])').innerText();
                            assert.ok(dialogText.includes('Apply edited request?'), 'Latest preview remains usable for apply');
                            await page.keyboard.press('Escape');
                        } else if (kind.endsWith('reopen')) {
                            const overlay = kind === 'message-reopen' ? 'message-compose-overlay'
                                : kind === 'escalate-reopen' ? 'escalate-overlay' : 'editor-overlay';
                            const body = kind === 'message-reopen' ? '#message-compose-body'
                                : kind === 'escalate-reopen' ? '#escalate-note' : '#editor-fields [name="details"]';
                            const open = async index => {
                                if (kind === 'message-reopen') await page.locator('#compose-message-button').click();
                                else if (kind === 'escalate-reopen') await page.locator('.log-item .action-button.escalate').nth(index).click();
                                else await page.locator('.log-item .action-button.edit').nth(index).click();
                            };
                            await open(0); await page.locator(body).fill('First submitted draft');
                            if (kind === 'apply-reopen') {
                                await page.locator('#editor-preview').click();
                                await page.locator('#sql-preview').filter({ hasText: 'Synthetic preview' }).waitFor();
                                await close('Close SQL preview');
                            }
                            await page.locator(`#${overlay} [type="submit"]`).click();
                            if (kind === 'apply-reopen') await page.locator('global-dialog:not([hidden]) global-dialog-action.main').click();
                            await waitHeld(1);
                            // Exercise Escape, not just the explicit close button.
                            await page.keyboard.press('Escape');
                            await open(1); await page.locator(body).fill('Second unsent draft');
                            await release(0, { status: kind === 'escalate-reopen' ? 'escalated' : 'approved' });
                            record.overlayVisible = await page.locator(`#${overlay}`).isVisible();
                            record.draft = await page.locator(body).inputValue();
                            assert.equal(record.overlayVisible, true, 'Earlier completion must not close the newly opened window');
                            assert.equal(record.draft, 'Second unsent draft', 'New draft must survive');
                            assert.equal(await page.locator(`#${overlay} [type="submit"]`).isEnabled(), true);
                        } else if (kind === 'message-list-order') {
                            await page.locator('#messages-tab').click(); await waitHeld(1);
                            await page.locator('#messages-refresh').click(); await waitHeld(2);
                            await release(1, { messages: [message(101, 'New message list')] });
                            await release(0, { messages: [message(100, 'Stale message list')] });
                            record.messages = await page.locator('#message-list').innerText();
                            assert.ok(record.messages.includes('New message list'));
                            assert.ok(!record.messages.includes('Stale message list'));
                        } else if (kind === 'message-read-refresh') {
                            await page.locator('#messages-tab').click();
                            await page.getByRole('button', { name: 'Mark as read', exact: true }).click(); await waitHeld(1);
                            await page.locator('#messages-refresh').click();
                            await page.getByText('New message from refresh', { exact: true }).waitFor();
                            await release(0, { messageID: 100, isRead: true });
                            record.messages = await page.locator('#message-list').innerText();
                            assert.ok(record.messages.includes('New message from refresh'), 'Read acknowledgement must not restore an older list');
                        } else {
                            const isRecord = kind.startsWith('record');
                            await page.locator(isRecord ? '[data-workspace-view="explorer"]' : '[data-workspace-view="audit"]').click();
                            const inspect = page.getByRole('button', { name: isRecord ? 'Inspect full record' : 'Inspect audit details', exact: true });
                            await inspect.nth(0).click(); await waitHeld(1);
                            if (kind.endsWith('view-change')) {
                                await page.locator('[data-workspace-view="queue"]').click();
                                await release(0, isRecord ? { row: { id: 1, name: 'Record one' } } : audit(1));
                                assert.equal(await page.locator(isRecord ? '#record-overlay' : '#audit-overlay').isVisible(), false,
                                    'A detail response must not open a modal over another workspace view');
                            } else {
                                await inspect.nth(1).click(); await waitHeld(2);
                                await release(1, isRecord ? { row: { id: 2, name: 'Record two' } } : audit(2));
                                await release(0, isRecord ? { row: { id: 1, name: 'Record one' } } : audit(1));
                                record.detail = await page.locator(isRecord ? '#record-title' : '#audit-detail-meta').textContent();
                                assert.ok(record.detail.includes(isRecord ? 'Record two' : 'Audit #2'), 'Latest selected detail must win');
                            }
                        }
                        assert.deepEqual(record.errors, [], 'No unhandled browser errors');
                        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                        record.passed = true;
                    } catch (error) { record.error = error.message; }
                    finally {
                        if (repetition === 1 && ['preview-order', 'message-reopen'].includes(kind)) {
                            await page.screenshot({ path: `${output}/${engine}-${width}-${kind}.png`, fullPage: true });
                        }
                        // Always release outstanding fixture gates before closing the browser/server.
                        held.forEach(item => item.resolve({ payload: {}, status: 503 }));
                        await page.close(); await app.close();
                        console.log(JSON.stringify({ engine, width, kind, repetition, passed: record.passed, error: record.error }));
                    }
                }
            }
        }
    } finally { await browser.close(); }
}
const passed = results.filter(value => value.passed).length;
await writeFile(`${output}/results.json`, JSON.stringify({ scope: 'Isolated synthetic moderation data, real browser UI, no production mutations.',
    baseline, passed, total: results.length, results }, null, 2));
console.log(JSON.stringify({ passed, total: results.length, output }));
if (!observe && passed !== results.length) process.exitCode = 1;
