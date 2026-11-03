import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLifecycleDatabase, seedLifecycleEvidence } from './helpers/lifecycle-mysql.mjs';
import { savePrivateTopic } from '../private-topic-service.js';
import { savePersonalPie, getRankingWorkspace } from '../ranking-service.js';
import { createRankingReadCache } from '../ranking-read-cache.js';
import { ESTIMATION_ALGORITHMS } from '../public/js/shared/estimation-algorithms.js';
import { createRankingPager } from '../ranking-pagination.js';
import { validateWorkspacePayload } from '../public/js/workspace/contracts.js';

test('actual workspace reads isolate algorithms in the shared cache and never mutate saved weights', async t => {
    const db = await createLifecycleDatabase(); t.after(() => db.close());
    const { pool } = db; await seedLifecycleEvidence(pool);
    await pool.execute("INSERT INTO models (ID, vendor_ID, slug, name) VALUES (4, 1, 'model-4', 'Model 4')");
    for (const condition of [1, 2, 3]) await pool.execute(`INSERT INTO benchmark_results (model_ID, benchmark_ID,
        benchmark_condition_ID, raw_score, source_url, source_type, benchmark_condition_snapshot, score_fields)
        VALUES (4, ?, ?, 70, 'https://example.test/results', 'vendor_official', '{}', '[]')`, [condition, condition]);
    await pool.execute('DELETE FROM benchmark_results WHERE model_ID = 1 AND benchmark_condition_ID = 2');
    const topic = await savePrivateTopic(pool, '42', { name: 'Algorithm trial', description: 'Compare missing-score assumptions.',
        scenes: [], defaultSceneKey: null }, randomUUID());
    await savePersonalPie(pool, { userID: '42', writeIdentity: randomUUID(), categoryID: topic.ID, contextValues: {}, expectedRevision: 0,
        entries: [{ conditionID: 1, weightBasisPoints: 5000 }, { conditionID: 2, weightBasisPoints: 5000 }], fallbackRules: [] });
    const [before] = await pool.query('SELECT * FROM personal_pies');
    const cache = createRankingReadCache(), results = new Map();
    for (const { ID: estimationAlgorithm } of [...ESTIMATION_ALGORITHMS, ...ESTIMATION_ALGORITHMS].reverse()) {
        const result = await getRankingWorkspace(pool, { userID: '42', categoryID: topic.ID, scoreMode: 'available', estimationAlgorithm,
            comparison: { mode: 'best', keys: ['model'] }, rankingCache: cache, jsonMemberMetadata: true });
        assert.equal(result.estimationAlgorithm, estimationAlgorithm);
        const page = createRankingPager().create(result, { userID: '42', initialMode: 'personal' });
        validateWorkspacePayload(JSON.parse(JSON.stringify(page)));
        const row = result.modelLeaderboards.personal.find(model => model.modelID === 1);
        if (results.has(estimationAlgorithm)) assert.equal(row.lower, results.get(estimationAlgorithm));
        results.set(estimationAlgorithm, row.lower);
        if (estimationAlgorithm !== 'current') {
            assert.equal(row.availableInference.observedContribution, 40);
            assert.ok(row.lower >= 40 && row.lower <= 90);
        }
    }
    assert.notEqual(results.get('current'), results.get('missing-rational'));
    assert.ok(cache.stats.entries > 0);
    const [after] = await pool.query('SELECT * FROM personal_pies');
    assert.deepEqual(after, before);
});
