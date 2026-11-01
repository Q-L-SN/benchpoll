import crypto from 'node:crypto';
import { canonicalAccountID } from './public/js/shared/account-identity.js';
import { startTransactionConnection, commitTransactionConnection, rollbackTransactionConnection,
    releaseTransactionConnection } from './db-transaction.js';
import { LEGAL_VERSIONS } from './public/js/shared/legal-versions.js';

export { LEGAL_VERSIONS };
const REQUEST_TYPES = new Set(['access', 'correction', 'erasure', 'objection', 'other']);
const REQUEST_STATUSES = new Set(['open', 'in_review', 'closed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const error = (status, code) => ({ status, body: { error: code } });

function accountID(value) {
    const id = canonicalAccountID(value);
    if (!id) throw error(401, 'authentication_required');
    return id;
}

export function privacyEmail(value) {
    const email = typeof value === 'string' ? value.trim() : '';
    return email.length >= 3 && email.length <= 254 && !/[\s\r\n]/.test(email)
        && /^[^@]+@[^@]+\.[^@]+$/.test(email) ? email : null;
}

export function publicPrivacyOperator(environment = process.env) {
    const name = String(environment.BENCHPOLL_OPERATOR_NAME ?? '').trim();
    return { displayName: name || 'BenchPoll operator', email: privacyEmail(environment.BENCHPOLL_PRIVACY_EMAIL),
        identityPending: !name };
}

export function ensurePrivacyCSRF(session) {
    if (!/^[a-zA-Z0-9_-]{43}$/.test(session.privacyCSRF ?? '')) {
        session.privacyCSRF = crypto.randomBytes(32).toString('base64url');
    }
    return session.privacyCSRF;
}

export function assertPrivacyCSRF(session, token) {
    if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(token) || typeof session?.privacyCSRF !== 'string'
        || token.length !== 43 || session.privacyCSRF.length !== 43
        || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(session.privacyCSRF))) {
        throw error(403, 'privacy_form_expired');
    }
}

export function validateLegalChoice(input, { hashes, now = Date.now() } = {}) {
    if (input?.acceptedTerms !== true) throw error(400, 'terms_acceptance_required');
    if (input.eligibleAge !== true) throw error(400, 'age_eligibility_required');
    if (input.termsVersion !== LEGAL_VERSIONS.terms || input.privacyVersion !== LEGAL_VERSIONS.privacy) {
        throw error(409, 'legal_version_changed');
    }
    const hasResearchChoice = Object.hasOwn(input, 'privateCategoryResearch');
    const research = hasResearchChoice ? input.privateCategoryResearch : null;
    if (research === true) throw error(409, 'private_category_research_unavailable');
    if (hasResearchChoice && research !== false) throw error(400, 'invalid_privacy_preference');
    if (!hashes || !/^[a-f0-9]{64}$/.test(hashes.terms ?? '') || !/^[a-f0-9]{64}$/.test(hashes.privacy ?? '')) {
        throw error(503, 'legal_documents_unavailable');
    }
    return { ...LEGAL_VERSIONS, acceptedAt: new Date(now).toISOString(), eligibleAge: true,
        privateCategoryResearch: research, hashes: { ...hashes } };
}

export function assertPendingLegalChoice(choice, hashes, now = Date.now()) {
    const age = now - Date.parse(choice?.acceptedAt);
    if (!choice || choice.terms !== LEGAL_VERSIONS.terms || choice.privacy !== LEGAL_VERSIONS.privacy
        || choice.research !== LEGAL_VERSIONS.research || choice.eligibleAge !== true
        || choice.privateCategoryResearch !== null && choice.privateCategoryResearch !== false
        || !Number.isFinite(age) || age < 0 || age > 10 * 60 * 1000
        || choice.hashes?.terms !== hashes?.terms || choice.hashes?.privacy !== hashes?.privacy) {
        throw error(409, 'legal_acceptance_required');
    }
    return choice;
}

