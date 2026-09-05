import nodemailer from 'nodemailer';

const DELIVERY_INTERVAL_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 8;
const VALID_DECISIONS = new Set(['approved', 'rejected']);

function environmentText(environment, name) {
    return String(environment[name] ?? '').trim();
}

function smtpConfiguration(environment) {
    const values = {
        host: environmentText(environment, 'BENCHPOLL_SMTP_HOST'),
        port: environmentText(environment, 'BENCHPOLL_SMTP_PORT'),
        user: environmentText(environment, 'BENCHPOLL_SMTP_USER'),
        password: environmentText(environment, 'BENCHPOLL_SMTP_PASSWORD'),
        from: environmentText(environment, 'BENCHPOLL_NOTIFICATION_FROM')
    };
    const configuredCount = Object.values(values).filter(Boolean).length;
    if (configuredCount === 0) {
        return null;
    }
    if (configuredCount !== Object.keys(values).length) {
        throw new Error('All BENCHPOLL_SMTP_* settings and BENCHPOLL_NOTIFICATION_FROM must be configured together.');
    }
    const port = Number(values.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new Error('BENCHPOLL_SMTP_PORT must be a valid TCP port.');
    }
    const secureSetting = environmentText(environment, 'BENCHPOLL_SMTP_SECURE');
    if (secureSetting && secureSetting !== 'true' && secureSetting !== 'false') {
        throw new Error('BENCHPOLL_SMTP_SECURE must be true or false.');
    }
    return {
        host: values.host,
        port,
        secure: secureSetting ? secureSetting === 'true' : port === 465,
        auth: { user: values.user, pass: values.password },
        from: values.from
    };
}

function contributionLabel(type) {
    return ({
        feedback: 'feedback',
        new_category: 'category or context contribution',
        new_benchmark: 'benchmark contribution',
        new_model: 'model contribution',
        benchmark_result: 'score contribution',
        entity_change: 'change request',
        report_issue: 'issue report'
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
    const safeOrigin = new URL(publicOrigin).origin;
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
    setIntervalFunction = setInterval
}) {
    const smtp = transport === undefined ? smtpConfiguration(environment) : null;
    const mailTransport = transport === undefined
        ? smtp && nodemailer.createTransport({
            host: smtp.host,
            port: smtp.port,
            secure: smtp.secure,
            auth: smtp.auth
        })
        : transport;
    const from = transport === undefined
        ? smtp?.from ?? ''
        : environmentText(environment, 'BENCHPOLL_NOTIFICATION_FROM') || 'BenchPoll <notifications@benchpoll.com>';
    let interval = null;

    async function enqueue(connection, { moderationLogID, userID, decision, contributionType }) {
        if (!VALID_DECISIONS.has(decision)) {
            throw new Error('Invalid moderation notification decision.');
        }
        const [users] = await connection.execute(
            'SELECT email FROM users WHERE ID = ? LIMIT 1',
            [userID]
        );
        const recipientEmail = typeof users[0]?.email === 'string' && users[0].email.trim()
            ? users[0].email.trim()
            : null;
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
            recipientEmail ? new Date() : null,
            lastError
        ]);
        return {
            ID: Number(result.insertId),
            recipientAvailable: recipientEmail !== null,
            deliveryConfigured: mailTransport !== null
        };
    }

    async function deliver(ID) {
        if (!mailTransport) {
            return { sent: false, reason: 'smtp_not_configured' };
        }
        const [claim] = await pool.execute(`
            UPDATE moderation_email_outbox
            SET delivery_status = 'sending', locked_at = NOW(3), attempt_count = attempt_count + 1,
                last_error = NULL
            WHERE ID = ?
              AND recipient_email IS NOT NULL
              AND delivery_status IN ('pending', 'failed')
              AND attempt_count < ?
              AND (next_attempt_at IS NULL OR next_attempt_at <= NOW(3))`, [ID, MAX_DELIVERY_ATTEMPTS]);
        if (Number(claim.affectedRows) !== 1) {
            return { sent: false, reason: 'not_claimed' };
        }
        const [rows] = await pool.execute(`
            SELECT ID, moderation_log_ID AS moderationLogID, recipient_email AS recipientEmail,
                   decision, contribution_type AS contributionType, attempt_count AS attemptCount
            FROM moderation_email_outbox
            WHERE ID = ? AND delivery_status = 'sending'`, [ID]);
        if (rows.length !== 1) {
            throw new Error('Claimed moderation email disappeared.');
        }
        const notification = rows[0];
        const message = buildModerationDecisionEmail({
            moderationLogID: Number(notification.moderationLogID),
            decision: notification.decision,
            contributionType: notification.contributionType,
            publicOrigin
        });
        try {
            await mailTransport.sendMail({
                from,
                to: notification.recipientEmail,
                ...message
            });
            await pool.execute(`
                UPDATE moderation_email_outbox
                SET delivery_status = 'sent', sent_at = NOW(3), locked_at = NULL,
                    next_attempt_at = NULL, last_error = NULL
                WHERE ID = ? AND delivery_status = 'sending'`, [ID]);
            return { sent: true };
        } catch (error) {
            const attemptCount = Number(notification.attemptCount);
            const retryDelayMinutes = Math.min(24 * 60, 5 * (2 ** Math.max(0, attemptCount - 1)));
            const messageText = String(error?.message || 'email_delivery_failed').slice(0, 1000);
            await pool.execute(`
                UPDATE moderation_email_outbox
                SET delivery_status = 'failed', locked_at = NULL,
                    next_attempt_at = DATE_ADD(NOW(3), INTERVAL ? MINUTE), last_error = ?
                WHERE ID = ? AND delivery_status = 'sending'`, [retryDelayMinutes, messageText, ID]);
            logger.error('Moderation email delivery failed.', { notificationID: ID, attemptCount });
            return { sent: false, reason: 'delivery_failed' };
        }
    }

    async function drain() {
        if (!mailTransport) {
            return;
        }
        await pool.execute(`
            UPDATE moderation_email_outbox
            SET delivery_status = 'failed', locked_at = NULL, next_attempt_at = NOW(3),
                last_error = 'stale_delivery_claim_recovered'
            WHERE delivery_status = 'sending'
              AND locked_at < DATE_SUB(NOW(3), INTERVAL 10 MINUTE)`);
        const [rows] = await pool.execute(`
            SELECT ID
            FROM moderation_email_outbox
            WHERE recipient_email IS NOT NULL
              AND delivery_status IN ('pending', 'failed')
              AND attempt_count < ?
              AND (next_attempt_at IS NULL OR next_attempt_at <= NOW(3))
            ORDER BY ID
            LIMIT 20`, [MAX_DELIVERY_ATTEMPTS]);
        for (const row of rows) {
            await deliver(Number(row.ID));
        }
    }

    function kick(ID) {
        if (!mailTransport) {
            return;
        }
        void deliver(ID).catch(error => {
            logger.error('Moderation email worker failed.', {
                notificationID: ID,
                error: String(error?.message || error)
            });
        });
    }

    function start() {
        if (!mailTransport || interval) {
            return;
        }
        void drain().catch(error => {
            logger.error('Moderation email outbox scan failed.', { error: String(error?.message || error) });
        });
        interval = setIntervalFunction(() => {
            void drain().catch(error => {
                logger.error('Moderation email outbox scan failed.', { error: String(error?.message || error) });
            });
        }, DELIVERY_INTERVAL_MS);
        interval?.unref?.();
    }

    return {
        deliveryConfigured: mailTransport !== null,
        enqueue,
        deliver,
        drain,
        kick,
        start
    };
}
