import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createPairwiseReference } from '../pairwise-score.js';
import { createPercentileReference, percentileScore } from '../public/js/shared/available-score.js';

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
if (!arg('source') || !arg('output')) throw new Error('--source and a new --output required.');
const snapshot = JSON.parse(await readFile(arg('source'), 'utf8'));
const models = snapshot.models.map(m => ({ ...m, results: new Map(m.results.map(([key, normalizedScore]) => [key, { normalizedScore }])) }));
const benchmarkByVersion = new Map(snapshot.versions.map(v => [String(v.ID), v.benchmarkID]));
const counts = new Map();
for (const m of models) for (const key of m.results.keys()) counts.set(key, (counts.get(key) ?? 0) + 1);
const hash = value => createHash('sha256').update(value).digest().readUInt32BE();
const cases = [], folds = [];
for (let fold = 0; fold < 5; fold++) {
    const masked = [], targets = [];
    for (const m of models) {
        const benchmarks = [...new Set([...m.results.keys()].map(key => benchmarkByVersion.get(key)))].sort((a, b) => a - b);
        const eligible = benchmarks.filter(ID => [...m.results.keys()].some(key => benchmarkByVersion.get(key) === ID && counts.get(key) >= 10));
        const seed = arg('seed') ? `${arg('seed')}:` : '';
        const chosen = benchmarks.length >= 2 && eligible.length ? eligible[hash(`${seed}${fold}:${m.comparisonIdentity}`) % eligible.length] : null;
        const keys = [...m.results.keys()].filter(key => benchmarkByVersion.get(key) === chosen)
            .sort((a, b) => counts.get(b) - counts.get(a) || Number(a) - Number(b));
        if (keys.length) targets.push({ identity: m.comparisonIdentity, version: keys[0], actual: m.results.get(keys[0]).normalizedScore });
        masked.push({ ...m, results: new Map([...m.results].filter(([key]) => benchmarkByVersion.get(key) !== chosen)) });
    }
    const start = performance.now(), pairwise = createPairwiseReference(masked);
    const fitMs = performance.now() - start, ordinal = createPairwiseReference(masked, { transform: 'percentile' });
    const margin = createPairwiseReference(masked, { transform: 'margin' });
    const old = createPercentileReference(masked), byIdentity = new Map(masked.map(m => [m.comparisonIdentity, m]));
    for (const target of targets) {
        const m = byIdentity.get(target.identity), distribution = old.distributions.get(target.version), estimate = old.estimate(m);
        const prediction = pairwise.predict(m, target.version), rankPrediction = ordinal.predict(m, target.version);
        cases.push({ fold, ...target, remainingVersions: m.results.size,
            old: estimate.percentile !== null && distribution?.count ? percentileScore(distribution, estimate.percentile) : null,
            pairwise: prediction?.normalizedScore ?? null, ordinal: rankPrediction?.normalizedScore ?? null,
            margin: margin.predict(m, target.version)?.normalizedScore ?? null });
    }
    folds.push({ fold, targets: targets.length, fitMs, diagnostics: pairwise.diagnostics });
}
const metrics = rows => {
    const comparable = rows.filter(row => row.old !== null && row.pairwise !== null && row.ordinal !== null && row.margin !== null);
    const summarize = field => ({ mae: comparable.reduce((sum, row) => sum + Math.abs(row[field] - row.actual) / comparable.length, 0),
        rmse: Math.sqrt(comparable.reduce((sum, row) => sum + (row[field] - row.actual) ** 2 / comparable.length, 0)) });
    return { cases: rows.length, commonCases: comparable.length, old: summarize('old'), pairwise: summarize('pairwise'), ordinal: summarize('ordinal'), margin: summarize('margin'),
        unresolved: Object.fromEntries(['old', 'pairwise', 'ordinal', 'margin'].map(field => [field, rows.filter(row => row[field] === null).length])) };
};
const report = { schemaVersion: 1, createdAt: new Date().toISOString(), businessWrites: 0,
    seed: arg('seed') ?? 'development',
    method: 'Five deterministic whole-benchmark holdouts per eligible model. All versions of the held-out benchmark are removed for that model; peers retain their observations.',
    sourceHash: createHash('sha256').update(await readFile(arg('source'))).digest('hex'),
    population: { models: models.length, versions: snapshot.versions.length, cells: models.reduce((sum, m) => sum + m.results.size, 0) },
    folds, all: metrics(cases), bounded: metrics(cases.filter(row => row.actual >= 0 && row.actual <= 100)),
    sparse: metrics(cases.filter(row => row.remainingVersions <= 5)), dense: metrics(cases.filter(row => row.remainingVersions > 5)), cases };
await writeFile(arg('output'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ ...report, cases: undefined }, null, 2));
