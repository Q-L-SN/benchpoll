import { canonicalAccountID } from '../shared/account-identity.js';
import { canonicalWritePayload } from '../shared/write-intent.js';
import { familyKey, FALLBACK_CONFIGURATION_VERSION } from '../shared/benchmark-families.js';
import { createDraftRecordStore } from './draft-records.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => integer(value) && value > 0;
export function pieRecoveryContextKey(categoryID, contextValues) {
    return `${categoryID}:${JSON.stringify(Object.entries(contextValues).sort(([a], [b]) => a.localeCompare(b)))}`;
}
function validScope(ownerID, categoryID, contextValues) {
    return typeof ownerID === 'string' && canonicalAccountID(ownerID) === ownerID && positive(categoryID)
        && contextValues && typeof contextValues === 'object' && !Array.isArray(contextValues)
        && Object.entries(contextValues).every(([key, value]) => key.length > 0 && typeof value === 'string');
}
function validPie(pie) {
    if (!Array.isArray(pie?.entries) || !Array.isArray(pie?.fallbackRules)) return false;
    const IDs = new Set();
    for (const entry of pie.entries) {
        if (!Number.isSafeInteger(entry?.conditionID) || entry.conditionID === 0 || !integer(entry.weightBasisPoints) || entry.weightBasisPoints > 10000
            || IDs.has(entry.conditionID)) return false;
        IDs.add(entry.conditionID);
    }
    if (pie.entries.length && pie.entries.reduce((total, entry) => total + entry.weightBasisPoints, 0) !== 10000) return false;
    const rules = new Set();
    try {
        for (const rule of pie.fallbackRules) {
            if (!positive(rule.primaryConditionID) || !IDs.has(rule.primaryConditionID) || rules.has(rule.primaryConditionID) || rule.mode !== 'ordered'
                || !Array.isArray(rule.entries)) return false;
            familyKey(rule.primaryConditionID, rule.entries);
            rules.add(rule.primaryConditionID);
        }
    } catch { return false; }
    return true;
}
function validRecovery(value, ownerID, categoryID, contextValues) {
    if (!validScope(ownerID, categoryID, contextValues) || value?.schema !== 1 || value.ownerID !== ownerID
        || value.fallbackConfigurationVersion !== FALLBACK_CONFIGURATION_VERSION
        || value.categoryID !== categoryID || canonicalWritePayload(value.contextValues) !== canonicalWritePayload(contextValues)
        || !integer(value.editVersion) || !integer(value.revision) || !validPie(value.draft)) return false;
    if (value.pending === null) return true;
    const pending = value.pending, body = pending?.body;
    return uuid.test(pending?.key ?? '') && integer(pending.editVersion) && pending.editVersion <= value.editVersion
        && body?.expectedUserID === ownerID && body.categoryID === categoryID
        && canonicalWritePayload(body.contextValues) === canonicalWritePayload(contextValues)
        && integer(body.expectedRevision) && body.expectedRevision <= value.revision && validPie(body)
        && (pending.editVersion !== value.editVersion || canonicalWritePayload({ entries: body.entries, fallbackRules: body.fallbackRules })
            === canonicalWritePayload(value.draft))
        && (body.fallbackConfigurationVersion === undefined || body.fallbackConfigurationVersion === FALLBACK_CONFIGURATION_VERSION)
        && Object.keys(body).every(key => ['expectedUserID', 'categoryID', 'contextValues', 'expectedRevision', 'entries', 'fallbackRules', 'fallbackConfigurationVersion'].includes(key));
}
function changedDraftError() {
    return Object.assign(new Error('This draft changed in another page. Refresh to review it before saving.'), { code: 'pie_recovery_changed' });
}

