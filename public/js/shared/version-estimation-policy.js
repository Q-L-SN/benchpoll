import { excludedFromRanking } from './aa-ranking-policy.js';
import { estimationVotePairKey } from './estimation-votes.js';

export function createVersionEstimationPlanner(conditions, externalPairs = []) {
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

    const externalByID = new Map();
    for (const { targetConditionID: a, sourceConditionID: b } of externalPairs) {
        if (!siblingsByID.has(a) || !siblingsByID.has(b) || siblingsByID.get(a) === siblingsByID.get(b)) continue;
        for (const [id, other] of [[a,b], [b,a]]) {
            if (!externalByID.has(id)) externalByID.set(id, new Set());
            externalByID.get(id).add(other);
        }
    }

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
                const externalSourceIDs = [...externalByID.get(conditionID) ?? []].filter(id => !blocked.has(estimationVotePairKey(conditionID, id))).sort((a,b) => a-b);
                policies.set(conditionID, { estimationSourceIDs, ...(externalSourceIDs.length ? { externalSourceIDs } : {}), ...(blockedEstimationPairs.length ? { blockedEstimationPairs } : {}) });
            }
            return { conditionID, weightBasisPoints, ...policies.get(conditionID) };
        });
    };
}
