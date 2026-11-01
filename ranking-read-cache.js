const snapshots = new WeakMap();
const calculationCaches = new WeakMap();

// Most response metadata is JSON-shaped. Avoid a native serialization round trip per model.
export function cloneRankingMetadata(value, seen = new Map()) {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    if (value instanceof Map) {
        const copy = new Map();
        seen.set(value, copy);
        for (const [key, item] of value) copy.set(cloneRankingMetadata(key, seen), cloneRankingMetadata(item, seen));
        return copy;
    }
    if (value instanceof Set) {
        const copy = new Set();
        seen.set(value, copy);
        for (const item of value) copy.add(cloneRankingMetadata(item, seen));
        return copy;
    }
    if (value instanceof Date) {
        const copy = new Date(value.getTime());
        seen.set(value, copy);
        return copy;
    }
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return structuredClone(value);
    const copy = Array.isArray(value) ? new Array(value.length) : {};
    seen.set(value, copy);
    for (const key of Object.keys(value)) {
        const next = cloneRankingMetadata(value[key], seen);
        if (key === '__proto__') Object.defineProperty(copy, key, { value: next, enumerable: true, writable: true, configurable: true });
        else copy[key] = next;
    }
    return copy;
}

// JSON cannot represent a Map. Preserve its existing wire shape without copying unused score cells.
export function cloneRankingMembersForJSON(members) {
    return cloneRankingMetadata(members.map(member => member.results instanceof Map ? { ...member, results: {} } : member));
}

export function deferRankingMetadata(object, key, load) {
    const replace = function (value) {
        Object.defineProperty(this, key, { value, enumerable: true, configurable: true, writable: true });
        return value;
    };
    Object.defineProperty(object, key, { enumerable: true, configurable: true,
        get() { return replace.call(this, load()); }, set: replace });
}

export function copyDeferredRankingRows(rows) {
    return rows.map(row => {
        const copy = Object.defineProperties({}, Object.getOwnPropertyDescriptors(row));
        for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(row))) {
            if ('value' in descriptor && descriptor.value && typeof descriptor.value === 'object') {
                deferRankingMetadata(copy, key, () => cloneRankingMetadata(descriptor.value));
            }
        }
        return copy;
    });
}

// Pie rows are always read fresh. Calculation reuse has a separate short-lived, owner-scoped memo.
export function createRankingReadCache({ maxEntries = 12, maxCells = 400000,
    maxAgeMs = 300000, now = () => Date.now() } = {}) {
    const entries = new Map();
    let cells = 0;
    const remove = key => {
        const entry = entries.get(key);
        if (entry) { cells -= entry.cells; entries.delete(key); }
    };
    const prune = () => {
        for (const [key, entry] of entries) if (entry.expiresAt <= now()) remove(key);
        while (entries.size > maxEntries || cells > maxCells) remove(entries.keys().next().value);
    };
    const cache = {
        async read(key, load, size = () => 0) {
            prune();
            let entry = entries.get(key);
            if (entry) { entries.delete(key); entries.set(key, entry); return entry.value; }
            entry = { value: null, cells: 0, expiresAt: now() + maxAgeMs };
            entry.value = Promise.resolve().then(load).then(value => {
                if (entries.get(key) === entry) {
                    entry.cells = size(value); cells += entry.cells;
                    entry.expiresAt = now() + maxAgeMs; prune();
                }
                return value;
            }).catch(error => { if (entries.get(key) === entry) remove(key); throw error; });
            entries.set(key, entry); prune();
            return entry.value;
        },
        clear() { entries.clear(); cells = 0; calculationCaches.get(cache)?.clear(); },
        get stats() { return { entries: entries.size, cells }; }
    };
    return cache;
}

export async function withRankingReadCache(connection, cache, build, assertActive = () => {}) {
    if (!cache) return build();
    let revision;
    try {
        const [rows] = await connection.execute(`SELECT CONCAT(d.epoch, ':', c.epoch) AS epoch,
            d.data_revision, c.catalogue_revision, (d.ready AND c.ready) AS ready
            FROM ranking_cache_revisions d JOIN ranking_cache_revisions c ON c.ID = 2 WHERE d.ID = 1`);
        revision = rows[0];
    } catch (error) {
        if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
    }
    if (!revision || !Number(revision.ready)) return build();
    snapshots.set(connection, { cache, assertActive, data: `${revision.epoch}:${revision.data_revision}`,
        catalogue: `${revision.epoch}:${revision.data_revision}:${revision.catalogue_revision}` });
    try { return await build(); }
    finally { snapshots.delete(connection); }
}

export async function cachedRankingRead(connection, domain, key, load, size) {
    const snapshot = snapshots.get(connection);
    if (!snapshot) return load();
    const identity = `${domain}:${snapshot[domain]}:${key}`;
    for (;;) {
        let produced = false;
        snapshot.assertActive();
        try {
            const value = await snapshot.cache.read(identity, async () => {
                produced = true;
                snapshot.assertActive();
                try { return await load(); }
                catch (error) {
                    // A late driver failure still belongs to its cancelled producer lease.
                    snapshot.assertActive();
                    throw error;
                }
            }, size);
            snapshot.assertActive();
            return value;
        } catch (error) {
            if (!['RANKING_READ_CANCELLED', 'RANKING_READ_TIMEOUT'].includes(error.code)) throw error;
            snapshot.assertActive();
            // Any number of other producers may stop; never retry our own failed load.
            if (produced) throw error;
        }
    }
}

export function hasRankingReadCache(connection) { return snapshots.has(connection); }

export async function cachedRankingCalculation(connection, key, load) {
    const snapshot = snapshots.get(connection);
    if (!snapshot) return load();
    snapshot.assertActive();
    if (!calculationCaches.has(snapshot.cache)) calculationCaches.set(snapshot.cache,
        createRankingReadCache({ maxEntries: 4, maxCells: 800000, maxAgeMs: 60000 }));
    const rows = await calculationCaches.get(snapshot.cache).read(`${snapshot.data}:${key}`, load,
        value => value.reduce((sum, row) => sum + 32 + row.resultCount * 12 + row.fallbackUsageCount * 16, 0));
    snapshot.assertActive();
    return copyDeferredRankingRows(rows);
}
