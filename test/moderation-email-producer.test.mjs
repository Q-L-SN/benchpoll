import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';
import * as transactions from '../db-transaction.js';
import { canonicalAccountID, requireAccountWriteOwner } from '../public/js/shared/account-identity.js';
import { readWriteIdentity, claimWriteIntent, completeWriteIntent } from '../write-idempotency.js';
import { createModerationAuditRecorder, insertModerationAuditLog, moderationAuditSnapshot } from '../moderation-admin.js';
import { createModerationEmailService } from '../moderation-email.js';
import { lockTopicReferences } from '../topic-reference-service.js';

const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
const contributorID = '9007199254740993';
const reviewerID = '9007199254740992';
const now = Date.now();
const feedback = { schemaVersion: 1, type: 'feedback', pageURL: '', details: 'Synthetic producer feedback.' };
const scenarios = ['approve', 'reject', 'apply', 'senior-submit', 'pending-submit'];
const mailScenarios = scenarios.filter(value => value !== 'pending-submit');
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

function evaluateRange(context, startText, endText, includeEnd = false) {
    const start = source.indexOf(startText), end = source.indexOf(endText, start);
    assert.ok(start >= 0 && end > start, `Production range exists: ${startText}`);
    vm.runInContext(source.slice(start, end + (includeEnd ? endText.length : 0)), context);
}

