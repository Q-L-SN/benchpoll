import { createHash } from 'node:crypto';
import { OFFICIAL_TOPIC_CATALOGUE } from './official-topic-catalogue.js';
import { allocateTopicIdentity } from './topic-platform-schema.js';
import { topicSlug, sceneSlug } from './public/js/shared/topics.js';
import { EMPTY_TOPIC_CONTEXT_HASH, sceneContext, ensureTopicRootContext, insertTopicScene,
    lockTopicReferenceGraph } from './topic-scenes-service.js';

export const OFFICIAL_TOPIC_RENAMES = Object.freeze({
    Office: ['Office Documents & Data Processing'],
    Cybersecurity: ['Cybersecurity & Cryptography'],
    'Natural Language': ['Language'],
    '3D Creation': ['3D Generation'],
    'Business Management': ['Management', 'Business'],
    'GUI Operation': ['Computer Use'],
    Robotics: ['Robot Operation']
});
const key = value => String(value).normalize('NFC').trim().toLocaleLowerCase();
const official = row => row.owner_user_ID == null && row.created_by_user_ID == null
    && (row.is_official == null || Number(row.is_official) === 1);
const active = row => Number(row.is_active) === 1;
const ID = row => Number(row.ID ?? row.context_ID);

export async function readOfficialTopicState(db, { lock = false } = {}) {
    // SELECT * also supports a read-only plan before the new identity columns
    // exist. The plan never includes private rows or their content.
    const [categories] = await db.query(`SELECT * FROM categories ORDER BY ID${lock ? ' FOR UPDATE' : ''}`);
    const IDs = categories.filter(official).map(ID);
    if (!IDs.length) return { categories, contexts: [], scenes: [] };
    const placeholders = IDs.map(() => '?').join(',');
    const [contexts] = await db.execute(`SELECT ID, category_ID, context_hash, context_values FROM ranking_contexts
        WHERE category_ID IN (${placeholders}) ORDER BY ID${lock ? ' FOR UPDATE' : ''}`, IDs);
    const [scenes] = await db.execute(`SELECT * FROM topic_scenes WHERE category_ID IN (${placeholders})
        ORDER BY context_ID${lock ? ' FOR UPDATE' : ''}`, IDs);
    return { categories, contexts, scenes };
}

export function planOfficialTopicReconciliation(state) {
    const existing = state.categories.filter(official), retained = new Set(), occupiedSlugs = new Map();
    for (const row of state.categories.filter(row => row.owner_user_ID == null && row.slug)) occupiedSlugs.set(key(row.slug), ID(row));
    const topics = OFFICIAL_TOPIC_CATALOGUE.map((definition, position) => {
        const names = new Set([definition.name, ...(OFFICIAL_TOPIC_RENAMES[definition.name] ?? [])].map(key));
        const candidates = existing.filter(row => names.has(key(row.name)));
        const eligible = candidates.some(active) ? candidates.filter(active) : candidates;
        if (eligible.length > 1) throw new Error(`Ambiguous official topic: ${definition.name}`);
        const current = eligible[0], categoryID = current ? ID(current) : null;
        if (categoryID != null) {
            if (retained.has(categoryID)) throw new Error('An official topic matched more than one catalogue entry');
            retained.add(categoryID);
        }
        let slug = topicSlug(definition.name), suffix = 0;
        while (occupiedSlugs.has(key(slug)) && occupiedSlugs.get(key(slug)) !== categoryID) {
            slug = `${topicSlug(definition.name).slice(0, 60)}-official${suffix++ ? '-' + suffix : ''}`;
        }
        occupiedSlugs.set(key(slug), categoryID ?? `new:${position}`);
        const contexts = state.contexts.filter(row => Number(row.category_ID) === categoryID);
        const scenes = state.scenes.filter(row => Number(row.category_ID) === categoryID);
        const live = scenes.filter(active);
        const general = live.find(row => key(row.name) === 'general') ?? live.find(row => Number(row.is_default) === 1);
        const emptyRoot = contexts.find(row => row.context_hash === EMPTY_TOPIC_CONTEXT_HASH);
        const rootContextID = general ? ID(general) : emptyRoot ? ID(emptyRoot) : contexts[0] ? ID(contexts[0]) : null;
        const used = new Set();
        const desiredScenes = definition.scenes.map((scene, scenePosition) => {
            const matches = scenes.filter(row => key(row.name) === key(scene.name));
            const selected = matches.find(active) ?? matches[0]
                ?? (scene.isDefault ? general ?? scenes.find(row => ID(row) === rootContextID) : null);
            const contextID = selected ? ID(selected) : scene.isDefault ? rootContextID : null;
            if (contextID != null && used.has(contextID)) throw new Error(`Scene identity reused in ${definition.name}`);
            if (contextID != null) used.add(contextID);
            return { ...scene, position: scenePosition, contextID,
                sceneNumber: selected?.scene_number == null ? null : Number(selected.scene_number),
                existingScene: Boolean(selected), description: selected?.description ?? '' };
        });
        return { categoryID, publicID: current?.public_ID == null ? null : Number(current.public_ID),
            previousName: current?.name ?? null, name: definition.name, description: definition.description, slug, position,
            rootContextID, scenes: desiredScenes,
            retireSceneIDs: live.filter(row => !used.has(ID(row))).map(ID),
            supersededRootIDs: contexts.filter(row => row.context_hash === EMPTY_TOPIC_CONTEXT_HASH && ID(row) !== rootContextID).map(ID) };
    });
    return { version: '20261112-official-catalogue', topics,
        retireTopics: existing.filter(row => active(row) && !retained.has(ID(row))).map(row => ({ categoryID: ID(row), name: row.name })),
        untouchedUserTopicCount: state.categories.filter(row => !official(row)).length };
}

