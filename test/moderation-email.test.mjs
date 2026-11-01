import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

import {
    buildModerationDecisionEmail,
    createModerationEmailService,
    inspectModerationEmailConfiguration
} from '../moderation-email.js';

const smtpEnvironment = {
    BENCHPOLL_SMTP_HOST: 'smtp.example.invalid',
    BENCHPOLL_SMTP_PORT: '587',
    BENCHPOLL_SMTP_USER: 'private-smtp-user',
    BENCHPOLL_SMTP_PASSWORD: 'private-smtp-password',
    BENCHPOLL_NOTIFICATION_FROM: 'BenchPoll <notifications@example.invalid>'
};
const optionalVariables = [
    'BENCHPOLL_SMTP_SECURE',
    'BENCHPOLL_EMAIL_DELIVERY_ENABLED',
    'BENCHPOLL_EMAIL_DAILY_LIMIT',
    'BENCHPOLL_EMAIL_MIN_OUTBOX_ID',
    'BENCHPOLL_NOTIFICATION_REPLY_TO'
];

function workerFixture({
    environment = {},
    notifications = [{ ID: 77 }],
    sendMail = async () => {},
    sleep = async (ms, clock) => { clock.now += ms; }
} = {}) {
    const clock = { now: Date.UTC(2026, 9, 18, 12) };
    const calls = [];
    const sent = [];
    const waits = [];
    const errors = [];
    const rows = notifications.map(row => ({
        moderationLogID: 41,
        recipientEmail: 'verified@example.invalid',
        decision: 'approved',
        contributionType: 'benchmark_result',
        attemptCount: 0,
        deliveryStatus: 'pending',
        nextAttemptAt: null,
        lockedAt: null,
        sentAt: null,
        createdAt: new Date(clock.now),
        ...row
    }));
    const eligible = row => row.recipientEmail && ['pending', 'failed'].includes(row.deliveryStatus)
        && !['smtp_permanent_rejection', 'delivery_uncertain_retry_window_elapsed'].includes(row.lastError)
        && row.attemptCount < 8 && (row.nextAttemptAt === null || row.nextAttemptAt <= clock.now);
    const pool = {
        async execute(sql, params) {
            calls.push({ sql, params });
            if (/COUNT\(\*\) AS sentCount/.test(sql)) {
                return [[{ sentCount: rows.filter(row => row.deliveryStatus === 'sent'
                    && row.sentAt > clock.now - 24 * 60 * 60_000).length }]];
            }
            if (/last_error = 'delivery_uncertain_retry_window_elapsed'/.test(sql)) {
                for (const row of rows) {
                    if (row.ID >= params[0] && row.attemptCount > 0 && row.attemptCount < params[1]
                        && ['pending', 'failed', 'sending'].includes(row.deliveryStatus)
                        && Number(row.createdAt) <= clock.now - 23 * 60 * 60_000) {
                        Object.assign(row, { deliveryStatus: 'failed', lockedAt: null,
                            nextAttemptAt: null, lastError: 'delivery_uncertain_retry_window_elapsed' });
                    }
                }
                return [{ affectedRows: 1 }];
            }
            if (/stale_delivery_claim_recovered/.test(sql)) {
                assert.match(sql, /WHERE ID >= \?/);
                for (const row of rows) {
                    if (row.ID >= params[0] && row.deliveryStatus === 'sending'
                        && row.lockedAt < clock.now - 10 * 60_000) {
                        Object.assign(row, { deliveryStatus: 'failed', lockedAt: null,
                            nextAttemptAt: clock.now, lastError: 'stale_delivery_claim_recovered' });
                    }
                }
                return [{ affectedRows: 1 }];
            }
            if (/SET delivery_status = 'sending'/.test(sql)) {
                assert.match(sql, /AND ID >= \?/);
                assert.equal(params[2], 8);
                const row = rows.find(row => row.ID === params[0] && row.ID >= params[1] && eligible(row)
                    && (row.attemptCount === 0 || Number(row.createdAt) > clock.now - 23 * 60 * 60_000));
                if (!row) return [{ affectedRows: 0 }];
                row.deliveryStatus = 'sending';
                row.lockedAt = clock.now;
                row.attemptCount++;
                return [{ affectedRows: 1 }];
            }
            if (/SELECT ID\s+FROM moderation_email_outbox/.test(sql)) {
                assert.match(sql, /WHERE ID >= \?/);
                assert.equal(params[1], 8);
                return [rows.filter(row => row.ID >= params[0] && eligible(row))
                    .sort((a, b) => a.ID - b.ID).slice(0, 20).map(row => ({ ID: row.ID }))];
            }
            const row = rows.find(row => row.ID === params.at(-1) && row.deliveryStatus === 'sending');
            if (/SELECT ID, moderation_log_ID/.test(sql)) return [row ? [{ ...row }] : []];
            if (/SET delivery_status = 'sent'/.test(sql)) {
                if (!row) return [{ affectedRows: 0 }];
                Object.assign(row, { deliveryStatus: 'sent', sentAt: clock.now, lockedAt: null,
                    nextAttemptAt: null, lastError: null });
                return [{ affectedRows: 1 }];
            }
            if (/SET delivery_status = 'failed'/.test(sql)) {
                if (!row) return [{ affectedRows: 0 }];
                Object.assign(row, { deliveryStatus: 'failed', lockedAt: null,
                    nextAttemptAt: params[0] ? null : clock.now + params[1] * 60_000,
                    lastError: params[2] });
                return [{ affectedRows: 1 }];
            }
            assert.fail(`Unexpected fixture query: ${sql}`);
        }
    };
    const service = createModerationEmailService({
        pool,
        publicOrigin: 'https://benchpoll.example.invalid',
        environment,
        clock: () => clock.now,
        async sleep(ms) { waits.push(ms); await sleep(ms, clock); },
        logger: { error(...args) { errors.push(args); } },
        transport: { async sendMail(message) {
            sent.push({ message, at: clock.now });
            const result = await sendMail(message);
            return result === undefined ? { accepted: [message.to], rejected: [] } : result;
        } }
    });
    return { service, pool, rows, calls, sent, waits, errors, clock };
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

test('missing SMTP settings are reported without enabling delivery', () => {
    assert.deepEqual(inspectModerationEmailConfiguration({}), {
        deliveryConfigured: false,
        smtpConfigured: false,
        variables: Object.fromEntries([
            ...Object.keys(smtpEnvironment), ...optionalVariables
        ].map(name => [name, 'missing'])),
        configurationError: null
    });
});

test('partial SMTP configuration reports only the missing variable names', () => {
    const environment = { BENCHPOLL_SMTP_PASSWORD: smtpEnvironment.BENCHPOLL_SMTP_PASSWORD };
    const status = inspectModerationEmailConfiguration(environment);
    assert.equal(status.deliveryConfigured, false);
    for (const name of Object.keys(smtpEnvironment).filter(name => name !== 'BENCHPOLL_SMTP_PASSWORD')) {
        assert(status.configurationError.includes(name));
    }
    assert.doesNotMatch(status.configurationError, /BENCHPOLL_SMTP_PASSWORD/);
    assert(!JSON.stringify(status).includes(environment.BENCHPOLL_SMTP_PASSWORD));
    assert.throws(() => createModerationEmailService({ pool: {}, environment }), {
        message: status.configurationError
    });
});

test('complete SMTP configuration is inspectable without creating a mail transport', t => {
    t.mock.method(nodemailer, 'createTransport', () => assert.fail('Inspection must not create a transport.'));
    const status = inspectModerationEmailConfiguration(smtpEnvironment);
    assert.equal(status.deliveryConfigured, true);
    assert.equal(status.smtpConfigured, true);
    assert.equal(status.configurationError, null);
    assert.equal(status.variables.BENCHPOLL_SMTP_SECURE, 'missing');
    for (const [name, value] of Object.entries(smtpEnvironment)) {
        assert.equal(status.variables[name], 'present');
        assert(!JSON.stringify(status).includes(value));
    }
});

test('SMTP preflight uses the same port and TLS validation as the mail service', () => {
    for (const [variable, value] of [
        ['BENCHPOLL_SMTP_PORT', '0'],
        ['BENCHPOLL_SMTP_PORT', '65536'],
        ['BENCHPOLL_SMTP_PORT', 'private-invalid-port'],
        ['BENCHPOLL_SMTP_SECURE', 'private-invalid-tls']
    ]) {
        const environment = { ...smtpEnvironment, [variable]: value };
        const status = inspectModerationEmailConfiguration(environment);
        assert.equal(status.deliveryConfigured, false);
        assert(status.configurationError.includes(variable));
        assert(!JSON.stringify(status).includes(value));
        assert.throws(() => createModerationEmailService({ pool: {}, environment }), {
            message: status.configurationError
        });
    }
    for (const secure of ['true', 'false', '']) {
        assert.equal(inspectModerationEmailConfiguration({
            ...smtpEnvironment, BENCHPOLL_SMTP_SECURE: secure
        }).deliveryConfigured, true);
    }
});

test('unconfigured email service never touches the queue or schedules delivery', async () => {
    for (let repetition = 0; repetition < 2; repetition++) {
        const service = createModerationEmailService({
            environment: {},
            pool: { execute() { assert.fail('Unconfigured email must not access the queue.'); } },
            setIntervalFunction() { assert.fail('Unconfigured email must not schedule delivery.'); }
        });
        assert.equal(service.deliveryConfigured, false);
        assert.deepEqual(await service.deliver(77), { sent: false, reason: 'smtp_not_configured' });
        await service.drain();
        service.kick(77);
        service.start();
    }
});

test('email configuration CLI is redacted and never starts the mail worker', t => {
    const directory = mkdtempSync(join(tmpdir(), 'benchpoll-email-cli-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const clearedSettings = Object.fromEntries([
        ...Object.keys(smtpEnvironment), ...optionalVariables
    ].map(name => [name, '']));
    for (const [environment, expectedExitCode, configured] of [
        [{}, 1, false],
        [smtpEnvironment, 0, true],
        [{ ...smtpEnvironment, BENCHPOLL_EMAIL_DELIVERY_ENABLED: 'false' }, 1, false],
        [{ ...smtpEnvironment, BENCHPOLL_EMAIL_DAILY_LIMIT: 'private-invalid-limit' }, 1, false],
        [{ BENCHPOLL_SMTP_PASSWORD: smtpEnvironment.BENCHPOLL_SMTP_PASSWORD }, 1, false]
    ]) {
        const result = spawnSync(process.execPath, [
            fileURLToPath(new URL('../scripts/check-moderation-email.mjs', import.meta.url))
        ], {
            cwd: directory,
            env: { ...process.env, ...clearedSettings, ...environment },
            encoding: 'utf8',
            timeout: 5000
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, expectedExitCode);
        assert.equal(result.stderr, '');
        const status = JSON.parse(result.stdout);
        assert.equal(status.deliveryConfigured, configured);
        assert.equal(status.smtpConnectionVerified, false);
        assert.equal(status.mailWorkerStarted, false);
        assert(!result.stdout.includes(smtpEnvironment.BENCHPOLL_SMTP_PASSWORD));
        assert(!result.stdout.includes(smtpEnvironment.BENCHPOLL_SMTP_USER));
        assert(!result.stdout.includes('private-invalid-limit'));
    }
});

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
        '9',
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
            if (/COUNT\(\*\) AS sentCount/.test(sql)) return [[{ sentCount: 0 }]];
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
                    attemptCount: 1,
                    createdAt: new Date()
                }]];
            }
            return [{ affectedRows: 1 }];
        }
    };
    const service = createModerationEmailService({
        pool,
        publicOrigin: 'https://benchpoll.com',
        environment: { BENCHPOLL_NOTIFICATION_FROM: 'BenchPoll <notifications@benchpoll.com>' },
        transport: { async sendMail(message) { sent.push(message); return { accepted: [message.to], rejected: [] }; } }
    });

    assert.deepEqual(await service.deliver(77), { sent: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'verified@example.com');
    assert.equal(Object.hasOwn(sent[0], 'replyTo'), false);
    assert.deepEqual(sent[0].headers, { 'Resend-Idempotency-Key': 'benchpoll-moderation-outbox/77' });
    assert(calls.some(call => /SET delivery_status = 'sent'/.test(call.sql)));
});

