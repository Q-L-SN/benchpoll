import { coverageMultiplier } from './coverage-penalty.js';

export const DEFAULT_ESTIMATION_ALGORITHM = 'current';
export const ORIGINAL_WEIGHT_POLICY = 'original';
export const ESTIMATION_ALGORITHMS = Object.freeze([
    { ID: DEFAULT_ESTIMATION_ALGORITHM, label: 'Version-based estimation',
        description: 'Related versions predict missing scores together. Nominated external versions can supply an estimate when the same benchmark provides none. Remaining gaps use the weighted average of this model’s scores in the treemap.' }
].map(Object.freeze));
const retiredAlgorithms = new Set(['missing-raw', 'missing-rational', 'missing-linear', 'missing-sqrt', 'missing-midpoint']);
export function normalizeEstimationAlgorithm(value = DEFAULT_ESTIMATION_ALGORITHM) {
    if (value !== DEFAULT_ESTIMATION_ALGORITHM) throw new TypeError('Invalid estimation algorithm');
    return DEFAULT_ESTIMATION_ALGORITHM;
}
export function estimationRequest(algorithm = DEFAULT_ESTIMATION_ALGORITHM) {
    normalizeEstimationAlgorithm(algorithm);
    return {};
}
export const isMissingInferenceMethod = method => typeof method === 'string' && method.startsWith('pairwise-')
    && retiredAlgorithms.has(method.slice('pairwise-'.length));

export function originalWeightContributions(observedScore, coverage, estimates) {
    if (!Number.isFinite(observedScore) || !Number.isFinite(coverage) || coverage < 0 || coverage > 1 + 1e-9) {
        throw new TypeError('Invalid observed score or coverage');
    }
    const coverageFraction = Math.min(1, coverage);
    let inferredFraction = 0, inferredContribution = 0;
    for (const estimate of estimates) {
        if (!Number.isFinite(estimate.weightFraction) || estimate.weightFraction <= 0
            || !Number.isFinite(estimate.normalizedScore)) {
            throw new TypeError('Invalid missing estimate');
        }
        inferredFraction += estimate.weightFraction;
        inferredContribution += estimate.normalizedScore * estimate.weightFraction;
    }
    const supported = coverageFraction + inferredFraction;
    if (supported > 1 + 1e-9) throw new TypeError('Inferred weights exceed the missing weight');
    const supportedFraction = Math.abs(1 - supported) < 1e-12 ? 1 : Math.min(1, supported);
    const observedContribution = observedScore * coverageFraction;
    return { weightPolicy: ORIGINAL_WEIGHT_POLICY, observedScore: coverageFraction === 0 ? 0 : observedScore,
        coverageFraction, inferredFraction, supportedFraction, unresolvedFraction: 1 - supportedFraction,
        observedContribution, inferredContribution, unresolvedContribution: 0,
        unpenalizedScore: observedContribution + inferredContribution };
}

// Archived traces retain the formula used to calculate them.
export function archivedMissingAdjustment({ coverageFraction, inferredFraction, inferredContribution }, algorithm) {
    const missingFactor = algorithm === 'missing-rational' ? coverageMultiplier(coverageFraction)
        : algorithm === 'missing-sqrt' ? Math.sqrt(coverageFraction) : algorithm === 'missing-raw' ? 1 : coverageFraction;
    const adjustedMissingContribution = inferredContribution * missingFactor
        + (algorithm === 'missing-midpoint' ? inferredFraction * 50 * (1 - missingFactor) : 0);
    return { missingFactor, adjustedMissingContribution };
}

export function storedMissingOnlyInference(observedScore, coverage, estimates, sourceCount, algorithm) {
    if (!retiredAlgorithms.has(algorithm) || coverage <= 0 || !Number.isSafeInteger(sourceCount) || sourceCount < 0
        || estimates.some(estimate => !sourceCount || estimate.normalizedScore < 0 || estimate.normalizedScore > 100)) {
        throw new TypeError('Invalid bounded missing estimate');
    }
    const { coverageFraction, observedContribution, inferredFraction, inferredContribution } = originalWeightContributions(observedScore, coverage, estimates);
    const missingFraction = 1 - coverageFraction;
    const unresolvedFraction = Math.max(0, missingFraction - inferredFraction);
    const unresolvedContribution = unresolvedFraction * 50;
    const missingContribution = inferredContribution + unresolvedContribution;
    const { missingFactor, adjustedMissingContribution: adjusted } = archivedMissingAdjustment({ coverageFraction,
        inferredFraction: missingFraction, inferredContribution: missingContribution }, algorithm);
    const adjustedMissingContribution = Math.min(missingFraction * 100, Math.max(0, adjusted));
    return { method: `pairwise-${algorithm}`, algorithm, percentile: null, sourceCount,
        observedScore, coverageFraction, inferredFraction, unresolvedFraction, observedContribution, inferredContribution,
        unresolvedContribution, missingContribution, missingFactor, adjustedMissingContribution,
        unpenalizedScore: observedContribution + missingContribution, totalScore: observedContribution + adjustedMissingContribution };
}
