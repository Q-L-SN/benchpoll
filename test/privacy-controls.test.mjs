import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { LEGAL_VERSIONS, validateLegalChoice, assertPendingLegalChoice, ensurePrivacyCSRF,
    assertPrivacyCSRF, normalizePrivacyRequest, createPrivacyRequestLimiter, createPrivacyControls,
    publicPrivacyOperator } from '../privacy-controls.js';

const hashes = { terms: 'a'.repeat(64), privacy: 'b'.repeat(64) };
const input = (overrides = {}) => ({ acceptedTerms: true, eligibleAge: true,
    termsVersion: LEGAL_VERSIONS.terms, privacyVersion: LEGAL_VERSIONS.privacy,
    privateCategoryResearch: false, ...overrides });
const throwsCode = (run, code) => assert.throws(run, value => value.body?.error === code);

test('consent is explicit, current, age-attested, and cannot enable private research', () => {
    const choice = validateLegalChoice(input(), { hashes });
    assert.equal(choice.privateCategoryResearch, false);
    assert.equal(choice.eligibleAge, true);
    assert.deepEqual(choice.hashes, hashes);
    for (const acceptedTerms of [false, undefined, 1, 'true']) {
        throwsCode(() => validateLegalChoice(input({ acceptedTerms }), { hashes }), 'terms_acceptance_required');
    }
    throwsCode(() => validateLegalChoice(input({ eligibleAge: false }), { hashes }), 'age_eligibility_required');
    throwsCode(() => validateLegalChoice(input({ termsVersion: 'old' }), { hashes }), 'legal_version_changed');
    throwsCode(() => validateLegalChoice(input({ privateCategoryResearch: undefined }), { hashes }), 'invalid_privacy_preference');
    throwsCode(() => validateLegalChoice(input({ privateCategoryResearch: true }), { hashes }), 'private_category_research_unavailable');
    throwsCode(() => validateLegalChoice(input()), 'legal_documents_unavailable');
});

test('OAuth evidence expires and is bound to the exact notices shown', () => {
    const now = Date.now();
    const proof = validateLegalChoice(input(), { hashes, now });
    assert.equal(assertPendingLegalChoice(proof, hashes, now + 10), proof);
    for (const candidate of [undefined, { ...proof, acceptedAt: 'invalid' },
        { ...proof, eligibleAge: false }, { ...proof, privateCategoryResearch: 'yes' },
        { ...proof, privateCategoryResearch: true },
        { ...proof, terms: 'old' }, { ...proof, hashes: { ...hashes, privacy: 'c'.repeat(64) } }]) {
        throwsCode(() => assertPendingLegalChoice(candidate, hashes, now), 'legal_acceptance_required');
    }
    throwsCode(() => assertPendingLegalChoice(proof, hashes, now - 1), 'legal_acceptance_required');
    throwsCode(() => assertPendingLegalChoice(proof, hashes, now + 600001), 'legal_acceptance_required');
});

test('login and account acceptance leave historical research choices untouched when omitted', async () => {
    const body = input();
    delete body.privateCategoryResearch;
    const choice = validateLegalChoice(body, { hashes, allowOmittedResearch: true });
    assert.equal(choice.privateCategoryResearch, null);
    assert.equal(assertPendingLegalChoice(choice, hashes), choice);
    assert.equal(validateLegalChoice(body, { hashes }).privateCategoryResearch, null);
    for (const privateCategoryResearch of [undefined, null, 'true', 1]) {
        throwsCode(() => validateLegalChoice({ ...body, privateCategoryResearch },
            { hashes, allowOmittedResearch: true }), 'invalid_privacy_preference');
    }
    for (const previous of [[], [{ private_category_research: 1, research_version: LEGAL_VERSIONS.research }],
        [{ private_category_research: 0, research_version: LEGAL_VERSIONS.research }]]) {
        const pool = database({ preference: previous });
        await createPrivacyControls({ pool, hashes }).recordAcceptanceOn(pool, '123', choice);
        assert.ok(pool.calls.some(([sql]) => sql.includes('INSERT INTO user_legal_acceptances')));
        assert.equal(pool.calls.some(([sql]) => /user_privacy_preferences|privacy_preference_events/.test(sql)), false);
    }
});

