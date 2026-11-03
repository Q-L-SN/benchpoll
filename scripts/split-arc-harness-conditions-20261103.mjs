import fs, { lstat, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { HARNESS_SPLIT_RELEASE, buildHarnessSplitPlan, canonicalJSON, harnessHash,
    referencesHarnessTarget, validateHarnessReview } from '../benchmark-harness-split.js';
import { loadScoreFieldCatalog } from '../score-field-service.js';
import { fieldDisplayValue, normalizeScoreFields } from '../public/js/shared/score-fields.js';
import { verifySlugBackup } from './migrate-topic-slugs-20261023.mjs';

const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
export async function readHarnessState(connection, review, { lock = false } = {}) {
    validateHarnessReview(review);
    const IDs = review.targets.map(target => target.benchmarkID), suffix = lock ? ' FOR UPDATE' : '';
    const [benchmarks] = await connection.query('SELECT * FROM benchmarks WHERE ID IN (?) ORDER BY ID' + suffix, [IDs]);
    const [conditions] = await connection.query('SELECT * FROM benchmark_conditions WHERE benchmark_ID IN (?) ORDER BY ID' + suffix, [IDs]);
    const [results] = await connection.query('SELECT * FROM benchmark_results WHERE benchmark_ID IN (?) ORDER BY ID' + suffix, [IDs]);
    const catalog = await loadScoreFieldCatalog(connection, null, lock);
    for (const row of results) {
        row.benchmark_condition_snapshot = parse(row.benchmark_condition_snapshot);
        row.score_fields = parse(row.score_fields);
        if (row.status !== 'accepted') continue;
        row.publicIdentity = { ID: Number(row.ID), modelID: Number(row.model_ID), rawScore: Number(row.raw_score),
            sourceURL: row.source_url, sourceTitle: row.source_title,
            fields: normalizeScoreFields(row.score_fields, catalog).map(item => {
                const field = catalog.find(field => field.ID === item.fieldID);
                return { name: field.name, value: fieldDisplayValue(field, item.value) };
            }) };
    }
    const [pending] = await connection.query("SELECT ID, content FROM moderation_logs WHERE status = 'pending' ORDER BY ID" + suffix);
    const benchmarkIDs = new Set(IDs), conditionIDs = new Set(conditions.map(row => Number(row.ID)));
    return { benchmarks, conditions, results, catalog,
        pendingTargetRequests: pending.filter(row => referencesHarnessTarget(parse(row.content), benchmarkIDs, conditionIDs)).map(row => Number(row.ID)) };
}

export async function previewHarnessSplit(connection, review) {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    try { return buildHarnessSplitPlan(await readHarnessState(connection, review), review); }
    finally { await connection.rollback(); }
}

// Caller must verify its backup before invoking this mutation. The CLI requires
// that backup and a digest from a fresh database preview; public API data alone
// cannot authorize a production apply.
export async function applyHarnessSplit(connection, review, { expectedPlanHash, rehearse = false, beforeCommit } = {}) {
    if (!/^[a-f0-9]{64}$/.test(expectedPlanHash ?? '')) throw new Error('A fresh database plan hash is required');
    const [[lock]] = await connection.execute('SELECT GET_LOCK(?,0) AS acquired', [HARNESS_SPLIT_RELEASE]);
    if (Number(lock.acquired) !== 1) throw new Error('Harness split is already running');
    let committed = false;
    try {
        await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await connection.beginTransaction();
        const before = await readHarnessState(connection, review, { lock: true });
        const plan = buildHarnessSplitPlan(before, review);
        if (!plan.canApply || plan.planHash !== expectedPlanHash) throw new Error('Harness split review is blocked or stale');
        const changed = [];
        for (const target of plan.targets) {
            for (const bucket of target.buckets) {
                if (bucket.create) {
                    const [inserted] = await connection.execute(`INSERT INTO benchmark_conditions
                        (benchmark_ID, condition_key, name, score_direction, uses_percentage_scale, is_default, is_primary, difference_explanation)
                        VALUES (?, ?, ?, 'higher', 1, 0, 0, ?)`, [target.benchmarkID, bucket.conditionKey, bucket.name, bucket.explanation]);
                    bucket.ID = Number(inserted.insertId);
                } else if (bucket.update) {
                    await connection.execute('UPDATE benchmark_conditions SET name = ?, difference_explanation = ?, is_default = 0 WHERE ID = ?',
                        [bucket.name, bucket.explanation, bucket.ID]);
                }
            }
            const affected = new Map([...target.moves, ...target.snapshots].map(row => [row.ID, row.bucket]));
            for (const [ID, bucketKey] of affected) {
                const row = before.results.find(row => Number(row.ID) === ID), bucket = target.buckets.find(row => row.key === bucketKey);
                const snapshot = { ...row.benchmark_condition_snapshot, benchmarkID: target.benchmarkID, conditionID: bucket.ID, name: bucket.name };
                const [updated] = await connection.execute(`UPDATE benchmark_results SET benchmark_condition_ID = ?,
                    benchmark_condition_snapshot = ? WHERE ID = ? AND benchmark_condition_ID = ? AND status = 'accepted'`,
                [bucket.ID, JSON.stringify(snapshot), ID, row.benchmark_condition_ID]);
                if (updated.affectedRows !== 1) throw new Error('Concurrent score mutation');
                changed.push({ resultID: ID, from: Number(row.benchmark_condition_ID), to: bucket.ID });
            }
            if (affected.size) await connection.execute('UPDATE benchmarks SET scores_updated_at = UTC_TIMESTAMP(3) WHERE ID = ?', [target.benchmarkID]);
        }
        const after = await readHarnessState(connection, review, { lock: true });
        const verified = buildHarnessSplitPlan(after, review);
        if (!verified.canApply || verified.mutations !== 0) throw new Error('Harness split verification failed');
        // Only the condition association, its display snapshot and update timestamp
        // may change. This includes archived/inactive evidence in the comparison.
        const evidence = state => state.results.map(row => Object.fromEntries(Object.entries(row)
            .filter(([key]) => !['benchmark_condition_ID', 'benchmark_condition_snapshot', 'updated_at'].includes(key))));
        if (canonicalJSON(evidence(before)) !== canonicalJSON(evidence(after))) throw new Error('Score evidence changed during harness split');
        const receipt = { release: HARNESS_SPLIT_RELEASE, applied: !rehearse, rehearsed: rehearse,
            planHash: expectedPlanHash, reviewHash: plan.reviewHash, changed,
            before, after, afterHash: harnessHash(after), counts: plan.targets.map(row => ({ benchmarkID: row.benchmarkID, counts: row.counts })) };
        if (beforeCommit) await beforeCommit({ ...receipt, applied: false, phase: 'prepared' });
        if (rehearse) await connection.rollback(); else { await connection.commit(); committed = true; }
        return receipt;
    } catch (error) { if (!committed) await connection.rollback(); throw error; }
    finally { await connection.execute('SELECT RELEASE_LOCK(?)', [HARNESS_SPLIT_RELEASE]); }
}

export async function openHarnessReceipt(path) {
    const destination = resolve(path), parent = await realpath(dirname(destination));
    for (let directory = parent; ; directory = dirname(directory)) {
        try { await lstat(join(directory, '.git')); throw new Error('Harness receipts must stay outside every Git repository'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (dirname(directory) === directory) break;
    }
    const directory = await fs.open(parent, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
        const file = await fs.open(join(parent, basename(destination)),
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        return {
            async write(result) {
                await file.writeFile(JSON.stringify(result, null, 2) + '\n', 'utf8');
                await file.sync();
                // The new filename must survive a crash as well as its contents.
                await directory.sync();
            },
            async close() { try { await file.close(); } finally { await directory.close(); } }
        };
    } catch (error) { await directory.close(); throw error; }
}

async function main() {
    const args = process.argv.slice(2), apply = args.includes('--apply'), rehearse = args.includes('--rehearse');
    const option = key => args.find(arg => arg.startsWith(key + '='))?.slice(key.length + 1);
    if (apply && rehearse || args.some(arg => !['--apply', '--rehearse'].includes(arg)
        && !['--review=', '--expect-plan=', '--backup-manifest=', '--output='].some(prefix => arg.startsWith(prefix)))) throw new Error('Invalid harness split arguments');
    const review = validateHarnessReview(JSON.parse(await readFile(resolve(option('--review') || 'ops/arc-harness-review-20261103.json'), 'utf8')));
    const database = process.env.BENCHPOLL_DB_NAME, user = process.env.BENCHPOLL_DB_USER;
    if (!database || !user || !process.env.BENCHPOLL_DB_HOST && !process.env.BENCHPOLL_DB_SOCKET) throw new Error('Explicit database name, user and host/socket required');
    if ((apply || rehearse) && !option('--output')) throw new Error('An outside-repository receipt path is required');
    if (rehearse && !/^benchpoll_harness_rehearsal_[a-z0-9_]+$/.test(database)) throw new Error('Use an isolated harness rehearsal database');
    if (apply) await verifySlugBackup(option('--backup-manifest'), database);
    const output = option('--output') ? await openHarnessReceipt(option('--output')) : null;
    let prepared;
    let connection;
    try {
        if (apply || rehearse) prepared = await openHarnessReceipt(option('--output') + '.prepared.json');
        connection = await mysql.createConnection({ database, user, password: process.env.DB_PASSWORD,
            socketPath: process.env.BENCHPOLL_DB_SOCKET, host: process.env.BENCHPOLL_DB_HOST,
            port: Number(process.env.BENCHPOLL_DB_PORT || 3306), dateStrings: true, timezone: 'Z',
            supportBigNumbers: true, bigNumberStrings: true });
        const result = apply || rehearse ? await applyHarnessSplit(connection, review,
            { expectedPlanHash: option('--expect-plan'), rehearse, beforeCommit: result => prepared.write(result) }) : await previewHarnessSplit(connection, review);
        await output?.write({ ...result, phase: apply ? 'committed' : rehearse ? 'rolled-back-rehearsal' : 'preview' });
        console.log(JSON.stringify(apply || rehearse ? { applied: result.applied, rehearsed: result.rehearsed, counts: result.counts }
            : { canApply: result.canApply, mutations: result.mutations, planHash: result.planHash, blockers: result.blockers, counts: result.targets.map(row => row.counts) }));
    } finally { try { await connection?.end(); } finally { try { await output?.close(); } finally { await prepared?.close(); } } }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
