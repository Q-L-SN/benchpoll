import assert from 'node:assert/strict';
import test from 'node:test';
import { mutationRoutes, runFailureAuditProbe } from '../scripts/review-moderation-transactions-20261008.mjs';

function assertGraphLockCleanup(result) {
    assert.equal(result.events.some(event => event.action === 'invalidate'), false, 'Failed decisions do not invalidate topic home');
    if (!['apply_moderation_log', 'review_moderation_log'].includes(result.route)) return;
    let owner = null;
    for (const event of result.events) {
        if (event.action === 'graph-lock-acquired') {
            assert.equal(owner, null, 'Graph-changing transactions are mutually exclusive');
            assert.equal(event.transaction, 1);
            owner = event.ID;
        } else if (event.action === 'claim-write-intent') {
            assert.equal(owner, event.ID, 'Claim the intent only while owning the graph lock');
        } else if (event.action === 'graph-lock-released') {
            assert.equal(owner, event.ID);
            owner = null;
        } else if (event.action === 'audit') {
            assert.notEqual(owner, event.ID, 'Failure audit does not retain the failed business graph lock');
        }
    }
    assert.equal(owner, null);
    for (let ID = 1; ID <= result.capacity; ID++) {
        const events = result.events.filter(event => event.ID === ID);
        assert.equal(events.filter(event => event.action === 'graph-lock-acquired').length, 1);
        assert.equal(events.filter(event => event.action === 'graph-lock-released').length, 1);
        const cleanup = events.findIndex(event => event.action === (result.rollbackFailure ? 'destroy' : 'rollback'));
        assert.ok(cleanup >= 0 && events.findIndex(event => event.action === 'graph-lock-released') > cleanup);
    }
}

for (const route of mutationRoutes) {
    for (const capacity of [1, 10]) test(`${route} failure auditing completes with every pool lease occupied (${capacity})`, async () => {
        const result = await runFailureAuditProbe({ route, capacity });
        assert.equal(result.completed, capacity);
        assert.equal(result.pendingBorrows, 0);
        assert.equal(result.retainedLeases, 0);
        assert.equal(result.borrowCalls, capacity, 'Never borrow a nested connection');
        assert.equal(result.auditRows, capacity);
        assert.equal(result.events.some(event => event.action.startsWith('email-')), false);
        assert.ok(result.outcomes.every(value => value.error === (['send_admin_message', 'resolve_score_sync_conflict'].includes(route)
            ? 'synthetic_operation_failure' : 'already_reviewed')));
        for (let ID = 1; ID <= capacity; ID++) {
            const events = result.events.filter(event => event.ID === ID);
            const audit = events.findIndex(event => event.action === 'audit');
            const rollback = events.findIndex(event => event.action === 'rollback' && event.transaction === 1);
            assert.ok(rollback >= 0 && audit > rollback);
            assert.equal(events[audit].transaction, 2, 'Failure audit runs in a separate transaction after business rollback');
            assert.equal(events.filter(event => event.action === 'commit' && event.transaction === 1).length, 0);
            assert.equal(events.filter(event => event.action === 'release').length, 1);
        }
        assert.equal(result.events.some(event => event.action === 'implicit-commit'), false);
        assertGraphLockCleanup(result);
    });
    test(`${route} preserves the operation error when failure audit insert fails`, async () => {
        const result = await runFailureAuditProbe({ route, capacity: 10, auditFailure: true });
        assert.equal(result.completed, 10);
        assert.equal(result.auditRows, 0);
        assert.equal(result.borrowCalls, 10);
        assert.equal(result.retainedLeases, 0);
        assert.equal(result.events.some(event => event.action.startsWith('email-')), false);
        assert.ok(result.outcomes.every(value => !value.error.includes('audit insert')));
        assert.equal(result.events.filter(event => event.action === 'rollback' && event.transaction === 2).length, 10);
        assertGraphLockCleanup(result);
    });
    test(`${route} destroys uncertain transactions instead of committing them through an audit`, async () => {
        const result = await runFailureAuditProbe({ route, capacity: 10, rollbackFailure: true });
        assert.equal(result.completed, 10);
        assert.equal(result.auditRows, 0);
        assert.equal(result.events.some(event => event.action.startsWith('email-')), false);
        assert.equal(result.retainedLeases, 0);
        assert.equal(result.events.filter(event => event.action === 'destroy').length, 10);
        assert.equal(result.events.some(event => event.action === 'implicit-commit'), false);
        assert.equal(result.events.some(event => event.action === 'begin' && event.transaction === 2), false);
        assert.ok(result.outcomes.every(value => !value.error.includes('rollback') && !value.error.includes('destroyed')));
        assertGraphLockCleanup(result);
    });
}

test('official score advisory-lock cleanup does not overwrite an earlier resolution error', async () => {
    const result = await runFailureAuditProbe({ route: 'resolve_score_sync_conflict', lockReleaseFailure: true });
    assert.equal(result.completed, 10);
    assert.equal(result.retainedLeases, 0);
    assert.ok(result.outcomes.every(value => value.error === 'synthetic_operation_failure'));
    assert.equal(result.events.filter(event => event.action === 'destroy').length, 10);
});