test('failed delivery records an error and schedules a retry', async () => {
    const calls = [];
    const pool = {
        async execute(sql, params) {
            calls.push({ sql, params });
            if (/COUNT\(\*\) AS sentCount/.test(sql)) return [[{ sentCount: 0 }]];
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
    assert.equal(retry.params[1], 5);
    assert.equal(retry.params[2], 'email_delivery_failed');
});

test('explicit pause disables every worker entry point without touching the queue or transport', async t => {
    t.mock.method(nodemailer, 'createTransport', () => assert.fail('Paused email must not create a transport.'));
    for (const transport of [undefined, null, { sendMail() { assert.fail('Paused email must not send.'); } }]) {
        const environment = { ...smtpEnvironment, BENCHPOLL_EMAIL_DELIVERY_ENABLED: ' false ' };
        const status = inspectModerationEmailConfiguration(environment);
        assert.equal(status.deliveryConfigured, false);
        assert.equal(status.smtpConfigured, true);
        assert.equal(status.configurationError, null);
        const service = createModerationEmailService({
            environment,
            transport,
            pool: { execute() { assert.fail('Paused email must not access the queue.'); } },
            setIntervalFunction() { assert.fail('Paused email must not schedule delivery.'); }
        });
        assert.equal(service.deliveryConfigured, false);
        assert.deepEqual(await service.deliver(77), { sent: false, reason: 'delivery_paused' });
        await service.drain();
        service.kick(77);
        service.start();
    }
});

test('paused delivery still enqueues notifications with a disabled UI status', async () => {
    const calls = [];
    const service = createModerationEmailService({
        environment: { BENCHPOLL_EMAIL_DELIVERY_ENABLED: 'false' },
        pool: { execute() { assert.fail('Enqueue must use the moderation transaction.'); } },
        transport: { sendMail() { assert.fail('Paused email must not send.'); } }
    });
    const result = await service.enqueue({ async execute(sql, params) {
        calls.push({ sql, params });
        return /SELECT email/.test(sql) ? [[{ email: 'verified@example.invalid' }]] : [{ insertId: 77 }];
    } }, { moderationLogID: 41, userID: '9007199254740993', decision: 'approved', contributionType: 'feedback' });
    assert.deepEqual(result, { ID: 77, recipientAvailable: true, deliveryConfigured: false });
    assert.deepEqual(calls[0].params, ['9007199254740993']);
    assert.equal(calls[1].params[5], 'pending');
});

test('worker start schedules one unreferenced recurring scan and returns immediately', async () => {
    let callback;
    let unrefs = 0;
    let scans = 0;
    const service = createModerationEmailService({
        environment: {},
        pool: { async execute(sql) {
            assert.match(sql, /SELECT COUNT/);
            scans++;
            return [[{ sentCount: 80 }]];
        } },
        transport: { sendMail() { assert.fail('Capped worker must not send.'); } },
        setIntervalFunction(fn, interval) {
            assert.equal(callback, undefined);
            assert.equal(interval, 60_000);
            callback = fn;
            return { unref() { unrefs++; } };
        }
    });
    assert.equal(service.start(), undefined);
    service.start();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(scans, 1);
    assert.equal(unrefs, 1);
    callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(scans, 2);
});

test('worker settings reject invalid values using only variable names in errors', () => {
    const invalidSettings = [
        ['BENCHPOLL_EMAIL_DELIVERY_ENABLED', 'private-invalid-enabled'],
        ...['BENCHPOLL_EMAIL_DAILY_LIMIT', 'BENCHPOLL_EMAIL_MIN_OUTBOX_ID'].flatMap(name =>
            ['0', '-1', '1.5', '1e2', '0x50', 'Infinity', '9007199254740992', 'private-invalid-integer']
                .map(value => [name, value]))
    ];
    for (const [name, value] of invalidSettings) {
        const environment = { ...smtpEnvironment, [name]: value };
        const status = inspectModerationEmailConfiguration(environment);
        assert.equal(status.deliveryConfigured, false);
        assert.equal(status.smtpConfigured, true);
        assert(status.configurationError.includes(name));
        for (const secret of [...Object.values(smtpEnvironment), value]) {
            assert(!JSON.stringify(status).includes(secret));
        }
        assert.throws(() => createModerationEmailService({ environment, pool: {} }), {
            message: status.configurationError
        });
        assert.throws(() => createModerationEmailService({ environment, pool: {}, transport: null }), {
            message: status.configurationError
        });
    }
    const status = inspectModerationEmailConfiguration({
        ...smtpEnvironment,
        BENCHPOLL_EMAIL_DELIVERY_ENABLED: 'true',
        BENCHPOLL_EMAIL_DAILY_LIMIT: '37',
        BENCHPOLL_EMAIL_MIN_OUTBOX_ID: '9827',
        BENCHPOLL_NOTIFICATION_REPLY_TO: 'private-replies@example.invalid'
    });
    assert.equal(status.deliveryConfigured, true);
    assert.equal(status.configurationError, null);
    assert(!/37|9827|private-replies/.test(JSON.stringify(status)));
    for (const name of optionalVariables.filter(name => name !== 'BENCHPOLL_SMTP_SECURE')) {
        assert.equal(status.variables[name], 'present');
    }
});

test('SMTP transports use bounded waits and mandatory TLS upgrades', t => {
    const options = [];
    t.mock.method(nodemailer, 'createTransport', configuration => {
        options.push(configuration);
        return { sendMail() { assert.fail('Configuration tests must not send.'); } };
    });
    for (const [port, secure, expectedSecure] of [
        ['587', '', false], ['465', '', true], ['587', 'true', true], ['465', 'false', false]
    ]) {
        const service = createModerationEmailService({
            pool: { execute() { assert.fail('Transport creation must not access the queue.'); } },
            environment: { ...smtpEnvironment, BENCHPOLL_SMTP_PORT: port, BENCHPOLL_SMTP_SECURE: secure }
        });
        assert.equal(service.deliveryConfigured, true);
        const configuration = options.at(-1);
        assert.equal(configuration.host, smtpEnvironment.BENCHPOLL_SMTP_HOST);
        assert.equal(configuration.port, Number(port));
        assert.equal(configuration.secure, expectedSecure);
        assert.equal(configuration.requireTLS, !expectedSecure);
        assert.notEqual(configuration.ignoreTLS, true);
        assert.deepEqual(configuration.auth, {
            user: smtpEnvironment.BENCHPOLL_SMTP_USER, pass: smtpEnvironment.BENCHPOLL_SMTP_PASSWORD
        });
        for (const name of ['connectionTimeout', 'greetingTimeout', 'socketTimeout']) {
            assert(configuration[name] > 0 && configuration[name] <= 60_000);
        }
    }
});

test('replyTo is included only when nonempty and idempotency keys identify each outbox row', async () => {
    for (const replyTo of [undefined, '', '   ', ' Replies <replies@example.invalid> ']) {
        const fixture = workerFixture({
            environment: { BENCHPOLL_NOTIFICATION_REPLY_TO: replyTo },
            notifications: [{ ID: 77 }, { ID: 78 }]
        });
        await fixture.service.drain();
        assert.equal(fixture.sent.length, 2);
        const messages = fixture.sent.map(row => row.message);
        for (const message of messages) {
            assert.equal(Object.hasOwn(message, 'replyTo'), Boolean(replyTo?.trim()));
            if (replyTo?.trim()) assert.equal(message.replyTo, replyTo.trim());
        }
        assert.deepEqual(messages.map(message => message.headers['Resend-Idempotency-Key']), [
            'benchpoll-moderation-outbox/77', 'benchpoll-moderation-outbox/78'
        ]);
    }
});

test('direct delivery, kicks and concurrent drains serialize SMTP calls and claims', async () => {
    const started = deferred();
    const release = deferred();
    let active = 0;
    let maxActive = 0;
    const fixture = workerFixture({
        notifications: [{ ID: 77 }, { ID: 78 }, { ID: 79 }],
        async sendMail(message) {
            maxActive = Math.max(maxActive, ++active);
            if (message.headers['Resend-Idempotency-Key'].endsWith('/77')) {
                started.resolve();
                await release.promise;
            }
            active--;
        }
    });
    const first = fixture.service.deliver(77);
    await started.promise;
    const second = fixture.service.deliver(78);
    assert.equal(fixture.service.kick(79), undefined);
    const scans = [fixture.service.drain(), fixture.service.drain()];
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.sent.length, 1);
    assert.equal(fixture.calls.filter(call => /SET delivery_status = 'sending'/.test(call.sql)).length, 1);
    release.resolve();
    await Promise.all([first, second, ...scans]);
    assert.equal(maxActive, 1);
    assert.equal(fixture.sent.length, 3);
    assert.deepEqual(fixture.waits, [1100, 1100]);
    assert.deepEqual(fixture.sent.map(row => row.at - fixture.sent[0].at), [0, 1100, 2200]);
    assert.deepEqual(fixture.rows.map(row => row.attemptCount), [1, 1, 1]);
});

test('SMTP pacing waits only for the remaining interval and rechecks early wakeups', async () => {
    const fixture = workerFixture({
        notifications: [{ ID: 77 }, { ID: 78 }, { ID: 79 }],
        async sleep(ms, clock) { clock.now += Math.min(ms, 400); }
    });
    await fixture.service.deliver(77);
    fixture.clock.now += 200;
    await fixture.service.deliver(78);
    assert.deepEqual(fixture.waits, [900, 500, 100]);
    assert.equal(fixture.sent[1].at - fixture.sent[0].at, 1100);
    fixture.clock.now += 1500;
    await fixture.service.deliver(79);
    assert.equal(fixture.waits.length, 3);
});

test('SMTP failures also reserve the minimum interval before another notification', async () => {
    let first = true;
    const fixture = workerFixture({
        notifications: [{ ID: 77 }, { ID: 78 }],
        async sendMail() {
            if (first) {
                first = false;
                throw new Error('temporary SMTP failure');
            }
        }
    });
    const results = await Promise.all([fixture.service.deliver(77), fixture.service.deliver(78)]);
    assert.deepEqual(results, [{ sent: false, reason: 'delivery_failed' }, { sent: true }]);
    assert.deepEqual(fixture.waits, [1100]);
});

test('a slow SMTP call completes before the next minimum interval starts', async () => {
    const fixture = workerFixture({
        notifications: [{ ID: 77 }, { ID: 78 }],
        async sendMail() { fixture.clock.now += 3000; }
    });
    await Promise.all([fixture.service.deliver(77), fixture.service.deliver(78)]);
    assert.deepEqual(fixture.waits, [1100]);
    assert.equal(fixture.sent[1].at - fixture.sent[0].at, 4100);
});

test('invalid outbox IDs never access the queue', async () => {
    const fixture = workerFixture();
    for (const ID of [0, -1, 1.5, NaN, Infinity, true, null, undefined, {}, '', '01', '1e2', '0x50', '9007199254740992']) {
        assert.deepEqual(await fixture.service.deliver(ID), { sent: false, reason: 'invalid_outbox_id' });
    }
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.sent.length, 0);
});

