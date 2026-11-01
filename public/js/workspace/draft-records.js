const tokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// One slot per draft prevents a restored document from rewriting another account's records.
export function createDraftRecordStore(prefix, getStorage = () => globalThis.sessionStorage) {
    const cached = new Map();
    let storageAvailable = true;
    let readAvailable = true;
    function read(key) {
        const slot = prefix + encodeURIComponent(key);
        let raw;
        try { raw = getStorage().getItem(slot); storageAvailable = true; readAvailable = true; }
        catch { storageAvailable = false; readAvailable = false; return structuredClone(cached.get(key)?.record ?? null); }
        const previous = cached.get(key);
        if (previous?.volatile && raw === previous.diskRaw) {
            storageAvailable = false;
            return structuredClone(previous.record);
        }
        let record = null;
        if (raw !== null && raw !== 'null') {
            try {
                record = JSON.parse(raw);
                if (!tokenPattern.test(record?.token ?? '') || !Object.hasOwn(record, 'value')) throw new TypeError();
            } catch { record = { token: raw, value: null, invalid: true }; }
        }
        cached.set(key, { diskRaw: raw, record });
        return structuredClone(record);
    }
    function replace(key, expectedToken, value) {
        const current = read(key);
        if ((current?.token ?? null) !== expectedToken) return { ok: false, durable: storageAvailable, record: current };
        const record = value === null ? null : { token: globalThis.crypto.randomUUID(), value: structuredClone(value) };
        const raw = record === null ? null : JSON.stringify(record);
        const diskRaw = cached.get(key)?.diskRaw ?? null;
        let durable = readAvailable;
        if (durable) {
            try {
                if (raw === null) {
                    const storage = getStorage();
                    if (typeof storage.removeItem === 'function') storage.removeItem(prefix + encodeURIComponent(key));
                    else storage.setItem(prefix + encodeURIComponent(key), 'null');
                } else getStorage().setItem(prefix + encodeURIComponent(key), raw);
            } catch { durable = false; }
        }
        storageAvailable = durable;
        cached.set(key, { diskRaw: durable ? raw : diskRaw, record, volatile: !durable });
        return { ok: true, durable, record: structuredClone(record) };
    }
    return { read, replace, get storageAvailable() { return storageAvailable; } };
}