test('CSRF tokens are stable within a session, unguessable and reject malformed Unicode safely', () => {
    const session = {};
    const token = ensurePrivacyCSRF(session);
    assert.match(token, /^[a-zA-Z0-9_-]{43}$/);
    assert.equal(ensurePrivacyCSRF(session), token);
    assert.notEqual(ensurePrivacyCSRF({}), token);
    assert.doesNotThrow(() => assertPrivacyCSRF(session, token));
    for (const candidate of [null, token.slice(1), 'x'.repeat(43), '\u4e2d'.repeat(43)]) {
        throwsCode(() => assertPrivacyCSRF(session, candidate), 'privacy_form_expired');
    }
});

test('operator metadata does not invent a domain mailbox or legal identity', () => {
    assert.deepEqual(publicPrivacyOperator({}), { displayName: 'BenchPoll operator', email: null, identityPending: true });
    assert.equal(publicPrivacyOperator({ BENCHPOLL_PRIVACY_EMAIL: 'a\r\n@evil.test' }).email, null);
    assert.deepEqual(publicPrivacyOperator({ BENCHPOLL_OPERATOR_NAME: ' Example ', BENCHPOLL_PRIVACY_EMAIL: ' privacy@example.test ' }),
        { displayName: 'Example', email: 'privacy@example.test', identityPending: false });
});

test('privacy request payload rejects unsupported types and excessive or empty input', () => {
    const body = { email: ' person@example.test ', requestType: 'erasure', message: ' Please erase my account. ' };
    assert.deepEqual(normalizePrivacyRequest(body), { email: 'person@example.test', requestType: 'erasure', message: 'Please erase my account.' });
    for (const email of ['a@localhost', 'a@b\n.test', 'a b@example.test', 'a'.repeat(255) + '@example.test']) {
        throwsCode(() => normalizePrivacyRequest({ ...body, email }), 'invalid_contact_email');
    }
    throwsCode(() => normalizePrivacyRequest({ ...body, requestType: 'export_all_users' }), 'invalid_privacy_request_type');
    for (const message of ['', '   ', 'x'.repeat(4001), 'has\0null']) {
        throwsCode(() => normalizePrivacyRequest({ ...body, message }), 'invalid_privacy_request_message');
    }
});

test('privacy request abuse limiter has bounded, temporary hashed buckets', () => {
    let now = 0;
    const limit = createPrivacyRequestLimiter({ now: () => now, limit: 2, maxBuckets: 2, windowMs: 100 });
    limit('one'); limit('one'); limit('two');
    throwsCode(() => limit('one'), 'privacy_request_rate_limited');
    throwsCode(() => limit('three'), 'privacy_request_rate_limited');
    now = 101;
    assert.doesNotThrow(() => limit('one'));
    assert.doesNotThrow(() => limit('three'));
});

function database({ accepted = false, preference = [], rows = [], failEvent = false } = {}) {
    const calls = [];
    const connection = {
        async beginTransaction() { calls.push(['begin']); },
        async commit() { calls.push(['commit']); },
        async rollback() { calls.push(['rollback']); },
        release() { calls.push(['release']); },
        async execute(sql, params) {
            calls.push([sql.replace(/\s+/g, ' ').trim(), params]);
            if (sql.includes('SELECT 1 FROM user_legal_acceptances')) return [accepted ? [{ 1: 1 }] : []];
            if (sql.includes('SELECT private_category_research')) return [preference];
            if (sql.includes('SELECT ID, deleted_at FROM users')) return [[{ ID: params[0], deleted_at: null }]];
            if (sql.includes('INSERT INTO privacy_preference_events') && failEvent) throw new Error('event-failed');
            if (sql.includes('FROM privacy_requests')) return [rows];
            if (sql.includes('UPDATE privacy_requests')) return [{ affectedRows: 1 }];
            return [[]];
        }
    };
    return { ...connection, calls, async getConnection() { return connection; } };
}

