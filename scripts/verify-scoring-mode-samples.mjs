import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { initPool, pool } from '../db.js';
import { getRankingWorkspace } from '../ranking-service.js';

function evidence(rows) {
    return rows.map(row => ({ ID: row.ID, comparable: row.comparable, members: row.members,
        coverage: row.coverage, resultCount: row.resultCount, missingWeight: row.missingWeight,
        fallbackUsageCount: row.fallbackUsageCount, fallbackResolutions: row.fallbackResolutions,
        comparisonScores: row.comparisonScores,
        calculationScores: row.calculationScores.map(score => {
            const sample = { ...score };
            delete sample.effectiveWeight;
            delete sample.contribution;
            return sample;
        }) })).sort((a, b) => a.ID - b.ID);
}
initPool(process.env.DB_PASSWORD);
const connection = await pool.getConnection();
try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const db = { getConnection: async () => new Proxy(connection, { get(target, key) {
        if (['commit', 'rollback', 'release'].includes(key)) return async () => {};
        if (key === 'query') return async (sql, ...args) => {
            if (/^(SET TRANSACTION|START TRANSACTION)/.test(sql)) return [];
            return target.query(sql, ...args);
        };
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
    } }) };
    const initial = await getRankingWorkspace(db);
    const conditionIDs = initial.benchmarks.filter(row => row.scoreCount > 0)
        .sort((a, b) => b.scoreCount - a.scoreCount).slice(0, 3).map(row => row.conditionID);
    assert.ok(conditionIDs.length >= 3, 'Three scored conditions are required for the production audit');
    const previewPersonalPie = { entries: conditionIDs.slice(0, 2).map(conditionID => ({ conditionID, weightBasisPoints: 5000 })),
        fallbackRules: [{ primaryConditionID: conditionIDs[0], mode: 'fallback_if_missing',
            entries: [{ conditionID: conditionIDs[2], weightBasisPoints: 10000 }] }] };
    const scenarios = [
        { mode: 'best', keys: ['model'] },
        { mode: 'matched', keys: ['model'] }
    ];
    const harness = initial.comparison.fields.find(field => /harness/i.test(field.name));
    if (harness) scenarios.push({ mode: 'best', keys: ['model', `field:${harness.ID}`] });
    const results = [];
    for (const comparison of scenarios) {
        const options = { categoryID: initial.context.categoryID, contextValues: initial.context.contextValues,
            comparison, previewPersonalPie };
        const range = await getRankingWorkspace(db, { ...options, scoreMode: 'range' });
        const available = await getRankingWorkspace(db, { ...options, scoreMode: 'available' });
        assert.deepEqual(range.personalPie, available.personalPie);
        assert.deepEqual(range.publicPie, available.publicPie);
        assert.deepEqual(range.comparison, available.comparison);
        for (const list of ['personal', 'public']) {
            const samples = evidence(range.modelLeaderboards[list]);
            assert.deepEqual(samples, evidence(available.modelLeaderboards[list]), `${comparison.mode}/${list} changed samples or eligibility`);
            results.push({ comparison, list, models: samples.length,
                comparable: samples.filter(row => row.comparable).length,
                partialCoverage: samples.filter(row => row.comparable && row.missingWeight > 0).length,
                sampleHash: createHash('sha256').update(JSON.stringify(samples)).digest('hex'), identicalSamples: true });
        }
    }
    console.log(JSON.stringify({ passed: true, categoryID: initial.context.categoryID, conditionIDs, readOnly: true, results }));
} finally { await connection.rollback(); connection.release(); await pool.end(); }
