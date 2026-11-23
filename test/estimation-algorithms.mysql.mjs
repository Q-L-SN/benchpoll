import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLifecycleDatabase, seedLifecycleEvidence } from './helpers/lifecycle-mysql.mjs';
import { savePrivateTopic } from '../private-topic-service.js';
import { savePersonalPie, getRankingWorkspace } from '../ranking-service.js';
import { createRankingReadCache } from '../ranking-read-cache.js';
import { DEFAULT_ESTIMATION_ALGORITHM, ESTIMATION_ALGORITHMS } from '../public/js/shared/estimation-algorithms.js';
import { createRankingPager } from '../ranking-pagination.js';
import { validateWorkspacePayload } from '../public/js/workspace/contracts.js';

test('actual workspace reads offer one estimation method and preserve the saved weights', async t => {
    const db = await createLifecycleDatabase(); t.after(() => db.close());
    const { pool } = db; await seedLifecycleEvidence(pool);
    const topic = await savePrivateTopic(pool, '42', { name: 'Estimation sample', description: 'Review an unresolved measurement.',
        scenes: [], defaultSceneKey: null }, randomUUID());
    await savePersonalPie(pool, { userID: '42', writeIdentity: randomUUID(), categoryID: topic.ID, contextValues: {}, expectedRevision: 0,
        entries: [{ conditionID: 1, weightBasisPoints: 5000 }, { conditionID: 2, weightBasisPoints: 5000 }] });
    await pool.execute('DELETE FROM benchmark_results WHERE model_ID = 1 AND benchmark_condition_ID = 2');
    const [before] = await pool.query('SELECT * FROM personal_pies');
    const rankingCache = createRankingReadCache();
    const read = options => getRankingWorkspace(pool, { userID: '42', categoryID: topic.ID, scoreMode: 'available',
        comparison: { mode: 'best', keys: ['model'] }, rankingCache, jsonMemberMetadata: true, ...options });
    const subject = workspace => workspace.modelLeaderboards.personal.find(model => model.modelID === 1);
    assert.deepEqual(ESTIMATION_ALGORITHMS.map(method => method.ID), [DEFAULT_ESTIMATION_ALGORITHM]);
    for (const options of [{}, { estimationAlgorithm: DEFAULT_ESTIMATION_ALGORITHM }, { rankingCache: null }]) {
        const result = await read(options);
        assert.equal(result.estimationAlgorithm, DEFAULT_ESTIMATION_ALGORITHM);
        const page = createRankingPager().create(result, { userID: '42', initialMode: 'personal' });
        validateWorkspacePayload(JSON.parse(JSON.stringify(page)));
        const row = subject(result);
        assert.deepEqual([row.lower, row.upper, row.coverage, row.inferredScores], [40, 40, 50, []]);
        assert.deepEqual([row.availableInference.observedContribution, row.availableInference.unresolvedFraction], [40, .5]);
    }
    await assert.rejects(read({ estimationAlgorithm: 'missing-rational' }), error => error.body?.error === 'invalid_estimation_algorithm');
    assert.ok(rankingCache.stats.entries > 0);
    const partial = subject(await read({ scoreMode: 'range' }));
    assert.deepEqual([partial.lower, partial.upper, partial.coverage], [40, 90, 50]);
    const [after] = await pool.query('SELECT * FROM personal_pies');
    assert.deepEqual(after, before);
});
