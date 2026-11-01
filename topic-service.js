import crypto from 'node:crypto';
import { canonicalAccountID } from './public/js/shared/account-identity.js';
import { FEATURED_TOPIC_ID, topicURL, topicSlug, isReservedTopicSlug, normalizeTopicSummary } from './public/js/shared/topics.js';
import { searchTopicGroups } from './public/js/navigation/scenes.js';
import { TOPIC_ACTIVITY_JOIN, orderTopicsByPopularity } from './topic-popularity.js';
import { loadTopicSceneCatalog } from './topic-scenes-service.js';
import { startTransactionConnection, commitTransactionConnection, rollbackTransactionConnection,
    releaseTransactionConnection } from './db-transaction.js';

const fail = (status, error) => { throw { status, body: { error } }; };
const emptyHash = crypto.createHash('sha256').update('{}').digest('hex');
const topicSelect = (withConfigured = false) => `SELECT c.ID, c.name, c.slug, c.description, c.owner_user_ID,
    c.created_by_user_ID, c.position, c.created_at,
    COALESCE(activity.popularity, 0) AS popularity, activity.last_activity,
    (c.created_by_user_ID IS NULL OR (u.ID IS NOT NULL AND
        (u.banned_at IS NULL OR (u.banned_until IS NOT NULL AND u.banned_until <= NOW())))) AS creator_eligible,
    COALESCE(NULLIF(p.display_name, ''), u.name) AS creator_name,
    COALESCE(p.avatar_data_url, u.profile_picture_URL) AS creator_avatar,
    ${withConfigured ? `EXISTS(SELECT 1 FROM ranking_contexts own_context
        JOIN personal_pies own_pie ON own_pie.context_ID = own_context.ID AND own_pie.user_ID = ?
        WHERE own_context.category_ID = c.ID AND
            (EXISTS(SELECT 1 FROM personal_pie_weights own_weight WHERE own_weight.pie_ID = own_pie.ID)
                OR EXISTS(SELECT 1 FROM personal_pie_topic_weights own_ref WHERE own_ref.pie_ID = own_pie.ID))) AS configured,` : ''}
    EXISTS(SELECT 1 FROM ranking_contexts rc JOIN personal_pies pp ON pp.context_ID = rc.ID
        WHERE rc.category_ID = c.ID AND
            (EXISTS(SELECT 1 FROM personal_pie_weights pw WHERE pw.pie_ID = pp.ID)
                OR EXISTS(SELECT 1 FROM personal_pie_topic_weights pr WHERE pr.pie_ID = pp.ID))) AS has_weights
    FROM categories c
    LEFT JOIN users u ON u.ID = c.created_by_user_ID AND u.deleted_at IS NULL
    LEFT JOIN user_public_profiles p ON p.user_ID = u.ID
    ${TOPIC_ACTIVITY_JOIN}`;

export function topicID(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail(400, 'invalid_topic_id');
    return value;
}

export function normalizeTopicRequest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => !['name', 'description', 'isPrivate'].includes(key))) fail(400, 'invalid_topic_request');
    const name = typeof body.name === 'string' ? body.name.trim().normalize('NFC') : '';
    if (!name || [...name].length > 128 || /[\p{Cc}\p{Cf}]/u.test(name)) fail(400, 'invalid_topic_name');
    if (typeof body.isPrivate !== 'boolean') fail(400, 'invalid_topic_visibility');
    if (isReservedTopicSlug(name)) fail(400, 'reserved_topic_name');
    let description;
    try { description = normalizeTopicSummary(body.description); }
    catch { fail(400, 'invalid_topic_description'); }
    return { name, description, isPrivate: body.isPrivate };
}

export function topicCreator(row) {
    if (row.owner_user_ID === null) return null;
    return { name: row.creator_name || (row.created_by_user_ID == null ? 'BenchPoll' : 'Former contributor'),
        avatarURL: row.creator_avatar || '/assets/benchpoll-mark.svg' };
}

export function serializeTopic(row) {
    const ID = Number(row.ID);
    const isPrivate = row.owner_user_ID != null;
    const slug = row.slug || topicSlug(row.name);
    const url = topicURL(ID, row.name, isPrivate, slug);
    return { ID, categoryID: ID, name: row.name, categoryName: row.name, slug,
        description: row.description ?? '', isPrivate, hasWeights: Boolean(row.has_weights),
        url, path: url.slice(1),
        lineage: [{ ID, name: row.name, position: Number(row.position ?? 0) }],
        creator: isPrivate ? topicCreator(row) : null };
}

export async function attachTopicScenes(db, topics) {
    const catalog = await loadTopicSceneCatalog(db, topics.map(topic => topic.ID));
    return topics.map(topic => {
        const entry = catalog.get(topic.ID);
        return { ...topic, ...entry, hasScenes: entry.scenes.length > 0,
            contextValues: entry.scenes.length ? { scene: String(entry.defaultContextID) } : {} };
    });
}

export function searchTopicsAndScenes(topics, query) {
    if (!query.trim()) return topics;
    return searchTopicGroups(topics, query).map(({ topic, scenes }) => ({ ...topic,
        searchMatches: scenes.map(scene => ({ ...scene, kind: 'scene', topicName: topic.name })) }));
}

