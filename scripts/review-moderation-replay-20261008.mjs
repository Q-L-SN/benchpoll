import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import vm from 'node:vm';
import * as transactionCleanup from '../db-transaction.js';
import { createModerationAuditRecorder, insertModerationAuditLog, moderationAuditSnapshot } from '../moderation-admin.js';
import { requireAccountWriteOwner } from '../public/js/shared/account-identity.js';
import { readWriteIdentity, claimWriteIntent, completeWriteIntent } from '../write-idempotency.js';
import { lockTopicReferences } from '../topic-reference-service.js';
import { resolveArenaSyncConflict } from '../arena-sync-conflicts.js';
import { arenaRowHash } from '../arena-import-plan.js';

export const decisionCases = ['approve', 'reject', 'apply', 'escalate', 'source', 'correction'];
export function decisionRoute(scenario) {
    return ['approve', 'reject'].includes(scenario) ? 'review_moderation_log'
        : scenario === 'apply' ? 'apply_moderation_log' : scenario === 'escalate' ? 'escalate_moderation_log'
            : 'resolve_score_sync_conflict';
}

export async function createModerationMutationHarness({ scenario = 'approve', source, failBusiness = false,
    graphLockAvailable = true } = {}) {
    assert.ok(decisionCases.includes(scenario));
    source ??= await readFile(new URL('../server.js', import.meta.url), 'utf8');
    const records = [], events = [], writeRows = new Map(), handlers = new Map();
    const requiresGraphLock = ['approve', 'reject', 'apply'].includes(scenario);
    const log = { ID: 901, status: 'pending', report_count: 1, user_id: '1',
        content: JSON.stringify({ schemaVersion: 1, type: 'feedback', details: 'Isolated review feedback.', pageURL: '' }),
        created_at: '2026-10-08T00:00:00.000Z', updated_at: '2026-10-08T01:00:00.000Z' };
    const incoming = { leaderboard_publish_date: '2026-10-08', score: 42.5 };
    let conflict = { row_key: 'a'.repeat(64), result_ID: 110, tracked_result_ID: 110, incoming_hash: arenaRowHash(incoming),
        incoming_row: JSON.stringify(incoming), source_revision: 'b'.repeat(40), manual_override: 'edit',
        result_status: 'accepted', status: 'pending' };
    let serial = 0, mutations = 0, clockOffset = 0, connectionSequence = 0;
    let graphLock = Promise.resolve(), graphOwner = null;
    class Clock extends Date { static now() { return Date.now() + clockOffset; } }
    const makeConnection = () => {
        const connectionID = ++connectionSequence;
        let journal = [], transaction = 0, activeTransaction = false, releaseGraphLock = null;
        const record = (kind, extra = {}) => events.push({ kind, connectionID, transaction, ...extra });
        const unlock = () => {
            if (!releaseGraphLock) return;
            assert.equal(graphOwner, connectionID);
            graphOwner = null;
            record('graph-lock-released');
            releaseGraphLock();
            releaseGraphLock = null;
        };
        return {
            async beginTransaction() {
                assert.equal(activeTransaction, false, 'Do not implicitly commit an active transaction');
                journal = []; activeTransaction = true; transaction++;
                record('begin');
            },
            async execute(sql, parameters = []) {
                assert.equal(activeTransaction, true, 'Decision SQL requires a live transaction');
                const statement = sql.replace(/\s+/g, ' ').trim();
                record('sql', { sql: statement, parameters: structuredClone(parameters) });
                if (statement === 'SELECT ID FROM topic_reference_lock WHERE ID = 1 FOR UPDATE') {
                    if (!graphLockAvailable) return [[], []];
                    if (!releaseGraphLock) {
                        const preceding = graphLock;
                        graphLock = new Promise(resolve => { releaseGraphLock = resolve; });
                        await preceding;
                        assert.equal(graphOwner, null, 'Only one transaction may hold the graph lock');
                        graphOwner = connectionID;
                        record('graph-lock-acquired');
                    }
                    return [[{ ID: 1 }], []];
                }
                if (sql.includes('INSERT INTO write_requests')) {
                    if (requiresGraphLock) assert.equal(graphOwner, connectionID, 'Graph lock precedes the write intent');
                    const [actor, key, action, payload_hash, owner_token] = parameters, rowKey = `${actor}:${key}`;
                    if (!writeRows.has(rowKey)) journal.push({ table: 'write_requests', rowKey,
                        data: { action, payload_hash, owner_token, response_status: null, response_body: null } });
                    return [{ affectedRows: 1 }, []];
                }
                if (sql.includes('FROM write_requests')) {
                    const rowKey = parameters.join(':');
                    return [[journal.find(item => item.rowKey === rowKey)?.data ?? writeRows.get(rowKey)], []];
                }
                if (sql.includes('UPDATE write_requests SET response_status')) {
                    const [status, body, actor, key, owner] = parameters;
                    const row = journal.find(item => item.rowKey === `${actor}:${key}`)?.data;
                    assert.equal(row?.owner_token, owner);
                    row.response_status = status; row.response_body = body;
                    return [{ affectedRows: 1 }, []];
                }
                if (sql.includes('FROM users')) return [[{ ID: parameters[0], email: 'isolated@example.test' }], []];
                if (sql.includes('FROM moderation_logs')) return [[structuredClone(log)], []];
                if (sql.includes('FROM arena_sync_conflicts c JOIN')) return [conflict ? [structuredClone(conflict)] : [], []];
                if (/INSERT INTO (?:moderation_audit_logs|moderation_email_outbox)/.test(sql)) {
                    const table = sql.match(/INSERT INTO (\w+)/)[1], ID = ++serial;
                    journal.push({ table, ID, parameters });
                    return [{ insertId: ID, affectedRows: 1 }, []];
                }
                if (/UPDATE moderation_logs SET/.test(sql)) {
                    if (failBusiness) throw { status: 503, body: { error: 'synthetic_business_failure' } };
                    const patch = sql.includes('content = ?') ? { content: parameters[0],
                        ...(sql.includes("status = 'approved'") ? { status: 'approved' }
                            : sql.includes('status = ?') ? { status: parameters[1] } : {}) }
                        : { status: parameters[0] };
                    journal.push({ table: 'moderation_mutation', patch });
                    return [{ affectedRows: 1 }, []];
                }
                if (sql.includes('UPDATE arena_sync_conflicts SET')) {
                    if (failBusiness) throw { status: 503, body: { error: 'synthetic_business_failure' } };
                    journal.push({ table: 'source_mutation', choice: 'source' });
                    return [{ affectedRows: 1 }, []];
                }
                if (sql.includes('UPDATE arena_import_rows SET')) {
                    if (failBusiness) throw { status: 503, body: { error: 'synthetic_business_failure' } };
                    journal.push({ table: 'source_mutation', choice: 'correction' });
                    return [{ affectedRows: 1 }, []];
                }
                if (sql.includes('DELETE FROM arena_sync_conflicts')) { journal.push({ table: 'source_delete' }); return [{ affectedRows: 1 }, []]; }
                throw Error(`Unhandled isolated decision statement: ${sql}`);
            },
            async query() { return [[{ acquired: 1 }], []]; },
            async commit() {
                for (const row of journal) {
                    if (row.table === 'write_requests') writeRows.set(row.rowKey, structuredClone(row.data));
                    else if (row.table === 'moderation_mutation') { Object.assign(log, row.patch); mutations++; }
                    else if (row.table === 'source_mutation') { if (row.choice === 'source') conflict.status = 'accept_source'; mutations++; }
                    else if (row.table === 'source_delete') conflict = null;
                }
                records.push(...journal); journal = []; activeTransaction = false;
                record('commit'); unlock();
            },
            async rollback() { journal = []; activeTransaction = false; record('rollback'); unlock(); },
            release() { assert.equal(activeTransaction, false); record('release'); unlock(); },
            destroy() { journal = []; activeTransaction = false; record('destroy'); unlock(); }
        };
    };
    // Isolate decision replay from the separately tested terms prerequisite.
    const passCurrentTerms = (_req, _res, next) => next();
    const context = vm.createContext({ ...transactionCleanup, crypto, Buffer, URL, Date: Clock, structuredClone, sessionSecret: 'isolated-signing-fixture',
        db: { getConnection: async () => makeConnection() }, readWriteIdentity, claimWriteIntent, completeWriteIntent,
        lockTopicReferences, topicHome: { invalidate() { events.push({ kind: 'invalidate' }); } },
        searchPresentation: { invalidate() {} },
        createModerationAuditRecorder, insertModerationAuditLog, moderationAuditSnapshot, resolveArenaSyncConflict,
        requireReviewerAuthForAPI: (_req, _res, next) => next(), requireAccountWriteOwner,
        requireCurrentTermsForAPI: passCurrentTerms,
        moderationEmailService: { enqueue: async (connection, details) => {
            const [result] = await connection.execute('INSERT INTO moderation_email_outbox VALUES (?)', [details]);
            return { ID: result.insertId, recipientAvailable: true, deliveryConfigured: false };
        }, kick() {} },
        API: { post(path, ...callbacks) { handlers.set(path, callbacks); } }, console: { error() {} }
    });
    const contractStart = source.indexOf('function normalizeString(');
    const contractEnd = source.indexOf('async function buildExecutedModerationSQLPreview(', contractStart);
    assert.ok(contractStart > 0 && contractEnd > contractStart);
    vm.runInContext(source.slice(contractStart, contractEnd), context);
    const previewStart = source.indexOf('function moderationTimestamp(');
    vm.runInContext(source.slice(previewStart, source.indexOf("API.post('/submit_contribution'", previewStart)), context);
    const helpersStart = source.indexOf('function directMutationAuditError(');
    vm.runInContext(source.slice(helpersStart, source.indexOf("API.post('/send_admin_message'", helpersStart)), context);
    const route = decisionRoute(scenario), start = source.indexOf(`API.post('/${route}'`);
    vm.runInContext(source.slice(start, source.indexOf('\n});', start) + '\n});'.length), context);
    const callbacks = handlers.get(`/${route}`);
    assert.equal(callbacks.length, 4, 'Role, owner and terms guards stay registered');
    assert.equal(callbacks[1], requireAccountWriteOwner);
    assert.equal(callbacks[2], passCurrentTerms);
    const body = ['source', 'correction'].includes(scenario) ? { rowKey: conflict.row_key, resultID: 110,
        incomingHash: conflict.incoming_hash, choice: scenario }
        : scenario === 'escalate' ? { ID: 901, note: 'An isolated escalation.' }
            : scenario === 'apply' ? { ID: 901, content: { schemaVersion: 1, type: 'feedback', details: 'Edited isolated feedback.', pageURL: '' } }
                : { ID: 901, status: scenario === 'approve' ? 'approved' : 'rejected' };
    const preview = (edited, actor = '1') => {
        context.__edited = edited;
        context.__log = structuredClone(log);
        context.__actor = actor;
        return { sql: '-- Isolated preview presentation; actual signed preview and content validation.', previewToken: vm.runInContext(`(() => {
            const actionAt = new Date().toISOString();
            const content = prepareEditedModerationContent(parseModerationContent(__log.content), __edited, __actor, actionAt);
            return createModerationPreviewToken({ moderationLogID: 901, reviewerUserID: __actor,
                updatedAt: moderationTimestamp(__log.updated_at), actionAt, content });
        })()`, context) };
    };
    if (scenario === 'apply') body.previewToken = preview(body.content).previewToken;
    return {
        route, body, records, events, log, preview,
        sourceConflict() { return structuredClone(conflict); },
        setBusinessFailure(value) { failBusiness = value; },
        setGraphLockAvailable(value) { graphLockAvailable = value; },
        advanceClock(ms) { clockOffset += ms; },
        async invoke(input = body, key = crypto.randomUUID(), actor = '1') {
            const req = { body: { ...structuredClone(input), expectedUserID: input.expectedUserID ?? actor },
                session: { userID: actor }, user: { ID: actor }, headers: { 'idempotency-key': key } };
            const response = { status: 200, body: null };
            const res = { status(value) { response.status = value; return this; }, json(value) { response.body = value; } };
            for (const callback of callbacks.slice(0, -1)) {
                let error; callback(req, res, value => { error = value; }); if (error) throw error;
            }
            await callbacks.at(-1)(req, res);
            return response;
        },
        summary() { return { mutations, replayRows: writeRows.size,
            successAudits: records.filter(row => row.table === 'moderation_audit_logs' && row.parameters[11] === 'success').length,
            failureAudits: records.filter(row => row.table === 'moderation_audit_logs' && row.parameters[11] === 'failure').length,
            outbox: records.filter(row => row.table === 'moderation_email_outbox').length }; }
    };
}

