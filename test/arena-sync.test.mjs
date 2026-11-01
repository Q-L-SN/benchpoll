import assert from 'node:assert/strict';
import test from 'node:test';
import { validateArenaSnapshot, assertFreshArenaBatch, arenaTrackedAction, publishArenaBatch,
    selectArenaSnapshotConfig, ARENA_DATASET_URL, ARENA_SNAPSHOT_VERSION } from '../arena-sync.js';
import { arenaRowHash } from '../arena-import-plan.js';
import { ArenaSyncConflictError } from '../arena-sync-conflicts.js';

function snapshot({ revision = 'a'.repeat(40), date = '2026-09-24', rating = 1300,
    sourceModifiedAt = '2026-09-24T12:00:00.000Z', names = ['model-a', 'model-b'] } = {}) {
    const rows = names.map((model_name, index) => ({ model_name, organization: 'openai',
        category: 'overall', rating: rating + index, leaderboard_publish_date: date }));
    return { schemaVersion: ARENA_SNAPSHOT_VERSION, source: ARENA_DATASET_URL, license: 'CC-BY-4.0',
        revision, sourceModifiedAt, fetchedAt: '2026-10-03T12:00:00.000Z',
        expectedConfigs: ['text_style_control'], configs: [{ config: 'text_style_control', rows,
            checksums: [{ filename: 'latest/0000.parquet', sha256: '1'.repeat(64), rows: rows.length, size: 100 }] }] };
}

function storedBatch(batch) {
    return { source_revision: batch.snapshot.revision, snapshot_hash: batch.contentHash,
        source_modified_at: batch.sourceModifiedAt.slice(0, 23).replace('T', ' '), status: 'succeeded' };
}

test('complete latest snapshots have a content identity independent of fetch time and row order', () => {
    const first = snapshot();
    const reordered = structuredClone(first);
    reordered.fetchedAt = '2026-10-03T15:00:00.000Z';
    reordered.configs[0].rows.reverse();
    const batch = validateArenaSnapshot(first);
    assert.equal(batch.contentHash, validateArenaSnapshot(reordered).contentHash);
    assert.equal(batch.plan.entries.length, 2);
    assert.deepEqual([...batch.feedDates], [['text_style_control/overall', '2026-09-24']]);
});

test('missing or duplicated source manifests cannot publish an empty or partial batch', () => {
    const invalid = [
        value => { delete value.schemaVersion; },
        value => { value.expectedConfigs.push('vision'); },
        value => { value.expectedConfigs.push('text_style_control'); },
        value => { value.configs = []; },
        value => { value.configs[0].rows = []; },
        value => { value.configs[0].rows.pop(); },
        value => { value.configs[0].checksums = []; },
        value => { value.configs[0].checksums.push(value.configs[0].checksums[0]); },
        value => { value.configs[0].checksums[0].sha256 = 'broken'; },
        value => { value.configs[0].checksums[0].size = 0; },
        value => { value.source = 'https://example.com'; },
        value => { value.sourceModifiedAt = 'invalid'; }
    ];
    for (const mutate of invalid) {
        const value = snapshot();
        mutate(value);
        assert.throws(() => validateArenaSnapshot(value));
    }
});

test('a latest leaderboard cannot contain multiple historical dates for the same condition', () => {
    const value = snapshot();
    value.configs[0].rows[1].leaderboard_publish_date = '2026-09-23';
    assert.throws(() => validateArenaSnapshot(value), /Mixed historical and current/);
    value.configs[0].rows[1].leaderboard_publish_date = '2026-02-30';
    assert.throws(() => validateArenaSnapshot(value), /Invalid Arena leaderboard publication date/);
});

test('different leaderboard conditions can publish on different dates', () => {
    const value = snapshot();
    value.configs[0].rows[1].category = 'coding';
    value.configs[0].rows[1].leaderboard_publish_date = '2026-09-23';
    assert.equal(validateArenaSnapshot(value).feedDates.size, 2);
});

test('conflicting source observations fail the whole batch rather than creating extra median samples', () => {
    const value = snapshot({ names: ['model-a', 'model-a'] });
    assert.throws(() => validateArenaSnapshot(value), /Conflicting Arena source rows/);
});

