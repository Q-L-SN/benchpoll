import { coverageMultiplier } from './coverage-penalty.js';
import { DEFAULT_ESTIMATION_ALGORITHM, normalizeEstimationAlgorithm } from './estimation-algorithms.js';

export const MIN_PAIRED_MODELS = 5;
export const MAX_HELD_OUT_ERROR = 5;
export const FALLBACK_INFERENCE_METHOD = 'calibrated-fallback';

export function fallbackInference(observedScore, coverageFraction, estimates, algorithm = DEFAULT_ESTIMATION_ALGORITHM) {
    normalizeEstimationAlgorithm(algorithm);
    if (!Number.isFinite(observedScore) || !Number.isFinite(coverageFraction) || coverageFraction < 0 || coverageFraction > 1
        || estimates.some(item => !Number.isFinite(item.normalizedScore) || !Number.isFinite(item.weightFraction)
            || item.weightFraction <= 0)) throw new TypeError('Invalid fallback evidence');
    const inferredFraction = estimates.reduce((sum, item) => sum + item.weightFraction, 0);
    const supported = coverageFraction + inferredFraction;
    if (supported > 1 + 1e-9) throw new TypeError('Fallback weights exceed the missing weight');
    if (supported <= 0) return null;
    const supportedFraction = Math.abs(1 - supported) < 1e-12 ? 1 : Math.min(1, supported);
    const observedContribution = observedScore * (coverageFraction / supportedFraction);
    const inferredContribution = estimates.reduce((sum, item) => sum + item.normalizedScore * (item.weightFraction / supportedFraction), 0);
    const unpenalizedScore = observedContribution + inferredContribution;
    const trace = { method: FALLBACK_INFERENCE_METHOD, algorithm, observedScore, coverageFraction, inferredFraction,
        supportedFraction, unresolvedFraction: Math.max(0, 1 - supportedFraction), observedContribution,
        inferredContribution, unpenalizedScore };
    if (algorithm === DEFAULT_ESTIMATION_ALGORITHM) {
        const coverageFactor = coverageMultiplier(supportedFraction);
        const appliedFactor = unpenalizedScore < 0 ? 2 - coverageFactor : coverageFactor;
        return { ...trace, coverageFactor, appliedFactor,
            totalScore: Math.max(-Number.MAX_VALUE, unpenalizedScore * appliedFactor) };
    }
    // Only a calibrated estimate can be adjusted. A wholly unresolved weight has no point value.
    const factor = algorithm === 'missing-raw' ? 1 : algorithm === 'missing-rational' ? coverageMultiplier(coverageFraction)
        : algorithm === 'missing-sqrt' ? Math.sqrt(coverageFraction) : coverageFraction;
    const adjustedMissingContribution = inferredContribution * factor + (algorithm === 'missing-midpoint'
        ? inferredFraction / supportedFraction * 50 * (1 - factor) : 0);
    return { ...trace, missingFactor: factor, adjustedMissingContribution,
        totalScore: observedContribution + adjustedMissingContribution };
}
