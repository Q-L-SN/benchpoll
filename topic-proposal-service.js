import { canonicalAccountID } from './public/js/shared/account-identity.js';
import { topicURL } from './public/js/shared/topics.js';
import { normalizeTopicRequest, assertPublicTopicAvailable } from './topic-service.js';
import { normalizeTopicSceneRequest, assertPublicSceneAvailable, lockTopicReferenceGraph,
    addTopicSceneInTransaction, topicSceneURL, TOPIC_SCENE_SQL_PREVIEW } from './topic-scenes-service.js';
import { moderationRecipientEmail } from './moderation-email.js';
import { claimWriteIntent, completeWriteIntent } from './write-idempotency.js';
import { startTransactionConnection, commitTransactionConnection, rollbackTransactionConnection,
    releaseTransactionConnection, runDatabaseOperation } from './db-transaction.js';
import { captureTopicSnapshot, saveTopicProposalSnapshot, loadTopicProposalSnapshot, snapshotHash } from './topic-snapshot-service.js';

export const TOPIC_PROPOSAL_THRESHOLD = 30;
export const TOPIC_PROPOSAL_SUPPORT_LIMIT = 3;
export const TOPIC_PROPOSAL_ACTIVE_LIMIT = 1;
export const TOPIC_PROPOSAL_DAYS = 14;
// Explicit offline migration hook; no API or runtime initialization calls it.
export async function ensureTopicProposalSchema(connection) {
    const migration = await import('./scripts/migrate-topic-proposals-20261027.mjs');
    return migration.ensureTopicProposalSchema(connection);
}
export async function ensureTopicProposalLimitsSchema(connection) {
    const migration = await import('./scripts/migrate-topic-proposal-limits-20261028.mjs');
    return migration.ensureTopicProposalLimitsSchema(connection);
}
const fail = (status, error, extra = {}) => { throw { status, body: { error, ...extra } }; };
const account = value => canonicalAccountID(value) || fail(401, 'authentication_required');
export function topicProposalID(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail(400, 'invalid_topic_proposal_id');
    return value;
}
function record(body, keys) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => !keys.includes(key))) fail(400, 'invalid_topic_proposal_request');
}
const active = alias => `${alias}.status = 'open' AND ${alias}.withdrawn_at IS NULL
    AND ${alias}.created_at > CURRENT_TIMESTAMP(3) - INTERVAL 14 DAY`;
const effectiveStatus = `CASE WHEN p.withdrawn_at IS NOT NULL THEN 'withdrawn'
    WHEN p.status = 'open' AND p.created_at <= CURRENT_TIMESTAMP(3) - INTERVAL 14 DAY THEN 'expired'
    ELSE p.status END`;
const projection = `SELECT p.*,
    ${effectiveStatus} AS effective_status,
    UNIX_TIMESTAMP(p.created_at + INTERVAL 14 DAY) * 1000 AS expires_at_ms,
    (SELECT COUNT(*) FROM topic_proposal_votes v WHERE v.proposal_ID = p.ID) AS support_count,
    EXISTS(SELECT 1 FROM topic_proposal_votes own WHERE own.proposal_ID = p.ID AND own.user_ID = ?) AS supported,
    c.name AS published_name, c.slug AS published_slug, published_scene.slug AS published_scene_slug,
    snapshot.source_topic_ID AS source_topic_ID
    FROM topic_proposals p LEFT JOIN categories c ON c.ID = COALESCE(p.topic_ID, p.parent_topic_ID) AND c.is_active = 1
    LEFT JOIN topic_scenes published_scene ON published_scene.context_ID = p.scene_context_ID AND published_scene.is_active = 1
    LEFT JOIN topic_proposal_snapshots snapshot ON snapshot.proposal_ID = p.ID AND snapshot.revision = p.revision`;

export function normalizeTopicProposalRequest(body) {
    record(body, ['name', 'description', 'parentTopicID']);
    if (body.parentTopicID !== undefined) {
        const scene = normalizeTopicSceneRequest({ categoryID: body.parentTopicID, name: body.name, description: body.description });
        return { name: scene.name, description: scene.description, parentTopicID: scene.categoryID };
    }
    const topic = normalizeTopicRequest({ ...body, isPrivate: false });
    return { name: topic.name, description: topic.description };
}

