import { coverageMultiplier } from './coverage-penalty.js';

export const DEFAULT_ESTIMATION_ALGORITHM = 'current';
export const ESTIMATION_ALGORITHMS = Object.freeze([
    { ID: 'current', label: 'Current · whole score', description: 'The existing rational coverage adjustment applies to the whole score.' },
    { ID: 'missing-raw', label: 'Missing · unadjusted', description: 'Keep measured contributions fixed and use missing-score estimates without attenuation.' },
    { ID: 'missing-rational', label: 'Missing · rational', description: 'Keep measured contributions fixed. Multiply the missing contribution by 5c / (1 + 4c), where c is measured coverage.' },
    { ID: 'missing-linear', label: 'Missing · linear', description: 'Keep measured contributions fixed. Multiply the missing contribution by measured coverage.' },
    { ID: 'missing-sqrt', label: 'Missing · square root', description: 'Keep measured contributions fixed. Multiply the missing contribution by the square root of measured coverage.' },
    { ID: 'missing-midpoint', label: 'Missing · midpoint', description: 'Keep measured contributions fixed. Blend missing estimates toward 50 as coverage falls; this can raise or lower the score.' }
].map(Object.freeze));
const algorithms = new Set(ESTIMATION_ALGORITHMS.map(item => item.ID));
export function normalizeEstimationAlgorithm(value = DEFAULT_ESTIMATION_ALGORITHM) {
    if (!algorithms.has(value)) throw new TypeError('Invalid estimation algorithm');
    return value;
}
export function estimationRequest(algorithm = DEFAULT_ESTIMATION_ALGORITHM) {
    return normalizeEstimationAlgorithm(algorithm) === DEFAULT_ESTIMATION_ALGORITHM ? {} : { estimationAlgorithm: algorithm };
}
export const missingInferenceMethod = algorithm => `pairwise-${algorithm}`;
export const isMissingInferenceMethod = method => ESTIMATION_ALGORITHMS.slice(1)
    .some(item => missingInferenceMethod(item.ID) === method);

// Experimental point estimates. 50 is a fixed scenario midpoint, not an empirical prior.
// All weights retain their original denominator, including wholly unresolved gaps.
export function missingOnlyInference(observedScore, coverage, estimates, sourceCount, algorithm) {
    normalizeEstimationAlgorithm(algorithm);
    if (algorithm === DEFAULT_ESTIMATION_ALGORITHM || !Number.isFinite(observedScore)
        || !Number.isFinite(coverage) || coverage <= 0 || coverage > 1 + 1e-9
        || !Number.isSafeInteger(sourceCount) || sourceCount < 0) throw new TypeError('Invalid missing-only inference');
    const covered = Math.min(1, coverage), missing = 1 - covered;
    let inferredFraction = 0, inferredContribution = 0;
    for (const estimate of estimates) {
        if (!sourceCount || !Number.isFinite(estimate.weightFraction) || estimate.weightFraction <= 0
            || !Number.isFinite(estimate.normalizedScore) || estimate.normalizedScore < 0 || estimate.normalizedScore > 100) {
            throw new TypeError('Invalid bounded missing estimate');
        }
        inferredFraction += estimate.weightFraction;
        inferredContribution += estimate.normalizedScore * estimate.weightFraction;
    }
    if (inferredFraction > missing + 1e-9) throw new TypeError('Inferred weights exceed the missing weight');
    const unresolvedFraction = Math.max(0, missing - inferredFraction);
    const unresolvedContribution = unresolvedFraction * 50;
    const observedContribution = observedScore * covered;
    const missingContribution = inferredContribution + unresolvedContribution;
    const missingFactor = algorithm === 'missing-rational' ? coverageMultiplier(covered)
        : algorithm === 'missing-sqrt' ? Math.sqrt(covered) : algorithm === 'missing-raw' ? 1 : covered;
    const adjustedMissingContribution = Math.min(missing * 100, Math.max(0, missingContribution * missingFactor
        + (algorithm === 'missing-midpoint' ? missing * 50 * (1 - missingFactor) : 0)));
    return { method: missingInferenceMethod(algorithm), algorithm, percentile: null, sourceCount,
        observedScore, coverageFraction: covered, inferredFraction, unresolvedFraction,
        observedContribution, inferredContribution, unresolvedContribution, missingContribution, missingFactor,
        adjustedMissingContribution, unpenalizedScore: observedContribution + missingContribution,
        totalScore: observedContribution + adjustedMissingContribution };
}