export function normalizePrivacyRequest(input) {
    const email = privacyEmail(input?.email);
    const message = typeof input?.message === 'string' ? input.message.trim() : '';
    if (!email) throw error(400, 'invalid_contact_email');
    if (!REQUEST_TYPES.has(input?.requestType)) throw error(400, 'invalid_privacy_request_type');
    if (message.length < 1 || message.length > 4000 || message.includes('\0')) {
        throw error(400, 'invalid_privacy_request_message');
    }
    return { email, requestType: input.requestType, message };
}

export function createPrivacyRequestLimiter({ now = Date.now, limit = 5, windowMs = 60 * 60 * 1000,
    maxBuckets = 5000, secret = crypto.randomBytes(32) } = {}) {
    const buckets = new Map();
    return address => {
        const time = now();
        for (const [key, bucket] of buckets) if (bucket.until <= time) buckets.delete(key);
        const key = crypto.createHmac('sha256', secret).update(String(address ?? 'unknown')).digest('hex');
        const bucket = buckets.get(key) ?? { count: 0, until: time + windowMs };
        if (bucket.count >= limit) throw error(429, 'privacy_request_rate_limited');
        if (!buckets.has(key) && buckets.size >= maxBuckets) throw error(429, 'privacy_request_rate_limited');
        ++bucket.count;
        buckets.set(key, bucket);
    };
}

async function transaction(pool, operation) {
    const connection = await pool.getConnection();
    try {
        await startTransactionConnection(connection, 'privacy-controls');
        const value = await operation(connection);
        await commitTransactionConnection(connection, 'privacy-controls');
        return value;
    } catch (cause) {
        await rollbackTransactionConnection(connection, 'privacy-controls', cause);
        throw cause;
    } finally { releaseTransactionConnection(connection, 'privacy-controls'); }
}

async function lockPrivacyAccount(connection, userID) {
    const [users] = await connection.execute('SELECT ID, deleted_at FROM users WHERE ID = ? FOR UPDATE', [userID]);
    if (!users.length || users[0].deleted_at) throw error(401, 'authentication_required');
}

async function writeResearchPreference(connection, userID, enabled, accountLocked = false) {
    if (enabled !== false) throw error(409, 'private_category_research_unavailable');
    // Lock before first-time inserts/FK checks so concurrent choices cannot upgrade shared locks in opposite order.
    if (!accountLocked) await lockPrivacyAccount(connection, userID);
    const [previous] = await connection.execute(
        'SELECT private_category_research, research_version FROM user_privacy_preferences WHERE user_ID = ? FOR UPDATE', [userID]);
    await connection.execute(`INSERT INTO user_privacy_preferences (user_ID, private_category_research, research_version)
        VALUES (?, ?, ?) AS preference ON DUPLICATE KEY UPDATE
        private_category_research = preference.private_category_research, research_version = preference.research_version,
        updated_at = CURRENT_TIMESTAMP(3)`, [userID, enabled ? 1 : 0, LEGAL_VERSIONS.research]);
    if (!previous.length || Boolean(previous[0].private_category_research) !== enabled
        || previous[0].research_version !== LEGAL_VERSIONS.research) {
        await connection.execute(`INSERT INTO privacy_preference_events (user_ID, research_version, enabled)
            VALUES (?, ?, ?)`, [userID, LEGAL_VERSIONS.research, enabled ? 1 : 0]);
    }
}

