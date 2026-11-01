import { FEATURED_TOPIC_ID } from './public/js/shared/topics.js';

export const TOPIC_ACTIVITY_JOIN = `LEFT JOIN (
    SELECT rc.category_ID, COUNT(DISTINCT pp.user_ID) AS popularity, MAX(pp.updated_at) AS last_activity
    FROM ranking_contexts rc JOIN personal_pies pp ON pp.context_ID = rc.ID
    JOIN users contributor ON contributor.ID = pp.user_ID
    WHERE pp.updated_at >= NOW() - INTERVAL 14 DAY AND contributor.deleted_at IS NULL
      AND (contributor.banned_at IS NULL OR (contributor.banned_until IS NOT NULL AND contributor.banned_until <= NOW()))
      AND EXISTS(SELECT 1 FROM personal_pie_weights w WHERE w.pie_ID = pp.ID AND w.weight_basis_points > 0)
    GROUP BY rc.category_ID
) activity ON activity.category_ID = c.ID`;

const timestamp = value => {
    const time = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(time) ? time : 0;
};

export function orderTopicsByPopularity(topics, { now = Date.now() } = {}) {
    const hot = [...topics].sort((a, b) => Number(b.popularity ?? 0) - Number(a.popularity ?? 0)
        || timestamp(b.last_activity) - timestamp(a.last_activity)
        || Number(a.position ?? 0) - Number(b.position ?? 0) || Number(a.ID) - Number(b.ID));
    const eligibleNew = hot.filter(topic => Number(topic.ID) !== FEATURED_TOPIC_ID && topic.owner_user_ID == null
        && topic.creator_eligible !== false && Number(topic.creator_eligible ?? 1) !== 0
        && timestamp(topic.created_at) <= now && timestamp(topic.created_at) > now - 7 * 86400000)
        .sort((a, b) => timestamp(b.created_at) - timestamp(a.created_at) || Number(a.ID) - Number(b.ID));
    const featured = hot.filter(topic => Number(topic.ID) === FEATURED_TOPIC_ID);
    const result = [...featured], used = new Set(featured.map(topic => Number(topic.ID))), exploredCreators = new Set();
    let ordinary = 0;
    while (used.size < hot.length) {
        let next;
        if (ordinary > 0 && (ordinary + 1) % 6 === 0) {
            next = eligibleNew.find(topic => !used.has(Number(topic.ID))
                && !exploredCreators.has(String(topic.created_by_user_ID ?? 'benchpoll')));
            if (next) exploredCreators.add(String(next.created_by_user_ID ?? 'benchpoll'));
        }
        next ??= hot.find(topic => !used.has(Number(topic.ID)));
        if (!next) break;
        result.push(next); used.add(Number(next.ID)); ordinary++;
    }
    return result;
}
