import { createHash } from 'node:crypto';

export const HARNESS_SPLIT_RELEASE = 'arc_harness_conditions_20261103';
export const canonicalJSON = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object'
    && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const harnessHash = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const visibleNameKey = value => String(value).normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');

export function publicScoreIdentity(score) {
    if (!positive(score.ID) || !positive(score.modelID) || !Number.isFinite(Number(score.rawScore))
        || typeof score.sourceURL !== 'string' || !Array.isArray(score.fields)
        || score.fields.some(field => typeof field.name !== 'string' || typeof field.value !== 'string')) throw new Error('Invalid reviewed score identity');
    return { ID: Number(score.ID), modelID: Number(score.modelID), rawScore: Number(score.rawScore),
        sourceURL: score.sourceURL, sourceTitle: score.sourceTitle ?? null,
        fields: score.fields.map(field => ({ name: field.name, value: field.value }))
            .sort((a, b) => canonicalJSON(a).localeCompare(canonicalJSON(b), 'en')) };
}

export function validateHarnessReview(review) {
    if (review?.version !== 1 || review.release !== HARNESS_SPLIT_RELEASE || !Array.isArray(review.targets)
        || !review.targets.length || !Array.isArray(review.evidence) || !review.evidence.length) throw new Error('Invalid harness review');
    const benchmarks = new Set(), conditions = new Set(), scores = new Set();
    for (const target of review.targets) {
        if (!positive(target.benchmarkID) || !positive(target.conditionID) || benchmarks.has(target.benchmarkID)
            || conditions.has(target.conditionID) || !/^ARC-AGI-[123]$/.test(target.benchmarkName)
            || !target.beforeName || !target.buckets?.standard || !Array.isArray(target.scores) || !target.scores.length) {
            throw new Error('Invalid or duplicate harness target');
        }
        benchmarks.add(target.benchmarkID); conditions.add(target.conditionID);
        const names = new Set();
        for (const [key, bucket] of Object.entries(target.buckets)) {
            if (!/^[a-z-]+$/.test(key) || typeof bucket.name !== 'string' || !visibleNameKey(bucket.name) || bucket.name.length > 192 || !bucket.explanation
                || key !== 'standard' && !/^harness-split-20261103:[a-z-]+$/.test(bucket.conditionKey)) throw new Error('Invalid harness bucket');
            const name = visibleNameKey(bucket.name);
            if (names.has(name)) throw new Error('Duplicate harness bucket name');
            names.add(name);
        }
        for (const score of target.scores) {
            publicScoreIdentity(score);
            if (scores.has(score.ID) || !Object.hasOwn(target.buckets, score.bucket) || !score.reason) throw new Error('Invalid or duplicate reviewed score');
            scores.add(score.ID);
        }
        if (!target.scores.some(score => score.bucket === 'standard')) throw new Error('An empty standard condition cannot become the default');
    }
    return review;
}

