import dotenv from '/home/ubuntu/benchpoll/node_modules/dotenv/lib/main.js';
import mysql from '/home/ubuntu/benchpoll/node_modules/mysql2/promise.js';

dotenv.config({ path: '/home/ubuntu/benchpoll/.env', quiet: true });
const db = await mysql.createConnection({
    host: process.env.BENCHPOLL_DB_HOST || 'localhost',
    port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
    socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
    user: process.env.BENCHPOLL_DB_USER || 'root',
    password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', dateStrings: true
});
try {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [contexts] = await db.query(`SELECT rc.ID, rc.category_ID, c.name, rc.context_values,
        COUNT(DISTINCT p.ID) AS pies, COUNT(w.benchmark_condition_ID) AS weights
        FROM ranking_contexts rc JOIN categories c ON c.ID=rc.category_ID
        LEFT JOIN personal_pies p ON p.context_ID=rc.ID
        LEFT JOIN personal_pie_weights w ON w.pie_ID=p.ID
        WHERE c.is_active=1 GROUP BY rc.ID,rc.category_ID,c.name,rc.context_values ORDER BY c.ID,rc.ID`);
    const [triggers] = await db.query('SHOW TRIGGERS');
    const [tables] = await db.query(`SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME IN ('ranking_contexts','categories','personal_pies','personal_pie_weights','topic_proposals')
        ORDER BY TABLE_NAME,ORDINAL_POSITION`);
    await db.commit();
    console.log(JSON.stringify({ contexts, tables, triggers: triggers.filter(row =>
        /categor|ranking_context|personal_pie|topic_proposal/.test(row.Table)) }, null, 2));
} catch (error) { await db.rollback(); throw error; }
finally { await db.end(); }
