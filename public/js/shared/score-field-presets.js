import { fieldNameKey } from './score-fields.js';

const nameKey = name => fieldNameKey(name).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
const aliases = {
    effort: ['effort', 'reasoning effort', 'thinking effort'],
    harness: ['harness', 'agent harness', 'harness name'],
    harnessVersion: ['harness version', 'agent harness version'],
    imageQuality: ['image quality', 'image quality preset']
};
export function runFieldKind(field) {
    return Object.entries(aliases).find(([, names]) => names.includes(nameKey(field.name)))?.[0] ?? null;
}
export function runFieldIcon(field) {
    return { effort: 'fa-brain', harness: 'fa-puzzle-piece', harnessVersion: 'fa-code-branch', imageQuality: 'fa-image' }[runFieldKind(field)] ?? null;
}
export function sortScoreFields(fields) {
    const rank = field => ({ effort: 0, harness: 1 }[runFieldKind(field)] ?? 2);
    return [...fields].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'en') || (a.ID ?? 0) - (b.ID ?? 0));
}
export function pinnedScoreFields(fields) {
    return ['effort', 'harness'].map(kind => {
        const candidates = fields.filter(field => Number.isSafeInteger(field.ID) && field.ID > 0
            && runFieldKind(field) === kind && field.type === 'enum');
        return candidates.find(field => nameKey(field.name) === kind) ?? candidates[0];
    }).filter(Boolean);
}
export function presetOption(field, value) {
    const options = field.options ?? [];
    return options.find(option => option.ID === value) ?? (typeof value === 'string'
        ? options.find(option => fieldNameKey(option.label) === fieldNameKey(value)) : null);
}

// Old drafts and saved filters can still contain the retired image-quality key or text Harness values.
export function adaptRunAssignments(assignments, fields) {
    if (!Array.isArray(assignments)) return assignments;
    const result = [];
    const origins = new Map();
    for (const assignment of assignments) {
        if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)) { result.push(assignment); continue; }
        let field = fields.find(field => field.ID === assignment.fieldID);
        if (!field) field = fields.find(field => field.legacyFields?.some(alias => alias.ID === assignment.fieldID));
        if (!field) { result.push({ ...assignment }); continue; }
        const next = { ...assignment, fieldID: field.ID };
        if (field.type === 'enum' && typeof next.value === 'string') {
            const option = presetOption(field, next.value);
            if (option) next.value = option.ID;
        }
        const duplicate = result.find(item => item?.fieldID === next.fieldID);
        if (duplicate && origins.get(field.ID) !== assignment.fieldID) {
            if (Object.keys(duplicate).length === Object.keys(next).length && Object.keys(duplicate)
                .every(key => Object.hasOwn(next, key) && Object.is(duplicate[key], next[key]))) continue;
            throw new Error('Conflicting legacy effort values must be reviewed.');
        }
        result.push(next);
        origins.set(field.ID, assignment.fieldID);
    }
    return result;
}

export function adaptRunComparison(comparison, fields = []) {
    if (!comparison || typeof comparison !== 'object' || Array.isArray(comparison)) return comparison;
    const aliasField = key => fields.find(field => field.legacyFields?.some(alias => `field:${alias.ID}` === key));
    const keyFor = key => aliasField(key) ? `field:${aliasField(key).ID}` : key;
    const keys = Array.isArray(comparison.keys) ? comparison.keys.map(keyFor) : null;
    const validFilters = Array.isArray(comparison.filters) && comparison.filters
        .every(filter => filter && typeof filter === 'object' && !Array.isArray(filter));
    return { ...comparison, ...(Array.isArray(keys) ? { keys: keys.filter((key, index) => !keys.slice(0, index)
        .some((other, previous) => other === key && comparison.keys[previous] !== comparison.keys[index])) } : {}),
        ...(validFilters ? { filters: comparison.filters.map(filter => {
            const key = keyFor(filter.key);
            const field = fields.find(field => `field:${field.ID}` === key);
            const option = filter.operator === 'eq' && field?.type === 'enum' ? presetOption(field, filter.value) : null;
            return { ...filter, key, ...(option ? { value: option.ID } : {}) };
        }).filter((filter, index, all) => !all.slice(0, index).some((other, previous) => JSON.stringify(other) === JSON.stringify(filter)
            && comparison.filters[previous].key !== comparison.filters[index].key)) } : {}) };
}
