import { comparisonProfileKey } from '../shared/comparison-profile-key.js';
import { canonicalAccountID, accountWriteError, isAccountWriteError } from '../shared/account-identity.js';

const STORAGE_PREFIX = 'benchpoll-comparison-profiles-v2:';
const MAX_PROFILES = 25;

const copy = value => structuredClone(value);

function validComparison(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !['best', 'matched'].includes(value.mode) || !Array.isArray(value.keys)
        || !Array.isArray(value.filters) || value.keys.some(key => typeof key !== 'string')
        || value.filters.some(filter => !filter || typeof filter !== 'object' || Array.isArray(filter))) {
        throw new Error('A saved comparison configuration is invalid.');
    }
    return { mode: value.mode, keys: [...value.keys], filters: copy(value.filters) };
}

function normalizedName(value) {
    const name = typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
    if (!name || name.length > 80 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new Error('Enter a name of up to 80 characters.');
    return name;
}

function normalizeProfiles(value) {
    if (!value || !Array.isArray(value.profiles) || value.profiles.length > MAX_PROFILES) {
        throw new Error('Saved comparison profiles are invalid.');
    }
    const seen = new Set();
    const profiles = value.profiles.map(profile => {
        const name = normalizedName(profile.name);
        const key = name.toLowerCase();
        if (seen.has(key)) throw new Error('Duplicate saved comparison profile.');
        seen.add(key);
        return { name, comparison: validComparison(profile.comparison) };
    });
    return { last: value.last === null ? null : validComparison(value.last), profiles };
}

export function createComparisonProfileStore({ request, storage = () => globalThis.localStorage }) {
    let authenticated = false;
    let userID = null;
    let storageKey = STORAGE_PREFIX + 'guest';
    let current = { last: null, profiles: [] };
    let saveTail = Promise.resolve();
    let epoch = 0;
    let loadSequence = 0;
    let accountWriteBlocked = false;

    function readLocal(key = storageKey) {
        const raw = storage().getItem(key);
        return raw === null ? { last: null, profiles: [] } : normalizeProfiles(JSON.parse(raw));
    }
    function writeLocal() {
        storage().setItem(storageKey, JSON.stringify(authenticated
            ? { last: current.last, profiles: [] } : current));
    }
    function snapshot() {
        return { authenticated, last: copy(current.last), profiles: copy(current.profiles) };
    }
    function writeContext() {
        return { epoch, authenticated, expectedUserID: userID };
    }
    function assertCurrent(context) {
        if (context.epoch !== epoch || context.authenticated !== authenticated
            || context.expectedUserID !== userID || accountWriteBlocked) throw accountWriteError();
    }
    async function requestOwned(path, body, context) {
        assertCurrent(context);
        let response;
        try { response = await request(path, { ...body, expectedUserID: context.expectedUserID }); }
        catch (error) {
            if (context.epoch === epoch && isAccountWriteError(error)) accountWriteBlocked = true;
            throw isAccountWriteError(error) ? accountWriteError(error.payload?.error ?? error.body?.error) : error;
        }
        assertCurrent(context);
        return response;
    }
    return {
        async load() {
            const sequence = ++loadSequence;
            let response;
            try { response = await request('/api/get_comparison_profiles', {}, { timeoutMs: 10000, requireJSON: true }); }
            catch (error) { if (sequence !== loadSequence) return snapshot(); throw error; }
            if (sequence !== loadSequence) return snapshot();
            if (!response || typeof response.authenticated !== 'boolean') throw new Error('Saved comparison profiles could not be loaded.');
            const nextAuthenticated = response.authenticated;
            const nextUserID = nextAuthenticated ? canonicalAccountID(response.userID) : null;
            if (nextAuthenticated && !nextUserID) {
                throw new Error('Saved comparison profiles have no account identity.');
            }
            const nextStorageKey = STORAGE_PREFIX + (nextUserID ?? 'guest');
            const server = nextAuthenticated ? normalizeProfiles(response) : null;
            let local;
            let warning;
            try { local = readLocal(nextStorageKey); }
            catch (error) {
                if (!nextAuthenticated) throw error;
                local = { last: null, profiles: [] };
                warning = 'Your local comparison cache could not be read; account settings were loaded.';
            }
            authenticated = nextAuthenticated;
            userID = nextUserID;
            storageKey = nextStorageKey;
            epoch += 1;
            accountWriteBlocked = false;
            current = authenticated ? { last: local.last ?? server.last, profiles: server.profiles } : local;
            return warning ? { ...snapshot(), warning } : snapshot();
        },
        snapshot,
        accountID: () => userID,
        saveLast(comparison) {
            const context = writeContext();
            current.last = validComparison(comparison);
            try { writeLocal(); }
            catch (error) { if (!authenticated) return Promise.reject(error); }
            if (!authenticated) return Promise.resolve(snapshot());
            const saved = copy(current.last);
            const task = saveTail.catch(() => {}).then(() => requestOwned('/api/save_comparison_profile', { comparison: saved }, context));
            saveTail = task;
            return task.then(() => snapshot());
        },
        async saveNamed(nameValue, comparisonValue) {
            const context = writeContext();
            const name = normalizedName(nameValue);
            const comparison = validComparison(comparisonValue);
            const key = name.toLowerCase();
            const duplicate = current.profiles.find(profile => comparisonProfileKey(profile.comparison) === comparisonProfileKey(comparison));
            if (duplicate) throw new Error(`Already saved as "${duplicate.name}".`);
            if (current.profiles.some(profile => profile.name.toLowerCase() === key)) throw new Error('That configuration name is already in use.');
            if (current.profiles.length >= MAX_PROFILES) throw new Error('You can save up to 25 configurations.');
            const saved = authenticated
                ? await requestOwned('/api/save_comparison_profile', { name, comparison }, context)
                : { name, comparison };
            const profile = { name: saved.name, comparison: validComparison(saved.comparison) };
            current.profiles.push(profile);
            current.profiles.sort((a, b) => a.name.localeCompare(b.name));
            if (!authenticated) writeLocal();
            return snapshot();
        },
        async renameNamed(nameValue, newNameValue) {
            const context = writeContext();
            const name = normalizedName(nameValue), newName = normalizedName(newNameValue);
            const index = current.profiles.findIndex(profile => profile.name.toLowerCase() === name.toLowerCase());
            if (index === -1) throw new Error('That configuration no longer exists.');
            if (current.profiles.some((profile, other) => other !== index && profile.name.toLowerCase() === newName.toLowerCase())) {
                throw new Error('That configuration name is already in use.');
            }
            if (authenticated) await requestOwned('/api/rename_comparison_profile', { name, newName }, context);
            current.profiles[index].name = newName;
            current.profiles.sort((a, b) => a.name.localeCompare(b.name));
            if (!authenticated) writeLocal();
            return snapshot();
        },
        async deleteNamed(nameValue) {
            const context = writeContext();
            const name = normalizedName(nameValue);
            const index = current.profiles.findIndex(profile => profile.name.toLowerCase() === name.toLowerCase());
            if (index === -1) throw new Error('That configuration no longer exists.');
            if (authenticated) await requestOwned('/api/delete_comparison_profile', { name }, context);
            current.profiles.splice(index, 1);
            if (!authenticated) writeLocal();
            return snapshot();
        }
    };
}