export function serializeTopicProposal(row, userID = null, quota = null) {
    const proposalID = topicProposalID(Number(row.ID));
    const topicID = row.topic_ID == null ? null : topicProposalID(Number(row.topic_ID));
    const supported = Number(row.supported) === 1;
    const status = row.effective_status ?? row.status;
    const isMine = Boolean(userID && String(row.user_ID) === userID);
    const expires = Number(row.expires_at_ms ?? (new Date(row.created_at).getTime() + TOPIC_PROPOSAL_DAYS * 86400000));
    const revision = Number(row.revision);
    if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isFinite(expires)) fail(503, 'topic_proposal_metadata_invalid');
    const parentTopicID = row.parent_topic_ID == null ? null : topicProposalID(Number(row.parent_topic_ID));
    const sceneID = row.scene_context_ID == null ? null : topicProposalID(Number(row.scene_context_ID));
    return { proposalID, name: row.name, description: row.description, supportCount: Number(row.support_count),
        threshold: TOPIC_PROPOSAL_THRESHOLD, status, supported, revision, expiresAt: new Date(expires).toISOString(), isMine,
        canSupport: Boolean(userID && !isMine && status === 'open' && !supported
            && (quota?.activeSupports ?? 0) < TOPIC_PROPOSAL_SUPPORT_LIMIT),
        canEdit: isMine && status === 'open', canWithdraw: isMine && status === 'open',
        canCancelSupport: Boolean(userID && supported && status === 'open'),
        submissionID: row.moderation_log_ID == null ? null : topicProposalID(Number(row.moderation_log_ID)),
        topicID, hasSnapshot: row.source_topic_ID != null,
        previewURL: row.source_topic_ID == null ? null : `/topic-proposals/${proposalID}/preview`,
        ...(isMine && row.source_topic_ID != null ? { sourceTopicID: Number(row.source_topic_ID) } : {}),
        ...(parentTopicID === null ? {} : { kind: 'scene', parentTopicID, parentTopicName: row.published_name ?? null, sceneID,
            sceneSlug: row.published_scene_slug ?? null }),
        url: sceneID && row.published_slug ? topicSceneURL({ ID: parentTopicID, name: row.published_name, slug: row.published_slug },
            { name: row.name, slug: row.published_scene_slug })
            : topicID && row.published_slug ? topicURL(topicID, row.published_name, false, row.published_slug) : null };
}

async function accountQuota(connection, userID) {
    if (!userID) return null;
    const [[row]] = await connection.execute(`SELECT
        (SELECT COUNT(*) FROM topic_proposal_votes v JOIN topic_proposals p ON p.ID = v.proposal_ID
            WHERE v.user_ID = ? AND ${active('p')}) AS active_supports,
        (SELECT p.ID FROM topic_proposals p WHERE p.user_ID = ? AND ${active('p')} ORDER BY p.ID DESC LIMIT 1) AS active_proposal_ID`, [userID, userID]);
    return { activeSupports: Number(row.active_supports),
        activeProposalID: row.active_proposal_ID == null ? null : topicProposalID(Number(row.active_proposal_ID)) };
}

async function releaseExpiredReservations(connection, slug, name) {
    await connection.execute(`UPDATE topic_proposals
        SET reservation_slug = NULL, reservation_name = NULL, updated_at = updated_at
        WHERE (withdrawn_at IS NOT NULL OR status = 'rejected'
            OR (status = 'open' AND created_at <= CURRENT_TIMESTAMP(3) - INTERVAL 14 DAY))
          AND (reservation_slug = ? OR reservation_name = ?)`, [slug, name]);
}

export async function readProposal(connection, ID, userID) {
    const [rows] = await connection.execute(`${projection} WHERE p.ID = ?`, [userID, ID]);
    if (rows.length !== 1) fail(404, 'topic_proposal_not_found');
    return serializeTopicProposal(rows[0], userID, await accountQuota(connection, userID));
}

