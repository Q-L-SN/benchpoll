import { normalizeUserID, selectScopedDimensions, decorateDimensions, canonicalizeContextValues } from './ranking-service.js';
import { entryFromContext, compareLocations } from './public/js/navigation/model.js';
import { selectableBenchmarkConditionSQL } from './benchmark-condition-visibility.js';
import { preserveRemovedPersonalPies } from './private-category-service.js';
import { TOPIC_ACTIVITY_JOIN, orderTopicsByPopularity } from './topic-popularity.js';
import { topicURL, topicSlug } from './public/js/shared/topics.js';
import { topicCreator } from './topic-service.js';
import { loadTopicSceneCatalog } from './topic-scenes-service.js';
import { startTransactionConnection, commitTransactionConnection, rollbackTransactionConnection,
    releaseTransactionConnection } from './db-transaction.js';

export function buildCategoryNavigation(categories, sceneCatalog = new Map()) {
    return orderTopicsByPopularity(categories.filter(category => category.owner_user_ID == null && category.is_active))
        .map(category => ({ ...entryFromContext({ categoryID: Number(category.ID),
            ID: sceneCatalog.get(Number(category.ID))?.defaultContextID ?? null,
            contextValues: sceneCatalog.get(Number(category.ID))?.scenes.length
                ? { scene: String(sceneCatalog.get(Number(category.ID)).defaultContextID) } : {},
            description: category.description, creator: topicCreator(category),
            lineage: [{ ID: Number(category.ID), name: String(category.name), position: Number(category.position ?? 0) }] }),
        ...(sceneCatalog.get(Number(category.ID)) ?? { scenes: [], defaultContextID: null, rootContextID: null }),
        slug: category.slug || topicSlug(category.name),
        url: topicURL(category.ID, category.name, false, category.slug || topicSlug(category.name)),
        popularity: Number(category.popularity ?? 0) }));
}

export async function getCategoryNavigation(db) {
    const [categories] = await db.execute(`SELECT c.ID, c.name, c.slug, c.description, c.position, c.is_active,
        c.created_by_user_ID, c.created_at, activity.last_activity,
        COALESCE(NULLIF(p.display_name, ''), creator.name) AS creator_name,
        COALESCE(p.avatar_data_url, creator.profile_picture_URL) AS creator_avatar,
        COALESCE(activity.popularity, 0) AS popularity,
        (c.created_by_user_ID IS NULL OR (creator.ID IS NOT NULL AND creator.deleted_at IS NULL
            AND (creator.banned_at IS NULL OR (creator.banned_until IS NOT NULL AND creator.banned_until <= NOW())))) AS creator_eligible
        FROM categories c ${TOPIC_ACTIVITY_JOIN}
        LEFT JOIN users creator ON creator.ID = c.created_by_user_ID AND creator.deleted_at IS NULL
        LEFT JOIN user_public_profiles p ON p.user_ID = creator.ID AND creator.deleted_at IS NULL
        WHERE c.owner_user_ID IS NULL ORDER BY c.position, c.ID`);
    const sceneCatalog = await loadTopicSceneCatalog(db, categories.filter(category => category.is_active).map(category => Number(category.ID)));
    const items = buildCategoryNavigation(categories, sceneCatalog);
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
        return { ...entry, slug: topic?.slug || topicSlug(entry.categoryName),
            ...(sceneEntry ?? {}),
            url: scene?.url ?? topicURL(categoryID, entry.categoryName, isPrivate, topic?.slug || topicSlug(entry.categoryName)),
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
        const [categories] = await connection.execute(`SELECT c.ID, c.name, c.slug, c.description, c.position, c.is_active,
            c.owner_user_ID, c.created_by_user_ID, COALESCE(NULLIF(p.display_name, ''), creator.name) AS creator_name,
            COALESCE(p.avatar_data_url, creator.profile_picture_URL) AS creator_avatar
            FROM categories c LEFT JOIN users creator ON creator.ID = c.created_by_user_ID AND creator.deleted_at IS NULL
            LEFT JOIN user_public_profiles p ON p.user_ID = creator.ID
            WHERE c.owner_user_ID IS NULL OR c.owner_user_ID = ? ORDER BY c.position, c.ID`, [owner]);
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
