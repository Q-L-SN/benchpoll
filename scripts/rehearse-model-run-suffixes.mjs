import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { modelRunConfiguration, runConfigurationFields } from '../model-run-configuration.js';
import { loadScoreFieldCatalog } from '../score-field-service.js';
import { normalizeScoreFields } from '../public/js/shared/score-fields.js';

const database = 'benchpoll_model_run_suffixes_rehearsal_20261004';
const snapshotPath = process.argv[2];
if (!snapshotPath) throw new Error('A fetched official Arena snapshot path is required');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../artifacts/model-run-suffixes-rehearsal/', import.meta.url);
await mkdir(output, { recursive: true });
const db = await mysql.createConnection({ socketPath: '/var/run/mysqld/mysqld.sock', user: 'root',
    database: 'benchmarks', charset: 'utf8mb4', dateStrings: true, timezone: 'Z' });
const env = { ...process.env, DOTENV_CONFIG_PATH: '/dev/null', BENCHPOLL_DB_NAME: database,
    BENCHPOLL_DB_USER: 'root', BENCHPOLL_DB_PASSWORD: '', BENCHPOLL_DB_SOCKET: '/var/run/mysqld/mysqld.sock',
    BENCHPOLL_RUN_CONFIG_OUTPUT: fileURLToPath(new URL('configurations/', output)) };
