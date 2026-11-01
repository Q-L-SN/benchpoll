import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { request } from 'node:https';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { applyFieldContribution } from '../score-field-service.js';

const database = process.env.BENCHPOLL_DB_NAME;
if (!database?.endsWith('_score_fields_rehearsal')) throw Error('API verification requires the isolated rehearsal database');
const db = await mysql.createConnection({ socketPath: '/var/run/mysqld/mysqld.sock', user: 'root', database });
const [[user]] = await db.execute("SELECT ID FROM users WHERE role = 'senior' AND deleted_at IS NULL LIMIT 1");
assert.ok(user);
const sessionID = randomUUID();
await db.execute('INSERT INTO sessions (session_id, expires, data) VALUES (?, ?, ?)', [sessionID, Math.floor(Date.now() / 1000) + 600,
    JSON.stringify({ cookie: { originalMaxAge: 600000, expires: new Date(Date.now() + 600000).toISOString(), httpOnly: true, path: '/' }, userID: user.ID })]);
const cookie = 'sid=' + encodeURIComponent('s:' + sessionID + '.' + createHmac('sha256', process.env.SESSION_SECRET).update(sessionID).digest('base64').replace(/=+$/, ''));
const env = { ...process.env, BENCHPOLL_DB_NAME: database, BENCHPOLL_DB_USER: 'root', BENCHPOLL_DB_SOCKET: '/var/run/mysqld/mysqld.sock',
    BENCHPOLL_PORT: '2337', BENCHPOLL_BIND_HOST: '127.0.0.1', PUBLIC_ORIGIN: 'https://127.0.0.1:2337' };