export function createPersonalPieRecovery({ state, guestDrafts, snapshot, getStorage = () => globalThis.sessionStorage }) {
    const records = createDraftRecordStore('benchpoll:owned-pie:v1:', getStorage);
    const slot = (ownerID, categoryID, contextValues) => `${ownerID}:${pieRecoveryContextKey(categoryID, contextValues)}`;
    const scope = () => ({ ownerID: state.userID, categoryID: state.categoryID, contextValues: { ...state.selectedContextValues } });
    function lookup(ownerID, categoryID, contextValues, { revision } = {}) {
        if (!validScope(ownerID, categoryID, contextValues)) return null;
        let record = records.read(slot(ownerID, categoryID, contextValues));
        if (!record) return null;
        if (record.value && !Object.hasOwn(record.value, 'fallbackConfigurationVersion')) {
            const value = { ...record.value, fallbackConfigurationVersion: FALLBACK_CONFIGURATION_VERSION,
                draft: { ...record.value.draft, fallbackRules: [] }, pending: null,
                revision: revision ?? record.value.revision };
            if (validRecovery(value, ownerID, categoryID, contextValues)) {
                const replaced = records.replace(slot(ownerID, categoryID, contextValues), record.token, value);
                if (replaced.ok) record = replaced.record;
            }
        }
        return validRecovery(record.value, ownerID, categoryID, contextValues) ? record
            : { token: record.token, invalid: true, value: null };
    }
    function replace(value) {
        const { ownerID, categoryID, contextValues } = scope();
        if (!validScope(ownerID, categoryID, contextValues) || !validRecovery(value, ownerID, categoryID, contextValues)) {
            throw new TypeError('Invalid account draft');
        }
        const result = records.replace(slot(ownerID, categoryID, contextValues), state.personalRecoveryToken, value);
        if (!result.ok) throw changedDraftError();
        state.personalRecoveryToken = result.record?.token ?? null;
        state.guestDraftStorageAvailable = result.durable;
        return result;
    }
    function checkpoint() {
        if (!state.authenticated || state.accountWriteBlocked || state.personalRecoveryBlocked) return null;
        const { ownerID, categoryID, contextValues } = scope();
        const request = state.personalSaveRequest;
        if (request && (request.body?.expectedUserID !== ownerID || request.body.categoryID !== categoryID
            || canonicalWritePayload(request.body.contextValues) !== canonicalWritePayload(contextValues))) {
            throw Object.assign(new Error('A pending save belongs to another context. Refresh to review your drafts.'),
                { code: 'pie_save_scope_changed' });
        }
        return replace({ schema: 1, fallbackConfigurationVersion: FALLBACK_CONFIGURATION_VERSION,
            ownerID, categoryID, contextValues, revision: state.personalRevision,
            editVersion: state.personalEditVersion, draft: snapshot(),
            pending: request?.key ? { body: request.body, key: request.key, editVersion: request.editVersion } : null });
    }
    return {
        lookup, checkpoint,
        newRequest(request) {
            return { ...request, body: structuredClone(request.body), key: globalThis.crypto.randomUUID() };
        },
        bind(record) {
            state.personalRecoveryToken = record?.token ?? null;
            state.personalRecoveryBlocked = record?.invalid === true;
            state.recoveredPersonalDraft = Boolean(record && !record.invalid);
            if (record?.value) {
                state.personalEditVersion = record.value.editVersion;
                const pending = record.value.pending;
                state.personalSaveRequest = pending ? { ...structuredClone(pending),
                    snapshot: { entries: structuredClone(pending.body.entries), fallbackRules: structuredClone(pending.body.fallbackRules) } } : null;
            }
        },
        capture(request, key, body = request.body) {
            if (canonicalWritePayload(body) !== canonicalWritePayload(request.body)) throw new TypeError('The pending body changed before transport');
            request.key = key;
            if (!checkpoint()) throw changedDraftError();
        },
        acknowledge(request, revision) {
            const { ownerID, categoryID, contextValues } = scope();
            const current = lookup(ownerID, categoryID, contextValues);
            if (current && (current.token !== state.personalRecoveryToken || current.value?.pending?.key !== request.key)) throw changedDraftError();
            state.personalSaveRequest = null;
            state.personalRevision = revision;
            if (request.editVersion !== state.personalEditVersion) return checkpoint();
            const result = records.replace(slot(ownerID, categoryID, contextValues), state.personalRecoveryToken, null);
            if (!result.ok) throw changedDraftError();
            state.personalRecoveryToken = null;
            state.guestDraftStorageAvailable = result.durable;
            state.recoveredPersonalDraft = false;
            return result;
        },
        adoptGuest() {
            const key = pieRecoveryContextKey(state.categoryID, state.selectedContextValues);
            const token = guestDrafts.token(key);
            const result = checkpoint();
            // Once saving is initiated, this is account data, not an anonymous preview.
            if (result?.durable) {
                guestDrafts.deleteIfToken(key, token);
                state.recoveredPersonalDraft = true;
            }
            else throw Object.assign(new Error('Browser storage is unavailable. Keep this tab open; sign in again after storage is enabled to save this preview safely.'),
                { code: 'pie_guest_binding_unavailable' });
        },
        discard() {
            const { ownerID, categoryID, contextValues } = scope();
            const result = records.replace(slot(ownerID, categoryID, contextValues), state.personalRecoveryToken, null);
            if (!result.ok) throw changedDraftError();
            state.personalRecoveryToken = null;
            state.personalRecoveryBlocked = false;
            state.recoveredPersonalDraft = false;
            state.personalSaveRequest = null;
            return result.durable;
        },
        get storageAvailable() { return records.storageAvailable; }
    };
}
