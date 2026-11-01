import assert from 'node:assert/strict';
import test from 'node:test';
import { openAccountCenter } from '../public/js/shared/account-center.js';

test('shared account center exports the same entry point for homepage and configuration', () => {
    assert.equal(typeof openAccountCenter, 'function');
});

test('account center refuses malformed or rounded identities before binding or touching the DOM', async () => {
    for (const userID of [null, undefined, '', '0', '01', 7, 9007199254740993, '18446744073709551616', {}, 7n]) {
        await assert.rejects(openAccountCenter({ profile: { userID, userName: 'Member' } }),
            error => error?.status === 409 && error?.payload?.error === 'account_identity_required');
    }
});
