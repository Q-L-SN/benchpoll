import { createRequire } from 'node:module';
const require = createRequire(`${process.argv[2] ?? '/home/ubuntu/benchpoll'}/package.json`);
const mysql = require('mysql2/promise');
const connection = await mysql.createConnection({ socketPath: '/var/run/mysqld/mysqld.sock', user: 'root', database: 'benchmarks' });
const scratch = `benchpoll_context_repro_20261012_${process.pid}`;
let createdScratch = false;
try {
    await connection.query(`CREATE DATABASE ${scratch}`);
    createdScratch = true;
    await connection.query(`CREATE TABLE ${scratch}.contexts LIKE ranking_contexts`);
    await connection.query(`CREATE TABLE ${scratch}.revisions (ID INT PRIMARY KEY, revision INT NOT NULL)`);
    await connection.query(`INSERT INTO ${scratch}.revisions VALUES (2, 0)`);
    await connection.query(`CREATE TRIGGER ${scratch}.contexts_update AFTER UPDATE ON ${scratch}.contexts FOR EACH ROW
        UPDATE ${scratch}.revisions SET revision = revision + 1 WHERE ID = 2`);
    for (let attempt = 1; attempt <= 2; attempt++) {
        await connection.query('DROP TEMPORARY TABLE IF EXISTS bp_context_upsert_repro');
        await connection.query('CREATE TEMPORARY TABLE bp_context_upsert_repro LIKE ranking_contexts');
        const query = `INSERT INTO bp_context_upsert_repro (category_ID, context_values, context_hash)
            VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE ID = LAST_INSERT_ID(ID)`;
        const args = [1, '{}', '0'.repeat(64)];
        const [created] = await connection.execute(query, args);
        const [reused] = await connection.execute(query, args);
        const [rows] = await connection.execute('SELECT ID FROM bp_context_upsert_repro');
        console.log(JSON.stringify({ attempt, created: { insertId: created.insertId, affectedRows: created.affectedRows },
            reused: { insertId: reused.insertId, affectedRows: reused.affectedRows }, storedID: rows[0].ID }));
        const triggeredQuery = query.replaceAll('bp_context_upsert_repro', `${scratch}.contexts`);
        const triggeredArgs = [attempt, '{}', '0'.repeat(64)];
        const [newWithTrigger] = await connection.execute(triggeredQuery, triggeredArgs);
        const [reusedWithTrigger] = await connection.execute(triggeredQuery, triggeredArgs);
        console.log(JSON.stringify({ attempt, triggerPresent: true, createdID: newWithTrigger.insertId,
            reusedID: reusedWithTrigger.insertId }));
    }
} finally {
    if (createdScratch) await connection.query(`DROP DATABASE ${scratch}`);
    await connection.end();
}
