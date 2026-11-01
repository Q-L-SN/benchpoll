export const MODEL_FOCUS_TARGET_LIMIT = 4096;
export const HOME_MODEL_FOCUS_PARAMS = ['focusModel', 'scoreMode', 'compareReasoning', 'compareHarness', 'mode'];

export function readHomeModelFocusIntent(input) {
    const url = new URL(input);
    if (!url.searchParams.has('focusModel')) return null;
    try {
        if (HOME_MODEL_FOCUS_PARAMS.some(key => url.searchParams.getAll(key).length > 1)) throw new TypeError();
        const targetModel = normalizeModelFocusTarget(url.searchParams.get('focusModel'));
        const scoreMode = url.searchParams.get('scoreMode') ?? 'available';
        const mode = url.searchParams.get('mode') ?? 'public';
        if (!['available', 'range'].includes(scoreMode) || !['public', 'personal'].includes(mode)) throw new TypeError();
        const comparison = {};
        for (const [query, key] of [['compareReasoning', 'reasoning'], ['compareHarness', 'harness']]) {
            const value = url.searchParams.get(query);
            if (![null, '0', '1'].includes(value)) throw new TypeError();
            comparison[key] = value === '1';
        }
        let keys = ['model'];
        try {
            const identity = JSON.parse(targetModel);
            if (Array.isArray(identity) && identity.length <= 3 && identity.every(part => Array.isArray(part)
                && part.length === 3 && (part[0] === 'model' || /^field:[1-9]\d*$/.test(part[0])))
                && identity.some(part => part[0] === 'model')) keys = [...new Set(identity.map(part => part[0]))];
        } catch { /* Numeric IDs and opaque identities do not carry comparison keys. */ }
        return { valid: true, targetModel, scoreMode, mode, comparison, keys };
    } catch { return { valid: false }; }
}

export function normalizeModelFocusTarget(value) {
    if (Number.isSafeInteger(value) && value > 0) return String(value);
    if (typeof value !== 'string' || !value.trim() || value.length > MODEL_FOCUS_TARGET_LIMIT
        || /[\u0000-\u001f]/.test(value)) throw new TypeError('Invalid model focus target');
    if (/^[1-9]\d*$/.test(value)) {
        if (!Number.isSafeInteger(Number(value))) throw new TypeError('Invalid model focus target');
        return value;
    }
    if (/^[\s+\-\d.]/.test(value)) throw new TypeError('Invalid model focus target');
    return value;
}

export function modelFocusID(model) {
    const ID = model.modelID ?? model.ID;
    return Number.isSafeInteger(ID) && ID > 0 ? String(ID) : '';
}

export function matchesModelFocus(model, target) {
    return /^[1-9]\d*$/.test(target) ? modelFocusID(model) === target : model.comparisonIdentity === target;
}

// A bare model ID must never choose an arbitrary reasoning/harness variant.
export function findModelFocusIndex(models, target) {
    let result = -1;
    for (let index = 0; index < models.length; index++) {
        if (!matchesModelFocus(models[index], target)) continue;
        if (result !== -1) return -1;
        result = index;
    }
    return result;
}

export function markModelFocusTarget(element, model) {
    element.dataset.modelFocusId = modelFocusID(model);
    if (typeof model.comparisonIdentity === 'string') element.dataset.comparisonIdentity = model.comparisonIdentity;
}

export function findRenderedModelFocus(rows, target) {
    const matches = [...rows.querySelectorAll('[data-model-focus-id]')].filter(element =>
        /^[1-9]\d*$/.test(target) ? element.dataset.modelFocusId === target : element.dataset.comparisonIdentity === target);
    return matches.length === 1 ? matches[0] : null;
}
