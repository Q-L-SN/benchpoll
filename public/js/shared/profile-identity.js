// Public handles are deliberately separate from the private provider/account ID.
export function publicProfileID(value) {
    if (typeof value !== 'string') return null;
    const id = value.trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/.test(id)) return null;
    if (/^\d+$/.test(id) && (!/^[1-9]\d*$/.test(id) || id.length > 20 || BigInt(id) > 18446744073709551615n)) return null;
    return id;
}

export function profileURL(value) {
    if (value && typeof value === 'object') value = value.publicID ?? value.handle;
    const id = publicProfileID(value);
    return id === null ? null : `/@${id}`;
}

export function publicProfileBio(value) {
    if (typeof value !== 'string' || value.length > 1120
        || /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value.replace(/\r?\n/g, ''))) return null;
    const bio = value.normalize('NFC').replace(/\r\n/g, '\n').trim();
    return [...bio].length <= 280 ? bio : null;
}
