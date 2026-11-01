import { normalizeScoreFields } from '../public/js/shared/score-fields.js';

export function reviewedFieldAdditions(spec, plan, catalog) {
    const allowed = new Set(plan.groups.flatMap(group => [group.targetID, ...group.sourceIDs]));
    const byCondition = new Map();
    for (const [id, name] of Object.entries(spec.expectedFieldNames ?? {})) {
        if (catalog.find(field => field.ID === Number(id))?.name !== name) {
            throw new Error(`Reviewed field ${id} no longer has the expected name ${name}.`);
        }
    }
    const add = (conditionID, entries) => {
        if (!Number.isSafeInteger(conditionID) || !allowed.has(conditionID)) {
            throw new Error(`Field additions reference an unreviewed condition ${conditionID}.`);
        }
        const normalized = normalizeScoreFields(entries, catalog);
        const previous = byCondition.get(conditionID) ?? [];
        for (const entry of normalized) {
            const existing = previous.find(item => item.fieldID === entry.fieldID);
            if (existing && existing.value !== entry.value) {
                throw new Error(`Contradictory reviewed field ${entry.fieldID} on condition ${conditionID}.`);
            }
            if (!existing) previous.push(entry);
        }
        byCondition.set(conditionID, previous);
    };
    for (const group of plan.groups) {
        if (group.sourceFieldAdditions.length) {
            for (const id of group.sourceIDs) add(id, group.sourceFieldAdditions);
        }
    }
    if (spec.conditionFieldAdditions !== undefined && !Array.isArray(spec.conditionFieldAdditions)) {
        throw new Error('Reviewed condition field additions must be an array.');
    }
    const declared = new Set();
    for (const item of spec.conditionFieldAdditions ?? []) {
        if (declared.has(item.conditionID) || !Array.isArray(item.entries) || !item.entries.length) {
            throw new Error(`Duplicate or empty field declaration on condition ${item.conditionID}.`);
        }
        declared.add(item.conditionID);
        add(item.conditionID, item.entries);
    }
    return byCondition;
}

export function extendReviewedScoreFields(assignments, additions, catalog, resultID) {
    const normalized = normalizeScoreFields(assignments, catalog);
    const missing = [];
    for (const entry of normalizeScoreFields(additions, catalog)) {
        const existing = normalized.find(item => item.fieldID === entry.fieldID);
        if (existing && existing.value !== entry.value) {
            throw new Error(`Conflicting score field ${entry.fieldID} on result ${resultID}.`);
        }
        if (!existing) missing.push(entry);
    }
    return missing.length ? normalizeScoreFields([...assignments, ...missing], catalog) : null;
}

export function reviewedResultFieldAdditions(spec, plan, catalog) {
    if (spec.resultFieldAdditions !== undefined && !Array.isArray(spec.resultFieldAdditions)) {
        throw new Error('Reviewed result field additions must be an array.');
    }
    const allowed = new Set(plan.groups.flatMap(group => [group.targetID, ...group.sourceIDs]));
    const byResult = new Map();
    for (const item of spec.resultFieldAdditions ?? []) {
        if (!Number.isSafeInteger(item.resultID) || item.resultID <= 0
            || !Number.isSafeInteger(item.conditionID) || !allowed.has(item.conditionID)
            || byResult.has(item.resultID) || !Array.isArray(item.entries) || !item.entries.length) {
            throw new Error(`Invalid or duplicate result field declaration on result ${item.resultID}.`);
        }
        byResult.set(item.resultID, { conditionID: item.conditionID,
            entries: normalizeScoreFields(item.entries, catalog) });
    }
    return byResult;
}

export function combinedReviewedFieldAdditions(conditionEntries = [], resultEntries = [], catalog) {
    const combined = normalizeScoreFields(conditionEntries, catalog);
    for (const entry of normalizeScoreFields(resultEntries, catalog)) {
        const previous = combined.find(item => item.fieldID === entry.fieldID);
        if (previous && previous.value !== entry.value) {
            throw new Error(`Conflicting condition and result declarations for field ${entry.fieldID}.`);
        }
        if (!previous) combined.push(entry);
    }
    return normalizeScoreFields(combined, catalog);
}
