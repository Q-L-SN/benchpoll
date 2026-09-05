import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildModerationDecisionEmail,
    createModerationEmailService
} from '../moderation-email.js';

test('moderation decision emails state the contribution type and final result', () => {
    const approved = buildModerationDecisionEmail({
        moderationLogID: 41,
        decision: 'approved',
        contributionType: 'benchmark_result',
        publicOrigin: 'https://benchpoll.com/path-is-ignored'
    });
    assert.equal(approved.subject, 'Your BenchPoll score contribution was approved');
    assert.match(approved.text, /score contribution \(#41\) was approved/);
    assert.match(approved.text, /https:\/\/benchpoll\.com/);
    assert.doesNotMatch(approved.text, /path-is-ignored/);

    const rejected = buildModerationDecisionEmail({
        moderationLogID: 42,
        decision: 'rejected',
        contributionType: 'new_benchmark',
        publicOrigin: 'https://benchpoll.com'
    });
    assert.equal(rejected.subject, 'Your BenchPoll benchmark contribution was not approved');
    assert.match(rejected.text, /submit a corrected contribution/);
});

test('moderation decisions enqueue the verified user email inside the review transaction', async () => {
    const calls = [];
    const connection = {
        async execute(sql, params) {
            calls.push({ sql, params });
            if (/SELECT email FROM users/.test(sql)) {
                return [[{ email: 'verified@example.com' }]];
            }
            return [{ insertId: 77 }];
        }
    };
    const service = createModerationEmailService({
        pool: {},
        publicOrigin: 'https://benchpoll.com',
        environment: {},
        transport: null
    });
    const queued = await service.enqueue(connection, {
        moderationLogID: 41,
        userID: 9,
        decision: 'approved',
        contributionType: 'benchmark_result'
    });

    assert.deepEqual(queued, {
        ID: 77,
        recipientAvailable: true,
        deliveryConfigured: false
    });
    assert.match(calls[1].sql, /INSERT INTO moderation_email_outbox/);
    assert.deepEqual(calls[1].params.slice(0, 6), [
        41,
        9,
        'verified@example.com',
        'approved',
        'benchmark_result',
        'pending'
    ]);
});

test('successful delivery marks an outbox notification as sent', async () => {
    const calls = [];
    const sent = [];
    const pool = {
        async execute(sql, params) {
            calls.push({ sql, params });
            if (/SET delivery_status = 'sending'/.test(sql)) {
                return [{ affectedRows: 1 }];
            }
            if (/FROM moderation_email_outbox/.test(sql) && /delivery_status = 'sending'/.test(sql)) {
                return [[{
                    ID: 77,
                    moderationLogID: 41,
                    recipientEmail: 'verified@example.com',
                    decision: 'approved',
                    contributionType: 'model_result',
                    attemptCount: 1
                }]];
            }
            return [{ affectedRows: 1 }];
        }
    };
    const service = createModerationEmailService({
        pool,
        publicOrigin: 'https://benchpoll.com',
        environment: { BENCHPOLL_NOTIFICATION_FROM: 'BenchPoll <notifications@benchpoll.com>' },
        transport: { async sendMail(message) { sent.push(message); } }
    });

    assert.deepEqual(await service.deliver(77), { sent: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'verified@example.com');
    assert(calls.some(call => /SET delivery_status = 'sent'/.test(call.sql)));
});

test('failed delivery records an error and schedules a retry', async () => {
    const calls = [];
    const pool = {
        async execute(sql, params) {
            calls.push({ sql, params });
            if (/SET delivery_status = 'sending'/.test(sql)) {
                return [{ affectedRows: 1 }];
            }
            if (/FROM moderation_email_outbox/.test(sql) && /delivery_status = 'sending'/.test(sql)) {
                return [[{
                    ID: 78,
                    moderationLogID: 42,
                    recipientEmail: 'verified@example.com',
                    decision: 'rejected',
                    contributionType: 'new_model',
                    attemptCount: 1
                }]];
            }
            return [{ affectedRows: 1 }];
        }
    };
    const service = createModerationEmailService({
        pool,
        publicOrigin: 'https://benchpoll.com',
        environment: { BENCHPOLL_NOTIFICATION_FROM: 'BenchPoll <notifications@benchpoll.com>' },
        logger: { error() {} },
        transport: { async sendMail() { throw new Error('temporary SMTP failure'); } }
    });

    assert.deepEqual(await service.deliver(78), { sent: false, reason: 'delivery_failed' });
    const retry = calls.find(call => /SET delivery_status = 'failed'/.test(call.sql));
    assert(retry);
    assert.equal(retry.params[0], 5);
    assert.equal(retry.params[1], 'temporary SMTP failure');
});