function createHarness({ scenario = 'approve', user = {}, failure = null, kickFailure = null,
    responseFailure = false, pauseEnqueue = false, pauseCommit = false, graphLockAvailable = true } = {}) {
    const submitting = scenario.endsWith('-submit');
    const actor = submitting ? contributorID : reviewerID;
    const route = submitting ? 'submit_contribution' : scenario === 'apply' ? 'apply_moderation_log' : 'review_moderation_log';
    const account = user === null ? null : { ID: contributorID, email: 'contributor@example.test',
        email_verified_at: new Date(now - 60_000), deleted_at: null, banned_at: null, banned_until: null, ...user };
    const state = { logs: new Map(submitting ? [] : [[901, { ID: 901, status: 'pending', report_count: 1,
        user_id: contributorID, content: JSON.stringify(feedback), created_at: new Date(now - 60_000),
        updated_at: new Date(now - 30_000) }]]), writes: new Map(), outbox: new Map(), audits: [] };
    const events = [], handlers = new Map(), locks = new Map();
    const enteredEnqueue = deferred(), resumeEnqueue = deferred();
    const enteredCommit = deferred(), resumeCommit = deferred();
    let sequence = 1000, connectionSequence = 0;
    const clone = value => structuredClone(value);
    const makeConnection = () => {
        const connectionID = ++connectionSequence;
        let transaction = 0, journal, held = [];
        const heldKeys = new Set();
        const record = (kind, extra = {}) => events.push({ kind, connectionID, transaction, ...extra });
        const unlock = () => { heldKeys.clear(); for (const release of held.splice(0)) release(); };
        const lock = async key => {
            if (heldKeys.has(key)) return;
            const preceding = locks.get(key) ?? Promise.resolve(), ready = deferred();
            locks.set(key, ready.promise);
            await preceding;
            heldKeys.add(key);
            record('lock-acquired', { key });
            held.push(() => { record('lock-released', { key }); ready.resolve(); });
        };
        const getLog = ID => journal.logs.get(ID) ?? state.logs.get(ID);
        return {
            async beginTransaction() {
                transaction++;
                journal = { logs: new Map(), writes: new Map(), outbox: new Map(), audits: [] };
                record('begin');
            },
            async execute(sql, parameters = []) {
                assert.ok(journal, 'All producer SQL uses a live transaction');
                const statement = sql.replace(/\s+/g, ' ').trim();
                record('sql', { sql: statement, parameters: clone(parameters) });
                if (statement === 'SELECT ID FROM topic_reference_lock WHERE ID = 1 FOR UPDATE') {
                    if (!graphLockAvailable) return [[], []];
                    await lock('topic-reference:1');
                    return [[{ ID: 1 }], []];
                }
                if (statement.startsWith('INSERT INTO write_requests')) {
                    if (!submitting) assert.ok(heldKeys.has('topic-reference:1'), 'Graph lock precedes the write intent');
                    const [ownerID, key, action, payload_hash, owner_token] = parameters, rowKey = `${ownerID}:${key}`;
                    await lock(`write:${rowKey}`);
                    if (!state.writes.has(rowKey)) journal.writes.set(rowKey,
                        { action, payload_hash, owner_token, response_status: null, response_body: null });
                    return [{ affectedRows: 1 }, []];
                }
                if (statement.includes('FROM write_requests')) {
                    const key = parameters.join(':');
                    return [[clone(journal.writes.get(key) ?? state.writes.get(key))], []];
                }
                if (statement.startsWith('UPDATE write_requests SET response_status')) {
                    if (failure === 'completion') throw new Error('synthetic_completion_failure');
                    const [status, body, ownerID, key, owner] = parameters, row = journal.writes.get(`${ownerID}:${key}`);
                    assert.equal(row?.owner_token, owner);
                    Object.assign(row, { response_status: status, response_body: body });
                    return [{ affectedRows: 1 }, []];
                }
                if (statement.includes('FROM users')) {
                    let eligible = account && canonicalAccountID(parameters[0]) === contributorID;
                    if (statement.includes('deleted_at IS NULL')) eligible &&= account.deleted_at === null;
                    if (statement.includes('banned_at IS NULL')) eligible &&= account.banned_at === null
                        || account.banned_until !== null && new Date(account.banned_until).getTime() <= now;
                    if (statement.includes('email_verified_at IS NOT NULL')) eligible &&= account.email_verified_at !== null;
                    if (statement.includes('FOR SHARE') && eligible) await lock(`user:${contributorID}:${connectionID}`);
                    return [eligible ? [clone(account)] : [], []];
                }
                if (statement.includes('FROM moderation_logs')) {
                    const ID = Number(parameters[0]);
                    if (statement.includes('FOR UPDATE')) await lock(`log:${ID}`);
                    const log = getLog(ID);
                    return [log ? [clone(log)] : [], []];
                }
                if (statement.startsWith('INSERT INTO moderation_logs')) {
                    const ID = ++sequence;
                    journal.logs.set(ID, { ID, status: 'pending', content: parameters[0], user_id: parameters[2], report_count: 1 });
                    return [{ insertId: ID, affectedRows: 1 }, []];
                }
                if (statement.startsWith('UPDATE moderation_logs SET')) {
                    if (failure === 'business') throw new Error('synthetic_business_failure');
                    const ID = Number(parameters.at(-1)), log = clone(getLog(ID));
                    if (statement.includes('content = ?')) log.content = parameters[0];
                    log.status = statement.includes("status = 'approved'") ? 'approved'
                        : statement.includes('content = ?') ? parameters[1] : parameters[0];
                    journal.logs.set(ID, log);
                    return [{ affectedRows: 1 }, []];
                }
                if (statement.startsWith('INSERT INTO moderation_audit_logs')) {
                    if (failure === 'audit' && parameters[11] === 'success') throw new Error('synthetic_audit_failure');
                    journal.audits.push(clone(parameters));
                    return [{ insertId: ++sequence, affectedRows: 1 }, []];
                }
                if (statement.startsWith('INSERT INTO moderation_email_outbox')) {
                    if (failure === 'outbox') throw new Error('synthetic_outbox_failure');
                    const logID = parameters[0];
                    await lock(`outbox:${logID}`);
                    assert.equal(state.outbox.has(logID), false, 'Unique outbox key');
                    const ID = ++sequence;
                    journal.outbox.set(logID, { ID, parameters: clone(parameters) });
                    return [{ insertId: ID, affectedRows: 1 }, []];
                }
                throw new Error(`Unhandled synthetic SQL: ${statement}`);
            },
            async commit() {
                record('commit-start');
                const businessTransaction = journal.logs.size > 0 || journal.writes.size > 0;
                if (businessTransaction && pauseCommit) { enteredCommit.resolve(); await resumeCommit.promise; }
                if (failure === 'commit-before' && businessTransaction) throw new Error('synthetic_commit_failure');
                if (failure === 'replay-commit' && transaction === 1) throw new Error('synthetic_replay_commit_failure');
                for (const table of ['logs', 'writes', 'outbox']) for (const [key, value] of journal[table]) state[table].set(key, clone(value));
                state.audits.push(...clone(journal.audits));
                journal = null;
                record('commit');
                unlock();
                if (failure === 'commit-ack' && businessTransaction) throw new Error('synthetic_commit_ack_lost');
            },
            async rollback() { record('rollback'); journal = null; unlock(); },
            release() { record('release'); unlock(); },
            destroy() { record('destroy'); journal = null; unlock(); }
        };
    };
    // Never start the worker or invoke its network-facing kick/deliver methods.
    const email = createModerationEmailService({ pool: {}, publicOrigin: 'https://example.test', environment: {}, transport: null });
    const pass = (_req, _res, next) => next();
    const context = vm.createContext({ ...transactions, crypto, Buffer, URL, structuredClone, canonicalAccountID,
        sessionSecret: 'synthetic-preview-signing-secret', db: { getConnection: async () => makeConnection() },
        readWriteIdentity, claimWriteIntent, completeWriteIntent, requireAccountWriteOwner,
        lockTopicReferences, topicHome: { invalidate() { events.push({ kind: 'invalidate' }); } },
        searchPresentation: { invalidate() { events.push({ kind: 'search-invalidate' }); } },
        createModerationAuditRecorder, insertModerationAuditLog, moderationAuditSnapshot,
        requireAuthForAPI: pass, requireReviewerAuthForAPI: pass, requireCurrentTermsForAPI: pass,
        console: { error(...args) { events.push({ kind: 'logged-error', args }); } },
        moderationEmailService: { deliveryConfigured: false, async enqueue(connection, details) {
            events.push({ kind: 'enqueue', details: clone(details) });
            const notification = await email.enqueue(connection, details);
            enteredEnqueue.resolve();
            if (pauseEnqueue) await resumeEnqueue.promise;
            if (failure === 'enqueue-after') throw new Error('synthetic_enqueue_failure');
            return notification;
        }, kick(ID) {
            assert.ok([...state.outbox.values()].some(row => row.ID === ID), 'Kick only sees committed outbox');
            events.push({ kind: 'kick', ID });
            if (kickFailure === 'sync') throw new Error('synthetic_kick_failure');
            if (kickFailure === 'async') return Promise.reject(new Error('synthetic_kick_failure'));
        } }, API: { post(path, ...callbacks) { handlers.set(path, callbacks); } }
    });
    evaluateRange(context, 'function normalizeString(', 'async function buildExecutedModerationSQLPreview(');
    evaluateRange(context, 'function moderationTimestamp(', "API.post('/submit_contribution'");
    evaluateRange(context, 'function directMutationAuditError(', "API.post('/send_admin_message'");
    evaluateRange(context, `API.post('/${route}'`, '\n});', true);
    const body = submitting ? { type: 'feedback', pageURL: '', details: feedback.details }
        : scenario === 'apply' ? { ID: 901, content: { ...feedback, details: 'Edited synthetic feedback.' } }
            : { ID: 901, status: scenario === 'reject' ? 'rejected' : 'approved' };
    if (scenario === 'apply') {
        context.previewInput = body.content;
        context.previewLog = clone(state.logs.get(901));
        context.reviewer = actor;
        body.previewToken = vm.runInContext(`(() => {
            const actionAt = new Date().toISOString();
            const content = prepareEditedModerationContent(parseModerationContent(previewLog.content), previewInput, reviewer, actionAt);
            return createModerationPreviewToken({ moderationLogID: 901, reviewerUserID: reviewer,
                updatedAt: moderationTimestamp(previewLog.updated_at), actionAt, content });
        })()`, context);
    }
    return { state, events, body, account, enteredEnqueue: enteredEnqueue.promise, resumeEnqueue: resumeEnqueue.resolve,
        enteredCommit: enteredCommit.promise, resumeCommit: resumeCommit.resolve,
        setFailure(value) { failure = value; },
        setGraphLockAvailable(value) { graphLockAvailable = value; },
        async invoke(input = body, key = crypto.randomUUID()) {
            const req = { body: clone({ ...input, expectedUserID: actor }), session: { userID: actor },
                user: { ID: actor, isSenior: scenario === 'senior-submit' }, headers: { 'idempotency-key': key } };
            const response = { status: 200, body: null };
            const res = { status(value) { response.status = value; return this; },
                json(value) { events.push({ kind: 'response' }); if (responseFailure) throw new Error('synthetic_response_failure'); response.body = clone(value); return this; },
                end() { events.push({ kind: 'response' }); if (responseFailure) throw new Error('synthetic_response_failure'); return this; } };
            const callbacks = handlers.get(`/${route}`);
            for (const guard of callbacks.slice(0, -1)) {
                let error;
                await guard(req, res, value => { error = value; });
                if (error) throw error;
            }
            await callbacks.at(-1)(req, res);
            return response;
        }
    };
}

