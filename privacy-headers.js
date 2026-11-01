// Review changed inline code before updating these pins; never hash injected response HTML.
export const REVIEWED_INLINE_SCRIPT_HASHES = Object.freeze({
    'private/home-built.html': 'sha256-zSiEQmbqsMJ3hZy19yrV/0f6vkXAZuzTz35grU6xUWI=',
    'public/assets/color-studies-20260909/index.html': 'sha256-B0jVaV6qxBJ0imok6w4LyDDPnOr2rAJlZAZ/MgW7yFc='
});

export const PRIVACY_CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    `script-src 'self' ${Object.values(REVIEWED_INLINE_SCRIPT_HASHES).map(hash => `'${hash}'`).join(' ')}`,
    "script-src-attr 'none'",
    // Existing custom elements, charts and controls require inline styles, not inline scripts.
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    // Custom avatars are fully decoded/re-encoded PNGs; data URLs are image-only.
    "img-src 'self' data: https:",
    "font-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'"
].join('; ');

export function privacyHeaders(_req, res, next) {
    const current = res.getHeader('Content-Security-Policy');
    const policies = current === undefined ? [] : Array.isArray(current) ? current : [current];
    // Additional policies intersect in browsers; do not replace another middleware's protection.
    if (!policies.includes(PRIVACY_CONTENT_SECURITY_POLICY)) {
        res.setHeader('Content-Security-Policy', policies.length
            ? [...policies, PRIVACY_CONTENT_SECURITY_POLICY] : PRIVACY_CONTENT_SECURITY_POLICY);
    }
    if (res.getHeader('Referrer-Policy') !== 'no-referrer') res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
}