export async function getTopic(db, userID, value) {
    const ID = topicID(value);
    const [rows] = await db.execute(`${topicSelect()}
        WHERE c.ID = ? AND c.is_active = 1 AND (c.owner_user_ID IS NULL OR c.owner_user_ID = ?)`, [ID, userID]);
    if (!rows.length) fail(404, 'topic_not_found');
    return (await attachTopicScenes(db, [serializeTopic(rows[0])]))[0];
}

export async function findTopicBySlug(db, slug) {
    if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
        || slug.length > 80 || isReservedTopicSlug(slug)) return null;
    const [rows] = await db.execute(`${topicSelect()}
        WHERE c.slug = ? AND c.owner_user_ID IS NULL AND c.is_active = 1`, [slug]);
    return rows.length === 1 ? (await attachTopicScenes(db, [serializeTopic(rows[0])]))[0] : null;
}

export async function listTopics(db, userID, body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => key !== 'query')) fail(400, 'invalid_topic_query');
    const query = body.query ?? '';
    if (typeof query !== 'string' || query.length > 128) fail(400, 'invalid_topic_query');
    const [rows] = await db.execute(`${topicSelect(true)}
        WHERE c.is_active = 1 AND (c.owner_user_ID IS NULL OR c.owner_user_ID = ?)
        ORDER BY c.ID = ? DESC, c.position, c.name, c.ID`, [userID, userID, FEATURED_TOPIC_ID]);
    let topics = orderTopicsByPopularity(rows).map(row => ({ ...serializeTopic(row),
        isMine: userID != null && String(row.created_by_user_ID ?? row.owner_user_ID) === String(userID),
        configured: Boolean(row.configured) }));
    topics = searchTopicsAndScenes(await attachTopicScenes(db, topics), query);
    return { topics, featuredTopicID: FEATURED_TOPIC_ID };
}

export async function createTopic(db, userID, body) {
    const owner = canonicalAccountID(userID);
    if (!owner) fail(401, 'authentication_required');
    const topic = normalizeTopicRequest(body);
    if (!topic.isPrivate) fail(409, 'public_topic_review_required');
    const connection = await db.getConnection();
    let ID;
    try {
        await startTransactionConnection(connection, 'CREATE TOPIC');
        const [users] = await connection.execute(`SELECT ID FROM users WHERE ID = ? AND deleted_at IS NULL
            AND (banned_at IS NULL OR (banned_until IS NOT NULL AND banned_until <= NOW())) FOR UPDATE`, [owner]);
        if (!users.length) fail(401, 'authentication_required');
        const [[count]] = await connection.execute(`SELECT COUNT(*) AS count FROM categories
            WHERE created_by_user_ID = ? AND created_at >= NOW() - INTERVAL 1 DAY`, [owner]);
        if (Number(count.count) >= 20) fail(429, 'topic_creation_limit');
        const slug = topicSlug(topic.name);
        const [result] = await connection.execute(`INSERT INTO categories
            (name, slug, description, owner_user_ID, created_by_user_ID, position)
            VALUES (?, ?, ?, ?, ?, 0)`, [topic.name, slug, topic.description,
        owner, owner]);
        ID = Number(result.insertId);
        await connection.execute(`INSERT INTO ranking_contexts (category_ID, context_values, context_hash)
            VALUES (?, '{}', ?)`, [ID, emptyHash]);
        await commitTransactionConnection(connection, 'CREATE TOPIC');
    } catch (error) {
        await rollbackTransactionConnection(connection, 'CREATE TOPIC', error);
        if (error.code === 'ER_DUP_ENTRY') fail(409, 'topic_name_exists');
        throw error;
    } finally { releaseTransactionConnection(connection, 'CREATE TOPIC'); }
    return { ...await getTopic(db, owner, ID), isMine: true, configured: false };
}

export async function assertPublicTopicAvailable(connection, topic) {
    if (isReservedTopicSlug(topic.name)) fail(400, 'reserved_topic_name');
    const slug = topicSlug(topic.name);
    const [existing] = await connection.execute(`SELECT ID FROM categories
        WHERE owner_user_ID IS NULL AND (slug = ? OR name = ?) LIMIT 1`, [slug, topic.name]);
    if (existing.length) fail(409, 'topic_name_exists');
    const key = legacyTopicRouteKey(slug);
    const [aliases] = await connection.execute(`SELECT category_ID FROM topic_legacy_routes
        WHERE route_hash = UNHEX(?) AND route_key = ?`,
    [crypto.createHash('sha256').update(key).digest('hex'), key]);
    if (aliases.length) fail(409, 'topic_name_exists');
    return slug;
}

export function legacyTopicRouteKey(path) {
    return String(path).split('/').filter(Boolean).map(part => decodeURIComponent(part)
        .normalize('NFC').toLowerCase().replace(/[-_\s]+/g, ' ').trim()).join('/');
}

export async function resolveLegacyTopic(db, path, userID = null) {
    let key;
    try { key = legacyTopicRouteKey(path); } catch { return null; }
    if (!key || key.length > 2048) return null;
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    const [rows] = await db.execute(`SELECT category_ID FROM topic_legacy_routes
        WHERE route_hash = UNHEX(?) AND route_key = ?`, [hash, key]);
    if (!rows.length) return null;
    try { return await getTopic(db, userID, Number(rows[0].category_ID)); }
    catch (error) { if (error.status === 404) return null; throw error; }
}
