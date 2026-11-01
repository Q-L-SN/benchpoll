#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { classifyConditionPair } from '../condition-precision-filter.js';
import { fullScoreEvidenceDigest } from '../condition-overlap-merge-plan.js';

const [reviewPath, oldAuditPath, currentAuditPath, snapshotPath, outputPath] = process.argv.slice(2);
if (!outputPath || process.argv.length !== 7) {
    throw new Error('Usage: node scripts/prepare-precision-semantic-merges.mjs <review.json> <old-audit.json> <current-audit.json> <current-snapshot.json.gz> <output-spec.json>');
}
const [review, oldAudit, currentAudit] = await Promise.all([reviewPath, oldAuditPath, currentAuditPath]
    .map(async path => JSON.parse(await readFile(path, 'utf8'))));
const snapshotBytes = await readFile(snapshotPath);
const snapshot = JSON.parse(snapshotPath.endsWith('.gz')
    ? gunzipSync(snapshotBytes).toString('utf8') : snapshotBytes.toString('utf8'));
if (!Array.isArray(review.groups) || !review.groups.length) throw new Error('Empty semantic review');
if (String(snapshot.snapshotTime) !== String(currentAudit.snapshotTime)) {
    throw new Error('Current audit and score snapshot were not taken at the same time');
}
const selectedIDs = new Set();
const proofs = [];
for (const group of review.groups) {
    if (!group.reason?.trim() || !Array.isArray(group.sourceIDs) || !group.sourceIDs.length) {
        throw new Error(`Invalid reviewed group ${group.targetID}`);
    }
    for (const id of [group.targetID, ...group.sourceIDs]) {
        if (selectedIDs.has(id)) throw new Error(`Condition ${id} occurs in multiple groups`);
        selectedIDs.add(id);
    }
    for (const sourceID of group.sourceIDs) {
        const IDs = [group.targetID, sourceID].sort((a, b) => a - b);
        const pairEvidence = [];
        for (const [label, audit] of [['original', oldAudit], ['current', currentAudit]]) {
            const pair = audit.pairs.find(row => row.conditionIDs[0] === IDs[0]
                && row.conditionIDs[1] === IDs[1]);
            const conditions = new Map(audit.conditions.map(row => [Number(row.ID), row]));
            const target = conditions.get(group.targetID);
            const source = conditions.get(sourceID);
            if (!pair || !target || !source || pair.benchmarkName !== group.benchmarkName
                || target.name !== currentAudit.conditions.find(row => Number(row.ID) === group.targetID)?.name
                || source.name !== currentAudit.conditions.find(row => Number(row.ID) === sourceID)?.name
                || !pair.sameScale || pair.semanticDifferences?.length
                || classifyConditionPair(pair, audit.samples).verdict !== 'merge') {
                throw new Error(`${label} audit does not verify reviewed pair ${IDs.join('/')}`);
            }
            pairEvidence.push({ audit: label, exact: pair.exactMatchCount,
                rounding: pair.rounding.length, models: pair.exactModelCount });
        }
        proofs.push({ targetID: group.targetID, sourceID, pairEvidence, reason: group.reason });
    }
}
const rows = snapshot.results.filter(row => selectedIDs.has(Number(row.conditionID)));
const snapshotIDs = new Set(snapshot.conditions.map(row => Number(row.ID)));
if ([...selectedIDs].some(id => !snapshotIDs.has(id))) throw new Error('A reviewed condition is absent from the snapshot');
const output = { scoreEvidenceScope: 'all', scoreEvidence: fullScoreEvidenceDigest(rows),
    groups: review.groups };
await writeFile(outputPath, JSON.stringify(output, null, 2));
console.log(JSON.stringify({ groups: output.groups.length, sources: proofs.length,
    scoreRows: rows.length, scoreEvidence: output.scoreEvidence,
    proof: proofs, output: outputPath }, null, 2));
