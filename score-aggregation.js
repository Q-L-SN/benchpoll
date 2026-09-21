export function scoreValueKey(modelConditionID, benchmarkConditionID, rawScore) {
    const value = Number(rawScore);
    if (rawScore === null || rawScore === undefined || rawScore === '' || !Number.isFinite(value)) {
        throw new Error('Invalid score value');
    }
    return JSON.stringify([Number(modelConditionID), Number(benchmarkConditionID), value]);
}

// Exact evidence prevents repeated submissions; aggregation separately deduplicates values.
export function scoreEvidenceKey(modelConditionID, benchmarkConditionID, sourceURL, rawScore) {
    const url = new URL(sourceURL);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid score source URL');
    url.hash = '';
    return JSON.stringify([scoreValueKey(modelConditionID, benchmarkConditionID, rawScore), url.href]);
}
