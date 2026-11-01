export function actualScoreFallbackPath(score) {
    if (score.fallbackFor === null) return [score.conditionID];
    const chain = score.familyConditionIDs;
    if (!Array.isArray(chain) || chain[0] !== score.fallbackFor
        || chain.some(ID => !Number.isSafeInteger(ID) || ID < 1)
        || new Set(chain).size !== chain.length) {
        throw new TypeError('Invalid calculation fallback path');
    }
    const usedIndex = chain.indexOf(score.conditionID);
    if (usedIndex < 1) throw new TypeError('Fallback path does not contain the used score');
    return chain.slice(0, usedIndex + 1);
}
