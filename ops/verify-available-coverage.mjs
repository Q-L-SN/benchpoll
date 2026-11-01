import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const root = '/home/ubuntu/benchpoll';
const app = process.argv.find(value => value.startsWith('--app='))?.slice(6) ?? root;
assert(app === root || /^\/home\/ubuntu\/benchpoll\/scripts\/showcase-view-20261012\/[a-z0-9-]+\/candidate$/.test(app));
const load = path => import(pathToFileURL(`${root}/${path}`).href);
const { default: dotenv } = await load('node_modules/dotenv/lib/main.js');
const { default: mysql } = await load('node_modules/mysql2/promise.js');
const { getRankingWorkspace, loadBenchmarkConditions } = await import(pathToFileURL(`${app}/ranking-service.js`).href);
const { createRankingReadCache } = await import(pathToFileURL(`${app}/ranking-read-cache.js`).href);
const { createRankingPager } = await import(pathToFileURL(`${app}/ranking-pagination.js`).href);
const { validateWorkspacePayload } = await import(pathToFileURL(`${app}/public/js/workspace/contracts.js`).href);
const environment = dotenv.parse(await readFile(`${root}/.env`));
const connection = await mysql.createConnection({
    socketPath: environment.BENCHPOLL_DB_SOCKET || undefined,
    host: environment.BENCHPOLL_DB_HOST || 'localhost', port: Number(environment.BENCHPOLL_DB_PORT || 3306),
    user: environment.BENCHPOLL_DB_USER || 'root', password: environment.BENCHPOLL_DB_PASSWORD ?? environment.DB_PASSWORD,
    database: environment.BENCHPOLL_DB_NAME || 'benchmarks',
    supportBigNumbers: true, bigNumberStrings: false, connectTimeout: 10_000
});
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < .000001, 'Coverage trace mismatch');
const db = { getConnection: async () => new Proxy(connection, { get(target, key) {
    if (['commit', 'rollback', 'release'].includes(key)) return async () => {};
    if (key === 'query') return async (sql, ...args) => {
        if (/^(SET TRANSACTION|START TRANSACTION)/.test(sql)) return [];
        return target.query(sql, ...args);
    };
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
} }) };
const evidence = row => ({ ID: row.ID, comparable: row.comparable, coverage: row.coverage,
    missingWeight: row.missingWeight, calculationScores: row.calculationScores, comparisonScores: row.comparisonScores,
    fallbackResolutions: row.fallbackResolutions, inferredScores: row.inferredScores });
const report = { persistentBusinessWrites: 0, externalMailSent: 0, cases: [] };
try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [categories] = await connection.execute("SELECT ID FROM categories WHERE name = 'Intelligence' AND is_active = 1 AND owner_user_ID IS NULL");
    assert.equal(categories.length, 1);
    const versions = (await loadBenchmarkConditions(connection)).sort((a, b) => b.scoreCount - a.scoreCount || a.conditionID - b.conditionID);
    const rankingCache = createRankingReadCache();
    for (const size of [10, 100]) {
        assert.ok(versions.length >= size);
        const previewPersonalPie = { entries: versions.slice(0, size).map(version => ({
            conditionID: version.conditionID, weightBasisPoints: 10000 / size })), fallbackRules: [] };
        const options = { categoryID: Number(categories[0].ID), scoreMode: 'available', jsonMemberMetadata: true,
            comparison: { mode: 'best', keys: ['model'] }, previewPersonalPie, rankingCache };
        const before = performance.now();
        const legacy = await getRankingWorkspace(db, { ...options, availableInferenceVersion: 2 });
        const legacyMs = performance.now() - before;
        const start = performance.now();
        const current = await getRankingWorkspace(db, { ...options, availableInferenceVersion: 4 });
        const currentMs = performance.now() - start;
        const checks = { size, legacyMs: Math.round(legacyMs), currentMs: Math.round(currentMs), models: 0,
            penalized: 0, fullyCovered: 0, incomparable: 0, estimatedResults: 0, negativeTotals: 0 };
        for (const list of ['personal', 'public']) {
            const oldByID = new Map(legacy.modelLeaderboards[list].map(row => [row.ID, row]));
            assert.equal(current.modelLeaderboards[list].length, oldByID.size);
            for (const row of current.modelLeaderboards[list]) {
                const old = oldByID.get(row.ID);
                assert.deepEqual(evidence(row), evidence(old), 'Measured and predicted evidence must remain unchanged');
                checks.models++;
                checks.estimatedResults += row.inferredScores.length;
                if (!row.availableInference) { checks.incomparable++; continue; }
                assert.equal(row.availableInference.method, 'pairwise-anchored-coverage-factor');
                close(row.availableInference.unpenalizedScore, old.availableInference.totalScore);
                const factor = Math.sqrt(row.availableInference.coverageFraction);
                const applied = row.availableInference.unpenalizedScore < 0 ? 2 - factor : factor;
                close(row.availableInference.coverageFactor, factor);
                close(row.availableInference.appliedFactor, applied);
                close(row.availableInference.totalScore, Math.max(-Number.MAX_VALUE, old.availableInference.totalScore * applied));
                assert.equal(Object.hasOwn(row.availableInference, 'coveragePenalty'), false);
                assert.ok(row.availableInference.totalScore <= old.availableInference.totalScore);
                if (row.availableInference.unpenalizedScore < 0) checks.negativeTotals++;
                if (row.availableInference.coverageFraction < 1 - .000001) checks.penalized++;
                else { checks.fullyCovered++; assert.equal(row.lower, old.lower); }
            }
        }
        const pager = createRankingPager();
        validateWorkspacePayload(JSON.parse(JSON.stringify(pager.create(current, { initialMode: 'personal' }))), { initialMode: 'personal' });
        const warm = performance.now();
        const cached = await getRankingWorkspace(db, { ...options, availableInferenceVersion: 4 });
        checks.cachedMs = Math.round(performance.now() - warm);
        assert.deepEqual(cached.modelLeaderboards.personal.map(row => row.lower), current.modelLeaderboards.personal.map(row => row.lower));
        const oldPenalty = await getRankingWorkspace(db, { ...options, availableInferenceVersion: 3 });
        for (const list of ['personal', 'public']) for (const row of oldPenalty.modelLeaderboards[list]) if (row.availableInference) {
            assert.equal(row.availableInference.method, 'pairwise-anchored-coverage');
            close(row.availableInference.coveragePenalty, 20 * (1 - row.availableInference.coverageFraction));
        }
        const afterLegacy = await getRankingWorkspace(db, { ...options, availableInferenceVersion: 4 });
        assert.deepEqual(afterLegacy.modelLeaderboards.personal.map(row => row.lower), current.modelLeaderboards.personal.map(row => row.lower));
        assert.ok(checks.penalized > 0);
        report.cases.push(checks);
    }
    console.log(JSON.stringify(report));
} finally {
    await connection.rollback();
    await connection.end();
}
