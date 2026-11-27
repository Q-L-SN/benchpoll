import { excludedFromRanking } from './aa-ranking-policy.js';
import { estimationVotePairKey } from './estimation-votes.js';

function votePolicy(communityVotes, personalVotes) {
    const rates = new Map();
    const blocked = new Set();
    for (const { targetConditionID, sourceConditionID, supportCount, opposeCount } of communityVotes) {
        const pair = estimationVotePairKey(targetConditionID, sourceConditionID);
        if (supportCount + opposeCount > 0) rates.set(pair, supportCount / (supportCount + opposeCount));
        if (opposeCount > supportCount) blocked.add(pair);
    }
    for (const { targetConditionID, sourceConditionID, vote } of personalVotes) {
        const pair = estimationVotePairKey(targetConditionID, sourceConditionID);
        if (vote === 'oppose') { blocked.add(pair); rates.set(pair, 0); }
        else if (vote === 'support') { blocked.delete(pair); rates.set(pair, 1); }
    }
    return { rates, blocked };
}

export function createVersionEstimationPlanner(conditions, externalPairs = []) {
    const versionsByBenchmark = new Map();
    const siblingsByID = new Map();
    const benchmarkByVersion = new Map();
    for (const condition of conditions) {
        if (!Number.isSafeInteger(condition.benchmarkID) || condition.benchmarkID <= 0
            || !Number.isSafeInteger(condition.conditionID) || condition.conditionID <= 0 || excludedFromRanking(condition)) continue;
        if (!versionsByBenchmark.has(condition.benchmarkID)) versionsByBenchmark.set(condition.benchmarkID, []);
        const versions = versionsByBenchmark.get(condition.benchmarkID);
        versions.push(condition.conditionID);
        siblingsByID.set(condition.conditionID, versions);
        benchmarkByVersion.set(condition.conditionID, condition.benchmarkID);
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

    function plan(entries, communityVotes = [], personalVotes = []) {
        const { blocked } = votePolicy(communityVotes, personalVotes);
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
    }

    plan.treemap = (entries, communityVotes = [], personalVotes = []) => {
        const weights = new Map();
        for (const { conditionID, weightBasisPoints } of entries) {
            const benchmarkID = benchmarkByVersion.get(conditionID);
            if (benchmarkID !== undefined && weightBasisPoints > 0) {
                weights.set(benchmarkID, (weights.get(benchmarkID) ?? 0) + weightBasisPoints);
            }
        }
        const { blocked, rates } = votePolicy(communityVotes, personalVotes);
        const graph = new Map(), groups = new Map(), linkedBenchmarks = new Set();
        const nominationsByBenchmark = new Map();
        const link = (a, b, supportRate, external) => {
            if (!graph.has(a)) graph.set(a, []);
            if (!graph.has(b)) graph.set(b, []);
            graph.get(a).push({ conditionID: b, supportRate, external });
            graph.get(b).push({ conditionID: a, supportRate, external });
        };
        for (const [from, neighbors] of externalByID) {
            for (const to of neighbors) {
                if (to <= from) continue;
                const pair = estimationVotePairKey(from, to), rate = rates.get(pair);
                if (!rate || blocked.has(pair)) continue;
                const first = benchmarkByVersion.get(from), second = benchmarkByVersion.get(to);
                const nomination = { from, to, first, second, rate };
                for (const benchmarkID of [first, second]) {
                    if (!nominationsByBenchmark.has(benchmarkID)) nominationsByBenchmark.set(benchmarkID, []);
                    nominationsByBenchmark.get(benchmarkID).push(nomination);
                }
            }
        }
        // A nominated benchmark outside the treemap may connect two weighted
        // benchmarks. Only weighted benchmarks can supply the starting score.
        const visited = new Set();
        for (const root of weights.keys()) {
            if (visited.has(root) || !nominationsByBenchmark.has(root)) continue;
            const component = [root], nominations = new Set();
            let weightedCount = 0;
            visited.add(root);
            for (const benchmarkID of component) {
                if (weights.has(benchmarkID)) weightedCount++;
                for (const nomination of nominationsByBenchmark.get(benchmarkID)) {
                    nominations.add(nomination);
                    const next = nomination.first === benchmarkID ? nomination.second : nomination.first;
                    if (!visited.has(next)) { visited.add(next); component.push(next); }
                }
            }
            if (weightedCount < 2) continue;
            for (const benchmarkID of component) linkedBenchmarks.add(benchmarkID);
            for (const { from, to, rate } of nominations) link(from, to, rate, true);
        }
        if (!linkedBenchmarks.size) return null;
        for (const benchmarkID of linkedBenchmarks) {
            const versions = versionsByBenchmark.get(benchmarkID);
            versions.forEach((from, index) => {
                groups.set(from, benchmarkID);
                if (!graph.has(from)) graph.set(from, []);
                for (let next = index + 1; next < versions.length; next++) {
                    const to = versions[next], pair = estimationVotePairKey(from, to);
                    if (!blocked.has(pair)) link(from, to, rates.get(pair) ?? 1, false);
                }
            });
        }
        const conditionIDs = [...graph.keys()].sort((a, b) => a - b);
        for (const neighbors of graph.values()) neighbors.sort((a, b) => a.conditionID - b.conditionID);
        const vetoes = [...blocked].filter(pair => pair.split(':').every(id => graph.has(Number(id)))).sort();
        const cacheKey = JSON.stringify([conditionIDs.map(id => [id, graph.get(id)]), vetoes]);
        return { graph, groups, weights, conditionIDs, blocked: new Set(vetoes), cacheKey };
    };
    return plan;
}
