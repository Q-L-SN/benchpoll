export function comparisonProfileKey(comparison) {
    const filters = comparison.filters.map(filter => JSON.stringify([
        filter.key, filter.operator, filter.value ?? null
    ])).sort();
    return JSON.stringify([comparison.mode, [...comparison.keys].sort(), filters]);
}