export function createPrivacyControls({ pool, hashes, operator = publicPrivacyOperator() }) {
    async function hasAccepted(userID) {
        const [rows] = await pool.execute(`SELECT 1 FROM user_legal_acceptances
            WHERE user_ID = ? AND terms_version = ? AND privacy_version = ? AND eligible_age = 1 LIMIT 1`,
        [accountID(userID), LEGAL_VERSIONS.terms, LEGAL_VERSIONS.privacy]);
        return rows.length === 1;
    }

    async function status(userID) {
        const id = userID == null ? null : accountID(userID);
        let accepted = false;
        if (id) {
            accepted = await hasAccepted(id);
        }
        // Historical choices remain stored, but none authorize new research.
        return { userID: id, authenticated: Boolean(id), versions: LEGAL_VERSIONS, accepted,
            privateCategoryResearch: false, operator };
    }

    async function recordAcceptanceOn(connection, userID, choice) {
        userID = accountID(userID);
        assertPendingLegalChoice(choice, hashes);
        await lockPrivacyAccount(connection, userID);
        await connection.execute(`INSERT INTO user_legal_acceptances
            (user_ID, terms_version, privacy_version, terms_hash, privacy_hash, eligible_age, accepted_at)
            VALUES (?, ?, ?, ?, ?, 1, ?) ON DUPLICATE KEY UPDATE user_ID = user_ID`,
        [userID, choice.terms, choice.privacy, choice.hashes.terms, choice.hashes.privacy,
            new Date(choice.acceptedAt)]);
        if (choice.privateCategoryResearch !== null) {
            await writeResearchPreference(connection, userID, choice.privateCategoryResearch, true);
        }
    }

    async function accept(userID, input) {
        const choice = validateLegalChoice(input, { hashes });
        await transaction(pool, connection => recordAcceptanceOn(connection, userID, choice));
        return status(userID);
    }

    async function savePreference(userID, enabled) {
        if (typeof enabled !== 'boolean') throw error(400, 'invalid_privacy_preference');
        if (enabled) throw error(409, 'private_category_research_unavailable');
        await transaction(pool, connection => writeResearchPreference(connection, accountID(userID), enabled));
        return status(userID);
    }

    async function submitRequest(userID, input) {
        const request = normalizePrivacyRequest(input);
        const reference = crypto.randomUUID();
        await pool.execute(`INSERT INTO privacy_requests (reference, user_ID, email, request_type, message, resolution, due_at)
            VALUES (?, ?, ?, ?, ?, '', DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 28 DAY))`,
        [reference, userID == null ? null : accountID(userID), request.email, request.requestType, request.message]);
        return { reference };
    }

    async function listRequests(before) {
        if (before !== undefined && (typeof before !== 'string' || !UUID.test(before))) {
            throw error(400, 'invalid_privacy_request_cursor');
        }
        const [rows] = await pool.execute(`SELECT reference, user_ID AS userID, email,
            request_type AS requestType, message, status, created_at AS createdAt, due_at AS dueAt, resolution
            FROM privacy_requests ${before ? `WHERE (created_at, reference) <
                (SELECT created_at, reference FROM privacy_requests WHERE reference = ?)` : ''}
            ORDER BY created_at DESC, reference DESC LIMIT 21`, before ? [before] : []);
        return { requests: rows.slice(0, 20).map(row => ({ ...row,
            userID: row.userID == null ? null : accountID(row.userID) })),
        nextCursor: rows.length > 20 ? rows[19].reference : null };
    }

    async function updateRequest(operatorID, input) {
        if (!UUID.test(input?.reference ?? '') || !REQUEST_STATUSES.has(input?.status)) {
            throw error(400, 'invalid_privacy_request_update');
        }
        const resolution = typeof input.resolution === 'string' ? input.resolution.trim() : '';
        if (resolution.length > 2000 || resolution.includes('\0') || (input.status === 'closed' && !resolution)) {
            throw error(400, 'invalid_privacy_request_resolution');
        }
        const [result] = await pool.execute(`UPDATE privacy_requests SET status = ?, resolution = ?, handled_by = ?,
            updated_at = CURRENT_TIMESTAMP(3) WHERE reference = ?`,
        [input.status, resolution, accountID(operatorID), input.reference]);
        if (!result.affectedRows) throw error(404, 'privacy_request_unavailable');
        return { updated: true };
    }

    return { hasAccepted, status, accept, recordAcceptanceOn, savePreference, submitRequest, listRequests, updateRequest };
}
