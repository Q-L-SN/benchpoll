// A persistent account/topic row prevents repeated toggling from refreshing age.
export const TOPIC_ACTIVITY_JOIN = `LEFT JOIN (
    SELECT f.category_ID, COUNT(*) AS favorite_count,
        SUM(f.first_favorited_at >= NOW() - INTERVAL 14 DAY AND f.first_favorited_at <= NOW()) AS recent_favorite_count
    FROM topic_favorites f JOIN users contributor ON contributor.ID = f.user_ID
    WHERE f.is_active = 1 AND contributor.deleted_at IS NULL
      AND (contributor.banned_at IS NULL OR (contributor.banned_until IS NOT NULL AND contributor.banned_until <= NOW()))
    GROUP BY f.category_ID
) activity ON activity.category_ID = c.ID`;

const count = value => Number.isFinite(Number(value)) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(value)))) : 0;

export function topicPopularity(topic) {
    const total = count(topic.favorite_count ?? topic.favoriteCount);
    const recent = Math.min(total, count(topic.recent_favorite_count ?? topic.recentFavoriteCount));
    // Damp large audiences while retaining durable support. Recent activity can
    // never exceed the number of unique accounts which currently favorite it.
    return Math.log1p(total) + 2 * Math.log1p(recent);
}

export function orderTopicsByPopularity(topics) {
    return [...topics].sort((a, b) => topicPopularity(b) - topicPopularity(a)
        || count(b.favorite_count ?? b.favoriteCount) - count(a.favorite_count ?? a.favoriteCount)
        || count(a.public_ID ?? a.publicID ?? a.ID ?? a.categoryID) - count(b.public_ID ?? b.publicID ?? b.ID ?? b.categoryID)
        || count(a.ID ?? a.categoryID) - count(b.ID ?? b.categoryID));
}
