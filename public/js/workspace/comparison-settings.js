import { fieldKey, fieldNameKey } from '../shared/score-fields.js';
import { adaptRunComparison } from '../shared/score-field-presets.js';

const STORAGE_PREFIX = 'benchpoll-comparison-settings-v1:';
const aliases = {
    reasoning: ['effort', 'reasoning effort', 'thinking effort'],
    harness: ['agent harness', 'harness', 'harness name']
};
export const defaultComparison = () => ({ mode: 'best', keys: ['model'], filters: [] });
export function basicComparisonOptions(value, metadata = null) {
    const comparison = adaptRunComparison(value?.basic ?? defaultComparison(), metadata?.fields ?? []);
    const allowed = metadata ? new Set(['model', ...Object.values(quickComparisonFields(metadata.fields ?? [], metadata.availableKeys ?? []))]) : null;
    const keys = (comparison.keys ?? []).filter(key => key === 'model' || /^field:[1-9]\d*$/.test(key));
    return { mode: 'best', keys: [...new Set(['model', ...keys.filter(key => !allowed || allowed.has(key))])].slice(0, 3), filters: [] };
}
const normalizeName = name => fieldNameKey(name).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');

export function quickComparisonFields(fields, availableKeys) {
    return Object.fromEntries(Object.entries(aliases).map(([kind, names]) => {
        const candidates = fields.filter(field => availableKeys.includes(fieldKey(field.ID)) && names.includes(normalizeName(field.name)))
            .sort((left, right) => names.indexOf(normalizeName(left.name)) - names.indexOf(normalizeName(right.name)) || left.ID - right.ID);
        return [kind, candidates.length ? fieldKey(candidates[0].ID) : null];
    }));
}

function normalize(value, userID) {
    const keys = value?.basic?.keys;
    const valid = Array.isArray(keys) && keys.includes('model') && keys.length <= 3
        && keys.every(key => key === 'model' || /^field:[1-9]\d*$/.test(key));
    return {
        experimental: userID !== null && value?.experimental === true,
        basic: valid ? { mode: 'best', keys: [...new Set(['model', ...keys])], filters: [] } : defaultComparison()
    };
}

export function readComparisonSettings(userID, storage) {
    try { return normalize(JSON.parse((storage ?? globalThis.localStorage).getItem(STORAGE_PREFIX + (userID ?? 'guest'))), userID); }
    catch { return normalize(null, userID); }
}

export function writeComparisonSettings(value, userID, storage) {
    try {
        (storage ?? globalThis.localStorage).setItem(STORAGE_PREFIX + (userID ?? 'guest'), JSON.stringify(normalize(value, userID)));
        return true;
    } catch { return false; }
}