export async function runDecisionReplayProbe({ scenario, source } = {}) {
    const harness = await createModerationMutationHarness({ scenario, source });
    const key = crypto.randomUUID(), responses = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
        try { responses.push({ attempt, delivered: attempt === 2, ...await harness.invoke(harness.body, key) }); }
        catch (error) { responses.push({ attempt, status: error.status ?? 500, error: error.body?.error ?? error.message }); }
    }
    const summary = harness.summary();
    return { scenario, route: harness.route, ...summary, responses,
        passed: responses.every(response => response.status === 200) && summary.mutations === 1 && summary.successAudits === 1
            && summary.failureAudits === 0 && JSON.stringify(responses[0].body) === JSON.stringify(responses[1].body),
        scope: 'Actual decision/parser/preview/owner/source-resolution/audit code; SQL, role/session and email transport are fixtures, no production data.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const output = process.argv.find(value => value.startsWith('--output='))?.slice(9)
        ?? 'artifacts/review-20261008/moderation-replay-before';
    const results = [];
    for (const scenario of decisionCases) for (let repetition = 1; repetition <= 2; repetition++) {
        const result = { ...await runDecisionReplayProbe({ scenario }), repetition };
        results.push(result); console.log(JSON.stringify(result));
    }
    await mkdir(output, { recursive: true });
    await writeFile(`${output}/results.json`, JSON.stringify({ passed: results.filter(result => result.passed).length,
        total: results.length, results }, null, 2));
    if (!process.argv.includes('--observe') && results.some(result => !result.passed)) process.exitCode = 1;
}
