import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const root = 'artifacts/review-20261008';
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const report = async name => {
    const path = `${root}/${name}/results.json`;
    const data = await readJSON(path);
    assert.equal(data.passed, data.total, path);
    return { passed: data.passed, total: data.total, report: path };
};
const state = await readJSON(`${root}/review-state.json`);
const deployment = await readJSON(`${root}/moderation-intent-deployment/deployment-result.json`);
const guards = await readJSON(`${root}/moderation-intent-deployment/deployed-guards.json`);
const assets = await readJSON(`${root}/moderation-intent-deployment/public-assets.json`);
assert.equal(deployment.release, guards.release);
assert.equal(deployment.release, assets.release);
assert.equal(deployment.healthy, true);
const unitPath = `${root}/moderation-intent-unit-tests.tap`;
const unit = await readFile(unitPath, 'utf8');
assert.match(unit, /# fail 0/);
const count = Number(unit.match(/# pass (\d+)/)?.[1]);
assert.equal(count, Number(unit.match(/# tests (\d+)/)?.[1]));
const frontend = await readJSON('artifacts/frontend/results.json');
assert.ok(frontend.every(check => check.passed));
const smokePath = `${root}/moderation-intent-production-smoke/results.json`;
const smoke = await readJSON(smokePath);
const previousRelease = state.release;
const latest = {
    release: deployment.release, previousRelease,
    deploymentReport: `${root}/moderation-intent-deployment/deployment-result.json`,
    productionBaseline: 'D:/BenchPoll-artifacts/review-20261008/moderation-intent-production-before',
    rolloutPlan: `${root}/moderation-intent-rollout.md`,
    contextMap: `${root}/moderation-intent-context.md`,
    filesDeployed: ['public/js/censor.js', 'private/censor.html'], databaseChanged: false,
    fixed: [
        { id: 'stale-moderation-sql-preview', resolution: 'Only the current preview, editor session and unchanged draft revision may publish SQL or its token; stale failures cannot interrupt a newer successful preview.' },
        { id: 'moderation-write-closes-new-draft', resolution: 'Capture request ID/token/body and overlay session. Earlier apply, escalation and message completion cannot close or overwrite a later draft. A new window restores its submit control; old finally handlers cannot enable a newer pending submission.' },
        { id: 'stale-reviewer-message-refresh', resolution: 'Latest message-list request wins, including error responses.' },
        { id: 'message-read-restores-old-list', resolution: 'Mark-read callbacks cannot render a list from an older refresh.' },
        { id: 'stale-reviewer-record-audit-detail', resolution: 'Latest detail selection wins; changing view, entity or list filters retires pending detail requests and their alerts.' },
        { id: 'stale-reviewer-queue-refresh', resolution: 'Only the latest queue refresh updates entries, errors or status-control enabled state.' }
    ],
    reproductionEvidence: {
        brief: `${root}/moderation-intent-reproduction.md`,
        browserBefore: { passed: 0, total: 96, report: `${root}/moderation-intent-before/results.json` },
        queueBefore: { passed: 0, total: 8, report: `${root}/moderation-queue-intent-before/results.json` },
        scope: 'Synthetic isolated data. Each scenario repeated twice per Chromium/WebKit and 1440px/390px. Queue reproduction uses captured production client in a local fixture. No real reviewer SQL or production messages.'
    },
    verification: {
        unitTests: { passed: count, total: count, report: unitPath },
        mainFrontendChecks: { passed: frontend.length, total: frontend.length, report: 'artifacts/frontend/results.json' },
        moderationIntent: await report('moderation-intent-after'),
        queueIntent: await report('moderation-queue-intent-after'),
        moderationNormal: await report('moderation-intent-normal'),
        moderationAccountSwitch: await report('moderation-intent-account'),
        moderationHTTPFailureRecovery: await report('moderation-intent-http'),
        moderationNetworkFailureRecovery: await report('moderation-intent-network'),
        lint: 'Modified application module, regression/rollout/verification helpers and source contracts passed.',
        screenshotsReviewed: [`${root}/moderation-intent-after/webkit-390-message-reopen.png`, `${root}/moderation-intent-after/chromium-1440-preview-order.png`]
    },
    productionChecks: {
        installedHashes: guards.installedHashes, services: guards.services,
        assetReport: `${root}/moderation-intent-deployment/public-assets.json`,
        guardReport: `${root}/moderation-intent-deployment/deployed-guards.json`,
        protectedRegistrations: guards.protectedRegistrations, pureGuardChecks: guards.checks.length,
        productionHandlersExecuted: false, databaseAccess: false,
        fullSmokeReport: smokePath, strictPassed: smoke.filter(check => check.passed).length, total: smoke.length,
        smokeCases: smoke.map(({ engine, width, passed, loadMilliseconds, errors, failedResponses }) => ({
            engine, width, passed, loadMilliseconds, errors, failedResponses })),
        residual: 'Synthetic fixtures do not certify real OAuth, authenticated production moderation, ambiguous committed-write idempotency or SMTP delivery. First-load latency remains variable. Prior Cloudflare analytics cancellation errors are tracked, not suppressed or claimed fixed.'
    }
};
state.moderationPaginationReview = state.latestReview;
state.latestReview = latest;
state.release = deployment.release;
state.productionBackup = deployment.backup;
state.goalStatus = 'active';
state.verification.unitTests = latest.verification.unitTests;
state.verification.mainFrontendChecks = latest.verification.mainFrontendChecks;
state.verification.productionSmoke = { ...latest.productionChecks, release: deployment.release };
state.nextReview = state.nextReview.map(item => item.startsWith('Review reviewer request-intent races:')
    ? 'Continue moderation review of ambiguous committed writes, idempotency and concurrent database decisions. SQL preview/session, queue/list/detail ordering have repeated local coverage; real GitHub OAuth and authenticated production changes remain unverified.' : item);
await writeFile(`${root}/moderation-intent-results.json`, JSON.stringify(latest, null, 2));
await writeFile(`${root}/review-state.json`, JSON.stringify(state, null, 2));
console.log(JSON.stringify({ release: state.release, goalStatus: state.goalStatus,
    unit: count, browserCases: 104 + 4 * 72, strictSmokePassed: latest.productionChecks.strictPassed, strictSmokeTotal: smoke.length }));