function revision(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail(400, 'topic_proposal_revision_required');
    return value;
}

async function collectingProposal(connection, ID, expectedRevision) {
    const query = `SELECT p.*, ${effectiveStatus} AS effective_status FROM topic_proposals p WHERE p.ID = ?`;
    const check = proposal => {
        if (!proposal) fail(404, 'topic_proposal_not_found');
        if (proposal.effective_status === 'expired') fail(409, 'topic_proposal_expired');
        if (proposal.effective_status !== 'open') fail(409, 'topic_proposal_not_open');
        if (Number(proposal.revision) !== expectedRevision) fail(409, 'topic_proposal_changed');
    };
    // A review may hold a pending row before its author FK; never wait on that row while holding the author.
    const [current] = await connection.execute(query, [ID]);
    check(current[0]);
    const [rows] = await connection.execute(query + ' FOR UPDATE', [ID]);
    const proposal = rows[0];
    check(proposal);
    return proposal;
}

// Lock parents before write-intent/FK inserts; every actor's parallel requests share one lock.
async function lockAccounts(connection, userID, proposalID) {
    let owner = userID;
    if (proposalID) {
        const [rows] = await connection.execute('SELECT user_ID FROM topic_proposals WHERE ID = ?', [proposalID]);
        if (!rows.length) fail(404, 'topic_proposal_not_found');
        owner = account(rows[0].user_ID);
    }
    const ids = [...new Set([userID, owner])].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
    const [users] = await connection.execute(`SELECT ID, email, email_verified_at,
        (deleted_at IS NULL AND (banned_at IS NULL OR (banned_until IS NOT NULL AND banned_until <= NOW()))) AS active
        FROM users WHERE ID IN (${ids.map(() => '?').join(', ')}) ORDER BY ID FOR UPDATE`, ids);
    const actor = users.find(user => String(user.ID) === userID);
    if (!actor || Number(actor.active) !== 1) fail(401, 'authentication_required');
    return { actor, ownerActive: users.some(user => String(user.ID) === owner && Number(user.active) === 1) };
}

export async function lockTopicProposalForReview(connection, content, metadata) {
    const ID = topicProposalID(content.proposalID);
    const [rows] = await connection.execute('SELECT * FROM topic_proposals WHERE ID = ? FOR UPDATE', [ID]);
    const proposal = rows[0];
    if (!proposal || proposal.status !== 'pending' || Number(proposal.moderation_log_ID) !== metadata.moderationLogID
        || !canonicalAccountID(metadata.submittedBy) || String(proposal.user_ID) !== String(metadata.submittedBy)) {
        fail(409, 'topic_proposal_review_mismatch');
    }
    if ((proposal.parent_topic_ID == null ? null : Number(proposal.parent_topic_ID)) !== (content.parentTopicID ?? null)) {
        fail(409, 'topic_proposal_review_mismatch');
    }
    const [[votes]] = await connection.execute(`SELECT COUNT(*) AS support_count FROM topic_proposal_votes
        WHERE proposal_ID = ? AND user_ID <> ?`, [ID, proposal.user_ID]);
    const count = Number(votes.support_count);
    if (!Number.isSafeInteger(count) || count < TOPIC_PROPOSAL_THRESHOLD) fail(409, 'topic_proposal_threshold_required');
    return proposal;
}

