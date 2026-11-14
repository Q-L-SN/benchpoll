import { createHash, randomUUID } from 'node:crypto';
import { canonicalAccountID } from './public/js/shared/account-identity.js';
import { topicSlug, sceneSlug } from './public/js/shared/topics.js';
import { normalizeTopicRequest, topicID, assertPublicTopicCapacity, assertPublicTopicAvailable, getTopic } from './topic-service.js';
import { loadTopicSceneCatalog, normalizeTopicSceneRequest, lockTopicReferenceGraph,
    ensureTopicRootContext, insertTopicScene, EMPTY_TOPIC_CONTEXT_HASH } from './topic-scenes-service.js';
import { allocateTopicIdentity } from './topic-platform-schema.js';
import { claimWriteIntent, completeWriteIntent } from './write-idempotency.js';
import { startTransactionConnection, commitTransactionConnection, rollbackTransactionConnection,
    releaseTransactionConnection } from './db-transaction.js';

const fail = (status, error) => { throw { status, body: { error } }; };
const account = value => canonicalAccountID(value) || fail(401, 'authentication_required');
const record = (value, keys) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !keys.includes(key))) fail(400, 'invalid_private_topic_request');
};
const expectedVersion = value => {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(400, 'private_topic_revision_required');
    return value;
};

export function privateTopicRevision(topic, scenes) {
    return createHash('sha256').update(JSON.stringify([topic.name, topic.description, topic.owner_user_ID == null,
        scenes.map(scene => [scene.ID, scene.name, scene.position, scene.isDefault])])).digest('hex');
}

export function normalizePrivateTopicEdit(body) {
    record(body, ['categoryID', 'expectedRevision', 'name', 'description', 'scenes', 'defaultSceneKey']);
    const metadata = normalizeTopicRequest({ name: body.name, description: body.description, isPrivate: true });
    const categoryID = body.categoryID == null ? null : topicID(body.categoryID);
    const expectedRevision = categoryID === null ? null : expectedVersion(body.expectedRevision);
    if (categoryID === null && body.expectedRevision != null) fail(400, 'invalid_private_topic_request');
    if (!Array.isArray(body.scenes) || body.scenes.length > 512) fail(400, 'invalid_topic_scene_list');
    const seenKeys = new Set(), seenNames = new Set(), seenSlugs = new Set(), seenIDs = new Set();
    const scenes = body.scenes.map(item => {
        record(item, ['key', 'ID', 'name']);
        if (typeof item.key !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(item.key) || seenKeys.has(item.key)) fail(400, 'invalid_scene_key');
        const ID = item.ID == null ? null : topicID(item.ID);
        if (ID !== null && (categoryID === null || seenIDs.has(ID))) fail(400, 'invalid_scene_id');
        const normalized = normalizeTopicSceneRequest({ categoryID: categoryID ?? 1, name: item.name });
        const nameKey = normalized.name.toLocaleLowerCase(), slug = sceneSlug(normalized.name);
        if (seenNames.has(nameKey) || seenSlugs.has(slug)) fail(409, 'topic_scene_exists');
        seenKeys.add(item.key); seenNames.add(nameKey); seenSlugs.add(slug); if (ID !== null) seenIDs.add(ID);
        return { key: item.key, ID, name: normalized.name };
    });
    if (scenes.length ? !seenKeys.has(body.defaultSceneKey) : body.defaultSceneKey != null) fail(400, 'topic_scene_default_required');
    return { categoryID, expectedRevision, name: metadata.name, description: metadata.description,
        scenes, defaultSceneKey: body.defaultSceneKey ?? null };
}

async function privateRow(connection, owner, ID, lock = false) {
    const [rows] = await connection.execute(`SELECT ID, name, slug, description, owner_user_ID, created_by_user_ID, public_ID, private_ID, is_official,
        is_active FROM categories WHERE ID = ? AND created_by_user_ID = ? AND is_official = 0 AND is_active = 1${lock ? ' FOR UPDATE' : ''}`, [ID, owner]);
    if (rows.length !== 1) fail(404, 'private_topic_not_found');
    return rows[0];
}

export async function readPrivateTopicEditor(db, userID, body) {
    record(body, ['categoryID']);
    const owner = account(userID), ID = topicID(body.categoryID);
    return editorResult(db, await privateRow(db, owner, ID));
}

async function editorResult(connection, row) {
    const topic = await getTopic(connection, row.created_by_user_ID, Number(row.ID));
    return { ...topic, isMine: true, editRevision: privateTopicRevision(row, topic.scenes) };
}

