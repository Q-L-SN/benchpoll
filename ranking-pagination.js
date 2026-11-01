import { randomUUID } from 'node:crypto';
import { BENCHMARK_GROUPS, benchmarkConditionGroup } from './public/js/shared/benchmark-condition-groups.js';
import { createSearchIndex, dominantSearchMatch } from './public/js/shared/search.js';
import { FEATURED_FALLBACK_LIMIT, FEATURED_FALLBACK_MIN_BASIS_POINTS } from './public/js/shared/fallback-catalogue-policy.js';
import { benchmarkVersionTieOrder } from './public/js/shared/benchmark-version-order.js';
import { normalizeRankingResume, RANKING_PAGE_SIZE } from './public/js/shared/ranking-resume.js';
import { normalizeModelFocusTarget, findModelFocusIndex } from './public/js/workspace/model-focus-target.js';
import { comparisonDisplayParts } from './public/js/shared/comparison-display.js';

export { RANKING_PAGE_SIZE };
const SNAPSHOT_TTL_MS = 15 * 60 * 1000;
const MAX_SNAPSHOTS = 12;

function rankingError(status, error) {
    return { status, body: { error } };
}

function modelOrder(left, right) {
    return Number(right.comparable !== false) - Number(left.comparable !== false)
        || Number(right.lower) - Number(left.lower)
        || Number(right.coverage) - Number(left.coverage)
        || left.name.localeCompare(right.name)
        || Number(left.ID) - Number(right.ID);
}

export function rankModels(models) {
    const ranked = [...models].sort(modelOrder);
    let previousScore = null;
    let previousRank = 0;
    return ranked.map((model, index) => {
        const score = Number(model.lower);
        const rank = previousScore !== null && Math.abs(score - previousScore) < 0.0001
            ? previousRank : index + 1;
        previousScore = score;
        previousRank = rank;
        const row = Object.defineProperties({}, Object.getOwnPropertyDescriptors(model));
        row.rank = model.comparable === false ? null : rank;
        return row;
    });
}

function modelScale(models) {
    let min = 0;
    let max = 100;
    for (const model of models) {
        if (model.comparable === false) continue;
        if (!Number.isFinite(model.lower) || !Number.isFinite(model.upper) || model.lower > model.upper) {
            throw new TypeError('Model score intervals must be finite and ordered');
        }
        min = Math.min(min, model.lower);
        max = Math.max(max, model.upper);
    }
    return { min, max };
}

function requireOffset(offset) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw rankingError(400, 'invalid_ranking_offset');
    return offset;
}

function normalizeQuery(query) {
    if (typeof query !== 'string' || query.length > 120) throw rankingError(400, 'invalid_ranking_query');
    return query.trim().toLocaleLowerCase('en-US');
}

export function searchRankedModels(models, comparison, query) {
    const normalized = normalizeQuery(query);
    if (!normalized) return [];
    const entries = models.map((model, offset) => ({ model, offset,
        parts: comparisonDisplayParts(model, comparison) }));
    const index = createSearchIndex(entries, entry => entry.parts.flatMap(part => [part.text, part.title]));
    return index.search(normalized, { limit: 20 }).flatMap(({ model, offset, parts }) => {
        const targetModel = model.comparisonIdentity || String(model.modelID ?? model.ID ?? '');
        try { normalizeModelFocusTarget(targetModel); }
        catch { return []; }
        if (findModelFocusIndex(models, targetModel) !== offset) return [];
        return [{ targetModel, offset, rank: model.rank ?? null,
            parts: parts.map(({ kind, key, text, title, icon }) => ({ kind, key, text, title, ...(icon ? { icon } : {}) })) }];
    }).slice(0, 10);
}

function benchmarkRows(snapshot, query, pinPersonal) {
    if (query && !snapshot.search) {
        snapshot.search = benchmarkSearchIndex(snapshot.benchmarks, snapshot.familiesByEntrance);
    }
    const matches = query ? snapshot.search.rank(query) : [];
    const promoted = query ? dominantSearchMatch(matches) : null;
    const filtered = query ? matches.map(({ item }) => item === promoted ? { ...item, searchPromoted: true } : item)
        .sort((left, right) => Number(right.searchPromoted) - Number(left.searchPromoted)) : snapshot.benchmarks;
    if (!pinPersonal) return filtered;
    return [...filtered].sort((left, right) => {
        const relevance = Number(right.searchPromoted) - Number(left.searchPromoted);
        if (relevance) return relevance;
        const leftWeight = snapshot.personalWeights.get(Number(left.conditionID));
        const rightWeight = snapshot.personalWeights.get(Number(right.conditionID));
        if (leftWeight !== undefined && rightWeight === undefined) return -1;
        if (rightWeight !== undefined && leftWeight === undefined) return 1;
        if (leftWeight !== undefined && rightWeight !== undefined && leftWeight !== rightWeight) {
            return rightWeight - leftWeight;
        }
        return (right.publicWeightBasisPoints - left.publicWeightBasisPoints) || benchmarkVersionTieOrder(left, right);
    });
}

