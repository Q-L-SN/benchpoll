import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const base = 'artifacts/review-20261008/authenticated-pie-recovery-20261008', root = resolve(base);
const deployment = resolve(arg('deployment')), sourcePath = resolve('artifacts/review-20261008/review-state.json');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const portable = path => relative(process.cwd(), path).replaceAll('\\', '/');
assert.ok(deployment.startsWith(join(root, 'deployment-')));
const manifest = await json(join(deployment, 'manifest.json')), receipt = await json(join(deployment, 'receipt.json'));
const installed = await json(join(deployment, 'installed-guards.json')), preflight = await json(join(deployment, 'preflight.json'));
const full = await json(preflight.proof.full.path), focused = await json(preflight.proof.focused.path);
const browser = await json(preflight.proof.browser.path);
const savePath = arg('save-browser'), saveBrowser = await json(savePath);
const publicPath = arg('public-report'), publicProof = await json(publicPath);
const livePath = arg('live-browser'), liveBrowser = await json(livePath);
assert.equal(receipt.healthy, true); assert.equal(receipt.release, manifest.release); assert.equal(receipt.files, 6);
assert.equal(receipt.databaseChanged, false); assert.equal(installed.applicationRestarted, false);
assert.equal(installed.concurrentChangesReverted, false); assert.equal(installed.protectedFiles, 161);
for (const proof of [preflight.proof.full, preflight.proof.focused, preflight.proof.browser]) {
    assert.equal(sha(await readFile(proof.path)), proof.hash);
}
for (const report of [full, focused]) { assert.equal(report.passed, true); assert.deepEqual(report.sourceDrift, []); }
for (const [report, count] of [[browser, 20], [saveBrowser, 12]]) {
    assert.equal(report.results.length, count); assert.ok(report.results.every(result => result.passed)); assert.deepEqual(report.sourceDrift, []);
    assert.equal(resolve(report.sourceRoot), join(deployment, 'stage'));
    for (const [path, expected] of Object.entries(report.hashes)) assert.equal(sha(await readFile(join(report.sourceRoot, path))), expected);
}
assert.equal(publicProof.passed, true); assert.equal(publicProof.release, receipt.release); assert.equal(publicProof.results.length, 11);
assert.equal(liveBrowser.results.length, 4);
const original = await readFile(sourcePath), state = JSON.parse(original.toString('utf8').replace(/^\uFEFF/, ''));
const previous = state.authenticatedPieRecoveryReview;
assert.equal(previous.status, 'reproduced_not_repaired', 'Do not overwrite a newer repair review');
const report = {
    ...previous, status: 'repaired_deployed', completedAt: new Date().toISOString(), release: receipt.release,
    previousReviewRelease: state.release, backup: receipt.backup, freshInstalledCapture: portable(join(deployment, 'baseline.json')),
    applicationChanges: true, frontendOnly: true, applicationRestarted: false, databaseChanged: false,
    productionBusinessDataWritten: false, realAccountRequests: false, productionRequests: true,
    filesDeployed: manifest.files.map(file => file.path), protectedHashes: installed.protectedFiles,
    concurrentChangesReverted: false, deploymentReport: portable(join(deployment, 'receipt.json')),
    installedChecks: portable(join(deployment, 'installed-guards.json')),
    originalRemaining: previous.remaining,
    fixed: [
        'Separate authenticated recovery by canonical owner and exact category/context; another owner or anonymous page never receives an automatic preview.',
        'Checkpoint edits before debounce, gestures/page exit and transport so reload preserves latest edits and the original unconfirmed body/UUID separately.',
        'Confirm restored recovery explicitly, replay the original request before newer edits, and use a fresh identity for genuinely new operations after discard.',
        'Keep real guest adoption independent, require an explicit claim for legacy ownerless data, and preserve unavailable/corrupt recovery for intentional resolution.',
        'Remove or overwrite only the matching record generation; stale responses and restored documents cannot clear another owner/context or newer recovery.'
    ],
    verification: {
        fullIntegrationSnapshot: portable(preflight.proof.full.path), integrationUnitTestsPassed: preflight.proof.full.testsPassed,
        installedRepairSuites: portable(preflight.proof.focused.path), installedRepairTestsPassed: preflight.proof.focused.testsPassed,
        browserReport: portable(preflight.proof.browser.path), browserChecksPassed: 20,
        saveBrowserReport: portable(savePath), saveBrowserChecksPassed: 12, lintPassed: true, sourceDrift: [],
        scope: 'Frozen current integration tree, separately verified installed-stage behavior and Chromium/WebKit fixtures at desktop/touch-mobile sizes. Later concurrent edits are not claimed verified.'
    },
    publicChecks: { passed: true, requestsPassed: publicProof.results.length, report: portable(publicPath),
        assetHashesMatched: 6, authenticated: false, accountWrites: false, browserUI: false, latencySLA: false },
    liveBrowserChecks: { passed: liveBrowser.passed, passedCount: liveBrowser.results.filter(result => result.passed).length,
        total: liveBrowser.results.length, report: portable(livePath), authenticated: false },
    concurrentWorkPolicy: 'Only six recovery modules/owned hunks are published onto a fresh installed capture. Unowned homepage changes and 161 protected files remain unchanged at release. No local reset, revert or full-tree copy.',
    scopeLimit: 'Fixture authenticated recovery and actual browser session storage, live anonymous HTTP and public browser smoke only. No real OAuth/account mutation, physical iPhone Safari or complete bug-elimination claim.',
    remaining: [
        'Whole-site review remains active. Real OAuth/authenticated production writes, physical iPhone Safari, natural score-sync publication and SMTP are not verified.',
        ...(liveBrowser.passed ? [] : ['Fresh anonymous live-browser startup did not pass all checks; inspect the live browser report before attributing this to an application defect.']),
        'Release compare/replace guards are not OS-level atomic compare-and-swap against an independent writer ignoring this protocol.'
    ],
    socialPublication: 'not_posted', closeout: base + '/closeout.md'
};
state.authenticatedPieRecoveryReview = report;
if (state.latestReview?.release === state.authenticatedPieSaveReview?.release && state.release === state.authenticatedPieSaveReview?.release) {
    state.latestReview = report; state.release = receipt.release; state.productionBackup = receipt.backup;
}
state.goalStatus = 'active';
await writeFile(join(root, 'closeout-summary.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
const temporary = sourcePath + '.pie-recovery-' + Date.now() + '.tmp';
await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx' });
assert.equal(sha(await readFile(sourcePath)), sha(original), 'Review state changed concurrently; preserve it');
await rename(temporary, sourcePath);
console.log(JSON.stringify({ recorded: true, release: receipt.release, goalStatus: state.goalStatus, liveBrowserPassed: liveBrowser.passed,
    applicationFilesChanged: false, productionBusinessDataWritten: false }));
