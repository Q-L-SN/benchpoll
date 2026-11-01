import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { canonicalWritePayload } from '../public/js/shared/write-intent.js';
import { decisionCases, createModerationMutationHarness, runDecisionReplayProbe } from '../scripts/review-moderation-replay-20261008.mjs';

for (const scenario of decisionCases) {
    for (let repetition = 1; repetition <= 2; repetition++) test(`${scenario}: committed response replay (${repetition})`, async () => {
        const result = await runDecisionReplayProbe({ scenario });
        assert.equal(result.passed, true);
        assert.equal(result.replayRows, 1);
        assert.equal(canonicalWritePayload(result.responses[0].body), canonicalWritePayload(result.responses[1].body));
    });
    test(`${scenario}: a different intent retains genuine changed-state rejection`, async () => {
        const harness = await createModerationMutationHarness({ scenario });
        await harness.invoke();
        await assert.rejects(harness.invoke(), error => error.status === 409);
        assert.equal(harness.summary().mutations, 1);
        assert.equal(harness.summary().replayRows, 1);
    });
    test(`${scenario}: changed input cannot reuse a committed identity`, async () => {
        const harness = await createModerationMutationHarness({ scenario }), key = randomUUID();
        await harness.invoke(harness.body, key);
        const input = structuredClone(harness.body);
        if (scenario === 'apply') input.content.details += ' Changed.';
        else if (scenario === 'escalate') input.note += ' Changed.';
        else if (['source', 'correction'].includes(scenario)) input.choice = scenario === 'source' ? 'correction' : 'source';
        else input.status = scenario === 'approve' ? 'rejected' : 'approved';
        await assert.rejects(harness.invoke(input, key), error => error.body?.error === 'write_identity_reused');
        assert.equal(harness.summary().mutations, 1);
    });
    test(`${scenario}: a replacement document actor cannot replay`, async () => {
        const harness = await createModerationMutationHarness({ scenario }), key = randomUUID();
        await harness.invoke(harness.body, key);
        await assert.rejects(harness.invoke({ ...harness.body, expectedUserID: '1' }, key, '2'),
            error => error.body?.error === 'account_changed');
        assert.equal(harness.summary().mutations, 1);
    });
    test(`${scenario}: failed business work rolls back the identity and remains retryable`, async () => {
        const harness = await createModerationMutationHarness({ scenario, failBusiness: true }), key = randomUUID();
        await assert.rejects(harness.invoke(harness.body, key), error => error.body?.error === 'synthetic_business_failure');
        assert.equal(harness.summary().mutations, 0); assert.equal(harness.summary().replayRows, 0);
        assert.equal(harness.summary().outbox, 0);
        assert.equal(harness.events.some(event => event.kind === 'invalidate'), false);
        harness.setBusinessFailure(false);
        await harness.invoke(harness.body, key);
        assert.equal(harness.summary().mutations, 1); assert.equal(harness.summary().replayRows, 1);
    });
}

for (const scenario of ['approve', 'reject', 'apply']) {
    test(`${scenario}: graph lock precedes each intent and only a new commit invalidates topic home`, async () => {
        const harness = await createModerationMutationHarness({ scenario }), key = randomUUID();
        await harness.invoke(harness.body, key);
        await harness.invoke(harness.body, key);
        for (const connectionID of [1, 2]) {
            const events = harness.events.filter(event => event.connectionID === connectionID);
            const begin = events.findIndex(event => event.kind === 'begin');
            const lock = events.findIndex(event => event.kind === 'graph-lock-acquired');
            const intent = events.findIndex(event => event.sql?.startsWith('INSERT INTO write_requests'));
            const commit = events.findIndex(event => event.kind === 'commit');
            const unlock = events.findIndex(event => event.kind === 'graph-lock-released');
            assert.ok(begin >= 0 && lock > begin && intent > lock && commit > intent && unlock > commit);
        }
        const invalidations = harness.events.filter(event => event.kind === 'invalidate');
        assert.equal(invalidations.length, 1, 'Cached replays do not invalidate again');
        assert.ok(harness.events.indexOf(invalidations[0]) > harness.events.findIndex(event => event.kind === 'commit'));
    });

    for (const sameKey of [true, false]) test(`${scenario}: graph lock serializes concurrent ${sameKey ? 'replays' : 'independent decisions'}`,
        { timeout: 2000 }, async () => {
            const harness = await createModerationMutationHarness({ scenario }), key = randomUUID();
            const results = await Promise.allSettled([
                harness.invoke(harness.body, key), harness.invoke(harness.body, sameKey ? key : randomUUID())
            ]);
            assert.equal(results.filter(result => result.status === 'fulfilled').length, sameKey ? 2 : 1);
            if (sameKey) assert.equal(canonicalWritePayload(results[0].value), canonicalWritePayload(results[1].value));
            else assert.equal(results.find(result => result.status === 'rejected').reason.body?.error, 'already_reviewed');
            assert.equal(harness.summary().mutations, 1);
            assert.equal(harness.summary().replayRows, 1);
            assert.equal(harness.summary().successAudits, 1);
            assert.equal(harness.summary().outbox, 1);
            assert.equal(harness.events.filter(event => event.kind === 'graph-lock-acquired').length, 2);
            assert.equal(harness.events.filter(event => event.kind === 'graph-lock-released').length, 2);
            assert.equal(harness.events.filter(event => event.kind === 'invalidate').length, 1);
        });

    test(`${scenario}: a missing graph-lock row rejects before claiming an intent and remains retryable`, async () => {
        const harness = await createModerationMutationHarness({ scenario, graphLockAvailable: false }), key = randomUUID();
        await assert.rejects(harness.invoke(harness.body, key),
            error => error.status === 503 && error.body?.error === 'topic_reference_schema_unavailable');
        assert.equal(harness.events.some(event => event.sql?.includes('write_requests')), false);
        assert.equal(harness.events.some(event => event.kind === 'invalidate'), false);
        assert.equal(harness.summary().mutations, 0);
        assert.equal(harness.summary().replayRows, 0);
        assert.equal(harness.summary().outbox, 0);
        assert.equal(harness.summary().failureAudits, 1);
        harness.setGraphLockAvailable(true);
        assert.equal((await harness.invoke(harness.body, key)).status, 200);
        assert.equal(harness.summary().mutations, 1);
        assert.equal(harness.summary().replayRows, 1);
    });
}

test('an already committed apply returns its original result even after its preview expires', async () => {
    const harness = await createModerationMutationHarness({ scenario: 'apply' }), key = randomUUID();
    const first = await harness.invoke(harness.body, key);
    harness.advanceClock(20 * 60 * 1000);
    const replay = await harness.invoke(harness.body, key);
    assert.equal(canonicalWritePayload(first.body), canonicalWritePayload(replay.body));
    assert.equal(harness.summary().mutations, 1);
});

test('an expired preview cannot start a new apply intent', async () => {
    const harness = await createModerationMutationHarness({ scenario: 'apply' });
    harness.advanceClock(20 * 60 * 1000);
    await assert.rejects(harness.invoke(), error => error.body?.error === 'moderation_preview_expired');
    assert.equal(harness.summary().mutations, 0); assert.equal(harness.summary().replayRows, 0);
});
