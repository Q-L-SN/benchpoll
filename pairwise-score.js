import { scoreDistribution, scorePercentile, PAIRWISE_INFERENCE_METHOD } from './public/js/shared/available-score.js';

export { PAIRWISE_INFERENCE_METHOD };
const identity = model => model.comparisonIdentity ?? JSON.stringify(['configuration', model.ID]);
const finite = value => {
    if (!Number.isFinite(value)) throw new TypeError('Pairwise scoring requires finite values');
    return value;
};
const dot = (left, right) => {
    let sum = 0;
    for (let i = 0; i < left.length; i++) sum += left[i] * right[i];
    return sum;
};

function fitComparisons(buckets, count, regularization) {
    const rhs = new Float64Array(count), diagonal = new Float64Array(count).fill(regularization);
    const sourceCounts = new Uint32Array(count), parent = Uint32Array.from({ length: count }, (_, i) => i);
    const root = index => {
        while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; }
        return index;
    };
    for (const bucket of buckets.values()) {
        if (bucket.indices.length < 2) continue;
        const size = bucket.indices.length, first = root(bucket.indices[0]);
        let mean = 0;
        for (const value of bucket.transformed) mean += value / size;
        bucket.mean = mean;
        for (let i = 0; i < size; i++) {
            const index = bucket.indices[i];
            parent[root(index)] = first;
            rhs[index] += bucket.transformed[i] - mean;
            diagonal[index] += 1 - 1 / size;
            sourceCounts[index]++;
        }
    }
    // A version's complete pairwise clique is exactly x_i - mean(x), so no N^2 matrix is needed.
    const multiply = (input, output) => {
        for (let i = 0; i < count; i++) output[i] = input[i] * regularization;
        for (const bucket of buckets.values()) {
            if (bucket.indices.length < 2) continue;
            let mean = 0;
            for (const index of bucket.indices) mean += input[index] / bucket.indices.length;
            for (const index of bucket.indices) output[index] += input[index] - mean;
        }
    };
    const ability = new Float64Array(count), residual = rhs.slice(), direction = new Float64Array(count);
    const preconditioned = new Float64Array(count), product = new Float64Array(count);
    for (let i = 0; i < count; i++) direction[i] = preconditioned[i] = residual[i] / diagonal[i];
    const norm = dot(rhs, rhs), tolerance = norm * 1e-20;
    let inner = dot(residual, preconditioned), iterations = 0, remaining = norm;
    for (; iterations < Math.min(160, count) && remaining > tolerance; iterations++) {
        multiply(direction, product);
        const denominator = dot(direction, product);
        if (!(denominator > 0) || !Number.isFinite(denominator)) break;
        const step = inner / denominator;
        for (let i = 0; i < count; i++) { ability[i] += step * direction[i]; residual[i] -= step * product[i]; }
        remaining = dot(residual, residual);
        if (remaining <= tolerance) { iterations++; break; }
        for (let i = 0; i < count; i++) preconditioned[i] = residual[i] / diagonal[i];
        const next = dot(residual, preconditioned), ratio = next / inner;
        for (let i = 0; i < count; i++) direction[i] = preconditioned[i] + ratio * direction[i];
        inner = next;
    }
    const components = Uint32Array.from(parent, (_, index) => root(index));
    return { ability, sourceCounts, components, iterations, converged: remaining <= tolerance,
        relativeResidual: norm ? Math.sqrt(remaining / norm) : 0 };
}

function calibration(points) {
    const ordered = points.slice().sort((a, b) => a.ability - b.ability || a.index - b.index);
    const blocks = [];
    for (let start = 0; start < ordered.length;) {
        let end = start + 1;
        while (end < ordered.length && ordered[end].ability === ordered[start].ability) end++;
        let value = 0;
        for (let i = start; i < end; i++) value += ordered[i].value / (end - start);
        blocks.push({ first: start, last: end - 1, count: end - start, value });
        while (blocks.length > 1 && blocks.at(-2).value > blocks.at(-1).value) {
            const right = blocks.pop(), left = blocks.pop(), count = left.count + right.count;
            blocks.push({ first: left.first, last: right.last, count,
                value: left.value * (left.count / count) + right.value * (right.count / count) });
        }
        start = end;
    }
    const knots = [];
    for (const block of blocks) for (let i = block.first; i <= block.last; i++) {
        if (knots.at(-1)?.ability !== ordered[i].ability) knots.push({ ability: ordered[i].ability, value: block.value });
    }
    return { knots, distribution: scoreDistribution(points.map(p => p.value)) };
}

