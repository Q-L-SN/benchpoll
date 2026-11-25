// Joint conditional mean on normalized benchmark points. Rows contain a measured target
// in column zero and at least one measured source. Missing source cells are NaN.
const PRIOR_STRENGTH = 2;
const PRIOR_CORRELATION = 0.70;
const EM_STEPS = 7;
const matrix = size => Array.from({ length: size }, () => new Float64Array(size));

function cholesky(covariance, columns, ridge) {
    const factor = matrix(columns.length);
    for (let i = 0; i < columns.length; i++) {
        for (let j = 0; j <= i; j++) {
            let value = covariance[columns[i]][columns[j]] + (i === j ? ridge[i] : 0);
            for (let k = 0; k < j; k++) value -= factor[i][k] * factor[j][k];
            factor[i][j] = i === j ? Math.sqrt(value) : value / factor[j][j];
        }
    }
    return factor;
}

function solve(factor, rhs) {
    const solution = Float64Array.from(rhs);
    for (let i = 0; i < solution.length; i++) {
        for (let j = 0; j < i; j++) solution[i] -= factor[i][j] * solution[j];
        solution[i] /= factor[i][i];
    }
    for (let i = solution.length - 1; i >= 0; i--) {
        for (let j = i + 1; j < solution.length; j++) solution[i] -= factor[j][i] * solution[j];
        solution[i] /= factor[i][i];
    }
    return solution;
}

// Invert a positive-definite block using its already factored lower triangle.
function inverse(factor) {
    const size = factor.length;
    return Array.from({ length: size }, (_, i) => {
        const unit = new Float64Array(size);
        unit[i] = 1;
        return solve(factor, unit);
    });
}

function columnStats(rows, column) {
    let low = Infinity, high = -Infinity, count = 0;
    for (const row of rows) {
        const x = row[column];
        if (!Number.isFinite(x)) continue;
        low = Math.min(low, x);
        high = Math.max(high, x);
        count++;
    }
    // Work in bounded units when taking moments. Benchmark points may be signed or open-ended.
    const unit = Math.max(1, Math.abs(low), Math.abs(high));
    let mean = 0, variance = 0;
    for (const row of rows) if (Number.isFinite(row[column])) mean += (row[column] / unit) / count;
    mean = Math.max(low / unit, Math.min(high / unit, mean));
    for (const row of rows) if (Number.isFinite(row[column])) variance += (row[column] / unit - mean) ** 2 / count;
    return { low, high, mean: mean * unit, scale: Math.hypot(Math.min(1, Math.sqrt(variance)) * unit, 0.5) };
}

function difference(x, y, scale) {
    const delta = x - y;
    return Number.isFinite(delta) ? delta / scale : x / scale - y / scale;
}

function addMoments(vector, sum, products) {
    for (let i = 0; i < vector.length; i++) {
        sum[i] += vector[i];
        for (let j = 0; j <= i; j++) products[i][j] += vector[i] * vector[j];
    }
}

function expectedMoments(group, center, covariance, sum, products) {
    const { observed, missing, rows } = group;
    const factor = cholesky(covariance, observed, observed.map(() => 1e-8));
    const slopes = missing.map(i => solve(factor, observed.map(j => covariance[j][i])));
    const filled = new Float64Array(center.length);
    for (const row of rows) {
        for (const i of observed) filled[i] = row[i];
        for (const [k, i] of missing.entries()) {
            let x = center[i];
            for (let j = 0; j < observed.length; j++) x += slopes[k][j] * (row[observed[j]] - center[observed[j]]);
            filled[i] = x;
        }
        addMoments(filled, sum, products);
    }
    // E[xxᵀ] also includes the uncertainty of each missing block.
    for (const [k, i] of missing.entries()) {
        for (const j of missing) {
            if (j > i) break;
            let conditional = covariance[i][j];
            for (let t = 0; t < observed.length; t++) conditional -= slopes[k][t] * covariance[observed[t]][j];
            products[i][j] += rows.length * conditional;
        }
    }
}

