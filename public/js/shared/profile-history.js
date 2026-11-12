import { postJSON } from './http.js';
import { pageAccountWriteScope } from './account-identity.js';

// Recording a visit must never delay or break topic navigation.
export async function recordProfileVisit({ categoryID, contextID = null } = {}) {
    try {
        if (!Number.isSafeInteger(Number(categoryID)) || Number(categoryID) < 1) return false;
        const body = { categoryID: Number(categoryID), ...(contextID == null ? {} : { contextID: Number(contextID) }) };
        const result = await pageAccountWriteScope.write((url, payload) => postJSON(url, payload, { timeoutMs: 10000, requireJSON: true }), '/api/record_profile_visit', body);
        return result?.recorded === true;
    } catch { return false; }
}
