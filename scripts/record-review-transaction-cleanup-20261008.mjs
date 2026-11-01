import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const root = 'artifacts/review-20261008';
const output = `${root}/transaction-cleanup-deployment`;
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const state = await json(`${root}/review-state.json`);
const manifest = await json(`${output}/manifest.json`), deployment = await json(`${output}/deployment-result.json`);
const guards = await json(`${output}/deployed-guards.json`), assets = await json(`${output}/public-assets.json`);
const before = await json(`${root}/transaction-cleanup-before/combined-results.json`);
const after = await json(`${root}/transaction-cleanup-after/results.json`);
const browser = await json(`${root}/transaction-cleanup-reviewer-browser/results.json`);
const frontend = await json('artifacts/frontend/results.json');
const staged = await json(`${output}/staged-mysql.json`), installed = await json(`${output}/installed-mysql.json`);
const stagedModeration = await json(`${output}/staged-moderation-mysql.json`);
const installedModeration = await json(`${output}/installed-moderation-mysql.json`);
const unitPath = `${root}/transaction-cleanup-unit-tests.tap`, unit = await readFile(unitPath, 'utf8');
const tests = Number(unit.match(/# tests (\d+)/)?.[1]), passes = Number(unit.match(/# pass (\d+)/)?.[1]);
const smokePath = `${root}/transaction-cleanup-production-smoke/results.json`, smoke = await json(smokePath);
const launchCheck = await json('artifacts/launch-20261008/handoff-check.json');

assert.ok([manifest, guards, assets].every(item => item.release === deployment.release));
assert.equal(deployment.healthy, true); assert.equal(deployment.files, 13); assert.equal(deployment.databaseChanged, false);
assert.equal(guards.installedHashes, 13); assert.equal(guards.protectedRegistrations, 15); assert.equal(guards.checks.length, 30);
assert.deepEqual(guards.services, ['active', 'active']);
assert.equal(before.passed, 0); assert.equal(before.total, 96);
assert.equal(after.passed, 96); assert.equal(after.total, 96); assert.ok(after.results.every(result => result.passed));
assert.ok(tests >= 1311); assert.equal(passes, tests); assert.match(unit, /# fail 0/);
assert.ok(frontend.length === 62 && frontend.every(result => result.passed));
assert.equal(browser.passed, 48); assert.equal(browser.total, 48); assert.ok(browser.results.every(result => result.passed));
for (const result of [staged, installed]) {
    assert.equal(result.passed, 77); assert.equal(result.total, 77); assert.equal(result.postFixPassed, 76);
    assert.equal(result.postFixTotal, 76); assert.equal(result.baselineReproduced, true);
    assert.equal(result.productionBusinessTablesAccessed, false); assert.equal(result.actualSQLInDisposableSchema, true);
    assert.ok(result.results.every(check => check.passed));
}
assert.equal(installed.applicationSource, '/home/ubuntu/benchpoll');
for (const result of [stagedModeration, installedModeration]) {
    assert.equal(result.passed, 48); assert.equal(result.total, 48); assert.equal(result.actualDriverAndTransactions, true);
    assert.equal(result.productionApplicationTablesRead, false); assert.equal(result.productionApplicationTablesWritten, false);
    assert.equal(result.realOAuth, false); assert.equal(result.realEmailDelivery, false);
    assert.ok(result.disposableSchemaCreatedAndRemoved);
}
assert.equal(installedModeration.applicationSource, '/home/ubuntu/benchpoll');
assert.equal(smoke.length, 4);
assert.equal(launchCheck.passed, 33); assert.equal(launchCheck.total, 33);

const previousRelease = state.release === deployment.release ? state.latestReview.previousRelease : state.release;
const latest = {
    release: deployment.release, previousRelease, filesDeployed: manifest.files.map(file => file.path), databaseChanged: false,
    contextMap: `${root}/transaction-cleanup-context.md`, rolloutPlan: `${root}/transaction-cleanup-rollout.md`,
    deploymentReport: `${output}/deployment-result.json`, productionBaseline: 'D:/BenchPoll-artifacts/review-20261008/transaction-cleanup-production-before',
    installedBaselineDiff: `${output}/installed-baseline.diff`,
    fixed: [
        { id: 'failed-cleanup-masks-original-and-reuses-unfinished-transaction', severity: 'high',
            resolution: 'Shared lifecycle preserves original errors, bounds rollback, destroys uncertain begin/commit/rollback leases, and avoids releasing discarded connections. Normal SQL and duplicate-name translations remain unchanged.' },
        { id: 'moderation-cleanup-hang-and-release-error', severity: 'high',
            resolution: 'Moderation keeps same-lease failure auditing after confirmed rollback, skips auditing after unsafe cleanup, and bounds rollback without replacing operation results. Preview requires confirmed rollback before returning SQL.' },
        { id: 'arena-failed-marker-not-durable-on-unsafe-transaction', severity: 'high',
            resolution: 'Clean bounded recovery persists only its batch failure; uncertain lease is destroyed before recovery. Failure marking cannot overwrite success after a lost commit acknowledgement. CLI lock/end cleanup is bounded and retains original causes.' },
        { id: 'score-source-registration-cleanup-masks-original-error',
            resolution: 'Operator registration starts inside owned error handling and preserves original status/code; its CLI skips discarded connections and bounds end cleanup without replacing the registration outcome.' },
        { id: 'release-listener-error-destroys-next-borrower', conditional: true,
            resolution: 'Native mysql2 release observation prevents the old wrapper from destroying a transferred lease; real driver reentrant listener probes pass. No triggering listener was found in the application owners.' }
    ],
    reproductionEvidence: { brief: `${root}/transaction-cleanup-reproduction.md`,
        before: { passed: 0, total: 96, report: `${root}/transaction-cleanup-before/combined-results.json` },
        after: { passed: 96, total: 96, report: `${root}/transaction-cleanup-after/results.json` },
        scope: after.scope, baselineAccidentalCommitReproducedInDisposableSchema: true, currentRealUserHarmEstablished: false },
    verification: {
        unitTests: { passed: passes, total: tests, report: unitPath },
        mainFrontendChecks: { passed: 62, total: 62, report: 'artifacts/frontend/results.json' },
        reviewerBrowser: { passed: 48, total: 48, report: `${root}/transaction-cleanup-reviewer-browser/results.json`, scope: browser.scope },
        stagedMySQL: { passed: staged.postFixPassed, total: staged.postFixTotal, additionalBaselineProof: 1, report: `${output}/staged-mysql.json` },
        stagedModerationMySQL: { passed: 48, total: 48, report: `${output}/staged-moderation-mysql.json` },
        lint: 'Application changes, diagnostics, regression tests and deployment helpers passed.',
        whitespace: 'git diff --check passed with CRLF accounted for.',
        screenshotsReviewed: [`${root}/transaction-cleanup-reviewer-browser/chromium-1440.png`, `${root}/transaction-cleanup-reviewer-browser/webkit-390.png`]
    },
    productionChecks: {
        installedHashes: 13, protectedRegistrations: 15, pureGuardChecks: 30, services: guards.services,
        assetReport: `${output}/public-assets.json`, guardReport: `${output}/deployed-guards.json`,
        realMySQL: { passed: installed.postFixPassed, total: installed.postFixTotal, additionalBaselineProof: 1,
            report: `${output}/installed-mysql.json`, actualSQLInDisposableSchema: true, productionBusinessTablesAccessed: false },
        moderationMySQL: { passed: 48, total: 48, report: `${output}/installed-moderation-mysql.json`,
            productionApplicationTablesRead: false, productionApplicationTablesWritten: false, realOAuth: false, realEmailDelivery: false },
        fullSmokeReport: smokePath, strictPassed: smoke.filter(check => check.passed).length, total: smoke.length,
        smokeCases: smoke, residual: 'All strict smoke failures retained; actual OAuth/SMTP and never-settling ordinary operation deadlines remain unverified.'
    },
    socialPublication: { status: 'not_posted', actualPostsOrMessagesSent: false,
        handoff: 'artifacts/launch-20261008/START-HERE.md', materials: 'artifacts/launch-20261008/launch-kit.html',
        archive: 'artifacts/launch-20261008/BenchPoll-launch-kit-20261008.zip',
        verification: { passed: 33, total: 33, report: 'artifacts/launch-20261008/handoff-check.json' } }
};
if (state.release !== deployment.release) state.accountPrecisionReview = state.latestReview;
state.latestReview = latest; state.release = deployment.release; state.productionBackup = deployment.backup;
state.databaseChanged = false; state.goalStatus = 'active';
state.verification.unitTests = latest.verification.unitTests;
state.verification.mainFrontendChecks = latest.verification.mainFrontendChecks;
state.verification.productionSmoke = { ...latest.productionChecks, release: deployment.release };
state.nextReview = state.nextReview.map(item => item.startsWith('Continue nonmoderation transaction rollback')
    ? 'Review uniform end-to-end deadlines for never-settling BEGIN/COMMIT and ordinary SQL; rollback/recovery/end cleanup now passed installed-source SQL diagnostics. Real OAuth and authenticated production mutations remain unverified.' : item);
if (!state.nextReview.some(item => item.includes('inherited moderation'))) {
    state.nextReview.push('Review inherited moderation detail side-accent styling seen in verified screenshots against the user no-left-accent policy; no frontend styling changes made in this transaction release.');
}
await writeFile(`${root}/transaction-cleanup-results.json`, JSON.stringify(latest, null, 2));
await writeFile(`${root}/review-state.json`, JSON.stringify(state, null, 2));
console.log(JSON.stringify({ release: state.release, goalStatus: state.goalStatus, unit: passes,
    installedMySQL: installed.postFixPassed, installedModerationMySQL: 48,
    strictSmokePassed: latest.productionChecks.strictPassed, strictSmokeTotal: smoke.length, socialPublication: 'not_posted' }));
