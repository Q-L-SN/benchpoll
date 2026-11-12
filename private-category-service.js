import crypto from 'node:crypto';
import { topicSlug, normalizeTopicSummary } from './public/js/shared/topics.js';
import { getTopic } from './topic-service.js';
import { allocateTopicIdentity } from './topic-platform-schema.js';
import { startTransactionConnection, commitTransactionConnection, rollbackTransactionConnection,
    releaseTransactionConnection } from './db-transaction.js';

const fail = (status, error) => { throw { status, body: { error } }; };
const emptyContextHash = crypto.createHash('sha256').update('{}').digest('hex');

export function privateCategoryName(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 128
        || /[\p{Cc}\p{Cf}]/u.test(value)) fail(400, 'invalid_private_category_name');
    return value.trim();
}

export function ownsCategory(category, userID) {
    return category.owner_user_ID != null && userID != null
        && String(category.owner_user_ID) === String(userID);
}

export async function getPrivateCategory(db, userID, categoryID) {
    if (userID == null) fail(401, 'authentication_required');
    if (!/^[1-9]\d*$/.test(String(categoryID))) fail(404, 'category_not_found');
    const topic = await getTopic(db, userID, Number(categoryID));
    if (!topic.isPrivate) fail(404, 'category_not_found');
    return { ...topic, dimensions: [], available: true };
}