for (const scenario of scenarios) test(`${scenario}: review, audit, outbox and idempotency commit together`, async () => {
    const h = createHarness({ scenario }), response = await h.invoke();
    assert.equal(response.status, scenario.endsWith('-submit') ? 204 : 200);
    assert.equal(h.state.logs.size, 1);
    assert.equal([...h.state.logs.values()][0].status, scenario === 'pending-submit' ? 'pending' : scenario === 'reject' ? 'rejected' : 'approved');
    assert.equal(h.state.writes.size, 1);
    assert.equal(h.state.outbox.size, scenario === 'pending-submit' ? 0 : 1);
    assert.equal(h.state.audits.filter(row => row[11] === 'success').length, scenario === 'pending-submit' ? 0 : 1);
    if (!scenario.endsWith('-submit')) {
        const lock = h.events.findIndex(event => event.kind === 'lock-acquired' && event.key === 'topic-reference:1');
        const intent = h.events.findIndex(event => event.sql?.startsWith('INSERT INTO write_requests'));
        assert.ok(lock > h.events.findIndex(event => event.kind === 'begin') && intent > lock);
        assert.equal(h.events.filter(event => event.kind === 'invalidate').length, 1);
        assert.ok(h.events.findIndex(event => event.kind === 'invalidate') > h.events.findIndex(event => event.kind === 'commit'));
    }
    const enqueues = h.events.filter(event => event.kind === 'enqueue');
    if (scenario !== 'pending-submit') {
        assert.equal(enqueues[0].details.userID, contributorID, 'Notify contributor, never reviewer or rounded adjacent ID');
        assert.equal(enqueues[0].details.contributionType, 'feedback');
        const row = [...h.state.outbox.values()][0];
        assert.equal(row.parameters[1], contributorID);
        assert.equal(row.parameters[2], 'contributor@example.test');
        assert.ok(h.events.findIndex(event => event.kind === 'kick') > h.events.findIndex(event => event.kind === 'commit'));
    }
});

