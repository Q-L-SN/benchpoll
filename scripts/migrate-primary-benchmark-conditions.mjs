#!/usr/bin/env node
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { chooseInitialPrimaryCondition } from '../benchmark-primary-condition.js';

export function upgradeBenchmarkModerationContent(content, primaryByBenchmarkID, describeChanges) {
    if (content.schemaVersion !== 5 || !(content.type === 'new_benchmark'
        || (content.type === 'entity_change' && content.targetKind === 'benchmark'))) return null;
    const upgraded = structuredClone(content);
    const assign = (conditions, preferredID, appended = false) => {
        if (!conditions?.length) throw new Error('Historical benchmark request has no conditions');
        const choice = appended ? null : (preferredID === undefined ? undefined : conditions.find(condition => condition.ID === preferredID))
            ?? chooseInitialPrimaryCondition(conditions.map((condition, index) => ({ ...condition,
                ID: condition.ID ?? index + 1, scoreCount: 0, scoredModelCount: 0 })));
        for (const [index, condition] of conditions.entries()) {
            condition.isPrimary = choice !== null && (condition.ID ?? index + 1) === choice.ID;
        }
        return choice?.ID;
    };
    if (content.type === 'new_benchmark') {
        for (const benchmark of upgraded.benchmarks) {
            assign(benchmark.conditions, undefined, benchmark.existingBenchmarkID !== null || benchmark.existingBenchmarkRef !== null);
        }
    } else {
        const beforeID = assign(upgraded.before.conditions, primaryByBenchmarkID.get(upgraded.targetID));
        if (upgraded.after) {
            assign(upgraded.after.conditions, beforeID);
            upgraded.changes = describeChanges(upgraded.before, upgraded.after);
        }
    }
    upgraded.schemaVersion = 6;
    return upgraded;
}

export function repairHistoricalBenchmarkDefaultFlags(content, describeChanges) {
    if (!(content.type === 'new_benchmark'
        || (content.type === 'entity_change' && content.targetKind === 'benchmark'))) return null;
    const repaired = structuredClone(content);
    const sets = content.type === 'new_benchmark'
        ? repaired.benchmarks.map(benchmark => benchmark.conditions)
        : [repaired.before.conditions, ...(repaired.after ? [repaired.after.conditions] : [])];
    let changed = false;
    for (const conditions of sets) {
        for (const condition of conditions) {
            const isDefault = condition.name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US') === 'default';
            if (condition.isDefault === isDefault) continue;
            condition.isDefault = isDefault;
            changed = true;
        }
    }
    if (!changed) return null;
    if (repaired.type === 'entity_change' && repaired.after) repaired.changes = describeChanges(repaired.before, repaired.after);
    return repaired;
}

async function loadChangeDiff() {
    const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
    const start = source.indexOf('function canonicalChangeValue(');
    const end = source.indexOf('function entityChildSetChanges(', start);
    if (start < 0 || end <= start) throw new Error('The canonical change diff was not found');
    const context = vm.createContext();
    vm.runInContext(source.slice(start, end) + '\nthis.diff = describeEntityChanges;', context);
    return context.diff;
}

