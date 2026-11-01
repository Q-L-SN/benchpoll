import assert from 'node:assert/strict';
import dotenv from '/home/ubuntu/benchpoll/node_modules/dotenv/lib/main.js';
import mysql from '/home/ubuntu/benchpoll/node_modules/mysql2/promise.js';

const stage = process.argv[2];
if (!/^\/home\/ubuntu\/benchpoll\/scripts\/benchmark-policy-20261031\/benchmark-policy-20261031-\d+$/.test(stage)) {
    throw new Error('Invalid candidate stage');
}
dotenv.config({ path: '/home/ubuntu/benchpoll/.env', quiet: true });
const pool = mysql.createPool({
    socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
    host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', charset: 'utf8mb4', connectionLimit: 2
});
const { getBenchmarkInformation } = await import(`${stage}/candidate/benchmark-details.js`);
const { getBenchmarkScores } = await import(`${stage}/candidate/benchmark-scores.js`);
const { loadApprovedModelConfigurations, loadModels } = await import(`${stage}/candidate/ranking-service.js`);
const { isAACondition } = await import(`${stage}/candidate/public/js/shared/aa-ranking-policy.js`);
const connection = await pool.getConnection();
try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const restricted = [8411, 13813, 25125, 25126, 2255, 25711, 4191, 9399, 25318, 25703, 25704, 25705, 25706, 25707, 25715];
    for (const conditionID of restricted) {
        const information = await getBenchmarkInformation(connection, { conditionID });
        assert.equal(information.displayRestriction, 'artificial_analysis');
        assert.equal(information.description, '');
        const scores = await getBenchmarkScores(pool, { benchmarkID: information.benchmarkID, conditionID });
        assert.equal(scores.displayRestriction, 'artificial_analysis');
        assert.equal(scores.conditions.find(row => row.ID === conditionID).scoreCount, null);
        assert.deepEqual(scores.scores, []);
    }
    const independent = await getBenchmarkScores(pool, { benchmarkID: 1428, conditionID: 689 });
    assert.equal(independent.displayRestriction, null);
    assert.ok(independent.scores.length > 0);
    const modelIDs = [...new Set(independent.scores.map(row => row.modelID))].slice(0, 3);
    const start = Date.now();
    const index = await loadApprovedModelConfigurations(connection, modelIDs, null, { includeVersions: true, includeDisplayRestrictions: true });
    assert.ok(index.configurations.length > 0);
    assert.ok(index.omittedConfigurations.length > 0);
    for (const configuration of index.configurations) {
        assert.equal(configuration.scoreCount, configuration.scoreGroups.reduce((sum, group) => sum + group.sampleCount, 0));
        assert.ok(configuration.scoreGroups.every(group => !isAACondition(group)));
    }
    const configurationMilliseconds = Date.now() - start;
    const rankingStart = Date.now();
    const models = await loadModels(connection, null, { conditionIDs: [22187], evidenceConditionIDs: [22187] });
    assert.ok(models.some(model => model.results.has('22187')));
    for (const model of models) {
        if (model.condition.scoreFields.some(field => field.fieldID === 59 && field.value === 'Artificial Analysis')) {
            assert.equal(model.results.has('22187'), false, model.name);
        }
    }
    const rankingMilliseconds = Date.now() - rankingStart;
    const mixed = await getBenchmarkScores(pool, { benchmarkID: 1786, conditionID: 22187 });
    assert.equal(mixed.omittedScores, true);
    assert.ok(mixed.scores.length > 0);
    assert.ok(mixed.scores.every(row => !row.fields.some(field => field.name === 'Published evaluation provider' && field.value === 'Artificial Analysis')));
    await connection.commit();
    console.log(JSON.stringify({ readOnly: true, restrictedVersions: restricted, independentVersion: 689,
        modelIDs, configurations: index.configurations.length, omittedConfigurations: index.omittedConfigurations.length,
        configurationMilliseconds, rankingMilliseconds, mixedVersion: 22187,
        mixedVisibleScores: mixed.conditions.find(condition => condition.ID === 22187).scoreCount }));
} catch (error) { await connection.rollback(); throw error; }
finally { connection.release(); await pool.end(); }
