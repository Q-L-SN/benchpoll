import crypto from 'node:crypto';
import { canonicalAccountID } from './public/js/shared/account-identity.js';
import { topicURL, topicSlug, normalizeTopicSummary } from './public/js/shared/topics.js';
import { searchTopicGroups } from './public/js/navigation/scenes.js';
import { TOPIC_ACTIVITY_JOIN, orderTopicsByPopularity, topicPopularity } from './topic-popularity.js';
import { loadTopicSceneCatalog, lockTopicReferenceGraph } from './topic-scenes-service.js';
import { allocateTopicIdentity } from './topic-platform-schema.js';
import { startTransactionConnection, commitTransactionConnection, rollbackTransactionConnection,
    releaseTransactionConnection } from './db-transaction.js';

const fail = (status, error) => { throw { status, body: { error } }; };
const emptyHash = crypto.createHash('sha256').update('{}').digest('hex');
const eligibleUser = alias => `${alias}.deleted_at IS NULL AND (${alias}.banned_at IS NULL OR (${alias}.banned_until IS NOT NULL AND ${alias}.banned_until <= NOW()))`;
const hasWeights = alias => `(EXISTS(SELECT 1 FROM personal_pie_weights w WHERE w.pie_ID = ${alias}.ID AND w.weight_basis_points > 0)
    OR EXISTS(SELECT 1 FROM personal_pie_topic_weights w WHERE w.pie_ID = ${alias}.ID AND w.weight_basis_points > 0))`;
const activeContext = alias => `(EXISTS(SELECT 1 FROM topic_scenes current_scene WHERE current_scene.context_ID = ${alias}.ID AND current_scene.is_active = 1)
    OR (${alias}.context_hash = '${emptyHash}' AND NOT EXISTS(SELECT 1 FROM topic_scenes any_scene
        WHERE any_scene.category_ID = ${alias}.category_ID AND any_scene.is_active = 1)))`;

// The first two parameters are always the viewer; visibility predicates remain
// explicit at each caller so profile queries cannot accidentally include private topics.
export const topicSelect = () => `SELECT c.ID, c.name, c.slug, c.description, c.owner_user_ID,
    c.public_ID, c.private_ID, c.is_official, c.created_by_user_ID, c.position, c.created_at, c.is_active,
    COALESCE(activity.favorite_count, 0) AS favorite_count,
    COALESCE(activity.recent_favorite_count, 0) AS recent_favorite_count,
    p.public_id AS creator_public_id, COALESCE(NULLIF(p.display_name, ''), u.name) AS creator_name,
    COALESCE(p.avatar_data_url, u.profile_picture_URL) AS creator_avatar,
    EXISTS(SELECT 1 FROM topic_favorites f WHERE f.category_ID = c.ID AND f.user_ID = ? AND f.is_active = 1) AS is_favorited,
    (SELECT JSON_ARRAYAGG(own_pie.context_ID) FROM personal_pies own_pie
        JOIN ranking_contexts own_context ON own_context.ID = own_pie.context_ID
        WHERE own_pie.user_ID = ? AND own_context.category_ID = c.ID AND ${activeContext('own_context')} AND ${hasWeights('own_pie')}) AS configured_context_ids,
    (SELECT COUNT(DISTINCT pp.user_ID) FROM ranking_contexts rc JOIN personal_pies pp ON pp.context_ID = rc.ID
        JOIN users contributor ON contributor.ID = pp.user_ID
        WHERE rc.category_ID = c.ID AND ${activeContext('rc')} AND ${eligibleUser('contributor')} AND ${hasWeights('pp')}) AS configuration_count
    FROM categories c LEFT JOIN users u ON u.ID = c.created_by_user_ID AND u.deleted_at IS NULL
    LEFT JOIN user_public_profiles p ON p.user_ID = u.ID ${TOPIC_ACTIVITY_JOIN}`;

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
    let description;
    try { description = normalizeTopicSummary(body.description); }
    catch { fail(400, 'invalid_topic_description'); }
    return { name, description, isPrivate: body.isPrivate };
}

