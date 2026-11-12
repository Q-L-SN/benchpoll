import { topicURL, parseTopicPath } from '../shared/topics.js';
import { searchItems } from '../shared/search.js';
import { orderedScenes, sceneURL } from './scenes.js';

const configuredSearchFields = item => [item.categoryName, item.description, item.lineage.map(category => category.name).join(' / '), item.contextLabel];

// Navigation identities and order are independent of pie mode, saves and the DOM.
export function contextKey(categoryID, values = {}) {
    return `${Number(categoryID)}:${JSON.stringify(Object.fromEntries(
        Object.keys(values).sort().map(key => [key, values[key]])
    ))}`;
}

export function entryFromContext(context) {
    const lineage = (context.lineage ?? [{ ID: context.categoryID ?? context.ID, name: context.categoryName ?? context.name }]).map(item => ({
        ID: Number(item.ID), name: String(item.name), position: Number(item.position ?? 0)
    }));
    if (!lineage.length) return null;
    const dimensions = context.dimensions ?? [];
    const values = { ...context.contextValues };
    const scenes = orderedScenes(context.scenes);
    const sceneID = context.sceneID ?? (values.scene ? Number(values.scene) : null);
    const scene = scenes.find(item => Number(item.ID) === Number(sceneID));
    return {
        contextID: context.contextID ?? (context.categoryID ? context.ID : null) ?? null,
        scenes,
        sceneID,
        defaultContextID: context.defaultContextID,
        rootContextID: context.rootContextID,
        sceneName: scene?.name ?? context.sceneName ?? '',
        categoryID: Number(context.categoryID ?? context.ID),
        categoryName: lineage.at(-1).name,
        description: typeof context.description === 'string' ? context.description : '',
        creator: context.creator ? { ...context.creator } : null,
        isOfficial: context.isOfficial === true, publicID: context.publicID, privateID: context.privateID,
        favoriteCount: Number(context.favoriteCount ?? 0), isFavorited: context.isFavorited === true,
        configurationCount: Number(context.configurationCount ?? 0), coverageIndex: context.coverageIndex ?? null,
        configuredPersonalContext: context.configuredPersonalContext ?? null,
        isPrivate: context.isPrivate === true,
        slug: context.slug,
        url: context.url || (context.path ? `/${context.path.replace(/^\/+/, '')}`
            : context.categoryPath ? `/${context.categoryPath.replace(/^\/+/, '')}` : undefined),
        isMine: context.isMine === true,
        configured: context.configured === true,
        lineage,
        contextValues: values,
        contextLabel: scene?.name ?? context.sceneName ?? context.contextLabel ?? dimensions.map(dimension => {
            const selected = dimension.options.find(option => option.key === values[dimension.key]);
            return `${dimension.name}: ${selected?.name ?? values[dimension.key]}`;
        }).join(' / '),
        contextOrder: scene ? [scenes.indexOf(scene)] : dimensions.map(dimension => dimension.options.findIndex(option => option.key === values[dimension.key])),
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
    // Topic positions and context option order are stable across saves and views.
    return compareNumbers(left.lineage.flatMap(item => [item.position ?? 0, item.ID]),
        right.lineage.flatMap(item => [item.position ?? 0, item.ID]))
        || compareNumbers(left.contextOrder ?? [], right.contextOrder ?? [])
        || contextKey(left.categoryID, left.contextValues).localeCompare(contextKey(right.categoryID, right.contextValues), 'en');
}

export function popularTopics(items) {
    // The API owns the favorites-based ordering, including deterministic ties.
    return [...items];
}

export function locationURL(entry) {
    if (!Number.isSafeInteger(Number(entry.categoryID)) || Number(entry.categoryID) < 1) throw new TypeError('Invalid topic ID');
    const path = entry.url || topicURL(entry);
    const url = new URL(path, 'https://navigation.invalid');
    if (!path.startsWith('/') || url.origin !== 'https://navigation.invalid' || !parseTopicPath(path)) throw new TypeError('Invalid topic URL');
    const scene = entry.contextValues?.scene ? entry.scenes?.find(item => String(item.ID) === String(entry.contextValues.scene))
        ?? (entry.sceneName ? { name: entry.sceneName } : null) : entry.scenes?.find(item => item.isDefault);
    if (scene) return sceneURL(path, scene);
    if (entry.contextValues?.scene) throw new TypeError('Missing scene name');
    if (Object.keys(entry.contextValues ?? {}).length) throw new TypeError('Unsupported topic context');
    return `${url.pathname}${url.search}`;
}

export function configuredRows(items, current, query = '', privateTopics = []) {
    const entries = new Map([...privateTopics.filter(item => item.isPrivate === true && item.isMine === true)
        .map(item => ({ ...item, weightCount: 0 })), ...items.filter(item => item.weightCount > 0)]
        .map(item => [contextKey(item.categoryID, item.contextValues), item]));
    const currentKey = current ? contextKey(current.categoryID, current.contextValues) : null;
    const rows = [...entries].map(([key, item]) => ({ ...item, key, configured: item.weightCount > 0,
        current: key === currentKey, groupID: item.categoryID, depth: 0
    })).sort(compareLocations);
    const filtered = searchItems(rows, query, configuredSearchFields);
    return filtered.map((item, index) => ({ ...item,
        groupStart: false,
        pathLabel: filtered.some((other, otherIndex) => otherIndex !== index
            && other.categoryName === item.categoryName && other.categoryID !== item.categoryID) ? `Topic ${item.categoryID}` : ''
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
            || item.lineage.some(category => !Number.isSafeInteger(category.ID) || category.ID < 1 || typeof category.name !== 'string'
                || (category.position !== undefined && (!Number.isSafeInteger(category.position) || category.position < 0)))
            || item.lineage.at(-1).ID !== item.categoryID
            || new Set(item.lineage.map(category => category.ID)).size !== item.lineage.length
            || !item.contextValues || typeof item.contextValues !== 'object' || Array.isArray(item.contextValues)
            || Object.values(item.contextValues).some(value => typeof value !== 'string')
            || !Array.isArray(item.contextOrder) || item.contextOrder.some(value => !Number.isSafeInteger(value))
            || typeof item.available !== 'boolean'
            || (item.weightCount !== undefined && (!Number.isSafeInteger(item.weightCount) || item.weightCount < 0))
            || (item.isPrivate !== undefined && typeof item.isPrivate !== 'boolean')
            || (item.isPrivate === true && (item.lineage.length !== 1
                || Object.keys(item.contextValues).some(key => key !== 'scene')))
            || (item.contextValues.scene !== undefined && (!/^[1-9]\d*$/.test(item.contextValues.scene)
                || !Number.isSafeInteger(Number(item.contextValues.scene))))) invalid();
        const key = contextKey(item.categoryID, item.contextValues);
        if (keys.has(key)) invalid();
        try { if (item.available) locationURL(item); } catch { invalid(); }
        keys.add(key);
    }
    return payload;
}
