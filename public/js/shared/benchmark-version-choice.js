import { excludedFromRanking } from './aa-ranking-policy.js';

// The grouped Add target and the community cold-start default must agree, even
// when the stored primary is unavailable. Keep wholly restricted groups visible.
function primaryVersion(versions) {
    const available = versions.filter(version => !excludedFromRanking(version));
    const candidates = available.length ? available : versions;
    return candidates.find(version => version.isPrimaryCondition)
        ?? [...candidates].sort((left, right) => (right.scoreCount ?? 0) - (left.scoreCount ?? 0)
            || left.conditionID - right.conditionID)[0];
}

// Version votes and benchmark weights have separate electorates. An absent flag
// preserves a saved, explicit version choice; new benchmark additions opt out.
export function versionChoiceOrder(left, right) {
    return (right.selectionBasisPoints ?? 0) - (left.selectionBasisPoints ?? 0)
        || (right.scoreCount ?? 0) - (left.scoreCount ?? 0)
        || left.conditionID - right.conditionID;
}

export function communityVersionComposition(pies, conditions) {
    const groups = new Map();
    const byCondition = new Map();
    for (const condition of conditions) {
        if (condition.conditionID < 1 || excludedFromRanking(condition)) continue;
        if (!groups.has(condition.benchmarkID)) groups.set(condition.benchmarkID, {
            benchmarkID: condition.benchmarkID, name: condition.name, voters: new Set(), versions: []
        });
        groups.get(condition.benchmarkID).versions.push({ ...condition, rawWeight: 0, voters: new Set() });
        byCondition.set(condition.conditionID, groups.get(condition.benchmarkID).versions.at(-1));
    }
    for (const [pieID, pie] of pies) for (const entry of pie.entries) {
        const version = byCondition.get(entry.conditionID);
        if (!version || entry.followCommunityVersion === true) continue;
        version.rawWeight += entry.weightBasisPoints;
        version.voters.add(pieID);
        groups.get(version.benchmarkID).voters.add(pieID);
    }
    return [...groups.values()].map(group => {
        const total = group.versions.reduce((sum, version) => sum + version.rawWeight, 0);
        const primary = primaryVersion(group.versions);
        return { benchmarkID: group.benchmarkID, name: group.name, primaryConditionID: primary.conditionID,
            configuredPieCount: group.voters.size, isDefault: total === 0,
            versions: group.versions.map(({ rawWeight, voters, ...version }) => ({ ...version,
                configuredPieCount: voters.size,
                selectionBasisPoints: total > 0 ? rawWeight / total * 10000 : 0,
                weightBasisPoints: total > 0 ? rawWeight / total * 10000
                    : version.conditionID === primary.conditionID ? 10000 : 0
            })).sort(versionChoiceOrder) };
    });
}

export function expandCommunityVersions(entries, composition = []) {
    const groups = new Map(composition.flatMap(group => group.versions.map(version => [version.conditionID, group])));
    return entries.flatMap(entry => {
        if (entry.followCommunityVersion !== true || entry.conditionID < 1) return [{ ...entry }];
        const group = groups.get(entry.conditionID);
        if (!group) throw new TypeError('Community version composition is missing for a benchmark');
        const source = { ...entry }; delete source.followCommunityVersion;
        return group.versions.filter(version => version.weightBasisPoints > 0).map(version => ({
            ...source, conditionID: version.conditionID,
            weightBasisPoints: entry.weightBasisPoints * version.weightBasisPoints / 10000
        }));
    });
}

export function groupBenchmarkRows(rows) {
    const groups = new Map(), references = [];
    for (const row of rows) {
        if (row.conditionID < 0) { references.push(row); continue; }
        if (!groups.has(row.benchmarkID)) groups.set(row.benchmarkID, []);
        groups.get(row.benchmarkID).push(row);
    }
    const rowsByWeight = [...references, ...[...groups.values()].map(versions => {
        const primary = primaryVersion(versions);
        const personal = versions.filter(row => row.personalWeightBasisPoints !== null && row.personalWeightBasisPoints !== undefined);
        const publicWeightBasisPoints = versions.reduce((sum, row) => sum + (row.publicWeightBasisPoints ?? 0), 0);
        const personalWeightBasisPoints = personal.length ? personal.reduce((sum, row) => sum + row.personalWeightBasisPoints, 0) : null;
        return { ...primary, isBenchmarkGroup: true, lowCoverage: false,
            memberConditionIDs: versions.map(row => row.conditionID),
            scoreCount: versions.reduce((sum, row) => sum + row.scoreCount, 0),
            publicWeightBasisPoints, publicWeight: publicWeightBasisPoints / 100,
            ...(versions.some(row => row.globalWeightBasisPoints !== undefined)
                ? { globalWeightBasisPoints: versions.reduce((sum, row) => sum + (row.globalWeightBasisPoints ?? 0), 0) } : {}),
            personalWeightBasisPoints, personalWeight: personalWeightBasisPoints === null ? null : personalWeightBasisPoints / 100 };
    })].sort((a, b) => b.publicWeightBasisPoints - a.publicWeightBasisPoints || a.conditionID - b.conditionID);
    let rank = 0, previousWeight = null;
    return rowsByWeight.map((row, index) => {
        if (row.publicWeightBasisPoints !== previousWeight) rank = index + 1;
        previousWeight = row.publicWeightBasisPoints;
        return { ...row, rank };
    });
}