function benchmarkSearchIndex(benchmarks, familiesByEntrance) {
    return createSearchIndex(benchmarks, row => [row.name, row.conditionName,
        ...(familiesByEntrance.get(row.conditionID) ?? []).flatMap(family => family.familyEntries).flatMap(entry => [entry.name, entry.conditionName,
            ...(entry.versions ?? []).flatMap(version => [version.name, version.conditionName])])], { identityFieldCount: 2 });
}

function updateBenchmarkCatalogue(snapshot, catalogue) {
    const familiesByEntrance = new Map();
    for (const family of catalogue.filter(row => row.isFamily)) {
        const ID = Number(family.conditionID);
        if (!familiesByEntrance.has(ID)) familiesByEntrance.set(ID, []);
        familiesByEntrance.get(ID).push(family);
    }
    for (const families of familiesByEntrance.values()) families.sort((left, right) =>
        right.publicWeightBasisPoints - left.publicWeightBasisPoints
        || left.familyKey.localeCompare(right.familyKey));
    snapshot.catalogue = catalogue;
    snapshot.familiesByEntrance = familiesByEntrance;
    snapshot.benchmarks = catalogue.filter(row => !row.isFamily).map(row => {
        const families = familiesByEntrance.get(Number(row.conditionID)) ?? [];
        return { ...row, searchPromoted: false, fallbackConfigCount: families.length,
            featuredFallbackConfigurations: families.filter(family => family.publicWeightBasisPoints >= FEATURED_FALLBACK_MIN_BASIS_POINTS)
                .slice(0, FEATURED_FALLBACK_LIMIT) };
    }).sort((left, right) => right.publicWeightBasisPoints - left.publicWeightBasisPoints
        || benchmarkVersionTieOrder(left, right));
    snapshot.search = null;
    snapshot.benchmarkPages.clear();
}

function benchmarkPage(snapshot, query, pinPersonal, offset, group, groupVersions, size = RANKING_PAGE_SIZE.benchmarks) {
    const grouping = query || groupVersions ? 'versions' : 'flat';
    const key = JSON.stringify([query, pinPersonal, grouping]);
    if (!snapshot.benchmarkPages.has(key)) {
        const groups = Object.fromEntries(BENCHMARK_GROUPS.map(group => [group, []]));
        for (const row of benchmarkRows(snapshot, query, pinPersonal)) {
            groups[grouping === 'flat' ? 'primary' : benchmarkConditionGroup(row)].push(row);
        }
        if (snapshot.benchmarkPages.size >= 32) snapshot.benchmarkPages.delete(snapshot.benchmarkPages.keys().next().value);
        snapshot.benchmarkPages.set(key, groups);
    }
    const groups = snapshot.benchmarkPages.get(key);
    return {
        ...page(groups[group], offset, size),
        group,
        grouping,
        groupTotals: Object.fromEntries(BENCHMARK_GROUPS.map(key => [key, groups[key].length]))
    };
}

function page(rows, offset, size) {
    if (offset > rows.length) throw rankingError(400, 'invalid_ranking_offset');
    const items = rows.slice(offset, offset + size);
    return { items, total: rows.length, nextOffset: offset + items.length,
        hasMore: offset + items.length < rows.length };
}

function pageMeta(result) {
    return { total: result.total, nextOffset: result.nextOffset, hasMore: result.hasMore };
}

function fallbackPage(snapshot, conditionID, offset, size = RANKING_PAGE_SIZE.fallbacks) {
    const entrance = snapshot.benchmarks.find(row => row.conditionID === conditionID);
    if (!entrance) throw rankingError(404, 'fallback_entrance_not_found');
    const featured = new Set(entrance.featuredFallbackConfigurations.map(row => row.familyKey));
    const remaining = (snapshot.familiesByEntrance.get(conditionID) ?? []).filter(row => !featured.has(row.familyKey));
    return { ...page(remaining, offset, size), conditionID,
        fallbackConfigCount: entrance.fallbackConfigCount,
        featuredFallbackConfigurations: entrance.featuredFallbackConfigurations };
}

