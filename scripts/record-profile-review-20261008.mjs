import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = 'artifacts/review-20261008', output = `${root}/profile-read-deployment`;
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const state = await json(`${root}/review-state.json`);
const manifest = await json(`${output}/manifest.json`), receipt = await json(`${output}/deployment-result.json`);
const guards = await json(`${output}/installed-guards.json`), preflight = await json(`${output}/preflight.json`);
const publicAssets = await json(`${output}/public-assets.json`);
const first = await json(`${output}/production-before.json`), extra = await json(`${output}/coordination-production-before.json`);
const index = await json(`${output}/verification-index.json`);
assert.match(index.directory, /^verification-[a-z0-9-]+$/);
const verified = `${output}/${index.directory}`, unitPath = `${verified}/unit-final.tap`;
const unit = await readFile(unitPath, 'utf8');
const count = Number(unit.match(/^# tests (\d+)$/m)?.[1]);
assert.equal(preflight.unitTests, count);
assert.match(unit, new RegExp(`^# pass ${count}$`, 'm'));
for (const field of ['fail', 'skipped', 'cancelled']) assert.match(unit, new RegExp(`^# ${field} 0$`, 'm'));
const frontend = await json(`${verified}/frontend-results.json`);
assert.equal(frontend.length, 62); assert.ok(frontend.every(item => item.passed));
const profilePath = `${root}/profile-read-after-final/results.json`, profile = await json(profilePath);
assert.equal(profile.after, true); assert.equal(profile.results.length, 12);
assert.ok(profile.results.every(item => item.passed && item.errors.length === 0));
for (const source of profile.sources) assert.equal(source.sha256, await sha(source.path));
const navigationPath = `${root}/navigation-contract-current/results.json`, navigation = await json(navigationPath);
assert.equal(navigation.length, 15); assert.ok(navigation.every(item => item.passed));
const coordination = await json(`${output}/coordination-proof.json`), snapshots = await json(`${output}/snapshot-proof.json`);
assert.equal(coordination.reports.length, 2); assert.equal(snapshots.reports.length, 2);
for (const path of coordination.reports) {
    const report = await json(path);
    assert.equal(report.expectFixed, true); assert.equal(report.protectedEvidenceUnchanged, true);
    assert.deepEqual(report.changedSources, []); assert.equal(report.browserMatrix.length, 4);
    assert.ok(report.browserMatrix.every(item => item.status === 'passed'
        && !item.remainingSameTarget.profileEditor.bug && !item.remainingSameTarget.privateForm.bug));
}
for (const path of snapshots.reports) {
    const report = await json(path);
    assert.equal(report.expectFixed, true); assert.equal(report.sourcesUnchanged, true);
    assert.equal(report.expectations.passed, true); assert.equal(report.preservation.preserved, true);
    assert.equal(report.tests.exitCode, 0); assert.equal(report.lint.exitCode, 0);
}
assert.equal(receipt.healthy, true); assert.equal(receipt.databaseChanged, false); assert.equal(receipt.files, 6);
assert.ok([manifest, guards, preflight].every(item => item.release === receipt.release));
assert.equal(publicAssets.release, receipt.release); assert.equal(publicAssets.results.length, 5);
assert.ok(publicAssets.results.every(item => item.matches && item.hash === manifest.files.find(file => file.path === item.path).after));
assert.equal(guards.installedHashes, 6); assert.equal(guards.protectedHashes, 21);
assert.equal(guards.protectedRegistrations, 26); assert.equal(guards.checks.length, 6);
assert.ok(guards.checks.every(item => item.matchedAccepted && item.foreignRejected));
assert.deepEqual(guards.services, ['active', 'active']); assert.equal(guards.databaseAccess, false);
assert.equal(first.baseline, extra.baseline);
const originals = new Map([...first.hashes, ...extra.hashes].map(file => [file.path, file.hash]));
for (const file of manifest.files) {
    assert.equal(await sha(file.path), file.after);
    assert.equal(originals.get(file.path), file.before);
    assert.equal(await sha(`${first.baseline}/${file.path}`), file.before);
}
const strictPath = `${root}/profile-read-production-smoke/results.json`;
const settledPath = `${root}/profile-read-production-settled-smoke/results.json`;
const strict = await json(strictPath), settled = await json(settledPath);
assert.equal(strict.length, 4); assert.equal(settled.length, 4);
assert.ok(strict.every(item => item.mode === 'immediate-navigation'));
assert.ok(settled.every(item => item.mode === 'settled-telemetry'));
for (const item of strict.filter(item => !item.passed)) {
    assert.ok(item.errors?.length > 0, 'Diagnose a new application failure before recording release health');
    assert.ok(item.errors.every(error => error.stack.includes('/cdn-cgi/rum? due to access control checks.')
        && error.stack.includes('static.cloudflareinsights.com/beacon.min.js')));
    assert.deepEqual(item.failedResponses, []);
}
assert.ok(settled.every(item => item.passed), 'Separate settled smoke must pass without filtering errors');
const handoff = await json('artifacts/launch-20261008/handoff-check.json');
assert.equal(handoff.passed, 33); assert.equal(handoff.total, 33);
const latest = {
    release: receipt.release, previousRelease: state.release, filesDeployed: manifest.files.map(file => file.path),
    databaseChanged: false, sourceRegistrationsChanged: false,
    contextMap: `${root}/profile-read-context.md`, reproduction: `${root}/profile-read-reproduction.md`,
    rolloutPlan: `${root}/profile-read-rollout.md`, productionBaseline: first.baseline,
    installedBaselineDiff: `${output}/installed-baseline.diff`, deploymentReport: `${output}/deployment-result.json`,
    fixed: [
        { id: 'unbounded-initial-comparison-profile-read', resolution: 'Opt-in ten-second deadline includes fetch/body and abort; a late transport cannot apply old settings.' },
        { id: 'profile-read-failure-default-substitution', resolution: 'Failure presents explicit Retry without calculating a different saved comparison; retry deduplicates and restores account settings.' },
        { id: 'composition-fallback-stale-show', resolution: 'Composition hides fallback through the same visibility controller, cancelling its old show.' },
        { id: 'agi-return-stale-hide', resolution: 'Promo desired aria state controls reversal rather than its temporary hidden state.' },
        { id: 'saved-profile-editor-stale-show', resolution: 'Menu close cancels the old editor show and retains hidden/inert/aria state.' },
        { id: 'private-category-form-stale-show', resolution: 'Guest cleanup cancels an obsolete form show without writes or account rebinding.' },
        { id: 'rejected-ranking-page-recency-touch', resolution: 'Only a successfully constructed page renews snapshot expiry and LRU priority.' },
        { id: 'failed-ranking-create-capacity-eviction', resolution: 'Prepare pages, catalogue, response and score scales before inserting or evicting. This covers synchronous producer failures, not later serialization/OOM.' },
        { id: 'expired-snapshot-family-cleanup', resolution: 'Prune expired snapshots before catalogue-wide cleanup; capacity reservation remains create-only.' }
    ],
    verification: {
        unitTests: { passed: count, total: count, report: unitPath,
            note: 'Includes explicit known-issue characterization controls; a green suite is not proof all bugs are fixed.' },
        mainFrontendChecks: { passed: 62, total: 62, report: `${verified}/frontend-results.json` },
        profileRecovery: { passed: 12, total: 12, report: profilePath, syntheticAccounts: true, writes: false },
        coordination: { passed: 8, total: 8, reports: coordination.reports, controlledAnimationCompletion: true,
            genericCrossInstanceMotionAppFailureProven: false, asyncReplayAppFailureProven: false },
        snapshotConsistency: { reports: snapshots.reports, testsPerRepetition: 67, repetitions: 2,
            productionData: false, activeOwnerCapacityProgressFixed: false },
        navigation: { passed: 15, total: 15, report: navigationPath,
            note: `${root}/profile-read-navigation-note.md`, actualOAuth: false },
        lint: `${verified}/lint-final.txt`,
        preservedFailures: [`${root}/profile-read-before/results.json`, `${root}/profile-read-after/results.json`,
            `${root}/coordination-after1`, `${root}/coordination-after2`, `${root}/navigation-before/results.json`,
            `${root}/navigation-updated-current/results.json`]
    },
    productionChecks: {
        installedHashes: 6, protectedHashes: 21, protectedRegistrations: 26, pureGuardChecks: 6,
        services: guards.services, report: `${output}/installed-guards.json`,
        publicAssetHashes: { matched: 5, total: 5, report: `${output}/public-assets.json` },
        strictSmoke: { passed: strict.filter(item => item.passed).length, total: 4, report: strictPath,
            unresolvedFailures: strict.filter(item => !item.passed).map(item => ({ engine: item.engine, width: item.width,
                error: item.error, errors: item.errors })) },
        separateSettledTelemetrySmoke: { passed: settled.filter(item => item.passed).length, total: 4,
            report: settledPath, replacesStrictSmoke: false },
        actualOAuth: false, actualEmailDelivery: false, physicalMobileSafari: false
    },
    remaining: [
        'Above twelve active synthetic owners, continuation recovery still resets to the first page. The reproduction is bounded and not a measured production traffic rate.',
        'Snapshot family-removal invalidation is deliberately conservative and global; unrelated continuation may return 410.',
        'Snapshot cache has no measured byte budget or idle expiry timer. Guest UUIDs are capability handles, not session-bound.',
        'Intermittent public asset stalls, whole-request/CPU deadlines, actual OAuth, physical Safari and SMTP delivery are not solved by these fixes.'
    ],
    socialPublication: { status: 'not_posted', actualPostsOrMessagesSent: false,
        handoff: 'artifacts/launch-20261008/START-HERE.md', materials: 'artifacts/launch-20261008/launch-kit.html',
        archive: 'artifacts/launch-20261008/BenchPoll-launch-kit-20261008.zip', verification: { passed: 33, total: 33 } }
};
if (state.release !== receipt.release) state.startupReview = state.latestReview;
state.latestReview = latest; state.release = receipt.release; state.productionBackup = receipt.backup;
state.databaseChanged = false; state.goalStatus = 'active';
state.verification.unitTests = latest.verification.unitTests;
state.verification.mainFrontendChecks = latest.verification.mainFrontendChecks;
state.verification.productionSmoke = { ...latest.productionChecks, release: receipt.release };
state.nextReview = state.nextReview.filter(item => !item.startsWith('Verify a stalled comparison-profile read'))
    .map(item => item.startsWith('Measure memory-bounded snapshot behavior')
        ? 'Fix progress-aware recovery when more active ranking snapshots than the twelve-slot cache are interleaved. Offline 13-owner controls still loop through 39 full refreshes in three rounds; retain consistent snapshot rows, account binding and bounded retry.' : item);
const progress = 'Review conservative snapshot-wide fallback/search offset invalidation, guest snapshot capabilities and byte-bounded retention; do not confuse repaired atomicity/recency with solved capacity.';
if (!state.nextReview.includes(progress)) state.nextReview.push(progress);
await writeFile(`${root}/profile-read-results.json`, JSON.stringify(latest, null, 2), { flag: 'wx' });
await writeFile(`${root}/review-state.json`, JSON.stringify(state, null, 2));
console.log(JSON.stringify({ release: receipt.release, goalStatus: state.goalStatus, unitTests: count, frontendChecks: 62,
    navigationChecks: 15, strictPassed: latest.productionChecks.strictSmoke.passed,
    settledPassed: latest.productionChecks.separateSettledTelemetrySmoke.passed, databaseChanged: false, socialPublication: 'not_posted' }));