test('source times and publication dates cannot claim future data', () => {
    assert.throws(() => validateArenaSnapshot(snapshot({ sourceModifiedAt: '2026-10-04T12:00:00.000Z' })), /newer than its fetch/);
    assert.throws(() => validateArenaSnapshot(snapshot({ date: '2026-10-04' })), /publication date is in the future/);
});

test('identical source revisions are idempotent and cannot contain silently changed scores', () => {
    const first = validateArenaSnapshot(snapshot());
    assert.doesNotThrow(() => assertFreshArenaBatch(first, { currentBatch: storedBatch(first) }));
    assert.throws(() => assertFreshArenaBatch(validateArenaSnapshot(snapshot({ rating: 1400 })),
        { currentBatch: storedBatch(first) }), /contents changed within the same source revision/);
});

test('a newer dataset revision can recompute scores without changing the publication date', () => {
    const previous = validateArenaSnapshot(snapshot());
    const next = validateArenaSnapshot(snapshot({ revision: 'b'.repeat(40), rating: 1400,
        sourceModifiedAt: '2026-09-25T12:00:00.000Z' }));
    assert.doesNotThrow(() => assertFreshArenaBatch(next, { currentBatch: storedBatch(previous),
        trackedRows: [{ config: 'text_style_control', category: 'overall', source_date: '2026-09-24' }] }));
});

test('an old source revision is rejected even if its leaderboard dates look current', () => {
    const current = validateArenaSnapshot(snapshot({ revision: 'b'.repeat(40), sourceModifiedAt: '2026-09-25T12:00:00.000Z' }));
    assert.throws(() => assertFreshArenaBatch(validateArenaSnapshot(snapshot()),
        { currentBatch: storedBatch(current) }), /Older or unordered/);
    const unordered = snapshot({ revision: 'c'.repeat(40), sourceModifiedAt: current.sourceModifiedAt });
    assert.throws(() => assertFreshArenaBatch(validateArenaSnapshot(unordered),
        { currentBatch: storedBatch(current) }), /Older or unordered/);
});

test('partial source groups and older publications cannot retire currently published rows', () => {
    const batch = validateArenaSnapshot(snapshot());
    assert.throws(() => assertFreshArenaBatch(batch, { trackedRows: [
        { config: 'vision', category: 'overall', source_date: '2026-09-23' }
    ] }), /omits a currently published leaderboard/);
    assert.throws(() => assertFreshArenaBatch(batch, { trackedRows: [
        { config: 'text_style_control', category: 'overall', source_date: '2026-09-25' }
    ] }), /Older Arena leaderboard/);
});

test('unchanged syncs keep manual corrections and never resurrect manually deleted scores', () => {
    const entry = validateArenaSnapshot(snapshot()).plan.entries[0];
    const previous = { result_ID: 10, source_hash: arenaRowHash(entry.row), manual_override: 'none', result_status: 'accepted' };
    assert.equal(arenaTrackedAction(entry, undefined), 'insert');
    assert.equal(arenaTrackedAction(entry, previous), 'unchanged');
    assert.equal(arenaTrackedAction(entry, { ...previous, source_hash: '0'.repeat(64) }), 'replace');
    assert.equal(arenaTrackedAction(entry, { ...previous, manual_override: 'edit' }), 'corrected');
    assert.equal(arenaTrackedAction(entry, { ...previous, manual_override: 'delete', result_status: 'superseded' }), 'suppressed');
    assert.throws(() => arenaTrackedAction(entry, { ...previous, result_status: 'superseded' }), /outside the source importer/);
    assert.throws(() => arenaTrackedAction(entry, { ...previous, manual_override: 'edit', result_status: 'superseded' }), /Invalid Arena manual/);
});

test('new source data cannot silently overwrite a reviewed manual correction', () => {
    const entry = validateArenaSnapshot(snapshot()).plan.entries[0];
    assert.throws(() => arenaTrackedAction(entry, { result_ID: 10, source_hash: '0'.repeat(64),
        manual_override: 'edit', result_status: 'accepted' }), /manual correction; review required/);
    assert.throws(() => arenaTrackedAction(entry, { result_ID: 10, source_hash: '0'.repeat(64),
        manual_override: 'delete', result_status: 'superseded' }), /manual correction; review required/);
});

