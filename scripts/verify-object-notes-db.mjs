import 'dotenv/config';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';

const connection = await mysql.createConnection({
    host: process.env.BENCHPOLL_DB_HOST || 'localhost',
    port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
    user: process.env.BENCHPOLL_DB_USER || 'root',
    password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', charset: 'utf8mb4'
});
const checked = [];
try {
    for (const table of ['benchmarks', 'models', 'benchmark_results', 'categories', 'ranking_dimensions']) {
        await connection.beginTransaction();
        const [[row]] = await connection.query(`SELECT ID, notes FROM ${mysql.escapeId(table)} ORDER BY ID LIMIT 1 FOR UPDATE`);
        if (!row) throw Error(`No row available for rollback verification: ${table}`);
        const note = 'Notes verification: \u5907\u6ce8 <text> "quoted"';
        await connection.execute(`UPDATE ${mysql.escapeId(table)} SET notes = ? WHERE ID = ?`, [note, row.ID]);
        const [[saved]] = await connection.execute(`SELECT notes FROM ${mysql.escapeId(table)} WHERE ID = ?`, [row.ID]);
        assert.equal(saved.notes, note);
        await connection.rollback();
        const [[restored]] = await connection.execute(`SELECT notes FROM ${mysql.escapeId(table)} WHERE ID = ?`, [row.ID]);
        assert.equal(restored.notes, row.notes);
        checked.push(table);
    }
    console.log(JSON.stringify({ passed: true, checked, allTestWritesRolledBack: true }));
} catch (error) {
    await connection.rollback();
    console.error(error.code || error.message);
    process.exitCode = 1;
} finally {
    await connection.end();
}
