function scoreParts(score) {
    const text = String(score);
    const match = text.match(/^-?\d+(?:\.(\d{1,6}))?$/);
    if (!match) throw new Error(`Invalid recorded score: ${text}`);
    const places = (match[1] ?? '').replace(/0+$/, '').length;
    const value = Number(text);
    if (!Number.isFinite(value)) throw new Error(`Invalid recorded score: ${text}`);
    return { value, places };
}

export function classifyScorePair(leftScore, rightScore) {
    const left = scoreParts(leftScore);
    const right = scoreParts(rightScore);
    const leftAbsolute = Math.abs(left.value);
    const rightAbsolute = Math.abs(right.value);

    if (left.places === 0 && right.places === 0
        && left.value <= 100 && right.value <= 100) return 'ignore';
    if (left.places >= 1 && right.places >= 1
        && leftAbsolute >= 3 && rightAbsolute >= 3) return 'merge';
    if (left.places >= 2 && right.places >= 2
        && leftAbsolute > 0 && leftAbsolute < 3
        && rightAbsolute > 0 && rightAbsolute < 3) return 'merge';
    return 'report';
}

export function classifyConditionPair(pair, samples) {
    const counts = { ignore: 0, merge: 0, report: 0 };
    let mergeEvidence = null;
    let reportEvidence = null;
    const record = (first, second, kind) => {
        const left = samples[first];
        const right = samples[second];
        if (!left || !right) throw new Error(`Missing score evidence ${first}/${second}`);
        const verdict = classifyScorePair(left.score, right.score);
        counts[verdict]++;
        const evidence = { kind, modelID: left.modelID,
            scores: [left.score, right.score], sampleIDs: [first, second] };
        if (verdict === 'merge' && !mergeEvidence) mergeEvidence = evidence;
        if (verdict === 'report' && !reportEvidence) reportEvidence = evidence;
    };
    for (const [first, second] of pair.exact) record(first, second, 'exact');
    for (const row of pair.rounding) record(row.precise, row.rounded, 'rounding');
    if (!counts.ignore && !counts.merge && !counts.report) {
        throw new Error(`Candidate ${pair.conditionIDs.join('/')} has no score evidence`);
    }
    return { verdict: counts.merge ? 'merge' : counts.report ? 'report' : 'ignore',
        counts, mergeEvidence, reportEvidence };
}

export function filterConditionPairs(report) {
    if (!Array.isArray(report.pairs) || !Array.isArray(report.samples)
        || !Array.isArray(report.conditions)) throw new Error('Invalid overlap report');
    const summary = { total: 0, ignore: 0, merge: 0, report: 0,
        mergeWithExplicitSemanticDifference: 0, mergeWithDifferentScale: 0 };
    const rows = report.pairs.map(pair => {
        const result = classifyConditionPair(pair, report.samples);
        summary.total++;
        summary[result.verdict]++;
        if (result.verdict === 'merge') {
            if (pair.semanticDifferences?.length) summary.mergeWithExplicitSemanticDifference++;
            if (!pair.sameScale) summary.mergeWithDifferentScale++;
        }
        return { conditionIDs: pair.conditionIDs, benchmarkName: pair.benchmarkName,
            verdict: result.verdict, counts: result.counts,
            mergeEvidence: result.mergeEvidence, reportEvidence: result.reportEvidence,
            sameScale: pair.sameScale, semanticDifferences: pair.semanticDifferences ?? [] };
    });
    return { summary, rows };
}
