import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import vm from 'node:vm';
import mysql from 'mysql2';
import * as transactions from '../../db-transaction.js';
import { canonicalAccountID, requireAccountWriteOwner } from '../../public/js/shared/account-identity.js';
import { readWriteIdentity, claimWriteIntent, completeWriteIntent } from '../../write-idempotency.js';
import { normalizeTopicRequest, assertPublicTopicAvailable, createTopic } from '../../topic-service.js';
import { createModerationAuditRecorder, insertModerationAuditLog, moderationAuditSnapshot } from '../../moderation-admin.js';
import { createModerationEmailService, moderationRecipientEmail } from '../../moderation-email.js';
import { createTopicProposalService, lockTopicProposalForReview, finishTopicProposalReview,
    normalizeTopicProposalRequest, approveTopicSceneProposal } from '../../topic-proposal-service.js';
import { lockTopicReferences } from '../../topic-reference-service.js';
import { TOPIC_SCENE_SQL_PREVIEW } from '../../topic-scenes-service.js';
import { assertPrivacyCSRF } from '../../privacy-controls.js';

const source = (await readFile(new URL('../../server.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const contributor = '9007199254740993', reviewer = '9007199254740992', senior = '99';
const request = { name: 'Clinical reasoning', description: 'Reasoning about clinical tasks.', isPrivate: false };
const proposalRequest = { name: request.name, description: request.description };
const supporters = Array.from({ length: 32 }, (_, index) => String(1000 + index));
const clone = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function evaluate(context, startText, endText, includeEnd = false) {
    const start = source.indexOf(startText), end = source.indexOf(endText, start);
    assert.ok(start >= 0 && end > start, `Production source range exists: ${startText}`);
    vm.runInContext(source.slice(start, end + (includeEnd ? endText.length : 0)), context);
}

function harness({ email = 'verified@example.test', verified = true, failure = null, deliveryEnabled = false,
    now = Date.parse('2026-10-28T00:00:00.000Z') } = {}) {
    const users = new Map([contributor, reviewer, senior, ...supporters].map(ID => [ID, { ID, email,
        email_verified_at: verified ? new Date() : null, deleted_at: null, banned_at: null, banned_until: null,
        isReviewer: ID !== contributor, isSenior: ID === senior }]));
    const state = { logs: new Map(), categories: new Map(), contexts: new Map(), writes: new Map(), outbox: new Map(),
        proposals: new Map(), votes: new Map(), audits: [] };
    const events = [], handlers = new Map(), locks = new Map(), aliases = new Set();
    let nextID = 100, borrowed = 0, clock = now, beforeSQL = null;
    const currentTime = () => new Date(clock);
    const collecting = proposal => proposal?.status === 'open' && !proposal.withdrawn_at
        && new Date(proposal.created_at).getTime() > clock - 14 * 86400000;
    const effectiveStatus = proposal => proposal.withdrawn_at ? 'withdrawn'
        : proposal.status === 'open' && !collecting(proposal) ? 'expired' : proposal.status;
    const quota = (rows, actor) => ({ active_supports: [...rows('votes').values()]
        .filter(vote => vote.user_ID === actor && collecting(rows('proposals').get(vote.proposal_ID))).length,
    active_proposal_ID: [...rows('proposals').values()]
        .filter(proposal => proposal.user_ID === actor && collecting(proposal)).sort((a, b) => b.ID - a.ID)[0]?.ID ?? null });
    const tables = ['logs', 'categories', 'contexts', 'writes', 'outbox', 'proposals', 'votes'];
    const projected = (proposal, rows, actor) => {
        const votes = [...rows('votes').values()].filter(vote => vote.proposal_ID === proposal.ID);
        const topic = rows('categories').get(proposal.topic_ID);
        return { ...clone(proposal), effective_status: effectiveStatus(proposal),
            expires_at_ms: new Date(proposal.created_at).getTime() + 14 * 86400000,
            support_count: votes.length, supported: votes.some(vote => vote.user_ID === actor) ? 1 : 0,
            published_name: topic?.name, published_slug: topic?.slug };
    };
    const sceneCatalog = (rows, parameters) => [...rows('contexts').values()]
        .filter(row => parameters.slice(0, -1).includes(row.categoryID))
        .map(row => ({ contextID: row.ID, category_ID: row.categoryID,
            scene_context_ID: null, context_hash: row.hash }));
    const makeConnection = () => {
        const connectionID = ++borrowed, held = [], heldKeys = new Set();
        let journal = null, readOnly = false, isolation = 'REPEATABLE READ', snapshot = null;
        const unlock = () => { heldKeys.clear(); held.splice(0).forEach(release => release()); };
        const lock = async key => {
            if (heldKeys.has(key)) return;
            events.push({ kind: 'lock-wait', connectionID, key });
            const previous = locks.get(key) ?? Promise.resolve(), ready = deferred();
            locks.set(key, ready.promise); await previous;
            heldKeys.add(key); held.push(ready.resolve);
            events.push({ kind: 'lock', connectionID, key });
        };
        const rows = (table, locking = false) => {
            if (journal && isolation === 'REPEATABLE READ' && !locking && !snapshot) {
                snapshot = Object.fromEntries(tables.map(name => [name, clone(state[name])]));
            }
            const committed = journal && isolation === 'REPEATABLE READ' && !locking ? snapshot[table] : state[table];
            const merged = new Map([...committed, ...(journal?.[table] ?? [])]);
            return new Map([...merged].filter(([, value]) => value !== null));
        };
        const connection = {
            async query(sql, parameters) { return connection.execute(sql, parameters); },
            async beginTransaction() {
                journal = Object.fromEntries(tables.map(table => [table, new Map()])); journal.audits = [];
                snapshot = null;
                events.push({ kind: 'begin', connectionID, isolation });
            },
            async execute(sql, parameters = []) {
                const statement = sql.replace(/\s+/g, ' ').trim();
                events.push({ kind: 'sql', connectionID, sql: statement, parameters: clone(parameters) });
                await beforeSQL?.({ sql: statement, parameters: clone(parameters), connectionID });
                if (statement === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED') {
                    assert.equal(journal, null, 'Isolation is transaction-local and selected before BEGIN');
                    isolation = 'READ COMMITTED'; return [{}];
                }
                if (statement === 'SET TRANSACTION READ ONLY') { readOnly = true; return [{}]; }
                if (readOnly) assert.match(statement, /^SELECT\b/, 'Preview never executes mutations');
                if (statement === 'SELECT ID FROM topic_reference_lock WHERE ID = 1 FOR UPDATE') {
                    await lock('topic-reference-graph');
                    return [[{ ID: 1 }]];
                }
                if (statement.includes('LEFT JOIN topic_scenes')) return [sceneCatalog(rows, parameters)];
                if (statement.startsWith('INSERT INTO write_requests')) {
                    const [actor, key, action, payload_hash, owner_token] = parameters, rowKey = `${actor}:${key}`;
                    await lock(`write:${rowKey}`);
                    if (!state.writes.has(rowKey)) journal.writes.set(rowKey,
                        { actor_user_ID: actor, action, payload_hash, owner_token, response_status: null, response_body: null, created_at: currentTime() });
                    return [{ affectedRows: 1 }];
                }
                if (statement.startsWith('SELECT GREATEST(')) {
                    const actor = String(parameters[0]), since = clock - 86400000;
                    const proposals = [...rows('proposals').values()].filter(row => row.user_ID === actor && new Date(row.created_at).getTime() >= since).length;
                    const writes = [...rows('writes').values()].filter(row => row.actor_user_ID === actor && row.action === 'propose_topic'
                        && row.response_status === 200 && new Date(row.created_at).getTime() >= since).length;
                    return [[{ count: Math.max(proposals, writes) }]];
                }
                if (statement.includes('FROM write_requests')) return [[clone(rows('writes').get(parameters.join(':')))]];
                if (statement.startsWith('UPDATE write_requests SET response_status')) {
                    if (failure === 'completion') throw new Error('synthetic_completion_failure');
                    const [status, body, actor, key, owner] = parameters, rowKey = `${actor}:${key}`;
                    const row = journal.writes.get(rowKey);
                    assert.equal(row.owner_token, owner);
                    Object.assign(row, { response_status: status, response_body: body });
                    return [{ affectedRows: 1 }];
                }
                if (statement.includes('AS active_supports')) {
                    assert.deepEqual(parameters, [parameters[0], parameters[0]], 'Both quota subqueries use the exact actor');
                    return [[quota(rows, parameters[0])]];
                }
                if (statement.includes('FROM users')) {
                    if (statement.includes('WHERE ID IN')) {
                        const ids = parameters.map(String);
                        if (statement.includes('ORDER BY ID')) ids.sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
                        if (statement.endsWith('FOR UPDATE')) for (const ID of ids) await lock(`user:${ID}`);
                        return [ids.flatMap(ID => {
                            const user = users.get(ID);
                            return user ? [{ ...clone(user), active: !user.deleted_at && (!user.banned_at
                                || user.banned_until && new Date(user.banned_until) <= currentTime()) ? 1 : 0 }] : [];
                        })];
                    }
                    if (statement.endsWith('FOR UPDATE')) await lock(`user:${parameters[0]}`);
                    const user = users.get(String(parameters[0]));
                    const eligible = user && (!statement.includes('email_verified_at IS NOT NULL') || user.email_verified_at)
                        && (!statement.includes('deleted_at IS NULL') || !user.deleted_at)
                        && (!statement.includes('banned_at IS NULL') || !user.banned_at
                            || user.banned_until && new Date(user.banned_until) <= currentTime());
                    return [eligible ? [clone(user)] : []];
                }
                if (statement.startsWith('SELECT p.*')) {
                    const projection = statement.includes('AS support_count'), ID = parameters[projection ? 1 : 0];
                    const locking = statement.endsWith('FOR UPDATE');
                    if (locking) await lock(`proposal:${ID}`);
                    const selected = [...rows('proposals', locking).values()].filter(row => !statement.includes('WHERE p.ID = ?') || row.ID === ID);
                    return [selected.map(row => projected(row, rows, projection ? parameters[0] : null))];
                }
                if (statement.startsWith('SELECT COUNT(*) AS support_count')) {
                    return [[{ support_count: [...rows('votes').values()].filter(row => row.proposal_ID === parameters[0]
                        && (!statement.includes('user_ID <>') || row.user_ID !== parameters[1])).length }]];
                }
                if (statement.startsWith('SELECT user_ID FROM topic_proposal_votes')) {
                    const vote = rows('votes').get(parameters.join(':')); return [vote ? [clone(vote)] : []];
                }
                if (statement.startsWith('INSERT INTO topic_proposal_votes')) {
                    const conditional = statement.includes('SELECT ID, ?'), [proposalID, actor] = conditional ? [parameters[1], parameters[0]] : parameters;
                    if (conditional && !collecting(rows('proposals').get(proposalID))) return [{ affectedRows: 0 }];
                    const key = `${proposalID}:${actor}`;
                    assert.equal(rows('votes').has(key), false, 'One vote per account');
                    journal.votes.set(key, { proposal_ID: proposalID, user_ID: actor, created_at: currentTime() });
                    return [{ affectedRows: 1 }];
                }
                if (statement.startsWith('DELETE FROM topic_proposal_votes')) {
                    const selected = [...rows('votes')].filter(([, vote]) => vote.proposal_ID === parameters[0]
                        && (parameters.length === 1 || vote.user_ID === parameters[1]));
                    for (const [key] of selected) journal.votes.set(key, null);
                    return [{ affectedRows: selected.length }];
                }
                if (statement.startsWith('DELETE FROM topic_proposals WHERE ID = ?')) {
                    const ID = parameters[0];
                    if (!rows('proposals').has(ID)) return [{ affectedRows: 0 }];
                    journal.proposals.set(ID, null);
                    for (const [key, vote] of rows('votes')) if (vote.proposal_ID === ID) journal.votes.set(key, null);
                    return [{ affectedRows: 1 }];
                }
                if (statement.startsWith('SELECT user_ID FROM topic_proposals')) {
                    const proposal = rows('proposals').get(parameters[0]);
                    return [proposal ? [{ user_ID: proposal.user_ID }] : []];
                }
                if (statement.startsWith('SELECT * FROM topic_proposals')) {
                    if (statement.endsWith('FOR UPDATE')) await lock(`proposal:${parameters[0]}`);
                    const row = rows('proposals', statement.endsWith('FOR UPDATE')).get(parameters[0]); return [row ? [clone(row)] : []];
                }
                if (statement.startsWith('SELECT ID FROM topic_proposals')) {
                    const excluding = statement.includes('WHERE ID <> ?');
                    const [slug, name] = excluding ? parameters.slice(1) : parameters;
                    return [[...rows('proposals').values()].filter(row => (!excluding || row.ID !== parameters[0])
                        && (row.reservation_slug === slug || row.reservation_name?.toLowerCase() === name.toLowerCase())).slice(0, 1)];
                }
                if (statement.startsWith('INSERT INTO topic_proposals')) {
                    const [user_ID, name, slug, description, reservation_slug, reservation_name] = parameters;
                    await lock(`proposal-slug:${slug}`); await lock(`proposal-name:${name.toLowerCase()}`);
                    if ([...rows('proposals').values()].some(row => row.reservation_slug === slug
                        || row.reservation_name?.toLowerCase() === name.toLowerCase())) throw Object.assign(new Error('Duplicate'), { code: 'ER_DUP_ENTRY' });
                    const ID = ++nextID;
                    journal.proposals.set(ID, { ID, user_ID, name, slug, description, reservation_slug, reservation_name, status: 'open', revision: 1,
                        created_at: currentTime(), updated_at: currentTime(), withdrawn_at: null, moderation_log_ID: null, topic_ID: null });
                    return [{ insertId: ID }];
                }
                if (statement.startsWith('UPDATE topic_proposals SET reservation_slug = NULL')) {
                    const [slug, name] = parameters;
                    await lock(`proposal-slug:${slug}`); await lock(`proposal-name:${name.toLowerCase()}`);
                    const expired = [...rows('proposals').values()].filter(row => row.withdrawn_at || row.status === 'rejected'
                        || row.status === 'open' && !collecting(row));
                    const releasable = expired.filter(row => row.reservation_slug === slug
                        || row.reservation_name?.toLowerCase() === name.toLowerCase());
                    for (const row of releasable) journal.proposals.set(row.ID, { ...clone(row), reservation_slug: null, reservation_name: null });
                    return [{ affectedRows: releasable.length }];
                }
                if (statement.startsWith('UPDATE topic_proposals')) {
                    const editing = statement.includes('SET name = ?'), withdrawing = statement.includes('SET withdrawn_at ='),
                        pending = statement.includes("status = 'pending',"),
                        ID = editing ? parameters[5] : withdrawing ? parameters[0] : pending ? parameters[1] : parameters[2];
                    if (failure === 'promotion' && pending) throw new Error('synthetic_promotion_failure');
                    const proposal = clone(rows('proposals').get(ID));
                    if (!proposal) return [{ affectedRows: 0 }];
                    if (editing) {
                        const [name, slug, description, reservation_slug, reservation_name] = parameters;
                        if ([...rows('proposals').values()].some(row => row.ID !== ID && (row.reservation_slug === slug
                            || row.reservation_name?.toLowerCase() === name.toLowerCase()))) {
                            throw Object.assign(new Error('Duplicate'), { code: 'ER_DUP_ENTRY' });
                        }
                        Object.assign(proposal, { name, slug, description, reservation_slug, reservation_name, revision: proposal.revision + 1 });
                    } else if (withdrawing) proposal.withdrawn_at = currentTime();
                    else if (pending) {
                        if (proposal.status !== 'open' || proposal.moderation_log_ID !== null) return [{ affectedRows: 0 }];
                        Object.assign(proposal, { status: 'pending', moderation_log_ID: parameters[0], promoted_at: currentTime() });
                    } else {
                        if (proposal.status !== 'pending' || proposal.moderation_log_ID !== parameters[3]) return [{ affectedRows: 0 }];
                        Object.assign(proposal, { status: parameters[0], topic_ID: parameters[1], decided_at: currentTime() });
                    }
                    proposal.updated_at = currentTime();
                    journal.proposals.set(ID, proposal); return [{ affectedRows: 1 }];
                }
                if (statement.includes('COUNT(*) AS count')) {
                    const table = statement.includes('FROM moderation_logs') ? 'logs' : statement.includes('FROM topic_proposals') ? 'proposals' : 'categories';
                    return [[{ count: [...rows(table).values()].filter(row => String(row.user_ID ?? row.user_id ?? row.created_by_user_ID) === String(parameters[0])
                        && (!statement.includes('created_at >= NOW() - INTERVAL 1 DAY') || new Date(row.created_at).getTime() >= clock - 86400000)).length }]];
                }
                if (statement.includes('FROM moderation_logs')) {
                    const ID = Number(parameters[0]);
                    if (statement.endsWith('FOR UPDATE')) await lock(`log:${ID}`);
                    const log = rows('logs').get(ID);
                    return [log ? [clone(log)] : []];
                }
                if (statement.startsWith('INSERT INTO moderation_logs')) {
                    if (failure === 'submission') throw new Error('synthetic_submission_failure');
                    const ID = ++nextID;
                    journal.logs.set(ID, { ID, content: parameters[0], report_count: parameters[1], user_id: parameters[2],
                        status: 'pending', created_at: new Date(), updated_at: new Date() });
                    return [{ insertId: ID }];
                }
                if (statement.startsWith('UPDATE moderation_logs SET')) {
                    const ID = Number(parameters.at(-1)), log = clone(rows('logs').get(ID));
                    if (statement.includes('content = ?')) log.content = parameters[0];
                    log.status = statement.includes("status = 'approved'") ? 'approved'
                        : statement.includes('content = ?') ? parameters[1] : parameters[0];
                    log.updated_at = new Date(); journal.logs.set(ID, log);
                    return [{ affectedRows: 1 }];
                }
                if (statement.includes('FROM topic_legacy_routes')) return [aliases.has(parameters[1]) ? [{ category_ID: 5 }] : []];
                if (statement.includes('FROM categories c')) {
                    const row = state.categories.get(Number(parameters[0]));
                    return [row ? [clone(row)] : []];
                }
                if (statement.includes('FROM categories')) {
                    return [[...rows('categories').values()].filter(row => row.owner_user_ID == null
                        && (row.slug === parameters[0] || row.name.toLowerCase() === parameters[1].toLowerCase()))];
                }
                if (statement.startsWith('INSERT INTO categories')) {
                    assert.ok(journal, 'Publication uses the review transaction');
                    const [name, slug, description] = parameters;
                    await lock(`slug:${slug}`);
                    if (failure === 'duplicate' || [...rows('categories').values()].some(row => row.owner_user_ID == null && row.slug === slug)) {
                        throw Object.assign(new Error('Duplicate'), { code: 'ER_DUP_ENTRY' });
                    }
                    const ID = ++nextID, isPrivate = !statement.includes('NULL');
                    journal.categories.set(ID, { ID, name, slug, description,
                        owner_user_ID: isPrivate ? parameters[3] : null,
                        created_by_user_ID: isPrivate ? parameters[4] : parameters[3], position: 0 });
                    return [{ insertId: ID }];
                }
                if (statement.startsWith('INSERT INTO ranking_contexts')) {
                    if (failure === 'context') throw new Error('synthetic_context_failure');
                    const ID = ++nextID;
                    journal.contexts.set(ID, { ID, categoryID: parameters[0], values: {}, hash: parameters[1] });
                    return [{ insertId: ID }];
                }
                if (statement.startsWith('INSERT INTO moderation_audit_logs')) {
                    if (failure === 'audit' && parameters[11] === 'success') throw new Error('synthetic_audit_failure');
                    journal.audits.push(clone(parameters)); return [{ insertId: ++nextID }];
                }
                if (statement.startsWith('INSERT INTO moderation_email_outbox')) {
                    if (failure === 'outbox') throw new Error('synthetic_outbox_failure');
                    await lock(`outbox:${parameters[0]}`);
                    assert.equal(rows('outbox').has(parameters[0]), false, 'Unique per-log decision outbox');
                    const ID = ++nextID;
                    journal.outbox.set(parameters[0], { ID, parameters: clone(parameters) });
                    return [{ insertId: ID }];
                }
                throw new Error(`Unhandled synthetic SQL: ${statement}`);
            },
            async commit() {
                if (failure === 'commit') throw new Error('synthetic_commit_failure');
                for (const table of tables) for (const [key, value] of journal[table]) {
                    if (value === null) state[table].delete(key);
                    else state[table].set(key, clone(value));
                }
                state.audits.push(...clone(journal.audits)); journal = null; unlock();
                events.push({ kind: 'commit', connectionID });
                if (failure === 'commit-ack') throw new Error('synthetic_commit_ack_lost');
            },
            async rollback() { journal = null; unlock(); events.push({ kind: 'rollback', connectionID }); },
            release() { unlock(); events.push({ kind: 'release', connectionID }); },
            destroy() { journal = null; unlock(); events.push({ kind: 'destroy', connectionID }); }
        };
        return connection;
    };
    const service = createModerationEmailService({ pool: {}, publicOrigin: 'https://example.test',
        transport: null, environment: { BENCHPOLL_EMAIL_DELIVERY_ENABLED: String(deliveryEnabled) } });
    const db = { getConnection: async () => makeConnection(), async execute(sql, parameters) {
        assert.match(sql, /^SELECT\b/, 'Pool is only used for post-commit private-topic reads');
        events.push({ kind: 'pool-sql', sql: sql.replace(/\s+/g, ' ').trim(), parameters: clone(parameters) });
        if (sql.includes('LEFT JOIN topic_scenes')) return [sceneCatalog(table => state[table], parameters)];
        if (sql.includes('AS active_supports')) {
            assert.deepEqual(parameters, [parameters[0], parameters[0]], 'Page quotas belong to the same exact actor');
            return [[quota(table => state[table], parameters[0])]];
        }
        if (sql.includes('FROM topic_proposals p')) {
            const rows = table => state[table];
            const byID = sql.includes('WHERE p.ID = ?');
            const proposals = [...state.proposals.values()].sort((a, b) => b.ID - a.ID)
                .filter(row => byID ? row.ID === parameters[1] : (!row.withdrawn_at
                    && (!sql.includes("p.status = 'pending'") || row.status === 'pending')
                    && (parameters[1] === undefined || row.ID < parameters[1]))).slice(0, 31);
            return [proposals.map(row => projected(row, rows, parameters[0]))];
        }
        const row = state.categories.get(Number(parameters[0])); return [row ? [clone(row)] : []];
    } };
    const context = vm.createContext({ ...transactions, crypto, mysql, Buffer, URL, structuredClone,
        canonicalAccountID, requireAccountWriteOwner, normalizeTopicRequest, assertPublicTopicAvailable, createTopic,
        moderationRecipientEmail, readWriteIdentity, claimWriteIntent, completeWriteIntent, db,
        lockTopicProposalForReview, finishTopicProposalReview, normalizeTopicProposalRequest,
        approveTopicSceneProposal, lockTopicReferences, TOPIC_SCENE_SQL_PREVIEW,
        createModerationAuditRecorder, insertModerationAuditLog, moderationAuditSnapshot,
        sessionSecret: 'synthetic-preview-secret', privacyControls: { hasAccepted: async () => true },
        publicOrigin: 'https://example.test',
        searchPresentation: { invalidate() {} },
        topicHome: { invalidate() {
            assert.ok(events.some(event => event.kind === 'commit'), 'Topic caches invalidate only after a successful commit');
            events.push({ kind: 'cache-invalidate' });
        } },
        activeUserRecord: async ID => clone(users.get(String(ID)) ?? null),
        activeSessionUserID: async req => users.has(String(req.session.userID)) ? String(req.session.userID) : null,
        console: { error() {} },
        moderationEmailService: { enqueue: (connection, details) => service.enqueue(connection, details), kick(ID) {
            assert.ok([...state.outbox.values()].some(row => row.ID === ID), 'Kick only follows committed outbox');
            events.push({ kind: 'kick', ID });
        } },
        API: { post(path, ...callbacks) { handlers.set(path, callbacks); } }
    });
    evaluate(context, 'const requireAuthForAPI =', 'const requireSeniorReviewerAuthForAPI =');
    evaluate(context, 'const discussionSameOrigin =', 'const privacyForm =');
    context.privacyForm = (req, _res, next) => { try { assertPrivacyCSRF(req.session, req.body.csrfToken); next(); } catch (error) { next(error); } };
    evaluate(context, 'function normalizeString(', 'async function buildExecutedModerationSQLPreview(');
    evaluate(context, 'async function buildExecutedModerationSQLPreview(', "API.post('/submit_contribution'");
    evaluate(context, 'function directMutationAuditError(', "API.post('/send_admin_message'");
    context.topicProposals = createTopicProposalService({ pool: db, queueForReview: context.queueTopicProposalForReview });
    for (const route of ['create_topic', 'propose_topic', 'vote_topic_proposal', 'cancel_topic_proposal_support',
        'edit_topic_proposal', 'withdraw_topic_proposal', 'get_topic_proposals', 'submit_contribution',
        'review_moderation_log', 'apply_moderation_log', 'preview_moderation_sql']) {
        evaluate(context, `API.post('/${route}'`, '\n});', true);
    }
    return { state, users, context, events, aliases, get borrowed() { return borrowed; },
        setFailure(value) { failure = value; },
        get now() { return clock; }, advance(milliseconds) { clock += milliseconds; },
        setBeforeSQL(callback) { beforeSQL = callback; },
        async invoke(route, body, { actor = contributor, key = crypto.randomUUID(), expectedUserID = actor, csrfToken = 'x'.repeat(43) } = {}) {
            const guarded = ['propose_topic', 'vote_topic_proposal', 'cancel_topic_proposal_support',
                'edit_topic_proposal', 'withdraw_topic_proposal'].includes(route);
            const req = { body: clone({ ...body, ...(route === 'get_topic_proposals' ? {} : { expectedUserID }), ...(guarded ? { csrfToken } : {}) }),
                session: { userID: actor, privacyCSRF: 'x'.repeat(43) },
                headers: { 'idempotency-key': key }, protocol: 'https',
                get(name) { return name === 'host' ? 'example.test' : name.toLowerCase() === 'idempotency-key' ? key : undefined; } };
            const response = { status: 200, body: null };
            const res = { set(name, value) { (response.headers ??= {})[name.toLowerCase()] = value; return this; }, status(value) { response.status = value; return this; },
                json(value) { response.body = clone(value); return this; }, end() { return this; } };
            const callbacks = handlers.get(`/${route}`);
            for (const guard of callbacks.slice(0, -1)) {
                let error; await guard(req, res, value => { error = value; }); if (error) throw error;
            }
            await callbacks.at(-1)(req, res); return response;
        }
    };
}

export { harness, contributor, reviewer, senior, request, proposalRequest, supporters };
