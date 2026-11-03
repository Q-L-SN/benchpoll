export function benchmarkVersionTieOrder(left, right) {
    for (const version of [left, right]) {
        const reference = version.type === 'topic' && Number.isSafeInteger(version.referenceContextID)
            && version.referenceContextID > 0 && version.conditionID === -version.referenceContextID;
        if (typeof version.isPrimaryCondition !== 'boolean' || !Number.isSafeInteger(version.scoreCount)
            || version.scoreCount < 0 || !Number.isSafeInteger(version.conditionID) || !reference && version.conditionID < 1) {
            throw new TypeError('Version ordering requires primary status, approved score count and condition ID');
        }
    }
    return Number(Boolean(right.isPrimaryCondition)) - Number(Boolean(left.isPrimaryCondition))
        || right.scoreCount - left.scoreCount
        || Number(left.conditionID) - Number(right.conditionID);
}
