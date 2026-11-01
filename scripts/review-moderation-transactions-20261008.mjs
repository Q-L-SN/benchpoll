import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { createModerationAuditRecorder, insertModerationAuditLog } from '../moderation-admin.js';
import { requireAccountWriteOwner } from '../public/js/shared/account-identity.js';
import { readWriteIdentity, claimWriteIntent, completeWriteIntent } from '../write-idempotency.js';
import { lockTopicReferences } from '../topic-reference-service.js';
import { randomUUID } from 'node:crypto';
import * as transactionCleanup from '../db-transaction.js';

export const mutationRoutes = ['send_admin_message', 'resolve_score_sync_conflict',
    'escalate_moderation_log', 'apply_moderation_log', 'review_moderation_log'];

export async function runFailureAuditProbe({ route, capacity = 10, auditFailure = false,
    rollbackFailure = false, lockReleaseFailure = false, source, timeoutMs = 100 } = {}) {
    source ??= await readFile(new URL('../server.js', import.meta.url), 'utf8');
    const pending = [], events = [], leases = new Set(), messages = [];
    const requiresGraphLock = ['apply_moderation_log', 'review_moderation_log'].includes(route);
    let serial = 0, originalBegins = 0, auditRows = 0, completions = 0, borrowCalls = 0, maxLeases = 0;
    let graphLock = Promise.resolve(), graphOwner = null;
    let releaseBarrier;
    const barrier = new Promise(resolve => { releaseBarrier = resolve; });
    let shutdown = false;
    const operationError = { status: 409, body: { error: 'synthetic_operation_failure' } };
    const makeConnection = () => {
        const ID = ++serial;
        let transaction = 0, released = false, activeTransaction = false, destroyed = false;
        let claim = null, releaseGraphLock = null;
        const unlock = () => {
            if (!releaseGraphLock) return;
            assert.equal(graphOwner, ID);
            graphOwner = null;
            events.push({ ID, action: 'graph-lock-released', transaction });
            releaseGraphLock();
            releaseGraphLock = null;
        };
        const connection = {
            async beginTransaction() {
                if (destroyed) throw new Error('Started transaction on destroyed connection');
                if (activeTransaction) events.push({ ID, action: 'implicit-commit' });
                activeTransaction = true;
                events.push({ ID, action: 'begin', transaction: ++transaction });
                if (ID <= capacity && transaction === 1) {
                    if (++originalBegins === capacity) releaseBarrier();
                    await barrier;
                }
            },
            async rollback() {
                events.push({ ID, action: 'rollback', transaction });
                if (rollbackFailure && ID <= capacity && transaction === 1) throw new Error('Synthetic rollback failure');
                activeTransaction = false; claim = null; unlock();
            },
            async commit() { activeTransaction = false; events.push({ ID, action: 'commit', transaction }); unlock(); },
            async execute(sql, parameters = []) {
                if (released || destroyed) throw new Error('Executed on unavailable connection');
                if (sql.replace(/\s+/g, ' ').trim() === 'SELECT ID FROM topic_reference_lock WHERE ID = 1 FOR UPDATE') {
                    assert.equal(activeTransaction, true, 'Graph lock requires a live transaction');
                    events.push({ ID, action: 'graph-lock-requested', transaction });
                    if (!releaseGraphLock) {
                        const preceding = graphLock;
                        graphLock = new Promise(resolve => { releaseGraphLock = resolve; });
                        await preceding;
                        assert.equal(graphOwner, null, 'Only one transaction may hold the graph lock');
                        graphOwner = ID;
                        events.push({ ID, action: 'graph-lock-acquired', transaction });
                    }
                    return [[{ ID: 1 }], []];
                }
                if (sql.includes('INSERT INTO write_requests')) {
                    if (requiresGraphLock) assert.equal(graphOwner, ID, 'Graph lock precedes the write intent');
                    events.push({ ID, action: 'claim-write-intent', transaction });
                    claim = { action: parameters[2], payload_hash: parameters[3], owner_token: parameters[4], response_status: null };
                    return [{ affectedRows: 1 }, []];
                }
                if (sql.includes('FROM write_requests')) return [[claim], []];
                if (sql.includes('INSERT INTO moderation_audit_logs')) {
                    events.push({ ID, action: 'audit', transaction, parameters });
                    if (auditFailure) throw new Error('Synthetic failure audit insert failure');
                    return [{ insertId: ++auditRows }, []];
                }
                if (sql.includes('INSERT INTO admin_messages')) throw operationError;
                if (sql.includes('FROM moderation_logs')) return [[{ ID: 901, status: 'approved',
                    user_id: '1', content: JSON.stringify({ type: 'feedback', details: 'Fixture' }) }], []];
                throw new Error(`Unhandled isolated statement: ${sql}`);
            },
            async query(sql) {
                if (destroyed) throw new Error('Queried destroyed connection');
                events.push({ ID, action: /RELEASE_LOCK/.test(sql) ? 'release-lock' : 'get-lock' });
                if (lockReleaseFailure && /RELEASE_LOCK/.test(sql)) throw new Error('Synthetic advisory lock cleanup failure');
                return [[{ acquired: 1 }], []];
            },
            destroy() {
                if (destroyed) return;
                destroyed = true; activeTransaction = false;
                events.push({ ID, action: 'destroy' }); unlock(); leases.delete(connection);
                if (!shutdown && pending.length) pending.shift().resolve(acquire());
            },
            release() {
                assert.equal(released, false, 'A connection must not be released twice');
                assert.equal(activeTransaction, false, 'Do not release a live transaction');
                assert.equal(releaseGraphLock, null, 'Transaction cleanup releases the graph lock');
                released = true; events.push({ ID, action: 'release' }); leases.delete(connection);
                if (!shutdown && pending.length) pending.shift().resolve(acquire());
            }
        };
        leases.add(connection); maxLeases = Math.max(maxLeases, leases.size);
        return connection;
    };
    const acquire = () => makeConnection();
    const pool = {
        async getConnection() {
            borrowCalls += 1;
            if (leases.size < capacity) return acquire();
            return new Promise((resolve, reject) => { pending.push({ resolve, reject }); });
        }
    };
    const handlers = new Map();
    // Isolate transaction failures from the separately tested terms prerequisite.
    const passCurrentTerms = (_req, _res, next) => next();
    const context = vm.createContext({ ...transactionCleanup, db: pool, createModerationAuditRecorder, insertModerationAuditLog,
        readWriteIdentity, claimWriteIntent, completeWriteIntent, lockTopicReferences,
        topicHome: { invalidate() { events.push({ action: 'invalidate' }); } },
        structuredClone, console: { error: (...args) => messages.push(args.map(String).join(' ')) },
        normalizeString: value => String(value).trim(), normalizeRequiredPositiveInteger: Number,
        getModerationStatus: value => value, parseModerationPreviewToken: () => ({ moderationLogID: 901, reviewerUserID: '1' }),
        requireReviewerAuthForAPI: (_req, _res, next) => next(), requireAccountWriteOwner,
        requireCurrentTermsForAPI: passCurrentTerms,
        moderationEmailService: {
            async enqueue() { events.push({ action: 'email-enqueue' }); throw new Error('Failed moderation must not enqueue email'); },
            kick() { events.push({ action: 'email-kick' }); throw new Error('Failed moderation must not kick email'); }
        },
        requireAdminMessagesSchema: async () => {}, resolveArenaSyncConflict: async () => { throw operationError; },
        API: { post(path, ...callbacks) { handlers.set(path, callbacks); } } });
    const emailHelpersStart = source.indexOf('async function enqueueModerationDecisionEmail(');
    const emailHelpersEnd = source.indexOf('function getModerationStatus(', emailHelpersStart);
    assert.ok(emailHelpersStart > 0 && emailHelpersEnd > emailHelpersStart);
    vm.runInContext(source.slice(emailHelpersStart, emailHelpersEnd), context);
    const helpersStart = source.indexOf('function directMutationAuditError(');
    const helpersEnd = source.indexOf("API.post('/send_admin_message'", helpersStart);
    assert.ok(helpersStart > 0 && helpersEnd > helpersStart);
    vm.runInContext(source.slice(helpersStart, helpersEnd), context);
    const start = source.indexOf(`API.post('/${route}'`);
    const next = source.indexOf('\n});', start + 1) + '\n});'.length;
    assert.ok(start >= 0 && next > start);
    vm.runInContext(source.slice(start, next), context);
    const callbacks = handlers.get(`/${route}`);
    assert.equal(callbacks.length, 4, 'Role, owner and terms guards stay registered');
    assert.equal(callbacks[1], requireAccountWriteOwner);
    assert.equal(callbacks[2], passCurrentTerms);
    const tasks = Array.from({ length: capacity }, async () => {
        const req = { body: { expectedUserID: '1', ID: 901, status: 'approved', body: 'Fixture message', note: 'Fixture escalation' },
            session: { userID: '1' }, user: { ID: '1' }, headers: { 'idempotency-key': randomUUID() } };
        const res = { json() { throw new Error('Failure fixture must not report success'); } };
        try {
            for (const middleware of callbacks.slice(0, -1)) {
                let error; middleware(req, res, value => { error = value; }); if (error) throw error;
            }
            await callbacks.at(-1)(req, res);
            return { completed: true, unexpectedSuccess: true };
        } catch (error) {
            if (shutdown) return { shutdown: true };
            completions += 1;
            return { completed: true, error: error.body?.error ?? error.message ?? `HTTP ${error.status}` };
        }
    });
    let timer;
    const terminal = await Promise.race([Promise.all(tasks), new Promise(resolve => {
        timer = setTimeout(() => resolve(null), timeoutMs);
    })]);
    clearTimeout(timer);
    const result = { route, capacity, auditFailure, rollbackFailure, lockReleaseFailure, completed: completions,
        pendingBorrows: pending.length, retainedLeases: leases.size, borrowCalls, maxLeases, auditRows,
        outcomes: terminal, messages, events,
        scope: 'Actual server callback/helper source and real audit recorder; simulated bounded leases/SQL, no production database.' };
    // Terminate only this isolated lease queue after recording the stuck state.
    shutdown = true;
    pending.splice(0).forEach(item => item.reject(new Error('Isolated probe shutdown')));
    releaseBarrier();
    await Promise.all(tasks);
    return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const observe = process.argv.includes('--observe');
    const output = process.argv.find(value => value.startsWith('--output='))?.slice(9)
        ?? 'artifacts/review-20261008/moderation-transactions-after';
    const results = [];
    for (const route of mutationRoutes) for (let repetition = 1; repetition <= 2; repetition++) {
        const result = await runFailureAuditProbe({ route });
        result.repetition = repetition;
        result.passed = result.completed === result.capacity && result.pendingBorrows === 0
            && result.retainedLeases === 0 && result.auditRows === result.capacity;
        results.push(result);
        console.log(JSON.stringify({ route, repetition, completed: result.completed,
            pendingBorrows: result.pendingBorrows, retainedLeases: result.retainedLeases,
            auditRows: result.auditRows, passed: result.passed }));
    }
    await mkdir(output, { recursive: true });
    await writeFile(`${output}/results.json`, JSON.stringify({ passed: results.filter(value => value.passed).length,
        total: results.length, results }, null, 2));
    if (!observe && results.some(value => !value.passed)) process.exitCode = 1;
}
