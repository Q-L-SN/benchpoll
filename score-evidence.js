import { createHash } from 'node:crypto';
import { canonicalNumber } from './public/js/shared/score-fields.js';

export function scoreEvidenceHash(scale, samples) {
    const contract = [scale.usesPercentageScale, scale.scoreDirection,
        scale.scoreMin === null ? null : canonicalNumber(Number(scale.scoreMin)),
        scale.scoreMax === null ? null : canonicalNumber(Number(scale.scoreMax)),
        scale.targetValue === null ? null : canonicalNumber(Number(scale.targetValue))];
    const evidence = samples.map(sample => {
        if (!Number.isSafeInteger(sample.ID) || sample.ID < 1) throw new Error('Invalid score evidence ID');
        return [sample.ID, canonicalNumber(Number(sample.rawScore))];
    }).sort((left, right) => left[0] - right[0]);
    return createHash('sha256').update(JSON.stringify([contract, evidence])).digest('hex');
}

export function normalizeExpectedEvidence(input) {
    if (input === undefined) return null;
    if (!input || Object.keys(input).some(key => !['conditionID', 'hash'].includes(key))
        || !Number.isSafeInteger(input.conditionID) || input.conditionID < 1
        || typeof input.hash !== 'string' || !/^[a-f0-9]{64}$/.test(input.hash)) {
        throw { status: 400, body: { error: 'invalid_ranking_evidence' } };
    }
    return { conditionID: input.conditionID, hash: input.hash };
}

export function assertRankingEvidence(expected, groups) {
    if (expected && !groups.some(group => group.benchmarkConditionID === expected.conditionID && group.evidenceHash === expected.hash)) {
        throw { status: 409, body: { error: 'ranking_evidence_changed', benchmarkConditionID: expected.conditionID } };
    }
}
