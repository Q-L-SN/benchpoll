import { EMPTY_TOPIC_CONTEXT_HASH } from './topic-scenes-service.js';

// Public evidence only. A private topic must never influence a public default.
export async function loadGlobalConditionWeights(db) {
    const [rows] = await db.execute(`SELECT w.benchmark_condition_ID AS conditionID, SUM(w.weight_basis_points) AS total
        FROM personal_pie_weights w JOIN personal_pies p ON p.ID = w.pie_ID
        JOIN ranking_contexts rc ON rc.ID = p.context_ID JOIN categories c ON c.ID = rc.category_ID
        JOIN users u ON u.ID = p.user_ID
        WHERE c.owner_user_ID IS NULL AND c.is_active = 1 AND w.weight_basis_points > 0
          AND u.deleted_at IS NULL AND (u.banned_at IS NULL OR (u.banned_until IS NOT NULL AND u.banned_until <= NOW()))
          AND ((rc.context_hash = '${EMPTY_TOPIC_CONTEXT_HASH}' AND NOT EXISTS(SELECT 1 FROM topic_scenes s WHERE s.category_ID = c.ID AND s.is_active = 1))
            OR EXISTS(SELECT 1 FROM topic_scenes s WHERE s.context_ID = rc.ID AND s.is_active = 1))
        GROUP BY w.benchmark_condition_ID
        UNION ALL
        SELECT -w.target_context_ID AS conditionID, SUM(w.weight_basis_points) AS total
        FROM personal_pie_topic_weights w JOIN personal_pies p ON p.ID = w.pie_ID
        JOIN ranking_contexts rc ON rc.ID = p.context_ID JOIN categories c ON c.ID = rc.category_ID
        JOIN ranking_contexts target_context ON target_context.ID = w.target_context_ID
        JOIN categories target ON target.ID = target_context.category_ID
        JOIN users u ON u.ID = p.user_ID
        WHERE c.owner_user_ID IS NULL AND c.is_active = 1 AND w.weight_basis_points > 0
          AND target.owner_user_ID IS NULL AND target.is_active = 1
          AND u.deleted_at IS NULL AND (u.banned_at IS NULL OR (u.banned_until IS NOT NULL AND u.banned_until <= NOW()))
          AND ((rc.context_hash = '${EMPTY_TOPIC_CONTEXT_HASH}' AND NOT EXISTS(SELECT 1 FROM topic_scenes s WHERE s.category_ID = c.ID AND s.is_active = 1))
            OR EXISTS(SELECT 1 FROM topic_scenes s WHERE s.context_ID = rc.ID AND s.is_active = 1))
          AND ((target_context.context_hash = '${EMPTY_TOPIC_CONTEXT_HASH}' AND NOT EXISTS(SELECT 1 FROM topic_scenes s WHERE s.category_ID = target.ID AND s.is_active = 1))
            OR EXISTS(SELECT 1 FROM topic_scenes s WHERE s.context_ID = target_context.ID AND s.is_active = 1))
        GROUP BY w.target_context_ID`);
    return new Map(rows.map(row => [Number(row.conditionID), Number(row.total)]));
}