export async function finishTopicProposalReview(connection, proposal, status, topicID = null, { sceneID = null } = {}) {
    const sceneProposal = proposal.parent_topic_ID != null;
    const approvedIdentity = sceneProposal ? sceneID : topicID;
    if (!['approved', 'rejected'].includes(status)
        || status === 'approved' && (!Number.isSafeInteger(approvedIdentity) || approvedIdentity === 0
            || approvedIdentity < 0 && connection[TOPIC_SCENE_SQL_PREVIEW] !== true)
        || status === 'rejected' && (topicID !== null || sceneID !== null)
        || sceneProposal && topicID !== null || !sceneProposal && sceneID !== null) fail(409, 'invalid_topic_proposal_decision');
    if (sceneProposal) {
        const [updated] = await connection.execute(`UPDATE topic_proposals SET status = ?, scene_context_ID = ?,
            decided_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
            WHERE ID = ? AND status = 'pending' AND moderation_log_ID = ?`,
        [status, sceneID, proposal.ID, proposal.moderation_log_ID]);
        if (Number(updated.affectedRows) !== 1) fail(409, 'topic_proposal_review_mismatch');
        return;
    }
    // Negative IDs are accepted only on the explicitly marked non-writing preview recorder.
    const [updated] = await connection.execute(`UPDATE topic_proposals SET status = ?, topic_ID = ?,
        decided_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
        WHERE ID = ? AND status = 'pending' AND moderation_log_ID = ?`,
    [status, topicID, proposal.ID, proposal.moderation_log_ID]);
    if (Number(updated.affectedRows) !== 1) fail(409, 'topic_proposal_review_mismatch');
}

export async function approveTopicSceneProposal(connection, content, metadata) {
    await lockTopicReferenceGraph(connection);
    const proposal = await lockTopicProposalForReview(connection, content, metadata);
    if (proposal.parent_topic_ID == null) fail(409, 'topic_scene_proposal_required');
    const reviewed = normalizeTopicSceneRequest({ categoryID: Number(proposal.parent_topic_ID), name: content.name, description: content.description });
    const { topic } = await assertPublicSceneAvailable(connection, reviewed.categoryID, reviewed.name, { lock: true });
    const created = await addTopicSceneInTransaction(connection, topic, { ...reviewed, isDefault: false });
    await finishTopicProposalReview(connection, proposal, 'approved', null, { sceneID: created.sceneID });
    return created;
}

async function assertProposedTargetAvailable(connection, proposal) {
    if (proposal.parent_topic_ID == null) return assertPublicTopicAvailable(connection, proposal);
    return (await assertPublicSceneAvailable(connection, Number(proposal.parent_topic_ID), proposal.name)).slug;
}

async function releaseExpiredSceneReservations(connection, parentTopicID, slug, name) {
    await connection.execute(`UPDATE topic_proposals SET scene_reservation_slug = NULL, scene_reservation_name = NULL,
        updated_at = updated_at WHERE parent_topic_ID = ?
        AND (withdrawn_at IS NOT NULL OR status = 'rejected'
            OR (status = 'open' AND created_at <= CURRENT_TIMESTAMP(3) - INTERVAL 14 DAY))
        AND (scene_reservation_slug = ? OR scene_reservation_name = ?)`, [parentTopicID, slug, name]);
}

