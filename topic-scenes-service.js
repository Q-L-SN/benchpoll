import { createHash, randomUUID } from 'node:crypto';
import { canonicalAccountID } from './public/js/shared/account-identity.js';
import { topicSlug, topicURL, normalizeTopicSummary, scenePath, sceneSlug } from './public/js/shared/topics.js';
import { claimWriteIntent, completeWriteIntent } from './write-idempotency.js';
import { startTransactionConnection, commitTransactionConnection, rollbackTransactionConnection,
    releaseTransactionConnection } from './db-transaction.js';

const fail = (status, error, extra = {}) => { throw { status, body: { error, ...extra } }; };
export const EMPTY_TOPIC_CONTEXT_HASH = createHash('sha256').update('{}').digest('hex');
// Only the server's non-writing SQL recorder receives this non-JSON capability.
export const TOPIC_SCENE_SQL_PREVIEW = Symbol('topic_scene_sql_preview');

export function sceneIdentity(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail(400, 'invalid_scene_id');
    return value;
}

export function sceneContext(contextID) {
    const ID = sceneIdentity(contextID), contextValues = { scene: String(ID) };
    const serialized = JSON.stringify(contextValues);
    return { ID, contextValues, serialized, contextHash: createHash('sha256').update(serialized).digest('hex') };
}

function valuesRecord(value) {
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { fail(400, 'invalid_context_values'); }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.values(value).some(item => typeof item !== 'string')) fail(400, 'invalid_context_values');
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
}

function sceneURLSlug(scene) {
    const slug = scene.slug || sceneSlug(scene.name);
    // Preserve the stored 80-character prefix so the alias cannot collide with a shorter valid slug.
    return slug.length === 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*-$/.test(slug) ? `${slug}scene` : slug;
}

export function topicSceneURL(topic, scene) {
    const ID = sceneIdentity(Number(topic.categoryID ?? topic.ID));
    const base = topicURL(ID, topic.categoryName ?? topic.name, topic.isPrivate === true || topic.owner_user_ID != null,
        topic.slug || topicSlug(topic.categoryName ?? topic.name));
    const path = scenePath(base, scene && { ...scene, slug: sceneURLSlug(scene) });
    if (!path) fail(400, 'invalid_scene_path');
    return path;
}

export function serializeTopicScene(row, topic = null) {
    const ID = sceneIdentity(Number(row.context_ID ?? row.contextID ?? row.ID));
    const categoryID = sceneIdentity(Number(row.category_ID ?? row.categoryID));
    const legacy = row.legacy_context_values == null ? null : valuesRecord(row.legacy_context_values);
    const scene = { ID, contextID: ID, sceneID: ID, categoryID, name: row.name, slug: sceneURLSlug(row),
        description: row.description ?? '', position: Number(row.position ?? 0),
        isDefault: Boolean(Number(row.is_default)), isActive: row.is_active == null || Boolean(Number(row.is_active)),
        ...sceneContext(ID), legacyContextValues: legacy };
    if (topic) scene.url = topicSceneURL(topic, scene);
    return scene;
}

export function orderTopicScenes(scenes) {
    if (scenes.length && scenes.filter(scene => scene.isDefault).length !== 1) fail(409, 'topic_scene_default_invalid');
    return [...scenes].sort((a, b) => Number(b.isDefault) - Number(a.isDefault)
        || a.position - b.position || a.ID - b.ID);
}

