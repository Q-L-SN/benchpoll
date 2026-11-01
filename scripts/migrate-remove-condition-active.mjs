#!/usr/bin/env node

import 'dotenv/config';
import { initPool, pool } from '../db.js';
import { selectableBenchmarkConditionSQL } from '../benchmark-condition-visibility.js';

const apply = process.argv.includes('--apply');
if (process.argv.slice(2).some(arg => arg !== '--apply')) {
    throw new Error('Usage: node scripts/migrate-remove-condition-active.mjs [--apply]');
}

initPool(process.env.DB_PASSWORD);
const connection = await pool.getConnection();
try {
    const [columns] = await connection.query(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'benchmark_conditions'
          AND COLUMN_NAME IN ('is_active', 'deleted_at')`);
    const columnNames = new Set(columns.map(row => row.COLUMN_NAME));
    if (!columnNames.has('is_active')) {
        if (!columnNames.has('deleted_at')) throw new Error('Condition table has neither active nor deletion column.');
        if (apply) throw new Error('Condition active flag is already removed.');
        console.log(JSON.stringify({ alreadyMigrated: true }));
        process.exitCode = 0;
    } else {
        const [[state]] = await connection.query(`SELECT
            COUNT(*) AS conditions,
            SUM(c.is_active = 1) AS previouslySelectableConditions,
            SUM(c.is_active = 0) AS historicalConditions,
            SUM(c.is_active = 1 AND b.is_active = 1) AS previouslyVisible,
            SUM(b.is_active = 1 AND c.condition_key <> CONCAT('retired-', c.ID)) AS visibleAfter
            FROM benchmark_conditions c JOIN benchmarks b ON b.ID = c.benchmark_ID`);
        const [[retiredReferences]] = await connection.query(`SELECT
            (SELECT COUNT(*) FROM personal_pie_weights w JOIN benchmark_conditions c
                ON c.ID = w.benchmark_condition_ID WHERE c.condition_key = CONCAT('retired-', c.ID))
            + (SELECT COUNT(*) FROM personal_pie_score_rule_components f JOIN benchmark_conditions c
                ON c.ID = f.fallback_benchmark_condition_ID WHERE c.condition_key = CONCAT('retired-', c.ID))
            + (SELECT COUNT(*) FROM discussion_mentions m JOIN benchmark_conditions c
                ON c.ID = m.condition_ID WHERE c.condition_key = CONCAT('retired-', c.ID)) AS count`);
        const [[acceptedRetired]] = await connection.query(`SELECT COUNT(*) AS count FROM benchmark_results r
            JOIN benchmark_conditions c ON c.ID = r.benchmark_condition_ID
            WHERE c.condition_key = CONCAT('retired-', c.ID) AND r.status = 'accepted'`);
        const [[duplicateDefaults]] = await connection.query(`SELECT COUNT(*) AS count FROM (
            SELECT benchmark_ID FROM benchmark_conditions WHERE is_default = 1
            GROUP BY benchmark_ID HAVING COUNT(*) > 1) duplicates`);
        const counts = Object.fromEntries(Object.entries(state).map(([key, value]) => [key, Number(value)]));
        if (Number(acceptedRetired.count) || Number(retiredReferences.count) || Number(duplicateDefaults.count)) {
            throw new Error(`Migration preflight failed: ${JSON.stringify({ counts,
                acceptedRetired: acceptedRetired.count, retiredReferences: retiredReferences.count,
                duplicateDefaults: duplicateDefaults.count })}`);
        }
        console.log(JSON.stringify({ dryRun: !apply, counts }));
        if (apply) {
            if (!columnNames.has('deleted_at')) {
                await connection.query(`ALTER TABLE benchmark_conditions
                    ADD COLUMN deleted_at DATETIME NULL AFTER is_default`);
            }
            await connection.query(`UPDATE benchmark_conditions SET deleted_at = updated_at
                WHERE condition_key = CONCAT('retired-', ID)`);
            await connection.query(`ALTER TABLE benchmark_conditions
                MODIFY COLUMN default_marker TINYINT GENERATED ALWAYS AS
                    (CASE WHEN is_default = 1 THEN 1 ELSE NULL END) STORED`);
            const [activeChecks] = await connection.query(`SELECT tc.CONSTRAINT_NAME AS name
                FROM information_schema.TABLE_CONSTRAINTS tc
                JOIN information_schema.CHECK_CONSTRAINTS cc
                  ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
                 AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
                WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.TABLE_NAME = 'benchmark_conditions'
                  AND tc.CONSTRAINT_TYPE = 'CHECK' AND cc.CHECK_CLAUSE LIKE '%is_active%'`);
            if (activeChecks.length !== 1 || !/^[A-Za-z0-9_]+$/.test(activeChecks[0].name)) {
                throw new Error(`Expected exactly one condition-active check: ${JSON.stringify(activeChecks)}`);
            }
            await connection.query(`ALTER TABLE benchmark_conditions
                DROP INDEX idx_benchmark_conditions_active,
                DROP CHECK ${activeChecks[0].name},
                DROP COLUMN is_active,
                ADD INDEX idx_benchmark_conditions_name (benchmark_ID, deleted_at, name)`);
            const [[after]] = await connection.query(`SELECT
                COUNT(*) AS conditions,
                SUM(b.is_active = 1 AND ${selectableBenchmarkConditionSQL('c')}) AS visible
                FROM benchmark_conditions c JOIN benchmarks b ON b.ID = c.benchmark_ID`);
            if (Number(after.conditions) !== counts.conditions || Number(after.visible) !== counts.visibleAfter) {
                throw new Error(`Condition count or visibility changed: ${JSON.stringify(after)}`);
            }
            console.log(JSON.stringify({ applied: true, conditions: Number(after.conditions),
                visible: Number(after.visible) }));
        }
    }
} finally {
    connection.release();
    await pool.end();
}
