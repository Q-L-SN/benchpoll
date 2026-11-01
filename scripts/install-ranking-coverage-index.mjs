import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';

const [operation, filename] = process.argv.slice(2);
assert.ok(['prepare', 'apply'].includes(operation) && filename, 'Usage: prepare|apply plan.json');
const name = 'idx_ranking_status_condition_model';
const columns = ['status', 'benchmark_condition_ID', 'model_ID'];
const SQL = `SELECT r.benchmark_condition_ID, COUNT(*) AS approved_score_count,
    COUNT(DISTINCT r.model_ID) AS scored_model_count FROM benchmark_results r
    JOIN models m ON m.ID = r.model_ID AND m.is_active = 1
    WHERE r.status = 'accepted' GROUP BY r.benchmark_condition_ID`;
const connection = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || '/var/run/mysqld/mysqld.sock',
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', timezone: 'Z' });
try {
    const indexes = (await connection.query('SHOW INDEX FROM benchmark_results'))[0];
    const existing = indexes.filter(index => index.Key_name === name).sort((a, b) => a.Seq_in_index - b.Seq_in_index);
    if (existing.length) assert.deepEqual(existing.map(index => index.Column_name), columns, 'An incompatible index exists');
    if (operation === 'prepare') {
        assert.equal(existing.length, 0, 'The index is already installed');
        const explain = (await connection.query('EXPLAIN ANALYZE ' + SQL))[0];
        const plan = { table: 'benchmark_results', name, columns, previousIndexes: indexes, explain,
            statement: `ALTER TABLE benchmark_results ADD INDEX ${name} (${columns.join(',')}), ALGORITHM=INPLACE, LOCK=NONE`,
            dataChanges: false, preparedAt: new Date().toISOString() };
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, JSON.stringify(plan, null, 2), { flag: 'wx' });
        console.log(JSON.stringify(plan));
    } else {
        const plan = JSON.parse(await readFile(filename, 'utf8'));
        assert.equal(plan.table, 'benchmark_results'); assert.equal(plan.name, name);
        assert.deepEqual(plan.columns, columns); assert.equal(plan.dataChanges, false);
        assert.equal(plan.statement, `ALTER TABLE benchmark_results ADD INDEX ${name} (${columns.join(',')}), ALGORITHM=INPLACE, LOCK=NONE`);
        if (!existing.length) {
            assert.deepEqual(indexes, plan.previousIndexes, 'Index metadata changed since preparation');
            await connection.query(plan.statement);
        }
        const installed = (await connection.query('SHOW INDEX FROM benchmark_results'))[0]
            .filter(index => index.Key_name === name).sort((a, b) => a.Seq_in_index - b.Seq_in_index);
        assert.deepEqual(installed.map(index => index.Column_name), columns);
        const receipt = { applied: true, dataChanges: false, appliedAt: new Date().toISOString(), installed,
            explain: (await connection.query('EXPLAIN ANALYZE ' + SQL))[0],
            rollback: `ALTER TABLE benchmark_results DROP INDEX ${name}, ALGORITHM=INPLACE, LOCK=NONE` };
        await writeFile(filename.replace(/\.json$/, '-applied.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
        console.log(JSON.stringify(receipt));
    }
} finally { await connection.end(); }
