const PROVENANCE_PREFIX = /^\[p:[0-9a-f]{12}\]\s*/i;
const TRUNCATION_SUFFIX = /\s+\[[0-9a-f]{12}\]$/i;
const RESTORABLE_TRUNCATED_NAME = /^(?:v8-benchv0\.1;\s*native snapshot=|CodeAgentBench;)/i;
const PROVENANCE_CLAUSE = /^(?:run|seed|status|native snapshot|profile_snapshot_date|page_updated|BenchmarkList_display_rank|BenchmarkList_display_category)\s*=/i;
const RANK_CLAUSE = /^ranking position \d+ of \d+$/i;
const CONFIDENCE_REPORT_CLAUSE = /^(?:confidence interval\b|95%\s*CI\b|CI not numerically specified$|bold means best or overlaps\s*95%\s*CI\b)/i;

export function needsOriginalConditionName(name) {
    return TRUNCATION_SUFFIX.test(name);
}

export function cleanBenchmarkConditionName(name, originalName = null) {
    if (typeof name !== 'string') return null;
    if (needsOriginalConditionName(name) && !RESTORABLE_TRUNCATED_NAME.test(name)) return null;
    const source = needsOriginalConditionName(name) ? originalName : name;
    if (typeof source !== 'string' || !source.trim()) return null;
    if (needsOriginalConditionName(name) && !source.startsWith(name.replace(TRUNCATION_SUFFIX, '').trimEnd())) return null;
    const withoutHashes = source.replace(PROVENANCE_PREFIX, '').replace(TRUNCATION_SUFFIX, '');
    const parts = withoutHashes.split(';').map(part => part.trim()).filter(Boolean);
    const isExploitRun = /^v8-benchv0\.1;\s*native snapshot=/i.test(withoutHashes);
    const isCodeAgentRun = /^CodeAgentBench;/i.test(withoutHashes);
    const retained = parts.filter(part => !PROVENANCE_CLAUSE.test(part) && !RANK_CLAUSE.test(part)
        && !CONFIDENCE_REPORT_CLAUSE.test(part) && !/^one run$/i.test(part)
        && !(isExploitRun && /^experiment\s*=/i.test(part))
        && !(isCodeAgentRun && /^(?:export|updated)\s*=/i.test(part)));
    if (source === name && withoutHashes === source && retained.length === parts.length) return null;
    const cleaned = retained
        .join('; ');
    if (!cleaned || cleaned.length > 192 || cleaned.toLowerCase() === 'default') return null;
    return cleaned === name ? null : cleaned;
}

function scoreSignature(condition) {
    return JSON.stringify([
        condition.score_direction, condition.target_value,
        Number(condition.uses_percentage_scale), condition.score_min, condition.score_max
    ]);
}

export function buildBenchmarkConditionCleanupPlan(conditions, originalNames, protectedIDs) {
    const groups = new Map();
    const skipped = { missingOriginal: 0, mismatchedOriginal: 0, divergentOriginal: 0, incompatibleScoreScale: 0, referenced: 0 };
    let candidates = 0;
    for (const condition of conditions) {
        if (condition.deleted_at !== null && condition.deleted_at !== undefined) continue;
        let cleaned = null;
        if (!Number(condition.is_default)) {
            if (needsOriginalConditionName(condition.name)) {
                const originals = originalNames.get(Number(condition.ID));
                if (!originals?.length || originals.length !== Number(condition.resultCount)) {
                    skipped.missingOriginal++;
                } else {
                    const names = new Set(originals.map(name => cleanBenchmarkConditionName(condition.name, name)));
                    if (names.size === 1) {
                        cleaned = [...names][0];
                        if (!cleaned) skipped.mismatchedOriginal++;
                    } else skipped.divergentOriginal++;
                }
            } else cleaned = cleanBenchmarkConditionName(condition.name);
        }
        if (cleaned) candidates++;
        const targetName = cleaned ?? condition.name;
        const groupKey = JSON.stringify([Number(condition.benchmark_ID), targetName]);
        if (!groups.has(groupKey)) groups.set(groupKey, []);
        groups.get(groupKey).push({ ...condition, targetName, changed: Boolean(cleaned) });
    }
    const renames = [];
    const merges = [];
    const affectedBenchmarks = new Map();
    for (const group of groups.values()) {
        if (!group.some(item => item.changed)) continue;
        if (new Set(group.map(scoreSignature)).size !== 1) {
            skipped.incompatibleScoreScale += group.length;
            continue;
        }
        if (group.some(item => protectedIDs.has(Number(item.ID)))) {
            skipped.referenced += group.length;
            continue;
        }
        const sorted = [...group].sort((a, b) => Number(a.changed) - Number(b.changed)
            || Number(b.resultCount) - Number(a.resultCount) || Number(a.ID) - Number(b.ID));
        const survivor = sorted[0];
        if (survivor.name !== survivor.targetName) renames.push({ ID: Number(survivor.ID), name: survivor.targetName });
        for (const source of sorted.slice(1)) merges.push({ sourceID: Number(source.ID), targetID: Number(survivor.ID),
            benchmarkID: Number(source.benchmark_ID), resultCount: Number(source.resultCount) });
        affectedBenchmarks.set(Number(survivor.benchmark_ID),
            (affectedBenchmarks.get(Number(survivor.benchmark_ID)) ?? 0) + group.length - 1);
    }
    renames.sort((a, b) => a.ID - b.ID);
    merges.sort((a, b) => a.sourceID - b.sourceID);
    return { candidates, renames, merges, skipped,
        affectedBenchmarks: [...affectedBenchmarks].sort((a, b) => b[1] - a[1] || a[0] - b[0]) };
}