test('anonymous status is read-free; even current historical opt-ins are never active', async () => {
    for (const version of ['old', LEGAL_VERSIONS.research]) {
        const pool = database({ preference: [{ private_category_research: 1, research_version: version }] });
        const service = createPrivacyControls({ pool, hashes, operator: publicPrivacyOperator({}) });
        assert.equal((await service.status(null)).privateCategoryResearch, false);
        assert.equal(pool.calls.length, 0);
        const status = await service.status('18446744073709551615');
        assert.equal(status.userID, '18446744073709551615');
        assert.equal(status.accepted, false);
        assert.equal(status.privateCategoryResearch, false);
        assert.equal(pool.calls[0][1][0], '18446744073709551615');
        assert.equal(pool.calls.some(([sql]) => /user_privacy_preferences|privacy_preference_events/.test(sql)), false);
    }
});

test('opt-ins and stale in-flight OAuth choices are rejected before writing any records', async () => {
    const pool = database({ preference: [{ private_category_research: 1, research_version: LEGAL_VERSIONS.research }] });
    const service = createPrivacyControls({ pool, hashes });
    await assert.rejects(service.savePreference('123', true), value => value.body?.error === 'private_category_research_unavailable');
    await assert.rejects(service.accept('123', input({ privateCategoryResearch: true })), value => value.body?.error === 'private_category_research_unavailable');
    const oldChoice = { ...validateLegalChoice(input(), { hashes }), privateCategoryResearch: true };
    await assert.rejects(service.recordAcceptanceOn(pool, '123', oldChoice), value => value.body?.error === 'legal_acceptance_required');
    assert.deepEqual(pool.calls, []);
});

test('Terms evidence and private research choice commit atomically', async () => {
    const pool = database();
    await createPrivacyControls({ pool, hashes }).accept('123', input());
    const acceptance = pool.calls.find(([sql]) => sql.includes('INSERT INTO user_legal_acceptances'));
    assert.deepEqual(acceptance[1].slice(0, 5), ['123', LEGAL_VERSIONS.terms, LEGAL_VERSIONS.privacy, hashes.terms, hashes.privacy]);
    assert.ok(acceptance[1][5] instanceof Date);
    assert.deepEqual(pool.calls.find(([sql]) => sql.includes('INSERT INTO privacy_preference_events'))[1], ['123', LEGAL_VERSIONS.research, 0]);
    assert.ok(pool.calls.some(([sql]) => sql === 'commit'));
    assert.equal(pool.calls.filter(([sql]) => sql === 'release').length, 1);
    assert.equal(pool.calls.some(([sql]) => sql === 'rollback'), false);
});

test('failed consent persistence rolls back and never returns successful status', async () => {
    const pool = database({ failEvent: true });
    await assert.rejects(createPrivacyControls({ pool, hashes }).accept('123', input()), /event-failed/);
    assert.ok(pool.calls.some(([sql]) => sql === 'rollback'));
    assert.equal(pool.calls.some(([sql]) => sql === 'commit'), false);
    assert.equal(pool.calls.filter(([sql]) => sql === 'release').length, 1);
});

test('withdrawal is available without prior Terms acceptance; unchanged choices do not create new events', async () => {
    const pool = database({ preference: [{ private_category_research: 1, research_version: LEGAL_VERSIONS.research }] });
    await createPrivacyControls({ pool, hashes }).savePreference('123', false);
    assert.equal(pool.calls.find(([sql]) => sql.includes('INSERT INTO privacy_preference_events'))[1][2], 0);
    const unchanged = database({ preference: [{ private_category_research: 0, research_version: LEGAL_VERSIONS.research }] });
    await createPrivacyControls({ pool: unchanged, hashes }).savePreference('123', false);
    assert.equal(unchanged.calls.some(([sql]) => sql.includes('INSERT INTO privacy_preference_events')), false);
});

