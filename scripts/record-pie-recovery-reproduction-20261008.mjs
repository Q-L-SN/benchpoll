import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = 'artifacts/review-20261008/authenticated-pie-recovery-20261008';
const paths = ['reproduction-first.json', 'reproduction-repeat.json', 'reproduction-installed.json'].map(path => base + '/' + path);
const reports = [];
for (const path of paths) {
    const report = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(report.total, 12); assert.equal(report.violations, 6); assert.equal(report.healthyControls, 6);
    assert.equal(report.applicationChanged, false); assert.equal(report.productionRequests, false);
    assert.equal(new Set(report.observations.filter(row => !row.passed).map(row => row.name)).size, 3);
    assert.equal(new Set(report.observations.filter(row => row.control && row.passed).map(row => row.name)).size, 3);
    reports.push(report);
}
assert.deepEqual(reports[0].fingerprints, reports[1].fingerprints);
const statePath = resolve('artifacts/review-20261008/review-state.json');
const original = await readFile(statePath), state = JSON.parse(original.toString('utf8').replace(/^\uFEFF/, ''));
assert.equal(Object.hasOwn(state, 'authenticatedPieRecoveryReview'), false, 'Preserve an existing later review');
const report = { status: 'reproduced_not_repaired', defectClasses: 2, observedFailureScenarios: 3,
    scope: 'Account isolation and reload durability of Personal Pie browser recovery. Whole-site review remains active.',
    brief: base + '/reproduction.md', requirements: base + '/repair-requirements.md',
    localBaseline: base + '/baseline.json', installedBaseline: base + '/installed-baseline.json',
    reports: paths, violationsPerRun: 6, healthyControlsPerRun: 6, runs: 3, repetitionsPerScenarioPerRun: 2,
    applicationChanges: false, databaseChanged: false, realAccountRequests: false,
    sourceCapture: 'Read-only capture of installed client/HTML source after the concurrent UI deployment; no business data read.',
    concurrentInstalledChangesObserved: 15, concurrentChangesReverted: false,
    findings: [
        { priority: 1, class: 'ownerless_authenticated_recovery', file: 'public/js/home-workspace.js',
            behavior: 'A failed signed-in draft is cached as a guest draft. A fresh different-owner or anonymous page automatically previews it.',
            serverScope: 'No unauthorized backend write or cross-user business-table access is claimed.' },
        { priority: 2, class: 'inflight_reload_draft_loss', file: 'public/js/home-workspace.js',
            behavior: 'The authenticated debounce and pending-response paths have no persisted recovery checkpoint; reload restores only the old server mix.' }
    ],
    remaining: ['Implement owner/context-scoped recovery and retain exact pending request identity before transport.',
        'Preserve genuine guest adoption, legacy ownerless data and newer recovery generations without automatic cross-account application.',
        'Validate the full repair requirements and current installed UI before publication.'],
    scopeLimit: 'Actual captured functions/modules with fixture transport and in-memory session storage. No real OAuth, live authenticated mutation, complete browser rendering or physical-device claim.'
};
state.authenticatedPieRecoveryReview = report;
state.goalStatus = 'active';
await writeFile(base + '/reproduction-summary.json', JSON.stringify(report, null, 2), { flag: 'wx' });
const temporary = statePath + `.pie-recovery-${Date.now()}.tmp`;
await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx' });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(await readFile(statePath)), sha(original), 'Review state changed concurrently; preserve it');
await rename(temporary, statePath);
console.log(JSON.stringify({ recorded: true, status: report.status, defectClasses: 2, scenarios: 3,
    applicationChanges: false, productionBusinessDataWritten: false, goalStatus: state.goalStatus }));
