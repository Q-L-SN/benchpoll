import 'dotenv/config';
import mysql from 'mysql2/promise';
import { writeFile } from 'node:fs/promises';
import { loadBenchmarkConditions, loadModels } from '../ranking-service.js';
import { loadScoreFieldCatalog } from '../score-field-service.js';
import { groupComparisonModels, comparisonOptions } from '../model-comparison.js';

const output = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length);
if (!output || !/^\/home\/ubuntu\/benchpoll\/scripts\/site-navigation-20261029\/site-navigation-20261029-\d+\/pairwise-current\.json$/.test(output)) {
    throw new Error('Explicit isolated output path is required');
}
const connection = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
    host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', dateStrings: true, charset: 'utf8mb4' });
try {
    await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const versions = (await loadBenchmarkConditions(connection)).filter(version => !version.excludedFromRanking);
    const fields = await loadScoreFieldCatalog(connection);
    const definitions = versions.map(version => ({ benchmark_condition_ID: version.conditionID,
        uses_percentage_scale: version.usesPercentageScale, score_min: version.scoreMin, score_max: version.scoreMax,
        score_direction: version.scoreDirection, target_value: version.targetValue }));
    const models = await loadModels(connection, fields, { conditionIDs: versions.map(version => version.conditionID), conditionDefinitions: definitions });
    const groups = groupComparisonModels(models, comparisonOptions(models, { mode: 'best', keys: ['model'] }, fields), []);
    const snapshot = { schemaVersion: 1, capturedAt: new Date().toISOString(), businessWrites: 0,
        versions: versions.map(version => ({ ID: version.conditionID, benchmarkID: version.benchmarkID,
            name: version.name, version: version.conditionName })),
        models: groups.map(group => ({ ID: group.ID, modelID: group.modelID, name: group.name, comparisonIdentity: group.comparisonIdentity,
            results: [...group.results].map(([key, score]) => [key, score.normalizedScore]) })) };
    await writeFile(output, JSON.stringify(snapshot), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ models: groups.length, versions: versions.length,
        cells: snapshot.models.reduce((sum, group) => sum + group.results.length, 0), businessWrites: 0 }));
} finally { await connection.rollback(); await connection.end(); }
