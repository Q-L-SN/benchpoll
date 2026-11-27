import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLifecycleDatabase, seedLifecycleEvidence } from './helpers/lifecycle-mysql.mjs';
import { savePrivateTopic } from '../private-topic-service.js';
import { saveEstimationVote } from '../estimation-ballots.js';
import { createTopic } from '../topic-service.js';
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
        assert.deepEqual([row.lower, row.upper, row.coverage], [65, 65, 50]);
        assert.deepEqual(row.inferredScores.map(score => [score.conditionID, score.estimationMethod, score.normalizedScore, score.contribution]),
            [[2, 'peer-median', 50, 25]]);
        assert.deepEqual([row.availableInference.observedContribution, row.availableInference.unresolvedFraction], [40, 0]);
    }
    await assert.rejects(read({ estimationAlgorithm: 'missing-rational' }), error => error.body?.error === 'invalid_estimation_algorithm');
    assert.ok(rankingCache.stats.entries > 0);
    const partial = subject(await read({ scoreMode: 'range' }));
    assert.deepEqual([partial.lower, partial.upper, partial.coverage], [40, 90, 50]);
    const [after] = await pool.query('SELECT * FROM personal_pies');
    assert.deepEqual(after, before);
});

test('SQL external estimates need one paired peer in personal rankings and must beat both held-out errors in public rankings', { timeout: 60000 }, async t => {
    const db = await createLifecycleDatabase();
    t.after(() => db.close());
    const { pool } = db;
    await seedLifecycleEvidence(pool);
    const cases = [
        { ID: 4, name: 'Single paired peer', peerScores: [42], subjectScore: 42, expected: 20 },
        // Training median baseline: MAE 18.33, RMSE 19.36 in both six-peer samples.
        // This source improves MAE to 16.15 and worsens RMSE to 22.24.
        { ID: 5, name: 'Smaller absolute error', peerScores: [30, 50, 70, 60, 80, 30], subjectScore: 55, expected: 45.49865910083421 },
        // This source worsens MAE to 18.70 and improves RMSE to 19.07.
        { ID: 6, name: 'Smaller squared error', peerScores: [50, 40, 10, 90, 50, 70], subjectScore: 55, expected: 46.114892872432634 }
    ];
    await pool.execute('DELETE FROM benchmark_results');
    for (let modelID = 4; modelID <= 8; modelID++) {
        await pool.execute('INSERT INTO models (ID, vendor_ID, slug, name) VALUES (?, 1, ?, ?)',
            [modelID, 'model-' + modelID, 'Model ' + modelID]);
    }
    const score = (modelID, conditionID, value) => pool.execute(`INSERT INTO benchmark_results
        (model_ID, benchmark_ID, benchmark_condition_ID, raw_score, source_url, source_type, benchmark_condition_snapshot, score_fields)
        VALUES (?, ?, ?, ?, 'https://example.test/validation', 'vendor_official', '{}', '[]')`,
    [modelID, conditionID, conditionID, value]);
    await score(1, 2, 50);
    for (let modelID = 2; modelID <= 7; modelID++) {
        await score(modelID, 1, 10 * modelID);
        await score(modelID, 2, 50);
    }
    for (const { ID, name, peerScores, subjectScore } of cases) {
        await pool.execute('INSERT INTO benchmarks (ID, name) VALUES (?, ?)', [ID, name]);
        await pool.execute(`INSERT INTO benchmark_conditions
            (ID, benchmark_ID, condition_key, name, score_direction, uses_percentage_scale, is_default, is_primary)
            VALUES (?, ?, 'default', 'Default', 'higher', 1, 1, 1)`, [ID, ID]);
        await score(1, ID, subjectScore);
        for (const [index, value] of peerScores.entries()) await score(index + 2, ID, value);
    }

    // A source-only model makes the sparse benchmark selectable and contributes no paired evidence.
    await score(8, 4, 60);

    const topic = await createTopic(pool, '42', { name: 'External validation sample', description: 'Review estimator holdouts.', isPrivate: false });
    await savePersonalPie(pool, { userID: '42', writeIdentity: randomUUID(), categoryID: topic.ID, expectedRevision: 0,
        entries: [{ conditionID: 1, weightBasisPoints: 8000 }, { conditionID: 2, weightBasisPoints: 2000 }] });
    const rankingCache = createRankingReadCache();
    const read = (mode, cache) => getRankingWorkspace(pool, { userID: '42', categoryID: topic.ID, scoreMode: 'available',
        comparison: { mode, keys: ['model'] }, rankingCache: cache, jsonMemberMetadata: true });
    const subject = rows => rows.find(model => model.modelID === 1);

    for (const { ID, name, expected, peerScores, subjectScore } of cases) {
        const pair = { targetConditionID: 1, sourceConditionID: ID };
        await saveEstimationVote(pool, '42', randomUUID(), { ...pair, vote: 'support', nominate: true });
        for (const [mode, cache] of [['best', rankingCache], ['best', null], ['matched', rankingCache]]) {
            const { modelLeaderboards, externalEstimationPairs } = await read(mode, cache);
            assert.deepEqual(externalEstimationPairs, [pair]);
            const personal = subject(modelLeaderboards.personal);
            assert.equal(personal.inferredScores.length, 1, name);
            const [estimate] = personal.inferredScores;
            assert.ok(Math.abs(estimate.normalizedScore - expected) < 1e-10, name);
            assert.equal(estimate.sources.length, 1, name);
            const [{ sourceConditionID, sourceScore, referenceCount }] = estimate.sources;
            assert.deepEqual([sourceConditionID, referenceCount], [ID, peerScores.length], name);
            assert.ok(Math.abs(sourceScore - subjectScore) < 1e-10, name);
            const publicRow = subject(modelLeaderboards.public);
            assert.deepEqual([publicRow.lower, publicRow.coverage], [46, 20], name);
            assert.deepEqual(publicRow.inferredScores.map(score => [score.conditionID, score.estimationMethod, score.normalizedScore]),
                [[1, 'peer-median', 45]], name);
            assert.equal(publicRow.availableInference.unresolvedFraction, 0, name);
        }
        await saveEstimationVote(pool, '42', randomUUID(), { ...pair, vote: null });
    }
});