export async function migratePrimaryBenchmarkConditions(db) {
    const describeChanges = await loadChangeDiff();
    const [[column]] = await db.query(`SELECT COUNT(*) count FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'benchmark_conditions' AND column_name = 'is_primary'`);
    if (!Number(column.count)) {
        await db.query(`ALTER TABLE benchmark_conditions
            ADD COLUMN is_primary TINYINT(1) NOT NULL DEFAULT 0,
            ADD COLUMN primary_marker TINYINT GENERATED ALWAYS AS
                (CASE WHEN is_primary = 1 AND deleted_at IS NULL THEN 1 ELSE NULL END) STORED,
            ADD UNIQUE KEY uq_benchmark_condition_primary (benchmark_ID, primary_marker),
            ADD CONSTRAINT chk_benchmark_condition_primary CHECK (is_primary IN (0,1)),
            ADD CONSTRAINT chk_deleted_condition_not_primary CHECK (deleted_at IS NULL OR is_primary = 0)`);
    }
    await db.beginTransaction();
    try {
        const [benchmarks] = await db.query('SELECT ID, name FROM benchmarks ORDER BY ID FOR UPDATE');
        const [conditions] = await db.query(`SELECT c.ID, c.benchmark_ID AS benchmarkID, c.name, c.is_primary AS isPrimary,
            COALESCE(s.scoreCount,0) AS scoreCount, COALESCE(s.scoredModelCount,0) AS scoredModelCount
            FROM benchmark_conditions c LEFT JOIN (
                SELECT benchmark_condition_ID, COUNT(*) scoreCount, COUNT(DISTINCT model_ID) scoredModelCount
                FROM benchmark_results WHERE status = 'accepted' GROUP BY benchmark_condition_ID
            ) s ON s.benchmark_condition_ID = c.ID WHERE c.deleted_at IS NULL ORDER BY c.ID`);
        const families = new Map();
        for (const row of conditions) {
            if (!families.has(row.benchmarkID)) families.set(row.benchmarkID, []);
            families.get(row.benchmarkID).push({ ...row, ID: Number(row.ID), scoreCount: Number(row.scoreCount),
                scoredModelCount: Number(row.scoredModelCount), isPrimary: Boolean(row.isPrimary) });
        }
        const selected = [];
        for (const benchmark of benchmarks) {
            const family = families.get(benchmark.ID);
            if (!family?.length) throw new Error(`Benchmark ${benchmark.ID} has no live conditions`);
            const primary = family.filter(condition => condition.isPrimary);
            if (primary.length > 1) throw new Error(`Benchmark ${benchmark.ID} has multiple primary conditions`);
            if (primary.length === 1) continue;
            const choice = chooseInitialPrimaryCondition(family);
            await db.execute('UPDATE benchmark_conditions SET is_primary = 1, updated_at = updated_at WHERE ID = ?', [choice.ID]);
            selected.push({ benchmarkID: benchmark.ID, benchmark: benchmark.name, conditionID: choice.ID,
                condition: choice.name, scoreCount: choice.scoreCount, scoredModelCount: choice.scoredModelCount });
        }
        const [[invalid]] = await db.query(`SELECT COUNT(*) count FROM (
            SELECT b.ID FROM benchmarks b LEFT JOIN benchmark_conditions c
                ON c.benchmark_ID = b.ID AND c.deleted_at IS NULL
            GROUP BY b.ID HAVING SUM(COALESCE(c.is_primary,0)) <> 1
        ) invalid`);
        if (Number(invalid.count)) throw new Error('Primary condition invariant failed');
        const [primaryRows] = await db.query('SELECT benchmark_ID, ID FROM benchmark_conditions WHERE is_primary = 1 AND deleted_at IS NULL');
        const primaryByBenchmarkID = new Map(primaryRows.map(row => [Number(row.benchmark_ID), Number(row.ID)]));
        const [logs] = await db.query('SELECT ID, content FROM moderation_logs ORDER BY ID FOR UPDATE');
        const upgradedLogIDs = [];
        const repairedDefaultLogIDs = [];
        for (const log of logs) {
            const content = typeof log.content === 'string' ? JSON.parse(log.content) : log.content;
            const upgraded = upgradeBenchmarkModerationContent(content, primaryByBenchmarkID, describeChanges);
            const repaired = repairHistoricalBenchmarkDefaultFlags(upgraded ?? content, describeChanges);
            if (!upgraded && !repaired) continue;
            await db.execute('UPDATE moderation_logs SET content = ?, updated_at = updated_at WHERE ID = ?', [JSON.stringify(repaired ?? upgraded), log.ID]);
            if (upgraded) upgradedLogIDs.push(log.ID);
            if (repaired) repairedDefaultLogIDs.push(log.ID);
        }
        await db.commit();
        return { initialized: selected.length, selected, upgradedLogIDs, repairedDefaultLogIDs };
    } catch (error) { await db.rollback(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const db = await mysql.createConnection(process.env.DB_SOCKET ? {
        socketPath: process.env.DB_SOCKET, user: 'root', database: 'benchmarks'
    } : { host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
    try { console.log(JSON.stringify(await migratePrimaryBenchmarkConditions(db))); }
    finally { await db.end(); }
}
