// Superseded and archived observations are audit history, not additional measurements.
export function currentScoreSQL(alias = 'benchmark_results') {
    if (typeof alias !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) {
        throw new TypeError('Invalid score table alias');
    }
    return `${alias}.status = 'accepted'`;
}

export function scoreValueKey(modelID, benchmarkConditionID, rawScore, fields = []) {
    const value = Number(rawScore);
    if (rawScore === null || rawScore === undefined || rawScore === '' || !Number.isFinite(value)) {
        throw new Error('Invalid score value');
    }
    return JSON.stringify([Number(modelID), Number(benchmarkConditionID), [...fields].sort((a, b) => a.fieldID - b.fieldID), value]);
}

// Exact evidence prevents repeated submissions; aggregation separately deduplicates values.
export function scoreEvidenceKey(modelID, benchmarkConditionID, sourceURL, rawScore, fields = []) {
    const url = new URL(sourceURL);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid score source URL');
    url.hash = '';
    return JSON.stringify([scoreValueKey(modelID, benchmarkConditionID, rawScore, fields), url.href]);
}