test('anonymous request is saved privately with a random reference, no raw IP or automatic email/erasure', async () => {
    const pool = database();
    const { reference } = await createPrivacyControls({ pool, hashes }).submitRequest(null,
        { email: 'person@example.test', requestType: 'access', message: 'My request' });
    assert.match(reference, /^[a-f0-9-]{36}$/);
    assert.deepEqual(pool.calls[0][1], [reference, null, 'person@example.test', 'access', 'My request']);
    assert.doesNotMatch(pool.calls[0][0], /IP|user_agent|DELETE|outbox/);
});

test('operator request pagination preserves exact account IDs and uses private keyset cursors', async () => {
    const rows = Array.from({ length: 21 }, () => ({ reference: crypto.randomUUID(), userID: '18446744073709551615' }));
    const pool = database({ rows });
    const service = createPrivacyControls({ pool, hashes });
    const result = await service.listRequests();
    assert.equal(result.requests.length, 20);
    assert.equal(result.nextCursor, rows[19].reference);
    assert.equal(result.requests[0].userID, '18446744073709551615');
    await service.listRequests(result.nextCursor);
    assert.match(pool.calls[1][0], /WHERE \(created_at, reference\) </);
    await assert.rejects(service.listRequests('injection'), value => value.status === 400);
});

test('closing a request requires a handling record and never triggers mail or erasure', async () => {
    const pool = database(), service = createPrivacyControls({ pool, hashes });
    const reference = crypto.randomUUID();
    await assert.rejects(service.updateRequest('123', { reference, status: 'closed', resolution: '' }), value => value.status === 400);
    assert.deepEqual(await service.updateRequest('123', { reference, status: 'closed', resolution: 'Identity verified; fulfilled manually.' }), { updated: true });
    assert.equal(pool.calls.length, 1);
    assert.match(pool.calls[0][0], /^UPDATE privacy_requests/);
});

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const registration = path => {
    const start = server.indexOf(`API.post('${path}'`);
    assert.ok(start >= 0, path);
    return server.slice(start, server.indexOf('\n});', start) + 4);
};

test('actual privacy routes cannot opt in, and accept Terms without altering historical preferences', async () => {
    const pool = database({ accepted: true, preference: [{ private_category_research: 1, research_version: LEGAL_VERSIONS.research }] });
    const privacyControls = createPrivacyControls({ pool, hashes });
    const handlers = new Map();
    const middleware = () => {};
    const context = { API: { post(path, ...callbacks) { handlers.set(path, callbacks.at(-1)); } },
        discussionSameOrigin: middleware, requireAuthForAPI: middleware, requireAccountWriteOwner: middleware,
        privacyForm: middleware, privacyControls, validateLegalChoice, legalDocumentHashes: hashes,
        crypto, URLSearchParams, publicOrigin: 'https://benchpoll.test', githubClientID: 'fixture', saveSession: async () => {} };
    for (const path of ['/prepare_github_login', '/accept_legal_terms', '/save_privacy_preferences']) {
        vm.runInNewContext(registration(path), context);
    }
    const request = { body: input({ privateCategoryResearch: true }), user: { ID: '123', isSenior: false }, session: {} };
    const response = { set() {}, json(value) { this.value = value; } };
    for (const handler of handlers.values()) {
        await assert.rejects(handler(request, response), value => value.body?.error === 'private_category_research_unavailable');
    }
    assert.deepEqual(pool.calls, []);
    delete request.body.privateCategoryResearch;
    await handlers.get('/prepare_github_login')(request, response);
    assert.equal(request.session.githubOAuth.legalChoice.privateCategoryResearch, null);
    await handlers.get('/accept_legal_terms')(request, response);
    assert.equal(response.value.accepted, true);
    assert.equal(response.value.privateCategoryResearch, false);
    assert.equal(pool.calls.some(([sql]) => /user_privacy_preferences|privacy_preference_events/.test(sql)), false);
});

