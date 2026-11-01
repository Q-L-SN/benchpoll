#!/usr/bin/env node

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { primaryFlagForNewCondition } from '../benchmark-primary-condition.js';
import { arenaTrackedAction, assertFreshArenaBatch, cleanupArenaImportConnection, initializeArenaSyncSchema,
    publishArenaBatch, selectArenaSnapshotConfig, validateArenaSnapshot } from '../arena-sync.js';
import { markBenchmarkScoresUpdated } from '../benchmark-details.js';
import { ArenaSyncConflictError, findArenaSyncConflicts } from '../arena-sync-conflicts.js';
import { loadScoreFieldCatalog } from '../score-field-service.js';
import { mergeRunConfigurationFields, modelRunConfiguration, runConfigurationFields } from '../model-run-configuration.js';
import {
    arenaCanonicalModelName, arenaCondition, arenaModelKey, arenaRowHash,
    arenaResultVendorSlug, arenaTrackedIdentities, arenaVendorName,
} from '../arena-import-plan.js';

const SOURCE_URL = 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset';
const LOCK_NAME = 'benchpoll_arena_latest_import';
const apply = process.argv.includes('--apply');
const snapshotPath = resolve(process.argv.find(arg => arg.endsWith('.json')) || 'artifacts/arena-latest.json');
const rawSnapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
const configIndex = process.argv.indexOf('--config');
const scoped = configIndex !== -1;
if (scoped && !/^[a-z0-9_]+$/.test(process.argv[configIndex + 1] || '')) throw new Error('A config name is required');
const snapshot = scoped ? selectArenaSnapshotConfig(rawSnapshot, process.argv[configIndex + 1]) : rawSnapshot;
const batch = validateArenaSnapshot(snapshot);
const plan = batch.plan;
const overview = {
    revision: snapshot.revision, source: SOURCE_URL, license: snapshot.license,
    snapshotPath, rows: plan.entries.length, benchmarks: plan.benchmarkNames.length,
    skippedEquivalentWebDevAliases: plan.skippedAliases.length,
    conflictingSourceGroups: plan.conflicts
};
if (!apply) {
    console.log(JSON.stringify({ dryRun: true, ...overview }, null, 2));
    process.exit(0);
}
const runIndex = process.argv.indexOf('--sync-run');
const syncRunID = runIndex === -1 ? null : Number(process.argv[runIndex + 1]);
if (runIndex !== -1 && (!Number.isSafeInteger(syncRunID) || syncRunID <= 0 || !scoped)) throw new Error('Invalid scheduled sync run');
if (!process.argv.includes('--backup-confirmed') && syncRunID === null) {
    throw new Error('Take and verify a production database backup, then pass --backup-confirmed');
}

