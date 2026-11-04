import { topicURL, sceneSummary, scenePath } from './public/js/shared/topics.js';

const fail = (status, error, details = {}) => { throw { status, body: { error, ...details } }; };
export const MAX_REFERENCE_DEPTH = 16;
export const MAX_REFERENCE_NODES = 256;

export async function loadTopicReferenceTargets(db, userID = null) {
    const [rows] = await db.execute(`SELECT rc.ID AS context_ID, c.ID AS category_ID,
        c.name AS topic_name, c.slug, c.description AS topic_description, c.owner_user_ID,
        s.context_ID AS scene_ID, s.name AS scene_name, s.slug AS scene_slug, s.description AS scene_description,
        s.is_default,
        EXISTS(SELECT 1 FROM personal_pies p JOIN users u ON u.ID = p.user_ID
            WHERE p.context_ID = rc.ID AND u.deleted_at IS NULL
            AND (u.banned_at IS NULL OR (u.banned_until IS NOT NULL AND u.banned_until <= NOW()))
            AND (EXISTS(SELECT 1 FROM personal_pie_weights w WHERE w.pie_ID = p.ID)
                OR EXISTS(SELECT 1 FROM personal_pie_topic_weights w WHERE w.pie_ID = p.ID))) AS has_weights
        FROM ranking_contexts rc JOIN categories c ON c.ID = rc.category_ID
        LEFT JOIN topic_scenes s ON s.context_ID = rc.ID AND s.is_active = 1
        WHERE c.is_active = 1 AND (c.owner_user_ID IS NULL OR c.owner_user_ID = ?)
        AND (s.context_ID IS NOT NULL OR (rc.context_values = JSON_OBJECT()
            AND NOT EXISTS(SELECT 1 FROM topic_scenes other WHERE other.category_ID = c.ID AND other.is_active = 1)))
        ORDER BY c.position, c.ID, COALESCE(s.is_default, 0) DESC, s.position, s.context_ID`, [userID]);
    return rows.map(row => {
        const contextID = Number(row.context_ID), categoryID = Number(row.category_ID);
        const sceneID = row.scene_ID == null ? null : Number(row.scene_ID);
        const isPrivate = row.owner_user_ID != null;
        const base = topicURL(categoryID, row.topic_name, isPrivate, row.slug);
        return { contextID, categoryID, sceneID, topicName: row.topic_name,
            sceneName: row.scene_name ?? null,
            name: sceneID === null ? row.topic_name : `${row.topic_name} / ${row.scene_name}`,
            description: sceneSummary({ name: row.topic_name, description: row.topic_description },
                { name: row.scene_name, description: row.scene_description }),
            isDefault: Boolean(Number(row.is_default)), isPrivate, hasWeights: Boolean(Number(row.has_weights)),
            url: sceneID === null ? base : scenePath(base, { name: row.scene_name, slug: row.scene_slug }) };
    });
}

export function referenceCondition(target) {
    return { ...target, ID: -target.contextID, conditionID: -target.contextID, referenceContextID: target.contextID, type: 'topic',
        benchmarkID: null, conditionName: '', conditionKey: `topic:${target.contextID}`,
        isDefaultCondition: true, isPrimaryCondition: true, lowCoverage: false,
        excludedFromRanking: false, scoredModelCount: 0, scoreCount: 0 };
}

export function missingReferenceCondition(contextID) {
    return { ID: -contextID, conditionID: -contextID, referenceContextID: contextID, type: 'topic',
        name: 'Unavailable topic', benchmarkID: null, conditionName: '',
        conditionKey: `topic:${contextID}`, unavailable: true, isDefaultCondition: true,
        isPrimaryCondition: true, lowCoverage: false, excludedFromRanking: false,
        scoredModelCount: 0, scoreCount: 0 };
}

// Every graph-changing write takes this row lock, preventing concurrent A->B / B->A saves.
export async function lockTopicReferences(db) {
    const [rows] = await db.execute('SELECT ID FROM topic_reference_lock WHERE ID = 1 FOR UPDATE');
    if (rows.length !== 1) fail(503, 'topic_reference_schema_unavailable');
}

export function assertAcyclicReferences(edges, sourceID, targets) {
    const graph = new Map();
    for (const edge of edges) {
        const source = Number(edge.source_context_ID), target = Number(edge.target_context_ID);
        if (!graph.has(source)) graph.set(source, new Set());
        graph.get(source).add(target);
    }
    const visited = new Set(), active = new Set(), heights = new Map();
    const visit = (ID, depth) => {
        if (ID === sourceID || active.has(ID)) fail(409, 'topic_reference_cycle');
        if (depth > MAX_REFERENCE_DEPTH) fail(409, 'topic_reference_depth_limit');
        if (heights.has(ID)) {
            if (depth + heights.get(ID) > MAX_REFERENCE_DEPTH) fail(409, 'topic_reference_depth_limit');
            return heights.get(ID);
        }
        visited.add(ID);
        if (visited.size > MAX_REFERENCE_NODES) fail(409, 'topic_reference_size_limit');
        active.add(ID);
        let height = 0;
        for (const next of [...graph.get(ID) ?? []].sort((a, b) => a - b)) height = Math.max(height, visit(next, depth + 1) + 1);
        active.delete(ID); heights.set(ID, height);
        return height;
    };
    for (const target of [...targets].sort((a, b) => a - b)) visit(target, 1);
}

// Display weights are rounded to 1bp. Recursive scoring must retain the unrounded electorate shares.
export function publicReferenceWeights(pie) {
    if (!pie.participantCount) return [];
    return pie.scoringEntries.map(entry => ({ conditionID: entry.conditionID,
        weightBasisPoints: entry.weightBasisPoints / pie.participantCount }));
}

