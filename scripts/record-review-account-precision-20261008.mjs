import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const root = 'artifacts/review-20261008';
const readJSON = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const state = await readJSON(`${root}/review-state.json`);
const deploymentRoot = `${root}/account-precision-deployment`;
const deployment = await readJSON(`${deploymentRoot}/deployment-result.json`);
const manifest = await readJSON(`${deploymentRoot}/manifest.json`);
const guards = await readJSON(`${deploymentRoot}/deployed-guards.json`);
const assets = await readJSON(`${deploymentRoot}/public-assets.json`);
const beforePath = `${root}/account-precision-before/results.json`;
const afterPath = `${root}/account-precision-after/results.json`;
const before = await readJSON(beforePath), after = await readJSON(afterPath);
const browserPath = `${root}/account-precision-browser/results.json`;
const browser = await readJSON(browserPath);
const databaseBeforePath = `${root}/account-precision-database-before.json`;
const databaseAfterPath = `${root}/account-precision-database-after.json`;
const databaseBefore = await readJSON(databaseBeforePath), databaseAfter = await readJSON(databaseAfterPath);
const preflightPath = `${root}/account-precision-preflight.json`;
const preflight = await readJSON(preflightPath);
const unitPath = `${root}/account-precision-unit-tests.tap`;
const unit = await readFile(unitPath, 'utf8');
const unitCount = Number(unit.match(/# pass (\d+)/)?.[1]);
const focusedPath = `${root}/account-precision-focused-tests.tap`;
const focused = await readFile(focusedPath, 'utf8');
const frontendPath = 'artifacts/frontend/results.json';
const frontend = await readJSON(frontendPath);
const smokePath = `${root}/account-precision-production-smoke/results.json`;
const smoke = await readJSON(smokePath);

assert.ok([manifest, guards, assets].every(item => item.release === deployment.release));
assert.equal(deployment.healthy, true); assert.equal(deployment.files, 5);
assert.equal(deployment.databaseChanged, false);
assert.equal(guards.installedHashes, 5); assert.equal(guards.protectedRegistrations, 15);
assert.equal(guards.checks.length, 30); assert.deepEqual(guards.services, ['active', 'active']);
assert.equal(before.passed, 0); assert.equal(before.total, 36);
assert.equal(after.passed, 36); assert.equal(after.total, 36);
assert.ok(after.results.every(result => result.passed));
assert.equal(browser.passed, 48); assert.equal(browser.total, 48);
assert.ok(browser.results.every(result => result.passed));
for (const result of [databaseBefore, databaseAfter]) {
    assert.equal(result.passed, 52); assert.equal(result.total, 52);
    assert.ok(result.results.every(check => check.passed));
    assert.equal(result.actualDriverAndTransactions, true);
    assert.equal(result.realSQLAuthRolesAndDecisionCallbacks, true);
    assert.equal(result.productionApplicationTablesRead, false);
    assert.equal(result.productionApplicationTablesWritten, false);
    assert.equal(result.realOAuth, false); assert.equal(result.realEmailDelivery, false);
    assert.ok(result.disposableSchemaCreatedAndRemoved);
}
assert.equal(databaseAfter.codeSource, '/home/ubuntu/benchpoll');
assert.equal(preflight.accountIDType, 'bigint unsigned');
assert.equal(preflight.accountsOutsideSafeRange, 0);
assert.equal(preflight.databaseWritten, false); assert.equal(preflight.userNamesOrEmailsRead, false);
assert.match(unit, /# fail 0/); assert.ok(unitCount >= 1156);
assert.equal(unitCount, Number(unit.match(/# tests (\d+)/)?.[1]));
assert.match(focused, /# fail 0/); assert.match(focused, /# pass 52/); assert.match(focused, /# tests 52/);
assert.ok(frontend.length === 62 && frontend.every(check => check.passed));
assert.equal(smoke.length, 4);

const previousRelease = state.release === deployment.release ? state.latestReview.previousRelease : state.release;
const latest = {
    release: deployment.release, previousRelease,
    deploymentReport: `${deploymentRoot}/deployment-result.json`,
    productionBaseline: 'D:/BenchPoll-artifacts/review-20261008/account-precision-production-before',
    contextMap: `${root}/account-precision-context.md`, rolloutPlan: `${root}/account-precision-rollout.md`,
    filesDeployed: manifest.files.map(file => file.path), databaseChanged: false,
    fixed: [
        { id: 'rounded-account-identity-permission-comparison', severity: 'high',
            resolution: 'Unsigned-BIGINT account identifiers retain exact canonical strings in active-session records and discussion ownership/self-vote checks. Invalid and already-rounded numeric actors fail before SQL.' },
        { id: 'rounded-reviewer-contributor-notification-binding',
            resolution: 'Audit snapshots, reviewer foreign keys and moderation notification recipients preserve exact account identity; safe driver scalar results retain their existing numeric types.' }
    ],
    reproductionEvidence: { brief: `${root}/account-precision-reproduction.md`,
        before: { passed: before.passed, total: before.total, report: beforePath },
        after: { passed: after.passed, total: after.total, report: afterPath },
        scope: after.scope, productionPreflight: { report: preflightPath, ...preflight },
        currentRealUserHarmEstablished: false },
    verification: {
        unitTests: { passed: unitCount, total: unitCount, report: unitPath },
        focusedAccountTests: { passed: 52, total: 52, source: 'test/account-precision.test.mjs', report: focusedPath },
        mainFrontendChecks: { passed: frontend.length, total: frontend.length, report: frontendPath },
        replayBrowser: { passed: browser.passed, total: browser.total, report: browserPath,
            engines: ['chromium', 'webkit'], widths: [1440, 390], scope: browser.scope },
        realMySQLBefore: { passed: databaseBefore.passed, total: databaseBefore.total, report: databaseBeforePath },
        lint: 'Changed modules, regression tests, deployment, diagnostic and recording helpers passed.',
        whitespace: 'git diff --check passed with CRLF accounted for.',
        screenshotsReviewed: [`${root}/account-precision-browser/chromium-1440.png`, `${root}/account-precision-browser/webkit-390.png`]
    },
    productionChecks: {
        installedHashes: guards.installedHashes, services: guards.services,
        assetReport: `${deploymentRoot}/public-assets.json`, guardReport: `${deploymentRoot}/deployed-guards.json`,
        publicAssets: assets.checks.filter(check => check.path).length,
        protectedRegistrations: guards.protectedRegistrations, pureGuardChecks: guards.checks.length,
        realMySQL: { passed: databaseAfter.passed, total: databaseAfter.total, report: databaseAfterPath,
            codeSource: databaseAfter.codeSource, actualDriverAndTransactions: true,
            disposableSchemaCreatedAndRemoved: databaseAfter.disposableSchemaCreatedAndRemoved,
            productionApplicationTablesRead: false, productionApplicationTablesWritten: false,
            reviewerAuthentication: 'synthetic fixture', realOAuth: false, realEmailDelivery: false },
        fullSmokeReport: smokePath, strictPassed: smoke.filter(check => check.passed).length, total: smoke.length,
        smokeCases: smoke.map(({ engine, width, passed, loadMilliseconds, error, errors, failedResponses, networkFailures }) => ({
            engine, width, passed, loadMilliseconds, error, errors, failedResponses, networkFailures })),
        residual: 'Every production smoke failure is retained. Actual OAuth, unconfigured SMTP, other transaction boundaries and first-load performance remain under review. This account boundary change does not resolve third-party Cloudflare analytics errors.'
    },
    socialPublication: { status: 'not_posted', handoff: 'artifacts/launch-20261008/START-HERE.md',
        materials: 'artifacts/launch-20261008/launch-kit.html',
        archive: 'artifacts/launch-20261008/BenchPoll-launch-kit-20261008.zip',
        record: 'artifacts/launch-20261008/publication-log.csv',
        actualPostsOrMessagesSent: false }
};
if (state.release !== deployment.release) state.moderationReplayReview = state.latestReview;
state.latestReview = latest;
state.release = deployment.release;
state.productionBackup = deployment.backup;
state.databaseChanged = false;
state.goalStatus = 'active';
state.verification.unitTests = latest.verification.unitTests;
state.verification.mainFrontendChecks = latest.verification.mainFrontendChecks;
state.verification.productionSmoke = { ...latest.productionChecks, release: deployment.release };
state.nextReview = state.nextReview.map(item => item.startsWith('Continue other transaction boundaries and account-ID precision.')
    ? 'Continue nonmoderation transaction rollback failure and uncertain-connection cleanup review. Exact account identity now passed installed-source MySQL checks; real OAuth and authenticated production business changes remain unverified.' : item);
await writeFile(`${root}/account-precision-results.json`, JSON.stringify(latest, null, 2));
await writeFile(`${root}/review-state.json`, JSON.stringify(state, null, 2));
console.log(JSON.stringify({ release: state.release, goalStatus: state.goalStatus, unit: unitCount,
    replayBrowser: browser.passed, actualMySQL: databaseAfter.passed,
    strictSmokePassed: latest.productionChecks.strictPassed, strictSmokeTotal: smoke.length,
    socialPublication: latest.socialPublication.status }));
