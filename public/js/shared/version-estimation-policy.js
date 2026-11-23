import { excludedFromRanking } from './aa-ranking-policy.js';
import { estimationVotePairKey } from './estimation-votes.js';

// The catalogue is shared across a ranking read. Ballots belong to the scene that
// supplied the weight, including when that scene is reached through another topic.
export function createVersionEstimationPlanner(conditions) {
    const versionsByBenchmark = new Map();
    const siblingsByID = new Map();
    for (const condition of conditions) {
        if (!Number.isSafeInteger(condition.benchmarkID) || condition.benchmarkID <= 0
            || !Number.isSafeInteger(condition.conditionID) || condition.conditionID <= 0 || excludedFromRanking(condition)) continue;
        if (!versionsByBenchmark.has(condition.benchmarkID)) versionsByBenchmark.set(condition.benchmarkID, []);
        const versions = versionsByBenchmark.get(condition.benchmarkID);
        versions.push(condition.conditionID);
        siblingsByID.set(condition.conditionID, versions);
    }
    for (const versions of versionsByBenchmark.values()) versions.sort((a, b) => a - b);

    return (entries, communityVotes = [], personalVotes = []) => {
        const blocked = new Set(communityVotes.filter(row => row.opposeCount > row.supportCount)
            .map(row => estimationVotePairKey(row.targetConditionID, row.sourceConditionID)));
        for (const { targetConditionID, sourceConditionID, vote } of personalVotes) {
            const pair = estimationVotePairKey(targetConditionID, sourceConditionID);
            if (vote === 'oppose') blocked.add(pair);
            else if (vote === 'support') blocked.delete(pair);
        }
        const sources = new Map();
        return entries.map(({ conditionID, weightBasisPoints }) => {
            if (!sources.has(conditionID)) sources.set(conditionID, (siblingsByID.get(conditionID) ?? [])
                .filter(ID => ID !== conditionID && !blocked.has(estimationVotePairKey(conditionID, ID))));
            return { conditionID, weightBasisPoints, estimationSourceIDs: sources.get(conditionID) };
        });
    };
}
