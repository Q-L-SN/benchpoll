import { canonicalAccountID } from './public/js/shared/account-identity.js';

const fail = (status, error) => { throw Object.assign(new Error(error), { status, body: { error } }); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function visitMetadata(topic, contextID) {
    const scenes = topic.scenes ?? [];
    if (scenes.length) {
        const scene = scenes.find(scene => Number(scene.contextID ?? scene.ID) === contextID);
        if (!scene) fail(404, 'profile_visit_unavailable');
        return { categoryID: topic.ID, contextID, name: topic.name, sceneName: scene.name, url: scene.url, isPrivate: topic.isPrivate === true };
    }
    if (Number(topic.rootContextID ?? topic.defaultContextID) !== contextID) fail(404, 'profile_visit_unavailable');
    return { categoryID: topic.ID, contextID, name: topic.name, sceneName: null, url: topic.url, isPrivate: topic.isPrivate === true };
}

export async function recordProfileVisit(db, rawUserID, body, getTopic) {
    const userID = canonicalAccountID(rawUserID);
    if (!userID) fail(401, 'authentication_required');
    if (!object(body) || Object.keys(body).some(key => !['categoryID', 'contextID'].includes(key))
        || !positive(body.categoryID) || (body.contextID != null && !positive(body.contextID))) fail(400, 'profile_visit_invalid');
    const topic = await getTopic(db, userID, body.categoryID);
    const contextID = body.contextID ?? Number(topic.defaultContextID ?? topic.rootContextID);
    if (!positive(contextID)) fail(404, 'profile_visit_unavailable');
    visitMetadata(topic, contextID);
    await db.execute(`INSERT INTO user_profile_visits (user_ID, category_ID, context_ID, visited_at)
        SELECT ID, ?, ?, NOW(3) FROM users WHERE ID = ? AND deleted_at IS NULL
            AND (banned_at IS NULL OR banned_until <= NOW())
        ON DUPLICATE KEY UPDATE visited_at = NOW(3), category_ID = VALUES(category_ID)`, [body.categoryID, contextID, userID]);
    return { recorded: true };
}

export async function loadProfileHistory(db, rawUserID, body = {}, getTopic) {
    const userID = canonicalAccountID(rawUserID);
    if (!userID) fail(401, 'authentication_required');
    if (!object(body) || Object.keys(body).some(key => key !== 'offset')
        || (body.offset !== undefined && (!Number.isSafeInteger(body.offset) || body.offset < 0 || body.offset > 10000))) fail(400, 'profile_history_query_invalid');
    const offset = body.offset ?? 0;
    const [rows] = await db.execute(`SELECT category_ID AS categoryID, context_ID AS contextID, visited_at AS visitedAt
        FROM user_profile_visits WHERE user_ID = ? ORDER BY visited_at DESC, context_ID DESC LIMIT 51 OFFSET ${offset}`, [userID]);
    const topics = new Map(), entries = [];
    for (const row of rows.slice(0, 50)) {
        const id = Number(row.categoryID);
        if (!topics.has(id)) {
            try { topics.set(id, await getTopic(db, userID, id)); }
            catch (error) { if (error.status !== 404) throw error; topics.set(id, null); }
        }
        const topic = topics.get(id);
        if (!topic) continue;
        try { entries.push({ ...visitMetadata(topic, Number(row.contextID)), visitedAt: row.visitedAt }); }
        catch (error) { if (error.status !== 404) throw error; }
    }
    return { userID, entries, nextOffset: rows.length > 50 ? offset + 50 : null };
}

export async function clearProfileHistory(db, rawUserID, body) {
    const userID = canonicalAccountID(rawUserID);
    if (!userID) fail(401, 'authentication_required');
    if (!object(body) || Object.keys(body).length) fail(400, 'profile_history_query_invalid');
    await db.execute('DELETE FROM user_profile_visits WHERE user_ID = ?', [userID]);
    return { cleared: true, userID };
}
