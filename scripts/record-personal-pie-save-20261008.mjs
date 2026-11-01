import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const base = 'artifacts/review-20261008/personal-pie-commit-20261008';
const root = resolve(base), deployment = join(root, 'deployment');
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const receipt = await json(join(deployment, 'receipt.json'));
const manifest = await json(join(deployment, 'manifest.json'));
const installed = await json(join(deployment, 'installed-guards.json'));
const integrationPath = base + '/immutable-1791465493098/integration-verification.json';
const focusedPath = base + '/immutable-1791465671324/focused-verification.json';
const browserPath = base + '/browser-1791464040405/report.json';
const publicPath = base + '/deployment/public-1791465886737.json';
const integration = await json(integrationPath), focused = await json(focusedPath);
const browser = await json(browserPath), native = await json(join(deployment, 'mysql.json')), publicProof = await json(publicPath);
assert.equal(receipt.healthy, true); assert.equal(manifest.files.length, 8); assert.equal(manifest.protectedFiles.length, 163);
assert.equal(installed.hashes.length, 171); assert.equal(installed.servicesActive, true);
assert.equal(installed.protectedRegistrations.length, 26);
for (const proof of [integration, focused]) {
    assert.equal(proof.passed, true); assert.deepEqual(proof.sourceDrift, []); assert.deepEqual(proof.runtimeDrift, []);
}
assert.equal(integration.checks.find(check => check.name === 'unit').summary.pass, 1554);
assert.equal(integration.checks.find(check => check.name === 'frontend').summary.passed, 62);
assert.equal(integration.checks.find(check => check.name === 'lint').passed, true);
assert.equal(focused.checks[0].summary.pass, 130);
assert.equal(browser.results.length, 12); assert.ok(browser.results.every(result => result.passed));
assert.equal(native.passed, 14); assert.equal(native.total, 14); assert.equal(native.productionBusinessDataWritten, false);
assert.equal(publicProof.passed, true); assert.equal(publicProof.results.length, 11); assert.equal(publicProof.release, receipt.release);
const statePath = resolve('artifacts/review-20261008/review-state.json');
const original = await readFile(statePath), state = JSON.parse(original.toString('utf8').replace(/^\uFEFF/, ''));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const previous = state.authenticatedPieSaveReview;
assert.equal(previous.status, 'reproduced_not_repaired', 'Never overwrite a later review result');
const report = {
    ...previous, status: 'repaired_deployed', release: receipt.release,
    previousRelease: state.release, backup: receipt.backup,
    scope: 'Authenticated Personal Pie save protocol: durable transactional receipt, safe replay, retained drafts, separate ranking refresh and bounded deadlock retry. Whole-site review remains active.',
    filesDeployed: manifest.files.map(file => file.path),
    deploymentReport: base + '/deployment/receipt.json', installedChecks: base + '/deployment/installed-guards.json',
    protectedHashes: 163, protectedWriteRegistrations: 26, applicationRestarted: true,
    applicationChanges: true, databaseChanged: false, productionBusinessDataWritten: false,
    productionRequests: true, workerTriggered: false, sourceRegistrationsChanged: false, timerChanged: false,
    originalRemaining: previous.remaining,
    fixed: ['Return the durable save receipt independently of ranking reads.',
        'Replay an actor-scoped request identity without repeating deletion/recreation or updating Pie activity again.',
        'Retain uncertain edits and Undo history; confirm the captured request before saving newer changes.',
        'Protect account/context/edit/presentation interleavings and bound both write and read responses.',
        'Retry confirmed InnoDB deadlocks only, with the same identity and at most three attempts.',
        'Show compact Retry save, Retry calculation or Review saved pie actions without a misleading empty ranking.'],
    verification: { fullIntegrationSnapshot: integrationPath, integrationUnitTestsPassed: 1554,
        frontendChecksPassed: 62, lintPassed: true, sourceDrift: [],
        installedRepairSuites: focusedPath, installedRepairTestsPassed: 130,
        nativeReport: base + '/deployment/mysql.json', nativeChecksPassed: 14,
        browserReport: browserPath, browserChecksPassed: 12,
        scope: 'Full frozen current integration tree including concurrent UI work; exact staged repair is independently covered by seven focused suites, native disposable MySQL and Chromium/WebKit fixtures. No full production-stage test-tree or physical-device claim.' },
    publicChecks: { passed: true, requestsPassed: 11, requestsTotal: 11, report: publicPath,
        assetHashesMatched: 6, authenticated: false, accountWrites: false, browserUI: false, latencySLA: false },
    concurrentWorkPolicy: 'No unrelated local logic or UI is restored. The deployed payload preserves captured installed bytes outside owned hunks; 163 other files and 26 write-owner registrations remain unchanged. Stop on changed owned behavior or installed drift.',
    remaining: ['Real OAuth and authenticated production writes, physical iPhone Safari, the earlier anonymous startup stall, natural score-sync publication, SMTP and broader review remain unverified.',
        'Release compare/replace checks do not provide an OS-level atomic compare-and-swap against an unrelated writer ignoring the protocol.'],
    socialPublication: 'not_posted', closeout: base + '/closeout.md'
};
state.authenticatedPieSaveReview = report;
state.latestReview = report;
state.release = receipt.release;
state.productionBackup = receipt.backup;
state.goalStatus = 'active';
state.databaseChanged = false;
await writeFile(join(root, 'closeout-summary.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
const temporary = statePath + `.personal-pie-${Date.now()}.tmp`;
await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx' });
assert.equal(sha(await readFile(statePath)), sha(original), 'Review state changed concurrently; do not replace it');
await rename(temporary, statePath);
console.log(JSON.stringify({ recorded: true, release: receipt.release, goalStatus: state.goalStatus,
    localApplicationFilesChanged: false, productionBusinessDataWritten: false }));
