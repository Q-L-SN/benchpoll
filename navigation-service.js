import { normalizeUserID, selectScopedDimensions, decorateDimensions, canonicalizeContextValues } from './ranking-service.js';
import { entryFromContext, compareLocations } from './public/js/navigation/model.js';
import { selectableBenchmarkConditionSQL } from './benchmark-condition-visibility.js';
import { preserveRemovedPersonalPies } from './private-category-service.js';
import { orderTopicsByPopularity } from './topic-popularity.js';
import { topicURL } from './public/js/shared/topics.js';
import { topicCreator, topicSelect, serializeTopic, listTopics } from './topic-service.js';
import { loadTopicSceneCatalog } from './topic-scenes-service.js';
import { startTransactionConnection, commitTransactionConnection, rollbackTransactionConnection,
    releaseTransactionConnection } from './db-transaction.js';

export function buildCategoryNavigation(categories, sceneCatalog = new Map()) {
    return orderTopicsByPopularity(categories.filter(category => category.owner_user_ID == null && category.is_active))
        .map(category => {
            const topic = serializeTopic(category);
            const catalog = sceneCatalog.get(topic.ID) ?? { scenes: [], defaultContextID: null, rootContextID: null };
            return { ...topic, ...entryFromContext({ ...topic, ...catalog, ID: catalog.defaultContextID,
                contextValues: catalog.scenes.length ? { scene: String(catalog.defaultContextID) } : {} }), ...catalog };
        });
}

export async function getCategoryNavigation(db, viewerID = null) {
    const { topics } = await listTopics(db, viewerID);
    const items = topics.filter(topic => !topic.isPrivate).map(topic => ({ ...topic,
        ...entryFromContext({ ...topic, ID: topic.defaultContextID }) }));
    return { items, entries: items, flat: true };
}

