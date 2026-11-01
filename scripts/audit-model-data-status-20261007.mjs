import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

// Offline evidence audit only: no runtime imports, network access or writes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const original = 'artifacts/post-astra-import-20261002/';
const reportPath = 'artifacts/completion-audit-20261007/model-data-status.json';
const bytes = name => readFileSync(path.join(root, name));
const json = name => JSON.parse(bytes(name).toString('utf8'));
const zipped = name => JSON.parse(gunzipSync(bytes(name)).toString('utf8'));
const sha256 = name => createHash('sha256').update(bytes(name)).digest('hex');
const flag = process.argv[2] ?? '--summary';
assert.equal(process.argv.length <= 3, true, 'Only one output flag is supported');
assert.ok(['--summary', '--details', '--mappings', '--small-plan', '--scope', '--verify'].includes(flag), 'Unknown flag');

const manifest = json(reportPath);
for (const input of manifest.inputEvidence) {
  assert.equal(sha256(input.path), input.sha256, `Pinned input changed: ${input.path}`);
}
const bundle = json(`${original}verified-bundle.json`);
const queue = json(`${original}pending-review.json`);
const receipt = json(`${original}apply.json`);
const baseline = zipped(`${original}production.json.gz`);
const before = zipped('artifacts/condition-audit-remaining-20261004/snapshot.json.gz');
const current = zipped('artifacts/condition-audit-followup-current-20261005/snapshot.json.gz');
const dictionary = json('artifacts/arc-official-20261006/production-state.json');
const resolutions = json('scripts/model-identity-resolutions-20261004.json');
const coverage = json(`${original}coverage.json`);
const models = new Map(dictionary.tables.models.map(row => [row.ID, row]));
const scores = new Map(current.scores.map(row => [row.ID, row]));
const baselineScores = new Map(baseline.scores.map(row => [row.ID, row]));
const conditions = new Map(current.conditions.map(row => [row.ID, row]));
const fields = new Map(current.catalog.score_fields.map(row => [row.ID, row]));
const options = new Map(current.catalog.score_field_options.map(row => [row.ID, row]));
const newConditions = new Map(receipt.newConditions.map(row => [row.ref, row.ID]));
const newBenchmarks = new Map(receipt.newBenchmarks.map(row => [row.ref, row.ID]));

assert.equal(bundle.pending.length, manifest.expected.pending);
assert.equal(queue.length, bundle.pending.length);
queue.forEach((row, index) => assert.equal(row.index, index));
assert.equal(current.generatedAt, manifest.snapshotBoundary.scores);
assert.equal(current.scores.length, manifest.expected.fullSnapshotScores);
assert.equal(receipt.dryRun, false);
assert.equal(receipt.inserted, manifest.expected.originalInserted);
assert.equal(receipt.bundleHash, manifest.inputEvidence[0].sha256);
const verifiedSources = Object.entries(bundle.sourceFiles);
for (const [file, evidence] of verifiedSources) {
  assert.equal(sha256(`${original}sources/${file}`), evidence.sha256, `Source changed: ${file}`);
}