// A single batched read supplies both scene discovery and root identities, without calculating rankings.
export async function loadTopicSceneCatalog(db, categoryIDs) {
    const IDs = [...new Set(categoryIDs.map(sceneIdentity))];
    if (!IDs.length) return new Map();
    const [rows] = await db.execute(`SELECT rc.ID AS contextID, rc.category_ID, rc.context_hash,
        s.context_ID AS scene_context_ID, s.name, s.slug, s.description, s.position,
        s.is_default, s.is_active, s.legacy_context_values,
        c.name AS category_name, c.slug AS category_slug, c.owner_user_ID
        FROM ranking_contexts rc JOIN categories c ON c.ID = rc.category_ID
        LEFT JOIN topic_scenes s ON s.context_ID = rc.ID AND s.category_ID = rc.category_ID
        WHERE rc.category_ID IN (${IDs.map(() => '?').join(', ')})
          AND (s.is_active = 1 OR (s.context_ID IS NULL AND rc.context_hash = ?))
        ORDER BY rc.category_ID, s.is_default DESC, s.position, rc.ID`, [...IDs, EMPTY_TOPIC_CONTEXT_HASH]);
    const catalog = new Map(IDs.map(ID => [ID, { scenes: [], rootContextID: null, defaultContextID: null }]));
    for (const row of rows) {
        const entry = catalog.get(Number(row.category_ID));
        if (!entry) fail(409, 'topic_scene_category_mismatch');
        if (row.scene_context_ID != null) {
            const scene = serializeTopicScene({ ...row, context_ID: row.scene_context_ID },
                { ID: Number(row.category_ID), name: row.category_name, slug: row.category_slug, owner_user_ID: row.owner_user_ID });
            entry.scenes.push(scene);
        } else {
            if (entry.rootContextID !== null) fail(409, 'topic_root_context_invalid');
            entry.rootContextID = sceneIdentity(Number(row.contextID));
        }
    }
    for (const entry of catalog.values()) {
        entry.scenes = orderTopicScenes(entry.scenes);
        entry.defaultContextID = entry.scenes[0]?.ID ?? entry.rootContextID;
        // A topic with scenes has no separate configurable umbrella context.
        if (entry.scenes.length) entry.rootContextID = entry.defaultContextID;
    }
    return catalog;
}

export async function loadTopicScenes(db, categoryID) {
    return (await loadTopicSceneCatalog(db, [sceneIdentity(categoryID)])).get(categoryID).scenes;
}

export async function resolveTopicScene(db, category, contextValues = {}, opts = {}) {
    const categoryID = sceneIdentity(Number(category.ID ?? category.categoryID));
    if (typeof contextValues === 'string') fail(400, 'invalid_context_values');
    const values = valuesRecord(contextValues);
    const scenes = orderTopicScenes(opts.scenes ?? await loadTopicScenes(db, categoryID));
    let requestedID = opts.contextID == null ? null : sceneIdentity(opts.contextID);
    if ('scene' in values) {
        if (Object.keys(values).length !== 1 || !/^[1-9]\d*$/.test(values.scene)) fail(400, 'invalid_scene_context');
        const ID = sceneIdentity(Number(values.scene));
        if (requestedID !== null && requestedID !== ID) fail(409, 'ranking_context_values_mismatch');
        requestedID = ID;
    }
    if (!scenes.length) {
        if (Object.keys(values).length) fail(404, 'topic_scene_not_found');
        if (requestedID !== null) {
            const [roots] = await db.execute(`SELECT ID FROM ranking_contexts WHERE ID = ? AND category_ID = ? AND context_hash = ?`,
                [requestedID, categoryID, EMPTY_TOPIC_CONTEXT_HASH]);
            if (roots.length !== 1) fail(404, 'topic_scene_not_found');
        }
        return null;
    }
    let scene;
    if (requestedID !== null) scene = scenes.find(item => item.ID === requestedID);
    else if (!Object.keys(values).length) {
        if (opts.requireExplicit || opts.forReference || opts.requireAllDimensions) fail(400, 'topic_scene_required', { categoryID });
        scene = scenes[0];
    } else if (opts.allowLegacy !== false && !opts.requireExplicit && !opts.forReference) {
        const serialized = JSON.stringify(values);
        scene = scenes.find(item => item.legacyContextValues !== null
            && JSON.stringify(valuesRecord(item.legacyContextValues)) === serialized);
    }
    if (!scene || Number(scene.categoryID) !== categoryID) fail(404, 'topic_scene_not_found');
    if (requestedID !== null && Object.keys(values).length && !('scene' in values)
        && JSON.stringify(valuesRecord(scene.legacyContextValues ?? {})) !== JSON.stringify(values)) {
        fail(409, 'ranking_context_values_mismatch');
    }
    return { ...sceneContext(scene.ID), categoryID, sceneID: scene.ID, scene,
        contextDisplayValues: { scene: scene.name }, dimensions: [], scenes,
        defaultContextID: scenes[0].ID, rootContextID: scenes[0].ID };
}

