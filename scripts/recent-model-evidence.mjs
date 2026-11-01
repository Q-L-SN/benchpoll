export function modelKey(value) {
    return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function huggingFaceModelID(value) {
    try {
        const url = new URL(value);
        const segments = url.pathname.split('/').filter(Boolean);
        if (url.hostname !== 'huggingface.co' || segments.length !== 2
            || ['datasets', 'spaces'].includes(segments[0])) return null;
        return segments.join('/');
    } catch {
        return null;
    }
}

export function repoMatchesModelName(modelName, repoID) {
    const nameKey = modelKey(modelName);
    const repoKey = modelKey(repoID.split('/')[1]);
    return nameKey.length >= 6 && repoKey.length >= 6
        && (nameKey.includes(repoKey) || repoKey.includes(nameKey));
}