// Limit isolated tail values only when fitting predictions; observations are unchanged.
const MIN_ISOLATED_GAP = 15;
const MAX_ISOLATED_ANCHORS = 3;
function robustCalibration(points) {
    if (points.length < 4) return calibration(points);
    const ordered = points.slice().sort((a, b) => a.value - b.value || a.index - b.index);
    const gaps = ordered.slice(1).map((point, i) => (point.value / 2 - ordered[i].value / 2) * 2)
        .sort((a, b) => a - b);
    const middle = Math.floor(gaps.length / 2);
    const typicalGap = gaps.length % 2 ? gaps[middle] : gaps[middle - 1] / 2 + gaps[middle] / 2;
    const threshold = Math.max(MIN_ISOLATED_GAP, 3 * typicalGap);
    const maxTail = Math.min(MAX_ISOLATED_ANCHORS, Math.floor((ordered.length - 1) / 2));
    const tailSize = fromStart => {
        let size = 0;
        for (let count = 1; count <= maxTail; count++) {
            const boundary = fromStart ? count : ordered.length - count;
            const gap = (ordered[boundary].value / 2 - ordered[boundary - 1].value / 2) * 2;
            if (gap > threshold) size = count;
        }
        return size;
    };
    const low = tailSize(true), high = tailSize(false);
    if (!low && !high || low + high > ordered.length - 2) return calibration(points);
    const core = ordered.slice(low, ordered.length - high);
    const quantile = fraction => {
        const index = (core.length - 1) * fraction, left = Math.floor(index), right = Math.ceil(index), part = index - left;
        return core[left].value * (1 - part) + core[right].value * part;
    };
    const scale = Math.max(1, Math.min(MIN_ISOLATED_GAP, (quantile(.75) / 2 - quantile(.25) / 2) * 3));
    const lower = core[0].value, upper = core.at(-1).value;
    const bounded = points.map(point => {
        const value = point.value < lower && low
            ? lower - scale * Math.tanh((lower / 2 - point.value / 2) * 2 / scale)
            : point.value > upper && high
                ? upper + scale * Math.tanh((point.value / 2 - upper / 2) * 2 / scale) : point.value;
        return { ...point, value: finite(value) };
    });
    return { ...calibration(bounded), distribution: scoreDistribution(points.map(point => point.value)) };
}

function calibratedScore(knots, ability) {
    let low = 0, high = knots.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (knots[middle].ability < ability) low = middle + 1; else high = middle;
    }
    if (!low) return knots[0].value;
    if (low === knots.length) return knots.at(-1).value;
    const left = knots[low - 1], right = knots[low];
    const fraction = (ability - left.ability) / (right.ability - left.ability);
    return finite(left.value * (1 - fraction) + right.value * fraction);
}

