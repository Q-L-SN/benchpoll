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
        const blockedByBenchmark = new Map();
        for (const key of [...blocked].sort()) {
            const [target, source] = key.split(':').map(Number);
            const versions = siblingsByID.get(target);
            if (!versions || versions !== siblingsByID.get(source)) continue;
            if (!blockedByBenchmark.has(versions)) blockedByBenchmark.set(versions, []);
            blockedByBenchmark.get(versions).push({ key, target, source });
        }
        const policies = new Map();
        return entries.map(({ conditionID, weightBasisPoints }) => {
            if (!policies.has(conditionID)) {
                const versions = siblingsByID.get(conditionID) ?? [];
                const estimationSourceIDs = versions.filter(ID => ID !== conditionID && !blocked.has(estimationVotePairKey(conditionID, ID)));
                const eligible = new Set(estimationSourceIDs);
                const blockedEstimationPairs = (blockedByBenchmark.get(versions) ?? [])
                    .filter(pair => eligible.has(pair.source) && eligible.has(pair.target)).map(pair => pair.key);
                policies.set(conditionID, { estimationSourceIDs, ...(blockedEstimationPairs.length ? { blockedEstimationPairs } : {}) });
            }
            return { conditionID, weightBasisPoints, ...policies.get(conditionID) };
        });
    };
}
