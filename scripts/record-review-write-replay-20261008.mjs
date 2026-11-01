import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const root = 'artifacts/review-20261008';
const readJSON = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const state = await readJSON(`${root}/review-state.json`);
const deploymentRoot = `${root}/write-replay-deployment`;
const deployment = await readJSON(`${deploymentRoot}/deployment-result.json`);
const manifest = await readJSON(`${deploymentRoot}/manifest.json`);
const guards = await readJSON(`${deploymentRoot}/deployed-guards.json`);
const assets = await readJSON(`${deploymentRoot}/public-assets.json`);
const schemaPath = `${root}/write-replay-schema-result.json`;
const schema = await readJSON(schemaPath);
const beforePath = `${root}/write-replay-before/results.json`;
const afterPath = `${root}/write-replay-after/results.json`;
const before = await readJSON(beforePath), after = await readJSON(afterPath);
const browserPath = `${root}/write-replay-browser/results.json`;
const browser = await readJSON(browserPath);
const databaseBeforePath = `${root}/write-replay-database-before.json`;
const databaseAfterPath = `${root}/write-replay-database-after.json`;
const databaseBefore = await readJSON(databaseBeforePath), databaseAfter = await readJSON(databaseAfterPath);
const unitPath = `${root}/write-replay-unit-tests.tap`;
const unit = await readFile(unitPath, 'utf8');
const unitCount = Number(unit.match(/# pass (\d+)/)?.[1]);
const frontendPath = 'artifacts/frontend/results.json';
const frontend = await readJSON(frontendPath);
const smokePath = `${root}/write-replay-production-smoke/results.json`;
const smoke = await readJSON(smokePath);
assert.ok([manifest, guards, assets].every(item => item.release === deployment.release));
assert.equal(deployment.healthy, true);
assert.equal(deployment.files, 10);
assert.equal(schema.verified, true);
assert.equal(schema.destructiveChanges, false);
assert.equal(schema.businessRowsWritten, false);
assert.deepEqual(schema.creates, ['write_requests']);
assert.equal(before.passed, 0); assert.equal(before.total, 4);
assert.ok(before.results.every(result => result.recordCount === 2));
assert.equal(after.passed, 4); assert.equal(after.total, 4);
assert.ok(after.results.every(result => result.recordCount === 1));
assert.equal(browser.passed, 32); assert.equal(browser.total, 32);
assert.ok(browser.results.every(result => result.passed));
for (const result of [databaseBefore, databaseAfter]) {
    assert.equal(result.passed, 16); assert.equal(result.total, 16);
    assert.equal(result.actualDriverAndTransactions, true);
    assert.equal(result.productionApplicationTablesRead, false);
    assert.equal(result.productionApplicationTablesWritten, false);
    assert.ok(result.disposableSchemaCreatedAndRemoved);
}
assert.equal(databaseAfter.codeSource, '/home/ubuntu/benchpoll');
assert.match(unit, /# fail 0/);
assert.ok(unitCount >= 1066);
assert.equal(unitCount, Number(unit.match(/# tests (\d+)/)?.[1]));
assert.ok(frontend.length === 62 && frontend.every(check => check.passed));
assert.equal(smoke.length, 4);

const previousRelease = state.release === deployment.release ? state.latestReview.previousRelease : state.release;
const latest = {
    release: deployment.release, previousRelease,
    deploymentReport: `${deploymentRoot}/deployment-result.json`,
    productionBaseline: 'D:/BenchPoll-artifacts/review-20261008/write-replay-production-before',
    contextMap: `${root}/write-replay-context.md`, rolloutPlan: `${root}/write-replay-rollout.md`,
    filesDeployed: manifest.files.map(file => file.path), databaseChanged: true,
    schema: { ...schema, report: schemaPath, rollbackPolicy: 'Keep the additive table and committed replay records on code rollback; never restore an old full database over subsequent user activity.' },
    fixed: [
        { id: 'committed-contribution-response-loss-duplicates', severity: 'high',
            resolution: 'Actor plus request UUID, canonical payload hash, business data and original response are persisted in one InnoDB transaction. Retry does not create another contribution.' },
        { id: 'committed-reviewer-message-response-loss-duplicates', severity: 'high',
            resolution: 'Same transaction-scoped replay protection returns original message/audit IDs instead of inserting a second message.' },
        { id: 'browser-unresolved-write-retry-identity',
            resolution: 'Main form, inline option proposal and reviewer-message clients snapshot input and retain only the unresolved fingerprint/UUID across retry or same-tab reload. Confirmed success permits a distinct new intent.' }
    ],
    reproductionEvidence: { brief: `${root}/write-replay-reproduction.md`,
        before: { passed: before.passed, total: before.total, report: beforePath },
        after: { passed: after.passed, total: after.total, report: afterPath },
        scope: 'Actual callback/parser/owner/audit source; SQL and session fixture with discarded first response. No production business mutation.' },
    verification: {
        unitTests: { passed: unitCount, total: unitCount, report: unitPath },
        focusedReplayTests: { passed: 25, total: 25, source: 'test/write-idempotency.test.mjs' },
        mainFrontendChecks: { passed: frontend.length, total: frontend.length, report: frontendPath },
        replayBrowser: { passed: browser.passed, total: browser.total, report: browserPath,
            engines: ['chromium', 'webkit'], widths: [1440, 390], scope: browser.scope },
        realMySQLBefore: { passed: databaseBefore.passed, total: databaseBefore.total, report: databaseBeforePath },
        lint: 'All changed application modules, regression tests, deployment/schema/verification/recording helpers passed.',
        whitespace: 'git diff --check passed with CRLF accounted for.',
        screenshotsReviewed: [`${root}/write-replay-browser/chromium-1440.png`, `${root}/write-replay-browser/webkit-390.png`]
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
            concurrentReviewCallbacks: true, reviewerAuthentication: 'synthetic fixture', realOAuth: false,
            realEmailDelivery: false },
        fullSmokeReport: smokePath, strictPassed: smoke.filter(check => check.passed).length, total: smoke.length,
        smokeCases: smoke.map(({ engine, width, passed, loadMilliseconds, error, errors, failedResponses, networkFailures }) => ({
            engine, width, passed, loadMilliseconds, error, errors, failedResponses, networkFailures })),
        residual: 'Production browser smoke failures are retained, not filtered. Real OAuth, SMTP, first-load latency, other mutations and approval/apply committed-response reconciliation remain under review. Old already-open clients require updated request identities; no bypass is provided.'
    }
};
if (state.release !== deployment.release) state.moderationTransactionsReview = state.latestReview;
state.latestReview = latest;
state.release = deployment.release;
state.productionBackup = deployment.backup;
state.databaseBackup = schema.backup;
state.databaseChanged = true;
state.goalStatus = 'active';
state.verification.unitTests = latest.verification.unitTests;
state.verification.mainFrontendChecks = latest.verification.mainFrontendChecks;
state.verification.productionSmoke = { ...latest.productionChecks, release: deployment.release };
state.nextReview = state.nextReview.map(item => item.startsWith('Continue moderation review of ambiguous committed writes,')
    ? 'Continue approval/apply/escalation/source-conflict committed-response reconciliation and other transaction boundaries. Contribution/message creation now has atomic durable replay; actual installed code passed isolated MySQL concurrency/rollback/recreation tests, including two row-locked review callbacks. Real OAuth and production authenticated business changes remain unverified.' : item);
await writeFile(`${root}/write-replay-results.json`, JSON.stringify(latest, null, 2));
await writeFile(`${root}/review-state.json`, JSON.stringify(state, null, 2));
console.log(JSON.stringify({ release: state.release, goalStatus: state.goalStatus, unit: unitCount,
    replayBrowser: browser.passed, actualMySQL: databaseAfter.passed,
    strictSmokePassed: latest.productionChecks.strictPassed, strictSmokeTotal: smoke.length }));