export function topicCreator(row) {
    if (Boolean(Number(row.is_official))) return null;
    const handle = row.creator_public_id ?? row.creator_handle ?? null;
    return { id: handle, handle, name: row.creator_name || 'Former contributor',
        avatarURL: row.creator_avatar || '/assets/benchpoll-mark.svg', url: handle ? `/@${encodeURIComponent(handle)}` : null };
}

function configuredIDs(value) {
    try { const IDs = typeof value === 'string' ? JSON.parse(value) : value; return Array.isArray(IDs) ? IDs.map(Number).filter(Number.isSafeInteger) : []; }
    catch { return []; }
}

export function serializeTopic(row, { viewerID = null } = {}) {
    const ID = Number(row.ID), isPrivate = row.owner_user_ID != null;
    const publicID = Number(row.public_ID), isMine = viewerID != null && String(row.created_by_user_ID ?? row.owner_user_ID) === String(viewerID);
    const privateID = row.private_ID;
    const url = topicURL({ publicID, privateID, isPrivate });
    const ownContexts = configuredIDs(row.configured_context_ids);
    return { ID, categoryID: ID, publicID, ...(isPrivate || isMine ? { privateID } : {}),
        name: row.name, categoryName: row.name, description: row.description ?? '', isPrivate, isMine,
        isOfficial: Boolean(Number(row.is_official)), hasWeights: Number(row.configuration_count ?? row.has_weights ?? 0) > 0,
        favoriteCount: Number(row.favorite_count ?? 0), isFavorited: Boolean(Number(row.is_favorited)),
        popularity: topicPopularity(row), configured: ownContexts.length > 0, configuredContextIDs: ownContexts,
        configurationCount: Number(row.configuration_count ?? 0), coverageIndex: null,
        url, path: url.slice(1), lineage: [{ ID, name: row.name, position: Number(row.position ?? 0) }], creator: topicCreator(row) };
}

export async function attachTopicScenes(db, topics) {
    const catalog = await loadTopicSceneCatalog(db, topics.map(topic => topic.ID));
    return topics.map(topic => {
        const entry = catalog.get(topic.ID);
        const configured = entry.scenes.find(scene => topic.configuredContextIDs.includes(scene.ID));
        const contextID = configured?.ID ?? (topic.configuredContextIDs.includes(entry.rootContextID) ? entry.rootContextID : null);
        return { ...topic, ...entry, hasScenes: entry.scenes.length > 0,
            configuredPersonalContext: contextID == null ? null : { contextID, name: configured?.name ?? topic.name,
                contextValues: configured ? { scene: String(contextID) } : {}, url: configured?.url ?? topic.url },
            contextValues: entry.scenes.length ? { scene: String(entry.defaultContextID) } : {} };
    });
}

export function searchTopicsAndScenes(topics, query) {
    if (!query.trim()) return topics;
    return searchTopicGroups(topics, query).map(({ topic, scenes }) => ({ ...topic,
        searchMatches: scenes.map(scene => ({ ...scene, kind: 'scene', topicName: topic.name })) }));
}

async function queryTopics(db, viewerID, where, parameters = []) {
    const viewer = canonicalAccountID(viewerID);
    const [rows] = await db.execute(`${topicSelect()} WHERE ${where}`, [viewer, viewer, ...parameters]);
    return attachTopicScenes(db, orderTopicsByPopularity(rows).map(row => serializeTopic(row, { viewerID: viewer })));
}

// Batch metadata for reference catalogues. Only authorized topics are returned;
// callers drop unavailable targets instead of retaining stale private metadata.
export async function loadTopicMetadata(db, userID, categoryIDs) {
    const IDs = [...new Set(categoryIDs.map(topicID))], owner = canonicalAccountID(userID);
    if (!IDs.length) return new Map();
    const topics = await queryTopics(db, owner, `c.ID IN (${IDs.map(() => '?').join(',')})
        AND c.is_active = 1 AND (c.owner_user_ID IS NULL OR c.owner_user_ID = ?)`, [...IDs, owner]);
    return new Map(topics.map(topic => [topic.ID, topic]));
}

