import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { openHarnessReceipt, applyHarnessSplit, readHarnessState } from '../scripts/split-arc-harness-conditions-20261103.mjs';
import { buildHarnessSplitPlan } from '../benchmark-harness-split.js';
import { harnessReview, reviewedHarnessState } from './helpers/harness-conditions-fixture.mjs';

async function receiptFixture(t, failure = null) {
    const parent = await realpath(tmpdir()), root = await mkdtemp(join(parent, 'benchpoll-receipt-'));
    assert.equal(dirname(root), parent);
    t.after(() => rm(root, { recursive: true, force: true }));
    const destination = join(root, 'receipt.json'), events = [], writes = [];
    const error = Object.assign(new Error('Receipt storage failure: ' + failure), { code: 'EIO' });
    const step = name => { events.push(name); if (failure === name) throw error; };
    const directory = { async sync() { step('directory-sync'); }, async close() { step('directory-close'); } };
    const file = {
        async writeFile(text, encoding) { step('file-write'); assert.equal(encoding, 'utf8'); writes.push(JSON.parse(text)); },
        async sync() { step('file-sync'); }, async close() { step('file-close'); }
    };
    t.mock.method(fs, 'open', async (path, flags, mode) => {
        if (path === root) {
            step('directory-open');
            assert.equal(flags, constants.O_RDONLY | constants.O_DIRECTORY);
            return directory;
        }
        assert.equal(path, destination);
        step('file-open');
        assert.equal(flags, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW);
        assert.equal(mode, 0o600);
        return file;
    });
    return { destination, events, writes, error };
}

function harnessConnection(events) {
    const review = structuredClone(harnessReview);
    review.targets = [review.targets[0]];
    const target = review.targets[0];
    target.buckets = { standard: target.buckets.standard };
    target.scores = [target.scores.find(row => row.bucket === 'standard')];
    target.scores[0].fields = [];
    const state = reviewedHarnessState(review), score = target.scores[0];
    Object.assign(state.results[0], { model_ID: score.modelID, source_url: score.sourceURL, source_title: score.sourceTitle, score_fields: [] });
    let saved;
    const connection = {
        async query(sql) {
            if (sql.startsWith('SET TRANSACTION')) return [];
            for (const [table, key] of [['benchmarks', 'benchmarks'], ['benchmark_conditions', 'conditions'], ['benchmark_results', 'results']]) {
                if (sql.includes('FROM ' + table + ' ')) return [structuredClone(state[key])];
            }
            if (sql.includes('FROM moderation_logs')) return [[]];
            assert.fail('Unexpected transaction query: ' + sql);
        },
        async execute(sql, values) {
            if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
            if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
            if (sql.includes('FROM score_fields') || sql.includes('FROM score_field_options')) return [[]];
            if (sql.startsWith('UPDATE benchmark_conditions')) {
                assert.equal(values[2], state.conditions[0].ID);
                Object.assign(state.conditions[0], { name: values[0], difference_explanation: values[1], is_default: 0 });
                events.push('condition-update');
                return [{ affectedRows: 1 }];
            }
            if (sql.startsWith('UPDATE benchmark_results')) {
                assert.equal(values[2], state.results[0].ID);
                assert.equal(values[3], state.results[0].benchmark_condition_ID);
                Object.assign(state.results[0], { benchmark_condition_ID: values[0], benchmark_condition_snapshot: JSON.parse(values[1]) });
                events.push('score-update');
                return [{ affectedRows: 1 }];
            }
            if (sql.startsWith('UPDATE benchmarks')) {
                assert.equal(values[0], state.benchmarks[0].ID);
                state.benchmarks[0].scores_updated_at = '2026-11-03 00:00:00.000';
                return [{ affectedRows: 1 }];
            }
            assert.fail('Unexpected transaction mutation: ' + sql);
        },
        async beginTransaction() { saved = structuredClone(state); events.push('begin'); },
        async commit() { saved = null; events.push('commit'); },
        async rollback() { if (saved) Object.assign(state, saved); saved = null; events.push('rollback'); }
    };
    return { connection, review, state };
}

