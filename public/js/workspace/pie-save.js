import { canonicalAccountID } from '../shared/account-identity.js';
import { canonicalWritePayload } from '../shared/write-intent.js';

export function validatePersonalPieSave(value, request, key) {
    const expectedRevision = request.entries.length ? request.expectedRevision + 1 : 0;
    if (value?.saved !== true || value.requestKey !== key || !canonicalAccountID(value.userID)
        || value.userID !== request.expectedUserID || value.categoryID !== request.categoryID
        || canonicalWritePayload(value.contextValues) !== canonicalWritePayload(request.contextValues)
        || !Number.isSafeInteger(value.personalPie?.revision) || value.personalPie.revision !== expectedRevision
        || canonicalWritePayload(value.personalPie.entries) !== canonicalWritePayload(request.entries)
        || canonicalWritePayload(value.personalPie.fallbackRules) !== canonicalWritePayload(request.fallbackRules)) {
        throw Object.assign(new Error('The save response could not be confirmed. Your changes are kept.'),
            { code: 'invalid_personal_pie_receipt' });
    }
    return value;
}
