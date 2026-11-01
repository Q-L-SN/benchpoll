import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const root = 'artifacts/review-20261008';
const output = `${root}/db-deadlines-deployment`;
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const uiPath = process.argv.find(value => value.startsWith('--ui-report='))?.slice('--ui-report='.length)
    ?? `${root}/moderation-style-residual-after-results.json`;
if (process.argv.includes('--preflight')) {
    const baseline = await json(`${output}/production-before.json`);
    const ui = await json(uiPath);
    const hashes = [], diffs = [];
    assert.equal(baseline.hashes.length, 6);
    for (const file of baseline.hashes) {
        const path = resolve(file.path), old = join(baseline.baseline, file.path);
        if (file.hash !== null) {
            assert.equal(createHash('sha256').update(await readFile(old)).digest('hex'), file.hash);
        } else assert.equal(file.path, 'db-deadlines.js');
        hashes.push({ path: file.path, before: file.hash,
            after: createHash('sha256').update(await readFile(path)).digest('hex') });
        if (/\.m?js$/.test(path)) execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
        const args = ['diff', '--no-index', '--ignore-space-at-eol', '--no-ext-diff', '--',
            file.hash === null ? '/dev/null' : old, path];
        try { diffs.push(execFileSync('git', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })); }
        catch (error) { if (error.status !== 1) throw error; diffs.push(String(error.stdout)); }
    }
    assert.equal(ui.passed, 6); assert.equal(ui.total, 6);
    assert.equal(hashes.find(file => file.path === 'public/css/censor.css').after, ui.cssHash);
    assert.equal(hashes.find(file => file.path === 'public/js/censor.js').after, ui.clientHash);
    await writeFile(`${output}/installed-baseline.diff`, diffs.join('\n'));
    await writeFile(`${output}/preflight.json`, JSON.stringify({ hashes, uiReport: uiPath,
        originalBaselinePreserved: true, syntaxPassed: true, databaseChanged: false }, null, 2));
    console.log(JSON.stringify({ preflightPassed: true, files: hashes.length, uiCases: ui.passed }));
    process.exit(0);
}
const state = await json(`${root}/review-state.json`);
const manifest = await json(`${output}/manifest.json`);
const deployment = await json(`${output}/deployment-result.json`);
const guards = await json(`${output}/deployed-guards.json`);
const assets = await json(`${output}/public-assets.json`);
const before = await json(`${root}/db-deadline-before.json`);
const after = await json(`${root}/db-deadline-after.json`);
const staged = await json(`${output}/staged-mysql.json`);
const installed = await json(`${output}/installed-mysql.json`);
const frontendPath = `${root}/db-deadline-frontend-results.json`;
const frontend = await json(frontendPath);
const browserPath = `${root}/db-deadline-reviewer-browser/results.json`;
const browser = await json(browserPath);
const ui = await json(uiPath);
const unitPath = `${root}/db-deadline-unit-tests.tap`;
const unit = await readFile(unitPath, 'utf8');
const tests = Number(unit.match(/# tests (\d+)/)?.[1]);
const passes = Number(unit.match(/# pass (\d+)/)?.[1]);
const smokePath = `${root}/db-deadline-production-smoke/results.json`;
const settledPath = `${root}/db-deadline-production-settled-smoke/results.json`;
const smoke = await json(smokePath), settled = await json(settledPath);
const cloudflare = await json(`${root}/cloudflare-residual-investigation.json`);
const launchCheck = await json('artifacts/launch-20261008/handoff-check.json');

assert.ok([manifest, guards, assets].every(item => item.release === deployment.release));
assert.equal(deployment.healthy, true);
assert.equal(deployment.files, 6);
assert.equal(deployment.databaseChanged, false);
assert.equal(guards.installedHashes, 6);
assert.equal(guards.protectedRegistrations, 15);
assert.equal(guards.checks.length, 30);
assert.deepEqual(guards.services, ['active', 'active']);
assert.equal(before.bounded, 0); assert.equal(before.total, 14);
assert.equal(after.bounded, 14); assert.equal(after.total, 14);
assert.ok(after.results.every(result => result.settled && result.status === 503));
assert.ok(tests >= 1362); assert.equal(passes, tests);
assert.match(unit, /# fail 0/); assert.match(unit, /# skipped 0/);
assert.equal(frontend.length, 62); assert.ok(frontend.every(result => result.passed));
assert.equal(browser.passed, 48); assert.equal(browser.total, 48);
assert.ok(browser.results.every(result => result.passed));
for (const result of [staged, installed]) {
    assert.equal(result.passed, 24); assert.equal(result.total, 24);
    assert.equal(result.actualDriverAndSQL, true);
    assert.equal(result.productionBusinessTablesAccessed, false);
    assert.equal(result.realOAuth, false); assert.equal(result.realEmailDelivery, false);
    assert.ok(result.disposableSchemaCreatedAndRemoved);
    assert.ok(result.results.every(check => check.passed));
}
assert.equal(installed.applicationSource, '/home/ubuntu/benchpoll');
assert.equal(installed.release, deployment.release);
assert.equal(ui.passed, 6); assert.equal(ui.total, 6);
assert.equal(ui.originalEvidenceUnchanged, true); assert.equal(ui.sharedPolicyUnchanged, true);
assert.ok(ui.results.every(result => result.passed && result.lifecycle.passed));
for (const [path, hash] of [['public/css/censor.css', ui.cssHash], ['public/js/censor.js', ui.clientHash]]) {
    assert.equal(manifest.files.find(file => file.path === path)?.after, hash, `UI evidence must match deployed ${path}`);
}
for (const file of manifest.files) {
    assert.equal(createHash('sha256').update(await readFile(file.path)).digest('hex'), file.after,
        `Working-tree source must still match release: ${file.path}`);
}
assert.equal(smoke.length, 4); assert.equal(settled.length, 4);
assert.ok(smoke.every(result => result.mode === 'immediate-navigation'));
assert.ok(settled.every(result => result.mode === 'settled-telemetry'));
for (const result of smoke.filter(check => !check.passed)) {
    assert.equal(result.engine, 'webkit');
    assert.ok(result.errors?.length > 0, 'A new non-telemetry smoke failure needs review before finalizing');
    assert.ok(result.errors.every(error => error.stack.includes('/cdn-cgi/rum? due to access control checks.')
        && error.stack.includes('static.cloudflareinsights.com/beacon.min.js')));
    assert.deepEqual(result.failedResponses, []);
}
assert.ok(settled.every(result => result.passed), 'Separate settled smoke must pass without filtering errors');
assert.equal(createHash('sha256').update(await readFile(cloudflare.originalSmokeIntegrity.path)).digest('hex'),
    cloudflare.originalSmokeIntegrity.sha256, 'Original strict failures must remain unchanged');
assert.equal(launchCheck.passed, 33); assert.equal(launchCheck.total, 33);

const previousRelease = state.release === deployment.release ? state.latestReview.previousRelease : state.release;
const latest = {
    release: deployment.release, previousRelease, filesDeployed: manifest.files.map(file => file.path), databaseChanged: false,
    contextMap: `${root}/db-deadline-context.md`, rolloutPlan: `${root}/db-deadline-rollout.md`,
    deploymentReport: `${output}/deployment-result.json`, productionBaseline: 'D:/BenchPoll-artifacts/review-20261008/db-deadlines-production-before',
    installedBaselineDiff: `${output}/installed-baseline.diff`,
    fixed: [
        { id: 'unbounded-database-acquire-query-begin-commit', severity: 'high',
            resolution: 'Bound individual waits and queue pressure. Timed-out acquisitions never issue late business SQL. Uncertain operations discard owned leases and return safe 503 without automatic SQL retries.' },
        { id: 'late-old-lease-damages-next-borrower',
            resolution: 'Closed wrappers cannot enqueue work, release or destroy a transferred native connection. Pending operations are discarded rather than returned to the pool.' },
        { id: 'moderation-left-accent-policy',
            resolution: 'Remove the unilateral decorative field stripe while retaining permitted dividers and existing complete unread-message emphasis.' },
        { id: 'moderation-webkit-select-keyboard-focus',
            resolution: 'Provide a restrained internal keyboard-focus indicator without an external input frame.' },
        { id: 'moderation-async-message-count-clips-active-tab',
            resolution: 'Reveal the active tab inside its own scroller when count text changes; preserve inactive-view scrolling, stale-response ordering and document position.' }
    ],
    reproductionEvidence: { brief: `${root}/db-deadline-reproduction.md`,
        before: { bounded: 0, total: 14, report: `${root}/db-deadline-before.json` },
        after: { bounded: 14, total: 14, report: `${root}/db-deadline-after.json` },
        scope: after.scope, currentRealUserHarmEstablished: false },
    verification: {
        unitTests: { passed: passes, total: tests, report: unitPath },
        mainFrontendChecks: { passed: 62, total: 62, report: frontendPath },
        reviewerBrowser: { passed: 48, total: 48, report: browserPath, scope: browser.scope },
        moderationResponsiveUI: { passed: 6, total: 6, report: uiPath, scope: ui.scope },
        stagedMySQL: { passed: 24, total: 24, report: `${output}/staged-mysql.json`, productionBusinessTablesAccessed: false },
        lint: 'Application changes, diagnostics, regression tests, recording and deployment helpers passed.',
        whitespace: 'git diff --check passed with CRLF accounted for.'
    },
    productionChecks: {
        installedHashes: 6, protectedRegistrations: 15, pureGuardChecks: 30, services: guards.services,
        assetReport: `${output}/public-assets.json`, guardReport: `${output}/deployed-guards.json`,
        realMySQL: { passed: 24, total: 24, report: `${output}/installed-mysql.json`, productionBusinessTablesAccessed: false },
        fullSmokeReport: smokePath, strictPassed: smoke.filter(check => check.passed).length, total: smoke.length, smokeCases: smoke,
        separateSettledTelemetrySmoke: { passed: settled.filter(check => check.passed).length,
            total: settled.length, report: settledPath, cases: settled },
        initialWorkspaceLoadSamples: [...smoke, ...settled].filter(check => Number.isFinite(check.loadMilliseconds))
            .map(check => ({ engine: check.engine, width: check.width, mode: check.mode,
                milliseconds: check.loadMilliseconds })),
        performanceScope: 'Uncontrolled public-network smoke samples, including concurrent browser checks; not a ranking-computation benchmark or latency guarantee.',
        residual: 'Strict rapid-navigation failures are retained. A separate telemetry-completion test does not resolve them. Whole HTTP/CPU deadlines, physical Safari, OAuth and email delivery are not certified.'
    },
    cloudflareInvestigation: { report: `${root}/cloudflare-residual-investigation.md`,
        rawReport: `${root}/cloudflare-residual-investigation.json`, originalStrictSmokeUnchanged: true,
        productionConfigurationChanged: false, exactWebKitInternalCauseProven: false },
    socialPublication: { status: 'not_posted', actualPostsOrMessagesSent: false,
        handoff: 'artifacts/launch-20261008/START-HERE.md', materials: 'artifacts/launch-20261008/launch-kit.html',
        archive: 'artifacts/launch-20261008/BenchPoll-launch-kit-20261008.zip',
        verification: { passed: 33, total: 33, report: 'artifacts/launch-20261008/handoff-check.json' } }
};
if (state.release !== deployment.release) state.transactionCleanupReview = state.latestReview;
state.latestReview = latest; state.release = deployment.release; state.productionBackup = deployment.backup;
state.databaseChanged = false; state.goalStatus = 'active';
state.verification.unitTests = latest.verification.unitTests;
state.verification.mainFrontendChecks = latest.verification.mainFrontendChecks;
state.verification.productionSmoke = { ...latest.productionChecks, release: deployment.release };
state.nextReview = state.nextReview.filter(item => !item.includes('inherited moderation detail side-accent'))
    .map(item => item.startsWith('Review uniform end-to-end deadlines')
        ? 'Review whole HTTP request and CPU-computation deadlines. Individual acquire/SQL/BEGIN/COMMIT waits are bounded and verified against installed source; real OAuth and authenticated production mutations remain unverified.' : item);
state.nextReview = state.nextReview.map(item => item.startsWith('Profile first workspace startup')
    ? 'Profile first workspace startup and distinguish module/network latency from ranking computation. Latest public-network smoke includes slow and variable fresh loads; individual DB deadlines do not establish a startup latency improvement.' : item);
await writeFile(`${root}/db-deadline-results.json`, JSON.stringify(latest, null, 2));
await writeFile(`${root}/review-state.json`, JSON.stringify(state, null, 2));
console.log(JSON.stringify({ release: state.release, goalStatus: state.goalStatus, unit: passes,
    installedMySQL: 24, strictSmokePassed: latest.productionChecks.strictPassed, strictSmokeTotal: smoke.length,
    separateSettledSmokePassed: latest.productionChecks.separateSettledTelemetrySmoke.passed, socialPublication: 'not_posted' }));