test('historical IDs are neither delivered nor changed by stale recovery or scans', async () => {
    const fixture = workerFixture({
        environment: { BENCHPOLL_EMAIL_MIN_OUTBOX_ID: '231' },
        notifications: [
            { ID: 1, deliveryStatus: 'sending', lockedAt: 1, attemptCount: 3 },
            { ID: 221 }, { ID: 230, deliveryStatus: 'failed', attemptCount: 7 },
            { ID: 231 }, { ID: 232, deliveryStatus: 'sending', lockedAt: 1, attemptCount: 1 }
        ]
    });
    const historical = structuredClone(fixture.rows.slice(0, 3));
    for (const ID of [1, '221', 230]) {
        assert.deepEqual(await fixture.service.deliver(ID), { sent: false, reason: 'below_min_outbox_id' });
    }
    assert.equal(fixture.calls.length, 0);
    fixture.service.kick(230);
    await fixture.service.drain();
    assert.deepEqual(fixture.rows.slice(0, 3), historical);
    assert.deepEqual(fixture.rows.slice(3).map(row => row.deliveryStatus), ['sent', 'sent']);
    assert.deepEqual(fixture.sent.map(row => row.message.headers['Resend-Idempotency-Key']), [
        'benchpoll-moderation-outbox/231', 'benchpoll-moderation-outbox/232'
    ]);
    const recovery = fixture.calls.find(call => /stale_delivery_claim_recovered/.test(call.sql));
    assert.deepEqual(recovery.params, [231]);
});