class TransactionFixture {
    constructor() { this.state = { batches: [], currentID: null, feeds: {}, scores: [], conflicts: [] }; this.events = []; }
    async execute(sql, parameters) {
        this.events.push(sql);
        if (sql.startsWith('INSERT INTO arena_sync_batches')) {
            const ID = this.state.batches.length + 1;
            this.state.batches.push({ ID, source_revision: parameters[0], source_modified_at: parameters[1],
                snapshot_hash: parameters[2], summary: JSON.parse(parameters[3]), status: 'running' });
            return [{ insertId: ID, affectedRows: 1 }];
        }
        if (sql.startsWith('UPDATE arena_sync_batches')) {
            const row = this.state.batches.find(row => row.ID === parameters[1]);
            assert.equal(row.status, 'running');
            row.status = sql.includes("status='succeeded'") ? 'succeeded' : 'failed';
            if (row.status === 'succeeded') row.summary = JSON.parse(parameters[0]);
            else row.error_message = parameters[0];
            return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('INSERT INTO arena_sync_state')) {
            this.state.currentID = parameters[0];
            return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('INSERT INTO arena_sync_feed_state')) {
            this.state.feeds[parameters[0]] = parameters[1];
            return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('INSERT INTO arena_sync_conflicts')) {
            this.state.conflicts.push({ row_key: parameters[0], result_ID: parameters[1], incoming_hash: parameters[2] });
            return [{ affectedRows: 1 }];
        }
        throw new Error(`Unexpected statement: ${sql}`);
    }
    async query(sql, parameters = []) {
        assert.match(sql, /JOIN arena_sync_batches/);
        assert.match(sql, /FOR UPDATE/);
        const IDs = sql.includes('arena_sync_feed_state') ? parameters[0].map(config => this.state.feeds[config]) : [this.state.currentID];
        return [[...this.state.batches.filter(row => IDs.includes(row.ID))]];
    }
    async beginTransaction() { this.events.push('begin'); this.saved = structuredClone(this.state); }
    async commit() { this.events.push('commit'); this.saved = null; }
    async rollback() { this.events.push('rollback'); this.state = this.saved; this.saved = null; }
    destroy() { this.events.push('destroy'); if (this.saved) this.state = this.saved; this.saved = null; }
}

async function seedPublished(fixture) {
    const batch = validateArenaSnapshot(snapshot());
    const result = await publishArenaBatch(fixture, batch, async () => {
        fixture.state.scores = [{ score: 1300, status: 'accepted' }];
        return { insertedResults: 1 };
    });
    return { batch, result };
}

test('only a fully successful batch advances the current pointer', async () => {
    const fixture = new TransactionFixture();
    const { result } = await seedPublished(fixture);
    assert.equal(result.batchID, 1);
    assert.equal(fixture.state.currentID, 1);
    assert.equal(fixture.state.batches[0].status, 'succeeded');
    assert.equal(fixture.events.at(-1), 'commit');
    assert.equal(fixture.state.batches[0].summary.insertedResults, 1);
});

test('changed scores become historical, not additional median samples', async () => {
    const fixture = new TransactionFixture();
    await seedPublished(fixture);
    const next = validateArenaSnapshot(snapshot({ revision: 'b'.repeat(40), rating: 1400,
        sourceModifiedAt: '2026-09-25T12:00:00.000Z' }));
    await publishArenaBatch(fixture, next, async () => {
        fixture.state.scores[0].status = 'superseded';
        fixture.state.scores.push({ score: 1400, status: 'accepted' });
        return { insertedResults: 1, replacedResults: 1 };
    });
    assert.deepEqual(fixture.state.scores.filter(row => row.status === 'accepted').map(row => row.score), [1400]);
    assert.equal(fixture.state.scores.length, 2);
    assert.equal(fixture.state.currentID, 2);
});

test('a failure after retiring an old score restores scores and the last successful batch', async () => {
    const fixture = new TransactionFixture();
    await seedPublished(fixture);
    const next = validateArenaSnapshot(snapshot({ revision: 'b'.repeat(40), rating: 1400,
        sourceModifiedAt: '2026-09-25T12:00:00.000Z' }));
    await assert.rejects(publishArenaBatch(fixture, next, async () => {
        fixture.state.scores[0].status = 'superseded';
        fixture.state.scores.push({ score: 1400, status: 'accepted' });
        throw new Error('Simulated incomplete write');
    }), /Simulated incomplete write/);
    assert.deepEqual(fixture.state.scores, [{ score: 1300, status: 'accepted' }]);
    assert.equal(fixture.state.currentID, 1);
    assert.equal(fixture.state.batches[1].status, 'failed');
    assert.match(fixture.state.batches[1].error_message, /Simulated incomplete write/);
});

