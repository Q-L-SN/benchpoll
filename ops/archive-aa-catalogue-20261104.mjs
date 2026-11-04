import { createRequire } from 'node:module';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chooseInitialPrimaryCondition } from '../benchmark-primary-condition.js';

export const batchID = 'aa-catalogue-archive-20261104';
const sha = value => createHash('sha256').update(value).digest('hex');
export const confirmedAA = reason => Boolean(reason) && reason !== 'possibly_aa_derived_result';

export function buildTargets(benchmarks, versions) {
    const targetVersions = versions.filter(row => row.deleted_at === null && (row.policyAA || row.exclusivelyAAProvenance));
    const targetIDs = new Set(targetVersions.map(row => Number(row.ID)));
    const aaBenchmarkIDs = new Set(versions.filter(row => row.aaBenchmark).map(row => Number(row.benchmark_ID)));
    for (const row of benchmarks) if (row.aaBenchmark) aaBenchmarkIDs.add(Number(row.ID));
    const targetBenchmarks = benchmarks.filter(row => Number(row.is_active) === 1 && aaBenchmarkIDs.has(Number(row.ID)));
    const affectedIDs = new Set(targetVersions.map(row => Number(row.benchmark_ID)));
    const retained = benchmark => versions.filter(condition => Number(condition.benchmark_ID) === Number(benchmark.ID)
        && condition.deleted_at === null && !targetIDs.has(Number(condition.ID)));
    const nonAAParents = benchmarks.filter(row => Number(row.is_active) === 1 && !aaBenchmarkIDs.has(Number(row.ID))
        && affectedIDs.has(Number(row.ID)));
    const needDefault = nonAAParents.filter(row => retained(row).length === 0);
    const primaryChanges = [];
    for (const benchmark of nonAAParents) {
        const remaining = retained(benchmark);
        if (!remaining.length || remaining.some(row => Number(row.is_primary) === 1)) continue;
        const selected = chooseInitialPrimaryCondition(remaining.map(row => ({ ...row, ID: Number(row.ID),
            scoredModelCount: row.scoredModels, scoreCount: row.acceptedScores - row.aaAcceptedScores })));
        primaryChanges.push(Number(selected.ID));
    }
    return { targetBenchmarks, targetVersions, needDefault, primaryChanges };
}

