import { coverageMultiplier } from './coverage-penalty.js';
import { archivedMissingAdjustment, DEFAULT_ESTIMATION_ALGORITHM, isMissingInferenceMethod, normalizeEstimationAlgorithm,
    originalWeightContributions, ORIGINAL_WEIGHT_POLICY } from './estimation-algorithms.js';

export const FALLBACK_INFERENCE_METHOD = 'calibrated-fallback';
export const JOINT_VERSION_METHOD = 'joint-versions';
export const TREEMAP_ESTIMATION_METHOD = 'treemap-chain';
export const PEER_MEDIAN_METHOD = 'peer-median';
export const SUPPORTED_WEIGHT_POLICY = 'supported';

export function fallbackInference(observedScore, coverageFraction, estimates, algorithm = DEFAULT_ESTIMATION_ALGORITHM, normalizeGaps = false) {
    const contributions = originalWeightContributions(observedScore, coverageFraction, estimates);
    const { supportedFraction } = contributions;
    if (normalizeGaps && supportedFraction > 0 && supportedFraction < 1) {
        contributions.weightPolicy = SUPPORTED_WEIGHT_POLICY;
        contributions.observedContribution /= supportedFraction;
        contributions.inferredContribution /= supportedFraction;
        contributions.unpenalizedScore = contributions.observedContribution + contributions.inferredContribution;
    }
    return { method: FALLBACK_INFERENCE_METHOD, algorithm: normalizeEstimationAlgorithm(algorithm),
        ...contributions, totalScore: contributions.unpenalizedScore };
}

export function storedFallbackInference(observedScore, coverageFraction, estimates, algorithm = DEFAULT_ESTIMATION_ALGORITHM, weightPolicy) {
    if (weightPolicy === ORIGINAL_WEIGHT_POLICY) return fallbackInference(observedScore, coverageFraction, estimates, algorithm);
    if (weightPolicy === SUPPORTED_WEIGHT_POLICY) return fallbackInference(observedScore, coverageFraction, estimates, algorithm, true);
    if (weightPolicy !== undefined) throw new TypeError('Invalid fallback weight policy');
    if (algorithm !== DEFAULT_ESTIMATION_ALGORITHM && !isMissingInferenceMethod(`pairwise-${algorithm}`)) {
        throw new TypeError('Invalid archived estimation algorithm');
    }
    const original = originalWeightContributions(observedScore, coverageFraction, estimates);
    const { inferredFraction, supportedFraction, unresolvedFraction } = original;
    if (!supportedFraction) return null;
    const observedContribution = original.observedContribution / supportedFraction;
    const inferredContribution = original.inferredContribution / supportedFraction;
    const unpenalizedScore = observedContribution + inferredContribution;
    const trace = { method: FALLBACK_INFERENCE_METHOD, algorithm, observedScore, coverageFraction, inferredFraction,
        supportedFraction, unresolvedFraction, observedContribution, inferredContribution, unpenalizedScore };
    if (algorithm === DEFAULT_ESTIMATION_ALGORITHM) {
        const coverageFactor = coverageMultiplier(supportedFraction);
        const appliedFactor = unpenalizedScore < 0 ? 2 - coverageFactor : coverageFactor;
        return { ...trace, coverageFactor, appliedFactor,
            totalScore: Math.max(-Number.MAX_VALUE, unpenalizedScore * appliedFactor) };
    }
    const adjustment = archivedMissingAdjustment({ ...trace, inferredFraction: inferredFraction / supportedFraction }, algorithm);
    return { ...trace, ...adjustment, totalScore: observedContribution + adjustment.adjustedMissingContribution };
}