export function normalizeTopicSceneRequest(body, { update = false } = {}) {
    const allowed = ['categoryID', 'name', 'description', 'isDefault', ...(update ? ['sceneID', 'position'] : [])];
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'invalid_topic_scene_request');
    const categoryID = sceneIdentity(body.categoryID);
    const name = typeof body.name === 'string' ? body.name.trim().normalize('NFC') : '';
    if (!name || [...name].length > 128 || /[\p{Cc}\p{Cf}]/u.test(name)) fail(400, 'invalid_scene_name');
    let description;
    try { description = normalizeTopicSummary(body.description); } catch { fail(400, 'invalid_scene_description'); }
    if (body.isDefault !== undefined && typeof body.isDefault !== 'boolean') fail(400, 'invalid_scene_default');
    if (body.position !== undefined && (!Number.isSafeInteger(body.position) || body.position < 0 || body.position > 1000000)) {
        fail(400, 'invalid_scene_position');
    }
    return { categoryID, name, description, isDefault: body.isDefault,
        ...(update ? { sceneID: sceneIdentity(body.sceneID), position: body.position } : {}) };
}

export async function lockTopicReferenceGraph(connection) {
    const [rows] = await connection.execute('SELECT ID FROM topic_reference_lock WHERE ID = 1 FOR UPDATE');
    if (rows.length !== 1) fail(503, 'topic_reference_schema_required');
}

export async function ensureTopicRootContext(connection, categoryID) {
    sceneIdentity(categoryID);
    const [existing] = await connection.execute(`SELECT ID FROM ranking_contexts
        WHERE category_ID = ? AND context_hash = ? FOR SHARE`, [categoryID, EMPTY_TOPIC_CONTEXT_HASH]);
    if (existing.length === 1) return sceneIdentity(Number(existing[0].ID));
    const [inserted] = await connection.execute(`INSERT INTO ranking_contexts (category_ID, context_values, context_hash)
        VALUES (?, '{}', ?) ON DUPLICATE KEY UPDATE ID = LAST_INSERT_ID(ID)`, [categoryID, EMPTY_TOPIC_CONTEXT_HASH]);
    if (connection[TOPIC_SCENE_SQL_PREVIEW] === true && Number.isSafeInteger(inserted.insertId) && inserted.insertId < 0) return inserted.insertId;
    if (Number(inserted.insertId) < 0) fail(409, 'invalid_topic_context_insert');
    const [rows] = await connection.execute(`SELECT ID FROM ranking_contexts
        WHERE category_ID = ? AND context_hash = ? FOR SHARE`, [categoryID, EMPTY_TOPIC_CONTEXT_HASH]);
    if (rows.length !== 1) fail(409, 'topic_root_context_invalid');
    return sceneIdentity(Number(rows[0].ID));
}

