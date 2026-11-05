// Presentation only: merge version weights by benchmark without changing scoring inputs.
export const UNRESOLVED_WEIGHT_ID = Number.MAX_SAFE_INTEGER;

export function mergeBenchmarkWeights(entries = [], versions = []) {
    const groups = new Map(), catalogue = new Map(versions.map(group => [group.benchmarkID, group]));
    for (const entry of entries) {
        if (!(entry.weightBasisPoints > 0)) continue;
        const unresolved = entry.conditionID < 0;
        const key = unresolved ? 'unresolved' : `benchmark:${entry.benchmarkID ?? entry.conditionID}`;
        let group = groups.get(key);
        if (!group) {
            const metadata = catalogue.get(entry.benchmarkID);
            const primary = metadata?.versions.find(version => version.conditionID === metadata.primaryConditionID);
            const ID = unresolved ? UNRESOLVED_WEIGHT_ID : primary?.conditionID ?? entry.conditionID;
            group = { ...entry, ...primary, ID, conditionID: ID, name: unresolved ? 'Unresolved weight' : metadata?.name ?? entry.name,
                type: unresolved ? 'unresolved' : 'benchmark', isUnresolved: unresolved, isBenchmarkGroup: !unresolved,
                scoreCount: metadata ? metadata.versions.reduce((sum, version) => sum + (version.scoreCount ?? 0), 0) : entry.scoreCount ?? 0,
                weightBasisPoints: 0, weight: 0 };
            groups.set(key, group);
        }
        group.weightBasisPoints += entry.weightBasisPoints;
        group.weight = group.weightBasisPoints / 100;
    }
    return [...groups.values()].sort((a, b) => b.weightBasisPoints - a.weightBasisPoints || a.conditionID - b.conditionID);
}

// Allocate the last hundredths deterministically so displayed component shares total 100%.
export function compositionPercentages(entries) {
    const total = entries.reduce((sum, entry) => sum + entry.weightBasisPoints, 0);
    if (!total) return [];
    const shares = entries.map((entry, index) => {
        const exact = entry.weightBasisPoints / total * 10000;
        return { index, value: Math.floor(exact), fraction: exact - Math.floor(exact) };
    });
    const remaining = 10000 - shares.reduce((sum, share) => sum + share.value, 0);
    [...shares].sort((a, b) => b.fraction - a.fraction || a.index - b.index)
        .slice(0, remaining).forEach(share => { share.value++; });
    return shares.map(share => `${Number((share.value / 100).toFixed(2))}%`);
}
