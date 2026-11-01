import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { auditConditionScoreOverlap } from '../condition-score-overlap.js';
import { planConditionOverlapMerges, scoreEvidenceDigest, semanticDifferences } from '../condition-overlap-merge-plan.js';

const [input, reviewPath, output] = process.argv.slice(2);
if (!input || !reviewPath || !output || process.argv.length !== 5) {
    throw new Error('Usage: node scripts/plan-condition-score-merges.mjs snapshot.json.gz review.json plan.json');
}
const snapshot = JSON.parse(gunzipSync(await readFile(input)).toString('utf8'));
const review = JSON.parse(await readFile(reviewPath, 'utf8'));
const report = auditConditionScoreOverlap(snapshot);
const plan = planConditionOverlapMerges(report, review.groups, new Set(review.protectedIDs));
const conditions = new Map(report.conditions.map(c => [Number(c.ID), c]));
const ids = new Set(plan.groups.flatMap(g => [g.targetID, ...g.sourceIDs]));
plan.scoreEvidence = scoreEvidenceDigest(snapshot.results.filter(row => ids.has(Number(row.conditionID))));
plan.snapshotTime = snapshot.snapshotTime;
plan.scanSummary = report.summary;
plan.reviewedInput = reviewPath;
plan.thresholdExceptions = report.pairs.filter(p => p.exactThresholdMet).map(p => ({
    conditionIDs: p.conditionIDs, benchmarkName: p.benchmarkName, exact: p.exactMatchCount,
    coverage: p.exactCoverage, conflictingConfigs: p.conflictingConfigs,
    semanticDifferences: semanticDifferences(...p.conditionIDs.map(id => conditions.get(id)))
}));
await writeFile(output, JSON.stringify(plan, null, 2));
console.log(JSON.stringify({ groups: plan.groups.length, merges: plan.steps.length,
    blocked: plan.blocked, scanSummary: plan.scanSummary }, null, 2));