for (const scenario of scenarios) test(`${scenario}: neither kick nor HTTP success precedes commit acknowledgement`, async () => {
    const h = createHarness({ scenario, pauseCommit: true }), pending = h.invoke();
    await h.enteredCommit;
    assert.equal(h.state.outbox.size, 0);
    assert.equal(h.state.writes.size, 0);
    assert.equal(h.events.some(event => event.kind === 'kick' || event.kind === 'response'), false);
    assert.equal(h.events.some(event => event.kind === 'invalidate'), false);
    h.resumeCommit();
    await pending;
    assert.equal(h.events.filter(event => event.kind === 'kick').length, scenario === 'pending-submit' ? 0 : 1);
});

for (const scenario of mailScenarios) {
    test(`${scenario}: exact request replay never enqueues or kicks twice`, async () => {
        const h = createHarness({ scenario }), key = crypto.randomUUID();
        assert.deepEqual(await h.invoke(h.body, key), await h.invoke(h.body, key));
        assert.equal(h.state.outbox.size, 1);
        assert.equal(h.events.filter(event => event.kind === 'enqueue').length, 1);
        assert.equal(h.events.filter(event => event.kind === 'kick').length, 1);
        if (!scenario.endsWith('-submit')) assert.equal(h.events.filter(event => event.kind === 'invalidate').length, 1);
    });
    for (const failure of ['business', 'audit', 'outbox', 'enqueue-after', 'completion', 'commit-before']) {
        test(`${scenario}: ${failure} never leaks a notification or a success response`, async () => {
            const h = createHarness({ scenario, failure });
            await assert.rejects(h.invoke(), /synthetic_/);
            assert.equal(h.state.outbox.size, 0);
            assert.equal(h.state.writes.size, 0);
            assert.equal(h.state.audits.filter(row => row[11] === 'success').length, 0);
            assert.equal(h.events.some(event => event.kind === 'kick' || event.kind === 'response'), false);
            assert.equal(h.events.some(event => event.kind === 'invalidate'), false);
            assert.equal([...h.state.logs.values()][0]?.status ?? 'pending', 'pending');
        });
    }
    test(`${scenario}: lost commit acknowledgement never kicks, then same-key retry replays committed result`, async () => {
        const h = createHarness({ scenario, failure: 'commit-ack' }), key = crypto.randomUUID();
        await assert.rejects(h.invoke(h.body, key), /synthetic_commit_ack_lost/);
        assert.equal(h.state.outbox.size, 1, 'The simulated database committed before losing its acknowledgement');
        assert.equal(h.events.some(event => event.kind === 'kick' || event.kind === 'response'), false);
        assert.equal(h.events.some(event => event.kind === 'invalidate'), false);
        assert.ok(h.events.some(event => event.kind === 'destroy'));
        h.setFailure(null);
        await h.invoke(h.body, key);
        assert.equal(h.state.outbox.size, 1);
        assert.equal(h.events.filter(event => event.kind === 'enqueue').length, 1);
        assert.equal(h.events.some(event => event.kind === 'kick'), false, 'Recovery is left to the durable outbox scan');
    });
    test(`${scenario}: failed replay commit cannot return a cached success`, async () => {
        const h = createHarness({ scenario }), key = crypto.randomUUID();
        await h.invoke(h.body, key);
        h.setFailure('replay-commit');
        await assert.rejects(h.invoke(h.body, key), /synthetic_replay_commit_failure/);
        assert.equal(h.state.outbox.size, 1);
        assert.equal(h.events.filter(event => event.kind === 'response').length, 1);
        assert.equal(h.events.filter(event => event.kind === 'kick').length, 1);
        assert.equal(h.state.audits.filter(row => row[11] === 'failure').length, 0);
    });
    test(`${scenario}: a rolled-back enqueue can retry with the same identity`, async () => {
        const h = createHarness({ scenario, failure: 'enqueue-after' }), key = crypto.randomUUID();
        await assert.rejects(h.invoke(h.body, key), /synthetic_enqueue_failure/);
        h.setFailure(null);
        await h.invoke(h.body, key);
        assert.equal(h.state.outbox.size, 1);
        assert.equal(h.state.writes.size, 1);
        assert.equal(h.events.filter(event => event.kind === 'kick').length, 1);
    });
    test(`${scenario}: post-commit HTTP failure never rolls back or records a failed review`, async () => {
        const h = createHarness({ scenario, responseFailure: true }), key = crypto.randomUUID();
        await assert.rejects(h.invoke(h.body, key), /synthetic_response_failure/);
        await assert.rejects(h.invoke(h.body, key), /synthetic_response_failure/);
        assert.equal(h.state.outbox.size, 1);
        assert.equal(h.events.some(event => event.kind === 'rollback'), false);
        assert.equal(h.state.audits.filter(row => row[11] === 'failure').length, 0);
    });
    for (const kickFailure of ['sync', 'async']) test(`${scenario}: ${kickFailure} kick failure cannot fail a committed review`, async () => {
        const h = createHarness({ scenario, kickFailure });
        await h.invoke();
        await nextTurn();
        assert.equal(h.state.outbox.size, 1);
        assert.equal(h.events.some(event => event.kind === 'rollback'), false);
        assert.equal(h.state.audits.filter(row => row[11] === 'failure').length, 0);
        assert.ok(h.events.some(event => event.kind === 'logged-error'));
    });
}