function notesOf(row) {
  return typeof row.notes === 'string' ? JSON.parse(row.notes) : row.notes ?? {};
}
function sourceURL(record) {
  return record.url ?? record.source?.url ?? record.URL ?? null;
}
function nativeID(record) {
  return record.nativeID ?? record.id ?? null;
}
function sameValue(left, right) {
  return left !== null && right !== null && left !== '' && right !== ''
    && Number.isFinite(Number(left)) && Number(left).toFixed(6) === Number(right).toFixed(6);
}
function counts(rows, key) {
  return rows.reduce((result, row) => {
    const value = row[key];
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}
function ranges(indexes) {
  const result = [];
  for (const index of indexes) {
    const last = result.at(-1);
    if (last && last[1] === index - 1) last[1] = index;
    else result.push([index, index]);
  }
  return result;
}

// A condition move is inferred only from preserved result IDs, never its name.
const conditionSuccessors = new Map();
const nativeProvenance = new Map();
for (const row of before.scores) {
  const successor = scores.get(row.ID);
  if (!successor) continue;
  const set = conditionSuccessors.get(row.benchmark_condition_ID) ?? new Set();
  set.add(successor.benchmark_condition_ID);
  conditionSuccessors.set(row.benchmark_condition_ID, set);
}
for (const row of current.scores) {
  const notes = notesOf(row);
  const identities = [notes.crawl_score_id, notes.post_astra_import?.nativeID,
    notes.post_astra_import?.crawlID, notes.sourceDetails?.originalCell?.id];
  for (const identity of new Set(identities.filter(Boolean))) {
    const matches = nativeProvenance.get(identity) ?? [];
    matches.push(row.ID);
    nativeProvenance.set(identity, matches);
  }
}
function conditionMapping(ref) {
  const definition = bundle.conditions[ref];
  if (!definition) return { originalID: null, currentID: null, needsReview: true };
  const originalID = definition.existingID ?? newConditions.get(ref) ?? null;
  const successors = [...(conditionSuccessors.get(originalID) ?? [])];
  const currentID = successors.length === 1 ? successors[0]
    : successors.length === 0 && conditions.has(originalID) ? originalID : null;
  const currentCondition = conditions.get(currentID);
  const benchmark = bundle.benchmarks[definition.benchmarkRef];
  return {
    originalID, currentID,
    benchmarkID: benchmark?.existingID ?? newBenchmarks.get(definition.benchmarkRef) ?? null,
    needsReview: !currentCondition || Boolean(currentCondition.deleted_at),
    definition
  };
}

const reasonStatus = {
  model_identity_unresolved: 'identity_or_variant_unresolved',
  publisher_imputed_score_not_an_observation: 'imputed_not_observation',
  publisher_derived_estimate: 'derived_or_approximate_not_observation',
  publisher_approximate_value: 'derived_or_approximate_not_observation'
};
const rows = bundle.pending.map((pending, index) => ({
  index, originalReason: pending.reason,
  status: reasonStatus[pending.reason] ?? 'metric_or_scale_unresolved',
  nativeID: nativeID(pending.record),
  originalLabel: pending.record.notes?.originalCell?.model_condition_text
    ?? pending.record.modelLabel ?? pending.record.model_object_id ?? pending.record.label ?? null,
  raw: pending.record.value ?? pending.record.rawScore ?? pending.record.row?.value ?? null,
  sourceURL: sourceURL(pending.record),
  locatedNativeResultIDs: nativeProvenance.get(nativeID(pending.record)) ?? []
}));
const assigned = new Set();
const configText = bytes(`${original}sources/posttrain-config.txt`).toString('utf8');
const posttrainCounts = {};
const posttrainData = new Map();
for (const [version, file, symbol] of [
  ['v1', 'posttrain-v1.txt', 'SCORES_DATA_V1'],
  ['v1.1', 'posttrain-v11.txt', 'SCORES_DATA'],
  ['v1.2', 'posttrain-v12.txt', 'SCORES_DATA_V12']
]) {
  const text = bytes(`${original}sources/${file}`).toString('utf8');
  const match = text.match(new RegExp(`window\\.${symbol}\\s*=\\s*([\\s\\S]*);\\s*$`));
  assert.ok(match, `Missing JSON assignment in ${file}`);
  posttrainData.set(version, JSON.parse(match[1]));
}

function setMapping(index, mapping) {
  assert.ok(!assigned.has(index), `Overlapping reviewed mapping at ${index}`);
  assert.equal(rows[index].originalReason, 'model_identity_unresolved');
  const model = models.get(mapping.modelID);
  assert.ok(model, `Unknown model ID ${mapping.modelID}`);
  assert.equal(model.vendor_ID, mapping.vendorID);
  assert.equal(model.is_active, 1);
  for (const [fieldID, value] of mapping.runFields ?? []) {
    const field = fields.get(fieldID);
    assert.ok(field, `Unknown field ${fieldID}`);
    if (field.field_type === 'enum') assert.equal(options.get(value)?.field_ID, fieldID);
  }
  const ref = bundle.pending[index].record.conditionRef;
  const condition = conditionMapping(ref);
  const evidenceFile = mapping.sourceFile === 'lingvl-chart'
    ? 'artifacts/openrouter-crawl-20260909/evidence/entry304-lingvl-chart-2.png'
    : `${original}sources/${mapping.sourceFile}`;
  const tupleCandidates = current.scores.filter(score => score.model_ID === mapping.modelID
    && score.benchmark_condition_ID === condition.currentID
    && score.source_url === rows[index].sourceURL && sameValue(score.raw_score, rows[index].raw));
  assigned.add(index);
  Object.assign(rows[index], {
    status: 'identity_mapped_not_imported', modelID: model.ID, modelName: model.name,
    vendorID: model.vendor_ID, conditionRef: ref,
    benchmarkID: condition.benchmarkID, originalConditionID: condition.originalID,
    currentConditionID: condition.currentID, conditionNeedsReview: condition.needsReview,
    correctedLabel: mapping.correctedLabel ?? null,
    runFields: (mapping.runFields ?? []).map(([fieldID, value]) => ({ fieldID, value })),
    evidence: { file: evidenceFile, sha256: sha256(evidenceFile) },
    identityEvidenceURL: mapping.identityEvidenceURL ?? rows[index].sourceURL,
    basis: mapping.basis ?? 'Exact source label and existing canonical model identity',
    sameTupleCandidatesRequiringProvenanceReview: tupleCandidates.map(score => score.ID),
    recommendedDisposition: rows[index].nativeID?.startsWith('posttrain:') ? 'archived' : 'stage_only',
    appliedByThisAudit: false
  });
}
for (const mapping of manifest.mappedGroups) {
  for (const index of mapping.indexes) setMapping(index, mapping);
}
for (const row of rows) {
  if (row.originalReason !== 'model_identity_unresolved' || !row.nativeID?.startsWith('posttrain:')) continue;
  const [, version, agent] = row.nativeID.split(':');
  const parts = row.nativeID.split(':');
  const data = posttrainData.get(version);
  const cell = parts[3] === 'overall' ? data.aggregatedScores[agent]
    : data.modelBenchmarkData[agent]?.[parts[3]]?.[parts[4]];
  assert.ok(cell, `Missing PostTrain native cell: ${row.nativeID}`);
  assert.ok(sameValue(row.raw, parts[3] === 'overall' ? cell.avg : cell.value));
  if (parts[3] !== 'overall') assert.equal(cell.fallbackType, false);
  if (['human', 'base-model-fewshot'].includes(agent)) {
    row.status = 'reference_not_training_agent';
    row.trainingAgentModelID = null;
    row.trainedCheckpoint = bundle.pending[row.index].record.notes?.trainedModel;
    continue;
  }
  const mapping = manifest.posttrainMappings.find(item => item.agent === agent);
  if (!mapping) continue;
  assert.ok(configText.includes(`"${agent}": {`), `Agent absent from pinned config: ${agent}`);
  posttrainCounts[agent] = (posttrainCounts[agent] ?? 0) + 1;
  const runFields = [[1, mapping.harness]];
  if (mapping.effort) runFields.push([20, mapping.effort]);
  if (mapping.context) runFields.push([6, mapping.context]);
  if (mapping.prompting) runFields.push([16, mapping.prompting]);
  const versionFile = { v1: 'posttrain-v1.txt', 'v1.1': 'posttrain-v11.txt', 'v1.2': 'posttrain-v12.txt' }[version];
  setMapping(row.index, { ...mapping, runFields, sourceFile: versionFile,
    identityEvidenceURL: manifest.posttrainIdentitySource,
    basis: `Pinned publisher agentInfo: ${agent}; benchmark measures training-agent achievement, not direct downstream capability` });
}
for (const mapping of manifest.posttrainMappings) assert.equal(posttrainCounts[mapping.agent], mapping.count);
for (const [index, resultID] of manifest.existingAcceptedBindings) {
  assert.ok(!assigned.has(index));
  const record = bundle.pending[index].record;
  const score = scores.get(resultID);
  assert.ok(baselineScores.has(resultID), `Not present before original import: ${resultID}`);
  assert.equal(score.status, 'accepted');
  assert.equal(notesOf(score).official_model_name, record.nativeID.replace(/^scale:[^:]+:/, ''));
  assert.equal(score.source_url, record.url);
  assert.ok(sameValue(score.raw_score, record.value));
  assert.equal(score.benchmark_condition_ID, conditionMapping(record.conditionRef).currentID);
  assigned.add(index);
  Object.assign(rows[index], { status: 'already_represented_accepted', resultID,
    modelID: score.model_ID, currentConditionID: score.benchmark_condition_ID,
    runFields: score.score_fields, existedBeforeOctober2: true });
}

const statusCounts = counts(rows, 'status');
assert.deepEqual(statusCounts, manifest.expected.statusCounts);
for (const row of rows.filter(row => row.status === 'imputed_not_observation')) {
  const record = bundle.pending[row.index].record;
  assert.ok(['not_stored', 'error', 'substituted'].includes(record.row.fallbackType));
  assert.equal(Number.isFinite(record.row.value), true);
}
assert.deepEqual(counts(bundle.pending.filter(row => row.reason === 'publisher_imputed_score_not_an_observation')
  .map(row => row.record.row), 'fallbackType'), manifest.expected.posttrainFallbackTypes);
// Equal numeric tuples from another effort/harness are not evidence duplicates.
for (const row of rows.filter(row => row.sameTupleCandidatesRequiringProvenanceReview?.length)) {
  for (const resultID of row.sameTupleCandidatesRequiringProvenanceReview) {
    assert.notEqual(notesOf(scores.get(resultID)).post_astra_import?.nativeID, row.nativeID);
  }
}
const nativeMatches = rows.filter(row => row.locatedNativeResultIDs.length);
assert.equal(nativeMatches.length, manifest.expected.nativeProvenanceMatches);
assert.deepEqual(nativeMatches.map(row => row.index), [25, 26, 27, 28]);
for (const row of nativeMatches) {
  assert.equal(row.status, 'metric_or_scale_unresolved');
  for (const ID of row.locatedNativeResultIDs) assert.equal(scores.get(ID).status, 'archived');
}
const inserted = receipt.dispositions.filter(row => row.action === 'insert').flatMap(row => row.resultIDs);
assert.equal(inserted.length, manifest.expected.originalInserted);
inserted.forEach(ID => assert.ok(scores.has(ID), `Original inserted score disappeared: ${ID}`));
assert.deepEqual(counts(inserted.map(ID => scores.get(ID)), 'status'), {
  accepted: manifest.expected.originalInsertedAccepted, archived: manifest.expected.originalInsertedArchived
});

const resolutionStates = resolutions.map(resolution => ({
  ...resolution, sourceInactive: models.get(resolution.fromID)?.is_active === 0,
  targetActive: models.get(resolution.toID)?.is_active === 1,
  scoresStillOnSource: current.scores.filter(row => row.model_ID === resolution.fromID).length
}));
assert.equal(resolutionStates.length, 22);
assert.ok(resolutionStates.every(row => row.sourceInactive && row.targetActive && row.scoresStillOnSource === 0));
const suffixReports = ['model-run-suffixes-20261004', 'model-run-suffixes-20261004-modes'].map(directory => {
  const report = json(`artifacts/${directory}/production-results.json`);
  assert.equal(report.passed, true);
  if (report.after) assert.deepEqual(report.before, report.after);
  return { directory, models: report.migration.models, movedScores: report.migration.scores,
    verifiedReceipt: report.passed, createsPendingScores: false };
});

const smallPlan = manifest.smallApplyPlan;
assert.equal(smallPlan.records.length, 2);
assert.equal(sha256(smallPlan.sourceFile), smallPlan.sourceSHA256);
const sourceRows = json(smallPlan.sourceFile).tables[0].rows;
const smallCondition = conditions.get(smallPlan.benchmark_condition_ID);
assert.equal(smallCondition.benchmark_ID, smallPlan.benchmark_ID);
assert.equal(smallCondition.deleted_at, null);
assert.equal(smallCondition.score_direction, 'higher');
assert.equal(smallCondition.uses_percentage_scale, 0);
assert.equal(Number(smallCondition.score_min), smallPlan.metric.min);
assert.equal(Number(smallCondition.score_max), smallPlan.metric.max);
for (const planned of smallPlan.records) {
  const row = rows[planned.pendingIndex];
  assert.equal(row.modelID, planned.model_ID);
  assert.equal(row.nativeID, planned.nativeID);
  assert.equal(row.currentConditionID, smallPlan.benchmark_condition_ID);
  assert.ok(sameValue(row.raw, planned.raw_score));
  assert.equal(row.locatedNativeResultIDs.length, 0);
  assert.equal(row.sameTupleCandidatesRequiringProvenanceReview.length, 0);
  const sourceRow = sourceRows.find(cells => cells[2] === planned.modelName);
  assert.ok(sourceRow, `Missing source row: ${planned.modelName}`);
  assert.ok(sameValue(sourceRow[3].split('\n')[0], planned.raw_score));
  const decision = resolutions.find(item => item.fromID === planned.identityResolution.fromID);
  assert.equal(decision.toID, planned.model_ID);
  assert.equal(decision.evidenceURL, planned.identityResolution.evidenceURL);
}

const uncovered = manifest.uncoveredNumericGroups.flatMap(group => group.scores.map(score => ({ ...score,
  benchmarkName: group.benchmarkName, benchmarkID: null, conditionID: null,
  metric: group.metric, direction: group.direction,
  sourceURL: group.sourceURL, sourceFile: `${original}sources/${group.sourceFile}`,
  proposedNativeID: `${group.key}:${score.nativeLabel}`
})));
assert.equal(uncovered.length, manifest.expected.uncoveredNumericObservations);
for (const group of manifest.uncoveredNumericGroups) {
  assert.ok(!Object.hasOwn(bundle.sourceFiles, group.sourceFile), 'Uncovered figure already in source manifest');
  assert.ok(!bundle.scores.some(row => row.evidence?.file === group.sourceFile));
}
for (const row of uncovered.filter(row => row.modelID !== null)) {
  assert.equal(models.get(row.modelID)?.is_active, 1);
  assert.equal(models.get(row.modelID)?.vendor_ID, row.vendorID);
}
const argon = coverage.coverage.find(row => row.ID === 'google/gemini-4-argon');
assert.equal(argon.databaseID, manifest.scope.argonModelID);
assert.equal(argon.staged, manifest.scope.argonStaged);
const argonTable = bundle.scores.filter(row => row.modelRef === 'google/gemini-4-argon'
  && row.nativeID.startsWith('gemini-4-argon:table0:'));
assert.equal(argonTable.length, manifest.scope.argonMainTableRows);
const benchmarkPlan = json(`${original}benchmark-source-plan.json`).map(source => {
  const capture = json(`${original}sources/${source.name}.capture.json`);
  return { ...source, fetched: capture.success === true, status: capture.status ?? null,
    finalURL: capture.finalURL ?? source.URL, error: capture.error ?? null,
    fullNumericBoardCollectionCertified: false };
});
const summary = {
  auditDate: manifest.auditDate, productionWrites: false, collectionComplete: false,
  snapshotBoundary: manifest.snapshotBoundary, verifiedPinnedInputs: manifest.inputEvidence.length,
  verifiedBundleSources: verifiedSources.length, originalPending: rows.length,
  originalReasonCounts: counts(rows, 'originalReason'), statusCounts,
  statusIndexRanges: Object.fromEntries(Object.keys(statusCounts).map(status => [status,
    ranges(rows.filter(row => row.status === status).map(row => row.index))])),
  originalInsertedRetained: inserted.length, originalInsertedStatusCounts: counts(inserted.map(ID => scores.get(ID)), 'status'),
  archivedNativeMatches: nativeMatches.map(row => ({ index: row.index, resultIDs: row.locatedNativeResultIDs })),
  identityResolutionStates: resolutionStates, suffixReports,
  mappedRowsWithSameTupleCandidates: rows.filter(row => row.sameTupleCandidatesRequiringProvenanceReview?.length)
    .map(row => ({ index: row.index, resultIDs: row.sameTupleCandidatesRequiringProvenanceReview })),
  mappingsNeedingConditionReview: rows.filter(row => row.conditionNeedsReview).map(row => row.index),
  smallPlanVerifiedOffline: true, smallPlanRecords: smallPlan.records.length,
  argon: { coverage: argon, mainTableRows: argonTable.length, uncoveredNumericObservations: uncovered.length,
    existingModelMappings: uncovered.filter(row => row.modelID !== null).length, missingCyberIdentityCells: 3 },
  scope: manifest.scope, benchmarkPlan, sourceGaps: manifest.sourceGaps
};
const output = flag === '--details' ? { ...summary, pending: rows }
  : flag === '--mappings' ? { snapshotBoundary: manifest.snapshotBoundary,
    auditCandidatesOnly: true, pending: rows.filter(row => row.status === 'identity_mapped_not_imported'), uncovered }
    : flag === '--small-plan' ? { ...smallPlan, offlineVerified: true, freshProductionPreflightRequired: true }
      : flag === '--scope' ? { scope: manifest.scope, originalTargets: coverage.coverage,
        benchmarkPlan, sourceGaps: manifest.sourceGaps }
        : flag === '--verify' ? { passed: true, statusCounts, pendingCovered: rows.length,
        originalInsertedRetained: inserted.length, smallPlanVerified: 2,
        sameTupleCandidates: summary.mappedRowsWithSameTupleCandidates,
        mappingsNeedingConditionReview: summary.mappingsNeedingConditionReview }
        : summary;
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
