export const topicCollections = Object.freeze({
    popular: 'Popular', favorites: 'My favorites', configured: 'Topics I configured',
    created: 'Topics I created', recent: 'Recently viewed', search: 'Search'
});

export const personalCollection = view => ['favorites', 'configured', 'created'].includes(view);

export function topicCollection(topics, view, recent = [], userID = null) {
    const available = topics.filter(topic => !topic.isPrivate || userID !== null && topic.isMine);
    if (personalCollection(view) && userID === null) return [];
    switch (view) {
        case 'popular': return available.filter(topic => !topic.isPrivate);
        case 'favorites': return available.filter(topic => topic.isFavorited);
        case 'configured': return available.filter(topic => topic.configured);
        case 'created': return available.filter(topic => topic.isMine);
        case 'recent': {
            const byID = new Map(available.map(topic => [Number(topic.categoryID ?? topic.ID), topic]));
            const ordered = [];
            for (const { categoryID } of recent) {
                if (byID.has(categoryID)) ordered.push(byID.get(categoryID));
                byID.delete(categoryID);
            }
            return ordered;
        }
        default: return available;
    }
}
