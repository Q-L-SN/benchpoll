export const DEFAULT_RANKING_CATEGORY_NAME = 'Intelligence';

export function canonicalRankingEntryURL(input, origin) {
    const url = new URL(input, origin);
    return `${url.pathname}${url.search}`;
}
