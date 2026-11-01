import dotenv from '/home/ubuntu/benchpoll/node_modules/dotenv/lib/main.js';
import mysql from '/home/ubuntu/benchpoll/node_modules/mysql2/promise.js';
import { loadScoreFieldCatalog } from '/home/ubuntu/benchpoll/score-field-service.js';
import { fieldDisplayValue } from '/home/ubuntu/benchpoll/public/js/shared/score-fields.js';
import { isAACondition } from '/home/ubuntu/benchpoll/public/js/shared/aa-ranking-policy.js';
import { aaResultReason } from '/home/ubuntu/benchpoll/aa-archive-policy.js';
import { currentScoreSQL } from '/home/ubuntu/benchpoll/score-aggregation.js';

dotenv.config({ path: '/home/ubuntu/benchpoll/.env', quiet: true });
const db = await mysql.createConnection({
    socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
    host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', dateStrings: true, charset: 'utf8mb4'
});
try {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const fields = await loadScoreFieldCatalog(db);
    const assignments = fields.flatMap(field => field.options.filter(option => /^(?:aa|artificial[ _-]+analysis)$/i.test(option.label.trim()))
        .map(option => ({ fieldID: field.ID, value: option.ID })));
    const [rows] = await db.execute(`SELECT r.ID, r.benchmark_ID AS benchmarkID,
        c.ID AS conditionID, c.name AS conditionName, c.condition_key AS conditionKey, c.score_source AS scoreSource,
        c.difference_explanation AS explanation, b.name AS benchmarkName, m.name AS modelName,
        r.model_ID AS modelID, r.raw_score AS rawScore, r.score_fields AS scoreFields,
        r.source_url, r.source_title, r.notes
        FROM benchmark_results r JOIN benchmarks b ON b.ID=r.benchmark_ID
        JOIN benchmark_conditions c ON c.ID=r.benchmark_condition_ID JOIN models m ON m.ID=r.model_ID
        WHERE ${currentScoreSQL('r')} AND c.deleted_at IS NULL AND b.is_active=1 AND m.is_active=1
          AND (${assignments.map(() => 'JSON_CONTAINS(r.score_fields, ?)').join(' OR ')}
            OR JSON_SEARCH(r.score_fields, 'one', 'Artificial Analysis', NULL, '$[*].value') IS NOT NULL
            OR JSON_SEARCH(r.score_fields, 'one', 'AA', NULL, '$[*].value') IS NOT NULL)
        ORDER BY c.ID, r.ID`, assignments.map(value => JSON.stringify(value)));
    const report = rows.map(row => {
        const values = typeof row.scoreFields === 'string' ? JSON.parse(row.scoreFields) : row.scoreFields;
        return { ...row, restricted: isAACondition(row) || Boolean(aaResultReason(row, undefined, fields)),
            fields: values.map(assignment => {
                const field = fields.find(field => field.ID === assignment.fieldID);
                return { name: field?.name, value: fieldDisplayValue(field, assignment.value) };
            }) };
    });
    await db.commit();
    console.log(JSON.stringify({ total: rows.length, unclassified: report.filter(row => !row.restricted) }, null, 2));
} catch (error) { await db.rollback(); throw error; }
finally { await db.end(); }
