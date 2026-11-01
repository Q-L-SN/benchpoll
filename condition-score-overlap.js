import { canonicalNumber } from './public/js/shared/score-fields.js';

const SCALE = 1000000n;
function decimal(input) {
    const match = String(input).match(/^(-?)(\d+)(?:\.(\d{1,6}))?$/);
    if (!match) throw new Error(`Invalid DECIMAL(18,6) score: ${input}`);
    const magnitude = BigInt(match[2]) * SCALE + BigInt((match[3] ?? '').padEnd(6, '0'));
    const value = match[1] ? -magnitude : magnitude;
    const text = decimalText(value);
    return { value, text, places: text.includes('.') ? text.split('.')[1].length : 0 };
}

function decimalText(value) {
    const magnitude = value < 0n ? -value : value;
    const fraction = String(magnitude % SCALE).padStart(6, '0').replace(/0+$/, '');
    return `${value < 0n ? '-' : ''}${magnitude / SCALE}${fraction ? `.${fraction}` : ''}`;
}

export function roundedScoreVariants(input) {
    const { value, places } = decimal(input);
    const variants = new Map();
    for (let precision = 0; precision < places; precision++) {
        const unit = 10n ** BigInt(6 - precision);
        const magnitude = value < 0n ? -value : value;
        const round = ((magnitude + unit / 2n) / unit) * unit * (value < 0n ? -1n : 1n);
        const floor = (value / unit - (value < 0n && value % unit ? 1n : 0n)) * unit;
        for (const [method, result] of [['round', round], ['floor', floor]]) {
            const score = decimalText(result);
            const actualPlaces = score.includes('.') ? score.split('.')[1].length : 0;
            if (actualPlaces !== precision || result === value) continue;
            const key = `${score}:${precision}`;
            if (!variants.has(key)) variants.set(key, { score, precision, methods: [] });
            variants.get(key).methods.push(method);
        }
    }
    return [...variants.values()];
}

function identityFields(input, catalog) {
    const fields = typeof input === 'string' ? JSON.parse(input) : input;
    if (!Array.isArray(fields)) throw new Error('Score fields must be an array');
    const seen = new Set();
    return fields.map(item => {
        const field = catalog.get(Number(item.fieldID));
        if (!field || !Number.isSafeInteger(item.fieldID) || seen.has(item.fieldID)
            || Object.keys(item).some(key => !['fieldID', 'value'].includes(key))
            || !Object.hasOwn(item, 'value')) throw new Error(`Invalid field assignment: ${JSON.stringify(item)}`);
        seen.add(item.fieldID);
        return { fieldID: item.fieldID, value: field.type === 'number' && item.value !== null
            ? canonicalNumber(item.value) : item.value };
    }).sort((a, b) => a.fieldID - b.fieldID);
}

function scaleSignature(condition) {
    return JSON.stringify([condition.score_direction, condition.target_value == null ? null : canonicalNumber(condition.target_value),
        Boolean(Number(condition.uses_percentage_scale)),
        condition.score_min == null ? null : canonicalNumber(condition.score_min),
        condition.score_max == null ? null : canonicalNumber(condition.score_max)]);
}