for (const key of ['BENCHPOLL_SMTP_HOST', 'BENCHPOLL_SMTP_PORT', 'BENCHPOLL_SMTP_SECURE', 'BENCHPOLL_SMTP_USER', 'BENCHPOLL_SMTP_PASSWORD', 'BENCHPOLL_NOTIFICATION_FROM']) env[key] = '';
const child = spawn(process.execPath, ['server.js'], { cwd: fileURLToPath(new URL('../', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
function api(path, body, authenticated = true) {
    return new Promise((resolve, reject) => {
        const req = request(`https://127.0.0.1:2337/api/${path}`, { method: 'POST', rejectUnauthorized: false,
            headers: { 'Content-Type': 'application/json', ...(authenticated ? { Cookie: cookie } : {}) } }, res => {
            let data = ''; res.on('data', chunk => { data += chunk; });
            res.on('end', () => { try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); } catch (error) { reject(error); } });
        });
        req.on('error', reject); req.end(JSON.stringify(body));
    });
}
async function submit(body, status = 204) {
    const response = await api('submit_contribution', body);
    assert.equal(response.status, status, JSON.stringify(response.body)); return response.body;
}
try {
    for (let attempt = 0; ; attempt++) {
        try { await api('get_weighted_workspace', {}, false); break; }
        catch (error) { if (attempt >= 40) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    const name = `API harness ${randomUUID()}`;
    const definition = { name, type: 'enum', allowEmpty: true, excludeMissing: true, excludeEmpty: true, options: [{ label: 'Alpha', excluded: false }, { label: 'Unknown', excluded: true }] };
    await submit({ type: 'score_field', operation: 'create', definition, notes: '' });
    const catalog = (await api('get_contribution_catalog', {})).body;
    const field = catalog.scoreFields.find(item => item.name === name); assert.ok(field?.ID);
    const option = field.options.find(item => item.label === 'Alpha');
    const [[sample]] = await db.execute("SELECT model_ID, benchmark_ID, benchmark_condition_ID, raw_score FROM benchmark_results WHERE status = 'accepted' ORDER BY ID LIMIT 1");
    const result = { clientRef: 'api-score', modelID: Number(sample.model_ID), benchmarkID: Number(sample.benchmark_ID),
        benchmarkConditionID: Number(sample.benchmark_condition_ID), rawScore: Number(sample.raw_score), scoreFields: [{ fieldID: field.ID, value: option.ID }],
        source: { type: 'other', url: 'https://example.com/score-fields-api-test', title: '' } };
    await submit({ type: 'benchmark_result', results: [result], reviewerNotes: '' });
    const details = await api('get_approved_benchmark_results', { modelID: result.modelID, scoreFields: result.scoreFields });
    assert.equal(details.status, 200, JSON.stringify(details.body)); assert.equal(details.body.scoreGroups.length, 1);
    const workspace = await api('get_weighted_workspace', { comparison: { mode: 'best', keys: [], filters: [{ key: `field:${field.ID}`, operator: 'eq', value: option.ID }] } });
    assert.equal(workspace.status, 200, JSON.stringify(workspace.body));
    assert.equal(workspace.body.modelLeaderboards.public.length, 1);
    const none = await api('get_weighted_workspace', { comparison: { mode: 'matched', keys: [] } });
    assert.equal(none.status, 400); assert.equal(none.body.error, 'comparison_key_required');
    await submit({ type: 'score_field_option', operation: 'update', targetID: option.ID, revision: option.revision, fieldID: field.ID, label: 'Renamed Alpha', excluded: false, notes: '' });
    const afterRename = await api('get_approved_benchmark_results', { modelID: result.modelID, scoreFields: result.scoreFields });
    assert.equal(afterRename.status, 200); assert.equal(afterRename.body.scoreGroups.length, 1);
    // The same session becomes a normal contributor only in this disposable database.
    await db.execute("UPDATE users SET role = 'user' WHERE ID = ?", [user.ID]);
    const pendingName = `Pending field ${randomUUID()}`;
    await submit({ type: 'score_field', operation: 'create', definition: { ...definition, name: pendingName, type: 'presence', allowEmpty: false, excludeEmpty: false, options: [] }, notes: '' });
    const pendingCatalog = (await api('get_contribution_catalog', {})).body;
    const pending = pendingCatalog.scoreFields.find(item => item.name === pendingName); assert.ok(pending?.pending);
    await submit({ type: 'benchmark_result', results: [{ ...result, scoreFields: [{ fieldRequestID: pending.requestID, value: null }] }], reviewerNotes: '' });
    await db.execute("UPDATE moderation_logs SET status = 'rejected' WHERE ID = ?", [pending.requestID]);
    const rejected = await submit({ type: 'benchmark_result', results: [{ ...result, scoreFields: [{ fieldRequestID: pending.requestID, value: null }] }], reviewerNotes: '' }, 409);
    assert.equal(rejected.error, 'field_reference_rejected');
    const enumName = `Pending enum ${randomUUID()}`;
    await submit({ type: 'score_field', operation: 'create', definition: { ...definition, name: enumName }, notes: '' });
    const enumPending = (await api('get_contribution_catalog', {})).body.scoreFields.find(item => item.name === enumName);
    const pendingScore = { ...result, scoreFields: [{ fieldRequestID: enumPending.requestID, optionIndex: 0 }] };
    await submit({ type: 'benchmark_result', results: [pendingScore], reviewerNotes: '' });
    const [[proposal]] = await db.execute('SELECT content FROM moderation_logs WHERE ID = ?', [enumPending.requestID]);
    const content = typeof proposal.content === 'string' ? JSON.parse(proposal.content) : proposal.content;
    content.definition.options[0].label = 'Reviewed label';
    await db.beginTransaction();
    await applyFieldContribution(db, content, { moderationLogID: enumPending.requestID });
    await db.execute("UPDATE moderation_logs SET status = 'approved', content = ? WHERE ID = ?", [JSON.stringify(content), enumPending.requestID]);
    await db.commit();
    const approvedField = (await api('get_contribution_catalog', {})).body.scoreFields.find(item => item.requestID === enumPending.requestID);
    assert.ok(approvedField.ID); assert.equal(approvedField.options.find(item => item.pendingIndex === 0).label, 'Reviewed label');
    await db.execute("UPDATE users SET role = 'senior' WHERE ID = ?", [user.ID]);
    await submit({ type: 'benchmark_result', results: [pendingScore], reviewerNotes: '' });
    const [[audit]] = await db.execute("SELECT COUNT(*) AS n FROM moderation_audit_logs WHERE request_type IN ('score_field', 'score_field_option')");
    assert.ok(Number(audit.n) >= 2);
    console.log(JSON.stringify({ apiVerified: true, seniorApplyAudited: true, scoreEvidence: true, valueFilters: true, pendingReferences: true, rejectedReferencesBlocked: true }));
} catch (error) {
    console.error(output.replace(/email[^\n]*/gi, 'email [redacted]')); throw error;
} finally {
    if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; }
    await db.execute("UPDATE users SET role = 'senior' WHERE ID = ?", [user.ID]);
    await db.end();
}