export function createPairwiseReference(models, { regularization = .5, transform = 'hybrid' } = {}) {
    if (!Number.isFinite(regularization) || regularization <= 0 || !['margin', 'percentile', 'hybrid'].includes(transform)) {
        throw new TypeError('Invalid pairwise fit options');
    }
    const ordered = models.map(model => ({ model, key: identity(model) })).sort((a, b) => a.key.localeCompare(b.key));
    const indices = new Map(), recorded = [], buckets = new Map();
    let cellCount = 0;
    for (let index = 0; index < ordered.length; index++) {
        const { model, key } = ordered[index];
        if (indices.has(key)) throw new TypeError('Duplicate comparison identity');
        indices.set(key, index);
        const values = new Map();
        for (const [condition, result] of model.results) {
            const value = finite(result.normalizedScore), version = String(condition);
            values.set(version, value); cellCount++;
            if (!buckets.has(version)) buckets.set(version, { indices: [], values: [], transformed: [] });
            const bucket = buckets.get(version); bucket.indices.push(index); bucket.values.push(value);
            bucket.transformed.push(Math.asinh(value / 100));
        }
        recorded.push(values);
    }
    if (transform !== 'margin') for (const bucket of buckets.values()) {
        const distribution = scoreDistribution(bucket.values);
        bucket.distribution = distribution;
        bucket.transformed = bucket.values.map(value => {
            const percentile = scorePercentile(distribution, value) ?? .5;
            return transform === 'percentile' ? percentile : .25 * percentile + .75 * Math.asinh(value / 100);
        });
    }
    const fit = fitComparisons(buckets, ordered.length, regularization), subjects = new WeakMap(), calibrations = new Map();
    const subject = model => {
        if (subjects.has(model)) return subjects.get(model);
        const index = indices.get(identity(model)), values = index === undefined ? null : recorded[index];
        const exact = values && values.size === model.results.size
            && [...model.results].every(([key, score]) => values.get(String(key)) === score.normalizedScore);
        const result = { index, exact: Boolean(exact), sourceCount: 0, components: new Map() };
        if (fit.converged && exact) result.sourceCount = fit.sourceCounts[index];
        else if (fit.converged) {
            for (const [key, score] of model.results) {
                const bucket = buckets.get(String(key));
                if (!bucket || bucket.indices.length < 2) continue;
                let meanValue = 0, meanAbility = 0, peers = 0;
                for (let i = 0; i < bucket.indices.length; i++) {
                    const peer = bucket.indices[i];
                    if (peer === index) continue;
                    meanValue += bucket.transformed[i]; meanAbility += fit.ability[peer]; peers++;
                }
                if (!peers) continue;
                const component = fit.components[bucket.indices[0]];
                if (!result.components.has(component)) result.components.set(component, { total: 0, count: 0 });
                const margin = Math.asinh(finite(score.normalizedScore) / 100);
                const percentile = transform === 'margin' ? null : scorePercentile(bucket.distribution, score.normalizedScore);
                const ownValue = transform === 'margin' ? margin : transform === 'percentile' ? percentile : .25 * percentile + .75 * margin;
                const estimate = result.components.get(component);
                estimate.total += ownValue - meanValue / peers + meanAbility / peers; estimate.count++;
                result.sourceCount++;
            }
        }
        subjects.set(model, result); return result;
    };
    return {
        method: PAIRWISE_INFERENCE_METHOD, cellCount, diagnostics: { nodes: models.length, versions: buckets.size,
            iterations: fit.iterations, converged: fit.converged, relativeResidual: fit.relativeResidual },
        estimate(model) { return { method: PAIRWISE_INFERENCE_METHOD, percentile: null, sourceCount: subject(model).sourceCount }; },
        predict(model, conditionID) {
            const current = subject(model), bucket = buckets.get(String(conditionID));
            if (!fit.converged || !current.sourceCount || !bucket || bucket.indices.length < 2) return null;
            const component = fit.components[bucket.indices[0]];
            const conditional = current.components.get(component);
            const ability = current.exact ? fit.components[current.index] === component ? fit.ability[current.index] : null
                : conditional ? conditional.total / (conditional.count + regularization) : null;
            if (ability === null) return null;
            const excluded = current.exact ? -1 : current.index ?? -1, cacheKey = JSON.stringify([String(conditionID), excluded]);
            if (!calibrations.has(cacheKey)) {
                const points = bucket.indices.flatMap((index, i) => index === excluded ? [] : [{ index, ability: fit.ability[index], value: bucket.values[i] }]);
                calibrations.set(cacheKey, points.length < 2 ? null : robustCalibration(points));
            }
            const curve = calibrations.get(cacheKey);
            if (!curve) return null;
            const normalizedScore = calibratedScore(curve.knots, ability);
            return { normalizedScore, percentile: scorePercentile(curve.distribution, normalizedScore),
                referenceCount: curve.distribution.count, sourceCount: current.exact ? current.sourceCount : conditional.count };
        }
    };
}