export async function validateTopicReferences(db, source, entries, userID) {
    const IDs = entries.filter(entry => entry.conditionID < 0).map(entry => -entry.conditionID);
    if (!IDs.length) return;
    const catalogue = new Map((await loadTopicReferenceTargets(db, userID)).map(target => [target.contextID, target]));
    for (const ID of IDs) {
        const target = catalogue.get(ID);
        if (!target) fail(404, 'topic_reference_not_found', { targetContextID: ID });
        if (!source.isPrivate && target.isPrivate) fail(409, 'private_topic_reference_not_public');
    }
    const [edges] = await db.execute(`SELECT p.context_ID AS source_context_ID, w.target_context_ID
        FROM personal_pie_topic_weights w JOIN personal_pies p ON p.ID = w.pie_ID
        JOIN ranking_contexts rc ON rc.ID = p.context_ID
        JOIN categories c ON c.ID = rc.category_ID WHERE c.is_active = 1`);
    assertAcyclicReferences(edges, source.ID, IDs);
}

function chainKey(family) {
    return (family.entries ?? []).map(entry => entry.conditionID).join(',');
}

function compositionFor(node, conditionID) {
    const own = node.fallbackRules?.find(rule => rule.primaryConditionID === conditionID);
    if (own) return [{ ...own, weightBasisPoints: 10000 }];
    return node.familyComposition?.find(group => group.primaryConditionID === conditionID)?.families
        ?? [{ familyID: null, entries: [], weightBasisPoints: 10000 }];
}

/** Expand raw weights, never child scores. Missing targets retain their share as unobserved weight. */
export async function expandTopicReferences(root, { loadTarget, maxDepth = MAX_REFERENCE_DEPTH,
    maxNodes = MAX_REFERENCE_NODES } = {}) {
    const memo = new Map(), active = new Set(), targets = new Map([[root.contextID, root]]);
    const unavailable = (ID, reason, name = 'Unavailable topic') => ({
        entries: [{ conditionID: -ID, weightBasisPoints: 10000 }], familyComposition: [],
        issues: [{ targetContextID: ID, reason, name }]
    });
    async function expand(node, depth) {
        const ID = node.contextID;
        const memoKey = `${ID}:${depth}`;
        if (active.has(ID)) return unavailable(ID, 'cycle', node.name);
        if (depth > maxDepth) return unavailable(ID, 'depth_limit', node.name);
        if (memo.has(memoKey)) return memo.get(memoKey);
        active.add(ID);
        const weights = new Map(), families = new Map(), issues = new Map();
        const add = (conditionID, weight, choices) => {
            weights.set(conditionID, (weights.get(conditionID) ?? 0) + weight);
            if (conditionID < 1) return;
            if (!families.has(conditionID)) families.set(conditionID, new Map());
            const group = families.get(conditionID);
            for (const family of choices) {
                const key = chainKey(family), previous = group.get(key);
                group.set(key, { familyID: family.familyID ?? null, entries: family.entries ?? [],
                    rawWeight: (previous?.rawWeight ?? 0) + weight * family.weightBasisPoints / 10000 });
            }
        };
        // Stable traversal makes resource-limit handling independent of UI ordering.
        for (const entry of [...node.entries].sort((a, b) => a.conditionID - b.conditionID)) {
            if (entry.weightBasisPoints === 0) continue;
            if (!Number.isFinite(entry.weightBasisPoints) || entry.weightBasisPoints < 0) throw new TypeError('Invalid topic weight');
            if (entry.conditionID > 0) {
                add(entry.conditionID, entry.weightBasisPoints, compositionFor(node, entry.conditionID));
                continue;
            }
            const targetID = -entry.conditionID;
            let child;
            if (active.has(targetID)) child = unavailable(targetID, 'cycle');
            else if (depth >= maxDepth) child = unavailable(targetID, 'depth_limit');
            else if (!targets.has(targetID) && targets.size >= maxNodes) child = unavailable(targetID, 'size_limit');
            else if (memo.has(`${targetID}:${depth + 1}`)) child = memo.get(`${targetID}:${depth + 1}`);
            else {
                if (!targets.has(targetID)) targets.set(targetID, await loadTarget(targetID));
                const target = targets.get(targetID);
                child = !target ? unavailable(targetID, 'unavailable')
                    : !target.entries.some(entry => entry.weightBasisPoints > 0) ? unavailable(targetID, 'empty', target.name)
                        : await expand(target, depth + 1);
            }
            for (const issue of child.issues) issues.set(`${issue.targetContextID}:${issue.reason}`, issue);
            for (const leaf of child.entries) add(leaf.conditionID,
                entry.weightBasisPoints * leaf.weightBasisPoints / 10000, compositionFor(child, leaf.conditionID));
        }
        active.delete(ID);
        const result = {
            entries: [...weights].map(([conditionID, weightBasisPoints]) => ({ conditionID, weightBasisPoints })),
            familyComposition: [...families].map(([primaryConditionID, choices]) => ({
                primaryConditionID, families: [...choices.values()].map(({ rawWeight, ...family }) => ({
                    ...family, primaryConditionID,
                    weightBasisPoints: rawWeight / weights.get(primaryConditionID) * 10000,
                    overallWeightBasisPoints: rawWeight
                }))
            })), issues: [...issues.values()]
        };
        if (!result.issues.some(issue => issue.reason === 'cycle')) memo.set(memoKey, result);
        return result;
    }
    return expand(root, 0);
}
