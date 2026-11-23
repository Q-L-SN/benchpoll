import { coverageMultiplier } from './coverage-penalty.js';
import { archivedMissingAdjustment, DEFAULT_ESTIMATION_ALGORITHM, isMissingInferenceMethod, normalizeEstimationAlgorithm,
    originalWeightContributions, ORIGINAL_WEIGHT_POLICY } from './estimation-algorithms.js';

export const MIN_PAIRED_MODELS = 5;
export const MAX_HELD_OUT_ERROR = 5;
export const FALLBACK_INFERENCE_METHOD = 'calibrated-fallback';

// Each input is already calibrated to the target scale using only paired measurements.
export function combineVersionEstimates(estimates) {
    if (!estimates.length) return null;
    const weights = estimates.map(({ referenceCount, validationError }) =>
        (referenceCount / (referenceCount + MIN_PAIRED_MODELS)) / (1 + validationError ** 2));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    // Scale first so the intermediate sum stays finite even for large signed scores.
    const scale = estimates.reduce((largest, estimate) => Math.max(largest, Math.abs(estimate.normalizedScore)), 0);
    const scaledSum = scale === 0 ? 0 : estimates.reduce((sum, estimate, index) =>
        sum + weights[index] * (estimate.normalizedScore / scale), 0);
    return {
        normalizedScore: (scaledSum / totalWeight) * scale,
        sources: estimates.map((estimate, index) => ({ ...estimate, weightFraction: weights[index] / totalWeight }))
    };
}

export function fallbackInference(observedScore, coverageFraction, estimates, algorithm = DEFAULT_ESTIMATION_ALGORITHM) {
    const contributions = originalWeightContributions(observedScore, coverageFraction, estimates);
    return { method: FALLBACK_INFERENCE_METHOD, algorithm: normalizeEstimationAlgorithm(algorithm),
        ...contributions, totalScore: contributions.unpenalizedScore };
}

export function storedFallbackInference(observedScore, coverageFraction, estimates, algorithm = DEFAULT_ESTIMATION_ALGORITHM, weightPolicy) {
    if (weightPolicy === ORIGINAL_WEIGHT_POLICY) return fallbackInference(observedScore, coverageFraction, estimates, algorithm);
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