test('default rolling limit is 80 and reaching it does not claim or consume attempts', async () => {
    for (const count of [79, 80]) {
        const fixture = workerFixture({
            notifications: [
                { ID: 100, attemptCount: 7 },
                ...Array.from({ length: count }, (_, i) => ({
                    ID: i + 1, deliveryStatus: 'sent', sentAt: Date.UTC(2026, 9, 18, 11)
                }))
            ]
        });
        const result = await fixture.service.deliver(100);
        assert.deepEqual(result, count === 80 ? { sent: false, reason: 'daily_limit_reached' } : { sent: true });
        assert.equal(fixture.rows[0].attemptCount, count === 80 ? 7 : 8);
        if (count === 80) {
            await fixture.service.drain();
            assert(fixture.calls.every(call => /SELECT COUNT/.test(call.sql)));
            assert.equal(fixture.sent.length, 0);
        }
    }
});

test('rolling cap counts historical sent mail and resumes when sent_at ages out', async () => {
    const fixture = workerFixture({
        environment: { BENCHPOLL_EMAIL_DAILY_LIMIT: '1', BENCHPOLL_EMAIL_MIN_OUTBOX_ID: '77' },
        notifications: [{ ID: 1, deliveryStatus: 'sent', sentAt: Date.UTC(2026, 9, 17, 12) + 1 }, { ID: 77 }]
    });
    assert.deepEqual(await fixture.service.deliver(77), { sent: false, reason: 'daily_limit_reached' });
    assert.equal(fixture.rows[1].attemptCount, 0);
    fixture.clock.now += 1;
    assert.deepEqual(await fixture.service.deliver(77), { sent: true });
    assert.equal(fixture.rows[1].attemptCount, 1);
    assert.match(fixture.calls[0].sql, /delivery_status = 'sent'/);
    assert.match(fixture.calls[0].sql, /sent_at > DATE_SUB\(NOW\(3\), INTERVAL 24 HOUR\)/);
    assert.doesNotMatch(fixture.calls[0].sql, /ID >=/);
});