test('receipt writes sync contents before the pinned parent directory and close both handles', async t => {
    const fixture = await receiptFixture(t), receipt = await openHarnessReceipt(fixture.destination);
    try { await receipt.write({ phase: 'prepared' }); } finally { await receipt.close(); }
    assert.deepEqual(fixture.events, ['directory-open', 'file-open', 'file-write', 'file-sync', 'directory-sync', 'file-close', 'directory-close']);
    assert.deepEqual(fixture.writes, [{ phase: 'prepared' }]);
});

test('receipt storage errors propagate without skipping directory durability or leaking handles', async t => {
    for (const failure of ['directory-open', 'file-open', 'file-write', 'file-sync', 'directory-sync', 'file-close']) {
        await t.test(failure, async t => {
            const fixture = await receiptFixture(t, failure);
            if (failure.endsWith('open')) {
                await assert.rejects(openHarnessReceipt(fixture.destination), error => error === fixture.error);
                assert.deepEqual(fixture.events, failure === 'directory-open' ? ['directory-open']
                    : ['directory-open', 'file-open', 'directory-close']);
                return;
            }
            const receipt = await openHarnessReceipt(fixture.destination);
            if (failure === 'file-close') await assert.rejects(receipt.close(), error => error === fixture.error);
            else {
                try { await assert.rejects(receipt.write({ phase: 'prepared' }), error => error === fixture.error); }
                finally { await receipt.close(); }
            }
            assert.deepEqual(fixture.events.slice(-2), ['file-close', 'directory-close']);
            if (failure === 'file-write') assert.equal(fixture.events.includes('file-sync'), false);
            if (failure === 'file-write' || failure === 'file-sync') assert.equal(fixture.events.includes('directory-sync'), false);
        });
    }
});

test('unsupported directory sync errors are not swallowed on any platform', async t => {
    const fixture = await receiptFixture(t, 'directory-sync');
    fixture.error.code = 'EINVAL';
    const receipt = await openHarnessReceipt(fixture.destination);
    try { await assert.rejects(receipt.write({ phase: 'prepared' }), error => error.code === 'EINVAL'); }
    finally { await receipt.close(); }
});

test('harness commit waits for directory sync and rolls back when it fails', async t => {
    for (const failure of [null, 'file-write', 'file-sync', 'directory-sync']) await t.test(failure ?? 'durable commit', async t => {
        const fixture = await receiptFixture(t, failure), receipt = await openHarnessReceipt(fixture.destination);
        const { connection, review, state } = harnessConnection(fixture.events), before = structuredClone(state);
        const plan = buildHarnessSplitPlan(await readHarnessState(connection, review), review);
        assert.equal(plan.canApply, true); assert.equal(plan.mutations, 2);
        const options = { expectedPlanHash: plan.planHash, beforeCommit: prepared => receipt.write(prepared) };
        try {
            if (failure) {
                await assert.rejects(applyHarnessSplit(connection, review, options), error => error === fixture.error);
                assert.equal(fixture.events.includes('commit'), false);
                assert.ok(fixture.events.indexOf('rollback') > fixture.events.indexOf(failure));
                assert.deepEqual(state, before, 'Every database update must be rolled back after receipt storage fails');
            } else {
                assert.equal((await applyHarnessSplit(connection, review, options)).applied, true);
                assert.ok(fixture.events.indexOf('commit') > fixture.events.indexOf('directory-sync'));
                assert.equal(fixture.events.includes('rollback'), false);
                assert.notDeepEqual(state, before);
                assert.equal(buildHarnessSplitPlan(await readHarnessState(connection, review), review).mutations, 0);
            }
            assert.ok(fixture.events.includes('condition-update'));
            assert.ok(fixture.events.includes('score-update'));
            if (failure !== 'file-write') {
                assert.equal(fixture.writes[0].phase, 'prepared');
                assert.equal(fixture.writes[0].applied, false);
            }
        } finally { await receipt.close(); }
    });
});
