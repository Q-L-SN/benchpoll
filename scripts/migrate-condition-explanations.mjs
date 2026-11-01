import 'dotenv/config';
import mysql from 'mysql2/promise';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

export function upgradeConditionExplanations(content, describeChanges) {
    if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('Invalid moderation content');
    const upgraded = structuredClone(content);
    let changed = false;
    const visit = record => {
        const isBenchmark = record.type === 'new_benchmark'
            || (record.type === 'entity_change' && record.targetKind === 'benchmark');
        if (isBenchmark) {
            const sets = record.type === 'new_benchmark'
                ? record.benchmarks.map(benchmark => benchmark.conditions)
                : [record.before.conditions, ...(record.after ? [record.after.conditions] : [])];
            let changedRecord = false;
            for (const conditions of sets) {
                if (!Array.isArray(conditions)) throw new Error('Invalid stored condition list');
                for (const condition of conditions) {
                    if (!Object.hasOwn(condition, 'differenceExplanation')) {
                        condition.differenceExplanation = '';
                        changedRecord = true;
                    } else if (typeof condition.differenceExplanation !== 'string'
                        || condition.differenceExplanation.length > 10000) throw new Error('Invalid stored condition explanation');
                }
            }
            if (changedRecord && record.type === 'entity_change' && record.after) {
                record.changes = describeChanges(record.before, record.after);
            }
            changed ||= changedRecord;
        }
        if (record.moderation?.originalContent) visit(record.moderation.originalContent);
    };
    visit(upgraded);
    return changed ? upgraded : null;
}

async function loadChangeDiff() {
    const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
    const start = source.indexOf('function canonicalChangeValue(');
    const end = source.indexOf('function entityChildSetChanges(', start);
    if (start < 0 || end <= start) throw new Error('Canonical change diff is missing');
    const context = vm.createContext();
    vm.runInContext(`${source.slice(start, end)}\nthis.diff = describeEntityChanges;`, context);
    return context.diff;
}

function oldConditionDigest(rows) {
    return createHash('sha256').update(JSON.stringify(rows.map(row => {
        const copy = { ...row };
        delete copy.difference_explanation;
        return copy;
    }))).digest('hex');
}

export async function migrateConditionExplanations(db, { apply = false } = {}) {
    const describeChanges = await loadChangeDiff();
    const [columns] = await db.query('SHOW COLUMNS FROM benchmark_conditions');
    const nameColumn = columns.find(column => column.Field === 'name');
    if (nameColumn?.Type !== 'varchar(192)') throw new Error('Unexpected condition name storage definition');
    const column = columns.find(item => item.Field === 'difference_explanation');
    if (column && (column.Type !== 'text' || column.Null !== 'YES')) throw new Error('Unexpected condition explanation schema');
    const [before] = await db.query('SELECT * FROM benchmark_conditions ORDER BY ID');
    const beforeDigest = oldConditionDigest(before);
    const [logs] = await db.query('SELECT ID, content FROM moderation_logs ORDER BY ID');
    const changes = logs.flatMap(log => {
        const content = typeof log.content === 'string' ? JSON.parse(log.content) : log.content;
        const upgraded = upgradeConditionExplanations(content, describeChanges);
        return upgraded ? [{ ID: log.ID, content: upgraded }] : [];
    });
    const summary = { apply, addColumn: !column, conditionCount: before.length,
        oldNameLimit: 192, preservedLongNames: before.filter(row => row.name.length > 60).length,
        upgradedLogIDs: changes.map(log => log.ID), conditionDigest: beforeDigest };
    if (!apply) return summary;
    if (!column) await db.query('ALTER TABLE benchmark_conditions ADD COLUMN difference_explanation TEXT NULL');
    await db.beginTransaction();
    try {
        const [currentLogs] = await db.query('SELECT ID, content FROM moderation_logs ORDER BY ID FOR UPDATE');
        if (JSON.stringify(currentLogs) !== JSON.stringify(logs)) throw new Error('Moderation requests changed during migration');
        for (const log of changes) await db.execute(
            'UPDATE moderation_logs SET content = ?, updated_at = updated_at WHERE ID = ?',
            [JSON.stringify(log.content), log.ID]);
        const [after] = await db.query('SELECT * FROM benchmark_conditions ORDER BY ID');
        if (oldConditionDigest(after) !== beforeDigest) throw new Error('Existing conditions changed during migration');
        await db.commit();
        return { ...summary, applied: true, oldConditionRowsUnchanged: true };
    } catch (error) {
        await db.rollback();
        throw error;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const apply = process.argv.includes('--apply');
    if (apply && !process.argv.includes('--backup-confirmed')) throw new Error('Verified backup required');
    const db = await mysql.createConnection({
        socketPath: process.env.BENCHPOLL_DB_SOCKET || '/var/run/mysqld/mysqld.sock',
        user: process.env.BENCHPOLL_DB_USER || 'root',
        password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', charset: 'utf8mb4', timezone: 'Z'
    });
    try { console.log(JSON.stringify(await migrateConditionExplanations(db, { apply }))); }
    finally { await db.end(); }
}
