import dotenv from '/home/ubuntu/benchpoll/node_modules/dotenv/lib/main.js';
import mysql from '/home/ubuntu/benchpoll/node_modules/mysql2/promise.js';
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
    const [conditions] = await db.query(`SELECT c.ID, c.benchmark_ID AS benchmarkID, b.name AS benchmarkName,
        c.name AS conditionName, c.condition_key AS conditionKey, c.score_source AS scoreSource,
        c.is_default AS isDefault, c.is_primary AS isPrimary, c.difference_explanation AS explanation,
        b.introduction_url AS introductionURL
        FROM benchmark_conditions c JOIN benchmarks b ON b.ID=c.benchmark_ID
        WHERE c.deleted_at IS NULL AND b.is_active=1 ORDER BY b.ID,c.ID`);
    const [sources] = await db.query(`SELECT r.ID, r.benchmark_condition_ID AS conditionID, r.source_url,
        r.source_title, r.notes FROM benchmark_results r
        JOIN benchmark_conditions c ON c.ID=r.benchmark_condition_ID JOIN benchmarks b ON b.ID=c.benchmark_ID
        WHERE ${currentScoreSQL('r')} AND c.deleted_at IS NULL AND b.is_active=1`);
    const totals = new Map(), aa = new Map();
    for (const row of sources) {
        totals.set(Number(row.conditionID), (totals.get(Number(row.conditionID)) ?? 0) + 1);
        if (aaResultReason(row)) {
            const entry = aa.get(Number(row.conditionID)) ?? { count: 0, hosts: new Set(), titles: new Set() };
            entry.count++;
            try { entry.hosts.add(new URL(row.source_url).hostname); } catch { /* Source can be absent. */ }
            if (row.source_title) entry.titles.add(row.source_title);
            aa.set(Number(row.conditionID), entry);
        }
    }
    const report = conditions.map(condition => {
        const source = aa.get(Number(condition.ID));
        return { ...condition, restricted: isAACondition(condition), totalScores: totals.get(Number(condition.ID)) ?? 0,
            aaScores: source?.count ?? 0, sourceHosts: [...source?.hosts ?? []], sourceTitles: [...source?.titles ?? []].slice(0, 6) };
    });
    await db.commit();
    console.log(JSON.stringify(process.argv.includes('--evidence') ? {
        evidence: sources.filter(row => [6222, 24727, 9399, 13813, 2255].includes(Number(row.conditionID)))
    } : { total: report.length, restricted: report.filter(row => row.restricted).length,
        candidates: report.filter(row => row.restricted || row.aaScores || /artificial.?analysis|\baa\b/i.test(JSON.stringify(row))),
        conditions: report }, null, 2));
} catch (error) { await db.rollback(); throw error; }
finally { await db.end(); }