export async function privateTopicTransaction(db, userID, key, action, payload, operation) {
    const owner = account(userID), connection = await db.getConnection();
    try {
        await startTransactionConnection(connection, 'PRIVATE TOPIC');
        await lockTopicReferenceGraph(connection);
        const [users] = await connection.execute(`SELECT ID FROM users WHERE ID = ? AND deleted_at IS NULL
            AND (banned_at IS NULL OR (banned_until IS NOT NULL AND banned_until <= NOW())) FOR UPDATE`, [owner]);
        if (users.length !== 1) fail(401, 'authentication_required');
        const intent = await claimWriteIntent(connection, { userID: owner, key, action, payload });
        const result = intent.response?.body ?? await operation(connection, owner);
        if (!intent.response) await completeWriteIntent(connection, intent, { status: 200, body: result });
        await commitTransactionConnection(connection, 'PRIVATE TOPIC');
        return result;
    } catch (error) {
        await rollbackTransactionConnection(connection, 'PRIVATE TOPIC', error);
        if (error.code === 'ER_DUP_ENTRY') fail(409, 'topic_name_or_scene_exists');
        throw error;
    } finally { releaseTransactionConnection(connection, 'PRIVATE TOPIC'); }
}

export async function insertPrivateTopic(connection, owner, metadata) {
    const [[count]] = await connection.execute(`SELECT COUNT(*) AS count FROM categories
        WHERE created_by_user_ID = ? AND created_at >= NOW() - INTERVAL 1 DAY`, [owner]);
    if (Number(count.count) >= 20) fail(429, 'topic_creation_limit');
    const { publicID, privateID } = await allocateTopicIdentity(connection);
    const [inserted] = await connection.execute(`INSERT INTO categories
        (name, slug, description, owner_user_ID, created_by_user_ID, public_ID, private_ID, is_official, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`, [metadata.name, topicSlug(metadata.name), metadata.description, owner, owner, publicID, privateID]);
    const ID = Number(inserted.insertId);
    await ensureTopicRootContext(connection, ID);
    return { ID, name: metadata.name, slug: topicSlug(metadata.name), description: metadata.description,
        owner_user_ID: owner, created_by_user_ID: owner, public_ID: publicID, private_ID: privateID, is_official: 0, is_active: 1 };
}

// The graph lock prevents pie saves and concurrent reference/scene edits from racing this replacement.
export async function replacePrivateScenes(connection, topic, previous, request) {
    const IDs = new Set(previous.scenes.map(scene => scene.ID));
    if (request.scenes.some(scene => scene.ID !== null && !IDs.has(scene.ID))) fail(404, 'topic_scene_not_found');
    const rootID = previous.defaultContextID ?? await ensureTopicRootContext(connection, Number(topic.ID));
    const retained = new Set(request.scenes.filter(scene => scene.ID !== null).map(scene => scene.ID));
    if (!request.scenes.length || !previous.scenes.length) retained.add(rootID);
    // Keep ranking contexts as unavailable reference identities, but remove deleted scene configurations.
    for (const scene of previous.scenes) if (!retained.has(scene.ID)) {
        await connection.execute('DELETE FROM personal_pies WHERE context_ID = ?', [scene.ID]);
    }
    await connection.execute('DELETE FROM topic_scenes WHERE category_ID = ?', [Number(topic.ID)]);
    if (!request.scenes.length) {
        await connection.execute(`UPDATE ranking_contexts SET context_values = ?, context_hash = ?, updated_at = updated_at
            WHERE ID = ? AND category_ID = ?`, ['{}', EMPTY_TOPIC_CONTEXT_HASH, rootID, Number(topic.ID)]);
        return;
    }
    for (const [position, scene] of request.scenes.entries()) {
        const isDefault = scene.key === request.defaultSceneKey;
        const old = previous.scenes.find(item => item.ID === scene.ID);
        const contextID = scene.ID ?? (!previous.scenes.length && isDefault ? rootID : null);
        await insertTopicScene(connection, Number(topic.ID), { ...scene, isDefault },
            { contextID, sceneNumber: old?.sceneNumber ?? null, legacyValues: old?.legacyContextValues ?? (contextID === rootID && !previous.scenes.length ? {} : null), position });
    }
}

export async function savePrivateTopic(db, userID, body, key) {
    const request = normalizePrivateTopicEdit(body);
    return privateTopicTransaction(db, userID, key, 'save_private_topic', request, async (connection, owner) => {
        const topic = request.categoryID === null ? await insertPrivateTopic(connection, owner, request)
            : await privateRow(connection, owner, request.categoryID, true);
        const catalog = (await loadTopicSceneCatalog(connection, [Number(topic.ID)])).get(Number(topic.ID));
        if (request.categoryID !== null && privateTopicRevision(topic, catalog.scenes) !== request.expectedRevision) fail(409, 'private_topic_changed');
        await replacePrivateScenes(connection, topic, catalog, request);
        await connection.execute('UPDATE categories SET name = ?, slug = ?, description = ? WHERE ID = ? AND created_by_user_ID = ?',
            [request.name, topicSlug(request.name), request.description, Number(topic.ID), owner]);
        return editorResult(connection, { ...topic, name: request.name, slug: topicSlug(request.name), description: request.description });
    });
}

