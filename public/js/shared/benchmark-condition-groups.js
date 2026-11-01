export const BENCHMARK_GROUPS = Object.freeze(['primary', 'other', 'lowCoverage']);

export function benchmarkConditionGroup(condition) {
    if (typeof condition.isPrimaryCondition !== 'boolean' || typeof condition.lowCoverage !== 'boolean') {
        throw new TypeError('Benchmark versions require primary and coverage flags');
    }
    // "primary" is the first, unfolded page, not the condition's primary flag.
    const personalWeight = condition.personalWeightBasisPoints ?? Number(condition.personalWeight) * 100;
    const publicWeight = condition.publicWeightBasisPoints ?? Number(condition.publicWeight) * 100;
    if (condition.searchPromoted === true || condition.isFamily || condition.isPrimaryCondition || personalWeight > 0 || publicWeight >= 300) return 'primary';
    return condition.lowCoverage ? 'lowCoverage' : 'other';
}
