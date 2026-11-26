const positiveID = value => Number.isSafeInteger(value) && value > 0;

// The wire names also identify the currently inspected/scoring version on writes.
// Persisted ballots always place the smaller ID first, independent of that view.
export function estimationPair(first, second) {
    if (!positiveID(first) || !positiveID(second) || first === second) throw new TypeError('Invalid estimation pair');
    return first < second ? { targetConditionID: first, sourceConditionID: second }
        : { targetConditionID: second, sourceConditionID: first };
}

export function estimationVotePairKey(a, b) {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function compareEstimationVotePairs(left, right) {
    return left.targetConditionID - right.targetConditionID || left.sourceConditionID - right.sourceConditionID;
}

export function normalizeEstimationVotes(votes) {
    if (!Array.isArray(votes)) throw new TypeError('Estimation votes must be an array');
    const seen = new Set();
    return Array.from(votes, entry => {
        if (!entry || Object.keys(entry).length !== 3 || !['support', 'oppose'].includes(entry.vote)) throw new TypeError('Invalid estimation vote');
        const pair = estimationPair(entry.targetConditionID, entry.sourceConditionID);
        const key = estimationVotePairKey(pair.targetConditionID, pair.sourceConditionID);
        if (seen.has(key)) throw new TypeError('Duplicate estimation vote');
        seen.add(key);
        return { ...pair, vote: entry.vote };
    }).sort(compareEstimationVotePairs);
}

export function withEstimationVote(votes, a, b, vote) {
    const key = estimationVotePairKey(a, b);
    const next = votes.filter(row => estimationVotePairKey(row.targetConditionID, row.sourceConditionID) !== key);
    if (vote !== null) next.push({ ...estimationPair(a, b), vote });
    return next.sort(compareEstimationVotePairs);
}