const connectionOptions = {
    socketPath: process.env.BENCHPOLL_DB_SOCKET || '/var/run/mysqld/mysqld.sock',
    user: process.env.BENCHPOLL_DB_USER || 'root',
    password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks',
    charset: 'utf8mb4', dateStrings: true, timezone: 'Z', connectTimeout: 5000
};
const connection = await mysql.createConnection(connectionOptions);
let locked = false, importError = null, stats;
try {
    const [[{ acquired }]] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [LOCK_NAME]);
    if (Number(acquired) !== 1) throw new Error('Arena import lock unavailable');
    locked = true;
    if (syncRunID !== null) {
        const [runs] = await connection.execute(`SELECT r.ID FROM score_sync_runs r
            JOIN score_sync_jobs j ON j.ID=r.job_ID
            WHERE r.ID=? AND r.status='running' AND j.source_key='arena_official' AND j.enabled=1`, [syncRunID]);
        if (runs.length !== 1) throw new Error('Scheduled Arena publication has no authorized running job');
    }
    if (!process.argv.includes('--schema-ready')) await initializeArenaSyncSchema(connection);
    stats = await publishArenaBatch(connection, batch, async () => {
        const [tracked] = await connection.query(`SELECT a.row_key,a.result_ID,a.source_hash,r.model_ID,
            a.config,a.category,a.source_date,a.manual_override,r.status AS result_status,r.benchmark_ID,r.benchmark_condition_ID,r.score_fields
            FROM arena_import_rows a JOIN benchmark_results r ON r.ID=a.result_ID
            ${scoped ? 'WHERE a.config IN (?)' : ''} FOR UPDATE`, scoped ? [snapshot.expectedConfigs] : []);
        assertFreshArenaBatch(batch, { trackedRows: tracked });
        const [conflictResolutions] = await connection.query(`SELECT * FROM arena_sync_conflicts
            ${scoped ? 'WHERE config IN (?)' : ''} FOR UPDATE`, scoped ? [snapshot.expectedConfigs] : []);
        const conflicts = findArenaSyncConflicts(plan.entries, tracked, conflictResolutions);
        if (conflicts.length) throw new ArenaSyncConflictError(conflicts);
        const resolutionsByKey = new Map(conflictResolutions.map(row => [row.row_key, row]));
        const [[autoIncrement]] = await connection.query('SELECT @@auto_increment_increment AS increment_value');
        if (Number(autoIncrement.increment_value) !== 1) throw new Error('Arena batch insertion requires consecutive generated result IDs');
        const [benchmarks] = await connection.query('SELECT ID,name FROM benchmarks');
        const benchmarkIDs = new Map(benchmarks.map(row => [row.name, row.ID]));
        const [conditions] = await connection.query(`SELECT ID,benchmark_ID,condition_key,name,
            score_direction,target_value,uses_percentage_scale,score_min,score_max,is_default,deleted_at,score_source
            FROM benchmark_conditions`);
        const conditionIDs = new Map(conditions.map(row => [`${row.benchmark_ID}:${row.condition_key}`, row]));
        const [identities] = await connection.query(`SELECT DISTINCT a.config,a.category,r.benchmark_ID,r.benchmark_condition_ID
            FROM arena_import_rows a JOIN benchmark_results r ON r.ID=a.result_ID`);
        const stableIdentities = arenaTrackedIdentities(identities, benchmarks, conditions);
        for (const [name, ID] of stableIdentities.benchmarkIDs) benchmarkIDs.set(name, ID);
        for (const [key, condition] of stableIdentities.conditionIDs) conditionIDs.set(key, condition);
        const [organizations] = await connection.query('SELECT ID,slug,name FROM organizations');
        const organizationIDs = new Map(organizations.map(row => [row.slug, row.ID]));
        const [models] = await connection.query('SELECT ID,vendor_ID,name,slug FROM models WHERE is_active=1');
        const scoreFieldDefinitions = await loadScoreFieldCatalog(connection);
        const [modelScores] = await connection.query(`SELECT model_ID,COUNT(*) AS result_count
            FROM benchmark_results WHERE status='accepted' GROUP BY model_ID`);
        const modelScoreCount = new Map(modelScores.map(row => [row.model_ID, Number(row.result_count)]));
        const modelIDs = new Map();
        for (const row of models) {
            const key = `${row.vendor_ID}:${arenaCanonicalModelName(row.name)}`;
            if (!modelIDs.has(key)) modelIDs.set(key, []);
            modelIDs.get(key).push(row);
        }
        const trackedByKey = new Map(tracked.map(row => [row.row_key, row]));

        const stats = { createdBenchmarks: 0, createdConditions: 0, createdOrganizations: 0,
            createdModels: 0, insertedResults: 0, replacedResults: 0, retiredResults: 0,
            unchangedResults: 0, remappedResults: 0, deactivatedOrphanedModels: 0,
            manualCorrections: 0, suppressedResults: 0, normalizedConfigurations: 0 };
        for (const name of plan.benchmarkNames) {
            if (!benchmarkIDs.has(name)) {
                const [result] = await connection.execute(
                    'INSERT INTO benchmarks (name,introduction_url,notes,request_official_sync,official_sync_url) VALUES (?,?,?,1,?)',
                    [name, 'https://arena.ai/leaderboard', 'Arena official leaderboard dataset (CC BY 4.0)', SOURCE_URL]);
                benchmarkIDs.set(name, result.insertId);
                stats.createdBenchmarks += 1;
            }
        }

        const requiredConditions = new Map();
        for (const entry of plan.entries) {
            const benchmarkID = benchmarkIDs.get(entry.benchmarkName);
            const conditionKey = arenaCondition(entry.config);
            const key = `${benchmarkID}:${conditionKey}`;
            requiredConditions.set(key, { benchmarkID, conditionKey,
                agent: entry.config === 'agent' || entry.config.startsWith('agent_') });
        }
        for (const [key, spec] of requiredConditions) {
            let condition = conditionIDs.get(key);
            if (!condition) {
                const [result] = await connection.execute(`INSERT INTO benchmark_conditions
                    (benchmark_ID,condition_key,name,score_direction,uses_percentage_scale,score_min,score_max,is_default,is_primary,score_source)
                    VALUES (?,?,?,?,?,?,?,?,?,'arena_official')`, [spec.benchmarkID, spec.conditionKey,
                    spec.conditionKey === 'default' ? 'default' : 'Unadjusted', 'higher', 0,
                    spec.agent ? -100 : -500, spec.agent ? 100 : 1500,
                    spec.conditionKey === 'default' ? 1 : 0, await primaryFlagForNewCondition(connection, spec.benchmarkID)]);
                condition = { ID: result.insertId, benchmark_ID: spec.benchmarkID,
                    name: spec.conditionKey === 'default' ? 'default' : 'Unadjusted',
                    score_direction: 'higher', target_value: null, uses_percentage_scale: 0,
                    score_min: spec.agent ? -100 : -500, score_max: spec.agent ? 100 : 1500,
                    is_default: spec.conditionKey === 'default' ? 1 : 0, deleted_at: null, score_source: 'arena_official' };
                conditionIDs.set(key, condition);
                stats.createdConditions += 1;
            } else if (condition.deleted_at !== null || condition.score_direction !== 'higher') {
                throw new Error(`Existing Arena condition cannot be reused: ${key}`);
            }
            if (condition.score_source === null) {
                await connection.execute("UPDATE benchmark_conditions SET score_source='arena_official' WHERE ID=? AND score_source IS NULL", [condition.ID]);
                condition.score_source = 'arena_official';
            }
            if (condition.score_source !== 'arena_official') throw new Error(`Arena condition has a conflicting source: ${key}`);
            if (Boolean(condition.uses_percentage_scale) || condition.target_value !== null
                || condition.score_min === null || condition.score_max === null
                || !Number.isFinite(Number(condition.score_min)) || !Number.isFinite(Number(condition.score_max))
                || Number(condition.score_max) <= Number(condition.score_min)) {
                throw new Error(`Arena condition has an incompatible normalization contract: ${key}`);
            }
            if (spec.agent && (Number(condition.score_min) !== -100 || Number(condition.score_max) !== 100)) {
                const [[existing]] = await connection.execute(
                    'SELECT COUNT(*) AS count FROM benchmark_results WHERE benchmark_condition_ID=?', [condition.ID]);
                if (Number(existing.count) !== 0) throw new Error(`Agent condition ${key} has legacy scores`);
                await connection.execute('UPDATE benchmark_conditions SET score_min=-100,score_max=100 WHERE ID=?',
                    [condition.ID]);
                condition.score_min = -100;
                condition.score_max = 100;
            }
        }

        const sourceModels = new Map();
        const sourceNames = new Map();
        for (const entry of plan.entries) {
            const key = arenaModelKey(entry.row.organization, entry.row.model_name);
            if (!sourceNames.has(key)) sourceNames.set(key, new Set());
            sourceNames.get(key).add(entry.row.model_name.toLowerCase());
            const previous = sourceModels.get(key);
            if (!previous || (/[A-Z ]/.test(entry.row.model_name) && !/[A-Z ]/.test(previous.model_name))) {
                sourceModels.set(key, entry.row);
            }
        }
        const resolvedModels = new Map();
        const resolvedFields = new Map();
        const ambiguousModels = [];
        for (const [key, source] of sourceModels) {
            const vendorSlug = arenaResultVendorSlug(source.organization, source.model_name);
            let vendorID = organizationIDs.get(vendorSlug);
            if (!vendorID) {
                const [result] = await connection.execute(`INSERT INTO organizations
                    (slug,name,is_model_vendor,introduction_url) VALUES (?,?,1,?)`,
                [vendorSlug, vendorSlug === 'qwen' ? 'Alibaba Qwen' : arenaVendorName(source.organization),
                    SOURCE_URL]);
                vendorID = result.insertId;
                organizationIDs.set(vendorSlug, vendorID);
                stats.createdOrganizations += 1;
            }
            const run = modelRunConfiguration(source.model_name, vendorSlug);
            resolvedFields.set(key, runConfigurationFields(run.configuration, scoreFieldDefinitions));
            const canonicalName = arenaCanonicalModelName(run.baseName);
            const existing = modelIDs.get(`${vendorID}:${canonicalName}`) || [];
            if (existing.length > 1) {
                const exact = existing.filter(row => Object.keys(run.configuration).length
                    ? row.name.toLowerCase() === run.baseName.toLowerCase()
                    : sourceNames.get(key).has(row.name.toLowerCase()));
                if (exact.length !== 1) {
                    ambiguousModels.push({ key, candidates: existing.map(row => ({ ID: row.ID,
                        name: row.name, results: modelScoreCount.get(row.ID) || 0 })) });
                    continue;
                }
                existing.splice(0, existing.length, exact[0]);
            }
            if (existing.length > 0) {
                resolvedModels.set(key, existing[0].ID);
                continue;
            }
            const modelIdentity = `${vendorSlug}:${canonicalName}`;
            const slug = `arena-${modelIdentity.replace(/[^a-z0-9]+/g, '-').slice(0, 75)}-${modelIdentity.length.toString(36)}`;
            let result;
            try {
                [result] = await connection.execute(`INSERT INTO models
                    (vendor_ID,slug,name,introduction_url,notes) VALUES (?,?,?,?,?)`,
                [vendorID, slug, run.baseName, SOURCE_URL,
                    `Arena dataset model identity: ${source.organization}/${source.model_name}`]);
            } catch (error) {
                throw new Error(`Cannot create Arena model ${key} (vendor ${vendorID}, existing canonical matches ${existing.length})`,
                    { cause: error });
            }
            resolvedModels.set(key, result.insertId);
            modelIDs.set(`${vendorID}:${canonicalName}`, [{ ID: result.insertId, vendor_ID: vendorID, name: run.baseName, slug }]);
            stats.createdModels += 1;
        }
        if (ambiguousModels.length) {
            throw new Error(`Ambiguous existing model mappings: ${JSON.stringify(ambiguousModels)}`);
        }

        const activeKeys = new Set();
        const inserts = [];
        const changedOldIDs = [];
        const remaps = [];
        const updatedBenchmarkIDs = new Set();
        for (const entry of plan.entries) {
            activeKeys.add(entry.key);
            const sourceHash = arenaRowHash(entry.row);
            const previous = trackedByKey.get(entry.key);
            const action = arenaTrackedAction(entry, previous, resolutionsByKey.get(entry.key));
            if (action === 'suppressed' || action === 'corrected') {
                if (action === 'suppressed') stats.suppressedResults += 1;
                else stats.manualCorrections += 1;
                continue;
            }
            if (action === 'unchanged') {
                const key = arenaModelKey(entry.row.organization, entry.row.model_name);
                const modelID = resolvedModels.get(key);
                const storedFields = typeof previous.score_fields === 'string' ? JSON.parse(previous.score_fields) : previous.score_fields;
                const existingFields = mergeRunConfigurationFields(storedFields, [], scoreFieldDefinitions);
                const fields = mergeRunConfigurationFields(existingFields, resolvedFields.get(key), scoreFieldDefinitions);
                if (Number(previous.model_ID) !== modelID || JSON.stringify(existingFields) !== JSON.stringify(fields)) {
                    remaps.push([modelID, previous.result_ID, JSON.stringify(fields)]);
                }
                stats.unchangedResults += 1;
                continue;
            }
            if (previous) changedOldIDs.push(previous.result_ID);
            const benchmarkID = benchmarkIDs.get(entry.benchmarkName);
            updatedBenchmarkIDs.add(Number(benchmarkID));
            const condition = conditionIDs.get(`${benchmarkID}:${arenaCondition(entry.config)}`);
            const conditionSnapshot = JSON.stringify({ conditionID: condition.ID,
                benchmarkID, name: condition.name, usesPercentageScale: false,
                scoreMin: Number(condition.score_min), scoreMax: Number(condition.score_max),
                scoreDirection: 'higher', targetValue: null });
            const row = entry.row;
            const sourceNotes = JSON.stringify({ arenaConfig: entry.config,
                arenaCategory: row.category, arenaModelName: row.model_name,
                arenaOrganization: row.organization, datasetRevision: snapshot.revision,
                leaderboardPublishDate: row.leaderboard_publish_date, rank: row.rank,
                voteCount: row.vote_count ?? null, observationCount: row.observation_count ?? null,
                scoreCiLower: row.score_ci_lower ?? row.rating_lower ?? null,
                scoreCiUpper: row.score_ci_upper ?? row.rating_upper ?? null });
            inserts.push({ entry, sourceHash, previous,
                values: [resolvedModels.get(arenaModelKey(row.organization, row.model_name)),
                    benchmarkID, condition.ID, entry.score, SOURCE_URL, 'third_party_lab',
                    `Arena.ai leaderboard dataset (${row.leaderboard_publish_date})`, sourceNotes,
                    conditionSnapshot, JSON.stringify(resolvedFields.get(arenaModelKey(row.organization, row.model_name)))] });
        }
        for (let offset = 0; offset < inserts.length; offset += 200) {
            const batch = inserts.slice(offset, offset + 200);
            const [result] = await connection.query(`INSERT INTO benchmark_results
                (model_ID,benchmark_ID,benchmark_condition_ID,raw_score,source_url,
                 source_type,source_title,notes,benchmark_condition_snapshot,score_fields)
                 VALUES ?`, [batch.map(item => item.values)]);
            if (result.affectedRows !== batch.length) throw new Error('Arena result insert count mismatch');
            const tracking = batch.map((item, index) => [item.entry.key, result.insertId + index,
                item.sourceHash, snapshot.revision, item.entry.config, item.entry.row.category,
                arenaModelKey(item.entry.row.organization, item.entry.row.model_name),
                item.entry.row.leaderboard_publish_date]);
            await connection.query(`INSERT INTO arena_import_rows
                (row_key,result_ID,source_hash,source_revision,config,category,model_key,source_date)
                 VALUES ? ON DUPLICATE KEY UPDATE result_ID=VALUES(result_ID),
                 source_hash=VALUES(source_hash),source_revision=VALUES(source_revision),
                 source_date=VALUES(source_date),manual_override='none',ingested_at=CURRENT_TIMESTAMP`, [tracking]);
            stats.insertedResults += batch.length;
            stats.replacedResults += batch.filter(item => item.previous).length;
        }
        for (let offset = 0; offset < changedOldIDs.length; offset += 500) {
            await connection.query('UPDATE benchmark_results SET status=? WHERE ID IN (?)',
                ['superseded', changedOldIDs.slice(offset, offset + 500)]);
        }
        const currentKeys = [...activeKeys];
        for (let offset = 0; offset < currentKeys.length; offset += 500) {
            await connection.query(`UPDATE arena_import_rows SET source_revision=?,ingested_at=CURRENT_TIMESTAMP
                WHERE row_key IN (?)`, [snapshot.revision, currentKeys.slice(offset, offset + 500)]);
        }
        for (const [modelID, resultID, fields] of remaps) {
            const [result] = await connection.execute(`UPDATE benchmark_results SET model_ID=?,score_fields=?
                WHERE ID=?`, [modelID, fields, resultID]);
            stats.remappedResults += result.affectedRows;
            stats.normalizedConfigurations += result.affectedRows;
        }
        const [orphaned] = await connection.query(`SELECT m.ID FROM models m
            WHERE m.notes LIKE 'Arena dataset model identity:%'
            AND m.is_active=1
            AND NOT EXISTS (SELECT 1 FROM benchmark_results r WHERE r.model_ID=m.ID)`);
        for (const row of orphaned) {
            const [result] = await connection.execute('UPDATE models SET is_active=0 WHERE ID=?', [row.ID]);
            stats.deactivatedOrphanedModels += result.affectedRows;
        }
        const stale = tracked.filter(row => !activeKeys.has(row.row_key));
        for (const row of stale) updatedBenchmarkIDs.add(Number(row.benchmark_ID));
        for (let offset = 0; offset < stale.length; offset += 500) {
            const batch = stale.slice(offset, offset + 500);
            await connection.query('UPDATE benchmark_results SET status=? WHERE ID IN (?)',
                ['superseded', batch.map(row => row.result_ID)]);
            await connection.query('DELETE FROM arena_import_rows WHERE row_key IN (?)',
                [batch.map(row => row.row_key)]);
            stats.retiredResults += batch.length;
        }
        if (conflictResolutions.length) await connection.query('DELETE FROM arena_sync_conflicts WHERE row_key IN (?)',
            [conflictResolutions.map(row => row.row_key)]);
        const [[check]] = await connection.query(`SELECT COUNT(*) AS total,
            SUM(r.status='accepted') AS accepted,
            SUM(JSON_TYPE(r.score_fields)='ARRAY') AS valid_score_fields
            FROM arena_import_rows a JOIN benchmark_results r ON r.ID=a.result_ID
            ${scoped ? 'WHERE a.config IN (?)' : ''}`, scoped ? [snapshot.expectedConfigs] : []);
        if (Number(check.total) !== plan.entries.length || Number(check.accepted) !== plan.entries.length - stats.suppressedResults
            || Number(check.valid_score_fields) !== plan.entries.length) {
            throw new Error(`Arena import verification failed: ${JSON.stringify(check)}`);
        }
        const [[external]] = await connection.query(`SELECT COUNT(*) AS count FROM benchmark_results r
            JOIN benchmark_conditions c ON c.ID=r.benchmark_condition_ID
            WHERE c.score_source='arena_official' AND r.status='accepted'
            ${scoped ? 'AND c.ID IN (?)' : ''}
            AND NOT EXISTS (SELECT 1 FROM arena_import_rows a WHERE a.result_ID=r.ID)`,
        scoped ? [[...requiredConditions.keys()].map(key => conditionIDs.get(key).ID)] : []);
        if (Number(external.count)) throw new Error('Arena managed conditions contain untracked current scores; explicit review is required');
        await markBenchmarkScoresUpdated(connection, [...updatedBenchmarkIDs]);
        return { ...stats, trackedResults: Number(check.total) };
    }, { scoped, recoveryConnectionFactory: () => mysql.createConnection(connectionOptions) });
} catch (error) {
    importError = error;
    throw error;
} finally {
    await cleanupArenaImportConnection(connection, { lockName: locked ? LOCK_NAME : null, originalError: importError });
}
console.log(JSON.stringify({ applied: true, ...overview, ...stats }, null, 2));