export async function loadInventory(db, appRoot) {
    const { isAABenchmark, isAACondition } = await import(pathToFileURL(resolve(appRoot, 'public/js/shared/aa-ranking-policy.js')));
    const { aaResultReason } = await import(pathToFileURL(resolve(appRoot, 'aa-archive-policy.js')));
    const [benchmarks] = await db.query('SELECT * FROM benchmarks ORDER BY ID');
    const [conditions] = await db.query('SELECT * FROM benchmark_conditions ORDER BY ID');
    const [counts] = await db.query(`SELECT benchmark_condition_ID AS ID, COUNT(*) AS total,
        SUM(status = 'accepted') AS accepted, COUNT(DISTINCT IF(status = 'accepted', model_ID, NULL)) AS models
        FROM benchmark_results GROUP BY benchmark_condition_ID`);
    const [fields] = await db.query('SELECT ID, name, field_type AS type FROM score_fields ORDER BY ID');
    const [options] = await db.query('SELECT ID, field_ID, label FROM score_field_options ORDER BY ID');
    for (const field of fields) field.options = options.filter(option => Number(option.field_ID) === Number(field.ID));
    const aaAssignments = fields.filter(field => ['published evaluation provider', 'evaluation provider', 'evaluator', 'original evaluator', 'operator']
        .includes(field.name.trim().toLowerCase())).flatMap(field => field.options
        .filter(option => /^(?:aa|artificial[ _-]+analysis)$/i.test(option.label.trim()))
        .map(option => JSON.stringify({ fieldID: Number(field.ID), value: Number(option.ID) })));
    const aaBenchmarkIDs = new Set(benchmarks.filter(row => isAABenchmark(row.name)).map(row => Number(row.ID)));
    for (const row of benchmarks) row.aaBenchmark = aaBenchmarkIDs.has(Number(row.ID));
    const candidates = [...aaBenchmarkIDs];
    const aaResults = [];
    let after = 0;
    for (;;) {
        const [rows] = await db.query(`SELECT ID, benchmark_ID, benchmark_condition_ID, status, source_url, source_title, notes, score_fields
            FROM benchmark_results WHERE ID > ? AND (
                ${candidates.length ? `benchmark_ID IN (${candidates.map(() => '?').join(',')}) OR` : ''}
                LOWER(COALESCE(source_url,'')) LIKE '%artificialanalysis%'
                OR LOWER(COALESCE(source_title,'')) LIKE '%artificial analysis%'
                OR LOWER(COALESCE(notes,'')) LIKE '%artificial%analysis%'
                OR REGEXP_LIKE(COALESCE(notes,''), '"(original[_-]?evaluator|operator|evaluator)"[[:space:]]*:[[:space:]]*"aa"', 'i')
                OR LOWER(CAST(score_fields AS CHAR)) LIKE '%artificial%analysis%'
                OR LOWER(CAST(score_fields AS CHAR)) LIKE '%"aa"%'
                ${aaAssignments.map(() => 'OR JSON_CONTAINS(score_fields, ?)').join(' ')}
                OR ID = 173021)
            ORDER BY ID LIMIT 2000`, [after, ...candidates, ...aaAssignments]);
        if (!rows.length) break;
        for (const row of rows) {
            const reason = aaResultReason(row, aaBenchmarkIDs, fields);
            if (reason) aaResults.push({ ID: Number(row.ID), benchmarkID: Number(row.benchmark_ID),
                conditionID: Number(row.benchmark_condition_ID), status: row.status, reason });
        }
        after = Number(rows.at(-1).ID);
    }
    const byBenchmark = new Map(benchmarks.map(row => [Number(row.ID), row]));
    const countMap = new Map(counts.map(row => [Number(row.ID), row]));
    const aaCounts = new Map();
    for (const result of aaResults) {
        const count = aaCounts.get(result.conditionID) ?? { total: 0, confirmed: 0, accepted: 0, reasons: new Set() };
        count.total++;
        if (confirmedAA(result.reason)) count.confirmed++;
        if (result.status === 'accepted') count.accepted++;
        count.reasons.add(result.reason);
        aaCounts.set(result.conditionID, count);
    }
    const versions = conditions.map(row => {
        const benchmark = byBenchmark.get(Number(row.benchmark_ID));
        const count = countMap.get(Number(row.ID)), aa = aaCounts.get(Number(row.ID));
        const identity = { benchmarkName: benchmark.name, benchmarkID: Number(row.benchmark_ID),
            conditionKey: row.condition_key, conditionName: row.name, scoreSource: row.score_source };
        return { ...row, ...identity, benchmarkActive: Number(benchmark.is_active),
            aaBenchmark: aaBenchmarkIDs.has(Number(row.benchmark_ID)), policyAA: isAACondition(identity),
            totalScores: Number(count?.total ?? 0), acceptedScores: Number(count?.accepted ?? 0),
            scoredModels: Number(count?.models ?? 0),
            aaScores: aa?.total ?? 0, aaAcceptedScores: aa?.accepted ?? 0,
            exclusivelyAAProvenance: Number(count?.total ?? 0) > 0 && Number(count.total) === aa?.confirmed,
            provenanceReasons: [...aa?.reasons ?? []] };
    });
    const targets = buildTargets(benchmarks, versions);
    const { targetVersions } = targets;
    const targetIDs = new Set(targetVersions.map(row => Number(row.ID)));
    const [references] = await db.query(`SELECT 'weight' AS kind, COUNT(*) AS total FROM personal_pie_weights
        WHERE benchmark_condition_ID IN (${targetVersions.length ? targetVersions.map(() => '?').join(',') : 'NULL'})
        UNION ALL SELECT 'family_member', COUNT(*) FROM benchmark_family_members
        WHERE benchmark_condition_ID IN (${targetVersions.length ? targetVersions.map(() => '?').join(',') : 'NULL'})
        UNION ALL SELECT 'family_primary', COUNT(*) FROM benchmark_families
        WHERE primary_benchmark_condition_ID IN (${targetVersions.length ? targetVersions.map(() => '?').join(',') : 'NULL'})`,
    [...targetIDs, ...targetIDs, ...targetIDs]);
    const [schema] = await db.query("SHOW CREATE TABLE aa_data_archive_items");
    const [affectedWeights] = targetIDs.size ? await db.query('SELECT * FROM personal_pie_weights WHERE benchmark_condition_ID IN (?) ORDER BY pie_ID, benchmark_condition_ID', [[...targetIDs]]) : [[]];
    const pieIDs = [...new Set(affectedWeights.map(row => Number(row.pie_ID)))];
    const dependencies = {};
    for (const table of ['personal_pies', 'personal_pie_weights', 'personal_pie_topic_weights', 'personal_pie_score_rules']) {
        [dependencies[table]] = pieIDs.length ? await db.query(`SELECT * FROM ${table} WHERE ${table === 'personal_pies' ? 'ID' : 'pie_ID'} IN (?) ORDER BY ${table === 'personal_pies' ? 'ID' : 'pie_ID'}`, [pieIDs]) : [[]];
    }
    const confirmedResultIDs = aaResults.filter(row => row.status === 'accepted' && confirmedAA(row.reason)).map(row => row.ID);
    const [results] = await db.query(`SELECT * FROM benchmark_results WHERE status = 'accepted' AND (
        benchmark_condition_ID IN (?) OR ID IN (?)) ORDER BY ID`, [[...targetIDs].length ? [...targetIDs] : [0], confirmedResultIDs.length ? confirmedResultIDs : [0]]);
    return { batchID, benchmarks, conditions, versions, aaResults, results, dependencies, ...targets, references,
        archiveSchema: schema[0]['Create Table'] };
}

