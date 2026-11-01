import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { getRankingWorkspace, loadApprovedModelConfigurations } from '../ranking-service.js';
import { createRankingPager } from '../ranking-pagination.js';
import { benchmarkConditionGroup } from '../public/js/shared/benchmark-condition-groups.js';
import { validateWorkspacePayload } from '../public/js/workspace/contracts.js';

const connection = await mysql.createConnection({ socketPath: '/var/run/mysqld/mysqld.sock', user: 'root', database: 'benchmarks' });
const digest = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
async function integrity() {
    const [[scores]] = await connection.query(`SELECT COUNT(*) count, SUM(ID) idSum,
        SUM(CRC32(CONCAT_WS(':',ID,benchmark_ID,benchmark_condition_ID,model_ID,raw_score,status,
            source_url,CAST(score_fields AS CHAR),notes))) checksum FROM benchmark_results`);
    const [[conditions]] = await connection.query('SELECT COUNT(*) count, SUM(ID) idSum FROM benchmark_conditions');
    const [[benchmarks]] = await connection.query('SELECT COUNT(*) count, SUM(ID) idSum FROM benchmarks');
    const pies = {};
    for (const table of ['personal_pies', 'personal_pie_weights', 'personal_pie_score_rules', 'personal_pie_score_rule_components']) {
        const [rows] = await connection.query(`SELECT * FROM ${table} ORDER BY 1,2`);
        pies[table] = { count: rows.length, sha256: digest(rows) };
    }
    return { scores, conditions, benchmarks, pies };
}
try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const db = { getConnection: async () => new Proxy(connection, { get(target, key) {
        if (['commit', 'rollback', 'release'].includes(key)) return async () => {};
        if (key === 'query') return async (sql, ...args) => {
            if (/^(SET TRANSACTION|START TRANSACTION)/.test(sql)) return [];
            return target.query(sql, ...args);
        };
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
    } }) };
    const before = await integrity();
    const [[category]] = await connection.query("SELECT ID FROM categories WHERE name='Intelligence' AND parent_ID IS NULL");
    assert.ok(category);
    const checks = [];
    const options = [
        { scoreMode: 'range', comparison: { mode: 'best', keys: ['model'] } },
        { scoreMode: 'available', comparison: { mode: 'best', keys: ['model'] } },
        { scoreMode: 'range', comparison: { mode: 'matched', keys: ['model'] } }
    ];
    for (const settings of options) {
        const started = performance.now();
        const workspace = await getRankingWorkspace(db, { categoryID: Number(category.ID), ...settings });
        const pager = createRankingPager();
        const paged = pager.create(workspace);
        validateWorkspacePayload(paged);
        const groups = Object.fromEntries(['primary', 'other', 'lowCoverage'].map(group => [group, 0]));
        for (const row of workspace.benchmarks) groups[benchmarkConditionGroup(row)]++;
        assert.equal(groups.primary, paged.rankingPagination.benchmarks.primary.total);
        assert.equal(groups.other, paged.rankingPagination.benchmarks.other.total);
        assert.equal(groups.lowCoverage, paged.rankingPagination.benchmarks.lowCoverage.total);
        const models = workspace.modelLeaderboards.public.filter(model => model.comparable);
        for (const model of models) {
            assert.ok(Math.abs(model.calculationScores.reduce((sum, score) => sum + score.contribution, 0) - model.lower) < 0.011);
        }
        if (models.length) {
            const IDs = [...new Set(models[0].members.map(member => member.modelID))];
            const configurations = await loadApprovedModelConfigurations(connection, IDs);
            assert.ok(configurations.length);
            const [[{ count }]] = await connection.execute(`SELECT COUNT(*) count FROM benchmark_results r
                JOIN benchmarks b ON b.ID=r.benchmark_ID AND b.is_active=1
                JOIN benchmark_conditions c ON c.ID=r.benchmark_condition_ID AND c.deleted_at IS NULL
                WHERE r.status='accepted' AND r.model_ID IN (${IDs.map(() => '?').join(',')})`, IDs);
            assert.equal(configurations.reduce((sum, item) => sum + item.scoreCount, 0), Number(count));
        }
        checks.push({ ...settings, groups, models: models.length, ms: Math.round(performance.now() - started) });
    }
    assert.deepEqual(await integrity(), before);
    const report = { checkedAt: new Date().toISOString(), readOnly: true, dataUnchanged: true, integrity: before, checks };
    if (process.env.BENCHPOLL_VERIFY_REPORT) await writeFile(process.env.BENCHPOLL_VERIFY_REPORT, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(report));
} finally { await connection.rollback(); await connection.end(); }