export async function insertPrivateCategory(connection, userID, name, notes = null, description = null) {
    const summary = normalizeTopicSummary(description ?? `Personal benchmark weights for ${name}.`);
    const { publicID, privateID } = await allocateTopicIdentity(connection);
    const [result] = await connection.execute(`INSERT INTO categories
        (owner_user_ID, created_by_user_ID, name, slug, description, public_ID, private_ID, is_official, position, notes) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    [userID, userID, privateCategoryName(name), topicSlug(name), summary, publicID, privateID, notes]);
    const categoryID = Number(result.insertId);
    const [context] = await connection.execute(`INSERT INTO ranking_contexts
        (category_ID, context_values, context_hash) VALUES (?, '{}', ?)`, [categoryID, emptyContextHash]);
    return { categoryID, contextID: Number(context.insertId) };
}

export function normalizePrivateCategoryRequest(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['name', 'description'].includes(key))) fail(400, 'invalid_private_category_request');
    const name = privateCategoryName(input.name);
    let description;
    try { description = normalizeTopicSummary(input.description); }
    catch { fail(400, 'invalid_topic_description'); }
    return { name, description };
}

export async function createPrivateCategory(db, userID, input) {
    if (userID == null) fail(401, 'authentication_required');
    const { name, description } = normalizePrivateCategoryRequest(input);
    const connection = await db.getConnection();
    try {
        await startTransactionConnection(connection, 'PRIVATE CATEGORY');
        const [users] = await connection.execute(`SELECT ID FROM users WHERE ID = ?
            AND deleted_at IS NULL AND (banned_at IS NULL OR (banned_until IS NOT NULL AND banned_until <= NOW())) FOR UPDATE`, [userID]);
        if (users.length !== 1) fail(401, 'authentication_required');
        const { categoryID } = await insertPrivateCategory(connection, userID, name, null, description);
        const entry = await getPrivateCategory(connection, userID, categoryID);
        await commitTransactionConnection(connection, 'PRIVATE CATEGORY');
        return entry;
    } catch (error) {
        await rollbackTransactionConnection(connection, 'PRIVATE CATEGORY', error);
        if (error.code === 'ER_DUP_ENTRY') fail(409, 'private_category_name_exists');
        throw error;
    } finally { releaseTransactionConnection(connection, 'PRIVATE CATEGORY'); }
}

// The caller holds the context/category locks and owns the transaction.
export async function preserveContextPies(connection, contextID, sourceName, sourcePath, ownerUserID = null) {
    const [pies] = await connection.execute(`SELECT p.ID, p.user_ID, rc.context_values
        FROM personal_pies p JOIN ranking_contexts rc ON rc.ID = p.context_ID
        WHERE p.context_ID = ? ${ownerUserID === null ? '' : 'AND p.user_ID = ?'} ORDER BY p.user_ID, p.ID FOR UPDATE`,
    ownerUserID === null ? [contextID] : [contextID, ownerUserID]);
    const moved = [];
    for (const pie of pies) {
        const values = typeof pie.context_values === 'string' ? JSON.parse(pie.context_values) : pie.context_values;
        const suffix = Object.values(values).filter(value => value !== 'any').join(', ');
        const baseName = `${sourceName}${suffix ? ` (${suffix})` : ''}`.slice(0, 110);
        const [[user]] = await connection.execute('SELECT ID FROM users WHERE ID = ? FOR UPDATE', [pie.user_ID]);
        if (!user) fail(409, 'personal_pie_owner_missing');
        let name = baseName, index = 2;
        // Use the database collation, including accent-insensitive uniqueness.
        while ((await connection.execute('SELECT ID FROM categories WHERE owner_user_ID = ? AND name = ?', [pie.user_ID, name]))[0].length) {
            name = `${baseName} (${index++})`;
        }
        const target = await insertPrivateCategory(connection, pie.user_ID, name,
            `Preserved from ${sourcePath}. Original context: ${JSON.stringify(values)}. Original context ID: ${contextID}.`);
        await connection.execute('UPDATE personal_pies SET context_ID = ?, updated_at = updated_at WHERE ID = ?',
            [target.contextID, pie.ID]);
        moved.push({ pieID: Number(pie.ID), sourceContextID: Number(contextID), ...target });
    }
    return moved;
}

export async function preserveRemovedPersonalPies(db, userID) {
    const connection = await db.getConnection();
    try {
        await startTransactionConnection(connection, 'PRESERVE PERSONAL PIES');
        const [users] = await connection.execute(`SELECT ID FROM users WHERE ID = ? AND deleted_at IS NULL
            AND (banned_at IS NULL OR (banned_until IS NOT NULL AND banned_until <= NOW())) FOR UPDATE`, [userID]);
        if (users.length !== 1) fail(401, 'authentication_required');
        const [contexts] = await connection.execute(`SELECT rc.ID, c.name FROM ranking_contexts rc
            JOIN categories c ON c.ID = rc.category_ID JOIN personal_pies p ON p.context_ID = rc.ID
            WHERE p.user_ID = ? AND c.owner_user_ID IS NULL AND c.is_active = 0 ORDER BY rc.ID FOR UPDATE`, [userID]);
        const moved = [];
        for (const context of contexts) moved.push(...await preserveContextPies(connection, context.ID, context.name, context.name, userID));
        await commitTransactionConnection(connection, 'PRESERVE PERSONAL PIES');
        return moved;
    } catch (error) { await rollbackTransactionConnection(connection, 'PRESERVE PERSONAL PIES', error); throw error; }
    finally { releaseTransactionConnection(connection, 'PRESERVE PERSONAL PIES'); }
}

export async function retirePublicCategory(connection, categoryID) {
    const [rows] = await connection.execute('SELECT * FROM categories WHERE ID = ? AND owner_user_ID IS NULL FOR UPDATE', [categoryID]);
    if (rows.length !== 1) fail(404, 'category_not_found');
    const [contexts] = await connection.execute('SELECT ID FROM ranking_contexts WHERE category_ID = ? ORDER BY ID FOR UPDATE', [categoryID]);
    const moved = [];
    for (const context of contexts) moved.push(...await preserveContextPies(connection, context.ID, rows[0].name, rows[0].name));
    // Keep old discussion/audit links intact, but remove it from all public surfaces.
    await connection.execute('UPDATE categories SET is_active = 0 WHERE ID = ?', [categoryID]);
    return moved;
}