export function reportInventory(inventory) {
    const version = row => ({ ID: Number(row.ID), benchmarkID: Number(row.benchmark_ID), benchmark: row.benchmarkName,
        name: row.name, key: row.condition_key, isDefault: Boolean(row.is_default), isPrimary: Boolean(row.is_primary),
        benchmarkActive: row.benchmarkActive, reason: row.policyAA ? 'aa_version_identity' : row.exclusivelyAAProvenance ? 'exclusively_aa_provenance' : 'mixed_provenance',
        scoreSource: row.score_source, scores: row.acceptedScores, aaScores: row.aaAcceptedScores });
    return { batchID, benchmarks: inventory.targetBenchmarks.map(row => ({ ID: Number(row.ID), name: row.name })),
        versions: inventory.targetVersions.map(version),
        newDefaults: inventory.needDefault.map(row => ({ ID: Number(row.ID), name: row.name })),
        mixedVersions: inventory.versions.filter(row => row.deleted_at === null && !row.policyAA && !row.exclusivelyAAProvenance && row.aaAcceptedScores > 0).map(version),
        acceptedAAResults: inventory.aaResults.filter(row => row.status === 'accepted').length,
        archivedResultCount: inventory.results.length,
        primaryChanges: inventory.primaryChanges.map(ID => version(inventory.versions.find(row => Number(row.ID) === ID))),
        references: inventory.references };
}

export function inventoryDigest(inventory) {
    return sha(JSON.stringify({ benchmarks: inventory.targetBenchmarks, versions: inventory.targetVersions,
        results: inventory.results, defaults: inventory.needDefault, primaryChanges: inventory.primaryChanges,
        dependencies: inventory.dependencies, references: inventory.references }));
}

