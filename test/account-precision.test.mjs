import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { accountPairs, precisionCases, runAccountPrecisionProbe, probeActiveAccount,
    probeDriverConfiguration, probeInvalidRecipient, probeDiscussionOwnership } from '../scripts/review-account-precision-20261008.mjs';
import { moderationAuditSnapshot, insertModerationAuditLog } from '../moderation-admin.js';

const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
const discussion = await readFile(new URL('../discussion-service.js', import.meta.url), 'utf8');
for (const [actor, neighbor] of accountPairs) for (const scenario of precisionCases) for (let repetition = 1; repetition <= 2; repetition++) {
    test(`exact account ${actor}: ${scenario} (${repetition})`, async () => {
        const result = await runAccountPrecisionProbe({ actor, neighbor, scenario });
        assert.equal(result.passed, true, JSON.stringify(result));
    });
}

for (const [actor, neighbor] of accountPairs) {
    test(`discussion ownership stays exact for ${actor} regardless of GitHub visibility or active state`, async () => {
        for (const author of [actor, neighbor]) for (const showGitHubProfile of [false, true]) for (const active of [false, true]) {
            assert.equal(await probeDiscussionOwnership(discussion, actor, author, { showGitHubProfile, active }), author === actor);
        }
    });
}

test('application pool preserves unsafe integers without forcing safe counts to strings', async () => {
    const source = await readFile(new URL('../db.js', import.meta.url), 'utf8');
    const options = await probeDriverConfiguration(source);
    assert.equal(options.supportBigNumbers, true); assert.equal(options.bigNumberStrings, false);
});

const invalid = [0, -1, true, '', '01', '1e0', Number('9007199254740993'), '18446744073709551616', {}, [], null, undefined];
for (const [index, value] of invalid.entries()) test(`invalid account cannot reach identity SQL (${index})`, async () => {
    const result = await probeActiveAccount(server, value);
    assert.equal(result.user, null); assert.equal(result.calls.length, 0);
    assert.deepEqual(await probeInvalidRecipient(value), { rejected: true, queries: 0 });
});

test('a returned account different from the requested account cannot authorize a role', async () => {
    const result = await probeActiveAccount(server, accountPairs[0][0], accountPairs[0][1]);
    assert.equal(result.user, null);
});

test('safe legacy numeric accounts are canonicalized to exact strings', async () => {
    for (const actor of [1, Number.MAX_SAFE_INTEGER, '7']) {
        const result = await probeActiveAccount(server, actor);
        assert.equal(result.user.ID, String(actor)); assert.equal(result.calls[0].args[0], String(actor));
    }
});

test('invalid reviewer or contributor identities cannot be silently recorded', async () => {
    for (const value of invalid) {
        const calls = [];
        await assert.rejects(insertModerationAuditLog({ execute: async (...args) => calls.push(args) },
            { statements: [{ sql: 'SELECT 1', success: true }], elapsedMs: () => 0 },
            { reviewerUserID: value, actionType: 'approve', requestBefore: { content: { type: 'feedback' } } }), /valid reviewer user ID/);
        assert.equal(calls.length, 0);
        if (value != null) assert.throws(() => moderationAuditSnapshot({ ID: 7, user_id: value }, {}), /valid contributor user ID/);
    }
    assert.equal(moderationAuditSnapshot({ ID: 7, user_id: null }, {}).submittedBy, null);
});