test('mutation gate protects writes but never blocks logout, deactivation or privacy rights behind new Terms', () => {
    for (const path of ['/save_personal_pie', '/create_private_category', '/submit_contribution',
        '/create_discussion_post', '/vote_discussion', '/save_comparison_profile']) {
        assert.match(registration(path), /requireAccountWriteOwner, requireCurrentTermsForAPI, async/);
    }
    for (const path of ['/logout', '/delete_account', '/save_privacy_preferences', '/submit_privacy_request', '/list_privacy_requests']) {
        assert.doesNotMatch(registration(path).split('\n')[0], /requireCurrentTermsForAPI/);
    }
    for (const path of ['/list_privacy_requests', '/update_privacy_request']) {
        assert.match(registration(path), /requireSeniorReviewerAuthForAPI, requireAccountWriteOwner, privacyForm/);
    }
    assert.doesNotMatch(registration('/submit_privacy_request').split('\n')[0], /requireAuthForAPI|requireAccountWriteOwner/);
    assert.match(registration('/submit_privacy_request'), /limitPrivacyRequest\(req.sessionID\)/);
    assert.match(registration('/submit_privacy_request'), /limitPrivacyPeer\(req.ip\)/);
    assert.match(server, /const limitPrivacyPeer = createPrivacyRequestLimiter\(\{ limit: 200 \}\)/);
});

test('mutation gate checks the current version rather than trusting a stale browser/session flag', async () => {
    const start = server.indexOf('const requireCurrentTermsForAPI =');
    const source = server.slice(start, server.indexOf('\n};', start) + 3);
    let accepted = false, checked;
    const guard = vm.runInNewContext(`${source}\nrequireCurrentTermsForAPI`, {
        privacyControls: { async hasAccepted(userID) { checked = userID; return accepted; } }
    });
    let failure;
    await guard({ user: { ID: '18446744073709551615' }, session: { legalAccepted: true } }, {}, error => { failure = error; });
    assert.equal(checked, '18446744073709551615');
    assert.equal(failure.status, 409);
    assert.equal(failure.body.error, 'legal_acceptance_required');
    assert.equal(failure.body.url, '/account/privacy');
    accepted = true; failure = null;
    await guard({ user: { ID: '123' } }, {}, error => { failure = error; });
    assert.equal(failure, undefined);
});

test('OAuth uses compact explicit continuation, and callback cannot create a user without evidence', async () => {
    const loginStart = server.slice(server.indexOf("page.get('/github_login'"), server.indexOf("page.get('/github_callback'"));
    assert.match(loginStart, /res.sendFile\(currentDir \+ '\/private\/sign-in.html'\)/);
    assert.doesNotMatch(loginStart, /githubOAuth\s*=/);
    const start = server.indexOf("page.get('/github_callback'");
    const code = server.slice(start, server.indexOf('\n});', start) + 4);
    let handler, fetches = 0;
    vm.runInNewContext(code, {
        page: { get(_path, _marker, callback) { handler = callback; } }, markErrorFrom() {},
        saveSession: async () => {}, assertPendingLegalChoice, legalDocumentHashes: hashes,
        crypto, Buffer, Date, fetch() { ++fetches; throw new Error('must not run'); }
    });
    let destination;
    const req = { query: { code: 'code', state: 'state' }, session: { githubOAuth: {
        state: 'state', createdAt: Date.now(), redirectURI: 'https://example.test/github_callback'
    } } };
    await handler(req, { set() {}, redirect(url) { destination = url; } }, error => { throw error; });
    assert.equal(destination, '/github_login');
    assert.equal(fetches, 0);
    assert.equal(req.session.githubOAuth, undefined);
    assert.ok(code.indexOf('assertPendingLegalChoice') < code.indexOf("fetch('https://github.com"));
    assert.match(code, /privacyControls.recordAcceptanceOn\(loginConnection, userID, oauth.legalChoice\)/);
    assert.ok(code.indexOf('commitTransactionConnection(loginConnection') < code.indexOf('regenerateSession(req)'));
});
