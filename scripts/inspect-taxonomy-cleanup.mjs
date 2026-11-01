import mysql from 'mysql2/promise';
import { writeFileSync } from 'node:fs';
const db = await mysql.createConnection({ socketPath: '/var/run/mysqld/mysqld.sock', user: 'root', database: 'benchmarks',
    supportBigNumbers: true, bigNumberStrings: true });
const data = {};
try {
    for (const table of ['categories', 'ranking_dimensions', 'ranking_dimension_options', 'ranking_contexts', 'personal_pies',
        'personal_pie_weights', 'personal_pie_score_rules', 'personal_pie_score_rule_components']) {
        [data[table]] = await db.query(`SELECT * FROM ${table}`);
    }
    [data.conditions] = await db.query(`SELECT c.*, b.name benchmark_name,
        COUNT(r.ID) score_count FROM benchmark_conditions c JOIN benchmarks b ON b.ID = c.benchmark_ID
        LEFT JOIN benchmark_results r ON r.benchmark_condition_ID = c.ID
        WHERE c.benchmark_ID IN (SELECT benchmark_ID FROM benchmark_conditions WHERE LOWER(name) LIKE '%snapshot%' OR LOWER(condition_key) LIKE '%snapshot%')
        GROUP BY c.ID, b.name ORDER BY c.benchmark_ID,c.ID`);
    [data.references] = await db.query(`SELECT table_name,column_name FROM information_schema.key_column_usage
        WHERE referenced_table_schema=DATABASE() AND referenced_table_name='benchmark_conditions'`);
    writeFileSync(process.argv[2], JSON.stringify(data, null, 2));
    console.log(JSON.stringify({ categories: data.categories.length, contexts: data.ranking_contexts.length,
        pies: data.personal_pies.length, snapshotBenchmarks: new Set(data.conditions.map(c => c.benchmark_ID)).size,
        conditions: data.conditions.length, references: data.references }));
} finally { await db.end(); }
