import { MIN_PAIRED_MODELS, MAX_HELD_OUT_ERROR } from './public/js/shared/fallback-inference.js';

// Scores are normalized to benchmark points before reaching this module.
// Each calibration is directional and uses paired measurements from one run configuration.
const NEARBY_POINTS = 10;

// The list is sorted by A minus B. Skip one position for a leave-one-model-out median.
function medianOffset(sorted, omit = -1) {
    const count = sorted.length - (omit >= 0 ? 1 : 0);
    const at = index => sorted[index + (omit >= 0 && index >= omit ? 1 : 0)].offset;
    return at(Math.floor((count - 1) / 2)) / 2 + at(Math.floor(count / 2)) / 2;
}

function localEstimate(pairs, subject, sourceScore) {
    const local = pairs.filter(pair => pair.modelID !== subject.modelID && Math.abs(pair.source - sourceScore) <= NEARBY_POINTS);
    if (local.length < MIN_PAIRED_MODELS || !local.some(pair => pair.source <= sourceScore)
        || !local.some(pair => pair.source >= sourceScore)) return null;

    const vendors = new Set(local.map(pair => pair.vendor).filter(Boolean));
    if (vendors.size === 1 && !vendors.has(subject.vendor)) return null;
    // Test each observation with its vendor held out when possible, otherwise hold out its model.
    const otherVendorOffsets = new Map();
    let error = 0;
    for (const [index, pair] of local.entries()) {
        let offset;
        if (pair.vendor && vendors.size > 1) {
            if (!otherVendorOffsets.has(pair.vendor)) {
                otherVendorOffsets.set(pair.vendor, medianOffset(local.filter(other => other.vendor !== pair.vendor)));
            }
            offset = otherVendorOffsets.get(pair.vendor);
        } else {
            offset = medianOffset(local, index);
        }
        error += Math.abs(offset - pair.offset) / local.length;
    }
    const normalizedScore = sourceScore + medianOffset(local);
    if (!Number.isFinite(normalizedScore) || !(error <= MAX_HELD_OUT_ERROR)) return null;
    return { normalizedScore, referenceCount: local.length, validationError: error };
}

const settingsKey = parameters => JSON.stringify(parameters == null ? null
    : Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b)));

export function createFallbackCalibration(configurations) {
    let byID;
    // A projected leaderboard row can combine different runs on different benchmarks.
    const indexRuns = () => byID ??= new Map(configurations.filter(config => !config.comparisonMode).map(config => [config.ID, {
        modelID: config.modelID ?? config.ID, vendor: config.vendorSlug || config.vendor,
        settings: settingsKey(config.condition?.parameters), results: config.results
    }]));
    const pairs = new Map();
    function pairedMeasurements(primary, source) {
        const key = primary + '/' + source;
        if (pairs.has(key)) return pairs.get(key);
        const settings = new Map();
        for (const config of indexRuns().values()) {
            const target = config.results.get(String(primary))?.normalizedScore;
            const backup = config.results.get(String(source))?.normalizedScore;
            if (!Number.isFinite(target) || !Number.isFinite(backup) || !Number.isFinite(target - backup)) continue;
            if (!settings.has(config.settings)) settings.set(config.settings, new Map());
            // loadModels already aggregates repeated runs for one model and identical settings.
            settings.get(config.settings).set(config.modelID, { modelID: config.modelID,
                vendor: config.vendor, source: backup, offset: target - backup });
        }
        const sorted = new Map([...settings].map(([setting, models]) =>
            [setting, [...models.values()].sort((a, b) => a.offset - b.offset || a.modelID - b.modelID)]));
        pairs.set(key, sorted);
        return sorted;
    }
    return {
        predict(model, primary, source, sourceScore, sourceMembers, matchedWeights = null) {
            const settings = pairedMeasurements(primary, source);
            const estimates = [];
            const members = matchedWeights ?? (sourceMembers ?? [model.ID]).map(ID => ({ ID }));
            for (const { ID, weight } of members) {
                const subject = byID.get(ID);
                if (!subject) return null;
                // Matched rows can average settings and measured scores. Calibrate each actual run.
                const measured = matchedWeights ? subject.results.get(String(source))?.normalizedScore : sourceScore;
                if (!Number.isFinite(measured)) return null;
                const estimate = localEstimate(settings.get(subject.settings) ?? [], subject, measured);
                if (!estimate) return null;
                estimates.push({ ...estimate, weight });
            }
            if (!estimates.length) return null;
            let normalizedScore;
            if (matchedWeights) normalizedScore = estimates.reduce((sum, item) => sum + item.normalizedScore * item.weight, 0);
            else {
                // Estimates from tied winning runs must agree.
                estimates.sort((a, b) => a.normalizedScore - b.normalizedScore);
                if (estimates.at(-1).normalizedScore - estimates[0].normalizedScore > MAX_HELD_OUT_ERROR) return null;
                const mid = Math.floor(estimates.length / 2);
                normalizedScore = estimates.length % 2 ? estimates[mid].normalizedScore
                    : estimates[mid - 1].normalizedScore / 2 + estimates[mid].normalizedScore / 2;
            }
            if (!Number.isFinite(normalizedScore)) return null;
            return { normalizedScore,
                referenceCount: estimates.reduce((n, item) => Math.min(n, item.referenceCount), Infinity),
                validationError: estimates.reduce((n, item) => Math.max(n, item.validationError), 0),
                sourceConditionID: source, sourceScore };
        }
    };
}
