// Navigation identities and order are independent of pie mode, saves and the DOM.
export function contextKey(categoryID, values = {}) {
    return `${Number(categoryID)}:${JSON.stringify(Object.fromEntries(
        Object.keys(values).sort().map(key => [key, values[key]])
    ))}`;
}

export function entryFromContext(context) {
    const lineage = (context.lineage ?? []).map(item => ({ ID: Number(item.ID), name: String(item.name) }));
    if (!lineage.length) return null;
    const dimensions = context.dimensions ?? [];
    const values = { ...context.contextValues };
    return {
        contextID: context.ID ?? null,
        categoryID: Number(context.categoryID),
        categoryName: lineage.at(-1).name,
        lineage,
        contextValues: values,
        contextLabel: dimensions.map(dimension => {
            const selected = dimension.options.find(option => option.key === values[dimension.key]);
            return `${dimension.name}: ${selected?.name ?? values[dimension.key]}`;
        }).join(' · '),
        contextOrder: dimensions.map(dimension => dimension.options.findIndex(option => option.key === values[dimension.key])),
        available: true
    };
}

function compareNumbers(left, right) {
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
        if (left[index] !== right[index]) return left[index] - right[index];
    }
    return left.length - right.length;
}

export function compareLocations(left, right) {
    // Sibling order matches getSubCategories: ORDER BY categories.ID. A prefix
    // precedes all of its descendants: this is a fully expanded tree, not BFS.
    return compareNumbers(left.lineage.map(item => item.ID), right.lineage.map(item => item.ID))
        || compareNumbers(left.contextOrder ?? [], right.contextOrder ?? [])
        || contextKey(left.categoryID, left.contextValues).localeCompare(contextKey(right.categoryID, right.contextValues), 'en');
}

export function locationURL(entry) {
    const path = entry.lineage.map(item => encodeURIComponent(item.name.trim().replace(/\s+/g, '-'))).join('/');
    const params = new URLSearchParams();
    Object.keys(entry.contextValues).sort().forEach(key => params.set(`context_${key}`, entry.contextValues[key]));
    return `/rankings/${path}${params.size ? `?${params}` : ''}`;
}

export function configuredRows(items, current, query = '') {
    const entries = new Map(items.map(item => [contextKey(item.categoryID, item.contextValues), item]));
    const savedCategories = new Set(items.map(item => item.categoryID));
    const currentKey = current ? contextKey(current.categoryID, current.contextValues) : null;
    const rows = [...entries].map(([key, item]) => {
        const configuredPath = item.lineage.filter(category => savedCategories.has(category.ID));
        return { ...item, key, configured: true, current: key === currentKey,
            groupID: configuredPath[0]?.ID ?? item.categoryID,
            depth: Math.max(0, configuredPath.length - 1) };
    }).sort(compareLocations);
    if (current && !entries.has(currentKey)) {
        const configuredPath = current.lineage.filter(category => savedCategories.has(category.ID));
        const after = rows.findIndex(item => compareLocations(current, item) < 0);
        const index = after < 0 ? rows.length : after;
        // A temporary ancestor joins the first following group for presentation
        // only; it must never absorb or split the saved groups underneath it.
        const descendant = rows.find(item => item.lineage.some(category => category.ID === current.categoryID));
        const groupID = configuredPath[0]?.ID ?? descendant?.groupID
            ?? rows[index - 1]?.groupID ?? rows[index]?.groupID ?? current.categoryID;
        rows.splice(index, 0, { ...current, key: currentKey, configured: false, current: true,
            groupID, depth: configuredPath.filter(item => item.ID !== current.categoryID).length });
    }
    const names = new Map();
    rows.forEach(item => {
        if (!names.has(item.categoryName)) names.set(item.categoryName, new Set());
        names.get(item.categoryName).add(item.categoryID);
    });
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const filtered = rows.filter(item => {
        const text = `${item.lineage.map(category => category.name).join(' / ')} ${item.contextLabel}`.toLocaleLowerCase();
        return terms.every(term => text.includes(term));
    });
    return filtered.map((item, index) => ({ ...item,
        groupStart: index > 0 && item.groupID !== filtered[index - 1].groupID,
        pathLabel: names.get(item.categoryName).size > 1 ? item.lineage.slice(0, -1).map(category => category.name).join(' / ') : ''
    }));
}

export function validateNavigationPayload(payload) {
    const invalid = () => { throw new TypeError('Invalid configured navigation response'); };
    if (!payload || !/^[1-9]\d*$/.test(payload.userID) || !Array.isArray(payload.items)) invalid();
    const keys = new Set();
    for (const item of payload.items) {
        if (!item || !Number.isSafeInteger(item.categoryID) || item.categoryID < 1
            || typeof item.categoryName !== 'string' || typeof item.contextLabel !== 'string'
            || !Array.isArray(item.lineage) || !item.lineage.length || item.lineage.length > 64
            || item.lineage.some(category => !Number.isSafeInteger(category.ID) || category.ID < 1 || typeof category.name !== 'string')
            || item.lineage.at(-1).ID !== item.categoryID
            || new Set(item.lineage.map(category => category.ID)).size !== item.lineage.length
            || !item.contextValues || typeof item.contextValues !== 'object' || Array.isArray(item.contextValues)
            || Object.values(item.contextValues).some(value => typeof value !== 'string')
            || !Array.isArray(item.contextOrder) || item.contextOrder.some(value => !Number.isSafeInteger(value))
            || typeof item.available !== 'boolean') invalid();
        const key = contextKey(item.categoryID, item.contextValues);
        if (keys.has(key)) invalid();
        keys.add(key);
    }
    return payload;
}
