export const RATIONAL_COVERAGE_A = 5;

export function coverageMultiplier(coverage) {
    if (!Number.isFinite(coverage) || coverage < 0 || coverage > 1) {
        throw new TypeError('Invalid coverage multiplier');
    }
    return RATIONAL_COVERAGE_A * coverage / (1 + (RATIONAL_COVERAGE_A - 1) * coverage);
}