// Caller owns the transaction. The shared graph lock prevents a concurrent
// scene edit/reference save from observing half of the catalogue change.
export async function reconcileOfficialTopics(connection) {
    await lockTopicReferenceGraph(connection);
    const plan = planOfficialTopicReconciliation(await readOfficialTopicState(connection, { lock: true }));
    for (const retired of plan.retireTopics) {
        await connection.execute('UPDATE topic_scenes SET is_active = 0, is_default = 0 WHERE category_ID = ?', [retired.categoryID]);
        await connection.execute('UPDATE categories SET is_active = 0 WHERE ID = ? AND is_official = 1 AND owner_user_ID IS NULL AND created_by_user_ID IS NULL', [retired.categoryID]);
    }
    const topics = [];
    for (const item of plan.topics) {
        let categoryID = item.categoryID, publicID = item.publicID;
        if (categoryID == null) {
            const identity = await allocateTopicIdentity(connection); publicID = identity.publicID;
            const [inserted] = await connection.execute(`INSERT INTO categories
                (name, slug, description, public_ID, private_ID, is_official, position)
                VALUES (?, ?, ?, ?, ?, 1, ?)`, [item.name, item.slug, item.description, publicID, identity.privateID, item.position]);
            categoryID = Number(inserted.insertId);
        } else {
            await connection.execute(`UPDATE categories SET name = ?, slug = ?, description = ?, position = ?, is_active = 1
                WHERE ID = ? AND is_official = 1 AND owner_user_ID IS NULL AND created_by_user_ID IS NULL`,
            [item.name, item.slug, item.description, item.position, categoryID]);
        }
        // Clear defaults together before assigning exactly one retained/new one.
        await connection.execute('UPDATE topic_scenes SET is_default = 0 WHERE category_ID = ?', [categoryID]);
        for (const contextID of item.retireSceneIDs) await connection.execute(
            'UPDATE topic_scenes SET is_active = 0 WHERE context_ID = ? AND category_ID = ?', [contextID, categoryID]);
        let rootContextID = item.rootContextID;
        if (!item.scenes.length) {
            for (const contextID of item.supersededRootIDs) {
                const values = JSON.stringify({ retiredRoot: String(contextID) });
                await connection.execute('UPDATE ranking_contexts SET context_values = ?, context_hash = ? WHERE ID = ? AND category_ID = ?',
                    [values, createHash('sha256').update(values).digest('hex'), contextID, categoryID]);
            }
            if (rootContextID == null) rootContextID = await ensureTopicRootContext(connection, categoryID);
            else {
                await connection.execute('DELETE FROM topic_scenes WHERE context_ID = ? AND category_ID = ?', [rootContextID, categoryID]);
                await connection.execute('UPDATE ranking_contexts SET context_values = ?, context_hash = ? WHERE ID = ? AND category_ID = ?',
                    ['{}', EMPTY_TOPIC_CONTEXT_HASH, rootContextID, categoryID]);
            }
        } else {
            if (rootContextID == null) rootContextID = await ensureTopicRootContext(connection, categoryID);
            for (const scene of item.scenes) {
                const contextID = scene.contextID ?? (scene.isDefault ? rootContextID : null);
                if (!scene.existingScene) {
                    await insertTopicScene(connection, categoryID, scene, { contextID, position: scene.position });
                } else {
                    await connection.execute(`UPDATE topic_scenes SET name = ?, slug = ?, position = ?, is_default = ?, is_active = 1
                        WHERE context_ID = ? AND category_ID = ?`,
                    [scene.name, sceneSlug(scene.name), scene.position, Number(scene.isDefault), contextID, categoryID]);
                    const context = sceneContext(contextID);
                    await connection.execute('UPDATE ranking_contexts SET context_values = ?, context_hash = ? WHERE ID = ? AND category_ID = ?',
                        [context.serialized, context.contextHash, contextID, categoryID]);
                }
            }
        }
        topics.push({ categoryID, publicID, name: item.name });
    }
    return { ...plan, topics, applied: true };
}