export function assertApplicable(inventory) {
    const targets = new Set(inventory.targetVersions.map(row => Number(row.ID)));
    if (inventory.references.some(row => row.kind !== 'weight' && Number(row.total) !== 0)) {
        throw new Error('An AA version has a fallback reference; review its family before applying');
    }
    const state = inventory.dependencies;
    if (state.personal_pie_weights.some(row => !targets.has(Number(row.benchmark_condition_ID)))
        || state.personal_pie_topic_weights.length) {
        throw new Error('Mixed personal weights require an explicit rebalancing plan');
    }
    for (const benchmark of inventory.needDefault) {
        const originals = inventory.targetVersions.filter(row => Number(row.benchmark_ID) === Number(benchmark.ID));
        if (originals.filter(row => Number(row.is_primary) === 1).length !== 1) {
            throw new Error('A replacement default needs exactly one original primary version');
        }
    }
}

async function selectIDs(db, table, ids) {
    if (!ids.length) return [];
    const [rows] = await db.query(`SELECT * FROM ${table} WHERE ID IN (?) ORDER BY ID`, [ids]);
    return rows;
}

const storedJSON = value => typeof value === 'object' && value !== null ? JSON.stringify(value) : value;
const without = (row, names) => Object.fromEntries(Object.entries(row).filter(([key]) => !names.includes(key)));
const flatRow = row => JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)));

async function integrity(db, inventory) {
    const [scores] = await db.query('SELECT ID, model_ID, benchmark_ID, benchmark_condition_ID, raw_score FROM benchmark_results ORDER BY ID');
    const [statuses] = await db.query('SELECT ID, status FROM benchmark_results WHERE ID NOT IN (?) ORDER BY ID',
        [inventory.results.length ? inventory.results.map(row => Number(row.ID)) : [0]]);
    const protectedTables = ['personal_pies', 'personal_pie_weights', 'personal_pie_topic_weights', 'personal_pie_score_rules',
        'benchmark_families', 'benchmark_family_members', 'discussion_posts', 'discussion_mentions', 'discussion_votes',
        'topic_proposals', 'topic_proposal_votes', 'topic_proposal_snapshots', 'moderation_email_outbox', 'arena_import_rows'];
    const pieIDs = new Set(inventory.dependencies.personal_pies.map(row => Number(row.ID)));
    const state = { scoreRows: scores.length, scoreValues: sha(JSON.stringify(scores)),
        unrelatedStatuses: sha(JSON.stringify(statuses)) };
    for (const table of protectedTables) {
        const [rows] = await db.query(`SELECT * FROM ${table}`);
        const retained = rows.filter(row => !table.startsWith('personal_pie') || !pieIDs.has(Number(table === 'personal_pies' ? row.ID : row.pie_ID)));
        state[table] = sha(JSON.stringify(retained.map(row => JSON.stringify(row)).sort()));
    }
    return state;
}

async function archiveStateDigest(db) {
    const [items] = await db.execute('SELECT entity_type, object_id, related_id FROM aa_data_archive_items WHERE batch_id = ? ORDER BY entity_type, object_id, related_id', [batchID]);
    const ids = types => [...new Set(items.filter(row => types.includes(row.entity_type)).map(row => Number(row.object_id)))];
    const state = {};
    for (const [table, types] of [['benchmarks', ['benchmark']], ['benchmark_conditions', ['condition', 'condition_primary', 'created_condition']], ['benchmark_results', ['result']], ['personal_pies', ['pie']]]) {
        state[table] = await selectIDs(db, table, ids(types));
    }
    const pieIDs = ids(['pie']);
    for (const table of ['personal_pie_weights', 'personal_pie_topic_weights', 'personal_pie_score_rules']) {
        const [rows] = pieIDs.length ? await db.query(`SELECT * FROM ${table} WHERE pie_ID IN (?)`, [pieIDs]) : [[]];
        state[table] = rows.map(row => JSON.stringify(row)).sort();
    }
    return sha(JSON.stringify(state));
}