// Build only location metadata. This never computes public pies or model scores.
export function buildPersonalNavigation(rows, categories, dimensionRows = [], optionRows = [], sceneCatalog = new Map()) {
    const byID = new Map(categories.map(category => [Number(category.ID), category]));
    return rows.filter(row => Number(row.weightCount) > 0).map(row => {
        const categoryID = Number(row.categoryID);
        const topic = byID.get(categoryID);
        let available = Boolean(topic?.is_active);
        const isPrivate = topic?.owner_user_ID != null;
        const lineage = [{ ID: categoryID, name: String(topic?.name ?? `Topic #${categoryID}`),
            position: Number(topic?.position ?? 0) }];
        let values = {};
        let dimensions = [];
        const sceneEntry = sceneCatalog.get(categoryID);
        const scene = sceneEntry?.scenes.find(item => item.ID === Number(row.contextID));
        try {
            values = typeof row.contextValues === 'string' ? JSON.parse(row.contextValues) : row.contextValues;
            if (!values || typeof values !== 'object' || Array.isArray(values)
                || Object.values(values).some(value => typeof value !== 'string')) throw new TypeError('Invalid context');
            if (sceneEntry?.scenes.length) {
                if (!scene) throw new TypeError('Scene is unavailable');
                values = { scene: String(scene.ID) };
            } else {
                const category = { ID: categoryID, lineage, isLeaf: true, isPrivate };
                dimensions = decorateDimensions(selectScopedDimensions(dimensionRows, category), optionRows);
                canonicalizeContextValues(values, dimensions, { requireAllDimensions: true });
            }
        } catch {
            available = false;
            if (!values || typeof values !== 'object' || Array.isArray(values)) values = {};
            values = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)]));
            dimensions = [];
        }
        const entry = entryFromContext({ ID: Number(row.contextID), categoryID, lineage, dimensions, contextValues: values, isPrivate,
            description: topic?.description, creator: topicCreator(topic ?? {}) });
        if (scene) {
            entry.contextLabel = scene.name;
            entry.contextOrder = [scene.isDefault ? -1 : scene.position, scene.ID];
            entry.sceneID = scene.ID;
            entry.scene = scene;
        } else if (!dimensions.length && Object.keys(values).length) {
            entry.contextLabel = Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}: ${value}`).join(', ');
        }
        if ((!isPrivate || Number(row.weightCount) > 0) && Number(row.totalBasisPoints) !== 10000
            || Number(row.unavailableConditions) > 0 || Number(row.unavailableReferences ?? 0) > 0) available = false;
        return { ...entry, publicID: Number(topic?.public_ID), privateID: isPrivate ? topic?.private_ID : undefined,
            isOfficial: Boolean(Number(topic?.is_official)), isMine: topic?.isMine === true,
            favoriteCount: Number(topic?.favorite_count ?? 0), isFavorited: Boolean(Number(topic?.is_favorited)),
            configurationCount: Number(topic?.configuration_count ?? 0), configured: true, coverageIndex: null,
            ...(sceneEntry ?? {}),
            url: scene?.url ?? (topic ? topicURL(topic) : null),
            available, weightCount: Number(row.weightCount) };
    }).sort(compareLocations);
}

export async function getPersonalNavigation(db, userID, { retirementChecked = false } = {}) {
    const owner = normalizeUserID(userID);
    if (!owner) throw { status: 401, body: { error: 'authentication_required' } };
    const connection = await db.getConnection();
    let preserveRetired = false, payload;
    try {
        await startTransactionConnection(connection, 'PERSONAL NAVIGATION', { readOnlySnapshot: true });
        const [users] = await connection.execute(`SELECT ID FROM users WHERE ID = ?
            AND deleted_at IS NULL AND (banned_at IS NULL OR (banned_until IS NOT NULL AND banned_until <= NOW()))`, [owner]);
        if (!users.length) throw { status: 401, body: { error: 'authentication_required' } };
        const [rows] = await connection.execute(`
            SELECT rc.ID AS contextID, rc.category_ID AS categoryID, rc.context_values AS contextValues,
                   COUNT(w.benchmark_condition_ID) + (SELECT COUNT(*) FROM personal_pie_topic_weights tw WHERE tw.pie_ID = pp.ID) AS weightCount,
                   COALESCE(SUM(w.weight_basis_points), 0) + COALESCE((SELECT SUM(tw.weight_basis_points)
                       FROM personal_pie_topic_weights tw WHERE tw.pie_ID = pp.ID), 0) AS totalBasisPoints,
                   (SELECT COUNT(*) FROM personal_pie_topic_weights tw
                       LEFT JOIN ranking_contexts target_rc ON target_rc.ID = tw.target_context_ID
                       LEFT JOIN categories target_topic ON target_topic.ID = target_rc.category_ID
                       LEFT JOIN topic_scenes target_scene ON target_scene.context_ID = target_rc.ID
                       WHERE tw.pie_ID = pp.ID AND (target_topic.ID IS NULL OR target_topic.is_active = 0
                           OR (target_topic.owner_user_ID IS NOT NULL AND
                               (cat.owner_user_ID IS NULL OR target_topic.owner_user_ID <> pp.user_ID))
                           OR target_scene.is_active = 0
                           OR (target_scene.context_ID IS NULL AND EXISTS(SELECT 1 FROM topic_scenes other_scene
                               WHERE other_scene.category_ID = target_rc.category_ID AND other_scene.is_active = 1)))) AS unavailableReferences,
                   SUM(CASE WHEN w.benchmark_condition_ID IS NULL THEN 0
                            WHEN bc.ID IS NULL OR b.ID IS NULL OR b.is_active = 0
                            OR NOT ${selectableBenchmarkConditionSQL('bc')}
                            THEN 1 ELSE 0 END) AS unavailableConditions
            FROM ranking_contexts rc
            JOIN categories cat ON cat.ID = rc.category_ID
            LEFT JOIN personal_pies pp ON pp.context_ID = rc.ID AND pp.user_ID = ?
            LEFT JOIN personal_pie_weights w ON w.pie_ID = pp.ID
            LEFT JOIN benchmark_conditions bc ON bc.ID = w.benchmark_condition_ID
            LEFT JOIN benchmarks b ON b.ID = bc.benchmark_ID
            WHERE (cat.owner_user_ID IS NULL AND pp.user_ID = ?) OR cat.owner_user_ID = ?
            GROUP BY pp.ID, pp.user_ID, cat.owner_user_ID, rc.ID, rc.category_ID, rc.context_values
            ORDER BY rc.category_ID, rc.ID`, [owner, owner, owner]);
        const [categories] = await connection.execute(`${topicSelect()}
            WHERE c.owner_user_ID IS NULL OR c.owner_user_ID = ? ORDER BY c.position, c.ID`, [owner, owner, owner]);
        for (const category of categories) category.isMine = String(category.created_by_user_ID ?? category.owner_user_ID) === String(owner);
        const sceneCatalog = await loadTopicSceneCatalog(connection, categories.map(category => Number(category.ID)));
        preserveRetired = rows.some(row => categories.some(category => Number(category.ID) === Number(row.categoryID)
            && category.owner_user_ID == null && !category.is_active));
        if (preserveRetired && retirementChecked) throw { status: 409, body: { error: 'retired_personal_pie_preservation_failed' } };
        const items = preserveRetired ? [] : buildPersonalNavigation(rows, categories, [], [], sceneCatalog);
        await commitTransactionConnection(connection, 'PERSONAL NAVIGATION');
        payload = { userID: owner, items };
    } catch (error) {
        await rollbackTransactionConnection(connection, 'PERSONAL NAVIGATION', error);
        throw error;
    } finally {
        releaseTransactionConnection(connection, 'PERSONAL NAVIGATION');
    }
    if (preserveRetired) {
        await preserveRemovedPersonalPies(db, owner);
        return getPersonalNavigation(db, owner, { retirementChecked: true });
    }
    return payload;
}