test('concurrent delivery cannot claim beyond the remaining daily allowance', async () => {
    const started = deferred();
    const release = deferred();
    const fixture = workerFixture({
        environment: { BENCHPOLL_EMAIL_DAILY_LIMIT: '1' },
        notifications: [{ ID: 77 }, { ID: 78 }, { ID: 79 }],
        async sendMail() { started.resolve(); await release.promise; }
    });
    const first = fixture.service.deliver(77);
    await started.promise;
    const second = fixture.service.deliver(78);
    fixture.service.kick(79);
    const scan = fixture.service.drain();
    release.resolve();
    assert.deepEqual(await first, { sent: true });
    assert.deepEqual(await second, { sent: false, reason: 'daily_limit_reached' });
    await scan;
    assert.equal(fixture.sent.length, 1);
    assert.deepEqual(fixture.rows.map(row => row.attemptCount), [1, 0, 0]);
    assert.equal(fixture.calls.filter(call => /SET delivery_status = 'sending'/.test(call.sql)).length, 1);
});

test('invalid daily count fails closed without consuming an attempt and does not poison serialization', async () => {
    const fixture = workerFixture();
    const execute = fixture.pool.execute;
    fixture.pool.execute = async (sql, params) => /COUNT\(\*\)/.test(sql)
        ? [[{ sentCount: 'invalid' }]] : execute(sql, params);
    await assert.rejects(fixture.service.deliver(77), /Could not read moderation email delivery count/);
    assert.equal(fixture.rows[0].attemptCount, 0);
    assert.equal(fixture.sent.length, 0);
    fixture.pool.execute = execute;
    assert.deepEqual(await fixture.service.deliver(77), { sent: true });
});

