import 'dotenv/config';
import mysql from 'mysql2/promise';

const config = { socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
    host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks' };
const aaBenchmarks = new Set(['artificial-analysis-long-context-reasoning', 'automationbench-aa', 'gdpval-stirrup', 'terminal-bench hard']);
const isAA = row => {
    const benchmark = String(row.benchmark_name ?? '').trim().toLowerCase();
    const key = String(row.condition_key ?? '').trim().toLowerCase();
    const name = String(row.condition_name ?? '');
    return benchmark.startsWith('aa-') || benchmark.startsWith('artificial analysis ') || benchmark.startsWith('gdpval-aa') || /[-\s]aa(?:$|[\s-])/.test(benchmark)
        || aaBenchmarks.has(benchmark) || /^aa(?:[-_]|$)/.test(key) || /\bartificial[ -]+analysis\b/i.test(name)
        || /(?:^|[;(,]\s*)aa(?:[-_ :]|$)/i.test(name);
};
const db = await mysql.createConnection(config);
try {
    const [conditions] = await db.query(`SELECT c.ID AS condition_ID, c.benchmark_ID, c.condition_key, c.name AS condition_name,
        c.deleted_at, b.name AS benchmark_name, b.is_active FROM benchmark_conditions c JOIN benchmarks b ON b.ID = c.benchmark_ID`);
    const excluded = conditions.filter(isAA), ids = new Set(excluded.map(row => Number(row.condition_ID)));
    const [weights] = await db.query('SELECT pie_ID, benchmark_condition_ID, weight_basis_points FROM personal_pie_weights ORDER BY pie_ID, benchmark_condition_ID');
    const [families] = await db.query(`SELECT r.pie_ID, r.primary_benchmark_condition_ID, r.family_ID, m.position, m.benchmark_condition_ID
        FROM personal_pie_score_rules r JOIN benchmark_family_members m ON m.family_ID = r.family_ID ORDER BY r.pie_ID, r.family_ID, m.position`);
    const [[withdrawn]] = await db.query('SELECT COUNT(*) AS count FROM topic_proposals WHERE withdrawn_at IS NOT NULL');
    console.log(JSON.stringify({ conditions: process.argv.includes('--summary') ? excluded.length : excluded, affectedWeights: weights.filter(row => ids.has(Number(row.benchmark_condition_ID))),
        affectedFamilyMembers: families.filter(row => ids.has(Number(row.primary_benchmark_condition_ID)) || ids.has(Number(row.benchmark_condition_ID))),
        withdrawnProposals: Number(withdrawn.count) }, null, 2));
} finally { await db.end(); }