test('conflict candidates survive the rolled-back publication without changing scores or the current pointer', async () => {
    const fixture = new TransactionFixture();
    await seedPublished(fixture);
    const next = validateArenaSnapshot(snapshot({ revision: 'b'.repeat(40), rating: 1400,
        sourceModifiedAt: '2026-09-25T12:00:00.000Z' }));
    await assert.rejects(publishArenaBatch(fixture, next, async () => {
        fixture.state.scores[0].status = 'superseded';
        throw new ArenaSyncConflictError([{ rowKey: 'a'.repeat(64), resultID: 10, incomingHash: 'b'.repeat(64),
            incomingRow: next.plan.entries[0].row, config: 'text_style_control', category: 'overall' }]);
    }), ArenaSyncConflictError);
    assert.deepEqual(fixture.state.scores, [{ score: 1300, status: 'accepted' }]);
    assert.equal(fixture.state.currentID, 1);
    assert.equal(fixture.state.batches[1].status, 'failed');
    assert.equal(fixture.state.conflicts.length, 1);
    const insert = fixture.events.findIndex(event => event.startsWith('INSERT INTO arena_sync_conflicts'));
    assert.ok(insert > fixture.events.indexOf('rollback'));
    assert.equal(fixture.events.at(-1), 'commit');
});

test('freshness failures never execute the score writer', async () => {
    const fixture = new TransactionFixture();
    await seedPublished(fixture);
    let called = false;
    const older = validateArenaSnapshot(snapshot({ revision: 'b'.repeat(40),
        sourceModifiedAt: '2026-09-23T12:00:00.000Z' }));
    await assert.rejects(publishArenaBatch(fixture, older, async () => { called = true; }), /Older or unordered/);
    assert.equal(called, false);
    assert.equal(fixture.state.currentID, 1);
    assert.equal(fixture.state.batches[1].status, 'failed');
});

test('rollback or audit failures are reported rather than swallowed', async () => {
    const fixture = new TransactionFixture();
    fixture.rollback = async () => { throw new Error('Rollback unavailable'); };
    await assert.rejects(publishArenaBatch(fixture, validateArenaSnapshot(snapshot()), async () => {
        throw new Error('Writer failed');
    }), error => error instanceof AggregateError && error.errors.some(error => error.message === 'Rollback unavailable'));
});

test('scoped feed publication cannot retire another leaderboard or move its successful pointer', async () => {
    const fixture = new TransactionFixture();
    await seedPublished(fixture);
    const raw = snapshot({ revision: 'b'.repeat(40), sourceModifiedAt: '2026-09-25T12:00:00.000Z' });
    raw.expectedConfigs.push('vision');
    raw.configs.push({ ...structuredClone(raw.configs[0]), config: 'vision' });
    const batch = validateArenaSnapshot(selectArenaSnapshotConfig(raw, 'vision'));
    await publishArenaBatch(fixture, batch, async () => ({ insertedResults: 2 }), { scoped: true });
    assert.equal(fixture.state.currentID, 1);
    assert.equal(fixture.state.feeds.text_style_control, 1);
    assert.equal(fixture.state.feeds.vision, 2);
    assert.deepEqual(fixture.state.batches[1].summary.configs, ['vision']);
    const invalid = structuredClone(raw);
    invalid.configs.pop();
    assert.throws(() => selectArenaSnapshotConfig(invalid, 'vision'), /manifest is incomplete/);
    assert.throws(() => selectArenaSnapshotConfig(raw, 'missing'), /missing the requested config/);
});

test('a failed file download is recorded but cannot publish, while healthy feeds remain usable', () => {
    const raw = snapshot();
    raw.expectedConfigs.push('vision');
    raw.configs.push({ config: 'vision', fetchError: '503 downloading vision' });
    assert.throws(() => validateArenaSnapshot(raw), /Arena download failed for vision: 503/);
    assert.throws(() => selectArenaSnapshotConfig(raw, 'vision'), /Arena download failed for vision: 503/);
    const healthy = validateArenaSnapshot(selectArenaSnapshotConfig(raw, 'text_style_control'));
    assert.equal(healthy.plan.entries.length, 2);
    assert.deepEqual(healthy.snapshot.expectedConfigs, ['text_style_control']);
});
