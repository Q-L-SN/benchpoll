const reserved = new Set(['discussion', 'categoryID', 'benchmarkID', 'threadID']);
const invalidContextURL = message => Object.assign(new Error(message), { status: 400 });

function ownersOf(key, dimensions) {
    return dimensions.filter(dimension => dimension.options.some(option => option.key === key));
}

export function readRankingContext(search, dimensions) {
    const values = {};
    for (const [key, value] of new URLSearchParams(search)) {
        let dimension;
        let selected = value;
        if (key.startsWith('context_')) {
            dimension = dimensions.find(item => item.key === key.slice(8));
            if (!dimension) throw invalidContextURL(`Unknown context: ${key.slice(8)}`);
        } else if (!reserved.has(key) && dimensions.some(item => item.key === key) && value) {
            dimension = dimensions.find(item => item.key === key);
        } else if (!value) {
            const owners = ownersOf(key, dimensions);
            if (owners.length !== 1) throw invalidContextURL(`Unknown or ambiguous context option: ${key}`);
            [dimension] = owners;
            selected = key;
        } else continue;
        if (Object.hasOwn(values, dimension.key)) throw invalidContextURL(`Repeated context: ${dimension.key}`);
        if (!dimension.options.some(option => option.key === selected)) throw invalidContextURL(`Invalid context option: ${selected}`);
        values[dimension.key] = selected;
    }
    return values;
}

export function rankingContextURL(input, dimensions, values) {
    const url = new URL(input);
    const extra = [...url.searchParams].filter(([key, value]) => !key.startsWith('context_')
        && !(dimensions.some(dimension => dimension.key === key) && !reserved.has(key))
        && !(value === '' && ownersOf(key, dimensions).length));
    const parts = [];
    for (const dimension of dimensions) {
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
