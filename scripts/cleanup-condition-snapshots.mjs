#!/usr/bin/env node
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { planSnapshotCleanup } from '../snapshot-condition-cleanup.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const connection = await mysql.createConnection({ socketPath: process.env.DB_SOCKET || '/var/run/mysqld/mysqld.sock',
    user: 'root', database: 'benchmarks', supportBigNumbers: true, bigNumberStrings: true });
const apply = process.argv.includes('--apply'), rehearse = process.argv.includes('--rehearse');
const reportPath = process.argv.find(arg => arg.startsWith('--report='))?.slice(9);
const expect = process.argv.find(arg => arg.startsWith('--expect='))?.slice(9);

async function evidenceDigest() {
    const digest = createHash('sha256');
    let cursor = 0, count = 0;
    while (true) {
        const [rows] = await connection.query('SELECT * FROM benchmark_results WHERE ID > ? ORDER BY ID LIMIT 3000', [cursor]);
        if (!rows.length) break;
        for (const row of rows) {
            const snapshot = typeof row.benchmark_condition_snapshot === 'string' ? JSON.parse(row.benchmark_condition_snapshot) : row.benchmark_condition_snapshot;
            const copy = { ...snapshot }; delete copy.conditionID;
            const result = { ...row, benchmark_condition_snapshot: copy }; delete result.benchmark_condition_ID;
            digest.update(JSON.stringify(result) + '\n'); count++;
        }
        cursor = rows.at(-1).ID;
    }
    return { count, sha256: digest.digest('hex') };
}

try {
    await connection.beginTransaction();
    const [references] = await connection.query(`SELECT table_name,column_name FROM information_schema.key_column_usage
        WHERE referenced_table_schema=DATABASE() AND referenced_table_name='benchmark_conditions'`);
    const expected = ['benchmark_results.benchmark_condition_ID', 'discussion_mentions.condition_ID',
        'personal_pie_score_rule_components.fallback_benchmark_condition_ID', 'personal_pie_weights.benchmark_condition_ID'].sort();
    if (JSON.stringify(references.map(row => `${row.TABLE_NAME}.${row.COLUMN_NAME}`).sort()) !== JSON.stringify(expected)) {
        throw new Error('Unreviewed condition reference table');
    }
    const [conditions] = await connection.query(`SELECT c.*, COUNT(r.ID) score_count FROM benchmark_conditions c
        LEFT JOIN benchmark_results r ON r.benchmark_condition_ID=c.ID GROUP BY c.ID ORDER BY c.ID`);
    const [referencesInPies] = await connection.query(`SELECT benchmark_condition_ID ID FROM personal_pie_weights
        UNION SELECT fallback_benchmark_condition_ID ID FROM personal_pie_score_rule_components`);
    const plan = planSnapshotCleanup(conditions, new Set(referencesInPies.map(row => Number(row.ID))));
    const planDigest = hash(plan);
    const report = { applied: false, rehearsed: false, renamed: plan.updates.length, merged: plan.merges.length,
        blocked: plan.blocked.length, planDigest, plan };
    if (apply || rehearse) {
        if (!expect || expect !== planDigest) throw new Error('Plan changed or expected digest not provided');
        const [[pending]] = await connection.query(`SELECT COUNT(*) count FROM moderation_logs WHERE status='pending'`);
        if (Number(pending.count)) throw new Error('Pending contributions must be resolved before condition cleanup');
        const before = await evidenceDigest();
        const [pieBefore] = await connection.query('SELECT * FROM personal_pie_weights ORDER BY pie_ID, benchmark_condition_ID');
        const [rulesBefore] = await connection.query('SELECT * FROM personal_pie_score_rule_components ORDER BY pie_ID,primary_benchmark_condition_ID,fallback_benchmark_condition_ID');
        for (const merge of plan.merges) {
            const [result] = await connection.execute(`UPDATE benchmark_results SET benchmark_condition_ID=?,
                benchmark_condition_snapshot=JSON_SET(benchmark_condition_snapshot,'$.conditionID',?), updated_at=updated_at
                WHERE benchmark_condition_ID=?`, [merge.targetID, merge.targetID, merge.sourceID]);
            if (result.affectedRows !== merge.resultCount) throw new Error('Result count changed during merge');
            await connection.execute('UPDATE discussion_mentions SET condition_ID=? WHERE condition_ID=?', [merge.targetID, merge.sourceID]);
            const [removed] = await connection.execute('DELETE FROM benchmark_conditions WHERE ID=?', [merge.sourceID]);
            if (removed.affectedRows !== 1) throw new Error('Condition merge did not delete exactly one condition');
        }
        for (const update of plan.updates) {
            await connection.execute(`UPDATE benchmark_conditions SET name=?,condition_key=?,is_default=?,updated_at=updated_at WHERE ID=?`,
                [update.name, update.key, Number(update.isDefault), update.ID]);
        }
        const after = await evidenceDigest();
        if (hash(before) !== hash(after)) throw new Error('Score/source/metadata preservation failed');
        const [pieAfter] = await connection.query('SELECT * FROM personal_pie_weights ORDER BY pie_ID, benchmark_condition_ID');
        const [rulesAfter] = await connection.query('SELECT * FROM personal_pie_score_rule_components ORDER BY pie_ID,primary_benchmark_condition_ID,fallback_benchmark_condition_ID');
        if (hash(pieBefore) !== hash(pieAfter) || hash(rulesBefore) !== hash(rulesAfter)) throw new Error('Personal weights changed');
        const [[remaining]] = await connection.query(`SELECT COUNT(*) count FROM benchmark_conditions
            WHERE LOWER(name) LIKE '%snapshot%' OR LOWER(condition_key) LIKE '%snapshot%'`);
        const [[stale]] = await connection.query(`SELECT COUNT(*) count FROM benchmark_results
            WHERE CAST(JSON_UNQUOTE(JSON_EXTRACT(benchmark_condition_snapshot,'$.conditionID')) AS UNSIGNED)<>benchmark_condition_ID`);
        if (Number(remaining.count) || Number(stale.count)) throw new Error('Snapshot cleanup verification failed');
        report.evidence = before;
        if (apply) { await connection.commit(); report.applied = true; }
        else { await connection.rollback(); report.rehearsed = true; }
    } else await connection.rollback();
    if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, plan: undefined }));
} catch (error) { await connection.rollback(); throw error; }
finally { await connection.end(); }