export async function assertPublicSceneAvailable(connection, categoryID, name, { excludeSceneID = null, lock = false } = {}) {
    sceneIdentity(categoryID);
    const [topics] = await connection.execute(`SELECT ID, name, slug, description, owner_user_ID FROM categories
        WHERE ID = ? AND is_active = 1 AND owner_user_ID IS NULL${lock ? ' FOR UPDATE' : ''}`, [categoryID]);
    if (topics.length !== 1) fail(404, 'topic_not_found');
    const slug = sceneSlug(name);
    const [existing] = await connection.execute(`SELECT context_ID FROM topic_scenes
        WHERE category_ID = ? AND (slug = ? OR name = ?)${excludeSceneID === null ? '' : ' AND context_ID <> ?'} LIMIT 1`,
    [categoryID, slug, name, ...(excludeSceneID === null ? [] : [excludeSceneID])]);
    if (existing.length) fail(409, 'topic_scene_exists');
    return { topic: topics[0], slug };
}

export async function insertTopicScene(connection, categoryID, request, { contextID = null, legacyValues = null, position = 10 } = {}) {
    if (contextID === null) {
        const pending = JSON.stringify({ pendingScene: randomUUID() });
        const [inserted] = await connection.execute(`INSERT INTO ranking_contexts (category_ID, context_values, context_hash)
            VALUES (?, ?, ?)`, [categoryID, pending, createHash('sha256').update(pending).digest('hex')]);
        contextID = Number(inserted.insertId);
    }
    // The existing read-only moderation SQL recorder supplies negative IDs for simulated INSERTs.
    const synthetic = connection[TOPIC_SCENE_SQL_PREVIEW] === true && Number.isSafeInteger(contextID) && contextID < 0;
    const serialized = JSON.stringify({ scene: String(contextID) });
    const context = synthetic ? { serialized, contextHash: createHash('sha256').update(serialized).digest('hex') } : sceneContext(contextID);
    await connection.execute(`UPDATE ranking_contexts SET context_values = ?, context_hash = ?, updated_at = updated_at
        WHERE ID = ? AND category_ID = ?`, [context.serialized, context.contextHash, contextID, categoryID]);
    await connection.execute(`INSERT INTO topic_scenes
        (context_ID, category_ID, name, slug, description, position, is_default, is_active, legacy_context_values)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`, [contextID, categoryID, request.name, sceneSlug(request.name),
        request.description, position, Number(request.isDefault === true), legacyValues === null ? null : JSON.stringify(legacyValues)]);
    return contextID;
}

// The caller must hold the graph/category lock inside the same transaction.
export async function addTopicSceneInTransaction(connection, topic, request) {
    const categoryID = sceneIdentity(Number(topic.ID));
    let scenes = await loadTopicScenes(connection, categoryID);
    if (scenes.length >= 512) fail(409, 'topic_scene_limit');
    if (!scenes.length) {
        const rootID = await ensureTopicRootContext(connection, categoryID);
        if (topicSlug(request.name) === 'general') {
            await insertTopicScene(connection, categoryID, { ...request, isDefault: true },
                { contextID: rootID, legacyValues: {}, position: 0 });
            return { contextID: rootID, sceneID: rootID, categoryID };
        }
        await insertTopicScene(connection, categoryID, { name: 'General', description: topic.description,
            isDefault: true }, { contextID: rootID, legacyValues: {}, position: 0 });
        scenes = [{ ID: rootID, position: 0, isDefault: true }];
    }
    if (request.isDefault) await connection.execute('UPDATE topic_scenes SET is_default = 0 WHERE category_ID = ? AND is_default = 1', [categoryID]);
    const contextID = await insertTopicScene(connection, categoryID, request,
        { position: Math.max(0, ...scenes.map(scene => scene.position)) + 10 });
    return { contextID, sceneID: contextID, categoryID };
}