test('SMTP acceptance followed by a failed sent write only retries bookkeeping', async () => {
    const fixture = workerFixture();
    const execute = fixture.pool.execute;
    let failSentWrite = true;
    fixture.pool.execute = async (sql, params) => {
        if (/SET delivery_status = 'sent'/.test(sql) && failSentWrite) {
            failSentWrite = false;
            throw new Error('temporary sent status failure');
        }
        return execute(sql, params);
    };
    assert.deepEqual(await fixture.service.deliver(77), { sent: false, reason: 'delivery_record_pending' });
    assert.deepEqual(await fixture.service.deliver(77), { sent: true });
    assert.equal(fixture.sent.length, 1);
    assert.equal(fixture.rows[0].attemptCount, 1);
    assert.equal(fixture.rows[0].attemptCount, 1);
    assert.equal(fixture.rows[0].deliveryStatus, 'sent');
});

test('failed bookkeeping after SMTP acceptance cannot trigger an immediate replay', async () => {
    const fixture = workerFixture({ notifications: [{ ID: 77 }, { ID: 78 }] });
    const execute = fixture.pool.execute;
    fixture.pool.execute = async (sql, params) => {
        if (params?.at(-1) === 77 && /SET delivery_status = '(sent|failed)'/.test(sql)) {
            throw new Error('private database failure');
        }
        return execute(sql, params);
    };
    assert.deepEqual(await fixture.service.deliver(77), { sent: false, reason: 'delivery_record_pending' });
    await assert.rejects(fixture.service.deliver(77), /private database failure/);
    assert.deepEqual(await fixture.service.deliver(78), { sent: true });
    assert.equal(fixture.sent.length, 2);
    assert.equal(fixture.rows[0].attemptCount, 1);
});

