const fail = message => { throw new Error(message); };
export const FIELD_TYPES = ['presence', 'text', 'number', 'enum'];
export const fieldKey = ID => `field:${ID}`;
export function fieldNameKey(value) {
    return String(value).normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

// Decimal strings avoid precision loss and make 1, 1.0 and 1e0 identical.
export function canonicalNumber(input) {
    if (typeof input !== 'string' && typeof input !== 'number') fail('invalid_field_number');
    const text = String(input).trim();
    const match = text.match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i);
    if (!match || text.length > 256 || !Number.isFinite(Number(text))) fail('invalid_field_number');
    let digits = (match[2] || '') + (match[3] || match[4] || '');
    let exponent = Number(match[5] || 0) - (match[3] || match[4] || '').length;
    digits = digits.replace(/^0+/, '');
    if (!digits) return '0';
    while (digits.endsWith('0')) { digits = digits.slice(0, -1); exponent++; }
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10000) fail('invalid_field_number');
    return `${match[1] === '-' ? '-' : ''}${digits}e${exponent}`;
}

export function compareCanonicalNumbers(left, right) {
    const a = canonicalNumber(left);
    const b = canonicalNumber(right);
    if (a === b) return 0;
    if (a === '0') return b.startsWith('-') ? 1 : -1;
    if (b === '0') return a.startsWith('-') ? -1 : 1;
    const negative = a.startsWith('-');
    if (negative !== b.startsWith('-')) return negative ? -1 : 1;
    const [aDigits, aExponent] = (negative ? a.slice(1) : a).split('e');
    const [bDigits, bExponent] = (negative ? b.slice(1) : b).split('e');
    const aMagnitude = aDigits.length + Number(aExponent);
    const bMagnitude = bDigits.length + Number(bExponent);
    let order = Math.sign(aMagnitude - bMagnitude);
    if (!order) {
        for (let index = 0; index < Math.max(aDigits.length, bDigits.length); index++) {
            order = Math.sign((aDigits.charCodeAt(index) || 48) - (bDigits.charCodeAt(index) || 48));
            if (order) break;
        }
    }
    return negative ? -order : order;
}

export function normalizeFieldDefinition(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_score_field');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80 || fieldNameKey(name) === 'model') fail('invalid_score_field_name');
    if (!FIELD_TYPES.includes(input.type)) fail('invalid_score_field_type');
    for (const key of ['allowEmpty', 'excludeMissing', 'excludeEmpty']) {
        if (typeof input[key] !== 'boolean') fail('invalid_score_field_policy');
    }
    if (input.type === 'presence' && (input.allowEmpty || input.excludeEmpty)) fail('presence_field_has_no_value');
    if (!input.allowEmpty && input.excludeEmpty) fail('empty_field_value_not_allowed');
    if (!Array.isArray(input.options)) fail('invalid_score_field_options');
    if (input.type !== 'enum' && input.options.length) fail('unexpected_score_field_options');
    if (input.type === 'enum' && (!input.options.length || input.options.length > 2048)) fail('score_field_options_required');
    const names = new Set();
    const options = input.options.map(option => {
        const label = typeof option.label === 'string' ? option.label.trim() : '';
        if (!label || label.length > 512 || names.has(fieldNameKey(label))) fail('invalid_or_duplicate_field_option');
        if (typeof option.excluded !== 'boolean') fail('invalid_score_field_policy');
        names.add(fieldNameKey(label));
        return { label, excluded: option.excluded };
    });
    return { name, type: input.type, allowEmpty: input.allowEmpty,
        excludeMissing: input.excludeMissing, excludeEmpty: input.excludeEmpty, options };
}

export function normalizeFieldValue(field, value) {
    if (field.type === 'presence') {
        if (value !== null) fail('presence_field_has_no_value');
        return null;
    }
    if (value === null || value === '') {
        if (!field.allowEmpty) fail('score_field_value_required');
        return null;
    }
    if (field.type === 'number') return canonicalNumber(value);
    if (field.type === 'text') {
        if (typeof value !== 'string' || value.length > 2000) fail('invalid_score_field_text');
        if (!value.trim()) {
            if (!field.allowEmpty) fail('score_field_value_required');
            return null;
        }
        return value;
    }
    if (field.type === 'enum') {
        if (!Number.isSafeInteger(value) || !field.options.some(option => option.ID === value)) fail('score_field_option_unavailable');
        return value;
    }
    fail('invalid_score_field_type');
}

