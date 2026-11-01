import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { selectArenaSnapshotConfig, validateArenaSnapshot } from '../arena-sync.js';
import { modelRunConfiguration } from '../model-run-configuration.js';

const database = 'benchpoll_arena_workspace_rehearsal_20261003';
const snapshotPath = process.argv[2];
if (!snapshotPath) throw new Error('A fetched official snapshot path is required');
const db = await mysql.createConnection({ socketPath: '/var/run/mysqld/mysqld.sock', user: 'root',
    database: 'benchmarks', charset: 'utf8mb4', dateStrings: true, timezone: 'Z' });
const output = new URL('../artifacts/arena-workspace-rehearsal/', import.meta.url);
await mkdir(output, { recursive: true });
let created = false;
function command(script, args = [], expectFailure = null) {
    const child = spawnSync(process.execPath, [`scripts/${script}`, ...args], { encoding: 'utf8', timeout: 600000,
        cwd: new URL('../', import.meta.url), maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, DOTENV_CONFIG_PATH: '/dev/null', BENCHPOLL_DB_NAME: database,
            BENCHPOLL_DB_USER: 'root', BENCHPOLL_DB_PASSWORD: '', BENCHPOLL_DB_SOCKET: '/var/run/mysqld/mysqld.sock',
            BENCHPOLL_RUN_CONFIG_OUTPUT: output.pathname + 'configurations' } });
    if (expectFailure) {
        assert.notEqual(child.status, 0, 'Expected publication to fail');
        assert.match(child.stderr, expectFailure);
    } else assert.equal(child.status, 0, child.stderr);
    return child.stdout;
}
async function counts() {
    const [[scores]] = await db.query('SELECT COUNT(*) count,SUM(raw_score) scoreSum FROM benchmark_results');
    const [[pies]] = await db.query('SELECT COUNT(*) count,SUM(weight_basis_points) sum FROM personal_pie_weights');
    return { scores, pies };
}
try {
    await db.query(`CREATE DATABASE ${database}`);
    created = true;
    const tables = ['organizations', 'models', 'benchmarks', 'benchmark_conditions', 'benchmark_tags', 'benchmark_tag_links',
        'benchmark_results', 'personal_pie_weights', 'personal_pie_score_rule_components', 'arena_sync_batches',
        'arena_sync_state', 'arena_import_rows', 'moderation_logs', 'score_fields', 'score_field_options', 'user_comparison_profiles',
        'categories', 'ranking_dimensions', 'ranking_dimension_options', 'ranking_contexts', 'users', 'personal_pies', 'personal_pie_score_rules'];
    for (const table of tables) {
        await db.query(`CREATE TABLE ${database}.${table} LIKE benchmarks.${table}`);
        const [columns] = await db.query(`SHOW COLUMNS FROM benchmarks.${table}`);
        const names = columns.filter(column => !column.Extra.includes('GENERATED')).map(column => {
            if (!/^[a-zA-Z0-9_]+$/.test(column.Field)) throw new Error('Unsafe rehearsal column name');
            return `\`${column.Field}\``;
        }).join(',');
        await db.query(`INSERT INTO ${database}.${table} (${names}) SELECT ${names} FROM benchmarks.${table}`);
    }
    await db.query(`USE ${database}`);
    await db.query('SET SESSION group_concat_max_len=1048576');
    const baseline = await counts();
    command('migrate-benchmark-details.mjs', ['--apply', '--backup-confirmed']);
    command('migrate-benchmark-details.mjs', ['--apply', '--backup-confirmed']);
    const migrationArguments = ['--apply', '--backup-confirmed', '--identity-resolutions', 'scripts/model-identity-resolutions-20261004.json',
        '--configuration-resolutions', 'scripts/score-configuration-resolutions-20261004.json'];
    command('migrate-model-run-configurations.mjs', migrationArguments);
    assert.deepEqual(await counts(), baseline);
    const repeated = JSON.parse(command('migrate-model-run-configurations.mjs', migrationArguments));
    assert.equal(repeated.models, 0);
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
    const feeds = [];
    for (const config of snapshot.expectedConfigs) {
        try { validateArenaSnapshot(selectArenaSnapshotConfig(snapshot, config)); }
        catch (error) {
            command('import-arena-latest.mjs', [snapshotPath, '--apply', '--backup-confirmed', '--schema-ready', '--config', config], /Conflicting Arena source rows/);
            feeds.push({ config, status: 'failed', error: error.message });
            continue;
        }
        const result = JSON.parse(command('import-arena-latest.mjs', [snapshotPath, '--apply', '--backup-confirmed', '--schema-ready', '--config', config]));
        const [[datesBefore]] = await db.query('SELECT SHA2(GROUP_CONCAT(CONCAT(ID,COALESCE(scores_updated_at,\'\')) ORDER BY ID SEPARATOR \',\'),256) hash FROM benchmarks');
        const again = JSON.parse(command('import-arena-latest.mjs', [snapshotPath, '--apply', '--backup-confirmed', '--schema-ready', '--config', config]));
        assert.equal(again.insertedResults, 0);
        assert.equal(again.remappedResults, 0, `${config} remapped unchanged model configuration on repeated import`);
        const [[datesAfter]] = await db.query('SELECT SHA2(GROUP_CONCAT(CONCAT(ID,COALESCE(scores_updated_at,\'\')) ORDER BY ID SEPARATOR \',\'),256) hash FROM benchmarks');
        assert.deepEqual(datesAfter, datesBefore);
        feeds.push({ config, status: 'succeeded', inserted: result.insertedResults, normalized: result.normalizedConfigurations });
    }
    const [[valid]] = await db.query(`SELECT COUNT(*) count FROM arena_import_rows a JOIN benchmark_results r ON r.ID=a.result_ID
        WHERE a.manual_override='none' AND r.status<>'accepted'`);
    assert.equal(Number(valid.count), 0);
    const [currentModels] = await db.query(`SELECT m.ID,m.name,o.slug vendorSlug FROM models m
        JOIN organizations o ON o.ID=m.vendor_ID WHERE m.is_active=1`);
    assert.deepEqual(currentModels.filter(model => Object.keys(modelRunConfiguration(model.name, model.vendorSlug).configuration).length),
        [], 'Recognized run configuration remained in an active model identity');
    const scoringSamples = JSON.parse(command('verify-scoring-mode-samples.mjs'));
    assert.equal(scoringSamples.passed, true);
    const summary = { passed: true, productionScoresChanged: 0, migrationsIdempotent: true,
        sameRawScoresAndPersonalWeights: true, unchangedSyncKeepsDates: true, scoringSamples, feeds };
    await writeFile(new URL('results.json', output), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
} finally {
    await db.query('USE benchmarks');
    if (created) await db.query(`DROP DATABASE ${database}`);
    await db.end();
}
