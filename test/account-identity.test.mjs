import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { canonicalAccountID, assertAccountWriteOwner, requireAccountWriteOwner,
    isAccountWriteError, createAccountWriteScope, accountWriteError } from '../public/js/shared/account-identity.js';

const ownedRoutes = ['save_personal_pie', 'save_comparison_profile', 'rename_comparison_profile', 'delete_comparison_profile',
    'create_discussion_post', 'vote_discussion', 'delete_discussion_post', 'create_private_category',
    'submit_contribution', 'logout', 'delete_account', 'review_moderation_log', 'apply_moderation_log',
    'preview_moderation_sql', 'escalate_moderation_log', 'send_admin_message', 'mark_admin_message_read',
    'resolve_score_sync_conflict', 'get_reported_discussion', 'list_moderation_logs', 'admin_data_explorer',
    'admin_data_record', 'list_admin_messages', 'list_moderation_audit_logs', 'list_score_sync_conflicts', 'get_moderation_audit_log'];

test('account identities are compared exactly without rounding or coercing malformed input', () => {
    for (const value of ['1', '9007199254740993', '18446744073709551615']) {
        assert.equal(canonicalAccountID(value), value);
        assert.doesNotThrow(() => assertAccountWriteOwner(value, value));
    }
    assert.equal(canonicalAccountID(7), '7');
    for (const value of [0, -1, 1.1, NaN, Infinity, 9007199254740992, null, {}, true,
        '0', '01', '+1', '1.0', ' 1', '1 ', '1e1', '18446744073709551616', '1'.repeat(100)]) {
        assert.equal(canonicalAccountID(value), null);
    }
    assert.throws(() => assertAccountWriteOwner('9007199254740993', '9007199254740992'),
        error => error.status === 409 && isAccountWriteError(error));
});

test('missing expected account is rejected and cannot choose a write owner', () => {
    for (const expected of [undefined, null, 7, '0', '07', [], {}]) {
        assert.throws(() => assertAccountWriteOwner('7', expected),
            error => error.status === 409 && error.body.error === 'account_identity_required');
    }
    assert.throws(() => assertAccountWriteOwner(null, '7'), error => error.status === 401);
    assert.throws(() => assertAccountWriteOwner('8', '7'), error => error.body.error === 'account_changed');
});

test('Express account guard rejects old-session writes before any mutation runs', async () => {
    const app = express();
    const writes = [];
    let sessionUserID = '7';
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { userID: sessionUserID }; next(); });
    for (const path of ownedRoutes) {
        app.post(`/api/${path}`, requireAccountWriteOwner, (req, res) => {
            writes.push({ path, userID: req.session.userID });
            res.json({ saved: true });
        });
    }
    app.use((error, _req, res, _next) => res.status(error.status ?? 500).json(error.body));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const send = (path, body) => fetch(`http://127.0.0.1:${server.address().port}/api/${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    try {
        for (const path of ownedRoutes) {
            assert.equal((await send(path, { expectedUserID: '7' })).status, 200);
            sessionUserID = '8';
            const rejected = await send(path, { expectedUserID: '7', userID: '8' });
            assert.equal(rejected.status, 409);
            assert.deepEqual(await rejected.json(), { error: 'account_changed' });
            assert.equal((await send(path, {})).status, 409);
            sessionUserID = null;
            assert.equal((await send(path, { expectedUserID: '7' })).status, 401);
            sessionUserID = '7';
        }
        assert.equal(writes.length, ownedRoutes.length);
        assert.ok(writes.every(write => write.userID === '7'));
    } finally { await new Promise(resolve => server.close(resolve)); }
});

test('production registrations protect each reviewed mutation before its handler', async () => {
    const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
    const order = /require(?:Auth|ReviewerAuth|SeniorReviewerAuth)ForAPI, requireAccountWriteOwner, (?:requireCurrentTermsForAPI, )?async/;
    assert.doesNotMatch('requireAuthForAPI, requireCurrentTermsForAPI, requireAccountWriteOwner, async', order);
    assert.doesNotMatch('requireAccountWriteOwner, requireAuthForAPI, requireCurrentTermsForAPI, async', order);
    for (const path of ownedRoutes) {
        const registration = source.slice(source.indexOf(`API.post('/${path}'`)).split('\n', 1)[0];
        assert.match(registration, order, path);
    }
});

test('a page scope binds the first exact account and cannot adopt a replacement reader', async () => {
    const scope = createAccountWriteScope();
    scope.bind(null);
    await assert.rejects(scope.write(() => assert.fail('A guest cannot dispatch an account write'), '/write'), isAccountWriteError);
    scope.bind('9007199254740993');
    const result = await scope.write(async (_path, body) => body, '/write', { value: 1, expectedUserID: '8' });
    assert.deepEqual(result, { value: 1, expectedUserID: '9007199254740993' });
    assert.throws(() => scope.bind('8'), isAccountWriteError);
    assert.throws(() => scope.bind('9007199254740993'), isAccountWriteError);
    await assert.rejects(scope.write(() => assert.fail('A blocked page must not dispatch'), '/write'), isAccountWriteError);
});

test('a page scope rejects missing or malformed reader identities without rounding', () => {
    for (const value of [undefined, 7, '', '07', '18446744073709551616', {}, false]) {
        const scope = createAccountWriteScope();
        assert.throws(() => scope.bind(value), error => error.body.error === 'account_identity_required');
        assert.throws(() => scope.bind('7'), isAccountWriteError);
    }
    const scope = createAccountWriteScope();
    scope.bind('7');
    assert.throws(() => scope.bind(null), isAccountWriteError);
    assert.throws(() => scope.capture(), isAccountWriteError);
});

test('a completed write cannot update the document after its account was invalidated', async () => {
    const scope = createAccountWriteScope();
    scope.bind('7');
    let complete;
    const pending = scope.write((_path, body) => {
        assert.equal(body.expectedUserID, '7');
        return new Promise(resolve => { complete = resolve; });
    }, '/write');
    scope.invalidate();
    complete({ saved: true });
    await assert.rejects(pending, isAccountWriteError);
});

test('server identity errors block further page writes and ordinary failures stay retryable', async () => {
    for (const code of ['account_changed', 'account_identity_required']) {
        const scope = createAccountWriteScope();
        scope.bind('7');
        await assert.rejects(scope.write(async () => {
            const error = accountWriteError(code); error.message = code; throw error;
        }, '/write'), error => isAccountWriteError(error) && /Refresh this page/.test(error.message));
        await assert.rejects(scope.write(() => assert.fail('Must not retry under a different session'), '/write'), isAccountWriteError);
    }
    const scope = createAccountWriteScope();
    scope.bind('7');
    await assert.rejects(scope.write(async () => { throw new Error('Network failure'); }, '/write'), /Network failure/);
    assert.deepEqual(await scope.write(async () => ({ saved: true }), '/write'), { saved: true });
    await assert.rejects(scope.write(async () => { throw Object.assign(new Error('Signed out'), { status: 401 }); }, '/write'), /Signed out/);
    assert.throws(() => scope.capture(), isAccountWriteError);
});
