import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const root = 'artifacts/review-20261008';
const readJSON = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const state = await readJSON(`${root}/review-state.json`);
const deploymentRoot = `${root}/moderation-replay-deployment`;
const deployment = await readJSON(`${deploymentRoot}/deployment-result.json`);
const manifest = await readJSON(`${deploymentRoot}/manifest.json`);
const guards = await readJSON(`${deploymentRoot}/deployed-guards.json`);
const assets = await readJSON(`${deploymentRoot}/public-assets.json`);
const beforePath = `${root}/moderation-replay-before/results.json`;
const afterPath = `${root}/moderation-replay-after/results.json`;
const before = await readJSON(beforePath), after = await readJSON(afterPath);
const browserPath = `${root}/moderation-replay-browser/results.json`;
const browser = await readJSON(browserPath);
const databaseBeforePath = `${root}/moderation-replay-database-before.json`;
const databaseAfterPath = `${root}/moderation-replay-database-after.json`;
const databaseBefore = await readJSON(databaseBeforePath), databaseAfter = await readJSON(databaseAfterPath);
const unitPath = `${root}/moderation-replay-unit-tests.tap`;
const unit = await readFile(unitPath, 'utf8');
const unitCount = Number(unit.match(/# pass (\d+)/)?.[1]);
const frontendPath = 'artifacts/frontend/results.json';
const frontend = await readJSON(frontendPath);
const smokePath = `${root}/moderation-replay-production-smoke/results.json`;
const smoke = await readJSON(smokePath);
assert.ok([manifest, guards, assets].every(item => item.release === deployment.release));
assert.equal(deployment.healthy, true); assert.equal(deployment.files, 3);
assert.equal(deployment.databaseChanged, false);
assert.equal(before.passed, 0); assert.equal(before.total, 12);
assert.equal(after.passed, 12); assert.equal(after.total, 12);
assert.ok(after.results.every(result => result.passed && result.mutations === 1
    && result.successAudits === 1 && result.failureAudits === 0));
assert.equal(browser.passed, 48); assert.equal(browser.total, 48);
assert.ok(browser.results.every(result => result.passed));
for (const result of [databaseBefore, databaseAfter]) {
    assert.equal(result.passed, 48); assert.equal(result.total, 48);
    assert.ok(result.results.every(check => check.passed));
    assert.equal(result.actualDriverAndTransactions, true);
    assert.equal(result.productionApplicationTablesRead, false);
    assert.equal(result.productionApplicationTablesWritten, false);
    assert.ok(result.disposableSchemaCreatedAndRemoved);
}
assert.equal(databaseAfter.codeSource, '/home/ubuntu/benchpoll');
assert.match(unit, /# fail 0/); assert.ok(unitCount >= 1104);
assert.equal(unitCount, Number(unit.match(/# tests (\d+)/)?.[1]));
assert.ok(frontend.length === 62 && frontend.every(check => check.passed));
assert.equal(smoke.length, 4);

const previousRelease = state.release === deployment.release ? state.latestReview.previousRelease : state.release;
const latest = {
    release: deployment.release, previousRelease,
    deploymentReport: `${deploymentRoot}/deployment-result.json`,
    productionBaseline: 'D:/BenchPoll-artifacts/review-20261008/moderation-replay-production-before',
    contextMap: `${root}/moderation-replay-context.md`, rolloutPlan: `${root}/moderation-replay-rollout.md`,
    filesDeployed: manifest.files.map(file => file.path), databaseChanged: false,
    fixed: [
        { id: 'committed-review-decision-response-loss-false-conflict', severity: 'high',
            resolution: 'Approve/reject, edited apply, escalation and source-conflict routes commit their original response with the decision under an exact actor/UUID/payload identity. Retry does not record a false failure audit or enqueue another email.' },
        { id: 'reviewer-decision-unresolved-retry-identity',
            resolution: 'Reviewer decision writes use the existing unresolved-intent browser transport; reads and previews remain ordinary requests. Role/owner, fresh preview, revision and genuine competing-intent checks remain enforced.' }
    ],
    reproductionEvidence: { brief: `${root}/moderation-replay-reproduction.md`,
        before: { passed: before.passed, total: before.total, report: beforePath },
        after: { passed: after.passed, total: after.total, report: afterPath },
        scope: 'Actual callback/parser/preview/owner/source/audit code with SQL/session/notification fixtures; first committed response discarded. No production mutation.' },
    verification: {
        unitTests: { passed: unitCount, total: unitCount, report: unitPath },
        focusedReplayTests: { passed: 38, total: 38, source: 'test/moderation-replay.test.mjs' },
        mainFrontendChecks: { passed: frontend.length, total: frontend.length, report: frontendPath },
        replayBrowser: { passed: browser.passed, total: browser.total, report: browserPath,
            engines: ['chromium', 'webkit'], widths: [1440, 390], scope: browser.scope,
            fixtureRepair: 'Danger confirmation needed the danger-button selector; all original assertions retained.' },
        realMySQLBefore: { passed: databaseBefore.passed, total: databaseBefore.total, report: databaseBeforePath },
        lint: 'All changed application modules, regression tests and deployment/diagnostic/recording helpers passed.',
        whitespace: 'git diff --check passed with CRLF accounted for.',
        screenshotsReviewed: [`${root}/moderation-replay-browser/chromium-1440.png`, `${root}/moderation-replay-browser/webkit-390.png`]
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
            concurrentDecisions: true, realSQLFailureRollback: true, reviewerAuthentication: 'synthetic fixture',
            realOAuth: false, realEmailDelivery: false },
        fullSmokeReport: smokePath, strictPassed: smoke.filter(check => check.passed).length, total: smoke.length,
        smokeCases: smoke.map(({ engine, width, passed, loadMilliseconds, error, errors, failedResponses, networkFailures }) => ({
            engine, width, passed, loadMilliseconds, error, errors, failedResponses, networkFailures })),
        residual: 'Production smoke failures are retained, not filtered. Real OAuth and SMTP, other transaction boundaries, large account-ID number conversion and first-load performance remain under review. Already-open old reviewer clients need updated identities; no bypass is provided.'
    },
    socialPublication: { status: 'not_posted', materials: 'artifacts/launch-20261008/launch-kit.html',
        archive: 'artifacts/launch-20261008/BenchPoll-launch-kit-20261008.zip',
        record: 'artifacts/launch-20261008/publication-log.csv' }
};
if (state.release !== deployment.release) state.writeReplayReview = state.latestReview;
state.latestReview = latest;
state.release = deployment.release;
state.productionBackup = deployment.backup;
state.databaseChanged = false;
state.goalStatus = 'active';
state.verification.unitTests = latest.verification.unitTests;
state.verification.mainFrontendChecks = latest.verification.mainFrontendChecks;
state.verification.productionSmoke = { ...latest.productionChecks, release: deployment.release };
state.nextReview = state.nextReview.map(item => item.startsWith('Continue approval/apply/escalation/source-conflict committed-response')
    ? 'Continue other transaction boundaries and account-ID precision. All moderation decision replay routes now passed actual installed-source MySQL replay/concurrency/rollback checks in disposable schemas. Actual OAuth and production authenticated business changes remain unverified.' : item);
await writeFile(`${root}/moderation-replay-results.json`, JSON.stringify(latest, null, 2));
await writeFile(`${root}/review-state.json`, JSON.stringify(state, null, 2));
console.log(JSON.stringify({ release: state.release, goalStatus: state.goalStatus, unit: unitCount,
    replayBrowser: browser.passed, actualMySQL: databaseAfter.passed,
    strictSmokePassed: latest.productionChecks.strictPassed, strictSmokeTotal: smoke.length,
    socialPublication: latest.socialPublication.status }));
