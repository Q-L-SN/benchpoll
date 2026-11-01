import assert from 'node:assert/strict';
import test from 'node:test';
import { arenaRowHash } from '../arena-import-plan.js';
import { arenaTrackedAction } from '../arena-sync.js';
import { findArenaSyncConflicts, resolveArenaSyncConflict } from '../arena-sync-conflicts.js';

const entry = { key: 'a'.repeat(64), config: 'text', row: { category: 'overall', rating: 1300,
    model_name: 'M', organization: 'Lab', leaderboard_publish_date: '2026-10-03' } };
const tracked = { row_key: entry.key, result_ID: 11, source_hash: '0'.repeat(64), source_revision: 'b'.repeat(40),
    manual_override: 'edit', result_status: 'accepted', config: 'text', category: 'overall' };

function reviewDB(previous = tracked, incoming = entry) {
    const state = { tracked: structuredClone(previous), conflict: { row_key: previous.row_key, result_ID: previous.result_ID,
        incoming_hash: incoming ? arenaRowHash(incoming.row) : null, incoming_row: incoming ? JSON.stringify(incoming.row) : null,
        source_revision: 'c'.repeat(40), status: 'pending' }, statements: [] };
    return { state, async execute(sql, parameters) {
        state.statements.push(sql);
        if (sql.startsWith('SELECT')) return [[{ ...state.conflict, tracked_result_ID: state.tracked.result_ID,
            previous_hash: state.tracked.source_hash, manual_override: state.tracked.manual_override,
            result_status: state.tracked.result_status }]];
        if (sql.startsWith('UPDATE arena_import_rows')) {
            state.tracked.source_hash = parameters[0]; state.tracked.source_revision = parameters[1]; state.tracked.source_date = parameters[2];
        } else if (sql.startsWith('DELETE')) state.conflict = null;
        else if (sql.startsWith('UPDATE arena_sync_conflicts')) state.conflict.status = 'accept_source';
        else throw new Error(sql);
        return [{ affectedRows: 1 }];
    } };
}
const request = (database, choice) => ({ rowKey: database.state.conflict.row_key, resultID: database.state.conflict.result_ID,
    incomingHash: database.state.conflict.incoming_hash, choice });

test('reviewing a new official version can retain either an edit or deletion without changing the reviewed score', async () => {
    for (const manual_override of ['edit', 'delete']) {
        const previous = { ...tracked, manual_override, result_status: manual_override === 'edit' ? 'accepted' : 'superseded' };
        const db = reviewDB(previous);
        assert.equal(findArenaSyncConflicts([entry], [previous]).length, 1);
        const resolved = await resolveArenaSyncConflict(db, request(db, 'correction'), 7);
        assert.equal(resolved.after.status, 'kept_correction');
        assert.equal(db.state.tracked.result_ID, 11);
        assert.equal(db.state.tracked.manual_override, manual_override);
        assert.equal(arenaTrackedAction(entry, db.state.tracked), manual_override === 'edit' ? 'corrected' : 'suppressed');
        assert.equal(findArenaSyncConflicts([entry], [db.state.tracked]).length, 0);
        assert.equal(db.state.conflict, null);
        assert.equal(findArenaSyncConflicts([{ ...entry, row: { ...entry.row, rating: 1400 } }], [db.state.tracked]).length, 1);
    }
});

test('accepting the exact official candidate restores both edited and deleted scores on the next atomic sync', async () => {
    for (const manual_override of ['edit', 'delete']) {
        const previous = { ...tracked, manual_override, result_status: manual_override === 'edit' ? 'accepted' : 'superseded' };
        const db = reviewDB(previous);
        await resolveArenaSyncConflict(db, request(db, 'source'), 7);
        assert.equal(arenaTrackedAction(entry, previous, db.state.conflict), 'replace');
        assert.deepEqual(findArenaSyncConflicts([entry], [previous], [db.state.conflict]), []);
        assert.equal(findArenaSyncConflicts([{ ...entry, row: { ...entry.row, rating: 1400 } }], [previous], [db.state.conflict]).length, 1);
        assert.throws(() => arenaTrackedAction(entry, previous), /review required/);
    }
});

test('changed candidates and changed tracked result IDs cannot reuse an earlier approval', async () => {
    const db = reviewDB();
    const input = request(db, 'source');
    db.state.tracked.result_ID = 12;
    await assert.rejects(resolveArenaSyncConflict(db, input, 7), error => error.body.error === 'sync_conflict_changed');
    assert.equal(db.state.statements.filter(sql => sql.startsWith('UPDATE')).length, 0);
    const fresh = reviewDB();
    await assert.rejects(resolveArenaSyncConflict(fresh, { ...request(fresh, 'source'), incomingHash: 'f'.repeat(64) }, 7));
    await assert.rejects(resolveArenaSyncConflict(fresh, { ...request(fresh, 'source'), extra: true }, 7));
});

test('a removed official row has an explicit acceptance path and cannot be acknowledged as an unchanged correction', async () => {
    const db = reviewDB(tracked, null);
    assert.equal(findArenaSyncConflicts([], [tracked])[0].incomingRow, null);
    await assert.rejects(resolveArenaSyncConflict(db, request(db, 'correction'), 7), error => error.body.error === 'removed_source_requires_acceptance');
    await resolveArenaSyncConflict(db, request(db, 'source'), 7);
    assert.deepEqual(findArenaSyncConflicts([], [tracked], [db.state.conflict]), []);
});

test('a stale correction state cannot be retained but can be explicitly replaced by official evidence', async () => {
    const db = reviewDB({ ...tracked, result_status: 'archived' });
    await assert.rejects(resolveArenaSyncConflict(db, request(db, 'correction'), 7), error => error.body.error === 'sync_correction_changed');
    assert.equal(db.state.statements.some(sql => sql.startsWith('UPDATE')), false);
    await resolveArenaSyncConflict(db, request(db, 'source'), 7);
    assert.equal(arenaTrackedAction(entry, db.state.tracked, db.state.conflict), 'replace');
});
