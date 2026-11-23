const positiveConditionID = value => Number.isSafeInteger(value) && value > 0;

export function estimationVotePairKey(targetConditionID, sourceConditionID) {
    return `${targetConditionID}:${sourceConditionID}`;
}

export function compareEstimationVotePairs(left, right) {
    return left.targetConditionID - right.targetConditionID || left.sourceConditionID - right.sourceConditionID;
}

function normalizeVotes(votes, allowLegacy) {
    if (!Array.isArray(votes)) throw new TypeError('Estimation votes must be an array');
    const pairs = new Set();
    const normalized = [];
    for (const entry of votes) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Object.hasOwn(entry, 'vote')
            || (entry.vote !== 'support' && entry.vote !== 'oppose')) {
            throw new TypeError('Invalid estimation vote');
        }
        const fieldCount = Object.keys(entry).length;
        if (allowLegacy && fieldCount === 2 && Object.hasOwn(entry, 'conditionID') && positiveConditionID(entry.conditionID)) continue;

        const { targetConditionID, sourceConditionID, vote } = entry;
        if (fieldCount !== 3 || !Object.hasOwn(entry, 'targetConditionID') || !Object.hasOwn(entry, 'sourceConditionID')
            || !positiveConditionID(targetConditionID) || !positiveConditionID(sourceConditionID)
            || targetConditionID === sourceConditionID) {
            throw new TypeError('Invalid estimation vote');
        }
        const key = estimationVotePairKey(targetConditionID, sourceConditionID);
        if (pairs.has(key)) throw new TypeError('Invalid estimation vote');
        pairs.add(key);
        normalized.push({ targetConditionID, sourceConditionID, vote });
    }
    return normalized.sort(compareEstimationVotePairs);
}

export function normalizeEstimationVotes(votes) {
    return normalizeVotes(votes, false);
}

export function normalizePersistedEstimationVotes(votes) {
    // Legacy ballots identify the source alone, so their direction cannot be recovered.
    return normalizeVotes(votes, true);
}