export function createTopicProposalService({ pool, queueForReview, captureSnapshot = captureTopicSnapshot,
    saveSnapshot = saveTopicProposalSnapshot, loadSnapshot = loadTopicProposalSnapshot }) {
    async function write(userID, key, action, payload, operation) {
        const connection = await pool.getConnection();
        try {
            await runDatabaseOperation(connection, 'TOPIC PROPOSAL',
                () => connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'));
            await startTransactionConnection(connection, 'TOPIC PROPOSAL');
            await lockTopicReferenceGraph(connection);
            const deleting = action === 'withdraw_topic_proposal';
            const accounts = await lockAccounts(connection, userID, deleting ? null : payload.proposalID);
            const intent = await claimWriteIntent(connection, { userID, key, action, payload });
            const response = intent.response ? (deleting ? intent.response.body : await readProposal(connection, intent.response.body.proposalID, userID))
                : await operation(connection, accounts);
            if (!intent.response) await completeWriteIntent(connection, intent, { status: 200, body: response });
            await commitTransactionConnection(connection, 'TOPIC PROPOSAL');
            return response;
        } catch (error) {
            await rollbackTransactionConnection(connection, 'TOPIC PROPOSAL', error);
            throw error;
        } finally { releaseTransactionConnection(connection, 'TOPIC PROPOSAL'); }
    }

    async function propose(userID, body, key) {
        userID = account(userID);
        record(body, ['sourceTopicID', 'name', 'description']);
        if (body.sourceTopicID === undefined) fail(400, 'private_topic_source_required');
        const normalized = { sourceTopicID: topicProposalID(body.sourceTopicID), ...(body.name === undefined && body.description === undefined ? {}
                : normalizeTopicProposalRequest({ name: body.name, description: body.description })) };
        let { name, description } = normalized;
        const { sourceTopicID } = normalized;
        return write(userID, key, 'propose_topic', normalized, async (connection, { actor }) => {
            if (!actor.email_verified_at || !moderationRecipientEmail(actor.email)) {
                fail(409, 'verified_email_required', { action: 'reauthorize_github' });
            }
            const quota = await accountQuota(connection, userID);
            if (quota.activeProposalID !== null) fail(409, 'active_topic_proposal_limit', { proposalID: quota.activeProposalID });
            const [[count]] = await connection.execute(`SELECT GREATEST(
                (SELECT COUNT(*) FROM topic_proposals WHERE user_ID = ? AND created_at >= NOW() - INTERVAL 1 DAY),
                (SELECT COUNT(*) FROM write_requests WHERE actor_user_ID = ? AND action = 'propose_topic'
                    AND response_status = 200 AND created_at >= NOW() - INTERVAL 1 DAY)) AS count`, [userID, userID]);
            if (Number(count.count) >= 20) fail(429, 'topic_creation_limit');
            const snapshot = await captureSnapshot(connection, userID, sourceTopicID, { name, description });
            ({ name, description } = snapshot);
            const slug = await assertPublicTopicAvailable(connection, { name, description });
            await releaseExpiredReservations(connection, slug, name);
            const findExisting = async (locking = '') => {
                const [rows] = await connection.execute(`SELECT ID FROM topic_proposals WHERE reservation_slug = ? OR reservation_name = ? LIMIT 1${locking}`, [slug, name]);
                return rows[0];
            };
            const existing = await findExisting();
            if (existing) fail(409, 'topic_proposal_exists', { proposalID: Number(existing.ID) });
            let inserted;
            try {
                [inserted] = await connection.execute(`INSERT INTO topic_proposals
                    (user_ID, name, slug, description, reservation_slug, reservation_name)
                    VALUES (?, ?, ?, ?, ?, ?)`, [userID, name, slug, description, slug, name]);
            } catch (error) {
                if (error.code !== 'ER_DUP_ENTRY') throw error;
                const duplicate = await findExisting(' FOR SHARE');
                fail(409, 'topic_proposal_exists', { proposalID: duplicate ? Number(duplicate.ID) : null });
            }
            await saveSnapshot(connection, Number(inserted.insertId), 1, sourceTopicID, snapshot);
            return readProposal(connection, topicProposalID(Number(inserted.insertId)), userID);
        });
    }

    async function list(userID, body = {}) {
        userID = userID == null ? null : account(userID); record(body, ['before', 'view']);
        const before = body.before === undefined ? null : topicProposalID(body.before);
        const view = body.view ?? 'all';
        if (!['all', 'review'].includes(view)) fail(400, 'invalid_topic_proposal_view');
        const [rows] = await pool.execute(`${projection} WHERE p.withdrawn_at IS NULL
            ${view === 'review' ? "AND p.status = 'pending'" : ''} ${before === null ? '' : 'AND p.ID < ?'}
            ORDER BY p.ID DESC LIMIT 31`, before === null ? [userID] : [userID, before]);
        const quota = await accountQuota(pool, userID);
        let activeProposal = quota?.activeProposalID ? await readProposal(pool, quota.activeProposalID, userID) : null;
        if (activeProposal && activeProposal.status !== 'open') { activeProposal = null; quota.activeProposalID = null; }
        return { authenticated: Boolean(userID), proposals: rows.slice(0, 30).map(row => serializeTopicProposal(row, userID, quota)),
            nextCursor: rows.length > 30 ? Number(rows[29].ID) : null, threshold: TOPIC_PROPOSAL_THRESHOLD,
            account: quota, activeProposal,
            limits: { supports: TOPIC_PROPOSAL_SUPPORT_LIMIT, proposals: TOPIC_PROPOSAL_ACTIVE_LIMIT, days: TOPIC_PROPOSAL_DAYS } };
    }

    async function support(userID, body, key) {
        userID = account(userID); record(body, ['proposalID', 'revision']);
        const ID = topicProposalID(body.proposalID);
        const expectedRevision = revision(body.revision);
        return write(userID, key, 'vote_topic_proposal', { proposalID: ID, revision: expectedRevision }, async (connection, { ownerActive }) => {
            const proposal = await collectingProposal(connection, ID, expectedRevision);
            if (String(proposal.user_ID) === userID) fail(403, 'proposal_self_support_not_allowed');
            if (!ownerActive) fail(409, 'topic_proposal_not_open');
            const [previous] = await connection.execute('SELECT user_ID FROM topic_proposal_votes WHERE proposal_ID = ? AND user_ID = ?', [ID, userID]);
            if (previous.length) return readProposal(connection, ID, userID);
            if ((await accountQuota(connection, userID)).activeSupports >= TOPIC_PROPOSAL_SUPPORT_LIMIT) fail(409, 'topic_proposal_support_limit');
            const [inserted] = await connection.execute(`INSERT INTO topic_proposal_votes (proposal_ID, user_ID)
                SELECT ID, ? FROM topic_proposals p WHERE p.ID = ? AND ${active('p')}`, [userID, ID]);
            if (Number(inserted.affectedRows) !== 1) fail(409, 'topic_proposal_expired');
            const [[votes]] = await connection.execute('SELECT COUNT(*) AS support_count FROM topic_proposal_votes WHERE proposal_ID = ?', [ID]);
            if (Number(votes.support_count) >= TOPIC_PROPOSAL_THRESHOLD) {
                await assertProposedTargetAvailable(connection, proposal);
                const moderationLogID = topicProposalID(Number(await queueForReview(connection, proposal)));
                const [updated] = await connection.execute(`UPDATE topic_proposals SET status = 'pending', moderation_log_ID = ?,
                    promoted_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
                    WHERE ID = ? AND status = 'open' AND moderation_log_ID IS NULL`, [moderationLogID, ID]);
                if (Number(updated.affectedRows) !== 1) fail(409, 'topic_proposal_not_open');
            }
            return readProposal(connection, ID, userID);
        });
    }

    async function cancelSupport(userID, body, key) {
        userID = account(userID); record(body, ['proposalID', 'revision']);
        const ID = topicProposalID(body.proposalID), expectedRevision = revision(body.revision);
        return write(userID, key, 'cancel_topic_proposal_support', { proposalID: ID, revision: expectedRevision }, async connection => {
            await collectingProposal(connection, ID, expectedRevision);
            await connection.execute('DELETE FROM topic_proposal_votes WHERE proposal_ID = ? AND user_ID = ?', [ID, userID]);
            return readProposal(connection, ID, userID);
        });
    }

    async function edit(userID, body, key) {
        userID = account(userID); record(body, ['proposalID', 'revision', 'name', 'description', 'sourceTopicID']);
        const ID = topicProposalID(body.proposalID), expectedRevision = revision(body.revision);
        // Validate shared text before borrowing a connection; the stored parent decides namespace validation below.
        const metadata = body.name === undefined && body.description === undefined && body.sourceTopicID !== undefined ? {}
            : normalizeTopicSceneRequest({ categoryID: 1, name: body.name, description: body.description });
        let { name, description } = metadata;
        const sourceTopicID = body.sourceTopicID === undefined ? null : topicProposalID(body.sourceTopicID);
        return write(userID, key, 'edit_topic_proposal', { proposalID: ID, revision: expectedRevision,
            ...(name === undefined ? {} : { name, description }), ...(sourceTopicID === null ? {} : { sourceTopicID }) }, async connection => {
            const proposal = await collectingProposal(connection, ID, expectedRevision);
            if (String(proposal.user_ID) !== userID) fail(403, 'topic_proposal_not_owner');
            if (sourceTopicID !== null && proposal.parent_topic_ID != null) fail(400, 'invalid_topic_proposal_request');
            const saved = proposal.parent_topic_ID == null ? await loadSnapshot(connection, ID, expectedRevision) : null;
            const snapshot = sourceTopicID !== null ? await captureSnapshot(connection, userID, sourceTopicID, { name, description })
                : saved ? { ...saved.snapshot, name, description } : null;
            if (snapshot) ({ name, description } = snapshot);
            if (name === proposal.name && description === proposal.description
                && (!snapshot || saved && snapshotHash(saved.snapshot) === snapshotHash(snapshot))) return readProposal(connection, ID, userID);
            if (proposal.parent_topic_ID != null) {
                const parentTopicID = Number(proposal.parent_topic_ID);
                const { slug } = await assertPublicSceneAvailable(connection, parentTopicID, name);
                await releaseExpiredSceneReservations(connection, parentTopicID, slug, name);
                const [duplicates] = await connection.execute(`SELECT ID FROM topic_proposals WHERE ID <> ? AND parent_topic_ID = ?
                    AND (scene_reservation_slug = ? OR scene_reservation_name = ?) LIMIT 1`, [ID, parentTopicID, slug, name]);
                if (duplicates.length) fail(409, 'topic_proposal_exists', { proposalID: Number(duplicates[0].ID) });
                try {
                    await connection.execute(`UPDATE topic_proposals SET name = ?, slug = ?, description = ?,
                        scene_reservation_slug = ?, scene_reservation_name = ?, revision = revision + 1,
                        updated_at = CURRENT_TIMESTAMP(3) WHERE ID = ?`, [name, slug, description, slug, name, ID]);
                } catch (error) {
                    if (error.code === 'ER_DUP_ENTRY') fail(409, 'topic_proposal_exists');
                    throw error;
                }
                await connection.execute('DELETE FROM topic_proposal_votes WHERE proposal_ID = ?', [ID]);
                return readProposal(connection, ID, userID);
            }
            const slug = await assertPublicTopicAvailable(connection, { name, description });
            await releaseExpiredReservations(connection, slug, name);
            const [duplicates] = await connection.execute('SELECT ID FROM topic_proposals WHERE ID <> ? AND (reservation_slug = ? OR reservation_name = ?) LIMIT 1', [ID, slug, name]);
            if (duplicates.length) fail(409, 'topic_proposal_exists', { proposalID: Number(duplicates[0].ID) });
            try {
                await connection.execute(`UPDATE topic_proposals SET name = ?, slug = ?, description = ?,
                    reservation_slug = ?, reservation_name = ?, revision = revision + 1,
                    updated_at = CURRENT_TIMESTAMP(3) WHERE ID = ?`, [name, slug, description, slug, name, ID]);
            } catch (error) {
                if (error.code === 'ER_DUP_ENTRY') fail(409, 'topic_proposal_exists');
                throw error;
            }
            if (snapshot) await saveSnapshot(connection, ID, expectedRevision + 1, sourceTopicID ?? saved.sourceTopicID, snapshot);
            await connection.execute('DELETE FROM topic_proposal_votes WHERE proposal_ID = ?', [ID]);
            return readProposal(connection, ID, userID);
        });
    }

    async function withdraw(userID, body, key) {
        userID = account(userID); record(body, ['proposalID', 'revision']);
        const ID = topicProposalID(body.proposalID), expectedRevision = revision(body.revision);
        return write(userID, key, 'withdraw_topic_proposal', { proposalID: ID, revision: expectedRevision }, async connection => {
            const proposal = await collectingProposal(connection, ID, expectedRevision);
            if (String(proposal.user_ID) !== userID) fail(403, 'topic_proposal_not_owner');
            const [deleted] = await connection.execute('DELETE FROM topic_proposals WHERE ID = ?', [ID]);
            if (Number(deleted.affectedRows) !== 1) fail(409, 'topic_proposal_not_open');
            return { proposalID: ID, deleted: true };
        });
    }
    return { propose, list, support, cancelSupport, edit, withdraw };
}
