import { createDraftRecordStore } from './draft-records.js';
import { FALLBACK_CONFIGURATION_VERSION } from '../shared/benchmark-families.js';

const LEGACY_KEY = 'benchpoll-guest-weights-v2-ordered';
const validDraft = value => Array.isArray(value?.entries) && Array.isArray(value?.fallbackRules);
const withoutLegacyChoices = value => ({ ...value, fallbackRules: [] });

export function createGuestDraftStore(getStorage = () => globalThis.sessionStorage) {
    const records = createDraftRecordStore('benchpoll:guest-pie:v3:', getStorage);
    const legacy = () => {
        try {
            const saved = JSON.parse(getStorage().getItem(LEGACY_KEY) ?? '[]');
            return Array.isArray(saved) ? saved : [];
        } catch { return []; }
    };

    return {
        get(key) {
            const record = records.read(key);
            if (!validDraft(record?.value)) return null;
            let value = record.value;
            if (value.fallbackConfigurationVersion === undefined) {
                value = { ...withoutLegacyChoices(value), fallbackConfigurationVersion: FALLBACK_CONFIGURATION_VERSION };
                const replaced = records.replace(key, record.token, value);
                if (!replaced.ok) return null;
            }
            if (value.fallbackConfigurationVersion !== FALLBACK_CONFIGURATION_VERSION) return null;
            const draft = { ...value };
            delete draft.fallbackConfigurationVersion;
            return draft;
        },
        token(key) { return records.read(key)?.token ?? null; },
        set(key, value) {
            if (!validDraft(value)) throw new TypeError('Invalid guest draft');
            return records.replace(key, records.read(key)?.token ?? null,
                { ...value, fallbackConfigurationVersion: FALLBACK_CONFIGURATION_VERSION }).durable;
        },
        delete(key) {
            return records.replace(key, records.read(key)?.token ?? null, null).durable;
        },
        deleteIfToken(key, token) { return records.replace(key, token, null); },
        getLegacy(key) {
            const found = legacy().find(item => Array.isArray(item) && item[0] === key && validDraft(item[1]));
            return found ? withoutLegacyChoices(structuredClone(found[1])) : null;
        },
        discardLegacy(key, expected) {
            try {
                const saved = legacy();
                const remaining = saved.filter(item => !(Array.isArray(item) && item[0] === key
                    && JSON.stringify(withoutLegacyChoices(item[1])) === JSON.stringify(expected)));
                getStorage().setItem(LEGACY_KEY, JSON.stringify(remaining));
                return true;
            } catch { return false; }
        },
        get storageAvailable() { return records.storageAvailable; }
    };
}