export function createRankingPager({ now = () => Date.now() } = {}) {
    const snapshots = new Map();

    function pruneExpired(time = now()) {
        for (const [id, snapshot] of snapshots) {
            if (snapshot.expiresAt <= time) snapshots.delete(id);
        }
    }

    function evictForInsert() {
        while (snapshots.size >= MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value);
    }

    function read(id, userID) {
        pruneExpired();
        const snapshot = snapshots.get(id);
        if (!snapshot) {
            throw rankingError(410, 'ranking_snapshot_expired');
        }
        if (String(snapshot.userID ?? '') !== String(userID ?? '')) {
            throw rankingError(403, 'ranking_snapshot_forbidden');
        }
        return snapshot;
    }

    function touch(id, snapshot) {
        snapshot.expiresAt = now() + SNAPSHOT_TTL_MS;
        snapshots.delete(id);
        snapshots.set(id, snapshot);
    }

    function getPage({ snapshotID, userID = null, list, group, conditionID, offset = 0, query = '', pinPersonal = false, groupVersions = false }) {
        if (typeof snapshotID !== 'string' || !/^[0-9a-f-]{36}$/.test(snapshotID)) {
            throw rankingError(400, 'invalid_ranking_snapshot');
        }
        if (typeof list !== 'string' || !Object.hasOwn(RANKING_PAGE_SIZE, list)) throw rankingError(400, 'invalid_ranking_list');
        if (list === 'benchmarks' ? !BENCHMARK_GROUPS.includes(group) : group !== undefined) {
            throw rankingError(400, 'invalid_ranking_group');
        }
        if (list === 'fallbacks' ? !Number.isSafeInteger(conditionID) || conditionID < 1 : conditionID !== undefined) {
            throw rankingError(400, 'invalid_fallback_entrance');
        }
        requireOffset(offset);
        if (typeof pinPersonal !== 'boolean') throw rankingError(400, 'invalid_ranking_pin');
        if (typeof groupVersions !== 'boolean') throw rankingError(400, 'invalid_ranking_grouping');
        const normalizedQuery = normalizeQuery(query);
        if (list !== 'benchmarks' && (normalizedQuery || pinPersonal || groupVersions)) {
            throw rankingError(400, 'invalid_model_ranking_filter');
        }
        if (list === 'benchmarks' && !normalizedQuery && !groupVersions && group !== 'primary') {
            throw rankingError(400, 'invalid_ranking_group');
        }
        const snapshot = read(snapshotID, userID);
        let result;
        if (list === 'fallbacks') {
            const entrance = snapshot.benchmarks.find(row => row.conditionID === conditionID);
            if (!entrance) {
                throw rankingError(404, 'fallback_entrance_not_found');
            }
            // Reference cleanup must not skip a surviving configuration on the next page.
            if (offset > 0 && snapshot.fallbackOffsetsChanged) throw rankingError(410, 'ranking_snapshot_expired');
            result = fallbackPage(snapshot, conditionID, offset);
        } else {
            // Removed search terms can change search offsets, but not ordinary unfiltered pages.
            if (list === 'benchmarks' && normalizedQuery && offset > 0 && snapshot.fallbackOffsetsChanged) {
                throw rankingError(410, 'ranking_snapshot_expired');
            }
            result = list === 'benchmarks'
                ? benchmarkPage(snapshot, normalizedQuery, pinPersonal, offset, group, groupVersions)
                : { ...page(snapshot.models[list], offset, RANKING_PAGE_SIZE[list]), scoreMode: snapshot.scoreMode };
        }
        touch(snapshotID, snapshot);
        return result;
    }

    function locateModel({ snapshotID, userID = null, list = 'public', targetModel }) {
        if (typeof snapshotID !== 'string' || !/^[0-9a-f-]{36}$/.test(snapshotID)) {
            throw rankingError(400, 'invalid_ranking_snapshot');
        }
        if (!['personal', 'public'].includes(list)) throw rankingError(400, 'invalid_ranking_list');
        try { targetModel = normalizeModelFocusTarget(targetModel); }
        catch { throw rankingError(400, 'invalid_ranking_target'); }
        const snapshot = read(snapshotID, userID);
        const targetOffset = findModelFocusIndex(snapshot.models[list], targetModel);
        const offset = targetOffset < 0 ? null : Math.floor(targetOffset / RANKING_PAGE_SIZE[list]) * RANKING_PAGE_SIZE[list];
        const result = { snapshotID, list, targetModel, found: targetOffset >= 0,
            targetOffset: targetOffset < 0 ? null : targetOffset, offset,
            page: offset === null ? null : { ...page(snapshot.models[list], offset, RANKING_PAGE_SIZE[list]), scoreMode: snapshot.scoreMode } };
        touch(snapshotID, snapshot);
        return result;
    }

    function searchModels({ snapshotID, userID = null, list = 'public', query = '' }) {
        if (typeof snapshotID !== 'string' || !/^[0-9a-f-]{36}$/.test(snapshotID)) throw rankingError(400, 'invalid_ranking_snapshot');
        if (!['personal', 'public'].includes(list)) throw rankingError(400, 'invalid_ranking_list');
        const snapshot = read(snapshotID, userID);
        const items = searchRankedModels(snapshot.models[list], snapshot.comparison, query);
        touch(snapshotID, snapshot);
        return { snapshotID, list, items };
    }

    function create(workspace, { userID = null, initialMode = 'public', query = '', pinPersonal = false, groupVersions = false, resume } = {}) {
        if (!['personal', 'public'].includes(initialMode)) throw rankingError(400, 'invalid_ranking_mode');
        if (!Array.isArray(workspace.benchmarks)
            || workspace.benchmarks.some(row => typeof row.lowCoverage !== 'boolean'
                || typeof row.isPrimaryCondition !== 'boolean')) {
            throw rankingError(500, 'benchmark_condition_flags_missing');
        }
        const normalizedQuery = normalizeQuery(query);
        if (typeof pinPersonal !== 'boolean') throw rankingError(400, 'invalid_ranking_pin');
        if (typeof groupVersions !== 'boolean') throw rankingError(400, 'invalid_ranking_grouping');
        const progress = normalizeRankingResume(resume);
        const snapshotID = randomUUID();
        const snapshot = {
            userID,
            scoreMode: workspace.scoreMode,
            comparison: workspace.comparison ?? { keys: ['model'], fields: [], models: [] },
            benchmarkPages: new Map(),
            personalWeights: new Map(workspace.personalPie.entries.map(entry => [
                Number(entry.conditionID), Number(entry.weightBasisPoints)
            ])),
            models: {
                personal: rankModels(workspace.modelLeaderboards.personal),
                public: rankModels(workspace.modelLeaderboards.public)
            }
        };
        updateBenchmarkCatalogue(snapshot, workspace.benchmarks);
        const benchmarkPages = Object.fromEntries(BENCHMARK_GROUPS.map(group => [group,
            benchmarkPage(snapshot, normalizedQuery, pinPersonal, 0, group, groupVersions,
                Math.max(group === 'primary' ? RANKING_PAGE_SIZE.benchmarks : 0, progress?.benchmarks[group] ?? 0))]));
        const modelPages = Object.fromEntries(['personal', 'public'].map(mode => [mode,
            page(snapshot.models[mode], 0, Math.max(initialMode === mode ? RANKING_PAGE_SIZE[mode] : 0, progress?.[mode] ?? 0))]));
        const restoredFallbacks = progress?.fallbacks.filter(item => item.depth > 0 && snapshot.familiesByEntrance.has(item.conditionID))
            .map(item => fallbackPage(snapshot, item.conditionID, 0, item.depth));
        const result = {
            ...workspace,
            benchmarks: BENCHMARK_GROUPS.flatMap(group => benchmarkPages[group].items),
            modelLeaderboards: {
                personal: modelPages.personal.items,
                public: modelPages.public.items
            },
            rankingPagination: {
                snapshotID,
                benchmarkGrouping: benchmarkPages.primary.grouping,
                benchmarks: Object.fromEntries(BENCHMARK_GROUPS.map(group => [group, pageMeta(benchmarkPages[group])])),
                personal: pageMeta(modelPages.personal),
                public: pageMeta(modelPages.public),
                ...(progress ? { fallbacks: restoredFallbacks } : {}),
                modelScales: {
                    personal: modelScale(snapshot.models.personal),
                    public: modelScale(snapshot.models.public)
                }
            }
        };
        // Commit only after page construction and all response validation have succeeded.
        const time = now();
        snapshot.expiresAt = time + SNAPSHOT_TTL_MS;
        pruneExpired(time);
        evictForInsert();
        snapshots.set(snapshotID, snapshot);
        return result;
    }

    function retainReferencedFamilies(familyIDs) {
        const referenced = new Set(familyIDs);
        pruneExpired();
        for (const snapshot of snapshots.values()) {
            const retained = snapshot.catalogue.filter(row => !row.isFamily
                || row.familyID === null || referenced.has(row.familyID));
            if (retained.length === snapshot.catalogue.length) continue;
            snapshot.fallbackOffsetsChanged = true;
            updateBenchmarkCatalogue(snapshot, retained);
        }
    }

    return { create, getPage, locateModel, searchModels, retainReferencedFamilies };
}
