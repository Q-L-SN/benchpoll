import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { request } from 'node:https';
import { fileURLToPath } from 'node:url';
import { arenaRowKey, arenaScore } from '../arena-import-plan.js';
import { initializeArenaConflictSchema } from '../arena-sync-conflicts.js';
import { loadModels } from '../ranking-service.js';
import { loadScoreFieldCatalog } from '../score-field-service.js';
import { normalizeScoreFields } from '../public/js/shared/score-fields.js';

const database = 'benchpoll_review_fixes_rehearsal_20261004';
const snapshotPath = process.argv[2];
if (!snapshotPath) throw new Error('A fetched Arena snapshot is required');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../artifacts/review-fixes-rehearsal/', import.meta.url);
await mkdir(output, { recursive: true });
const db = await mysql.createConnection({ socketPath: '/var/run/mysqld/mysqld.sock', user: 'root',
    database: 'benchmarks', charset: 'utf8mb4', dateStrings: true, timezone: 'Z' });
const secret = randomUUID() + randomUUID();
const env = { ...process.env, DOTENV_CONFIG_PATH: '/dev/null', BENCHPOLL_DB_NAME: database,
    BENCHPOLL_DB_USER: 'root', BENCHPOLL_DB_PASSWORD: '', DB_PASSWORD: 'unused-socket-credential',
    BENCHPOLL_DB_SOCKET: '/var/run/mysqld/mysqld.sock', SESSION_SECRET: secret,
    SESSION_CLEANUP_INTERVAL_MINUTES: '60', SESSION_MAX_AGE_DAYS: '1', GITHUB_CLIENT_SECRET: 'rehearsal-not-for-oauth',
    GITHUB_MIN_ACCOUNT_AGE_DAYS: '0', BENCHPOLL_PORT: '2437', BENCHPOLL_BIND_HOST: '127.0.0.1', PUBLIC_ORIGIN: 'https://127.0.0.1:2437' };