export async function applyArchive(db, { appRoot, expectedDigest, backupPath, beforeCommit }) {
    await db.beginTransaction();
    try {
        const [runs] = await db.execute('SELECT batch_id FROM aa_data_archive_runs WHERE batch_id = ? FOR UPDATE', [batchID]);
        if (runs.length) throw new Error('This archive batch already ran; refusing a second application');
        const inventory = await loadInventory(db, appRoot);
        if (inventoryDigest(inventory) !== expectedDigest) throw new Error('Archive candidates changed since the reviewed audit');
        assertApplicable(inventory);
        const [[arena]] = await db.query(`SELECT COUNT(*) AS total FROM arena_import_rows a
            JOIN benchmark_results r ON r.ID = a.result_ID WHERE r.benchmark_condition_ID IN (?) OR r.ID IN (?)`,
        [inventory.targetVersions.length ? inventory.targetVersions.map(row => Number(row.ID)) : [0],
            inventory.results.length ? inventory.results.map(row => Number(row.ID)) : [0]]);
        if (Number(arena.total) !== 0) throw new Error('AA archival overlaps tracked Arena imports');
        const before = await integrity(db, inventory);
        const benchmarkIDs = inventory.targetBenchmarks.map(row => Number(row.ID));
        const conditionIDs = inventory.targetVersions.map(row => Number(row.ID));
        const resultIDs = inventory.results.map(row => Number(row.ID));
        const benchmarks = await selectIDs(db, 'benchmarks', benchmarkIDs);
        const conditions = await selectIDs(db, 'benchmark_conditions', conditionIDs);
        const primaryRows = await selectIDs(db, 'benchmark_conditions', inventory.primaryChanges);
        const items = [];
        const add = (type, row, reason, objectID = row.ID, relatedID = 0) => items.push([batchID, type, objectID, relatedID, 0, JSON.stringify(row), reason]);
        for (const row of benchmarks) add('benchmark', row, 'aa_benchmark');
        for (const row of conditions) add('condition', row, 'aa_version');
        for (const row of inventory.results) add('result', row, 'aa_version_or_confirmed_source');
        for (const row of primaryRows) add('condition_primary', row, 'replace_archived_primary');
        for (const row of inventory.dependencies.personal_pies) add('pie', row, 'remove_archived_sector');
        for (const row of inventory.dependencies.personal_pie_weights) add('pie_weight', row, 'remove_archived_sector', row.pie_ID, row.benchmark_condition_ID);
        for (const row of inventory.dependencies.personal_pie_score_rules) add('pie_rule', row, 'remove_archived_sector', row.pie_ID, row.primary_benchmark_condition_ID);
        await db.execute(`INSERT INTO aa_data_archive_runs (batch_id, backup_path, benchmark_count, condition_count, result_count)
            VALUES (?, ?, ?, ?, ?)`, [batchID, backupPath, benchmarkIDs.length, conditionIDs.length, resultIDs.length]);
        for (let offset = 0; offset < items.length; offset += 100) await db.query(`INSERT INTO aa_data_archive_items
            (batch_id, entity_type, object_id, related_id, extra_id, original_state, reason) VALUES ?`, [items.slice(offset, offset + 100)]);
        const change = async (sql, ids) => {
            if (!ids.length) return;
            const [result] = await db.query(sql, [ids]);
            if (result.affectedRows !== ids.length) throw new Error('Unexpected archive affected-row count');
        };
        await change('UPDATE benchmarks SET is_active = 0, updated_at = NOW() WHERE is_active = 1 AND ID IN (?)', benchmarkIDs);
        // Keep original keys as tombstones, so importers cannot silently reuse an archived version identity.
        await change('UPDATE benchmark_conditions SET deleted_at = NOW(), is_default = 0, is_primary = 0, updated_at = NOW() WHERE deleted_at IS NULL AND ID IN (?)', conditionIDs);
        await change("UPDATE benchmark_results SET status = 'archived', updated_at = NOW() WHERE status = 'accepted' AND ID IN (?)", resultIDs);
        await change('UPDATE benchmark_conditions SET is_primary = 1, updated_at = NOW() WHERE deleted_at IS NULL AND is_primary = 0 AND ID IN (?)', inventory.primaryChanges);
        for (const row of inventory.dependencies.personal_pie_weights) {
            const [removed] = await db.execute('DELETE FROM personal_pie_weights WHERE pie_ID = ? AND benchmark_condition_ID = ? AND weight_basis_points = ?',
                [row.pie_ID, row.benchmark_condition_ID, row.weight_basis_points]);
            if (removed.affectedRows !== 1) throw new Error('Personal weight changed');
        }
        for (const row of inventory.dependencies.personal_pies) {
            const [changed] = await db.execute('UPDATE personal_pies SET revision = revision + 1 WHERE ID = ? AND revision = ?', [row.ID, row.revision]);
            if (changed.affectedRows !== 1) throw new Error('Personal pie revision changed');
        }
        const createdDefaults = [];
        for (const benchmark of inventory.needDefault) {
            const source = inventory.targetVersions.find(row => Number(row.benchmark_ID) === Number(benchmark.ID) && Number(row.is_primary) === 1);
            const key = inventory.conditions.some(row => Number(row.benchmark_ID) === Number(benchmark.ID) && row.condition_key === 'default')
                ? 'default-independent-20261104' : 'default';
            const [created] = await db.execute(`INSERT INTO benchmark_conditions (benchmark_ID, condition_key, name,
                score_direction, target_value, uses_percentage_scale, score_min, score_max, is_default, is_primary,
                difference_explanation) VALUES (?, ?, 'default', ?, ?, ?, ?, ?, 1, 1, ?)`,
            [benchmark.ID, key, source.score_direction, source.target_value, source.uses_percentage_scale,
                source.score_min, source.score_max, 'Default version for independently sourced results.']);
            const [row] = await selectIDs(db, 'benchmark_conditions', [created.insertId]);
            await db.execute(`INSERT INTO aa_data_archive_items
                (batch_id, entity_type, object_id, original_state, reason) VALUES (?, 'created_condition', ?, ?, 'replace_all_aa_versions')`,
            [batchID, row.ID, JSON.stringify(row)]);
            createdDefaults.push({ benchmarkID: Number(benchmark.ID), benchmark: benchmark.name, ID: Number(row.ID), name: row.name, key });
        }
        await db.query('UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2');
        const changedResults = await selectIDs(db, 'benchmark_results', resultIDs);
        const normalizeResults = rows => rows.map(row => without(row, ['status', 'updated_at']));
        if (sha(JSON.stringify(normalizeResults(changedResults))) !== sha(JSON.stringify(normalizeResults(inventory.results)))
            || changedResults.some(row => row.status !== 'archived')) throw new Error('Archived score evidence changed');
        const changedConditions = await selectIDs(db, 'benchmark_conditions', conditionIDs);
        if (changedConditions.some(row => row.deleted_at === null || Number(row.is_primary) !== 0 || Number(row.is_default) !== 0)) throw new Error('Version archival incomplete');
        const after = await integrity(db, inventory);
        if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Unrelated data or score values changed');
        const remaining = await loadInventory(db, appRoot);
        if (remaining.targetBenchmarks.length || remaining.targetVersions.length || remaining.results.length) throw new Error('AA archive candidates remain');
        const affectedBenchmarkIDs = [...new Set(inventory.targetVersions.map(row => Number(row.benchmark_ID)))];
        for (const benchmarkID of affectedBenchmarkIDs) {
            const benchmark = remaining.benchmarks.find(row => Number(row.ID) === benchmarkID);
            if (Number(benchmark.is_active) !== 1) continue;
            const live = remaining.versions.filter(row => Number(row.benchmark_ID) === benchmarkID && row.deleted_at === null);
            if (!live.length || live.filter(row => Number(row.is_primary) === 1).length !== 1) throw new Error('Active benchmark lost its primary version');
        }
        for (const created of createdDefaults) {
            const version = remaining.versions.find(row => Number(row.ID) === created.ID);
            if (version.totalScores !== 0 || version.policyAA || !version.is_default || !version.is_primary) throw new Error('Replacement default is not empty and independent');
        }
        const receipt = { ...reportInventory(inventory), applied: true, verified: true, appliedAt: new Date().toISOString(),
            createdDefaults, integrity: before, removedWeights: inventory.dependencies.personal_pie_weights.length,
            remainingAABenchmarks: 0, remainingAAVersions: 0, archiveStateDigest: await archiveStateDigest(db) };
        if (beforeCommit) await beforeCommit(receipt);
        await db.commit();
        return receipt;
    } catch (error) { await db.rollback(); throw error; }
}