for (const scenario of ['approve', 'reject', 'apply']) {
    test(`${scenario}: missing graph-lock schema fails before intent, mail or cache mutation`, async () => {
        const h = createHarness({ scenario, graphLockAvailable: false }), key = crypto.randomUUID();
        await assert.rejects(h.invoke(h.body, key),
            error => error.status === 503 && error.body?.error === 'topic_reference_schema_unavailable');
        assert.equal(h.events.some(event => event.sql?.includes('write_requests')), false);
        assert.equal(h.events.some(event => ['enqueue', 'kick', 'invalidate', 'response'].includes(event.kind)), false);
        assert.equal(h.state.logs.get(901).status, 'pending');
        assert.equal(h.state.outbox.size, 0);
        assert.equal(h.state.writes.size, 0);
        h.setGraphLockAvailable(true);
        assert.equal((await h.invoke(h.body, key)).status, 200);
        assert.equal(h.state.outbox.size, 1);
    });

    for (const [label, user] of [
        ['missing account', null], ['deleted account', { deleted_at: new Date(now - 1000) }],
        ['permanent ban', { banned_at: new Date(now - 1000) }],
        ['active temporary ban', { banned_at: new Date(now - 1000), banned_until: new Date(now + 60_000) }]
    ]) test(`${scenario}: ${label} does not receive mail or block the review`, async () => {
        const h = createHarness({ scenario, user }), result = await h.invoke();
        assert.equal(result.status, 200);
        assert.equal(h.state.outbox.size, 0);
        assert.equal(h.events.some(event => event.kind === 'enqueue' || event.kind === 'kick'), false);
    });
    test(`${scenario}: expired ban permits mail to the exact contributor`, async () => {
        const h = createHarness({ scenario, user: { banned_at: new Date(now - 60_000), banned_until: new Date(now - 1000) } });
        await h.invoke();
        assert.equal(h.state.outbox.size, 1);
    });
    test(`${scenario}: a legacy submission without an account is reviewable without a notification`, async () => {
        const h = createHarness({ scenario });
        h.state.logs.get(901).user_id = null;
        await h.invoke();
        assert.equal(h.state.outbox.size, 0);
        assert.equal(h.events.some(event => event.kind === 'enqueue' || event.kind === 'kick'), false);
    });
    test(`${scenario}: a mismatched returned account cannot become the recipient`, async () => {
        const h = createHarness({ scenario, user: { ID: reviewerID } });
        await h.invoke();
        assert.equal(h.state.outbox.size, 0);
    });
    for (const [label, user] of [['missing email', { email: null }], ['unverified email', { email_verified_at: null }]]) {
        test(`${scenario}: ${label} does not roll back the decision`, async () => {
            const h = createHarness({ scenario, user }), response = await h.invoke();
            assert.equal(response.status, 200);
            assert.equal(response.body.emailNotification.recipientAvailable, false);
            assert.equal([...h.state.outbox.values()][0].parameters[2], null);
            assert.equal(h.state.writes.size, 1);
        });
    }
    for (const sameKey of [true, false]) test(`${scenario}: concurrent ${sameKey ? 'same-key replay' : 'independent duplicate'} commits one outbox row`, async t => {
        const h = createHarness({ scenario, pauseEnqueue: true }), key = crypto.randomUUID();
        t.after(h.resumeEnqueue);
        const first = h.invoke(h.body, key);
        await h.enteredEnqueue;
        let secondFinished = false;
        const second = h.invoke(h.body, sameKey ? key : crypto.randomUUID()).then(value => ({ value }), error => ({ error }))
            .finally(() => { secondFinished = true; });
        await nextTurn();
        assert.equal(secondFinished, false, 'The duplicate waits for the uncommitted graph lock');
        const secondEvents = h.events.filter(event => event.connectionID === 2);
        assert.ok(secondEvents.some(event => event.sql === 'SELECT ID FROM topic_reference_lock WHERE ID = 1 FOR UPDATE'));
        assert.equal(secondEvents.some(event => event.sql?.includes('write_requests')), false,
            'The waiter must not claim an intent before acquiring the graph lock');
        assert.equal(h.state.outbox.size, 0, 'Uncommitted outbox is invisible');
        assert.equal(h.events.some(event => event.kind === 'kick'), false);
        h.resumeEnqueue();
        const [result, duplicate] = await Promise.all([first, second]);
        if (sameKey) assert.deepEqual(duplicate.value, result);
        else assert.equal(duplicate.error?.body?.error, 'already_reviewed');
        assert.equal(h.state.outbox.size, 1);
        assert.equal(h.events.filter(event => event.kind === 'kick').length, 1);
        assert.equal(h.events.filter(event => event.kind === 'lock-acquired' && event.key === 'topic-reference:1').length, 2);
        assert.equal(h.events.filter(event => event.kind === 'lock-released' && event.key === 'topic-reference:1').length, 2);
        assert.equal(h.events.filter(event => event.kind === 'invalidate').length, 1);
    });
}

for (const scenario of ['senior-submit', 'pending-submit']) test(`${scenario}: unverified email cannot pass the submission prerequisite`, async () => {
    const h = createHarness({ scenario, user: { email_verified_at: null } });
    await assert.rejects(h.invoke(), error => error.body?.error === 'verified_email_required');
    assert.equal(h.state.logs.size, 0);
    assert.equal(h.state.writes.size, 0);
    assert.equal(h.state.outbox.size, 0);
});

for (const scenario of ['senior-submit', 'pending-submit']) test(`${scenario}: concurrent same-key submission commits only once`, async () => {
    const h = createHarness({ scenario, pauseCommit: true }), key = crypto.randomUUID();
    const first = h.invoke(h.body, key);
    await h.enteredCommit;
    const second = h.invoke(h.body, key);
    await nextTurn();
    assert.equal(h.state.logs.size, 0);
    h.resumeCommit();
    assert.deepEqual(await first, await second);
    assert.equal(h.state.logs.size, 1);
    assert.equal(h.state.writes.size, 1);
    assert.equal(h.state.outbox.size, scenario === 'senior-submit' ? 1 : 0);
    assert.equal(h.events.filter(event => event.kind === 'kick').length, scenario === 'senior-submit' ? 1 : 0);
});