export async function assertTopicAccess(db, userID, categoryIDs) {
    const IDs = [...new Set(categoryIDs.map(topicID))];
    if (!IDs.length) return;
    const [rows] = await db.execute(`SELECT ID FROM categories WHERE ID IN (${IDs.map(() => '?').join(',')})
        AND is_active = 1 AND (owner_user_ID IS NULL OR owner_user_ID = ?)`, [...IDs, canonicalAccountID(userID)]);
    if (rows.length !== IDs.length) fail(410, 'ranking_snapshot_expired');
}

export async function getTopic(db, userID, value) {
    const ID = topicID(value), owner = canonicalAccountID(userID);
    const topics = await queryTopics(db, owner, 'c.ID = ? AND c.is_active = 1 AND (c.owner_user_ID IS NULL OR c.owner_user_ID = ?)', [ID, owner]);
    if (topics.length !== 1) fail(404, 'topic_not_found');
    return topics[0];
}

export async function resolveTopicLocation(db, userID, request) {
    const keys = Object.keys(request ?? {});
    if (!request || Array.isArray(request) || keys.some(key => !['publicID', 'privateID', 'sceneNumber'].includes(key))
        || Number(Object.hasOwn(request, 'publicID')) + Number(Object.hasOwn(request, 'privateID')) !== 1) fail(400, 'invalid_topic_request');
    const owner = canonicalAccountID(userID);
    let topics;
    if (request.publicID !== undefined) {
        const publicID = topicID(request.publicID);
        // Even its owner cannot open a private topic using a retired public URL.
        topics = await queryTopics(db, owner, 'c.public_ID = ? AND c.owner_user_ID IS NULL AND c.is_active = 1', [publicID]);
    } else {
        if (typeof request.privateID !== 'string' || !/^[A-Za-z0-9]{12,64}$/.test(request.privateID)) fail(404, 'topic_not_found');
        topics = await queryTopics(db, owner, 'c.private_ID = ? AND c.is_active = 1 AND (c.owner_user_ID IS NULL OR c.owner_user_ID = ?)', [request.privateID, owner]);
    }
    if (topics.length !== 1) fail(404, 'topic_not_found');
    const topic = topics[0], number = request.sceneNumber == null ? null : topicID(request.sceneNumber);
    const scene = number == null ? topic.scenes[0] ?? null : topic.scenes.find(item => item.sceneNumber === number);
    if (number !== null && !scene) fail(404, 'topic_scene_not_found');
    return { topic, scene, path: scene?.url ?? topic.url };
}

export async function readTopicRequest(db, userID, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_topic_request');
    if (Object.hasOwn(body, 'categoryID')) {
        if (Object.keys(body).length !== 1) fail(400, 'invalid_topic_request');
        return getTopic(db, userID, body.categoryID);
    }
    const { topic, scene, path } = await resolveTopicLocation(db, userID, body);
    return { ...topic, selectedScene: scene, canonicalPath: path };
}

export async function listTopics(db, userID, body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => key !== 'query')) fail(400, 'invalid_topic_query');
    const query = body.query ?? '';
    if (typeof query !== 'string' || query.length > 128) fail(400, 'invalid_topic_query');
    const owner = canonicalAccountID(userID);
    const topics = await queryTopics(db, owner, 'c.is_active = 1 AND (c.owner_user_ID IS NULL OR c.owner_user_ID = ?)', [owner]);
    const featuredTopicID = topics.find(topic => topic.isOfficial && topic.name === 'Intelligence' && !topic.isPrivate)?.ID ?? null;
    return { topics: searchTopicsAndScenes(topics, query), featuredTopicID };
}