export async function restoreArchive(db, expectedDigest) {
    await db.beginTransaction();
    try {
        if (!expectedDigest || await archiveStateDigest(db) !== expectedDigest) throw new Error('Archived state changed; manual restoration required');
        const [items] = await db.execute('SELECT * FROM aa_data_archive_items WHERE batch_id = ? AND restored_at IS NULL ORDER BY entity_type, object_id, related_id FOR UPDATE', [batchID]);
        if (!items.length) throw new Error('No unrestored archive items');
        const rows = type => items.filter(row => row.entity_type === type).map(row => typeof row.original_state === 'string' ? JSON.parse(row.original_state) : row.original_state);
        for (const row of rows('created_condition')) {
            const [[counts]] = await db.execute('SELECT COUNT(*) AS total FROM benchmark_results WHERE benchmark_condition_ID = ?', [row.ID]);
            if (Number(counts.total) !== 0) throw new Error('Replacement default has acquired scores; manual restoration required');
            const [current] = await selectIDs(db, 'benchmark_conditions', [row.ID]);
            if (flatRow(current) !== flatRow(row)) throw new Error('Replacement default has changed');
            await db.execute('DELETE FROM benchmark_conditions WHERE ID = ?', [row.ID]);
        }
        for (const row of rows('condition_primary')) await db.execute('UPDATE benchmark_conditions SET is_primary = 0 WHERE ID = ?', [row.ID]);
        const update = async (table, row, excluded = []) => {
            const fields = Object.keys(row).filter(key => key !== 'ID' && !excluded.includes(key));
            await db.execute(`UPDATE ${table} SET ${fields.map(key => `\`${key}\` = ?`).join(',')} WHERE ID = ?`, [...fields.map(key => storedJSON(row[key])), row.ID]);
        };
        for (const row of rows('benchmark')) await update('benchmarks', row);
        for (const type of ['condition', 'condition_primary']) for (const row of rows(type)) await update('benchmark_conditions', row, ['default_marker', 'primary_marker']);
        for (const row of rows('result')) await update('benchmark_results', row);
        for (const type of ['pie_weight', 'pie_rule']) for (const row of rows(type)) {
            const fields = Object.keys(row);
            await db.execute(`INSERT INTO ${type === 'pie_weight' ? 'personal_pie_weights' : 'personal_pie_score_rules'} (${fields.map(key => `\`${key}\``).join(',')}) VALUES (${fields.map(() => '?').join(',')})`, fields.map(key => storedJSON(row[key])));
        }
        for (const row of rows('pie')) await update('personal_pies', row);
        await db.execute('UPDATE aa_data_archive_items SET restored_at = NOW() WHERE batch_id = ?', [batchID]);
        await db.query('UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2');
        await db.commit();
    } catch (error) { await db.rollback(); throw error; }
}

async function freshBackup(stage, startedAt) {
    execFileSync('systemctl', ['start', 'benchpoll-db-backup.service']);
    const names = (await readdir('/var/backups/benchpoll')).filter(name => /^benchmarks-\d{8}T\d+Z\.sql\.gz$/.test(name)).sort();
    const path = join('/var/backups/benchpoll', names.at(-1));
    const info = await stat(path);
    if (!info.isFile() || info.size < 1000 || info.mode & 0o077 || info.mtimeMs < startedAt) throw new Error('Fresh private backup required');
    execFileSync('gzip', ['-t', path]);
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(path)) hash.update(bytes);
    const sha256 = hash.digest('hex');
    if ((await readFile(path + '.sha256', 'utf8')).split(/\s+/)[0] !== sha256) throw new Error('Backup checksum mismatch');
    const backup = { path, bytes: info.size, createdAt: info.mtime.toISOString(), sha256 };
    await writeFile(join(stage, 'database-backup.json'), JSON.stringify(backup, null, 2), { flag: 'wx', mode: 0o600 });
    return backup;
}

async function main() {
    const appRoot = process.env.BENCHPOLL_APP_ROOT || '/home/ubuntu/benchpoll';
    const output = process.argv[3];
    const action = process.argv[2];
    if (!['audit', 'apply'].includes(action) || !output) throw new Error('Usage: archive-aa-catalogue-20261104.mjs audit OUTPUT | apply REVIEWED_INVENTORY');
    const require = createRequire(resolve(appRoot, 'package.json'));
    const db = await require('mysql2/promise').createConnection({ user: 'root', database: 'benchmarks',
        socketPath: '/var/run/mysqld/mysqld.sock', dateStrings: true, timezone: 'Z', charset: 'utf8mb4' });
    try {
        if (action === 'apply') {
            const stage = '/home/ubuntu/benchpoll-releases/aa-catalogue-20261104';
            if (process.getuid() !== 0 || appRoot !== '/home/ubuntu/benchpoll' || dirname(resolve(output)) !== stage) throw new Error('Unexpected production operator context');
            const reviewed = JSON.parse(await readFile(output, 'utf8'));
            assertApplicable(reviewed);
            const expectedDigest = inventoryDigest(reviewed);
            const run = (...args) => execFileSync('systemctl', args, { encoding: 'utf8' });
            const active = unit => { try { return run('is-active', unit).trim() === 'active'; } catch { return false; } };
            if (!active('benchpoll.service')) throw new Error('Application must be healthy before archival');
            const [[lock]] = await db.query('SELECT GET_LOCK(?, 10) AS acquired', [batchID]);
            if (Number(lock.acquired) !== 1) throw new Error('Could not acquire archive lock');
            let paused = false;
            const timer = active('benchpoll-score-sync.timer');
            try {
                if (timer) run('stop', 'benchpoll-score-sync.timer');
                if (active('benchpoll-score-sync.service')) throw new Error('Score sync is running; retry later');
                paused = true; run('stop', 'benchpoll.service');
                const backup = await freshBackup(stage, Date.now());
                const receipt = await applyArchive(db, { appRoot, expectedDigest, backupPath: backup.path });
                await writeFile(join(stage, 'receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o644 });
                console.log(JSON.stringify({ applied: true, benchmarks: receipt.benchmarks.length, versions: receipt.versions.length,
                    results: receipt.archivedResultCount, createdDefaults: receipt.createdDefaults, removedWeights: receipt.removedWeights, backupSHA256: backup.sha256 }));
            } finally {
                try { if (paused) run('start', 'benchpoll.service'); }
                finally { if (timer) run('start', 'benchpoll-score-sync.timer'); await db.query('SELECT RELEASE_LOCK(?)', [batchID]); }
            }
            return;
        }
        await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
        const inventory = await loadInventory(db, appRoot);
        await db.commit();
        const report = reportInventory(inventory);
        await writeFile(output, JSON.stringify(inventory, null, 2), { flag: 'wx', mode: 0o600 });
        await writeFile(output + '.report.json', JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o644 });
        console.log(JSON.stringify({ output, sha256: sha(await readFile(output)), benchmarks: report.benchmarks.length,
            versions: report.versions.length, newDefaults: report.newDefaults, acceptedAAResults: report.acceptedAAResults,
            archivedResultCount: report.archivedResultCount, primaryChanges: report.primaryChanges, digest: inventoryDigest(inventory),
            mixedVersions: report.mixedVersions, references: report.references }));
    } finally { await db.end(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
