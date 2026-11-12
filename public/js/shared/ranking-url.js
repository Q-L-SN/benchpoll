import { parseTopicPath, scenePath } from './topics.js';
const invalidContextURL = message => Object.assign(new Error(message), { status: 400 });

export function readRankingContext(search) {
    for (const key of new URLSearchParams(search).keys()) {
        if (key === 'scene' || key.startsWith('context_')) throw invalidContextURL('Scenes use numeric URL paths.');
    }
    return {};
}

export function rankingContextURL(input, _dimensions = [], values = {}, scenes = []) {
    const url = new URL(input);
    readRankingContext(url.search);
    const identity = parseTopicPath(url.pathname);
    if (!identity) throw invalidContextURL('Invalid topic path');
    if (values.scene !== undefined) {
        const scene = scenes.find(item => String(item.ID) === String(values.scene));
        if (!scene) throw invalidContextURL('Unknown scene');
        const path = scenePath(url.pathname, scene);
        if (!path) throw invalidContextURL('Invalid scene path');
        url.pathname = path;
    }
    return url;
}
