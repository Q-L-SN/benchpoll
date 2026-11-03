import { coverageMultiplier } from './coverage-penalty.js';
import { DEFAULT_ESTIMATION_ALGORITHM, normalizeEstimationAlgorithm, missingOnlyInference,
    isMissingInferenceMethod } from './estimation-algorithms.js';

const finite = value => {
    if (!Number.isFinite(value)) throw new TypeError('Percentile scoring requires finite values');
    return value;
};

export const PAIRWISE_INFERENCE_METHOD = 'pairwise-anchored';
export const PAIRWISE_COVERAGE_METHOD = 'pairwise-anchored-coverage';
export const PAIRWISE_COVERAGE_FACTOR_METHOD = 'pairwise-anchored-coverage-factor';
export const PAIRWISE_RATIONAL_COVERAGE_FACTOR_METHOD = 'pairwise-anchored-rational-coverage-factor';
export const AVAILABLE_COVERAGE_EXPONENT = .35;
export const AVAILABLE_COVERAGE_PENALTY_POINTS = 20;
export const AVAILABLE_INFERENCE_VERSION = 7;

export function normalizeAvailableInferenceVersion(version = AVAILABLE_INFERENCE_VERSION) {
    if (![1, 2, 3, 4, 5, 6, 7].includes(version)) throw new TypeError('Invalid available inference version');
    // Stale clients may still send a retired version, but new calculations use the current one.
    return AVAILABLE_INFERENCE_VERSION;
}

export function rankingReadBody(url, body) {
    return url === '/api/get_weighted_workspace'
        ? { ...body, availableInferenceVersion: normalizeAvailableInferenceVersion(body?.availableInferenceVersion) } : body;
}

export function scoreDistribution(values) {
    const sorted = [...values].map(finite).sort((a, b) => a - b);
    const knots = [];
    for (let first = 0; first < sorted.length;) {
        let last = first;
        while (last + 1 < sorted.length && sorted[last + 1] === sorted[first]) last++;
        knots.push({ value: sorted[first], percentile: sorted.length < 2 ? .5 : (first + last) / 2 / (sorted.length - 1) });
        first = last + 1;
    }
    return { values: sorted, knots, count: sorted.length };
}

export function scorePercentile(distribution, score) {
    finite(score);
    if (distribution.count < 2) return null;
    const { knots } = distribution;
    let low = 0, high = knots.length;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (knots[mid].value < score) low = mid + 1; else high = mid;
    }
    if (low < knots.length && knots[low].value === score) return knots[low].percentile;
    if (low === 0) return 0;
    if (low === knots.length) return 1;
    const left = knots[low - 1], right = knots[low];
    const fraction = (score / 2 - left.value / 2) / (right.value / 2 - left.value / 2);
    return left.percentile * (1 - fraction) + right.percentile * fraction;
}

export function percentileScore(distribution, percentile) {
    if (!Number.isFinite(percentile) || percentile < 0 || percentile > 1) throw new TypeError('Invalid percentile');
    if (!distribution.count) return null;
    const index = percentile * (distribution.count - 1);
    const lower = Math.floor(index), upper = Math.ceil(index), fraction = index - lower;
    return finite(distribution.values[lower] * (1 - fraction) + distribution.values[upper] * fraction);
}

// One projected comparison object contributes at most one real score per version.
export function createPercentileReference(models) {
    const values = new Map();
    for (const model of models) for (const [key, score] of model.results) {
        if (!values.has(key)) values.set(key, []);
        values.get(key).push(finite(score.normalizedScore));
    }
    const distributions = new Map([...values].map(([key, scores]) => [key, scoreDistribution(scores)]));
    return {
        distributions,
        estimate(model) {
            let percentile = 0, sourceCount = 0;
            for (const [key, score] of model.results) {
                const distribution = distributions.get(key);
                if (!distribution || distribution.count < 2) continue;
                const value = scorePercentile(distribution, score.normalizedScore);
                percentile += value; sourceCount++;
            }
            return { percentile: sourceCount ? percentile / sourceCount : null, sourceCount };
        }
    };
}

