import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHarnessSplitPlan, validateHarnessReview, referencesHarnessTarget } from '../benchmark-harness-split.js';
import { openHarnessReceipt } from '../scripts/split-arc-harness-conditions-20261103.mjs';
import { harnessReview as review, reviewedHarnessState as reviewedState } from './helpers/harness-conditions-fixture.mjs';

test('review separates official ARC adapters, custom systems and unknown configurations without losing records', () => {
    assert.equal(validateHarnessReview(review), review);
    assert.deepEqual(review.targets.map(row => Object.fromEntries(Object.keys(row.buckets).map(bucket =>
        [bucket, row.scores.filter(score => score.bucket === bucket).length]))), [
        { standard: 247, custom: 6, unverified: 12 }, { standard: 248, custom: 9, unverified: 28 }, { standard: 45, 'provider-adapter': 16 }
    ]);
    const plan = buildHarnessSplitPlan(reviewedState(), review);
    assert.equal(plan.canApply, true);
    assert.equal(plan.targets.reduce((n, target) => n + target.moves.length, 0), 71);
    for (const target of plan.targets) assert.equal(target.buckets.find(row => row.key === 'standard').ID, target.conditionID);
    const all = review.targets.flatMap(row => row.scores);
    assert.equal(all.find(row => row.ID === 205307).bucket, 'custom', 'Officially verified Poetiq is still a solver scaffold');
    assert.equal(all.find(row => row.ID === 205046).bucket, 'custom', 'Explicit code execution is not the direct no-tools setup');
    assert.equal(all.find(row => row.ID === 57385).bucket, 'provider-adapter', 'Provider Adapter is an official, separate condition');
    assert.equal(all.find(row => row.ID === 9330).bucket, 'unverified', 'A vendor quote is not direct-harness evidence');
});

test('new records, missing records, changed fields, changed sources and altered scales require another review', () => {
    for (const mutate of [
        state => state.results.push({ ...structuredClone(state.results[0]), ID: 999999 }),
        state => state.results.shift(),
        state => state.results[0].publicIdentity.fields.push({ name: 'Harness', value: 'Different agent' }),
        state => { state.results[0].publicIdentity.sourceURL = 'https://example.test/replaced'; },
        state => { state.results[0].publicIdentity.rawScore += 1; },
        state => { state.conditions[0].score_direction = 'lower'; },
        state => { state.conditions[0].is_primary = 0; },
        state => { state.pendingTargetRequests = [123]; }
    ]) {
        const state = reviewedState(); mutate(state);
        assert.equal(buildHarnessSplitPlan(state, review).canApply, false);
    }
});

test('a fully applied split is idempotent and preserves unrelated conditions', () => {
    const state = reviewedState();
    const first = buildHarnessSplitPlan(state, review); let next = 90000;
    for (const target of first.targets) {
        const original = state.conditions.find(row => row.ID === target.conditionID);
        for (const bucket of target.buckets) {
            if (bucket.create) { bucket.ID = ++next; state.conditions.push({ ...original, ID: bucket.ID,
                condition_key: bucket.conditionKey, is_primary: 0, name: bucket.name, difference_explanation: bucket.explanation }); }
            else Object.assign(original, { name: bucket.name, difference_explanation: bucket.explanation });
            for (const reviewed of review.targets.find(row => row.conditionID === target.conditionID).scores.filter(row => row.bucket === bucket.key)) {
                const row = state.results.find(row => row.ID === reviewed.ID); row.benchmark_condition_ID = bucket.ID;
                Object.assign(row.benchmark_condition_snapshot, { conditionID: bucket.ID, name: bucket.name });
            }
        }
    }
    const again = buildHarnessSplitPlan(state, review);
    assert.equal(again.canApply, true); assert.equal(again.mutations, 0);
});

test('visible destination-name collisions block both creation and primary-condition renaming', () => {
    for (const target of review.targets) for (const [bucket, definition] of Object.entries(target.buckets)) {
        for (const name of [definition.name, definition.name.toUpperCase(), '  ' + definition.name.replaceAll(' ', '  ') + '  ',
            definition.name.replace(/[A-Za-z]/g, char => String.fromCharCode(char.charCodeAt(0) + 0xfee0))]) {
            const state = reviewedState(), original = state.conditions.find(row => row.ID === target.conditionID);
            state.conditions.push({ ...original, ID: 999999, condition_key: 'manually-created', name, is_primary: 0 });
            const before = structuredClone(state), plan = buildHarnessSplitPlan(state, review);
            assert.equal(plan.canApply, false);
            assert.ok(plan.blockers.some(row => row.code === 'destination_condition_name_conflict'
                && row.benchmarkID === target.benchmarkID && row.bucket === bucket && row.conditionID === 999999));
            assert.deepEqual(state, before, 'Planning must not modify the conflicting condition');
        }
    }
});