export function auditConditionScoreOverlap(snapshot, {
    onProgress = () => {}, confirmedMergeGroups = [], includeConditionPair = () => true
} = {}) {
    if (snapshot.version !== 1 && snapshot.version !== 2) throw new Error('Unsupported snapshot version');
    const catalog = new Map(snapshot.fields.map(field => [Number(field.ID), field]));
    const conditions = new Map(snapshot.conditions.map(condition => [Number(condition.ID), {
        ...condition, ID: Number(condition.ID), benchmark_ID: Number(condition.benchmark_ID),
        samples: new Map(), configurations: new Map(), scale: scaleSignature(condition)
    }]));
    const confirmedGroups = new Map();
    confirmedMergeGroups.forEach((group, index) => {
        const IDs = [group.targetID, ...group.sourceIDs];
        const benchmarkIDs = new Set();
        if (IDs.length < 2) throw new Error('Confirmed merge group has no sources');
        for (const ID of IDs) {
            if (!conditions.has(ID) || confirmedGroups.has(ID)) throw new Error(`Missing or repeated confirmed condition ${ID}`);
            confirmedGroups.set(ID, index);
            benchmarkIDs.add(conditions.get(ID).benchmark_ID);
        }
        if (benchmarkIDs.size !== 1) throw new Error('Confirmed merge group spans multiple benchmarks');
    });
    const families = new Map();
    const samples = [];
    for (const row of snapshot.results) {
        const condition = conditions.get(Number(row.conditionID));
        if (!condition) throw new Error(`Unknown condition on result ${row.ID}`);
        const fields = identityFields(row.fields, catalog);
        const configKey = JSON.stringify([Number(row.modelID), fields]);
        const score = decimal(row.rawScore).text;
        const sampleKey = JSON.stringify([configKey, score]);
        let sample = condition.samples.get(sampleKey);
        if (!sample) {
            sample = { index: samples.length, conditionID: condition.ID, modelID: Number(row.modelID),
                modelName: row.modelName, fields, score, resultIDs: [], sources: [] };
            condition.samples.set(sampleKey, sample);
            samples.push(sample);
            if (!condition.configurations.has(configKey)) condition.configurations.set(configKey, new Set());
            condition.configurations.get(configKey).add(score);
            if (!families.has(condition.benchmark_ID)) families.set(condition.benchmark_ID, new Map());
            const family = families.get(condition.benchmark_ID);
            if (!family.has(configKey)) family.set(configKey, new Map());
            const scores = family.get(configKey);
            if (!scores.has(score)) scores.set(score, []);
            scores.get(score).push(sample);
        }
        sample.resultIDs.push(Number(row.ID));
        if (row.sourceURL && !sample.sources.includes(row.sourceURL)) sample.sources.push(row.sourceURL);
    }
    const output = [];
    let completed = 0;
    for (const [benchmarkID, configs] of families) {
        const pairs = new Map();
        function pairFor(first, second) {
            if (!includeConditionPair(first.conditionID, second.conditionID)) return null;
            const IDs = [first.conditionID, second.conditionID].sort((a, b) => a - b);
            const key = IDs.join(':');
            if (!pairs.has(key)) pairs.set(key, { benchmarkID, conditionIDs: IDs, exact: [], rounding: [] });
            return pairs.get(key);
        }
        for (const scores of configs.values()) {
            for (const entries of scores.values()) {
                for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
                    pairFor(entries[i], entries[j])?.exact.push([entries[i].index, entries[j].index]);
                }
            }
            for (const [score, preciseSamples] of scores) {
                for (const variant of roundedScoreVariants(score)) {
                    const roundedSamples = scores.get(variant.score);
                    if (!roundedSamples) continue;
                    for (const precise of preciseSamples) for (const rounded of roundedSamples) {
                        if (precise.conditionID === rounded.conditionID) continue;
                        pairFor(precise, rounded)?.rounding.push({ precise: precise.index,
                            rounded: rounded.index, precision: variant.precision, methods: variant.methods,
                            lowInformation: variant.precision === 0 && decimal(precise.score).value > -SCALE
                                && decimal(precise.score).value < SCALE });
                    }
                }
            }
        }
        for (const pair of pairs.values()) {
            const [left, right] = pair.conditionIDs.map(ID => conditions.get(ID));
            const count = Math.min(left.samples.size, right.samples.size);
            const modelIDs = new Set(pair.exact.map(([index]) => samples[index].modelID));
            let conflictingConfigs = 0, differingConfigs = 0;
            for (const [key, values] of left.configurations) {
                const other = right.configurations.get(key);
                if (!other) continue;
                if (![...values].some(value => other.has(value))) conflictingConfigs++;
                if (values.size !== other.size || [...values].some(value => !other.has(value))) differingConfigs++;
            }
            const sameScale = left.scale === right.scale;
            const exactThresholdMet = pair.exact.length >= 2 && pair.exact.length * 4 >= count * 3;
            const confirmedMerge = confirmedGroups.has(left.ID) && confirmedGroups.get(left.ID) === confirmedGroups.get(right.ID);
            const target = [left, right].sort((a, b) => b.samples.size - a.samples.size
                || Number(b.is_default) - Number(a.is_default) || a.ID - b.ID)[0];
            output.push({ ...pair, benchmarkName: left.benchmark_name,
                counts: [left.samples.size, right.samples.size], exactMatchCount: pair.exact.length,
                exactModelCount: modelIDs.size, exactCoverage: pair.exact.length / count,
                sameScale, conflictingConfigs, differingConfigs, exactThresholdMet,
                numericChecksPassed: exactThresholdMet && sameScale && modelIDs.size >= 2 && conflictingConfigs === 0,
                confirmedMerge, roundingNeedsReview: pair.rounding.length > 0 && !confirmedMerge,
                roundingModelCount: new Set(pair.rounding.map(item => samples[item.precise].modelID)).size,
                nonTrivialRoundingCount: pair.rounding.filter(item => !item.lowInformation).length,
                targetID: target.ID, sourceID: target === left ? right.ID : left.ID,
                category: exactThresholdMet ? 'exact-threshold' : pair.exact.length >= 2
                    ? 'partial-exact' : pair.exact.length === 1 ? 'single-exact' : 'rounding-only' });
        }
        onProgress({ completed: ++completed, total: families.size, pairs: output.length });
    }
    output.sort((a, b) => a.benchmarkName.localeCompare(b.benchmarkName) || a.conditionIDs[0] - b.conditionIDs[0]
        || a.conditionIDs[1] - b.conditionIDs[1]);
    return {
        version: 1, snapshotTime: snapshot.snapshotTime, generatedAt: new Date().toISOString(), confirmedMergeGroups,
        summary: { benchmarks: families.size, conditions: conditions.size, rawResults: snapshot.results.length,
            distinctSamples: samples.length, sourceDuplicates: snapshot.results.length - samples.length,
            candidatePairs: output.length, exactThreshold: output.filter(pair => pair.exactThresholdMet).length,
            numericChecksPassed: output.filter(pair => pair.numericChecksPassed).length,
            partialExact: output.filter(pair => pair.category === 'partial-exact').length,
            singleExact: output.filter(pair => pair.category === 'single-exact').length,
            roundingReview: output.filter(pair => pair.roundingNeedsReview).length,
            roundingSuppressedByConfirmedMerge: output.filter(pair => pair.confirmedMerge && pair.rounding.length).length,
            roundingOnlyLowInformation: output.filter(pair => pair.roundingNeedsReview && !pair.nonTrivialRoundingCount).length },
        conditions: snapshot.conditions, fields: snapshot.fields, options: snapshot.options, samples, pairs: output
    };
}
