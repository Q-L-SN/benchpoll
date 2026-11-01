import 'dotenv/config';
import mysql from 'mysql2/promise';
import { open, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isAACondition } from '../public/js/shared/aa-ranking-policy.js';

export function buildCleanupPlan({ conditions, pies, weights, rules, members, proposals }) {
    const excluded = new Set(conditions.filter(isAACondition).map(row => Number(row.condition_ID)));
    const excludedPrimary = new Set(weights.filter(row => excluded.has(Number(row.benchmark_condition_ID)))
        .map(row => `${row.pie_ID}:${row.benchmark_condition_ID}`));
    const aaFamilies = new Set(members.filter(row => row.benchmark_condition_ID != null && excluded.has(Number(row.benchmark_condition_ID)))
        .map(row => String(row.family_ID)));
    if (rules.some(row => aaFamilies.has(String(row.family_ID)) && !excludedPrimary.has(`${row.pie_ID}:${row.primary_benchmark_condition_ID}`))) {
        throw new Error('AA fallback in an otherwise retained family requires separate review');
    }
    const pieIDs = new Set(weights.filter(row => excluded.has(Number(row.benchmark_condition_ID))).map(row => String(row.pie_ID)));
    const changes = [];
    for (const pieID of pieIDs) {
        if (!pies.some(row => String(row.ID) === pieID)) throw new Error('Missing personal pie');
        const entries = weights.filter(row => String(row.pie_ID) === pieID);
        if (entries.reduce((sum, row) => sum + Number(row.weight_basis_points), 0) !== 10000) throw new Error('Invalid existing pie total');
        const removed = entries.filter(row => excluded.has(Number(row.benchmark_condition_ID)));
        const retained = entries.filter(row => !excluded.has(Number(row.benchmark_condition_ID)));
        const total = retained.reduce((sum, row) => sum + Number(row.weight_basis_points), 0);
        const distributed = retained.map((row, index) => {
            const exact = Number(row.weight_basis_points) * 10000 / total;
            return { row, index, weight: Math.floor(exact), fraction: exact - Math.floor(exact) };
        });
        let remainder = 10000 - distributed.reduce((sum, entry) => sum + entry.weight, 0);
        for (const entry of [...distributed].sort((a, b) => b.fraction - a.fraction || a.index - b.index)) {
            if (remainder-- > 0) entry.weight++;
        }
        changes.push({ pieID, removed, retained: distributed });
    }
    const withdrawn = proposals.filter(row => row.withdrawn_at != null);
    if (withdrawn.some(row => row.status !== 'open' || row.moderation_log_ID != null || row.topic_ID != null)) {
        throw new Error('A withdrawn proposal is linked to review or a topic');
    }
    return { excluded, changes, withdrawn };
}

async function run() {
    const apply = process.argv.includes('--apply');
    const backup = process.argv.find(arg => arg.startsWith('--backup='))?.slice('--backup='.length);
    if (apply && (!backup || !/^\/home\/ubuntu\/benchpoll-code-backups\/aa-ranking-cleanup-20261029-\d+\.json$/.test(backup))) {
        throw new Error('An approved absolute backup path is required');
    }
    const db = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
        host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
        user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', supportBigNumbers: true, bigNumberStrings: true, dateStrings: true });
    let locked = false;
    try {
        const [[lock]] = await db.query("SELECT GET_LOCK('benchpoll-aa-cleanup-20261029', 10) AS acquired");
        if (Number(lock.acquired) !== 1) throw new Error('Could not acquire cleanup lock');
        locked = true;
        await db.beginTransaction();
        const [conditions] = await db.query(`SELECT c.ID AS condition_ID, c.condition_key, c.name AS condition_name, b.name AS benchmarkName
            FROM benchmark_conditions c JOIN benchmarks b ON b.ID = c.benchmark_ID`);
        const tables = ['personal_pies', 'personal_pie_weights', 'personal_pie_score_rules', 'benchmark_families',
            'benchmark_family_members', 'topic_proposals', 'topic_proposal_votes'];
        const snapshot = { conditions };
        for (const table of tables) [snapshot[table]] = await db.query(`SELECT * FROM ${table} FOR UPDATE`);
        const plan = buildCleanupPlan({ conditions, pies: snapshot.personal_pies, weights: snapshot.personal_pie_weights,
            rules: snapshot.personal_pie_score_rules, members: snapshot.benchmark_family_members, proposals: snapshot.topic_proposals });
        if (!apply) { await db.rollback(); console.log(JSON.stringify({ dryRun: true, excludedConditions: plan.excluded.size,
            pies: plan.changes.length, removedSectors: plan.changes.reduce((sum, item) => sum + item.removed.length, 0), withdrawn: plan.withdrawn.length })); return; }
        const [foreignKeys] = await db.query(`SELECT TABLE_NAME, REFERENCED_TABLE_NAME, DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
            WHERE CONSTRAINT_SCHEMA = DATABASE() AND ((TABLE_NAME = 'personal_pie_score_rules' AND REFERENCED_TABLE_NAME = 'personal_pie_weights')
            OR (TABLE_NAME = 'topic_proposal_votes' AND REFERENCED_TABLE_NAME = 'topic_proposals'))`);
        if (!['personal_pie_score_rules', 'topic_proposal_votes'].every(table => foreignKeys.some(key => key.TABLE_NAME === table && key.DELETE_RULE === 'CASCADE'))) {
            throw new Error('Expected cascade constraints are missing');
        }
        await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
        const file = await open(backup, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify({ createdAt: new Date().toISOString(), snapshot })); await file.sync(); }
        finally { await file.close(); }
        for (const change of plan.changes) {
            for (const row of change.removed) {
                const [result] = await db.execute('DELETE FROM personal_pie_weights WHERE pie_ID = ? AND benchmark_condition_ID = ? AND weight_basis_points = ?',
                    [change.pieID, row.benchmark_condition_ID, row.weight_basis_points]);
                if (result.affectedRows !== 1) throw new Error('Pie changed during cleanup');
            }
            for (const { row, weight } of change.retained) {
                const [result] = await db.execute('UPDATE personal_pie_weights SET weight_basis_points = ?, updated_at = updated_at WHERE pie_ID = ? AND benchmark_condition_ID = ?',
                    [weight, change.pieID, row.benchmark_condition_ID]);
                if (result.affectedRows !== 1) throw new Error('Retained sector changed during cleanup');
            }
            const [result] = await db.execute('UPDATE personal_pies SET revision = revision + 1, updated_at = updated_at WHERE ID = ?', [change.pieID]);
            if (result.affectedRows !== 1) throw new Error('Pie missing during cleanup');
        }
        for (const proposal of plan.withdrawn) {
            const [result] = await db.execute("DELETE FROM topic_proposals WHERE ID = ? AND withdrawn_at IS NOT NULL AND status = 'open' AND moderation_log_ID IS NULL AND topic_ID IS NULL", [proposal.ID]);
            if (result.affectedRows !== 1) throw new Error('Withdrawn proposal changed during cleanup');
        }
        await db.commit();
        console.log(JSON.stringify({ applied: true, backup, pies: plan.changes.length,
            removedSectors: plan.changes.reduce((sum, item) => sum + item.removed.length, 0), withdrawn: plan.withdrawn.length }));
    } catch (error) { await db.rollback().catch(() => {}); throw error; }
    finally { if (locked) await db.query("SELECT RELEASE_LOCK('benchpoll-aa-cleanup-20261029')").catch(() => {}); await db.end(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await run();