export function availableResultInference(observedScore, coverageFraction, estimates, percentile = null, sourceCount = 0,
    algorithm = DEFAULT_ESTIMATION_ALGORITHM) {
    normalizeEstimationAlgorithm(algorithm);
    if (algorithm !== DEFAULT_ESTIMATION_ALGORITHM) {
        if (percentile !== null) throw new TypeError('Missing-only inference requires pairwise estimates');
        return missingOnlyInference(observedScore, coverageFraction, estimates, sourceCount, algorithm);
    }
    return storedAvailableResultInference(observedScore, coverageFraction, estimates, percentile, sourceCount,
        { method: PAIRWISE_RATIONAL_COVERAGE_FACTOR_METHOD });
}

// Historical evidence must be checked against the formula recorded in its trace.
export function storedAvailableResultInference(observedScore, coverageFraction, estimates, percentile = null, sourceCount = 0,
    { method } = {}) {
    if (isMissingInferenceMethod(method)) {
        if (percentile !== null) throw new TypeError('Missing-only inference requires pairwise estimates');
        return missingOnlyInference(observedScore, coverageFraction, estimates, sourceCount, method.slice('pairwise-'.length));
    }
    finite(observedScore);
    if (!Number.isFinite(coverageFraction) || coverageFraction <= 0 || coverageFraction > 1 + 1e-9
        || !Number.isSafeInteger(sourceCount) || sourceCount < 0
        || !['mean-percentile', PAIRWISE_INFERENCE_METHOD, PAIRWISE_COVERAGE_METHOD, PAIRWISE_COVERAGE_FACTOR_METHOD, PAIRWISE_RATIONAL_COVERAGE_FACTOR_METHOD].includes(method)
        || (method !== 'mean-percentile' ? percentile !== null
            : sourceCount ? !Number.isFinite(percentile) || percentile < 0 || percentile > 1 : percentile !== null)) {
        throw new TypeError('Invalid available-result inference');
    }
    let inferredFraction = 0, inferredWeightedScore = 0;
    for (const score of estimates) {
        if (!sourceCount || !Number.isFinite(score.weightFraction) || score.weightFraction <= 0) {
            throw new TypeError('Invalid inferred weight');
        }
        inferredFraction += score.weightFraction;
        inferredWeightedScore += finite(score.normalizedScore) * score.weightFraction;
    }
    const covered = Math.min(1, coverageFraction);
    const scoringFraction = covered + inferredFraction;
    if (scoringFraction > 1 + 1e-9) throw new TypeError('Inferred weights exceed the missing weight');
    const observedContribution = observedScore * (covered / scoringFraction);
    const inferredContribution = inferredWeightedScore / scoringFraction;
    const unpenalizedScore = finite(observedContribution + inferredContribution);
    if ([PAIRWISE_COVERAGE_FACTOR_METHOD, PAIRWISE_RATIONAL_COVERAGE_FACTOR_METHOD].includes(method)) {
        // The retired formula is retained only to validate stored calculation traces.
        const coverageFactor = method === PAIRWISE_COVERAGE_FACTOR_METHOD
            ? covered ** AVAILABLE_COVERAGE_EXPONENT : coverageMultiplier(covered);
        // Mirror the relative loss for negatives; division would explode near zero coverage.
        const appliedFactor = unpenalizedScore < 0 ? 2 - coverageFactor : coverageFactor;
        return { method, percentile, sourceCount, observedScore, coverageFraction: covered,
            inferredFraction, unresolvedFraction: Math.max(0, 1 - scoringFraction),
            observedContribution, inferredContribution, unpenalizedScore, coverageFactor, appliedFactor,
            totalScore: finite(Math.max(-Number.MAX_VALUE, unpenalizedScore * appliedFactor)) };
    }
    const coveragePenalty = AVAILABLE_COVERAGE_PENALTY_POINTS * (1 - covered);
    return { method, percentile, sourceCount, observedScore, coverageFraction: covered,
        inferredFraction, unresolvedFraction: Math.max(0, 1 - scoringFraction),
        observedContribution, inferredContribution,
        ...(method === PAIRWISE_COVERAGE_METHOD ? { unpenalizedScore, coveragePenalty } : {}),
        totalScore: method === PAIRWISE_COVERAGE_METHOD ? finite(unpenalizedScore - coveragePenalty) : unpenalizedScore };
}
