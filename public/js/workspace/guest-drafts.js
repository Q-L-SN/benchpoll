import { createDraftRecordStore } from './draft-records.js';
import { FALLBACK_CONFIGURATION_VERSION } from '../shared/benchmark-families.js';

const LEGACY_KEY = 'benchpoll-guest-weights-v2-ordered';
const isWeightDraft = value => Array.isArray(value?.entries) && Array.isArray(value?.fallbackRules);
const withoutLegacyChoices = value => ({ ...value, fallbackRules: [] });
function withoutLegacyVotes(value) {
    const draft = { ...value };
    delete draft.estimationVotes;
    return draft;
}
function legacyDraft(value) {
    return isWeightDraft(value) ? withoutLegacyChoices(withoutLegacyVotes(value)) : null;
}

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
            if (!isWeightDraft(record?.value)) return null;
            let value = withoutLegacyVotes(record.value);
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
            if (!isWeightDraft(value) || Object.hasOwn(value, 'estimationVotes')) throw new TypeError('Invalid guest draft');
            return records.replace(key, records.read(key)?.token ?? null,
                { ...value, fallbackConfigurationVersion: FALLBACK_CONFIGURATION_VERSION }).durable;
        },
        delete(key) {
            return records.replace(key, records.read(key)?.token ?? null, null).durable;
        },
        deleteIfToken(key, token) { return records.replace(key, token, null); },
        getLegacy(key) {
            for (const item of legacy()) {
                if (!Array.isArray(item) || item[0] !== key) continue;
                const draft = legacyDraft(item[1]);
                if (draft) return draft;
            }
            return null;
        },
        discardLegacy(key, expected) {
            try {
                const saved = legacy();
                const remaining = saved.filter(item => !(Array.isArray(item) && item[0] === key
                    && JSON.stringify(legacyDraft(item[1])) === JSON.stringify(expected)));
                getStorage().setItem(LEGACY_KEY, JSON.stringify(remaining));
                return true;
            } catch { return false; }
        },
        get storageAvailable() { return records.storageAvailable; }
    };
}
