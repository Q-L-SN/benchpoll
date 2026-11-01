const reserved = new Set(['discussion', 'categoryID', 'benchmarkID', 'threadID', 'scene']);
const invalidContextURL = message => Object.assign(new Error(message), { status: 400 });

function sceneValue(value) {
    if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
        throw invalidContextURL('Invalid scene');
    }
    return String(value);
}

function ownersOf(key, dimensions) {
    return dimensions.filter(dimension => dimension.options.some(option => option.key === key));
}

export function readRankingContext(search, dimensions = []) {
    const values = {};
    for (const [key, value] of new URLSearchParams(search)) {
        if (key === 'scene' || key === 'context_scene') {
            if (Object.hasOwn(values, 'scene')) throw invalidContextURL('Repeated scene');
            values.scene = sceneValue(value);
            continue;
        }
        let dimension;
        let selected = value;
        if (key.startsWith('context_')) {
            // Old explicit context links are resolved to stable scenes by the server.
            if (!dimensions.length) {
                const name = key.slice(8);
                if (!name || !value || Object.hasOwn(values, name)) throw invalidContextURL('Invalid legacy context');
                values[name] = value;
                continue;
            }
            dimension = dimensions.find(item => item.key === key.slice(8));
            if (!dimension) throw invalidContextURL(`Unknown context: ${key.slice(8)}`);
        } else if (!reserved.has(key) && dimensions.some(item => item.key === key) && value) {
            dimension = dimensions.find(item => item.key === key);
        } else if (!value && dimensions.length) {
            const owners = ownersOf(key, dimensions);
            if (owners.length !== 1) throw invalidContextURL(`Unknown or ambiguous context option: ${key}`);
            [dimension] = owners;
            selected = key;
        } else continue;
        if (Object.hasOwn(values, dimension.key)) throw invalidContextURL(`Repeated context: ${dimension.key}`);
        if (!dimension.options.some(option => option.key === selected)) throw invalidContextURL(`Invalid context option: ${selected}`);
        values[dimension.key] = selected;
    }
    if (values.scene && Object.keys(values).length !== 1) throw invalidContextURL('A scene cannot be combined with context options');
    return values;
}

export function rankingContextURL(input, dimensions = [], values = {}) {
    const url = new URL(input);
    const extra = [...url.searchParams].filter(([key, value]) => key !== 'scene' && !key.startsWith('context_')
        && !(dimensions.some(dimension => dimension.key === key) && !reserved.has(key))
        && !(value === '' && ownersOf(key, dimensions).length));
    const parts = [];
    if (values.scene !== undefined) parts.push(`scene=${sceneValue(values.scene)}`);
    for (const dimension of values.scene === undefined ? dimensions : []) {
        const selected = dimension.options.find(option => option.key === values[dimension.key]);
        if (!selected) throw new Error(`Invalid context selection: ${dimension.key}`);
        // Only omit neutral defaults: omission must never select a different context.
        if (selected.isNeutral && selected.isDefault) continue;
        if (ownersOf(selected.key, dimensions).length === 1 && !reserved.has(selected.key)
            && !selected.key.startsWith('context_')) parts.push(encodeURIComponent(selected.key));
        else {
            const key = reserved.has(dimension.key) ? `context_${dimension.key}` : dimension.key;
            parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(selected.key)}`);
        }
    }
    parts.push(...extra.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`));
    url.search = parts.length ? `?${parts.join('&')}` : '';
    return url;
}
