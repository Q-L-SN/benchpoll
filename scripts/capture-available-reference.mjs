import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import mysql from 'mysql2/promise';

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = arg('root'), output = arg('output');
if (!root || !output || !process.env.BENCHPOLL_DB_SOCKET || !process.env.BENCHPOLL_DB_USER || !process.env.BENCHPOLL_DB_NAME) {
    throw new Error('Explicit --root, --output and database socket/user/name required.');
}
const ranking = await import(pathToFileURL(resolve(root, 'ranking-service.js')));
const { loadScoreFieldCatalog } = await import(pathToFileURL(resolve(root, 'score-field-service.js')));
const { groupComparisonModels, comparisonOptions } = await import(pathToFileURL(resolve(root, 'model-comparison.js')));
const connection = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET,
    user: process.env.BENCHPOLL_DB_USER, database: process.env.BENCHPOLL_DB_NAME, dateStrings: true, charset: 'utf8mb4' });
try {
    await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const versions = await ranking.loadBenchmarkConditions(connection), fields = await loadScoreFieldCatalog(connection);
    const conditions = versions.map(v => ({ benchmark_condition_ID: v.conditionID, uses_percentage_scale: v.usesPercentageScale,
        score_min: v.scoreMin, score_max: v.scoreMax, score_direction: v.scoreDirection, target_value: v.targetValue }));
    const models = await ranking.loadModels(connection, fields, { conditionIDs: versions.map(v => v.conditionID), conditionDefinitions: conditions });
    const groups = groupComparisonModels(models, comparisonOptions(models, { mode: 'best', keys: ['model'] }, fields), []);
    const snapshot = { schemaVersion: 1, capturedAt: new Date().toISOString(), businessWrites: 0,
        sourceHash: createHash('sha256').update(await readFile(resolve(root, 'ranking-service.js'))).digest('hex'),
        versions: versions.map(v => ({ ID: v.conditionID, benchmarkID: v.benchmarkID, name: v.name, version: v.conditionName })),
        models: groups.map(v => ({ ID: v.ID, modelID: v.modelID, name: v.name, comparisonIdentity: v.comparisonIdentity,
            results: [...v.results].map(([key, score]) => [key, score.normalizedScore]) })) };
    await writeFile(output, JSON.stringify(snapshot), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ models: groups.length, versions: versions.length,
        cells: snapshot.models.reduce((sum, m) => sum + m.results.length, 0), businessWrites: 0 }));
} finally { await connection.rollback(); await connection.end(); }
