export function noticeNavigationTarget(value, origin) {
    if (typeof value !== 'string' || !value.trim()) return null;
    let url;
    try { url = new URL(value, origin); }
    catch { return null; }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) return null;
    return url.pathname + url.search + url.hash;
}