async function privateSceneWrite(db, userID, body, key, action, operation) {
    const owner = canonicalAccountID(userID);
    if (!owner) fail(401, 'authentication_required');
    const connection = await db.getConnection();
    try {
        await startTransactionConnection(connection, 'TOPIC SCENE');
        await lockTopicReferenceGraph(connection);
        const [users] = await connection.execute(`SELECT ID FROM users WHERE ID = ? AND deleted_at IS NULL
            AND (banned_at IS NULL OR (banned_until IS NOT NULL AND banned_until <= NOW())) FOR UPDATE`, [owner]);
        if (!users.length) fail(401, 'authentication_required');
        const [topics] = await connection.execute(`SELECT ID, name, slug, description, owner_user_ID FROM categories
            WHERE ID = ? AND is_active = 1 AND owner_user_ID = ? FOR UPDATE`, [body.categoryID, owner]);
        if (!topics.length) fail(404, 'private_topic_not_found');
        const intent = key == null ? null : await claimWriteIntent(connection, { userID: owner, key, action, payload: body });
        const identity = intent?.response ? intent.response.body : await operation(connection, topics[0]);
        const scenes = await loadTopicScenes(connection, body.categoryID);
        const result = { ...identity, scene: scenes.find(scene => scene.ID === identity.sceneID), scenes,
            defaultContextID: scenes[0].ID, rootContextID: scenes[0].ID };
        if (intent && !intent.response) await completeWriteIntent(connection, intent, { status: 200, body: result });
        await commitTransactionConnection(connection, 'TOPIC SCENE');
        return result;
    } catch (error) {
        await rollbackTransactionConnection(connection, 'TOPIC SCENE', error);
        if (error.code === 'ER_DUP_ENTRY') fail(409, 'topic_scene_exists');
        throw error;
    } finally { releaseTransactionConnection(connection, 'TOPIC SCENE'); }
}

export async function createPrivateTopicScene(db, userID, body, key = null) {
    const request = normalizeTopicSceneRequest(body);
    return privateSceneWrite(db, userID, request, key, 'create_topic_scene', (connection, topic) =>
        addTopicSceneInTransaction(connection, topic, request));
}

export async function updatePrivateTopicScene(db, userID, body, key = null) {
    const request = normalizeTopicSceneRequest(body, { update: true });
    return privateSceneWrite(db, userID, request, key, 'update_topic_scene', async connection => {
        const scenes = await loadTopicScenes(connection, request.categoryID);
        const scene = scenes.find(item => item.ID === request.sceneID);
        if (!scene) fail(404, 'topic_scene_not_found');
        if (scene.isDefault && request.isDefault === false) fail(409, 'topic_scene_default_required');
        if (request.isDefault) await connection.execute('UPDATE topic_scenes SET is_default = 0 WHERE category_ID = ? AND is_default = 1', [request.categoryID]);
        await connection.execute(`UPDATE topic_scenes SET name = ?, slug = ?, description = ?, position = ?, is_default = ?
            WHERE context_ID = ? AND category_ID = ? AND is_active = 1`,
        [request.name, sceneSlug(request.name), request.description, request.position ?? scene.position,
            Number(request.isDefault ?? scene.isDefault), scene.ID, request.categoryID]);
        return { sceneID: scene.ID, contextID: scene.ID, categoryID: request.categoryID };
    });
}

export async function setPrivateTopicDefaultScene(db, userID, body, key = null) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(name => !['categoryID', 'sceneID'].includes(name))) fail(400, 'invalid_topic_scene_request');
    const request = { categoryID: sceneIdentity(body.categoryID), sceneID: sceneIdentity(body.sceneID) };
    return privateSceneWrite(db, userID, request, key, 'set_default_topic_scene', async connection => {
        const scenes = await loadTopicScenes(connection, request.categoryID);
        if (!scenes.some(scene => scene.ID === request.sceneID)) fail(404, 'topic_scene_not_found');
        await connection.execute('UPDATE topic_scenes SET is_default = 0 WHERE category_ID = ? AND is_default = 1', [request.categoryID]);
        await connection.execute('UPDATE topic_scenes SET is_default = 1 WHERE context_ID = ? AND category_ID = ? AND is_active = 1',
            [request.sceneID, request.categoryID]);
        return { ...request, contextID: request.sceneID };
    });
}