test('zero affected sent-status writes are treated as uncertain delivery, not success', async () => {
    const fixture = workerFixture();
    const execute = fixture.pool.execute;
    fixture.pool.execute = async (sql, params) => /SET delivery_status = 'sent'/.test(sql)
        ? [{ affectedRows: 0 }] : /SELECT delivery_status/.test(sql) ? [[]] : execute(sql, params);
    assert.deepEqual(await fixture.service.deliver(77), { sent: false, reason: 'delivery_record_pending' });
    await assert.rejects(fixture.service.deliver(77), /sent status was not recorded/);
    assert.equal(fixture.sent.length, 1);
});

test('SMTP retry backoff still stops after eight attempts', async () => {
    const fixture = workerFixture({ async sendMail() { throw new Error('temporary SMTP failure'); } });
    for (let attempt = 1; attempt <= 8; attempt++) {
        assert.deepEqual(await fixture.service.deliver(77), { sent: false, reason: 'delivery_failed' });
        assert.equal(fixture.rows[0].attemptCount, attempt);
        const expectedDelay = 5 * (2 ** (attempt - 1)) * 60_000;
        assert.equal(fixture.rows[0].nextAttemptAt - fixture.clock.now, expectedDelay);
        fixture.clock.now += expectedDelay;
    }
    assert.deepEqual(await fixture.service.deliver(77), { sent: false, reason: 'not_claimed' });
    assert.equal(fixture.rows[0].attemptCount, 8);
    assert.equal(fixture.sent.length, 8);
});

test('sender and reply mailboxes reject groups, multiple recipients and header injection', () => {
    for (const variable of ['BENCHPOLL_NOTIFICATION_FROM', 'BENCHPOLL_NOTIFICATION_REPLY_TO']) {
        for (const value of ['a@example.invalid, b@example.invalid', 'Group: a@example.invalid;',
            'a@example.invalid\r\nBcc: hidden@example.invalid', 'not-an-address']) {
            const status = inspectModerationEmailConfiguration({ ...smtpEnvironment, [variable]: value });
            assert.equal(status.deliveryConfigured, false);
            assert.match(status.configurationError, new RegExp(variable));
            assert(!status.configurationError.includes(value));
        }
    }
});

test('enqueue accepts a single verified mailbox, not display names or recipient lists', async () => {
    for (const email of ['one@example.invalid', 'One <one@example.invalid>',
        'one@example.invalid, two@example.invalid', 'one@example.invalid\nBcc: two@example.invalid', '', null]) {
        const fixture = workerFixture();
        const calls = [];
        const result = await fixture.service.enqueue({ async execute(sql, params) {
            calls.push({ sql, params });
            if (/SELECT email/.test(sql)) {
                assert.match(sql, /email_verified_at IS NOT NULL/);
                return [[{ email }]];
            }
            return [{ insertId: 77 }];
        } }, { moderationLogID: 41, userID: 9, decision: 'approved', contributionType: 'feedback' });
        const valid = email === 'one@example.invalid';
        assert.equal(result.recipientAvailable, valid);
        assert.equal(calls[1].params[2], valid ? email : null);
        assert.equal(calls[1].params[5], valid ? 'pending' : 'failed');
    }
});

test('legacy recipient lists cannot be expanded into more than one outgoing notification', async () => {
    const fixture = workerFixture({ notifications: [{ ID: 77, recipientEmail: 'one@example.invalid, two@example.invalid' }] });
    await fixture.service.deliver(77);
    assert.equal(fixture.sent.length, 0);
    assert.equal(fixture.rows[0].attemptCount, 1);
    assert.equal(fixture.rows[0].lastError, 'smtp_permanent_rejection');
});

test('unconfirmed or mismatched SMTP acceptance is never recorded as sent', async () => {
    for (const result of [null, {}, { accepted: [] }, { accepted: ['someone-else@example.invalid'] },
        { accepted: ['verified@example.invalid'], rejected: ['another@example.invalid'] }]) {
        const fixture = workerFixture({ async sendMail() { return result; } });
        assert.deepEqual(await fixture.service.deliver(77), { sent: false, reason: 'delivery_failed' });
        assert.equal(fixture.rows[0].deliveryStatus, 'failed');
        assert.equal(fixture.rows[0].sentAt, null);
    }
});

