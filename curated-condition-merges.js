function positiveID(value) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Invalid condition ID: ${value}`);
    return id;
}

function scoreSignature(row) {
    return JSON.stringify([
        row.score_direction,
        row.target_value == null ? null : Number(row.target_value),
        Number(row.uses_percentage_scale),
        row.score_min == null ? null : Number(row.score_min),
        row.score_max == null ? null : Number(row.score_max)
    ]);
}

export function buildCuratedConditionMergePlan(spec, conditions, protectedIDs = new Set()) {
    if (!spec || !Array.isArray(spec.groups) || !spec.groups.length) {
        throw new Error('The curated plan must contain at least one group.');
    }
    const byID = new Map(conditions.map(row => [positiveID(row.ID), row]));
    const usedIDs = new Set();
    const groups = [];
    const merges = [];
    for (const input of spec.groups) {
        const targetID = positiveID(input.targetID);
        if (!Array.isArray(input.sourceIDs) || !input.sourceIDs.length) {
            throw new Error(`Merge target ${targetID} has no sources.`);
        }
        if (typeof input.reason !== 'string' || !input.reason.trim()) {
            throw new Error(`Merge target ${targetID} lacks a rationale.`);
        }
        const additions = input.sourceFieldAdditions ?? [];
        if (!Array.isArray(additions) || new Set(additions.map(item => positiveID(item.fieldID))).size !== additions.length) {
            throw new Error(`Invalid or repeated source field additions for ${targetID}.`);
        }
        const target = byID.get(targetID);
        if (!target || target.deleted_at != null) throw new Error(`Deleted or missing target ${targetID}.`);
        if (input.benchmarkName !== undefined && input.benchmarkName !== target.benchmark_name) {
            throw new Error(`Benchmark name changed for target ${targetID}.`);
        }
        const newName = input.targetName ?? target.name;
        if (typeof newName !== 'string' || !newName.trim() || newName.length > 192) {
            throw new Error(`Invalid target name for ${targetID}.`);
        }
        const targetScale = input.targetScale ?? null;
        if (targetScale !== null) {
            if (typeof targetScale.usesPercentageScale !== 'boolean'
                || targetScale.usesPercentageScale
                || !Number.isFinite(targetScale.scoreMin)
                || !Number.isFinite(targetScale.scoreMax)
                || targetScale.scoreMax <= targetScale.scoreMin) {
                throw new Error(`Invalid reviewed target scale for ${targetID}.`);
            }
        }
        if (usedIDs.has(targetID)) throw new Error(`Condition ${targetID} appears in multiple groups.`);
        usedIDs.add(targetID);
        const sourceIDs = [...new Set(input.sourceIDs.map(positiveID))].sort((a, b) => a - b);
        if (sourceIDs.length !== input.sourceIDs.length) throw new Error(`Duplicate sources for ${targetID}.`);
        const sources = sourceIDs.map(id => {
            if (usedIDs.has(id)) throw new Error(`Condition ${id} appears in multiple groups.`);
            usedIDs.add(id);
            const source = byID.get(id);
            if (!source || source.deleted_at != null) throw new Error(`Deleted or missing source ${id}.`);
            if (Number(source.benchmark_ID) !== Number(target.benchmark_ID)) {
                throw new Error(`Conditions ${id} and ${targetID} belong to different benchmarks.`);
            }
            if (scoreSignature(source) !== scoreSignature(target)) {
                throw new Error(`Conditions ${id} and ${targetID} use different score scales.`);
            }
            if (Number(source.is_default)) throw new Error(`Default condition ${id} must survive its merge.`);
            if (protectedIDs.has(id)) throw new Error(`Condition ${id} has live pie or discussion references.`);
            merges.push({ sourceID: id, targetID, resultCount: Number(source.resultCount) });
            return { ID: id, name: source.name, resultCount: Number(source.resultCount) };
        });
        groups.push({ benchmarkID: Number(target.benchmark_ID), benchmarkName: target.benchmark_name,
            targetID, targetName: target.name, newName, targetScale,
            scoreSignature: scoreSignature(target),
            targetResultCount: Number(target.resultCount), sourceIDs, sources,
            sourceFieldAdditions: additions, reason: input.reason.trim() });
    }
    groups.sort((a, b) => a.targetID - b.targetID);
    merges.sort((a, b) => a.sourceID - b.sourceID);
    const names = new Set();
    for (const group of groups) {
        const key = `${group.benchmarkID}:${group.newName.trim().toLowerCase()}`;
        if (names.has(key)) throw new Error(`Multiple curated targets would share the name ${group.newName}.`);
        names.add(key);
    }
    const renames = groups.filter(group => group.newName !== group.targetName)
        .map(group => ({ ID: group.targetID, name: group.newName }));
    const scaleUpdates = groups.filter(group => group.targetScale)
        .map(group => ({ ID: group.targetID, ...group.targetScale }));
    return { groups, merges, renames, scaleUpdates };
}
