import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const root = 'artifacts/review-20261008';
const readJSON = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const state = await readJSON(`${root}/review-state.json`);
const deploymentRoot = `${root}/moderation-transactions-deployment`;
const deployment = await readJSON(`${deploymentRoot}/deployment-result.json`);
const guards = await readJSON(`${deploymentRoot}/deployed-guards.json`);
const assets = await readJSON(`${deploymentRoot}/public-assets.json`);
const beforePath = `${root}/moderation-transactions-before/results.json`;
const afterPath = `${root}/moderation-transactions-after/results.json`;
const before = await readJSON(beforePath);
const after = await readJSON(afterPath);
const probePath = `${root}/moderation-transactions-database-probe.json`;
const probe = await readJSON(probePath);
const unitPath = `${root}/moderation-transactions-unit-tests.tap`;
const unit = await readFile(unitPath, 'utf8');
const unitCount = Number(unit.match(/# pass (\d+)/)?.[1]);
const frontendPath = 'artifacts/frontend/results.json';
const frontend = await readJSON(frontendPath);
const smokePath = `${root}/moderation-transactions-production-smoke/results.json`;
const smoke = await readJSON(smokePath);
assert.equal(deployment.release, guards.release);
assert.equal(deployment.release, assets.release);
assert.equal(deployment.healthy, true);
assert.equal(deployment.databaseChanged, false);
assert.equal(deployment.files, 1);
assert.equal(before.passed, 0);
assert.equal(before.total, 10);
assert.ok(before.results.every(result => result.completed === 0 && result.pendingBorrows === 10 && result.retainedLeases === 10));
assert.equal(after.passed, 10);
assert.equal(after.total, 10);
assert.ok(after.results.every(result => result.completed === 10 && result.pendingBorrows === 0 && result.retainedLeases === 0 && result.auditRows === 10));
assert.equal(probe.passed, 4);
assert.equal(probe.total, 4);
assert.equal(probe.permanentApplicationTablesRead, false);
assert.equal(probe.permanentApplicationTablesWritten, false);
assert.match(unit, /# fail 0/);
assert.ok(unitCount >= 1041);
assert.equal(unitCount, Number(unit.match(/# tests (\d+)/)?.[1]));
assert.ok(frontend.length === 62 && frontend.every(check => check.passed));
assert.equal(smoke.length, 4);

const previousRelease = state.release === deployment.release
    ? state.latestReview.previousRelease : state.release;
const latest = {
    release: deployment.release, previousRelease,
    deploymentReport: `${deploymentRoot}/deployment-result.json`,
    productionBaseline: 'D:/BenchPoll-artifacts/review-20261008/moderation-transactions-production-before',
    rolloutPlan: `${root}/moderation-transactions-rollout.md`,
    contextMap: `${root}/moderation-transactions-context.md`,
    filesDeployed: ['server.js'], databaseChanged: false,
    fixed: [
        { id: 'moderation-failure-audit-pool-starvation', severity: 'high',
            resolution: 'Five failing write paths reuse their successfully rolled-back caller-owned connection for independent failure auditing instead of borrowing a second connection while retaining the first.' },
        { id: 'moderation-rollback-uncertain-lease',
            resolution: 'Destroy a connection whose rollback fails; do not start another transaction on uncertain business work. Keep the original operation error.' },
        { id: 'score-sync-advisory-cleanup-masks-error',
            resolution: 'Catch advisory-lock cleanup failure, destroy the lease and retain the original resolution result/error.' }
    ],
    reproductionEvidence: {
        brief: `${root}/moderation-transactions-reproduction.md`,
        before: { passed: before.passed, total: before.total, report: beforePath },
        after: { passed: after.passed, total: after.total, report: afterPath },
        requestsPerScenario: 10, repetitionsPerRoute: 2,
        scope: 'Actual server route callback/helper source and real SQL audit recorder. Bounded pool leases and SQL responses are simulated; no production business handlers or records are mutated.'
    },
    verification: {
        unitTests: { passed: unitCount, total: unitCount, report: unitPath },
        focusedTransactionTests: { passed: 21, total: 21, source: 'test/moderation-transactions.test.mjs' },
        mainFrontendChecks: { passed: frontend.length, total: frontend.length, report: frontendPath },
        lint: 'Changed server, regression tests, deployment and verification helpers and temporary database diagnostic passed.',
        whitespaceCheck: 'git diff --check passed; existing CRLF conversion warnings were not application failures.'
    },
    productionChecks: {
        installedHashes: guards.installedHashes, services: guards.services,
        assetReport: `${deploymentRoot}/public-assets.json`,
        guardReport: `${deploymentRoot}/deployed-guards.json`,
        protectedRegistrations: guards.protectedRegistrations, pureGuardChecks: guards.checks.length,
        pureGuardsDatabaseAccess: false,
        databaseProbe: { passed: probe.passed, total: probe.total, report: probePath,
            helperSource: probe.helperSource, actualDriverAndTransactions: true,
            privatePoolLimit: 1, temporaryTablesOnly: true,
            permanentApplicationTablesRead: false, permanentApplicationTablesWritten: false,
            realModerationHandlersInvoked: false },
        fullSmokeReport: smokePath, strictPassed: smoke.filter(check => check.passed).length, total: smoke.length,
        smokeCases: smoke.map(({ engine, width, passed, loadMilliseconds, errors, failedResponses }) => ({
            engine, width, passed, loadMilliseconds, errors, failedResponses })),
        residual: 'Temporary InnoDB tests verify installed helper commit/rollback boundaries, not real moderation business SQL, concurrent row locks, OAuth or SMTP. Committed-write replay and first-load performance remain under review. Cloudflare analytics errors are retained when observed, not filtered.'
    }
};
if (state.release !== deployment.release) state.moderationIntentReview = state.latestReview;
state.latestReview = latest;
state.release = deployment.release;
state.productionBackup = deployment.backup;
state.goalStatus = 'active';
state.verification.unitTests = latest.verification.unitTests;
state.verification.mainFrontendChecks = latest.verification.mainFrontendChecks;
state.verification.productionSmoke = { ...latest.productionChecks, release: deployment.release };
state.nextReview = state.nextReview.map(item => item.startsWith('Continue moderation review of ambiguous committed writes,')
    ? 'Continue moderation review of ambiguous committed writes, idempotency and concurrent row-lock decisions. Failure-audit pool starvation, unsafe rollback reuse and source-lock cleanup masking are fixed; installed helper transaction boundaries passed temporary-table tests. Real OAuth, authenticated business changes and replay recovery remain unverified.' : item);
await writeFile(`${root}/moderation-transactions-results.json`, JSON.stringify(latest, null, 2));
await writeFile(`${root}/review-state.json`, JSON.stringify(state, null, 2));
console.log(JSON.stringify({ release: state.release, goalStatus: state.goalStatus, unit: unitCount,
    saturatedPoolCases: after.passed, actualTransactionCases: probe.passed,
    strictSmokePassed: latest.productionChecks.strictPassed, strictSmokeTotal: smoke.length }));