test('workspace reads and cached ballots carry treemap chains across an unselected version', async t => {
    const db = await createLifecycleDatabase();
    t.after(() => db.close());
    const { pool } = db;
    await seedLifecycleEvidence(pool);
    await pool.execute('DELETE FROM benchmark_results');
    await pool.execute(`INSERT INTO benchmark_conditions
        (ID, benchmark_ID, condition_key, name, score_direction, uses_percentage_scale, is_default, is_primary)
        VALUES (4, 2, 'secondary', 'Secondary', 'higher', 1, 0, 0)`);
    for (let id = 4; id <= 7; id++) {
        await pool.execute('INSERT INTO models (ID, vendor_ID, slug, name) VALUES (?, 1, ?, ?)', [id, `model-${id}`, `Model ${id}`]);
    }
    const saveScore = (model, condition, score) => pool.execute(`INSERT INTO benchmark_results
        (model_ID, benchmark_ID, benchmark_condition_ID, raw_score, source_url, source_type, benchmark_condition_snapshot, score_fields)
        VALUES (?, ?, ?, ?, 'https://example.test/versions', 'vendor_official', '{}', '[]')`,
    [model, condition === 4 ? 2 : condition, condition, score]);
    await saveScore(1, 4, 56);
    await saveScore(1, 3, 50);
    for (let model = 2; model <= 7; model++) {
        await saveScore(model, 4, model * 10);
        await saveScore(model, 2, model * 10 + 2);
        await saveScore(model, 1, model * 10 + 12);
        await saveScore(model, 3, 50);
    }
    const topic = await createTopic(pool, '42', { name: 'Version paths', description: 'Compare nominations.', isPrivate: false });
    await savePersonalPie(pool, { userID: '42', writeIdentity: randomUUID(), categoryID: topic.ID, expectedRevision: 0,
        entries: [{ conditionID: 1, weightBasisPoints: 6000 }, { conditionID: 2, weightBasisPoints: 3000 }, { conditionID: 3, weightBasisPoints: 1000 }] });
    await saveEstimationVote(pool, '42', randomUUID(), { targetConditionID: 1, sourceConditionID: 2, vote: 'support', nominate: true });
    const rankingCache = createRankingReadCache();
    const read = () => getRankingWorkspace(pool, { categoryID: topic.ID, userID: '42', scoreMode: 'available', rankingCache,
        comparison: { mode: 'matched', keys: ['model'] }, jsonMemberMetadata: true });
    const estimate = (workspace, scope) => workspace.modelLeaderboards[scope].find(row => row.modelID === 1)
        .inferredScores.find(score => score.conditionID === 1);
    const first = await read();
    const page = JSON.parse(JSON.stringify(createRankingPager().create(first, { userID: '42' })));
    validateWorkspacePayload(page);
    const wrongPath = estimate(page, 'public').sources[0].calibrationPaths[0];
    wrongPath[0].targetConditionID = 4;
    assert.throws(() => validateWorkspacePayload(page), /inferredScores/);
    for (const scope of ['public', 'personal']) {
        const line = estimate(first, scope);
        assert.equal(line.estimationMethod, 'treemap-chain');
        assert.deepEqual(line.sources.map(source => [source.sourceConditionID, source.calibrationPaths[0].map(step => step.targetConditionID)]), [[4, [2, 1]]]);
    }
    const pair = { targetConditionID: 2, sourceConditionID: 4 };
    await saveEstimationVote(pool, '43', randomUUID(), { ...pair, vote: 'support' });
    await saveEstimationVote(pool, '42', randomUUID(), { ...pair, vote: 'oppose' });
    const changed = await read();
    assert.equal(estimate(changed, 'public').estimationMethod, 'treemap-chain');
    assert.equal(estimate(changed, 'personal').estimationMethod, 'peer-median');
    assert.equal(estimate(changed, 'personal').normalizedScore, 57);
});
