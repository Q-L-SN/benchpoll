export function isContextDimensionUnlocked(dimensions, index) {
    return Array.isArray(dimensions) && Number.isInteger(index) && index >= 0 && index < dimensions.length;
}

export function selectContextOption(dimensions, values, index, key) {
    if (!isContextDimensionUnlocked(dimensions, index, values)) throw new TypeError('context_dimension_locked');
    const dimension = dimensions[index];
    const selected = dimension?.options.find(option => option.key === key);
    if (!selected) throw new TypeError('invalid_context_option');
    return { ...values, [dimension.key]: key };
}
