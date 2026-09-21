export function normalizeModelParameters(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('model_parameters_required');
    const entries = Object.entries(input);
    if (entries.length > 16) throw Error('too_many_model_parameters');
    const result = Object.create(null);
    for (const [rawKey, rawValue] of entries) {
        const key = rawKey.trim().toLowerCase().replace(/[\s-]+/g, '_');
        if (!/^[a-z][a-z0-9_]{0,39}$/.test(key) || ['model', 'constructor', 'prototype', '__proto__'].includes(key)) throw Error('invalid_model_parameter_key');
        if (typeof rawValue !== 'string' || !rawValue.trim() || rawValue.trim().length > 160) throw Error('invalid_model_parameter_value');
        if (Object.hasOwn(result, key)) throw Error('duplicate_model_parameter_key');
        result[key] = rawValue.trim();
    }
    return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

export function modelParameterLabel(parameters, ID = null) {
    if (parameters === null) return `Unconfigured #${ID}`;
    const entries = Object.entries(normalizeModelParameters(parameters));
    return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(' / ') : 'default';
}

export function parameterRowsToObject(rows) {
    const input = Object.create(null);
    for (const { key, value } of rows) {
        if (Object.hasOwn(input, key)) throw Error('duplicate_model_parameter_key');
        input[key] = value;
    }
    return normalizeModelParameters(input);
}
