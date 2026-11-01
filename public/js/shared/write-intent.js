export function canonicalWritePayload(value) {
    return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}

function browserStorage() {
    try { return globalThis.sessionStorage ?? null; } catch { return null; }
}

async function payloadDigest(value) {
    const bytes = await globalThis.crypto.subtle.digest('SHA-256', new globalThis.TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

const keyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createRetryableWrite(request, { storage = browserStorage(),
    randomUUID = () => globalThis.crypto.randomUUID(), digest = payloadDigest } = {}) {
    const pending = new Map();
    const prefix = 'benchpoll:unconfirmed-write:';
    return async (path, body, options = {}) => {
        const { validateResponse, requestKey, onIdentity, ...requestOptions } = options;
        if (validateResponse !== undefined && typeof validateResponse !== 'function') throw new TypeError('Invalid write validator.');
        if (onIdentity !== undefined && typeof onIdentity !== 'function') throw new TypeError('Invalid write identity callback.');
        if (requestKey !== undefined && !keyPattern.test(requestKey)) throw new TypeError('Invalid retained write identity.');
        // Snapshot before hashing so a later draft edit cannot change the identified request.
        const captured = JSON.parse(canonicalWritePayload(body));
        const signature = await digest(canonicalWritePayload({ path, body: captured }));
        const slot = prefix + signature;
        let key = requestKey ?? pending.get(slot);
        if (!key) {
            try { key = storage?.getItem(slot); } catch { /* Keep an in-memory identity if storage is unavailable. */ }
            if (!keyPattern.test(key ?? '')) key = randomUUID();
            pending.set(slot, key);
            try { storage?.setItem(slot, key); } catch { /* The active document still retains the identity. */ }
        }
        const forget = () => {
            if (pending.get(slot) === key) pending.delete(slot);
            try { if (storage?.getItem(slot) === key) storage.removeItem(slot); } catch { /* Successful writes may leave harmless replay metadata. */ }
        };
        try {
            // Persist the captured body and identity together before a transport can start.
            if (onIdentity) await onIdentity(key, captured);
            const result = await request(path, captured, { ...requestOptions,
                headers: { ...requestOptions.headers, 'Idempotency-Key': key }, requireJSON: true });
            if (validateResponse) await validateResponse(result, captured, key);
            forget();
            return result;
        } catch (error) {
            if (['write_identity_required', 'invalid_write_identity', 'write_identity_reused'].includes(error.payload?.error)) forget();
            throw error;
        }
    };
}