for (const key of ['BENCHPOLL_SMTP_HOST', 'BENCHPOLL_SMTP_PORT', 'BENCHPOLL_SMTP_SECURE', 'BENCHPOLL_SMTP_USER', 'BENCHPOLL_SMTP_PASSWORD', 'BENCHPOLL_NOTIFICATION_FROM']) env[key] = '';
let created = false;
let child;
let cookie;
let log = '';
let revision = 0;
function run(script, args, failure = null) {
    const result = spawnSync(process.execPath, [`scripts/${script}`, ...args], { cwd: root, env,
        encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    if (failure) { assert.notEqual(result.status, 0); assert.match(result.stderr, failure); return; }
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}
function api(endpoint, body, authenticated = true) {
    return new Promise((resolve, reject) => {
        const req = request(`https://127.0.0.1:2437/api/${endpoint}`, { method: 'POST', rejectUnauthorized: false,
            headers: { 'Content-Type': 'application/json', ...(authenticated ? { Cookie: cookie } : {}) } }, res => {
            let data = ''; res.on('data', chunk => { data += chunk; });
            res.on('end', () => { try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); } catch (error) { reject(error); } });
        });
        req.on('error', reject); req.end(JSON.stringify(body));
    });
}
const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
const feed = snapshot.configs.find(config => config.config === 'text');
assert.ok(feed?.rows.length > 2);
const sourceRow = feed.rows.find(row => row.category === 'overall');
assert.ok(sourceRow);
const key = arenaRowKey('text', sourceRow);
async function tracked() {
    const [[row]] = await db.execute(`SELECT a.*,r.raw_score,r.model_ID,r.score_fields,r.benchmark_ID,r.benchmark_condition_ID,r.status
        FROM arena_import_rows a JOIN benchmark_results r ON r.ID=a.result_ID WHERE a.row_key=?`, [key]);
    return row;
}
async function candidate(rating) {
    revision++;
    const result = structuredClone(snapshot);
    result.revision = createHash('sha256').update(`review-rehearsal-${revision}`).digest('hex').slice(0, 40);
    result.sourceModifiedAt = new Date(Date.parse(snapshot.sourceModifiedAt) + revision * 1000).toISOString();
    result.fetchedAt = new Date(Math.max(Date.parse(snapshot.fetchedAt), Date.parse(result.sourceModifiedAt)) + 1000).toISOString();
    const rows = result.configs.find(config => config.config === 'text');
    rows.rows = rows.rows.filter(row => {
        if (arenaRowKey('text', row) !== key) return true;
        if (rating === null) return false;
        row.rating = rating; return true;
    });
    const bytes = JSON.stringify(rows.rows);
    rows.checksums = [{ filename: 'latest/test-00000-of-00001.parquet', rows: rows.rows.length,
        size: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') }];
    const file = fileURLToPath(new URL(`candidate-${revision}.json`, output));
    await writeFile(file, JSON.stringify(result));
    return file;
}
const importArgs = file => [file, '--apply', '--backup-confirmed', '--schema-ready', '--config', 'text'];
async function conflictRequest(choice) {
    const response = await api('list_score_sync_conflicts', {});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const row = response.body.conflicts.find(row => row.row_key === key);
    assert.ok(row);
    const answer = await api('resolve_score_sync_conflict', { rowKey: key, resultID: row.result_ID, incomingHash: row.incoming_hash, choice });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    return { row, answer };
}
try {
    await db.query(`CREATE DATABASE ${database}`);
    created = true;
    const tables = ['organizations', 'models', 'benchmarks', 'benchmark_conditions', 'benchmark_tags', 'benchmark_tag_links',
        'benchmark_results', 'arena_sync_batches', 'arena_sync_state', 'arena_sync_feed_state', 'arena_import_rows',
        'moderation_logs', 'moderation_audit_logs', 'score_fields', 'score_field_options', 'user_comparison_profiles',
        'categories', 'ranking_dimensions', 'ranking_dimension_options', 'ranking_contexts', 'users',
        'personal_pies', 'personal_pie_weights', 'personal_pie_score_rules', 'personal_pie_score_rule_components',
        'sessions', 'user_sessions', 'score_sync_jobs', 'score_sync_runs', 'score_sync_registry_events'];
    for (const table of tables) {
        await db.query(`CREATE TABLE ${database}.${table} LIKE benchmarks.${table}`);
        if (['sessions', 'user_sessions'].includes(table)) continue;
        const [columns] = await db.query(`SHOW COLUMNS FROM benchmarks.${table}`);
        const names = columns.filter(column => !column.Extra.includes('GENERATED')).map(column => {
            if (!/^[a-zA-Z0-9_]+$/.test(column.Field)) throw new Error('Unsafe rehearsal column');
            return `\`${column.Field}\``;
        }).join(',');
        await db.query(`INSERT INTO ${database}.${table} (${names}) SELECT ${names} FROM benchmarks.${table}`);
    }
    await db.query(`USE ${database}`);
    await initializeArenaConflictSchema(db);
    await initializeArenaConflictSchema(db);
    const [[foreignKey]] = await db.query(`SELECT COUNT(*) n FROM information_schema.referential_constraints
        WHERE constraint_schema=? AND table_name='arena_sync_conflicts' AND referenced_table_name='benchmark_results'`, [database]);
    assert.equal(Number(foreignKey.n), 1);
    const initial = await tracked(); assert.ok(initial);
    const [[countBefore]] = await db.query('SELECT COUNT(*) n FROM benchmark_conditions');
    await db.execute("UPDATE benchmarks SET name='Renamed Arena review fixture' WHERE ID=?", [initial.benchmark_ID]);
    await db.execute("UPDATE benchmark_conditions SET name='Renamed condition',condition_key='renamed-review' WHERE ID=?", [initial.benchmark_condition_ID]);
    const same = run('import-arena-latest.mjs', importArgs(snapshotPath));
    assert.equal(same.createdBenchmarks, 0); assert.equal(same.createdConditions, 0); assert.equal(same.insertedResults, 0);
    assert.equal((await tracked()).benchmark_condition_ID, initial.benchmark_condition_ID);
    const [[countAfter]] = await db.query('SELECT COUNT(*) n FROM benchmark_conditions');
    assert.deepEqual(countBefore, countAfter);

    const [[user]] = await db.query("SELECT ID FROM users WHERE role='senior' AND deleted_at IS NULL LIMIT 1");
    assert.ok(user);
    const sessionID = randomUUID();
    await db.execute('INSERT INTO sessions (session_id,expires,data) VALUES (?,?,?)', [sessionID, Math.floor(Date.now() / 1000) + 1800,
        JSON.stringify({ cookie: { originalMaxAge: 1800000, expires: new Date(Date.now() + 1800000).toISOString(), httpOnly: true, path: '/' }, userID: user.ID })]);
    cookie = 'sid=' + encodeURIComponent('s:' + sessionID + '.' + createHmac('sha256', secret).update(sessionID).digest('base64').replace(/=+$/, ''));
    child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
    for (let attempt = 0; ; attempt++) {
        try { const response = await api('list_score_sync_conflicts', {}, false); assert.equal(response.status, 401); break; }
        catch (error) { if (attempt >= 50 || child.exitCode !== null) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.equal((await api('resolve_score_sync_conflict', {}, false)).status, 401);
    const manualScore = Number(initial.raw_score) + 3;
    await db.execute('UPDATE benchmark_results SET raw_score=? WHERE ID=?', [manualScore, initial.result_ID]);
    await db.execute("UPDATE arena_import_rows SET manual_override='edit' WHERE row_key=?", [key]);
    let file = await candidate(sourceRow.rating + 20);
    const [[pointer]] = await db.query("SELECT current_batch_ID FROM arena_sync_feed_state WHERE config='text'");
    run('import-arena-latest.mjs', importArgs(file), /source changes need review/);
    const [[failedPointer]] = await db.query("SELECT current_batch_ID FROM arena_sync_feed_state WHERE config='text'");
    assert.deepEqual(pointer, failedPointer);
    assert.equal(Number((await tracked()).raw_score), manualScore);
    const kept = await conflictRequest('correction'); assert.equal(kept.answer.body.status, 'kept_correction');
    const repeated = run('import-arena-latest.mjs', importArgs(file)); assert.equal(repeated.manualCorrections, 1);
    assert.equal(Number((await tracked()).raw_score), manualScore);
    const definitions = await loadScoreFieldCatalog(db);
    const scoreFields = normalizeScoreFields(typeof initial.score_fields === 'string' ? JSON.parse(initial.score_fields) : initial.score_fields, definitions);
    const model = (await loadModels(db, definitions)).find(model => model.modelID === Number(initial.model_ID)
        && JSON.stringify(model.condition.scoreFields) === JSON.stringify(scoreFields));
    assert.ok(model);
    const evidence = model.results.get(String(initial.benchmark_condition_ID)); assert.ok(evidence);
    const detail = { modelID: Number(initial.model_ID), scoreFields, expectedEvidence: { conditionID: Number(initial.benchmark_condition_ID), hash: evidence.evidenceHash } };
    const current = await api('get_approved_benchmark_results', detail, false);
    assert.equal(current.status, 200, JSON.stringify(current.body));
    assert.equal(current.body.scoreGroups.find(group => group.benchmarkConditionID === detail.expectedEvidence.conditionID).evidenceHash, evidence.evidenceHash);

    file = await candidate(sourceRow.rating + 30);
    run('import-arena-latest.mjs', importArgs(file), /source changes need review/);
    const accepted = await conflictRequest('source'); assert.equal(accepted.answer.body.status, 'accept_source');
    assert.equal((await api('resolve_score_sync_conflict', { rowKey: key, resultID: accepted.row.result_ID, incomingHash: accepted.row.incoming_hash, choice: 'source' })).status, 409);
    const published = run('import-arena-latest.mjs', importArgs(file)); assert.equal(published.replacedResults, 1);
    let next = await tracked();
    assert.equal(Number(next.raw_score), arenaScore('text', { ...sourceRow, rating: sourceRow.rating + 30 }));
    assert.notEqual(next.result_ID, initial.result_ID); assert.equal(next.manual_override, 'none');
    const stale = await api('get_approved_benchmark_results', detail, false);
    assert.equal(stale.status, 409); assert.equal(stale.body.error, 'ranking_evidence_changed');
    const all = await api('get_approved_benchmark_results', { modelID: detail.modelID, scoreFields }, false); assert.equal(all.status, 200);

    await db.execute("UPDATE benchmark_results SET status='superseded' WHERE ID=?", [next.result_ID]);
    await db.execute("UPDATE arena_import_rows SET manual_override='delete' WHERE row_key=?", [key]);
    file = await candidate(sourceRow.rating + 40);
    run('import-arena-latest.mjs', importArgs(file), /source changes need review/);
    await conflictRequest('source');
    run('import-arena-latest.mjs', importArgs(file));
    next = await tracked(); assert.equal(next.status, 'accepted'); assert.equal(next.manual_override, 'none');
    await db.execute("UPDATE arena_import_rows SET manual_override='edit' WHERE row_key=?", [key]);
    file = await candidate(null);
    run('import-arena-latest.mjs', importArgs(file), /source changes need review/);
    await conflictRequest('source');
    const removed = run('import-arena-latest.mjs', importArgs(file)); assert.equal(removed.retiredResults, 1);
    assert.equal(await tracked(), undefined);
    const [[audit]] = await db.query("SELECT COUNT(*) n FROM moderation_audit_logs WHERE request_type='score_sync_conflict' AND outcome='success' AND reviewer_user_ID=?", [user.ID]);
    assert.equal(Number(audit.n), 4);
    const [[pending]] = await db.query('SELECT COUNT(*) n FROM arena_sync_conflicts'); assert.equal(Number(pending.n), 0);
    const scoring = run('verify-scoring-mode-samples.mjs', []); assert.equal(scoring.passed, true);
    const summary = { passed: true, productionScoresChanged: 0, stableRenamedIdentity: true,
        conflictRollbackPreservesPublication: true, correctionRetained: true, officialUpdateApproved: true,
        deletionRestoredAfterReview: true, removalReviewed: true, reviewerAuditRows: Number(audit.n),
        evidenceVersionVerified: true, staleEvidenceRejected: true, scoring };
    await writeFile(new URL('results.json', output), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
} catch (error) {
    console.error(log); throw error;
} finally {
    if (child?.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; }
    try { if (created) await db.query(`DROP DATABASE ${database}`); }
    finally { await db.end(); }
}
