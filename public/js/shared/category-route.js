const normalized = value => String(value).normalize('NFKC').trim().toLowerCase().replace(/[-_\s]+/g, '-');

export const RESERVED_CATEGORY_PATHS = Object.freeze([
    'api', 'assets', 'css', 'js', 'fonts', 'contribute', 'how-it-works', 'personal', 'privacy', 'terms', 'cookies', 'community-guidelines', 'account',
    'login', 'github-login', 'github-callback', 'adminlogin', 'censor',
    'dialogpage', 'discussions', 'rankings', 'favicon.ico', 'apple-touch-icon.png',
    'robots.txt', 'sitemap.xml', '.well-known'
]);
const reserved = new Set(RESERVED_CATEGORY_PATHS);

export function isReservedCategoryName(name) {
    return reserved.has(normalized(name));
}

export function assertCategoryName(name) {
    if (typeof name !== 'string' || !name.trim() || /[/\\?#\p{Cc}\p{Cf}]/u.test(name)
        || ['.', '..'].includes(name.trim()) || isReservedCategoryName(name)) {
        throw new TypeError('This category name is reserved or cannot be used in a URL.');
    }
    return name.trim();
}

export function categorySegment(name) {
    return encodeURIComponent(assertCategoryName(name).replace(/\s+/g, '-'));
}

export function categoryPathParts(pathname) {
    return pathname.split('/').filter(Boolean).map(part => assertCategoryName(decodeURIComponent(part)));
}
