import nodemailer from 'nodemailer';
import addressParser from 'nodemailer/lib/addressparser/index.js';
import { setTimeout as sleepFor } from 'node:timers/promises';
import { canonicalAccountID } from './public/js/shared/account-identity.js';

const DELIVERY_INTERVAL_MS = 60_000;
const SMTP_SEND_INTERVAL_MS = 1100;
const MAX_DELIVERY_ATTEMPTS = 8;
const AUTOMATIC_RETRY_SQL = `(last_error IS NULL OR last_error NOT IN
    ('smtp_permanent_rejection', 'delivery_uncertain_retry_window_elapsed'))`;
const VALID_DECISIONS = new Set(['approved', 'rejected']);
const SMTP_VARIABLES = {
    host: 'BENCHPOLL_SMTP_HOST',
    port: 'BENCHPOLL_SMTP_PORT',
    user: 'BENCHPOLL_SMTP_USER',
    password: 'BENCHPOLL_SMTP_PASSWORD',
    from: 'BENCHPOLL_NOTIFICATION_FROM'
};
const DELIVERY_VARIABLES = [
    'BENCHPOLL_EMAIL_DELIVERY_ENABLED',
    'BENCHPOLL_EMAIL_DAILY_LIMIT',
    'BENCHPOLL_EMAIL_MIN_OUTBOX_ID',
    'BENCHPOLL_NOTIFICATION_REPLY_TO'
];

function environmentText(environment, name) {
    return String(environment[name] ?? '').trim();
}

function singleMailbox(value, { bare = false } = {}) {
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return null;
    const text = value.trim();
    const addresses = addressParser(text);
    if (addresses.length !== 1 || addresses[0].group) return null;
    const address = addresses[0].address;
    if (!address || address.length > 320 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(address)) return null;
    if (bare && text !== address) return null;
    return address;
}

export function moderationRecipientEmail(value) {
    return singleMailbox(value, { bare: true });
}

function positiveIntegerSetting(environment, name, fallback) {
    const text = environmentText(environment, name);
    if (!text) return fallback;
    const value = Number(text);
    if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(value)) {
        throw new Error(`${name} must be a positive safe integer.`);
    }
    return value;
}

function deliveryConfiguration(environment) {
    const enabled = environmentText(environment, 'BENCHPOLL_EMAIL_DELIVERY_ENABLED');
    if (enabled && enabled !== 'true' && enabled !== 'false') {
        throw new Error('BENCHPOLL_EMAIL_DELIVERY_ENABLED must be true or false.');
    }
    const replyTo = environmentText(environment, 'BENCHPOLL_NOTIFICATION_REPLY_TO');
    if (replyTo && !singleMailbox(replyTo)) throw new Error('BENCHPOLL_NOTIFICATION_REPLY_TO must contain one mailbox.');
    return {
        enabled: enabled !== 'false',
        dailyLimit: positiveIntegerSetting(environment, 'BENCHPOLL_EMAIL_DAILY_LIMIT', 80),
        minOutboxID: positiveIntegerSetting(environment, 'BENCHPOLL_EMAIL_MIN_OUTBOX_ID', 1)
    };
}

function smtpConfiguration(environment) {
    const values = Object.fromEntries(Object.entries(SMTP_VARIABLES).map(([key, name]) => [
        key, environmentText(environment, name)
    ]));
    const missingVariables = Object.entries(SMTP_VARIABLES)
        .filter(([key]) => !values[key]).map(([, name]) => name);
    if (missingVariables.length === Object.keys(values).length) {
        return null;
    }
    if (missingVariables.length > 0) {
        throw new Error(`Missing moderation email settings: ${missingVariables.join(', ')}.`);
    }
    const port = Number(values.port);
    if (!/^[1-9]\d*$/.test(values.port) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new Error('BENCHPOLL_SMTP_PORT must be a valid TCP port.');
    }
    const secureSetting = environmentText(environment, 'BENCHPOLL_SMTP_SECURE');
    if (secureSetting && secureSetting !== 'true' && secureSetting !== 'false') {
        throw new Error('BENCHPOLL_SMTP_SECURE must be true or false.');
    }
    if (!singleMailbox(values.from)) throw new Error('BENCHPOLL_NOTIFICATION_FROM must contain one mailbox.');
    return {
        host: values.host,
        port,
        secure: secureSetting ? secureSetting === 'true' : port === 465,
        auth: { user: values.user, pass: values.password },
        from: values.from
    };
}

