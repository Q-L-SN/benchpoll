import { canonicalAccountID } from '../shared/account-identity.js';
import { canonicalWritePayload } from '../shared/write-intent.js';
import { normalizeEstimationVotes } from '../shared/estimation-votes.js';

function confirmsEstimationVotes(actual, expected) {
    try {
        if (actual === undefined) return expected === undefined;
        const votes = normalizeEstimationVotes(actual);
        return expected === undefined || canonicalWritePayload(votes) === canonicalWritePayload(normalizeEstimationVotes(expected));
    } catch { return false; }
}

export function validatePersonalPieSave(value, request, key) {
    const expectedRevision = request.entries.length ? request.expectedRevision + 1 : 0;
    const returnedRules = value?.personalPie?.fallbackRules;
    const expectedRules = request.fallbackRules === undefined ? [] : request.fallbackRules;
    if (value?.saved !== true || value.requestKey !== key || !canonicalAccountID(value.userID)
        || value.userID !== request.expectedUserID || value.categoryID !== request.categoryID
        || canonicalWritePayload(value.contextValues) !== canonicalWritePayload(request.contextValues)
        || !Number.isSafeInteger(value.personalPie?.revision) || value.personalPie.revision !== expectedRevision
        || canonicalWritePayload(value.personalPie.entries) !== canonicalWritePayload(request.entries)
        || canonicalWritePayload(returnedRules === undefined ? [] : returnedRules) !== canonicalWritePayload(expectedRules)
        || !confirmsEstimationVotes(value.personalPie.estimationVotes, request.estimationVotes)) {
        throw Object.assign(new Error('The save response could not be confirmed. Your changes are kept.'),
            { code: 'invalid_personal_pie_receipt' });
    }
    return value;
}
