import { topicURL, sceneSummary, scenePath } from './public/js/shared/topics.js';
import { absorbReferenceGraph } from './topic-reference-graph.js';
import { loadTopicMetadata } from './topic-service.js';

const fail = (status, error, details = {}) => { throw { status, body: { error, ...details } }; };
export const MAX_REFERENCE_NODES = 256;

export async function loadTopicReferenceTargets(db, userID = null, { includeMetadata = false } = {}) {
    const [rows] = await db.execute(`SELECT rc.ID AS context_ID, c.ID AS category_ID,
        c.name AS topic_name, c.slug, c.public_ID, c.private_ID, c.description AS topic_description, c.owner_user_ID,
        s.context_ID AS scene_ID, s.scene_number, s.name AS scene_name, s.slug AS scene_slug,
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
    const metadata = includeMetadata ? await loadTopicMetadata(db, userID, rows.map(row => Number(row.category_ID))) : null;
    return rows.filter(row => !metadata || metadata.has(Number(row.category_ID))).map(row => {
        const contextID = Number(row.context_ID), categoryID = Number(row.category_ID);
        const sceneID = row.scene_ID == null ? null : Number(row.scene_ID);
        const isPrivate = row.owner_user_ID != null;
        const publicID = Number(row.public_ID), privateID = row.private_ID ?? null;
        const sceneNumber = row.scene_number == null ? null : Number(row.scene_number);
        const base = topicURL({ ID: categoryID, publicID, privateID, isPrivate });
        const topic = metadata?.get(categoryID);
        return { contextID, categoryID, publicID, ...(isPrivate ? { privateID } : {}), sceneID, sceneNumber, topicName: row.topic_name,
            sceneName: row.scene_name ?? null,
            name: sceneID === null ? row.topic_name : `${row.topic_name} / ${row.scene_name}`,
            description: sceneSummary({ description: row.topic_description }),
            isDefault: Boolean(Number(row.is_default)), isPrivate, hasWeights: Boolean(Number(row.has_weights)),
            ...(topic ? { favoriteCount: topic.favoriteCount, isFavorited: topic.isFavorited,
                configured: topic.configuredContextIDs.includes(contextID), configuredContextIDs: topic.configuredContextIDs,
                configurationCount: topic.configurationCount, coverageIndex: topic.coverageIndex,
                creator: topic.creator, isOfficial: topic.isOfficial, isMine: topic.isMine } : {}),
            url: sceneID === null ? base : scenePath(base, { sceneNumber }) };
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

// Serialize graph-changing writes with topic lifecycle operations and reference cleanup.
export async function lockTopicReferences(db) {
    const [rows] = await db.execute('SELECT ID FROM topic_reference_lock WHERE ID = 1 FOR UPDATE');
    if (rows.length !== 1) fail(503, 'topic_reference_schema_unavailable');
}

// Display weights are rounded to 1bp. Graph scoring retains unrounded electorate shares.
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
        if (ID === Number(source.ID ?? source.contextID)) fail(409, 'topic_reference_self', { targetContextID: ID });
        if (!source.isPrivate && target.isPrivate) fail(409, 'private_topic_reference_not_public');
        if (!target.hasWeights) fail(409, 'topic_reference_empty', { targetContextID: ID });
    }
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

/** Expand allocations to their eventual benchmark/fallback absorption shares.
 * Every context is loaded once using the caller's public/personal policy.
 * Missing targets and closed topic-only classes keep explicit unmeasured mass.
 */
export async function expandTopicReferences(root, { loadTarget, maxNodes = MAX_REFERENCE_NODES } = {}) {
    if (!Number.isSafeInteger(maxNodes) || maxNodes < 1) throw new TypeError('Invalid topic graph limit');
    const targets = new Map([[root.contextID, root]]), nodes = new Map(), outcomes = new Map();
    const missingKeys = new Map();
    const add = (map, key, weight) => { if (weight > 0) map.set(key, (map.get(key) ?? 0) + weight); };
    const missing = (ID, reason, name = 'Unavailable topic', details = {}) => {
        const key = `missing:${ID}:${reason}`;
        if (!outcomes.has(key)) outcomes.set(key, { conditionID: -ID,
            issue: { targetContextID: ID, reason, name, ...details } });
        return key;
    };
    const queue = [root.contextID];
    for (let index = 0; index < queue.length; index++) {
        const ID = queue[index], target = targets.get(ID);
        const row = { edges: new Map(), absorbed: new Map() }; nodes.set(ID, row);
        const entries = [...target?.entries ?? []].sort((a, b) => a.conditionID - b.conditionID);
        for (const entry of entries) {
            if (!Number.isSafeInteger(entry.conditionID) || entry.conditionID === 0
                || !Number.isFinite(entry.weightBasisPoints) || entry.weightBasisPoints < 0) throw new TypeError('Invalid topic weight');
            if (entry.weightBasisPoints === 0) continue;
            if (entry.conditionID > 0) {
                for (const family of compositionFor(target, entry.conditionID)) {
                    if (!Number.isFinite(family.weightBasisPoints) || family.weightBasisPoints < 0) throw new TypeError('Invalid topic fallback share');
                    const key = `benchmark:${entry.conditionID}:${chainKey(family)}`;
                    if (!outcomes.has(key)) outcomes.set(key, { conditionID: entry.conditionID,
                        familyID: family.familyID ?? null, entries: family.entries ?? [] });
                    add(row.absorbed, key, entry.weightBasisPoints * family.weightBasisPoints / 10000);
                }
                continue;
            }
            const targetID = -entry.conditionID;
            if (!targets.has(targetID) && !missingKeys.has(targetID)) {
                if (targets.size >= maxNodes) missingKeys.set(targetID, missing(targetID, 'size_limit'));
                else { targets.set(targetID, await loadTarget(targetID)); queue.push(targetID); }
            }
            if (missingKeys.has(targetID)) add(row.absorbed, missingKeys.get(targetID), entry.weightBasisPoints);
            else add(row.edges, targetID, entry.weightBasisPoints);
        }
        if (!row.edges.size && !row.absorbed.size) {
            if (ID === root.contextID && target) return { entries: [], familyComposition: [], issues: [], referenceCompositions: [] };
            row.absorbed.set(missing(ID, target ? 'empty' : 'unavailable', target?.name), 10000);
        }
    }
    const solved = absorbReferenceGraph(nodes, component => {
        const ID = component[0];
        return missing(ID, 'closed_cycle', targets.get(ID)?.name, { contextIDs: component });
    });
    const composition = distribution => {
        const weights = new Map(), families = new Map(), issues = [];
        for (const [key, fraction] of [...distribution].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
            const outcome = outcomes.get(key), weight = fraction * 10000;
            add(weights, outcome.conditionID, weight);
            if (outcome.issue) issues.push(outcome.issue);
            else {
                if (!families.has(outcome.conditionID)) families.set(outcome.conditionID, []);
                families.get(outcome.conditionID).push({ primaryConditionID: outcome.conditionID,
                    familyID: outcome.familyID, entries: outcome.entries, overallWeightBasisPoints: weight });
            }
        }
        return {
            entries: [...weights].sort(([a], [b]) => a - b).map(([conditionID, weightBasisPoints]) => ({ conditionID, weightBasisPoints })),
            familyComposition: [...families].sort(([a], [b]) => a - b).map(([primaryConditionID, choices]) => ({
                primaryConditionID, families: choices.map(family => ({ ...family,
                    weightBasisPoints: family.overallWeightBasisPoints / weights.get(primaryConditionID) * 10000 }))
            })), issues
        };
    };
    return { ...composition(solved.get(root.contextID)),
        referenceCompositions: [...new Set(root.entries.filter(entry => entry.conditionID < 0 && entry.weightBasisPoints > 0)
            .map(entry => -entry.conditionID))].sort((a, b) => a - b).map(referenceContextID => ({ referenceContextID,
            ...composition(solved.get(referenceContextID) ?? new Map([[missingKeys.get(referenceContextID), 1]])) }))
    };
}
