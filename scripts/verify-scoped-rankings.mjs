import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { getRankingWorkspace as baseline } from '../ranking-service.js';
import { createRankingPager } from '../ranking-pagination.js';
import { resolvedFamilyConditionIDs } from '../public/js/shared/benchmark-families.js';

const [candidateFilename, output] = process.argv.slice(2);
assert.ok(candidateFilename && output, 'Usage: candidate-module output.json');
const { getRankingWorkspace: candidate } = await import(new URL(candidateFilename, import.meta.url));
const samples = JSON.parse(await readFile(new URL('../artifacts/ranking-speed-20261006/before.json', import.meta.url), 'utf8'));
const connection = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || '/var/run/mysqld/mysqld.sock',
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', timezone: 'Z' });
const queries = [];
const db = { getConnection: async () => new Proxy(connection, { get(target, key) {
    if (['commit', 'rollback', 'release'].includes(key)) return async () => {};
    if (key === 'query' || key === 'execute') return async (sql, ...args) => {
        if (/^(SET TRANSACTION|START TRANSACTION)/.test(sql)) return [];
        const start = performance.now();
        try { return await target[key](sql, ...args); }
        finally { queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), ms: Math.round(performance.now() - start) }); }
    };
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
} }) };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function scope(workspace) {
    return new Set([
        ...workspace.personalPie.entries.map(entry => entry.conditionID),
        ...workspace.publicPie.entries.map(entry => entry.conditionID),
        ...workspace.personalPie.fallbackRules.flatMap(rule => resolvedFamilyConditionIDs(rule.primaryConditionID, rule.entries)),
        ...workspace.publicPie.familyComposition.flatMap(group => group.families.flatMap(family =>
            resolvedFamilyConditionIDs(group.primaryConditionID, family.entries)))
    ]);
}
function comparable(workspace, conditionIDs) {
    const value = structuredClone(workspace);
    delete value.serverTime;
    for (const leaderboard of Object.values(value.modelLeaderboards)) for (const row of leaderboard) {
        row.comparisonScores = row.comparisonScores.filter(score => conditionIDs.has(score.conditionID));
    }
    return value;
}
const report = { startedAt: new Date().toISOString(), cases: [] };
try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    report.counts = (await connection.query('SELECT COUNT(*) AS results, MAX(ID) AS lastID FROM benchmark_results'))[0];
    report.referenceBaselineCounts = samples.counts;
    report.freshBaselineInSameSnapshot = true;
    const scenarios = [
        { size: 10, mode: 'best', keys: ['model'], fallback: false },
        { size: 100, mode: 'best', keys: ['model'], fallback: false },
        { size: 10, mode: 'best', keys: [], fallback: false },
        { size: 10, mode: 'matched', keys: ['model'], fallback: false },
        { size: 10, mode: 'best', keys: ['model'], fallback: true }
    ];
    for (const scenario of scenarios) for (const scoreMode of ['range', 'available']) {
        const IDs = samples.conditionIDs.slice(0, scenario.size);
        const options = { categoryID: samples.categoryID, comparison: { mode: scenario.mode, keys: scenario.keys }, scoreMode,
            previewPersonalPie: { entries: IDs.map(conditionID => ({ conditionID, weightBasisPoints: 10000 / scenario.size })),
                fallbackRules: scenario.fallback ? [{ primaryConditionID: IDs[0], mode: 'ordered',
                    entries: [{ conditionID: samples.conditionIDs[10] }, { kind: 'other_versions' }, { conditionID: samples.conditionIDs[11] }] }] : [] } };
        let start = performance.now();
        const previous = await baseline(db, options);
        const beforeMs = Math.round(performance.now() - start);
        queries.length = 0;
        start = performance.now();
        const next = await candidate(db, options);
        const computeMs = Math.round(performance.now() - start);
        const payload = createRankingPager().create(next, { initialMode: 'personal' });
        delete payload.serverTime;
        delete payload.rankingPagination.snapshotID;
        const serialized = JSON.stringify(payload);
        const totalMs = Math.round(performance.now() - start);
        const included = scope(next);
        assert.deepEqual(comparable(next, included), comparable(previous, included), 'Ranking, metadata or evidence changed');
        for (const leaderboard of Object.values(next.modelLeaderboards)) for (const row of leaderboard) {
            assert.ok(row.comparisonScores.every(score => included.has(score.conditionID)), 'Unneeded comparison evidence escaped scope');
        }
        const entry = { ...scenario, scoreMode, beforeMs, computeMs, totalMs,
            identical: true, responseBytes: Buffer.byteLength(serialized), digest: digest(comparable(next, included)),
            selectedVersions: included.size, models: next.modelLeaderboards.personal.length,
            queries: structuredClone(queries) };
        report.cases.push(entry);
        console.log(JSON.stringify({ ...entry, queries: entry.queries.filter(query => query.ms >= 50).map(query => ({ ...query, sql: query.sql.slice(0, 100) })) }));
    }
    report.passed = true;
} finally {
    await connection.rollback();
    await connection.end();
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2));
}
