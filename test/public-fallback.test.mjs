import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPublicPie, getRankingWorkspace } from '../ranking-service.js';

const scene = { ID: 10, categoryID: 1, sceneID: 10 };
const catalogue = (entries = [[1, 10], [2, 10], [3, 20], [4, 10]]) => new Map(entries.map(([conditionID, benchmarkID, excludedFromRanking]) =>
    [conditionID, { conditionID, benchmarkID, excludedFromRanking, isPrimaryCondition: [1, 3].includes(conditionID), scoreCount: 1 }]));
const rowsForPie = (pieID, entries, votes = null) => (entries.length ? entries : [[null, null]]).map(([conditionID, points]) => ({
    pie_ID: pieID, context_ID: 10, benchmark_condition_ID: conditionID, weight_basis_points: points,
    is_recent: 1, estimation_votes: votes
}));
const database = rows => ({ async execute(sql, params) {
    assert.match(sql, /FROM personal_pies/);
    assert.match(sql, /personal_pies\.estimation_votes/);
    assert.match(sql, /users.deleted_at IS NULL/);
    assert.match(sql, /users.banned_at IS NULL/);
    assert.deepEqual(params, [10]);
    return [rows];
} });
const vote = (targetConditionID, sourceConditionID, option) => ({ targetConditionID, sourceConditionID, vote: option });

test('an eligible pie counts once per ordered pair, regardless of weight or current scoring version', async () => {
    const rows = [
        ...rowsForPie(1, [[1, 100], [3, 9900]], JSON.stringify([vote(1, 2, 'support')])),
        ...rowsForPie(2, [[4, 10000]], [vote(1, 2, 'oppose'), vote(4, 2, 'support')]),
        ...rowsForPie(3, [[1, 6000], [2, 4000]], [vote(2, 1, 'support'), vote(1, 2, 'support')]),
        ...rowsForPie(4, [[1, 10000]])
    ];
    const pie = await loadPublicPie(database(rows), scene, catalogue());
    assert.equal(pie.participantCount, 4);
    assert.deepEqual(pie.estimationVotes, [
        { targetConditionID: 1, sourceConditionID: 2, supportCount: 2, opposeCount: 1 },
        { targetConditionID: 2, sourceConditionID: 1, supportCount: 1, opposeCount: 0 },
        { targetConditionID: 4, sourceConditionID: 2, supportCount: 1, opposeCount: 0 }
    ]);
    assert.deepEqual(pie.familyComposition, []);
});

test('community counts omit out-of-scope pairs and older undirected votes', async () => {
    const rows = [
        ...rowsForPie(1, [[1, 10000]], [vote(1, 2, 'support'), vote(1, 4, 'oppose'), vote(4, 2, 'oppose'),
            vote(99, 1, 'support'), vote(1, 99, 'support'), vote(1, 3, 'support'), { conditionID: 2, vote: 'oppose' }]),
        ...rowsForPie(2, [[3, 10000]], [vote(1, 2, 'oppose')]),
        ...rowsForPie(3, [[-20, 10000]], [vote(1, 2, 'oppose')]),
        ...rowsForPie(4, [], [vote(1, 2, 'oppose')]),
        ...rowsForPie(5, [[1, 10000]], [{ conditionID: 2, vote: 'oppose' }])
    ];
    const pie = await loadPublicPie(database(rows), scene, catalogue([[1, 10], [2, 10], [3, 20], [4, 10, true]]));
    assert.equal(pie.participantCount, 4);
    assert.deepEqual(pie.estimationVotes, [{ targetConditionID: 1, sourceConditionID: 2, supportCount: 1, opposeCount: 0 }]);
});

test('community counts preserve every voted sibling version and use a stable condition order', async () => {
    const siblingIDs = Array.from({ length: 130 }, (_, index) => index + 2);
    const conditions = catalogue([1, ...siblingIDs].map(ID => [ID, 10]));
    const ballots = siblingIDs.slice().reverse().map(ID => vote(1, ID, 'support'));
    const pie = await loadPublicPie(database(rowsForPie(1, [[1, 10000]], ballots)), scene, conditions);
    assert.deepEqual(pie.estimationVotes, siblingIDs.map(sourceConditionID => ({ targetConditionID: 1, sourceConditionID, supportCount: 1, opposeCount: 0 })));
});

test('malformed stored ballots fail the invariant without inflating counts', async () => {
    for (const votes of ['bad JSON', [vote(1, 2, 'support'), vote(1, 2, 'oppose')], [vote(1, 2, 'neutral')]]) {
        await assert.rejects(loadPublicPie(database(rowsForPie(1, [[1, 10000]], votes)), scene, catalogue()),
            error => error.status === 409 && error.body?.error === 'stored_estimation_votes_invalid' && error.body.pieID === 1);
    }
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
