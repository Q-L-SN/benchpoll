const HASH_SUFFIX = /\s+\[[0-9a-f]{12}\]$/i;
const REQUIRED_KEYS = ['dataset_id', 'config', 'split', 'metric'];

function originalName(condition, originalNames) {
    const name = String(condition.name ?? '');
    if (!HASH_SUFFIX.test(name)) return name;
    const originals = originalNames.get(Number(condition.ID));
    if (!originals?.length || originals.length !== Number(condition.resultCount)) return null;
    const prefix = name.replace(HASH_SUFFIX, '').trimEnd();
    if (originals.some(value => typeof value !== 'string' || !value.startsWith(prefix))) return null;
    return new Set(originals).size === 1 ? originals[0] : null;
}

export function canonicalMtebCondition(condition, originalNames = new Map()) {
    const name = originalName(condition, originalNames);
    if (!name || !/\bmteb\b/i.test(`${condition.benchmark_name ?? ''} ${name}`)) return null;
    const clauses = new Map();
    for (const part of name.split(';')) {
        const clause = part.trim().replace(/^MTEB\s+task=/i, 'task=');
        if (/^score scale 0-100$/i.test(clause)) continue;
        const separator = clause.indexOf('=');
        if (separator <= 0 || separator === clause.length - 1) return null;
        const key = clause.slice(0, separator).trim().toLowerCase();
        const value = clause.slice(separator + 1).trim().replace(/\s+/g, ' ').toLowerCase();
        if (!key || !value || clauses.has(key)) return null;
        clauses.set(key, value);
    }
    if (REQUIRED_KEYS.some(key => !clauses.has(key))
        || !/^[a-z][a-z0-9_.@-]{2,}$/.test(clauses.get('metric'))) return null;
    return JSON.stringify([...clauses].sort(([left], [right]) => left.localeCompare(right)));
}

function scoreSignature(condition) {
    return JSON.stringify([
        condition.score_direction, condition.target_value,
        Number(condition.uses_percentage_scale), condition.score_min, condition.score_max
    ]);
}

export function buildMtebConsolidationPlan(conditions, originalNames = new Map(), protectedIDs = new Set()) {
    const groups = new Map();
    for (const condition of conditions) {
        if (condition.deleted_at !== null && condition.deleted_at !== undefined) continue;
        const canonical = canonicalMtebCondition(condition, originalNames);
        if (canonical === null) continue;
        const key = JSON.stringify([Number(condition.benchmark_ID), canonical, scoreSignature(condition)]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(condition);
    }
    const merges = [];
    let protectedGroups = 0;
    for (const group of groups.values()) {
        if (group.length < 2) continue;
        const protectedMembers = group.filter(item => protectedIDs.has(Number(item.ID)));
        if (protectedMembers.length > 1) {
            protectedGroups++;
            continue;
        }
        const sorted = [...group].sort((a, b) =>
            Number(protectedIDs.has(Number(b.ID))) - Number(protectedIDs.has(Number(a.ID)))
            || Number(HASH_SUFFIX.test(a.name)) - Number(HASH_SUFFIX.test(b.name))
            || Number(b.resultCount) - Number(a.resultCount)
            || Number(a.ID) - Number(b.ID));
        const target = sorted[0];
        for (const source of sorted.slice(1)) {
            merges.push({ sourceID: Number(source.ID), targetID: Number(target.ID),
                benchmarkID: Number(source.benchmark_ID), resultCount: Number(source.resultCount) });
        }
    }
    merges.sort((a, b) => a.sourceID - b.sourceID);
    return { merges, eligibleGroups: groups.size, protectedGroups };
}
