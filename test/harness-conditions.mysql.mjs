import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLifecycleDatabase } from './helpers/lifecycle-mysql.mjs';
import { harnessReview, seedHarnessReview } from './helpers/harness-conditions-fixture.mjs';
import { previewHarnessSplit, applyHarnessSplit, readHarnessState } from '../scripts/split-arc-harness-conditions-20261103.mjs';
import { canonicalJSON } from '../benchmark-harness-split.js';
import { getBenchmarkScores } from '../benchmark-scores.js';
import { getBenchmarkInformation } from '../benchmark-details.js';
import { savePrivateTopic } from '../private-topic-service.js';
import { getRankingWorkspace, savePersonalPie } from '../ranking-service.js';
import { createRankingReadCache } from '../ranking-read-cache.js';

test('611 public scores: guarded transactional split preserves evidence and saved weights, updates actual ranking and is repeatable', async t => {
    const database = await createLifecycleDatabase(); let connection;
    t.after(async () => { connection?.release(); await database.close(); });
    const { pool } = database; await seedHarnessReview(pool);
    await pool.execute(`INSERT INTO benchmark_conditions (ID, benchmark_ID, condition_key, name, score_direction, uses_percentage_scale)
        VALUES (900000, 1028, 'unrelated-public', 'Separate public tasks', 'higher', 1)`);
    for (const [ID, condition, status] of [[900000, 22186, 'archived'], [900001, 900000, 'accepted']]) {
        await pool.execute(`INSERT INTO benchmark_results (ID, model_ID, benchmark_ID, benchmark_condition_ID, raw_score,
            source_url, source_type, benchmark_condition_snapshot, score_fields, status)
            VALUES (?, 541, 1028, ?, 12.345678, 'https://example.test/unrelated', 'other', '{"original":true}', '[]', ?)`, [ID, condition, status]);
    }
    connection = await pool.getConnection();
    const topic = await savePrivateTopic(pool, '42', { name: 'Harness review', description: 'Local ARC-AGI-3 rehearsal.', scenes: [], defaultSceneKey: null }, randomUUID());
    await savePersonalPie(pool, { userID: '42', writeIdentity: randomUUID(), categoryID: topic.ID, contextValues: {}, expectedRevision: 0,
        entries: [{ conditionID: 22186, weightBasisPoints: 10000 }], fallbackRules: [] });
    const rankingCache = createRankingReadCache();
    const ranking = () => getRankingWorkspace(pool, { userID: '42', categoryID: topic.ID, scoreMode: 'available',
        comparison: { mode: 'best', keys: ['model'] }, rankingCache });
    const [weightsBefore] = await pool.query('SELECT * FROM personal_pie_weights');
    const [piesBefore] = await pool.query('SELECT * FROM personal_pies');
    const beforeRanking = await ranking();
    assert.equal(beforeRanking.modelLeaderboards.personal.find(row => row.modelID === 541).lower, 99.95);
    const before = await readHarnessState(connection, harnessReview);
    const plan = await previewHarnessSplit(connection, harnessReview);
    assert.deepEqual(plan.blockers, []);
    const [pending] = await pool.execute(`INSERT INTO moderation_logs (content, report_count, user_id)
        VALUES ('{"type":"entity_change","targetKind":"benchmark","targetID":1028}', 0, 42)`);
    assert.ok((await previewHarnessSplit(connection, harnessReview)).blockers.some(row => row.code === 'pending_target_moderation'));
    await pool.execute('DELETE FROM moderation_logs WHERE ID = ?', [pending.insertId]);
    await assert.rejects(applyHarnessSplit(connection, harnessReview, { expectedPlanHash: '0'.repeat(64) }), /stale/);
    await assert.rejects(applyHarnessSplit(connection, harnessReview, { expectedPlanHash: plan.planHash,
        beforeCommit: () => { throw new Error('receipt storage unavailable'); } }), /receipt storage unavailable/);
    assert.equal(canonicalJSON(await readHarnessState(connection, harnessReview)), canonicalJSON(before), 'A failed durable receipt rolls back every mutation');
    const rehearsal = await applyHarnessSplit(connection, harnessReview, { expectedPlanHash: plan.planHash, rehearse: true });
    assert.equal(rehearsal.applied, false);
    assert.equal(canonicalJSON(await readHarnessState(connection, harnessReview)), canonicalJSON(before));
    const receipt = await applyHarnessSplit(connection, harnessReview, { expectedPlanHash: plan.planHash });
    assert.equal(receipt.applied, true);
    assert.equal(receipt.changed.filter(row => row.from !== row.to).length, 71);
    for (const ID of [900000, 900001]) assert.equal(canonicalJSON(receipt.after.results.find(row => Number(row.ID) === ID)),
        canonicalJSON(receipt.before.results.find(row => Number(row.ID) === ID)), 'Archived and unrelated records remain byte-equivalent after JSON decoding');
    const afterRanking = await ranking();
    const bestStandard = Math.max(...harnessReview.targets.find(row => row.benchmarkID === 1028).scores
        .filter(row => row.modelID === 541 && row.bucket === 'standard').map(row => row.rawScore));
    assert.equal(afterRanking.modelLeaderboards.personal.find(row => row.modelID === 541).lower, Number(bestStandard.toFixed(2)));
    const scores = await getBenchmarkScores(pool, { benchmarkID: 1028, conditionID: 22186 });
    assert.equal(scores.scores.length, 45);
    assert.equal(scores.conditions.find(row => row.ID === 22186).isPrimary, true);
    assert.equal(scores.conditions.find(row => row.name.startsWith('Provider Adapter')).scoreCount, 16);
    assert.ok(scores.scores.every(row => row.fields.some(field => field.name === 'Harness' && field.value === 'Standard')));
    const information = await getBenchmarkInformation(pool, { conditionID: 22186 });
    assert.equal(information.conditionName, 'Standard harness · Semi-private');
    assert.match(information.differenceExplanation, /Provider Adapter results are separate/);
    const [weightsAfter] = await pool.query('SELECT * FROM personal_pie_weights');
    const [piesAfter] = await pool.query('SELECT * FROM personal_pies');
    assert.deepEqual(weightsAfter, weightsBefore); assert.deepEqual(piesAfter, piesBefore);
    const again = await previewHarnessSplit(connection, harnessReview);
    assert.equal(again.canApply, true); assert.equal(again.mutations, 0);
    assert.equal((await applyHarnessSplit(connection, harnessReview, { expectedPlanHash: again.planHash })).changed.length, 0);
    // A newly accepted score cannot be silently assigned from its URL or missing harness.
    await pool.execute(`INSERT INTO benchmark_results (model_ID, benchmark_ID, benchmark_condition_ID, raw_score,
        source_url, source_type, benchmark_condition_snapshot, score_fields) VALUES (541, 1028, 22186, 1,
        'https://arcprize.org/leaderboard', 'other', '{}', '[]')`);
    const stale = await previewHarnessSplit(connection, harnessReview);
    assert.ok(stale.blockers.some(row => row.code === 'unreviewed_score'));
    await assert.rejects(applyHarnessSplit(connection, harnessReview, { expectedPlanHash: stale.planHash }), /blocked/);
});
