export function normalizeEstimationVotes(votes) {
    if (!Array.isArray(votes)) throw new TypeError('Estimation votes must be an array');
    const conditionIDs = new Set();
    const normalized = [];
    for (const entry of votes) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 2
            || !Object.hasOwn(entry, 'conditionID') || !Object.hasOwn(entry, 'vote')
            || !Number.isSafeInteger(entry.conditionID) || entry.conditionID < 1
            || (entry.vote !== 'support' && entry.vote !== 'oppose')
            || conditionIDs.has(entry.conditionID)) {
            throw new TypeError('Invalid estimation vote');
        }
        conditionIDs.add(entry.conditionID);
        normalized.push({ conditionID: entry.conditionID, vote: entry.vote });
    }
    return normalized.sort((left, right) => left.conditionID - right.conditionID);
}
