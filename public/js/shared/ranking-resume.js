import { BENCHMARK_GROUPS } from './benchmark-condition-groups.js';
import { FALLBACK_CONFIGURATION_PAGE_SIZE } from './fallback-catalogue-policy.js';

export const RANKING_PAGE_SIZE = Object.freeze({ benchmarks: 40, fallbacks: FALLBACK_CONFIGURATION_PAGE_SIZE, personal: 25, public: 25 });

function invalidResume() {
    throw { status: 400, body: { error: 'invalid_ranking_resume' } };
}

function record(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !keys.includes(key))) invalidResume();
    return value;
}

function depth(value) {
    if (!Number.isSafeInteger(value) || value < 0) invalidResume();
    return value;
}

export function normalizeRankingResume(value) {
    if (value == null) return null;
    const input = record(value, ['benchmarks', 'personal', 'public', 'fallbacks']);
    const benchmarks = record(input.benchmarks, BENCHMARK_GROUPS);
    if (!Array.isArray(input.fallbacks)) invalidResume();
    const seen = new Set();
    return {
        benchmarks: Object.fromEntries(BENCHMARK_GROUPS.map(group => [group, depth(benchmarks[group])])),
        personal: depth(input.personal), public: depth(input.public),
        fallbacks: input.fallbacks.map(value => {
            const item = record(value, ['conditionID', 'depth']);
            if (!Number.isSafeInteger(item.conditionID) || item.conditionID < 1 || seen.has(item.conditionID)) invalidResume();
            seen.add(item.conditionID);
            return { conditionID: item.conditionID, depth: depth(item.depth) };
        })
    };
}

export function captureRankingResume(pagination, { requests = [], fallbacks = [] } = {}) {
    const resume = normalizeRankingResume({
        benchmarks: Object.fromEntries(BENCHMARK_GROUPS.map(group => [group, pagination.benchmarks[group].nextOffset])),
        personal: pagination.personal.nextOffset, public: pagination.public.nextOffset, fallbacks
    });
    for (const { list, group, conditionID, offset } of requests) {
        if (!Object.hasOwn(RANKING_PAGE_SIZE, list)) invalidResume();
        const end = Math.min(Number.MAX_SAFE_INTEGER, depth(offset) + RANKING_PAGE_SIZE[list]);
        if (list === 'benchmarks') {
            if (!BENCHMARK_GROUPS.includes(group)) invalidResume();
            resume.benchmarks[group] = Math.max(resume.benchmarks[group], end);
        } else if (list === 'fallbacks') {
            if (!Number.isSafeInteger(conditionID) || conditionID < 1) invalidResume();
            const item = resume.fallbacks.find(item => item.conditionID === conditionID);
            if (item) item.depth = Math.max(item.depth, end);
            else resume.fallbacks.push({ conditionID, depth: end });
        } else resume[list] = Math.max(resume[list], end);
    }
    return resume;
}