// With many nearly complete patterns, conditioning on the smaller missing block
// reuses one precision matrix. This is the same conditional mean and covariance.
function expectedFromPrecision({ observed, missing, rows }, center, precision, sum, products) {
    const conditional = inverse(cholesky(precision, missing, missing.map(() => 0)));
    const offsets = new Float64Array(missing.length);
    const filled = new Float64Array(center.length);
    for (const row of rows) {
        for (const i of observed) filled[i] = row[i];
        for (let j = 0; j < missing.length; j++) {
            const coefficients = precision[missing[j]];
            let value = 0;
            for (const i of observed) value += coefficients[i] * (row[i] - center[i]);
            offsets[j] = value;
        }
        for (let j = 0; j < missing.length; j++) {
            let value = center[missing[j]];
            for (let k = 0; k < missing.length; k++) value -= conditional[j][k] * offsets[k];
            filled[missing[j]] = value;
        }
        addMoments(filled, sum, products);
    }
    for (let j = 0; j < missing.length; j++) {
        for (let k = 0; k <= j; k++) {
            // The full covariance was ridged before inversion. Only observed columns
            // carry that ridge in the reference conditional distribution.
            products[missing[j]][missing[k]] += rows.length * (conditional[j][k] - (j === k ? 1e-8 : 0));
        }
    }
}

export function fitJointVersionModel(rows) {
    const size = rows[0].length;
    const columns = Array.from({ length: size }, (_, i) => i);
    const stats = columns.map(i => columnStats(rows, i));
    const completeSum = new Float64Array(size), completeProducts = matrix(size);
    const groups = new Map();
    for (const row of rows) {
        const observed = columns.filter(i => Number.isFinite(row[i]));
        const standardized = row.map((x, i) => difference(x, stats[i].mean, stats[i].scale));
        if (observed.length === size) {
            addMoments(standardized, completeSum, completeProducts);
            continue;
        }
        const key = observed.join(',');
        if (!groups.has(key)) groups.set(key, { observed, missing: columns.filter(i => !Number.isFinite(row[i])), rows: [] });
        groups.get(key).rows.push(standardized);
    }

    const center = new Float64Array(size);
    const covariance = columns.map(i => Float64Array.from(columns, j => i === j ? 1 : PRIOR_CORRELATION));
    const mass = rows.length + PRIOR_STRENGTH;
    const patterns = [...groups.values()];
    const dense = patterns.filter(group => group.missing.length < group.observed.length);
    // A full Cholesky factor and its inverse cost about 7d³/6 multiply-adds.
    // Reuse that inverse only when it saves work across the recorded masks.
    const separateCost = dense.reduce((sum, { observed, missing }) =>
        sum + observed.length ** 2 * (observed.length / 6 + missing.length), 0);
    const nearComplete = separateCost > 7 * size ** 3 / 6 ? dense : [];
    const otherGroups = nearComplete.length ? patterns.filter(group => group.missing.length >= group.observed.length) : patterns;
    // With complete observations every iteration gives exactly the same moments.
    for (let step = 0; step < (groups.size ? EM_STEPS : 1); step++) {
        const sum = completeSum.slice(), products = completeProducts.map(row => row.slice());
        for (const group of otherGroups) expectedMoments(group, center, covariance, sum, products);
        if (nearComplete.length) {
            const precision = inverse(cholesky(covariance, columns, columns.map(() => 1e-8)));
            for (const group of nearComplete) expectedFromPrecision(group, center, precision, sum, products);
        }
        for (const i of columns) center[i] = sum[i] / mass;
        for (const i of columns) {
            for (let j = 0; j <= i; j++) {
                const prior = i === j ? 1 : PRIOR_CORRELATION;
                covariance[j][i] = covariance[i][j] = (products[i][j] + PRIOR_STRENGTH * prior) / mass
                    - center[i] * center[j] + (i === j ? 1e-7 : 0);
            }
        }
    }
    const sources = columns.slice(1);
    // The final ridge is in benchmark points. Solve in standardized units to keep it well conditioned.
    const factor = cholesky(covariance, sources, sources.map(i => 1e-7 / stats[i].scale / stats[i].scale));
    const slopes = solve(factor, sources.map(i => covariance[0][i]));
    // Capture only the compact fitted coefficients and scales in the ranking cache.
    return { stats, center, slopes };
}

export function predictJointVersion({ stats, center, slopes }, measured) {
    let z = center[0];
    for (let j = 0; j < measured.length; j++) {
        const { low, high, mean, scale } = stats[j + 1];
        const edge = Math.max(low, Math.min(high, measured[j]));
        const outside = difference(measured[j], edge, scale);
        const reach = 1.8 + 3 / scale;
        const excursion = outside === 0 ? 0 : Math.sign(outside) * reach / Math.hypot(1, reach / outside);
        z += slopes[j] * (difference(edge, mean, scale) + excursion - center[j + 1]);
    }
    const { mean, scale } = stats[0];
    let score = mean + scale * z;
    if (!Number.isFinite(score)) {
        const unit = Math.max(Math.abs(mean), scale);
        score = (mean / unit + (scale / unit) * z) * unit;
    }
    return Number.isFinite(score) ? score : null;
}