export function inspectModerationEmailConfiguration(environment = process.env) {
    const variables = Object.fromEntries([
        ...Object.values(SMTP_VARIABLES), 'BENCHPOLL_SMTP_SECURE', ...DELIVERY_VARIABLES
    ].map(name => [name, environmentText(environment, name) ? 'present' : 'missing']));
    let smtpConfigured = false;
    try {
        smtpConfigured = smtpConfiguration(environment) !== null;
        const delivery = deliveryConfiguration(environment);
        return {
            deliveryConfigured: smtpConfigured && delivery.enabled,
            smtpConfigured,
            variables,
            configurationError: null
        };
    } catch (error) {
        return { deliveryConfigured: false, smtpConfigured, variables, configurationError: error.message };
    }
}

function contributionLabel(type) {
    return ({
        feedback: 'feedback',
        new_category: 'category or context contribution',
        new_topic: 'public topic',
        new_benchmark: 'benchmark contribution',
        new_model: 'model contribution',
        benchmark_result: 'score contribution',
        entity_change: 'change request',
        report_issue: 'issue report',
        discussion_report: 'discussion report'
    })[type] ?? 'contribution';
}

function escapeHTML(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

export function buildModerationDecisionEmail({ moderationLogID, decision, contributionType, publicOrigin }) {
    if (!Number.isSafeInteger(moderationLogID) || moderationLogID < 1) throw new Error('Invalid moderation log ID.');
    if (!VALID_DECISIONS.has(decision)) {
        throw new Error('Invalid moderation email decision.');
    }
    const approved = decision === 'approved';
    const label = contributionLabel(contributionType);
    const statusText = approved ? 'approved' : 'not approved';
    const subject = `Your BenchPoll ${label} was ${statusText}`;
    const detail = approved
        ? 'The reviewed contribution has been accepted and applied where applicable.'
        : 'The reviewed contribution was not accepted. You can submit a corrected contribution at any time.';
    const origin = new URL(publicOrigin);
    if (!['https:', 'http:'].includes(origin.protocol)) throw new Error('Invalid notification public origin.');
    const safeOrigin = origin.origin;
    const text = [
        'Hello,',
        '',
        `Your BenchPoll ${label} (#${moderationLogID}) was ${statusText}.`,
        detail,
        '',
        `Open BenchPoll: ${safeOrigin}`,
        '',
        'This is an automated review notification.'
    ].join('\n');
    const html = `<p>Hello,</p>
        <p>Your BenchPoll ${escapeHTML(label)} <strong>#${moderationLogID}</strong> was <strong>${escapeHTML(statusText)}</strong>.</p>
        <p>${escapeHTML(detail)}</p>
        <p><a href="${escapeHTML(safeOrigin)}">Open BenchPoll</a></p>
        <p>This is an automated review notification.</p>`;
    return { subject, text, html };
}

export function createModerationEmailService({
    pool,
    publicOrigin,
    environment = process.env,
    logger = console,
    transport = undefined,
    setIntervalFunction = setInterval,
    clock = Date.now,
    sleep = sleepFor
}) {
    const smtp = transport === undefined ? smtpConfiguration(environment) : null;
    const delivery = deliveryConfiguration(environment);
    const mailTransport = transport === undefined
        ? delivery.enabled && smtp ? nodemailer.createTransport({
            host: smtp.host,
            port: smtp.port,
            secure: smtp.secure,
            requireTLS: !smtp.secure,
            connectionTimeout: 10_000,
            greetingTimeout: 10_000,
            socketTimeout: 30_000,
            auth: smtp.auth
        }) : null
        : transport;
    const deliveryConfigured = delivery.enabled && Boolean(mailTransport);
    const from = transport === undefined
        ? smtp?.from ?? ''
        : environmentText(environment, 'BENCHPOLL_NOTIFICATION_FROM') || 'BenchPoll <notifications@benchpoll.com>';
    const replyTo = environmentText(environment, 'BENCHPOLL_NOTIFICATION_REPLY_TO');
    let interval = null;
    let deliveryChain = Promise.resolve();
    let lastSendAt = null;
    const acceptedNotifications = new Map();
    let scan = null;

    async function enqueue(connection, { moderationLogID, userID, decision, contributionType }) {
        if (!VALID_DECISIONS.has(decision)) {
            throw new Error('Invalid moderation notification decision.');
        }
        userID = canonicalAccountID(userID);
        if (!userID) throw new Error('A valid user ID is required for moderation notification.');
        const [users] = await connection.execute(
            'SELECT email FROM users WHERE ID = ? AND email_verified_at IS NOT NULL LIMIT 1 FOR SHARE',
            [userID]
        );
        const recipientEmail = moderationRecipientEmail(users[0]?.email);
        const deliveryStatus = recipientEmail ? 'pending' : 'failed';
        const lastError = recipientEmail ? null : 'verified_email_unavailable';
        const [result] = await connection.execute(`
            INSERT INTO moderation_email_outbox
                (moderation_log_ID, user_ID, recipient_email, decision, contribution_type,
                 delivery_status, next_attempt_at, last_error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
            moderationLogID,
            userID,
            recipientEmail,
            decision,
            contributionType,
            deliveryStatus,
            recipientEmail ? new Date(clock()) : null,
            lastError
        ]);
        return {
            ID: Number(result.insertId),
            recipientAvailable: recipientEmail !== null,
            deliveryConfigured
        };
    }

    async function dailyLimitReached() {
        const [rows] = await pool.execute(`
            SELECT COUNT(*) AS sentCount
            FROM moderation_email_outbox
            WHERE delivery_status = 'sent'
              AND sent_at > DATE_SUB(NOW(3), INTERVAL 24 HOUR)`);
        const sentCount = Number(rows[0]?.sentCount);
        if (!Number.isSafeInteger(sentCount) || sentCount < 0) {
            throw new Error('Could not read moderation email delivery count.');
        }
        return sentCount + acceptedNotifications.size >= delivery.dailyLimit;
    }

    async function recordAcceptance(ID) {
        const acceptedAt = acceptedNotifications.get(ID);
        const [marked] = await pool.execute(`
            UPDATE moderation_email_outbox
            SET delivery_status = 'sent', sent_at = ?, locked_at = NULL,
                next_attempt_at = NULL, last_error = NULL
            WHERE ID = ? AND delivery_status IN ('sending', 'failed')`, [new Date(acceptedAt), ID]);
        if (Number(marked.affectedRows) !== 1) {
            const [rows] = await pool.execute('SELECT delivery_status FROM moderation_email_outbox WHERE ID = ?', [ID]);
            if (rows[0]?.delivery_status !== 'sent') throw new Error('Moderation email sent status was not recorded.');
        }
        acceptedNotifications.delete(ID);
        return { sent: true };
    }

    async function deliverNext(ID) {
        if (!delivery.enabled) {
            return { sent: false, reason: 'delivery_paused' };
        }
        if (!deliveryConfigured) {
            return { sent: false, reason: 'smtp_not_configured' };
        }
        if (!['number', 'string'].includes(typeof ID) || !/^[1-9]\d*$/.test(String(ID))
            || !Number.isSafeInteger(Number(ID))) {
            return { sent: false, reason: 'invalid_outbox_id' };
        }
        ID = Number(ID);
        if (ID < delivery.minOutboxID) {
            return { sent: false, reason: 'below_min_outbox_id' };
        }
        if (acceptedNotifications.has(ID)) {
            return recordAcceptance(ID);
        }
        if (await dailyLimitReached()) {
            return { sent: false, reason: 'daily_limit_reached' };
        }
        const [claim] = await pool.execute(`
            UPDATE moderation_email_outbox
            SET delivery_status = 'sending', locked_at = NOW(3), attempt_count = attempt_count + 1,
                last_error = NULL
            WHERE ID = ?
              AND ID >= ?
              AND recipient_email IS NOT NULL
              AND delivery_status IN ('pending', 'failed')
              AND ${AUTOMATIC_RETRY_SQL}
              AND attempt_count < ?
              AND (attempt_count = 0 OR created_at > DATE_SUB(NOW(3), INTERVAL 23 HOUR))
              AND (next_attempt_at IS NULL OR next_attempt_at <= NOW(3))`, [ID, delivery.minOutboxID, MAX_DELIVERY_ATTEMPTS]);
        if (Number(claim.affectedRows) !== 1) {
            return { sent: false, reason: 'not_claimed' };
        }
        const [rows] = await pool.execute(`
            SELECT ID, moderation_log_ID AS moderationLogID, recipient_email AS recipientEmail,
                   decision, contribution_type AS contributionType, attempt_count AS attemptCount,
                   created_at AS createdAt
            FROM moderation_email_outbox
            WHERE ID = ? AND delivery_status = 'sending'`, [ID]);
        if (rows.length !== 1) {
            throw new Error('Claimed moderation email disappeared.');
        }
        const notification = rows[0];
        const attemptCount = Number(notification.attemptCount);
        const retryDelayMinutes = Math.min(24 * 60, 5 * (2 ** Math.max(0, attemptCount - 1)));
        try {
            if (!singleMailbox(notification.recipientEmail, { bare: true })) {
                throw Object.assign(new Error('Invalid notification recipient.'), { responseCode: 550 });
            }
            const message = buildModerationDecisionEmail({
                moderationLogID: Number(notification.moderationLogID),
                decision: notification.decision,
                contributionType: notification.contributionType,
                publicOrigin
            });
            while (lastSendAt !== null && clock() - lastSendAt < SMTP_SEND_INTERVAL_MS) {
                await sleep(SMTP_SEND_INTERVAL_MS - (clock() - lastSendAt));
            }
            try {
                const result = await mailTransport.sendMail({
                    from,
                    to: notification.recipientEmail,
                    ...(replyTo ? { replyTo } : {}),
                    headers: { 'Resend-Idempotency-Key': `benchpoll-moderation-outbox/${ID}` },
                    messageId: `<benchpoll-moderation-outbox-${ID}@${new URL(publicOrigin).hostname}>`,
                    baseBoundary: `benchpoll-moderation-outbox-${ID}`,
                    date: new Date(notification.createdAt),
                    ...message
                });
                if (!Array.isArray(result?.accepted) || result.accepted.length !== 1
                    || result.accepted[0] !== notification.recipientEmail || result.rejected?.length) {
                    throw new Error('SMTP acceptance was not confirmed for the notification recipient.');
                }
                acceptedNotifications.set(ID, clock());
            } finally {
                lastSendAt = clock();
            }
            return await recordAcceptance(ID);
        } catch (error) {
            // An accepted message only needs bookkeeping; sending it again is unnecessary.
            if (acceptedNotifications.has(ID)) {
                logger.error('Moderation email acceptance could not be recorded.', { notificationID: ID, attemptCount });
                return { sent: false, reason: 'delivery_record_pending' };
            }
            const responseCode = Number(error?.responseCode);
            const permanent = responseCode >= 500 && responseCode < 600;
            const messageText = permanent ? 'smtp_permanent_rejection' : 'email_delivery_failed';
            await pool.execute(`
                UPDATE moderation_email_outbox
                SET delivery_status = 'failed', locked_at = NULL,
                    next_attempt_at = IF(?, NULL, DATE_ADD(NOW(3), INTERVAL ? MINUTE)), last_error = ?
                WHERE ID = ? AND delivery_status = 'sending'`, [permanent, retryDelayMinutes, messageText, ID]);
            logger.error('Moderation email delivery failed.', { notificationID: ID, attemptCount });
            return { sent: false, reason: 'delivery_failed' };
        }
    }

    function deliver(ID) {
        const result = deliveryChain.then(() => deliverNext(ID));
        deliveryChain = result.catch(() => {});
        return result;
    }

    async function scanQueue() {
        if (!deliveryConfigured) {
            return;
        }
        for (const ID of acceptedNotifications.keys()) await deliver(ID);
        if (await dailyLimitReached()) return;
        // Queue creation precedes first send, making this a conservative bound on Resend's 24h key TTL.
        await pool.execute(`
            UPDATE moderation_email_outbox
            SET delivery_status = 'failed', locked_at = NULL, next_attempt_at = NULL,
                last_error = 'delivery_uncertain_retry_window_elapsed'
            WHERE ID >= ? AND attempt_count > 0 AND attempt_count < ?
              AND ${AUTOMATIC_RETRY_SQL}
              AND delivery_status IN ('pending', 'failed', 'sending')
              AND created_at <= DATE_SUB(NOW(3), INTERVAL 23 HOUR)`,
        [delivery.minOutboxID, MAX_DELIVERY_ATTEMPTS]);
        await pool.execute(`
            UPDATE moderation_email_outbox
            SET delivery_status = 'failed', locked_at = NULL, next_attempt_at = NOW(3),
                last_error = 'stale_delivery_claim_recovered'
            WHERE ID >= ? AND delivery_status = 'sending'
              AND locked_at < DATE_SUB(NOW(3), INTERVAL 10 MINUTE)`, [delivery.minOutboxID]);
        const [rows] = await pool.execute(`
            SELECT ID
            FROM moderation_email_outbox
            WHERE ID >= ? AND recipient_email IS NOT NULL
              AND delivery_status IN ('pending', 'failed')
              AND ${AUTOMATIC_RETRY_SQL}
              AND attempt_count < ?
              AND (next_attempt_at IS NULL OR next_attempt_at <= NOW(3))
            ORDER BY ID
            LIMIT 20`, [delivery.minOutboxID, MAX_DELIVERY_ATTEMPTS]);
        for (const row of rows) {
            const result = await deliver(row.ID);
            if (result.reason === 'daily_limit_reached') break;
        }
    }

    function drain() {
        if (!scan) scan = scanQueue().finally(() => { scan = null; });
        return scan;
    }

    function kick(ID) {
        if (!deliveryConfigured) {
            return;
        }
        void deliver(ID).catch(() => {
            logger.error('Moderation email worker failed.', {
                notificationID: ID
            });
        });
    }

    function start() {
        if (!deliveryConfigured || interval) {
            return;
        }
        void drain().catch(() => {
            logger.error('Moderation email outbox scan failed.');
        });
        interval = setIntervalFunction(() => {
            void drain().catch(() => {
                logger.error('Moderation email outbox scan failed.');
            });
        }, DELIVERY_INTERVAL_MS);
        interval?.unref?.();
    }

    return {
        deliveryConfigured,
        enqueue,
        deliver,
        drain,
        kick,
        start
    };
}