test('a destination already using its reviewed key does not hide another visible-name collision', () => {
    const state = reviewedState(), target = review.targets[0], definition = target.buckets.custom;
    state.conditions.push({ ...state.conditions[0], ID: 90000, condition_key: definition.conditionKey,
        name: definition.name, difference_explanation: definition.explanation, is_primary: 0 });
    assert.equal(buildHarnessSplitPlan(state, review).canApply, true);
    state.conditions.push({ ...state.conditions.at(-1), ID: 90001, condition_key: 'manual-copy' });
    const plan = buildHarnessSplitPlan(state, review);
    assert.equal(plan.canApply, false);
    assert.ok(plan.blockers.some(row => row.code === 'destination_condition_name_conflict' && row.conditionID === 90001));
});

test('deleted labels and labels in another benchmark do not collide with a destination', () => {
    const state = reviewedState(), definition = review.targets[0].buckets.custom;
    state.conditions.push({ ...state.conditions[0], ID: 90000, condition_key: 'deleted-copy',
        name: definition.name, is_primary: 0, deleted_at: '2026-11-02 00:00:00' });
    state.conditions.push({ ...state.conditions[0], ID: 90001, benchmark_ID: 999999,
        condition_key: 'other-benchmark', name: definition.name, is_primary: 0 });
    assert.equal(buildHarnessSplitPlan(state, review).canApply, true);
});

test('review rejects duplicate planned visible names even before destination rows exist', () => {
    const duplicate = structuredClone(review);
    duplicate.targets[0].buckets.custom.name = '  ' + duplicate.targets[0].buckets.standard.name.toUpperCase() + '  ';
    assert.throws(() => validateHarnessReview(duplicate), /Duplicate harness bucket name/);
});

test('pending requests match benchmark and condition references without mistaking model IDs', () => {
    const benchmarks = new Set([1028]), conditions = new Set([22186]);
    assert.equal(referencesHarnessTarget({ results: [{ benchmarkID: 1028 }] }, benchmarks, conditions), true);
    assert.equal(referencesHarnessTarget({ targetKind: 'benchmark', targetID: 1028 }, benchmarks, conditions), true);
    assert.equal(referencesHarnessTarget({ benchmarkConditionID: 22186 }, benchmarks, conditions), true);
    assert.equal(referencesHarnessTarget({ modelID: 1028, targetKind: 'model', targetID: 1028 }, benchmarks, conditions), false);
});

test('private receipts reject Git directories, symlink destinations and overwrites', async t => {
    const root = await mkdtemp(join(tmpdir(), 'benchpoll-harness-')); t.after(() => rm(root, { recursive: true, force: true }));
    const repo = join(root, 'repo'); await mkdir(join(repo, '.git'), { recursive: true });
    await assert.rejects(openHarnessReceipt(join(repo, 'receipt.json')), /outside every Git/);
    await symlink(repo, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(openHarnessReceipt(join(root, 'alias', 'receipt.json')), /outside every Git/);
    await t.test('real receipt durability, permissions and exclusive creation', {
        skip: process.platform === 'win32' ? 'Directory fsync and POSIX mode checks require a POSIX filesystem' : false
    }, async () => {
        const destination = join(root, 'receipt.json'), receipt = await openHarnessReceipt(destination);
        try { await receipt.write({ phase: 'prepared' }); } finally { await receipt.close(); }
        assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), { phase: 'prepared' });
        assert.equal((await stat(destination)).mode & 0o777, 0o600);
        await assert.rejects(openHarnessReceipt(destination), error => error.code === 'EEXIST');
        await symlink(destination, join(root, 'linked-receipt.json'));
        await assert.rejects(openHarnessReceipt(join(root, 'linked-receipt.json')), error => error.code === 'EEXIST' || error.code === 'ELOOP');
    });
});