let created = false;
function run(script, args = []) {
    const result = spawnSync(process.execPath, [`scripts/${script}`, ...args], { cwd: root, env,
        encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}
async function protectedEvidence() {
    const [scores] = await db.query(`SELECT ID,SHA2(JSON_ARRAY(ID,raw_score,status,source_url,source_title,source_type,
        notes,benchmark_ID,benchmark_condition_ID,benchmark_condition_snapshot,created_at),256) AS fingerprint
        FROM benchmark_results ORDER BY ID`);
    const digest = createHash('sha256');
    for (const score of scores) digest.update(`${score.ID}:${score.fingerprint}\n`);
    const [[pies]] = await db.query('SELECT COUNT(*) AS count,SUM(weight_basis_points) AS total FROM personal_pie_weights');
    return { scores: scores.length, evidenceHash: digest.digest('hex'), pies };
}
try {
    await db.query(`CREATE DATABASE ${database}`);
    created = true;
    const tables = ['organizations', 'models', 'benchmarks', 'benchmark_conditions', 'benchmark_tags', 'benchmark_tag_links',
        'benchmark_results', 'personal_pie_weights', 'personal_pie_score_rule_components', 'arena_sync_batches',
        'arena_sync_state', 'arena_sync_feed_state', 'arena_import_rows', 'arena_sync_conflicts', 'moderation_logs',
        'score_fields', 'score_field_options', 'user_comparison_profiles', 'categories', 'ranking_dimensions',
        'ranking_dimension_options', 'ranking_contexts', 'users', 'personal_pies', 'personal_pie_score_rules'];
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
    const before = await protectedEvidence();
    const fieldRegistration = run('register-model-run-fields.mjs', ['--apply', '--backup-confirmed']);
    const repeatedRegistration = run('register-model-run-fields.mjs', ['--apply', '--backup-confirmed']);
    assert.equal(repeatedRegistration.createdField, false);
    assert.deepEqual(repeatedRegistration.missingOptions, []);
    const dryRun = run('migrate-model-run-configurations.mjs');
    assert.deepEqual(await protectedEvidence(), before);
    const plan = JSON.parse(await readFile(new URL('configurations/plan.json', output), 'utf8'));
    const originalScores = new Map();
    for (const mapping of plan.modelMappings) {
        const [scores] = await db.execute('SELECT ID,score_fields FROM benchmark_results WHERE model_ID=?', [mapping.fromID]);
        originalScores.set(mapping.fromID, scores);
    }
    const migration = run('migrate-model-run-configurations.mjs', ['--apply', '--backup-confirmed']);
    assert.equal(migration.models, dryRun.models);
    assert.equal(migration.scores, dryRun.scores);
    assert.deepEqual(await protectedEvidence(), before);
    const fields = await loadScoreFieldCatalog(db);
    for (const mapping of plan.modelMappings) {
        const [scores] = await db.query('SELECT ID,model_ID,score_fields FROM benchmark_results WHERE ID IN (?)',
            [originalScores.get(mapping.fromID).map(score => score.ID)]);
        assert.equal(scores.length, originalScores.get(mapping.fromID).length);
        for (const score of scores) {
            assert.equal(Number(score.model_ID), mapping.toID);
            const assignments = normalizeScoreFields(score.score_fields, fields);
            for (const assignment of mapping.fields) assert.ok(assignments.some(item => item.fieldID === assignment.fieldID
                && item.value === assignment.value), `Result ${score.ID} lost an inferred run field`);
        }
        const [[model]] = await db.execute('SELECT name,is_active FROM models WHERE ID=?', [mapping.fromID]);
        if (mapping.fromID === mapping.toID) assert.equal(model.name, mapping.baseName);
        else assert.equal(model.is_active, 0);
    }
    const repeated = run('migrate-model-run-configurations.mjs', ['--apply', '--backup-confirmed']);
    assert.equal(repeated.models, 0);
    assert.equal(repeated.scores, 0);
    assert.deepEqual(await protectedEvidence(), before);
    console.log(JSON.stringify({ phase: 'migration', models: migration.models, scores: migration.scores,
        fieldsPreserved: true, evidenceUnchanged: true }));
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
    const feeds = [];
    for (const config of ['text', 'search', 'search_factuality', 'search_style_control']) {
        assert.ok(snapshot.expectedConfigs.includes(config));
        const args = [snapshotPath, '--apply', '--backup-confirmed', '--schema-ready', '--config', config];
        const first = run('import-arena-latest.mjs', args);
        const again = run('import-arena-latest.mjs', args);
        assert.equal(again.insertedResults, 0);
        assert.equal(again.remappedResults, 0);
        feeds.push({ config, createdModels: first.createdModels, insertedResults: first.insertedResults,
            repeatInserted: again.insertedResults, repeatRemapped: again.remappedResults });
        console.log(JSON.stringify({ phase: 'sync', ...feeds.at(-1) }));
    }
    const [active] = await db.query(`SELECT m.ID,m.name,o.slug AS vendorSlug FROM models m
        JOIN organizations o ON o.ID=m.vendor_ID WHERE m.is_active=1`);
    const leftover = active.filter(model => {
        const run = modelRunConfiguration(model.name, model.vendorSlug);
        return Object.keys(run.configuration).length || run.baseName !== model.name;
    });
    assert.deepEqual(leftover, []);
    const [tracking] = await db.query(`SELECT m.name,o.slug AS vendorSlug,r.score_fields,a.model_key
        FROM arena_import_rows a JOIN benchmark_results r ON r.ID=a.result_ID
        JOIN models m ON m.ID=r.model_ID JOIN organizations o ON o.ID=m.vendor_ID
        WHERE a.model_key LIKE '%highpreview%' OR a.model_key LIKE '%pplsonar%'`);
    assert.ok(tracking.length);
    for (const row of tracking) {
        const original = snapshot.configs.flatMap(config => config.rows).find(source =>
            source.model_name.includes('high-preview') && row.model_key.endsWith(source.model_name.replace(/[^a-z0-9]/g, '')));
        const assignments = normalizeScoreFields(row.score_fields, fields);
        if (original) {
            assert.match(row.name, /-preview$/);
            for (const field of runConfigurationFields(modelRunConfiguration(original.model_name, row.vendorSlug).configuration, fields)) {
                assert.ok(assignments.some(item => item.fieldID === field.fieldID && item.value === field.value));
            }
        } else if (row.model_key.includes('pplsonar')) {
            const field = fields.find(field => field.name === 'Search context size');
            const high = field.options.find(option => option.label === 'high');
            assert.ok(assignments.some(item => item.fieldID === field.ID && item.value === high.ID));
            assert.ok(!assignments.some(item => fields.find(field => field.ID === item.fieldID).name === 'Reasoning effort'));
        }
    }
    const samples = run('verify-scoring-mode-samples.mjs');
    assert.equal(samples.passed, true);
    const summary = { passed: true, productionWrites: 0, before, fieldRegistration, migration,
        mappings: plan.modelMappings, repeatedMigrationHasNoChanges: true, sourceLabelsRemoved: true, feeds, identicalScoringSamples: samples.passed };
    await writeFile(new URL('results.json', output), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
} finally {
    await db.query('USE benchmarks');
    if (created) await db.query(`DROP DATABASE ${database}`);
    await db.end();
}
