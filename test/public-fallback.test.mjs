import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { loadEstimationBallots } from '../estimation-ballots.js';
import { getRankingWorkspace } from '../ranking-service.js';

const catalogue = (entries = [[1, 10], [2, 10], [3, 20], [4, 10], [5, 10, true]]) => new Map(
    entries.map(([conditionID, benchmarkID, excludedFromRanking]) =>
        [conditionID, { conditionID, benchmarkID, excludedFromRanking }]));
const pair = (targetConditionID, sourceConditionID) => ({ targetConditionID, sourceConditionID });
const tally = (targetConditionID, sourceConditionID, supportCount, opposeCount) =>
    ({ ...pair(targetConditionID, sourceConditionID), supportCount, opposeCount });

function ballotDatabase(t) {
    const sql = new DatabaseSync(':memory:');
    t.after(() => sql.close());
    sql.exec(`
        CREATE TABLE users (ID INTEGER PRIMARY KEY, deleted_at INTEGER, banned_at INTEGER, banned_until INTEGER);
        CREATE TABLE estimation_pair_votes (user_ID INTEGER NOT NULL REFERENCES users (ID),
            first_ID INTEGER NOT NULL, second_ID INTEGER NOT NULL, vote TEXT NOT NULL, updated_at INTEGER NOT NULL,
            CHECK (first_ID < second_ID), CHECK (vote IN ('support', 'oppose')), PRIMARY KEY (user_ID, first_ID, second_ID));
    `);
    const now = 1000;
    sql.function('NOW', () => now);
    return {
        add(user, first, second, vote, hoursAgo, { deleted = null, banned = null, until = null } = {}) {
            sql.prepare('INSERT OR IGNORE INTO users VALUES (?, ?, ?, ?)').run(user, deleted, banned, until);
            sql.prepare('INSERT INTO estimation_pair_votes VALUES (?, ?, ?, ?, ?)').run(user, first, second, vote, now - hoursAgo);
        },
        remove(user, first, second) {
            sql.prepare('DELETE FROM estimation_pair_votes WHERE user_ID = ? AND first_ID = ? AND second_ID = ?').run(user, first, second);
        },
        async execute(query, params) {
            // Store timestamps as hours and adapt MySQL interval syntax for the same SQL tally.
            return [sql.prepare(query.replace(/NOW\(\)\s*-\s*INTERVAL\s*\? HOUR/i, 'NOW() - ?')).all(...params)];
        }
    };
}

test('the sitewide sample includes every ballot in 72 hours and tops up each pair independently to ten', async t => {
    const db = ballotDatabase(t);
    db.add(1, 1, 2, 'support', 72);
    for (let user = 2; user <= 12; user++) db.add(user, 1, 2, 'oppose', user);
    db.add(99, 1, 2, 'support', 73);
    db.add(1, 2, 4, 'support', 12);
    db.add(2, 2, 4, 'support', 24);
    for (let user = 3; user <= 12; user++) db.add(user, 2, 4, 'oppose', user + 72);
    db.add(13, 2, 4, 'support', 0, { deleted: 999 });
    db.add(14, 2, 4, 'support', 0, { banned: 999, until: 1001 });
    db.add(15, 2, 4, 'support', 80, { banned: 900, until: 1000 });
    db.add(16, 2, 4, 'support', 0, { banned: 999 });

    const result = await loadEstimationBallots(db, 99, catalogue(), 72, 10);
    assert.deepEqual(result, { externalPairs: [], personal: [{ ...pair(1, 2), vote: 'support' }],
        community: [tally(1, 2, 1, 11), tally(2, 4, 3, 7)] });
});

test('external nominations appear exactly while the pair sample includes support', async t => {
    const db = ballotDatabase(t);
    for (let user = 1; user <= 10; user++) db.add(user, 1, 3, 'oppose', user);
    db.add(99, 1, 3, 'support', 80);
    db.add(99, 2, 5, 'support', 0);
    db.add(99, 2, 9, 'support', 0);
    db.add(99, 3, 4, 'oppose', 0);
    db.add(99, 1, 2, 'oppose', 80);
    const read = () => loadEstimationBallots(db, 99, catalogue(), 72, 10);
    const base = { externalPairs: [], community: [tally(1, 2, 0, 1)],
        personal: [{ ...pair(1, 2), vote: 'oppose' }] };
    assert.deepEqual(await read(), base);

    db.add(100, 1, 3, 'support', 0);
    assert.deepEqual(await read(), { externalPairs: [pair(1, 3)],
        community: [tally(1, 2, 0, 1), tally(1, 3, 1, 10)],
        personal: [...base.personal, { ...pair(1, 3), vote: 'support' }] });

    db.remove(100, 1, 3);
    assert.deepEqual(await read(), base);
});

test('community and personal ballots preserve all eligible pairs in ascending version order', async t => {
    const db = ballotDatabase(t);
    const siblingIDs = Array.from({ length: 130 }, (_, index) => index + 2);
    const conditions = catalogue([1, ...siblingIDs].map(ID => [ID, 10]));
    for (const id of [...siblingIDs].reverse()) db.add(99, 1, id, 'support', id);
    const { community, personal, externalPairs } = await loadEstimationBallots(db, 99, conditions, 72, 10);
    assert.deepEqual(community, siblingIDs.map(id => tally(1, id, 1, 0)));
    assert.deepEqual(personal, siblingIDs.map(id => ({ ...pair(1, id), vote: 'support' })));
    assert.deepEqual(externalPairs, []);
});

test('the cutoff for equally old ballots uses account ID to complete the sample', async t => {
    const db = ballotDatabase(t);
    for (let user = 11; user >= 1; user--) db.add(user, 1, 2, user === 11 ? 'oppose' : 'support', 80);
    const { community, personal } = await loadEstimationBallots(db, 11, catalogue(), 72, 10);
    assert.deepEqual(community, [tally(1, 2, 10, 0)]);
    assert.deepEqual(personal, [{ ...pair(1, 2), vote: 'oppose' }]);
});

test('workspace snapshot errors roll back and release the pooled connection', async () => {
    const events = [], failure = new Error('read failed');
    const db = { async getConnection() { return {
        async query(sql) { events.push(sql); }, async execute() { throw failure; },
        async commit() { events.push('commit'); }, async rollback() { events.push('rollback'); }, release() { events.push('release'); }
    }; } };
    await assert.rejects(getRankingWorkspace(db), error => error === failure);
    assert.deepEqual(events, ['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
        'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY', 'rollback', 'release']);
});
