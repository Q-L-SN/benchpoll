#!/usr/bin/env node

import 'dotenv/config';
import assert from 'node:assert/strict';
import { initPool, pool } from '../db.js';
import { loadBenchmarkConditions, MIN_COMPARABLE_MODELS } from '../ranking-service.js';

initPool(process.env.DB_PASSWORD);
const connection = await pool.getConnection();
try {
    const start = performance.now();
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const conditions = await loadBenchmarkConditions(connection);
    const [[{ rawConditions }]] = await connection.execute(`
        SELECT COUNT(*) AS rawConditions
        FROM benchmark_conditions c
        JOIN benchmarks b ON b.ID = c.benchmark_ID
        WHERE c.deleted_at IS NULL AND b.is_active = 1`);
    const [preservedRows] = await connection.execute(`
        SELECT benchmark_condition_ID AS ID FROM personal_pie_weights
        UNION
        SELECT fallback_benchmark_condition_ID AS ID FROM personal_pie_score_rule_components`);
    const candidateIDs = new Set(conditions.map(condition => condition.conditionID));
    assert.equal(candidateIDs.size, conditions.length, 'Duplicate Pie candidates');
    for (const row of preservedRows) {
        assert.ok(candidateIDs.has(Number(row.ID)), `Stored Pie condition ${row.ID} became unavailable`);
    }
    const preservedIDs = new Set(preservedRows.map(row => Number(row.ID)));
    for (const condition of conditions) {
        assert.ok(condition.scoredModelCount >= MIN_COMPARABLE_MODELS || preservedIDs.has(condition.conditionID),
            `Unscored Pie candidate ${condition.conditionID} has no existing Pie reference`);
    }
    const coverage = conditions.map(condition => condition.scoredModelCount).sort((a, b) => a - b);
    const [[{ personalPies, personalWeights }]] = await connection.execute(`
        SELECT (SELECT COUNT(*) FROM personal_pies) AS personalPies,
               (SELECT COUNT(*) FROM personal_pie_weights) AS personalWeights`);
    const [weightedContexts] = await connection.execute(`
        SELECT ranking_contexts.category_ID AS categoryID,
               COUNT(DISTINCT personal_pies.ID) AS pies
        FROM personal_pies
        JOIN ranking_contexts ON ranking_contexts.ID = personal_pies.context_ID
        JOIN personal_pie_weights ON personal_pie_weights.pie_ID = personal_pies.ID
        GROUP BY ranking_contexts.category_ID
        ORDER BY pies DESC, ranking_contexts.category_ID
        LIMIT 10`);
    const report = {
        rawConditions: Number(rawConditions),
        selectableConditions: conditions.length,
        comparableConditions: conditions.filter(condition => condition.scoredModelCount >= MIN_COMPARABLE_MODELS).length,
        preservedLowCoverage: conditions.filter(condition => condition.scoredModelCount < MIN_COMPARABLE_MODELS).length,
        benchmarksWithCandidates: new Set(conditions.map(condition => condition.benchmarkID)).size,
        medianScoredModels: coverage[Math.floor(coverage.length / 2)],
        candidatesWithAtLeast10Models: coverage.filter(count => count >= 10).length,
        candidatesWithAtLeast25Models: coverage.filter(count => count >= 25).length,
        personalPies: Number(personalPies),
        personalWeights: Number(personalWeights),
        weightedContexts,
        elapsedMs: Math.round(performance.now() - start)
    };
    console.log(JSON.stringify(report, null, 2));
    await connection.commit();
} catch (error) {
    await connection.rollback();
    throw error;
} finally {
    connection.release();
    await pool.end();
}