export function normalizeScoreFields(assignments, definitions) {
    if (!Array.isArray(assignments) || assignments.length > 64) fail('invalid_score_fields');
    const seen = new Set();
    return assignments.map(entry => {
        if (!entry || Object.keys(entry).some(key => !['fieldID', 'value'].includes(key))
            || !Number.isSafeInteger(entry.fieldID) || entry.fieldID < 1 || seen.has(entry.fieldID)) fail('invalid_or_duplicate_score_field');
        seen.add(entry.fieldID);
        const field = definitions.find(item => item.ID === entry.fieldID);
        if (!field) fail('score_field_unavailable');
        return { fieldID: entry.fieldID, value: normalizeFieldValue(field, entry.value) };
    }).sort((a, b) => a.fieldID - b.fieldID);
}

export function fieldDisplayValue(field, value) {
    if (field.type === 'presence') return 'Present';
    if (value === null) return 'Empty';
    if (field.type === 'enum') return field.options.find(option => option.ID === value)?.label ?? 'Unavailable value';
    if (field.type === 'number') {
        const number = Number(value);
        return Number.isFinite(number) && canonicalNumber(String(number)) === canonicalNumber(value) ? String(number) : String(value);
    }
    return String(value);
}

export function comparisonValueEligible(field, values) {
    const key = fieldKey(field.ID);
    if (!Object.hasOwn(values, key)) return !field.excludeMissing;
    if (values[key] === null) return field.type === 'presence' || !field.excludeEmpty;
    return field.type !== 'enum' || !field.options.some(option => option.ID === values[key] && option.excluded);
}

export function normalizeValueFilters(input, availableKeys, definitions) {
    if (!Array.isArray(input) || input.length > 65) fail('invalid_comparison_filters');
    const seen = new Map();
    return input.map(filter => {
        if (!filter || Object.keys(filter).some(key => !['key', 'operator', 'value'].includes(key))
            || !availableKeys.includes(filter.key)) fail('invalid_comparison_filter_key');
        const { key, operator } = filter;
        if (!['eq', 'gt', 'lt', 'present', 'absent'].includes(operator)) fail('invalid_comparison_filter_operator');
        const field = definitions.find(item => fieldKey(item.ID) === key);
        const previous = seen.get(key) ?? new Set();
        if (previous.size && !(field?.type === 'number' && previous.size === 1
            && ((previous.has('gt') && operator === 'lt') || (previous.has('lt') && operator === 'gt')))) {
            fail('duplicate_comparison_filter');
        }
        previous.add(operator);
        seen.set(key, previous);
        if (key === 'model') {
            if (operator !== 'eq' || !Number.isSafeInteger(filter.value) || filter.value < 1) fail('invalid_model_filter');
            return { key, operator, value: filter.value };
        }
        if (operator === 'eq' && field?.type === 'presence') fail('presence_field_has_no_value');
        if (['gt', 'lt'].includes(operator) && field?.type !== 'number') fail('numeric_comparison_filter_required');
        if (['present', 'absent'].includes(operator)) {
            if (Object.hasOwn(filter, 'value')) fail('unexpected_comparison_filter_value');
            return { key, operator };
        }
        const value = field ? normalizeFieldValue(field, filter.value) : filter.value;
        if (value === null || value === undefined) fail('comparison_filter_value_required');
        if (!field && typeof value !== 'string') fail('invalid_comparison_filter_value');
        return { key, operator, value };
    });
}

export function matchesValueFilters(values, filters) {
    return filters.every(filter => {
        const present = Object.hasOwn(values, filter.key);
        if (filter.operator === 'present') return present;
        if (filter.operator === 'absent') return !present;
        if (filter.operator === 'gt' || filter.operator === 'lt') {
            if (!present || values[filter.key] === null) return false;
            const order = compareCanonicalNumbers(values[filter.key], filter.value);
            return filter.operator === 'gt' ? order > 0 : order < 0;
        }
        return present && values[filter.key] === filter.value;
    });
}
