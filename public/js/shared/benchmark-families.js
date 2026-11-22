export const FALLBACK_RULE_MODE = 'ordered';
export const SMALL_FAMILY_SHARE_BASIS_POINTS = 300;
export const FALLBACK_CONFIGURATION_VERSION = 2;
export const portableFamilyEntry = entry => ({ conditionID: entry.conditionID });
export const familyEntryKey = entry => entry.conditionID;

export function familyKey(primaryConditionID, entries = []) {
    if (!Number.isSafeInteger(primaryConditionID) || primaryConditionID < 1 || !Array.isArray(entries)) {
        throw new TypeError('Invalid benchmark family');
    }
    const seen = new Set([primaryConditionID]);
    const IDs = entries.map(entry => {
        const ID = entry?.conditionID;
        if (!Number.isSafeInteger(ID) || ID < 1 || seen.has(ID) || Object.hasOwn(entry, 'kind')) throw new TypeError('Invalid family member');
        seen.add(ID);
        return ID;
    });
    return JSON.stringify([primaryConditionID, ...IDs]);
}

export function resolvedFamilyConditionIDs(primaryConditionID, entries = []) {
    familyKey(primaryConditionID, entries);
    return [primaryConditionID, ...entries.map(entry => entry.conditionID)];
}

// The caller supplies a calibration for the primary and each actual backup score.
export function resolveFallbackChain(model, chain, predict) {
    for (const [index, conditionID] of chain.entries()) {
        const normalizedScore = model.results.get(String(conditionID))?.normalizedScore;
        if (normalizedScore == null) continue;
        if (!Number.isFinite(normalizedScore)) throw new TypeError('Invalid normalized family score');
        if (index === 0) return { normalizedScore, prediction: null, attemptedCount: 1 };
        const prediction = predict(conditionID, normalizedScore);
        if (prediction) return { normalizedScore: null, prediction, attemptedCount: index + 1 };
    }
    return { normalizedScore: null, prediction: null, attemptedCount: chain.length };
}

export function groupSmallFamilies(families, threshold = SMALL_FAMILY_SHARE_BASIS_POINTS) {
    if (!Array.isArray(families) || !Number.isFinite(threshold) || threshold < 0 || threshold > 10000) {
        throw new TypeError('Invalid family composition');
    }
    const sorted = [...families].sort((a, b) => b.weightBasisPoints - a.weightBasisPoints
        || familyKey(a.primaryConditionID, a.entries).localeCompare(familyKey(b.primaryConditionID, b.entries)));
    if (sorted.some(family => !Number.isFinite(family.weightBasisPoints) || family.weightBasisPoints <= 0)
        || (sorted.length && Math.abs(sorted.reduce((sum, family) => sum + family.weightBasisPoints, 0) - 10000) > 1e-6)) {
        throw new TypeError('Family shares must total 100 percent');
    }
    const visible = sorted.filter(family => family.weightBasisPoints >= threshold);
    const other = sorted.filter(family => family.weightBasisPoints < threshold);
    return { visible, other, otherWeightBasisPoints: other.reduce((sum, family) => sum + family.weightBasisPoints, 0) };
}