export async function deletePrivateTopic(db, userID, body, key) {
    record(body, ['categoryID', 'expectedRevision']);
    const request = { categoryID: topicID(body.categoryID), expectedRevision: expectedVersion(body.expectedRevision) };
    return privateTopicTransaction(db, userID, key, 'delete_private_topic', request, async (connection, owner) => {
        const topic = await privateRow(connection, owner, request.categoryID, true);
        const current = await editorResult(connection, topic);
        if (current.editRevision !== request.expectedRevision) fail(409, 'private_topic_changed');
        if (topic.owner_user_ID == null) fail(409, 'make_topic_private_before_deleting');
        await connection.execute(`DELETE p FROM personal_pies p JOIN ranking_contexts rc ON rc.ID = p.context_ID
            WHERE rc.category_ID = ?`, [request.categoryID]);
        await connection.execute('DELETE FROM topic_scenes WHERE category_ID = ?', [request.categoryID]);
        await connection.execute(`UPDATE categories SET is_active = 0, name = ?, slug = ?, description = '', notes = NULL
            WHERE ID = ? AND owner_user_ID = ?`, ['Deleted private topic ' + randomUUID(), 'deleted-private-' + request.categoryID, request.categoryID, owner]);
        return { categoryID: request.categoryID, deleted: true };
    });
}

export async function setTopicVisibility(db, userID, body, key) {
    record(body, ['categoryID', 'isPublic', 'expectedRevision']);
    if (typeof body.isPublic !== 'boolean') fail(400, 'invalid_topic_visibility');
    const request = { categoryID: topicID(body.categoryID), isPublic: body.isPublic,
        ...(body.expectedRevision === undefined ? {} : { expectedRevision: expectedVersion(body.expectedRevision) }) };
    return privateTopicTransaction(db, userID, key, 'set_topic_visibility', request, async (connection, owner) => {
        const topic = await privateRow(connection, owner, request.categoryID, true);
        const current = await editorResult(connection, topic);
        if (request.expectedRevision && current.editRevision !== request.expectedRevision) fail(409, 'private_topic_changed');
        if (request.isPublic === (topic.owner_user_ID == null)) return current;
        if (request.isPublic) {
            await assertPublicTopicCapacity(connection, owner, request.categoryID);
            await assertPublicTopicAvailable(connection, topic, request.categoryID);
            // A publication may contain cycles, but no public composition may
            // disclose another private topic or its saved weights.
            const [privateTargets] = await connection.execute(`SELECT target.ID FROM personal_pie_topic_weights w
                JOIN personal_pies p ON p.ID = w.pie_ID JOIN ranking_contexts source ON source.ID = p.context_ID
                JOIN ranking_contexts destination ON destination.ID = w.target_context_ID
                JOIN categories target ON target.ID = destination.category_ID
                WHERE source.category_ID = ? AND target.owner_user_ID IS NOT NULL AND target.ID <> ? LIMIT 1`,
                [request.categoryID, request.categoryID]);
            if (privateTargets.length) fail(409, 'private_topic_reference_not_public');
        }
        await connection.execute('UPDATE categories SET owner_user_ID = ? WHERE ID = ? AND created_by_user_ID = ?',
            [request.isPublic ? null : owner, request.categoryID, owner]);
        return { ...await getTopic(connection, owner, request.categoryID),
            editRevision: privateTopicRevision({ ...topic, owner_user_ID: request.isPublic ? null : owner }, current.scenes) };
    });
}

export async function setTopicFavorite(db, userID, body, key) {
    record(body, ['categoryID', 'isFavorited']);
    if (typeof body.isFavorited !== 'boolean') fail(400, 'invalid_topic_favorite');
    const request = { categoryID: topicID(body.categoryID), isFavorited: body.isFavorited };
    return privateTopicTransaction(db, userID, key, 'set_topic_favorite', request, async (connection, owner) => {
        const [topics] = await connection.execute(`SELECT ID FROM categories WHERE ID = ? AND is_active = 1
            AND (owner_user_ID IS NULL OR owner_user_ID = ?) FOR UPDATE`, [request.categoryID, owner]);
        if (topics.length !== 1) fail(404, 'topic_not_found');
        if (request.isFavorited) await connection.execute(`INSERT INTO topic_favorites (category_ID, user_ID, is_active) VALUES (?, ?, 1)
            ON DUPLICATE KEY UPDATE is_active = 1`, [request.categoryID, owner]);
        else await connection.execute('UPDATE topic_favorites SET is_active = 0 WHERE category_ID = ? AND user_ID = ?', [request.categoryID, owner]);
        const [[count]] = await connection.execute(`SELECT COUNT(*) AS count FROM topic_favorites f JOIN users u ON u.ID = f.user_ID
            WHERE f.category_ID = ? AND f.is_active = 1 AND u.deleted_at IS NULL
                AND (u.banned_at IS NULL OR (u.banned_until IS NOT NULL AND u.banned_until <= NOW()))`, [request.categoryID]);
        return { categoryID: request.categoryID, isFavorited: request.isFavorited, favoriteCount: Number(count.count) };
    });
}
