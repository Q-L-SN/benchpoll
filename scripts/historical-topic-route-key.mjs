// Historical migration input normalization only. Runtime routes never call this.
export function legacyTopicRouteKey(path) {
    return String(path).split('/').filter(Boolean).map(part => decodeURIComponent(part)
        .normalize('NFC').toLowerCase().replace(/[-_\s]+/g, ' ').trim()).join('/');
}
