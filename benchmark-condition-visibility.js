// Archived scores do not remove their condition from the catalog. Only an
// explicit user deletion does; the row remains for score and audit history.
export function selectableBenchmarkConditionSQL(alias = 'benchmark_conditions') {
    if (!/^[a-z_][a-z_0-9]*$/i.test(alias)) throw new TypeError('Invalid SQL alias');
    return `${alias}.deleted_at IS NULL`;
}

export function conditionCoverage(conditions, ownerBenchmarkID) {
    const maxima = new Map();
    const group = condition => {
        const key = ownerBenchmarkID === undefined ? condition.benchmarkID : ownerBenchmarkID;
        if (!(Number.isSafeInteger(key) && key > 0) && !(typeof key === 'string' && key.trim())) {
            throw new TypeError('Benchmark coverage requires an explicit benchmark identity');
        }
        return key;
    };
    for (const condition of conditions) {
        if (!Number.isSafeInteger(condition.scoreCount) || condition.scoreCount < 0) {
            throw new TypeError('Benchmark score counts must be non-negative integers');
        }
        const key = group(condition);
        maxima.set(key, Math.max(maxima.get(key) ?? 0, condition.scoreCount));
    }
    return conditions.map(condition => ({ ...condition,
        lowCoverage: maxima.get(group(condition)) > 0
            && condition.scoreCount * 5 <= maxima.get(group(condition))
    }));
}
