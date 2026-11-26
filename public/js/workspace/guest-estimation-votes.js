import { estimationVotePairKey, normalizeEstimationVotes, withEstimationVote } from '../shared/estimation-votes.js';

const key = 'benchpoll:guest-estimation-pairs:v1';
let memory = [];
export function guestEstimationVotes(catalogue, externalPairs = []) {
    try {
        const stored = sessionStorage.getItem(key);
        if (stored) memory = normalizeEstimationVotes(JSON.parse(stored));
    } catch { /* The current tab still has its votes. */ }
    if (!memory.length || !catalogue) return memory;
    const groups = new Map(catalogue.flatMap(group => group.versions.map(version => [version.conditionID, group.benchmarkID])));
    const nominated = new Set(externalPairs.map(row => estimationVotePairKey(row.targetConditionID, row.sourceConditionID)));
    return memory.filter(({ targetConditionID: a, sourceConditionID: b }) => groups.has(a) && groups.has(b)
        && (groups.get(a) === groups.get(b) || nominated.has(estimationVotePairKey(a, b))));
}
function store(votes) {
    memory = votes;
    try { sessionStorage.setItem(key, JSON.stringify(memory)); } catch { /* Keep the session preference in memory. */ }
    return memory;
}
export function setGuestEstimationVote(a, b, vote) {
    return store(withEstimationVote(guestEstimationVotes(), a, b, vote));
}
export function clearImportedGuestEstimationVotes(imported) {
    const choices = new Map(imported.map(row => [estimationVotePairKey(row.targetConditionID, row.sourceConditionID), row.vote]));
    return store(guestEstimationVotes().filter(row => choices.get(estimationVotePairKey(row.targetConditionID, row.sourceConditionID)) !== row.vote));
}
