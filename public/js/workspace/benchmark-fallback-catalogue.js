import { validateRankingPagePayload } from './contracts.js?v=fallback-discovery-20261005';
import { FALLBACK_CONFIGURATION_PAGE_SIZE } from '../shared/fallback-catalogue-policy.js';

export function createBenchmarkFallbackCatalogue({ request, onChange, onExpired }) {
    const pages = new Map();
    let snapshotID = null;
    let generation = 0;
    let suspended = false;

    function invalidate() {
        generation++;
        suspended = true;
        for (const page of pages.values()) page.loading = false;
    }

    function setSnapshot(ID, { restoredPages = [] } = {}) {
        suspended = false;
        if (ID === snapshotID) return;
        snapshotID = ID;
        generation++;
        pages.clear();
        for (const response of restoredPages) {
            pages.set(response.conditionID, { items: [...response.items], total: response.total,
                nextOffset: response.nextOffset, hasMore: response.hasMore, loaded: true, loading: false, error: '',
                featured: response.featuredFallbackConfigurations, fallbackConfigCount: response.fallbackConfigCount });
        }
    }

    function progress() {
        return [...pages].filter(([, page]) => page.loading || page.nextOffset > 0)
            .map(([conditionID, page]) => ({ conditionID,
                depth: page.nextOffset + (page.loading && page.hasMore ? FALLBACK_CONFIGURATION_PAGE_SIZE : 0) }));
    }

    function featuredFor(entrance) {
        return pages.get(Number(entrance.ID))?.featured ?? entrance.featuredFallbackConfigurations ?? [];
    }

    async function load(conditionID) {
        if (!snapshotID || suspended) return;
        const page = pages.get(conditionID) ?? { items: [], nextOffset: 0, hasMore: true, loaded: false, loading: false, error: '' };
        pages.set(conditionID, page);
        if (page.loading || !page.hasMore) return;
        const started = generation;
        const offset = page.nextOffset;
        page.loading = true;
        page.error = '';
        onChange();
        try {
            const response = validateRankingPagePayload(await request({ snapshotID, list: 'fallbacks', conditionID, offset }),
                { list: 'fallbacks', conditionID, offset });
            if (started !== generation) return;
            const known = new Set([...page.items, ...response.featuredFallbackConfigurations].map(row => row.familyKey));
            if (response.items.some(row => known.has(row.familyKey))) throw new Error('Duplicate fallback configuration page');
            page.items.push(...response.items);
            Object.assign(page, { total: response.total, nextOffset: response.nextOffset, hasMore: response.hasMore, loaded: true,
                featured: response.featuredFallbackConfigurations, fallbackConfigCount: response.fallbackConfigCount });
        } catch (error) {
            if (started !== generation) return;
            if (error.status === 410 || error.status === 403 && error.payload?.error === 'ranking_snapshot_forbidden') {
                page.error = 'Refreshing fallback configurations…';
                onExpired({ list: 'fallbacks', conditionID, offset });
                return;
            }
            page.error = 'Could not load fallback configurations.';
        } finally {
            if (started === generation) {
                page.loading = false;
                onChange();
            }
        }
    }

    function view(entrance) {
        const page = pages.get(Number(entrance.ID));
        const featured = featuredFor(entrance);
        const remaining = page?.total ?? Math.max(0, (entrance.fallbackConfigCount ?? featured.length) - featured.length);
        return { featured, items: page?.items ?? [], total: remaining + featured.length,
            loaded: page?.loaded ?? false, loading: page?.loading ?? false, error: page?.error ?? '',
            hasMore: page?.hasMore ?? remaining > 0, nextOffset: page?.nextOffset ?? 0,
            suspended, snapshotID };
    }
    return { setSnapshot, invalidate, view, load, featuredFor, progress };
}