export async function readProfileTopics(db, { userID, viewerID = null, includeFavorites = false, includeConfigured = false }) {
    const owner = canonicalAccountID(userID);
    if (!owner) fail(404, 'profile_not_found');
    const visible = 'c.is_active = 1 AND c.owner_user_ID IS NULL';
    const published = await queryTopics(db, viewerID, `${visible} AND c.created_by_user_ID = ?`, [owner]);
    const result = { published };
    const isOwner = canonicalAccountID(viewerID) === owner;
    const collectionVisible = isOwner ? 'c.is_active = 1 AND (c.owner_user_ID IS NULL OR c.owner_user_ID = ?)' : visible;
    const parameters = isOwner ? [owner, owner] : [owner];
    if (includeFavorites) result.favorites = await queryTopics(db, viewerID, `${collectionVisible} AND EXISTS(SELECT 1 FROM topic_favorites own_favorite
        WHERE own_favorite.category_ID = c.ID AND own_favorite.user_ID = ? AND own_favorite.is_active = 1)`, parameters);
    if (includeConfigured) result.configured = await queryTopics(db, viewerID, `${collectionVisible} AND EXISTS(SELECT 1 FROM personal_pies own_pie
        JOIN ranking_contexts own_context ON own_context.ID = own_pie.context_ID
        WHERE own_context.category_ID = c.ID AND own_pie.user_ID = ? AND ${activeContext('own_context')} AND ${hasWeights('own_pie')})`, parameters);
    return result;
}

export async function assertPublicTopicCapacity(connection, owner, excludeID = 0) {
    // The caller holds the user's FOR UPDATE lock. Every publication path uses it.
    const [[count]] = await connection.execute(`SELECT COUNT(*) AS count FROM categories
        WHERE created_by_user_ID = ? AND owner_user_ID IS NULL AND is_active = 1 AND is_official = 0 AND ID <> ?`, [owner, excludeID]);
    if (Number(count.count) >= 3) fail(409, 'public_topic_limit');
}

export async function createTopic(db, userID, body) {
    const owner = canonicalAccountID(userID);
    if (!owner) fail(401, 'authentication_required');
    const topic = normalizeTopicRequest(body), connection = await db.getConnection();
    let ID;
    try {
        await startTransactionConnection(connection, 'CREATE TOPIC');
        await lockTopicReferenceGraph(connection);
        const [users] = await connection.execute(`SELECT ID FROM users WHERE ID = ? AND ${eligibleUser('users')} FOR UPDATE`, [owner]);
        if (!users.length) fail(401, 'authentication_required');
        const [[count]] = await connection.execute(`SELECT COUNT(*) AS count FROM categories
            WHERE created_by_user_ID = ? AND created_at >= NOW() - INTERVAL 1 DAY`, [owner]);
        if (Number(count.count) >= 20) fail(429, 'topic_creation_limit');
        if (!topic.isPrivate) await assertPublicTopicCapacity(connection, owner);
        const { publicID, privateID } = await allocateTopicIdentity(connection);
        const [result] = await connection.execute(`INSERT INTO categories
            (name, slug, description, owner_user_ID, created_by_user_ID, public_ID, private_ID, is_official, position)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`, [topic.name, topicSlug(topic.name), topic.description,
            topic.isPrivate ? owner : null, owner, publicID, privateID]);
        ID = Number(result.insertId);
        await connection.execute(`INSERT INTO ranking_contexts (category_ID, context_values, context_hash) VALUES (?, '{}', ?)`, [ID, emptyHash]);
        await commitTransactionConnection(connection, 'CREATE TOPIC');
    } catch (error) {
        await rollbackTransactionConnection(connection, 'CREATE TOPIC', error);
        if (error.code === 'ER_DUP_ENTRY') fail(409, 'topic_name_exists');
        throw error;
    } finally { releaseTransactionConnection(connection, 'CREATE TOPIC'); }
    return getTopic(db, owner, ID);
}

export async function assertPublicTopicAvailable(connection, topic, excludeID = 0) {
    const slug = topicSlug(topic.name);
    const [existing] = await connection.execute(`SELECT ID FROM categories
        WHERE owner_user_ID IS NULL AND (slug = ? OR name = ?) AND ID <> ? LIMIT 1`, [slug, topic.name, excludeID]);
    if (existing.length) fail(409, 'topic_name_exists');
    return slug;
}
