import { auditConditionScoreOverlap } from './condition-score-overlap.js';
import { classifyConditionPair } from './condition-precision-filter.js';
import { semanticDifferences } from './condition-overlap-merge-plan.js';

export function normalizeBenchmarkName(name) {
    return String(name).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export function benchmarkNameSimilarity(left, right) {
    const a = Array.from(normalizeBenchmarkName(left));
    const b = Array.from(normalizeBenchmarkName(right));
    if (!a.length || !b.length) return { similarity: 0, band: null };
    let previous = Uint32Array.from({ length: b.length + 1 }, (_, i) => i);
    let current = new Uint32Array(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
        current[0] = i;
        for (let j = 1; j <= b.length; j++) {
            current[j] = Math.min(previous[j] + 1, current[j - 1] + 1,
                previous[j - 1] + Number(a[i - 1] !== b[j - 1]));
        }
        [previous, current] = [current, previous];
    }
    const length = Math.max(a.length, b.length);
    const matching = length - previous[b.length];
    // Integer comparisons keep exactly 60% and 70% on their intended boundaries.
    const band = matching * 100 > length * 70 ? 'high'
        : matching * 100 >= length * 30 && matching * 100 <= length * 60 ? 'medium' : null;
    return { similarity: matching / length, band };
}

export function auditCrossBenchmarkScores(snapshot, { onProgress = () => {} } = {}) {
    const benchmarks = new Map();
    const conditions = new Map();
    for (const condition of snapshot.conditions) {
        const id = Number(condition.benchmark_ID);
        if (conditions.has(Number(condition.ID))) throw new Error(`Repeated condition ${condition.ID}`);
        conditions.set(Number(condition.ID), condition);
        if (!benchmarks.has(id)) benchmarks.set(id, {
            ID: id, name: condition.benchmark_name, conditions: [], results: [], modelIDs: new Set()
        });
        const benchmark = benchmarks.get(id);
        if (benchmark.name !== condition.benchmark_name) throw new Error(`Inconsistent benchmark ${id}`);
        benchmark.conditions.push(condition);
    }
    for (const result of snapshot.results) {
        const condition = conditions.get(Number(result.conditionID));
        if (!condition) throw new Error(`Unknown condition ${result.conditionID}`);
        const benchmark = benchmarks.get(Number(condition.benchmark_ID));
        benchmark.results.push(result);
        benchmark.modelIDs.add(Number(result.modelID));
    }
    const summary = { benchmarks: benchmarks.size, conditions: conditions.size,
        rawResults: snapshot.results.length, namePairs: 0, highNamePairs: 0, mediumNamePairs: 0,
        withCommonModels: 0, scoreMatchedBenchmarkPairs: 0, scoreMatchedConditionPairs: 0,
        ignoredConditionPairs: 0, precisionReportPairs: 0, numericalPassPairs: 0,
        highPassWithoutDetectedConflict: 0, mediumPassWithoutDetectedConflict: 0,
        numericalPassWithDetectedConflict: 0 };
    const samples = [], sampleIndex = new Map(), pairs = [], namePairs = [];
    const items = [...benchmarks.values()].sort((a, b) => a.ID - b.ID);
    let visited = 0;
    const total = items.length * (items.length - 1) / 2;
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        const left = items[i], right = items[j];
        const match = benchmarkNameSimilarity(left.name, right.name);
        visited++;
        if (visited % 1000 === 0) onProgress({ visited, total, ...summary });
        if (!match.band) continue;
        summary.namePairs++;
        summary[match.band === 'high' ? 'highNamePairs' : 'mediumNamePairs']++;
        const namePair = { benchmarkIDs: [left.ID, right.ID], names: [left.name, right.name],
            ...match, commonModels: [...left.modelIDs].filter(id => right.modelIDs.has(id)).length,
            matchedConditionPairs: 0, numericalPassPairs: 0, passWithoutDetectedConflict: 0 };
        namePairs.push(namePair);
        if (!namePair.commonModels) continue;
        summary.withCommonModels++;
        // Audit each name pair independently: similarity never forms transitive families.
        const audit = auditConditionScoreOverlap({ ...snapshot,
            conditions: [...left.conditions, ...right.conditions].map(c => ({ ...c, benchmark_ID: left.ID })),
            results: [...left.results, ...right.results]
        }, { includeConditionPair: (a, b) => conditions.get(a).benchmark_ID !== conditions.get(b).benchmark_ID });
        if (audit.pairs.length) summary.scoreMatchedBenchmarkPairs++;
        const localToGlobal = new Map();
        function intern(localID) {
            if (localToGlobal.has(localID)) return localToGlobal.get(localID);
            const sample = audit.samples[localID];
            const key = JSON.stringify([sample.conditionID, sample.modelID, sample.fields, sample.score]);
            if (!sampleIndex.has(key)) {
                const index = samples.length;
                sampleIndex.set(key, index);
                samples.push({ ...sample, index });
            }
            const index = sampleIndex.get(key);
            localToGlobal.set(localID, index);
            return index;
        }
        for (const pair of audit.pairs) {
            summary.scoreMatchedConditionPairs++;
            namePair.matchedConditionPairs++;
            const precision = classifyConditionPair(pair, audit.samples);
            if (precision.verdict === 'ignore') { summary.ignoredConditionPairs++; continue; }
            const differences = semanticDifferences(...pair.conditionIDs.map(id => conditions.get(id)));
            const noDetectedConflict = pair.sameScale && !differences.length;
            if (precision.verdict === 'merge') {
                summary.numericalPassPairs++;
                namePair.numericalPassPairs++;
                if (noDetectedConflict) {
                    summary[match.band === 'high' ? 'highPassWithoutDetectedConflict' : 'mediumPassWithoutDetectedConflict']++;
                    namePair.passWithoutDetectedConflict++;
                } else summary.numericalPassWithDetectedConflict++;
            } else summary.precisionReportPairs++;
            for (const witness of [precision.mergeEvidence, precision.reportEvidence]) {
                if (witness) witness.sampleIDs = witness.sampleIDs.map(intern);
            }
            const orderedBenchmarks = pair.conditionIDs.map(id => benchmarks.get(Number(conditions.get(id).benchmark_ID)));
            const nameNumbers = name => name.match(/\d+(?:\.\d+)*/g) ?? [];
            pairs.push({ ...pair, benchmarkID: undefined, benchmarkName: undefined,
                benchmarkIDs: orderedBenchmarks.map(b => b.ID), benchmarkNames: orderedBenchmarks.map(b => b.name),
                nameSimilarity: match.similarity, nameBand: match.band,
                nameNumbersDiffer: JSON.stringify(nameNumbers(left.name)) !== JSON.stringify(nameNumbers(right.name)),
                semanticDifferences: differences, precision, noDetectedConflict,
                exact: pair.exact.map(row => row.map(intern)),
                rounding: pair.rounding.map(row => ({ ...row, precise: intern(row.precise), rounded: intern(row.rounded) })) });
        }
    }
    pairs.sort((a, b) => Number(b.precision.verdict === 'merge') - Number(a.precision.verdict === 'merge')
        || Number(b.noDetectedConflict) - Number(a.noDetectedConflict)
        || b.nameSimilarity - a.nameSimilarity || b.exactModelCount - a.exactModelCount
        || a.conditionIDs[0] - b.conditionIDs[0] || a.conditionIDs[1] - b.conditionIDs[1]);
    onProgress({ visited, total, ...summary });
    return { version: 1, snapshotTime: snapshot.snapshotTime, generatedAt: new Date().toISOString(),
        summary, namePairs, conditions: snapshot.conditions, fields: snapshot.fields, options: snapshot.options,
        samples, pairs, execution: { applied: false } };
}
