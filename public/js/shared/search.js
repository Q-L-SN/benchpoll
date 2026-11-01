import Fuse from '../vendor/fuse-7.5.0.js';

export function searchText(value) {
    return String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '')
        .toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}.]+/gu, ' ')
        .replace(/(?<!\d)\.|\.(?!\d)/gu, ' ').trim().replace(/\s+/g, ' ');
}

const compact = value => value.replaceAll(' ', '');

export function createSearchIndex(items, getFields, { identityFieldCount = 1 } = {}) {
    const documents = items.map((item, index) => {
        const values = getFields(item);
        const normalized = (Array.isArray(values) ? values : [values]).map(searchText);
        const fields = normalized.filter(Boolean);
        const identityFields = normalized.slice(0, identityFieldCount).filter(Boolean);
        return { item, index, fields, identities: [...identityFields, identityFields.join(' ')], words: fields.flatMap(field => field.split(' ')),
            primary: fields[0] ?? '', compact: fields.map(compact) };
    });
    const fuse = new Fuse(documents, { keys: ['fields'], includeScore: true,
        threshold: 0.24, ignoreLocation: true, ignoreFieldNorm: true });
    const cache = new Map();
    let identityFuse;
    function search(query, { limit = Infinity } = {}) {
        const text = searchText(query);
        if (!text) return items.slice(0, limit);
        if (!cache.has(text)) {
            const terms = [...new Set(text.split(' '))];
            const fuzzy = new Map();
            const exactHits = new Map();
            for (const term of terms) {
                const hasNumber = /\d/.test(term);
                const hits = new Set(documents.filter(doc =>
                    (hasNumber ? doc.words.some(word => word === term || (!/^\d/.test(term)
                        && word.startsWith(term) && !/[\d.]/.test(word.charAt(term.length))))
                        : doc.fields.some(field => field.includes(term)))
                    || doc.compact.some(field => !hasNumber ? field.includes(term)
                        : /\p{L}/u.test(term) && field.startsWith(term) && !/[\d.]/.test(field.charAt(term.length))))
                    .map(doc => doc.index));
                exactHits.set(term, hits);
                // Never approximate version numbers or very short abbreviations.
                fuzzy.set(term, !hits.size && term.length >= 4 && !hasNumber
                    ? new Map(fuse.search(term).map(hit => [hit.refIndex, hit.score])) : new Map());
            }
            const matches = [];
            for (const doc of documents) {
                let penalty = 0;
                let match = true;
                for (const term of terms) {
                    if (exactHits.get(term).has(doc.index)) continue;
                    const typo = fuzzy.get(term).get(doc.index);
                    if (typo === undefined) { match = false; break; }
                    penalty += 10 + typo;
                }
                if (!match) continue;
                const tier = doc.primary === text || compact(doc.primary) === compact(text) ? 0
                    : doc.primary.startsWith(text) ? 1 : doc.primary.includes(text) ? 2
                        : terms.every(term => doc.primary.includes(term)) ? 3 : 4;
                matches.push({ doc, score: penalty + tier });
            }
            matches.sort((a, b) => a.score - b.score || a.doc.index - b.doc.index);
            if (cache.size >= 32) cache.delete(cache.keys().next().value);
            cache.set(text, matches);
        }
        return cache.get(text).slice(0, limit).map(hit => hit.doc.item);
    }
    function rank(query) {
        const text = searchText(query);
        if (!text) return items.map(item => ({ item, score: 0, confidence: 0 }));
        search(text);
        identityFuse ??= new Fuse(documents, { keys: ['identities'], includeScore: true,
            threshold: 0.24, ignoreLocation: true, ignoreFieldNorm: true });
        const fuzzyIdentities = new Map(identityFuse.search(text).map(hit => [hit.refIndex, hit.score]));
        const terms = [...new Set(text.split(' '))];
        return cache.get(text).map(({ doc, score }) => {
            let confidence = Math.max(0, ...doc.identities.map(identity => {
                if (identity === text || compact(identity) === compact(text)) return 1;
                const words = [...new Set(identity.split(' '))];
                if (!terms.every(term => identity.includes(term))) return 0;
                if (terms.length === words.length && terms.every(term => words.includes(term))) return 1;
                return 0.65 + 0.3 * Math.min(1, text.length / identity.length);
            }));
            // A typo may be decisive; matching only tags or fallback members is not an identity match.
            if (!doc.identities.some(identity => terms.every(term => identity.includes(term)))) {
                const fuzzyScore = fuzzyIdentities.get(doc.index);
                if (fuzzyScore !== undefined) confidence = Math.max(confidence, 1 - fuzzyScore * 1.2);
            }
            return { item: doc.item, score, confidence };
        });
    }
    return { search, rank };
}

export function dominantSearchMatch(matches) {
    const ranked = [...matches].sort((left, right) => right.confidence - left.confidence || left.score - right.score);
    const best = ranked[0];
    const second = ranked[1]?.confidence ?? 0;
    return best && best.confidence >= 0.88 && best.confidence - second >= 0.18
        && best.confidence >= second * 1.25 ? best.item : null;
}

const indexes = new WeakMap();
export function searchItems(items, query, getFields, options) {
    let variants = indexes.get(items);
    if (!variants) { variants = new WeakMap(); indexes.set(items, variants); }
    if (!variants.has(getFields)) variants.set(getFields, createSearchIndex(items, getFields));
    return variants.get(getFields).search(query, options);
}
