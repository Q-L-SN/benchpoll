import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { initPool, pool } from '../db.js';
import { getRankingWorkspace as baseline } from '../ranking-service.js';

const candidatePath = process.argv[2];
if (!candidatePath) throw new Error('Pass a candidate module path relative to scripts/');
const { getRankingWorkspace: candidate } = await import(new URL(candidatePath, import.meta.url));
function digest(workspace) {
    const normalized = structuredClone(workspace);
    delete normalized.serverTime;
    // Evidence display order is not part of the calculation contract.
    for (const rows of Object.values(normalized.modelLeaderboards)) {
        for (const row of rows) row.comparisonScores.sort((a, b) => a.conditionID - b.conditionID);
    }
    return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
initPool(process.env.DB_PASSWORD);
const connection = await pool.getConnection();
try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    // Compare both implementations within one snapshot even while production accepts contributions.
    const db = { getConnection: async () => new Proxy(connection, { get(target, key) {
        if (['commit', 'rollback', 'release'].includes(key)) return async () => {};
        if (key === 'query') return async (sql, ...args) => {
            if (/^(SET TRANSACTION|START TRANSACTION)/.test(sql)) return [];
            return target.query(sql, ...args);
        };
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
    } }) };
    const [[{ count }]] = await connection.query('SELECT COUNT(*) AS count FROM benchmark_results');
    console.log(JSON.stringify({ count }));
    let previewPersonalPie;
    const scenarios = [null, { mode: 'best', keys: ['model'] }, { mode: 'matched', keys: ['model'] }];
    for (const comparison of scenarios) {
        const options = { categoryID: Number(process.argv[3] ?? 54), comparison, previewPersonalPie };
        let start = performance.now();
        const previous = await baseline(db, options);
        const beforeMs = Math.round(performance.now() - start);
        start = performance.now();
        const next = await candidate(db, options);
        const afterMs = Math.round(performance.now() - start);
        assert.equal(digest(next), digest(previous), 'Ranking, metadata or evidence changed');
        const primary = previous.publicPie.entries[0]?.conditionID;
        const alternate = previous.publicPie.entries[1]?.conditionID;
        if (primary && alternate) previewPersonalPie = {
            entries: [{ conditionID: primary, weightBasisPoints: 10000 }],
            fallbackRules: [{ primaryConditionID: primary, mode: 'fallback_if_missing',
                entries: [{ conditionID: alternate, weightBasisPoints: 10000 }] }]
        };
        console.log(JSON.stringify({ comparison, beforeMs, afterMs, identical: true }));
    }
} finally {
    await connection.rollback();
    connection.release();
    await pool.end();
}