test('permanent SMTP rejections stop immediately without logging raw provider details', async () => {
    const fixture = workerFixture({ async sendMail() {
        throw Object.assign(new Error('550 private-recipient@example.invalid private-token'), { responseCode: 550 });
    } });
    await fixture.service.deliver(77);
    assert.equal(fixture.rows[0].attemptCount, 1);
    assert.equal(fixture.rows[0].nextAttemptAt, null);
    await fixture.service.drain();
    assert.equal(fixture.sent.length, 1);
    assert.doesNotMatch(JSON.stringify(fixture.errors), /private-recipient|private-token/);
    assert.equal(fixture.rows[0].lastError, 'smtp_permanent_rejection');
});

test('unknown delivery retries stop before the provider idempotency window expires, including after restart', async () => {
    const fixture = workerFixture({ notifications: [
        { ID: 76, attemptCount: 1, deliveryStatus: 'sending', lockedAt: 1,
            createdAt: new Date(Date.UTC(2026, 9, 17, 13)) },
        { ID: 77, attemptCount: 1, deliveryStatus: 'failed', createdAt: new Date(Date.UTC(2026, 9, 17, 12)) },
        { ID: 78, createdAt: new Date(Date.UTC(2026, 9, 17, 12)) }
    ] });
    assert.deepEqual(await fixture.service.deliver(77), { sent: false, reason: 'not_claimed' });
    await fixture.service.drain();
    assert.deepEqual(fixture.rows.slice(0, 2).map(row => [row.attemptCount, row.lastError]), [
        [1, 'delivery_uncertain_retry_window_elapsed'], [1, 'delivery_uncertain_retry_window_elapsed']
    ]);
    assert.equal(fixture.sent.length, 1);
    assert.equal(fixture.rows[2].deliveryStatus, 'sent');
});

test('accepted messages retain their daily slot until database bookkeeping succeeds', async () => {
    const fixture = workerFixture({ environment: { BENCHPOLL_EMAIL_DAILY_LIMIT: '1' },
        notifications: [{ ID: 77 }, { ID: 78 }] });
    const execute = fixture.pool.execute;
    fixture.pool.execute = async (sql, params) => {
        if (/SET delivery_status = 'sent'/.test(sql)) throw new Error('database unavailable');
        return execute(sql, params);
    };
    assert.deepEqual(await fixture.service.deliver(77), { sent: false, reason: 'delivery_record_pending' });
    assert.deepEqual(await fixture.service.deliver(78), { sent: false, reason: 'daily_limit_reached' });
    fixture.pool.execute = execute;
    await fixture.service.drain();
    assert.equal(fixture.rows[0].deliveryStatus, 'sent');
    assert.equal(fixture.rows[1].attemptCount, 0);
    assert.equal(fixture.sent.length, 1);
});

test('real Nodemailer SMTP responses keep retry identity and MIME date stable', async t => {
    const messages = [];
    const sockets = new Set();
    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.setEncoding('utf8');
        socket.write('220 localhost test SMTP\r\n');
        let pending = '';
        let data = null;
        socket.on('data', chunk => {
            pending += chunk;
            let end;
            while ((end = pending.indexOf('\r\n')) !== -1) {
                const line = pending.slice(0, end);
                pending = pending.slice(end + 2);
                if (data !== null) {
                    if (line !== '.') { data.push(line); continue; }
                    messages.push(data.join('\r\n'));
                    data = null;
                    socket.write(messages.length === 1 ? '451 temporary test failure\r\n' : '250 test accepted\r\n');
                } else if (/^(EHLO|HELO|MAIL FROM:|RCPT TO:|RSET|NOOP)/i.test(line)) {
                    socket.write('250 localhost\r\n');
                } else if (line === 'DATA') {
                    data = [];
                    socket.write('354 end with dot\r\n');
                } else if (line === 'QUIT') socket.end('221 goodbye\r\n');
                else socket.write('500 unsupported test command\r\n');
            }
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
    const transport = nodemailer.createTransport({ host: '127.0.0.1', port: server.address().port,
        secure: false, ignoreTLS: true, connectionTimeout: 1000, greetingTimeout: 1000, socketTimeout: 1000 });
    const fixture = workerFixture({ async sendMail(message) { return transport.sendMail(message); } });
    assert.deepEqual(await fixture.service.deliver(77), { sent: false, reason: 'delivery_failed' });
    fixture.clock.now += 5 * 60_000;
    assert.deepEqual(await fixture.service.deliver(77), { sent: true });
    assert.equal(messages.length, 2);
    for (const header of ['Message-ID', 'Date', 'Resend-Idempotency-Key', 'To', 'Subject']) {
        const expression = new RegExp(`^${header}: (.+)$`, 'mi');
        assert.equal(messages[0].match(expression)?.[1], messages[1].match(expression)?.[1], header);
        assert(messages[0].match(expression), header);
    }
    assert.equal(messages[0], messages[1], 'Retry MIME content must not change with time or random boundaries.');
    assert.equal(fixture.rows[0].deliveryStatus, 'sent');
});