// A reviewed inventory, not a classifier for arbitrary future submissions. Missing
// harness metadata and an official-looking URL never automatically grant eligibility.
export function buildHarnessSplitPlan(state, review) {
    validateHarnessReview(review);
    const blockers = [], targets = [], seenResults = new Set();
    const block = (code, detail) => blockers.push({ code, ...detail });
    for (const target of review.targets) {
        const benchmark = state.benchmarks.find(row => Number(row.ID) === target.benchmarkID);
        const conditions = state.conditions.filter(row => Number(row.benchmark_ID) === target.benchmarkID);
        const original = conditions.find(row => Number(row.ID) === target.conditionID);
        if (!benchmark || benchmark.name !== target.benchmarkName || Number(benchmark.is_active) !== 1
            || !original || original.deleted_at !== null || Number(original.is_primary) !== 1
            || ![target.beforeName, target.buckets.standard.name].includes(original.name)
            || conditions.filter(row => !row.deleted_at && Number(row.is_primary) === 1).length !== 1) {
            block('benchmark_condition_changed', { benchmarkID: target.benchmarkID }); continue;
        }
        const validScale = row => row.score_direction === 'higher' && Number(row.uses_percentage_scale) === 1
            && row.target_value === null && row.score_min === null && row.score_max === null;
        if (!validScale(original) || original.score_source != null || Number(original.is_default) !== 0) {
            block('score_condition_contract_changed', { conditionID: target.conditionID }); continue;
        }
        const buckets = Object.entries(target.buckets).map(([key, definition]) => {
            const row = key === 'standard' ? original : conditions.find(row => row.condition_key === definition.conditionKey);
            for (const conflict of conditions.filter(candidate => candidate !== row && candidate.deleted_at === null
                && visibleNameKey(candidate.name) === visibleNameKey(definition.name))) {
                block('destination_condition_name_conflict', { benchmarkID: target.benchmarkID, bucket: key, conditionID: Number(conflict.ID) });
            }
            if (row && (!validScale(row) || row.deleted_at !== null || row.score_source != null || key !== 'standard'
                && (Number(row.is_primary) !== 0 || Number(row.is_default) !== 0 || row.name !== definition.name))) {
                block('destination_condition_changed', { conditionID: Number(row.ID) });
            }
            return { key, ...definition, ID: row ? Number(row.ID) : null,
                create: !row, update: !!row && (row.name !== definition.name || row.difference_explanation !== definition.explanation) };
        });
        const scope = new Set(buckets.filter(row => row.ID).map(row => row.ID));
        const expected = new Map(target.scores.map(row => [Number(row.ID), row]));
        const results = state.results.filter(row => Number(row.benchmark_ID) === target.benchmarkID && row.status === 'accepted');
        for (const row of results) {
            if (scope.has(Number(row.benchmark_condition_ID)) && !expected.has(Number(row.ID))) block('unreviewed_score', { resultID: Number(row.ID) });
        }
        const moves = [], snapshots = [];
        for (const [ID, reviewed] of expected) {
            const row = results.find(result => Number(result.ID) === ID);
            const bucket = buckets.find(item => item.key === reviewed.bucket);
            if (!row || seenResults.has(ID) || ![target.conditionID, bucket.ID].includes(Number(row.benchmark_condition_ID))) {
                block('reviewed_score_missing_or_moved', { resultID: ID }); continue;
            }
            seenResults.add(ID);
            if (harnessHash(publicScoreIdentity(row.publicIdentity)) !== harnessHash(publicScoreIdentity(reviewed))) {
                block('reviewed_score_changed', { resultID: ID }); continue;
            }
            if (Number(row.benchmark_condition_ID) !== bucket.ID) moves.push({ ID, from: Number(row.benchmark_condition_ID), bucket: bucket.key });
            const before = parse(row.benchmark_condition_snapshot);
            if (!before || typeof before !== 'object' || Array.isArray(before)) { block('invalid_score_snapshot', { resultID: ID }); continue; }
            if (before.conditionID !== bucket.ID || before.name !== bucket.name || before.benchmarkID !== target.benchmarkID) {
                snapshots.push({ ID, bucket: bucket.key });
            }
        }
        targets.push({ benchmarkID: target.benchmarkID, conditionID: target.conditionID, buckets, moves, snapshots,
            counts: Object.fromEntries(buckets.map(bucket => [bucket.key, target.scores.filter(row => row.bucket === bucket.key).length])) });
    }
    for (const ID of state.pendingTargetRequests ?? []) block('pending_target_moderation', { requestID: ID });
    const mutations = targets.reduce((n, target) => n + target.buckets.filter(row => row.create || row.update).length
        + new Set([...target.moves, ...target.snapshots].map(row => row.ID)).size, 0);
    const plan = { release: HARNESS_SPLIT_RELEASE, reviewHash: harnessHash(review), stateHash: harnessHash(state),
        canApply: blockers.length === 0, mutations, blockers, targets };
    return { ...plan, planHash: harnessHash(plan) };
}

export function referencesHarnessTarget(value, benchmarkIDs, conditionIDs) {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(item => referencesHarnessTarget(item, benchmarkIDs, conditionIDs));
    if ((value.targetKind === 'benchmark' && benchmarkIDs.has(Number(value.targetID)))
        || Object.entries(value).some(([key, item]) => /^(?:benchmarkID|existingBenchmarkID|targetBenchmarkID)$/.test(key)
            && benchmarkIDs.has(Number(item)) || /^(?:conditionID|benchmarkConditionID|existingBenchmarkConditionID)$/.test(key)
            && conditionIDs.has(Number(item)))) return true;
    return Object.values(value).some(item => referencesHarnessTarget(item, benchmarkIDs, conditionIDs));
}
