import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = 'artifacts/review-20261008';
const output = `${root}/startup-deployment`;
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const state = await json(`${root}/review-state.json`);
const manifest = await json(`${output}/manifest.json`);
const deployment = await json(`${output}/deployment-result.json`);
const guards = await json(`${output}/installed-guards.json`);
const baseline = await json(`${output}/production-before.json`);
const applied = await json(`${root}/startup-server-applied-results.json`);
const discovery = await json(`${root}/startup-discovery-direct/results.json`);
const frontend = await json(`${output}/frontend-results.json`);
const unitPath = `${root}/startup-unit-final.tap`;
const unit = await readFile(unitPath, 'utf8');
const strictPath = `${root}/startup-production-smoke/results.json`;
const settledPath = `${root}/startup-production-settled-smoke/results.json`;
const strict = await json(strictPath), settled = await json(settledPath);
const timingBefore = await json(`${root}/startup-timing-before/results.json`);
const timingAfter = await json(`${root}/startup-timing-after/results.json`);
const originBefore = await json(`${root}/startup-origin-before.json`);
const originAfter = await json(`${root}/startup-origin-after.json`);
const publicAB = await json(`${root}/startup-public-ab/results.json`);
const handoff = await json('artifacts/launch-20261008/handoff-check.json');

assert.equal(deployment.healthy, true);
assert.equal(deployment.databaseChanged, false);
assert.equal(deployment.files, 3);
assert.ok([manifest, guards, timingAfter].every(item => item.release === deployment.release));
assert.equal(guards.installedHashes, 3); assert.equal(guards.protectedHashes, 20);
assert.equal(guards.protectedRegistrations, 26);
assert.equal(guards.checks.length, 6);
assert.ok(guards.checks.every(check => check.matchedAccepted && check.foreignRejected));
assert.deepEqual(guards.services, ['active', 'active']);
assert.equal(guards.databaseAccess, false);
assert.equal(applied.result, 'pass'); assert.equal(applied.repetitions, 2);
for (const source of applied.sources) assert.equal(source.currentSHA256, await sha(source.file));
for (const file of manifest.files) {
    assert.equal(await sha(file.path), file.after);
    assert.equal(await sha(`${baseline.baseline}/${file.path}`), file.before);
}
assert.match(unit, /# tests 1372/); assert.match(unit, /# pass 1372/);
assert.match(unit, /# fail 0/); assert.match(unit, /# skipped 0/); assert.match(unit, /# cancelled 0/);
assert.equal(frontend.length, 62); assert.ok(frontend.every(check => check.passed));
assert.equal(discovery.results.length, 16); assert.ok(discovery.results.every(check => check.passed));
for (const result of discovery.results.filter(check => check.variant === 'after')) {
    assert.equal(result.htmlHash, await sha('private/home.html'));
    assert.equal(result.moduleRequests, 69); assert.equal(result.workspaceRequests, 1);
}
assert.equal(publicAB.results.length, 4); assert.ok(publicAB.results.every(check => check.passed));
for (const result of publicAB.results.filter(check => check.variant === 'after')) {
    assert.equal(result.htmlHash, await sha('private/home.html'));
}
assert.equal(strict.length, 4); assert.equal(settled.length, 4);
assert.ok(strict.every(check => check.mode === 'immediate-navigation'));
assert.ok(settled.every(check => check.mode === 'settled-telemetry'));
for (const result of strict.filter(check => !check.passed)) {
    assert.equal(result.engine, 'webkit');
    assert.ok(result.errors?.length > 0, 'A new application failure needs review before recording this release');
    assert.ok(result.errors.every(error => error.stack.includes('/cdn-cgi/rum? due to access control checks.')
        && error.stack.includes('static.cloudflareinsights.com/beacon.min.js')));
    assert.deepEqual(result.failedResponses, []);
}
assert.ok(settled.every(check => check.passed), 'Settled smoke must pass without filtering page errors');
assert.equal(timingBefore.results.length, 8); assert.equal(timingAfter.results.length, 8);
assert.ok(timingBefore.results.every(check => check.passed));
assert.ok(timingAfter.results.every(check => check.passed));
assert.equal(handoff.passed, 33); assert.equal(handoff.total, 33);

const median = values => {
    const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    assert.ok(sorted.length > 0 && sorted.every(Number.isFinite));
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const timingSamples = report => report.results.map(check => ({ engine: check.engine, width: check.width,
    repetition: check.repetition, phase: check.phase, domMs: check.domContentLoadedMilliseconds,
    modelMs: check.modelsReadyMilliseconds, uncaughtErrors: check.errors.length }));
const originSamples = report => report.results.filter(check => check.path === '/api/get_weighted_workspace')
    .map(check => ({ port: check.port, repetition: check.repetition, status: check.status, totalMs: check.totalMs }));
const originBeforeSamples = originSamples(originBefore), originAfterSamples = originSamples(originAfter);
assert.equal(originBeforeSamples.length, 6); assert.equal(originAfterSamples.length, 6);
assert.ok([...originBeforeSamples, ...originAfterSamples].every(check => check.status === 200));
const previousRelease = state.release === deployment.release ? state.latestReview.previousRelease : state.release;
const latest = {
    release: deployment.release, previousRelease, filesDeployed: manifest.files.map(file => file.path), databaseChanged: false,
    contextMap: `${root}/startup-context.md`, reproduction: `${root}/startup-reproduction.md`,
    rolloutPlan: `${root}/startup-rollout.md`, deploymentReport: `${output}/deployment-result.json`,
    productionBaseline: baseline.baseline, installedBaselineDiff: `${output}/installed-baseline.diff`,
    fixed: [
        { id: 'unused-full-catalog-search-index-on-first-load', resolution: 'Build the search index only for a nonempty query; catalogue cleanup still invalidates search and page caches.' },
        { id: 'repeated-snapshot-normalization-metadata-select', resolution: 'Reuse validated metadata from the same database snapshot; standalone loadModels callers keep the SQL fallback.' },
        { id: 'repeated-linear-family-entrance-lookup', resolution: 'Use a request-local condition lookup map without changing scores, order, identity or evidence.' },
        { id: 'late-existing-module-and-stylesheet-discovery', resolution: 'Expose the same ten ordered CSS imports and eighteen exact module URLs earlier. Controlled discovery improves; real public latency improvement is not established.' },
        { id: 'retired-available-results-help', resolution: 'Describe current mean-percentile inference, not retired downward coverage adjustment.' }
    ],
    verification: {
        unitTests: { passed: 1372, total: 1372, report: unitPath },
        mainFrontendChecks: { passed: 62, total: 62, report: `${output}/frontend-results.json` },
        exactStructuredExports: { workspaces: 10, repetitions: 2, pagerContinuationsPerRepetition: 9,
            report: `${root}/startup-server-applied-results.json`, productionData: false,
            scope: 'Unmodified original ESM versus current source with identical synthetic structured SQL fixtures; full output equality except time/random snapshot ID, one fewer SELECT in every workspace.' },
        controlledDiscovery: { passed: 16, total: 16, report: `${root}/startup-discovery-direct/results.json`,
            scope: 'Desktop/mobile Chromium and WebKit twice, fixed per-request delay, identical style/geometry, 69 unique modules and one workspace fetch; not a production performance benchmark.' },
        originalFailedEvidence: [`${root}/startup-unit-tests.tap`, `${root}/startup-discovery/results.json`],
        lint: 'Changed application modules, tests, diagnostics and deployment/recording helpers passed.'
    },
    productionChecks: {
        installedHashes: 3, protectedHashes: 20, protectedRegistrations: 26, pureGuardChecks: 6,
        services: guards.services, report: `${output}/installed-guards.json`,
        strictSmoke: { passed: strict.filter(check => check.passed).length, total: strict.length, report: strictPath,
            unresolvedFailures: strict.filter(check => !check.passed).map(check => ({ engine: check.engine,
                width: check.width, error: check.error, errors: check.errors })) },
        separateSettledTelemetrySmoke: { passed: settled.filter(check => check.passed).length,
            total: settled.length, report: settledPath, replacesStrictSmoke: false },
        actualOAuth: false, actualEmailDelivery: false, physicalMobileSafari: false
    },
    performance: {
        publicStartupSolved: false, causalPublicLatencyImprovementEstablished: false,
        originalTimingReport: `${root}/startup-timing-before/results.json`,
        currentTimingReport: `${root}/startup-timing-after/results.json`,
        before: timingSamples(timingBefore), after: timingSamples(timingAfter),
        loopback: { beforeReport: `${root}/startup-origin-before.json`, afterReport: `${root}/startup-origin-after.json`,
            before: originBeforeSamples, after: originAfterSamples,
            beforeMedianMs: median(originBeforeSamples.map(check => check.totalMs)),
            afterMedianMs: median(originAfterSamples.map(check => check.totalMs)) },
        alternatingPublicHTML: { report: `${root}/startup-public-ab/results.json`, scope: publicAB.scope,
            samples: publicAB.results.map(check => ({ repetition: check.repetition, variant: check.variant,
                domMs: check.domMs, readyMs: check.readyMs, passed: check.passed })) },
        conclusion: 'Narrow redundant work is removed with exact-output proof. Full public fresh loads were generally slower in the after window; alternating HTML is mixed (one slower, one faster). Intermittent simultaneous asset stalls remain unresolved. Small sequential samples, time-window and service warm-up differences are not causal latency evidence. Do not claim the startup target is met.'
    },
    socialPublication: { status: 'not_posted', actualPostsOrMessagesSent: false,
        handoff: 'artifacts/launch-20261008/START-HERE.md', materials: 'artifacts/launch-20261008/launch-kit.html',
        archive: 'artifacts/launch-20261008/BenchPoll-launch-kit-20261008.zip',
        verification: { passed: 33, total: 33, report: 'artifacts/launch-20261008/handoff-check.json' } }
};
if (state.release !== deployment.release) state.databaseDeadlineReview = state.latestReview;
state.latestReview = latest; state.release = deployment.release; state.productionBackup = deployment.backup;
state.databaseChanged = false; state.goalStatus = 'active';
state.verification.unitTests = latest.verification.unitTests;
state.verification.mainFrontendChecks = latest.verification.mainFrontendChecks;
state.verification.productionSmoke = { ...latest.productionChecks, release: deployment.release };
state.nextReview = state.nextReview.map(item => item.startsWith('Profile first workspace startup')
    ? 'Continue public startup transport and request-priority investigation. Original/current timings and alternating HTML retain slow samples; narrow exact-output optimizations do not establish a public latency improvement.' : item);
for (const item of [
    'Verify a stalled comparison-profile read cannot indefinitely delay initial ranking; source/control-flow reproduction exists, current real-user harm is not established.',
    'Review duplicate query-versioned motion module instances and cross-instance cancellation, then asynchronous channel replay ordering; risks are not yet proven live bugs.'
]) if (!state.nextReview.includes(item)) state.nextReview.push(item);
await writeFile(`${root}/startup-results.json`, JSON.stringify(latest, null, 2));
await writeFile(`${root}/review-state.json`, JSON.stringify(state, null, 2));
console.log(JSON.stringify({ release: state.release, goalStatus: state.goalStatus, unitTests: 1372, frontendChecks: 62,
    strictPassed: latest.productionChecks.strictSmoke.passed, settledPassed: latest.productionChecks.separateSettledTelemetrySmoke.passed,
    publicStartupSolved: false, socialPublication: 'not_posted' }));
