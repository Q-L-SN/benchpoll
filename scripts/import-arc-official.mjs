#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { ARC_SOURCES, decimalText, normalizeArcSource, sha256 } from './collect-arc-official.mjs';
import { canonicalNumber, compareCanonicalNumbers, fieldNameKey, normalizeScoreFields } from '../public/js/shared/score-fields.js';

export const SOURCE_TITLE = 'ARC Prize official leaderboard';
const LOCK = 'benchpoll-arc-official-import';
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const key = (provider, model) => JSON.stringify([provider, model]);
export function stableJSON(value) {
    return JSON.stringify(value, (name, item) => item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
}
export const objectHash = value => sha256(stableJSON(value));

const PROJECTIONS = {
    organizations: ['ID', 'slug', 'name', 'is_model_vendor', 'is_active', 'introduction_url'],
    models: ['ID', 'slug', 'name', 'vendor_ID', 'introduction_url', 'is_active', 'notes'],
    benchmarks: ['ID', 'name', 'introduction_url', 'is_active', 'scores_updated_at'],
    benchmark_conditions: ['ID', 'benchmark_ID', 'condition_key', 'name', 'score_direction',
        'target_value', 'uses_percentage_scale', 'score_min', 'score_max', 'is_default',
        'deleted_at', 'is_primary', 'score_source', 'difference_explanation'],
    score_fields: ['ID', 'name', 'name_key', 'field_type', 'allow_empty', 'exclude_missing',
        'exclude_empty', 'is_active', 'revision'],
    score_field_options: ['ID', 'field_ID', 'label', 'label_key', 'is_active', 'excluded', 'revision'],
    benchmark_results: ['ID', 'model_ID', 'benchmark_ID', 'benchmark_condition_ID', 'raw_score',
        'source_url', 'source_type', 'source_title', 'benchmark_condition_snapshot', 'status',
        'notes', 'score_fields', 'submitted_by', 'moderation_log_ID', 'accepted_at', 'created_at', 'updated_at']
};
export { PROJECTIONS as ARC_EXPORT_COLUMNS };
export const ARC_DATE_COLUMNS = {
    benchmarks: ['scores_updated_at'],
    benchmark_conditions: ['deleted_at'],
    benchmark_results: ['accepted_at', 'created_at', 'updated_at']
};
export const ARC_JSON_COLUMNS = { benchmark_results: ['benchmark_condition_snapshot', 'score_fields'] };
export function projectionSQL(table, column) {
    if (column === 'raw_score') return 'CAST(raw_score AS CHAR)';
    if (ARC_DATE_COLUMNS[table]?.includes(column)) return `DATE_FORMAT(\`${column}\`, '%Y-%m-%d %H:%i:%s.%f')`;
    return `\`${column}\``;
}
export function normalizeDatabaseTables(tables) {
    for (const [table, rows] of Object.entries(tables)) for (const row of rows) {
        for (const column of ARC_JSON_COLUMNS[table] ?? []) if (typeof row[column] === 'string') row[column] = JSON.parse(row[column]);
        for (const column of ARC_DATE_COLUMNS[table] ?? []) {
            if (row[column] == null) continue;
            if (typeof row[column] !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/.test(row[column])) {
                throw new Error(`Noncanonical database date ${table}.${column}.`);
            }
        }
    }
    return tables;
}
const where = table => table === 'benchmarks' ? " WHERE name IN ('ARC-AGI-1','ARC-AGI-2')"
    : table === 'benchmark_conditions' ? " WHERE benchmark_ID IN (SELECT ID FROM benchmarks WHERE name IN ('ARC-AGI-1','ARC-AGI-2'))"
        : table === 'benchmark_results' ? ` WHERE benchmark_ID IN (SELECT ID FROM benchmarks WHERE name IN ('ARC-AGI-1','ARC-AGI-2')) OR source_title = '${SOURCE_TITLE}' OR notes LIKE '%arc_official_key%'` : '';
export { where as arcStateWhere };

export function exportReadOnlySQL() {
    const statements = [
        'SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ;',
        'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY;'
    ];
    for (const [table, columns] of Object.entries(PROJECTIONS)) {
        const pairs = columns.map(column => `'${column}', ${projectionSQL(table, column)}`).join(', ');
        statements.push(`SELECT JSON_OBJECT('table','${table}','row',JSON_OBJECT(${pairs})) FROM \`${table}\`${where(table)} ORDER BY ID;`);
    }
    statements.push(`SELECT JSON_OBJECT('table','columns','row',JSON_OBJECT('table',TABLE_NAME,'column',COLUMN_NAME,'type',COLUMN_TYPE,'nullable',IS_NULLABLE,'scale',NUMERIC_SCALE,'precision',NUMERIC_PRECISION))
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${Object.keys(PROJECTIONS).map(table => `'${table}'`).join(',')}) ORDER BY TABLE_NAME,ORDINAL_POSITION;`);
    statements.push(`SELECT JSON_OBJECT('table','engines','row',JSON_OBJECT('table',TABLE_NAME,'engine',ENGINE)) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${Object.keys(PROJECTIONS).map(table => `'${table}'`).join(',')}) ORDER BY TABLE_NAME;`);
    statements.push('ROLLBACK;');
    return statements.join('\n');
}

export async function captureReadOnlySSH({ host, identityFile }) {
    if (!/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+$/.test(host) || !identityFile) throw new Error('Invalid read-only SSH target.');
    const output = await new Promise((resolveOutput, reject) => {
        const child = spawn('ssh', ['-i', identityFile, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', host,
            'sudo mysql --default-character-set=utf8mb4 --socket=/var/run/mysqld/mysqld.sock --database=benchmarks --batch --raw --skip-column-names'],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolveOutput(stdout)
            : reject(new Error(`Read-only SSH query failed (${code}); output suppressed (${stderr.length} diagnostic bytes).`)));
        child.stdin.end(exportReadOnlySQL());
    });
    const tables = Object.fromEntries([...Object.keys(PROJECTIONS), 'columns', 'engines'].map(table => [table, []]));
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
        const item = JSON.parse(line);
        if (!Object.hasOwn(tables, item.table)) throw new Error('Unexpected database export table.');
        tables[item.table].push(item.row);
    }
    return { schemaVersion: 1, capturedAt: new Date().toISOString(), access: 'SSH read-only consistent snapshot', tables: normalizeDatabaseTables(tables) };
}

export async function readDatabaseState(connection) {
    const tables = {};
    for (const [table, columns] of Object.entries(PROJECTIONS)) {
        const [rows] = await connection.query(`SELECT ${columns.map(column => `${projectionSQL(table, column)} AS \`${column}\``).join(',')} FROM \`${table}\`${where(table)} ORDER BY ID`);
        tables[table] = rows;
    }
    const [columns] = await connection.query(`SELECT TABLE_NAME AS \`table\`, COLUMN_NAME AS \`column\`,
        COLUMN_TYPE AS type, IS_NULLABLE AS nullable, NUMERIC_SCALE AS scale, NUMERIC_PRECISION AS \`precision\`
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME,ORDINAL_POSITION`, [Object.keys(PROJECTIONS)]);
    const [engines] = await connection.query(`SELECT TABLE_NAME AS \`table\`, ENGINE AS engine FROM information_schema.TABLES
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME`, [Object.keys(PROJECTIONS)]);
    tables.columns = columns; tables.engines = engines;
    return { schemaVersion: 1, capturedAt: new Date().toISOString(), access: 'direct database consistent snapshot', tables: normalizeDatabaseTables(tables) };
}

export async function loadArcSnapshot(path) {
    const bytes = await readFile(path);
    const snapshot = JSON.parse(bytes.toString('utf8'));
    if (snapshot.schemaVersion !== 1 || snapshot.publisher !== 'ARC Prize'
        || !Number.isFinite(Date.parse(snapshot.fetchedAt)) || snapshot.sources?.length !== ARC_SOURCES.length) {
        throw new Error('Invalid ARC snapshot.');
    }
    for (const definition of ARC_SOURCES) {
        const matches = snapshot.sources.filter(source => source.version === definition.version);
        if (matches.length !== 1 || matches[0].rawFile !== `${definition.version}.json`) throw new Error('Invalid source inventory.');
        const text = await readFile(resolve(dirname(path), matches[0].rawFile), 'utf8');
        if (stableJSON(matches[0]) !== stableJSON(normalizeArcSource(text, definition))) {
            throw new Error(`Snapshot differs from raw official ${definition.version} evidence.`);
        }
    }
    return { snapshot, hash: sha256(bytes) };
}

export function fitsRawScore(score, schema) {
    if (!schema || !/^decimal\(\d+,\d+\)$/i.test(schema.type)) return false;
    const plain = decimalText(score), [integer, fractional = ''] = plain.split('.');
    return fractional.length <= Number(schema.scale)
        && integer.replace(/^-?0*/, '').length <= Number(schema.precision) - Number(schema.scale);
}

export function quantizePercent(input) {
    const exactPercent = decimalText(input);
    if (compareCanonicalNumbers(exactPercent, '0') < 0 || compareCanonicalNumbers(exactPercent, '100') > 0) {
        throw new Error('ARC percentage must be between 0 and 100.');
    }
    const [integer, fraction = ''] = exactPercent.split('.');
    let units = BigInt(integer + fraction.slice(0, 6).padEnd(6, '0'));
    if (fraction.length > 6 && fraction[6] >= '5') units++;
    const digits = units.toString().padStart(7, '0');
    const storedPercent = `${digits.slice(0, -6)}.${digits.slice(-6)}`;
    const scale = Math.max(6, fraction.length);
    const exactUnits = BigInt(integer + fraction.padEnd(scale, '0'));
    const differenceUnits = units * 10n ** BigInt(scale - 6) - exactUnits;
    const difference = decimalText(`${differenceUnits}e-${scale}`);
    return { exactPercent, storedPercent, rule: 'ROUND_HALF_UP', decimalPlaces: 6,
        storageType: 'DECIMAL(18,6)', difference, differenceDefinition: 'storedPercent - exactPercent',
        differenceUnit: 'percentage_points', changed: differenceUnits !== 0n };
}

function fieldCatalog(tables) {
    return tables.score_fields.filter(row => Number(row.is_active) === 1).map(row => ({
        ID: Number(row.ID), name: row.name, type: row.field_type, allowEmpty: Boolean(row.allow_empty),
        excludeMissing: Boolean(row.exclude_missing), excludeEmpty: Boolean(row.exclude_empty),
        options: tables.score_field_options.filter(option => Number(option.field_ID) === Number(row.ID)
            && Number(option.is_active) === 1).map(option => ({ ID: Number(option.ID), label: option.label,
            excluded: Boolean(option.excluded) }))
    }));
}

function parseNotes(row) {
    if (!row.notes) return {};
    try {
        const notes = json(row.notes);
        return notes && typeof notes === 'object' && !Array.isArray(notes) ? notes : { previous_notes: row.notes };
    } catch { return { previous_notes: row.notes }; }
}

function sameFields(left, right, catalog) {
    return stableJSON(normalizeScoreFields(json(left), catalog)) === stableJSON(right);
}

function assertState(state) {
    if (state.schemaVersion !== 1 || !state.tables) throw new Error('Invalid database snapshot schema.');
    for (const table of [...Object.keys(PROJECTIONS), 'columns', 'engines']) {
        if (!Array.isArray(state.tables[table])) throw new Error(`Missing database export: ${table}.`);
    }
    for (const table of Object.keys(PROJECTIONS)) {
        if (state.tables.engines.find(row => row.table === table)?.engine !== 'InnoDB') throw new Error(`Nontransactional or missing ${table}.`);
        const ids = state.tables[table].map(row => String(row.ID));
        if (new Set(ids).size !== ids.length) throw new Error(`Duplicate database IDs in ${table}.`);
        for (const column of PROJECTIONS[table]) {
            if (!state.tables.columns.some(row => row.table === table && row.column === column)) throw new Error(`Missing ${table}.${column}.`);
        }
    }
    if (state.tables.columns.find(row => row.table === 'benchmark_results' && row.column === 'score_fields')?.type !== 'json') {
        throw new Error('Per-score fields schema is incompatible.');
    }
    for (const benchmark of state.tables.benchmarks) {
        if (!Object.hasOwn(benchmark, 'scores_updated_at') || (benchmark.scores_updated_at !== null
            && (typeof benchmark.scores_updated_at !== 'string'
                || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/.test(benchmark.scores_updated_at)))) {
            throw new Error('Missing/noncanonical benchmark score-update timestamp.');
        }
    }
}

export function buildArcPlan(snapshot, state, mapping, hashes = {}) {
    assertState(state);
    if (mapping.schemaVersion !== 1 || !Array.isArray(mapping.identities) || !Array.isArray(mapping.runs)
        || !Array.isArray(mapping.datasets)) throw new Error('Invalid explicit mapping schema.');
    if (mapping.snapshotHash && mapping.snapshotHash !== hashes.snapshotHash) throw new Error('Mapping was reviewed for a different snapshot.');
    const tables = state.tables, catalog = fieldCatalog(tables);
    const plan = { schemaVersion: 1, dryRun: true, ...hashes, stateHash: objectHash(tables),
        sources: snapshot.sources.map(source => ({ version: source.version, url: source.url, sha256: source.sha256,
            generatedAt: source.generatedAt, datasets: source.datasets, collected: source.entries.length,
            excluded: source.excluded, unlabelled: source.entries.filter(row => row.displayLabel === false).length })),
        creates: { organizations: [], models: [] }, datasets: [], rows: [], blockers: [], warnings: [] };
    const block = (code, recordIDs, detail) => plan.blockers.push({ code, recordIDs, detail });
    const organizationBySlug = new Map(tables.organizations.map(row => [row.slug, row]));
    const modelBySlug = new Map(tables.models.map(row => [row.slug, row]));
    if (organizationBySlug.size !== tables.organizations.length || modelBySlug.size !== tables.models.length) throw new Error('Duplicate database slugs.');
    for (const organization of mapping.newOrganizations ?? []) {
        if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(organization.slug) || !organization.name
            || organization.name.length > 128 || !organization.evidenceURL || organizationBySlug.has(organization.slug)) {
            const existing = organizationBySlug.get(organization.slug);
            if (existing && existing.name === organization.name && Number(existing.is_active) === 1
                && Number(existing.is_model_vendor) === 1) continue;
            throw new Error(`Invalid/conflicting new organization ${organization.slug}.`);
        }
        if (tables.organizations.some(row => fieldNameKey(row.name) === fieldNameKey(organization.name))) throw new Error(`Organization name already exists: ${organization.name}.`);
        plan.creates.organizations.push(organization);
        organizationBySlug.set(organization.slug, { ...organization, ID: null, is_active: 1, is_model_vendor: 1 });
    }
    for (const model of mapping.newModels ?? []) {
        const vendor = organizationBySlug.get(model.vendorSlug), existing = modelBySlug.get(model.slug);
        if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(model.slug) || !model.name || model.name.length > 192
            || !model.evidenceURL || !vendor || Number(vendor.is_active) !== 1 || Number(vendor.is_model_vendor) !== 1) {
            throw new Error(`Invalid new model ${model.slug}.`);
        }
        if (existing) {
            if (existing.name !== model.name || Number(existing.vendor_ID) !== Number(vendor.ID) || Number(existing.is_active) !== 1) throw new Error(`Conflicting new model ${model.slug}.`);
            continue;
        }
        if (tables.models.some(row => Number(row.vendor_ID) === Number(vendor.ID)
            && fieldNameKey(row.name) === fieldNameKey(model.name))) throw new Error(`Model identity already exists under another slug: ${model.name}.`);
        plan.creates.models.push(model);
        modelBySlug.set(model.slug, { ...model, ID: null, vendor_ID: vendor.ID, is_active: 1 });
    }
    const identities = new Map();
    for (const identity of mapping.identities) {
        if (!identity.providerId || !identity.sourceModelIds?.length || !identity.modelSlug || !identity.evidence?.length) throw new Error('Identity requires explicit source IDs and evidence.');
        const model = modelBySlug.get(identity.modelSlug), vendor = organizationBySlug.get(identity.vendorSlug);
        if (!model || !vendor || model.name !== identity.expectedName || Number(model.is_active) !== 1
            || (model.ID !== null && Number(model.vendor_ID) !== Number(vendor.ID))
            || (model.ID === null && model.vendorSlug !== identity.vendorSlug)) throw new Error(`Mapped identity differs: ${identity.modelSlug}.`);
        const duplicates = tables.models.filter(row => Number(row.vendor_ID) === Number(vendor.ID)
            && fieldNameKey(row.name) === fieldNameKey(model.name));
        if (duplicates.length > 1) throw new Error(`Ambiguous model identity ${model.name}.`);
        for (const modelId of identity.sourceModelIds) {
            const id = key(identity.providerId, modelId);
            if (identities.has(id)) throw new Error(`Duplicate explicit identity mapping: ${id}.`);
            identities.set(id, model);
        }
    }
    const runs = new Map();
    for (const run of mapping.runs) {
        if (!run.recordID || runs.has(run.recordID) || !Array.isArray(run.fields) || !run.evidence?.length) throw new Error('Invalid/duplicate run configuration mapping.');
        const fields = normalizeScoreFields(run.fields, catalog);
        for (const field of fields) {
            const definition = catalog.find(item => item.ID === field.fieldID);
            const expected = mapping.expectedFields?.[field.fieldID];
            if (!expected || expected.name !== definition.name || expected.type !== definition.type) throw new Error(`Field contract changed: ${field.fieldID}.`);
            if (definition.type === 'enum' && (definition.options.find(option => option.ID === field.value)?.label !== expected.options?.[field.value]
                || definition.options.find(option => option.ID === field.value)?.excluded)) throw new Error(`Enum option contract changed: ${field.fieldID}/${field.value}.`);
        }
        runs.set(run.recordID, { ...run, fields });
    }
    const sourceRows = snapshot.sources.flatMap(source => source.entries.map(row => ({ ...row, sourceVersion: source.version }))),
        sourceIDs = new Set(sourceRows.map(row => row.recordID));
    if (sourceIDs.size !== sourceRows.length) throw new Error('Duplicate snapshot record IDs.');
    for (const run of runs.values()) if (!sourceIDs.has(run.recordID)) throw new Error(`Run mapping references nonexistent evidence ${run.recordID}.`);
    for (const identity of mapping.identities) for (const modelId of identity.sourceModelIds) {
        if (!sourceRows.some(row => row.providerId === identity.providerId && row.modelId === modelId)) throw new Error(`Identity mapping references nonexistent evidence ${modelId}.`);
    }
    const datasetTargets = new Map(), datasetRefs = new Set();
    for (const source of snapshot.sources) for (const dataset of source.datasets) {
        const datasetKey = `${source.version}:${dataset.id}`;
        const ids = source.entries.filter(row => row.datasetId === dataset.id).map(row => row.recordID);
        const matches = mapping.datasets.filter(item => item.sourceVersion === source.version && item.datasetId === dataset.id);
        if (matches.length !== 1) { block('dataset_mapping_required', ids, { datasetKey }); continue; }
        const target = matches[0], benchmark = tables.benchmarks.find(row => Number(row.ID) === target.benchmarkID),
            condition = tables.benchmark_conditions.find(row => Number(row.ID) === target.conditionID);
        if (!target.evidence?.length || !benchmark || benchmark.name !== source.benchmark || benchmark.name !== target.benchmarkName
            || Number(benchmark.is_active) !== 1 || !condition || Number(condition.benchmark_ID) !== target.benchmarkID
            || condition.condition_key !== target.conditionKey || condition.name !== target.conditionName
            || condition.deleted_at !== null || condition.score_direction !== 'higher' || Number(condition.uses_percentage_scale) !== 1
            || condition.score_min !== null || condition.score_max !== null || condition.target_value !== null) {
            block('dataset_target_contract_changed', ids, target); continue;
        }
        if (datasetRefs.has(target.conditionID)) throw new Error('Different official datasets must not share a condition.');
        datasetRefs.add(target.conditionID);
        const primary = tables.benchmark_conditions.filter(row => Number(row.benchmark_ID) === target.benchmarkID
            && row.deleted_at === null && Number(row.is_primary) === 1);
        if (primary.length !== 1) { block('primary_condition_invariant', ids, { benchmarkID: target.benchmarkID }); continue; }
        const state = { ...target, conditionSnapshot: { name: condition.name, scoreMax: null, scoreMin: null,
            benchmarkID: target.benchmarkID, conditionID: target.conditionID, targetValue: null,
            scoreDirection: 'higher', usesPercentageScale: true } };
        datasetTargets.set(datasetKey, state); plan.datasets.push(target);
    }
    if (mapping.datasets.length !== plan.datasets.length && !plan.blockers.length) throw new Error('Mapping contains an unused dataset.');
    const rawSchema = tables.columns.find(row => row.table === 'benchmark_results' && row.column === 'raw_score');
    const existingByKey = new Map();
    for (const row of tables.benchmark_results) {
        const auditKey = parseNotes(row).arc_official_key;
        if (!auditKey) {
            if (row.source_title === SOURCE_TITLE) block('existing_import_missing_key', [], { resultID: row.ID });
            continue;
        }
        const group = existingByKey.get(auditKey) ?? []; group.push(row); existingByKey.set(auditKey, group);
    }
    const unmapped = new Map(), plannedPartitions = new Map();
    for (const sourceRow of sourceRows) {
        const model = identities.get(key(sourceRow.providerId, sourceRow.modelId)),
            dataset = datasetTargets.get(`${sourceRow.sourceVersion}:${sourceRow.datasetId}`), run = runs.get(sourceRow.recordID);
        const row = { recordID: sourceRow.recordID, modelId: sourceRow.modelId, modelName: sourceRow.modelName,
            providerId: sourceRow.providerId, sourceVersion: sourceRow.sourceVersion, datasetId: sourceRow.datasetId,
            sourceIndex: sourceRow.sourceIndex, scoreFraction: sourceRow.scoreFraction, scorePercent: sourceRow.scorePercent,
            quantization: quantizePercent(sourceRow.scorePercent),
            sourceURL: sourceRow.sourceURL, costPerTaskUSD: sourceRow.costPerTaskUSD,
            modelSlug: model?.slug ?? null, modelID: model?.ID ?? null,
            benchmarkID: dataset?.benchmarkID ?? null, conditionID: dataset?.conditionID ?? null,
            fields: run?.fields ?? null, action: 'blocked', issues: [] };
        const issue = (code, detail) => { row.issues.push(code); block(code, [row.recordID], detail); };
        if (sourceRow.sourceCollisionOf) issue('source_identity_collision', { otherRecordID: sourceRow.sourceCollisionOf });
        if (!model) {
            row.issues.push('model_identity_unresolved');
            const unresolved = (mapping.unresolvedIdentityNotes ?? []).find(item => item.providerId === sourceRow.providerId
                && item.sourceModelIds.includes(sourceRow.modelId));
            const identity = key(sourceRow.providerId, sourceRow.modelId), group = unmapped.get(identity) ?? {
                providerId: sourceRow.providerId, modelId: sourceRow.modelId, modelName: sourceRow.modelName, recordIDs: [],
                reason: unresolved?.reason ?? 'No explicitly reviewed identity mapping; no automatic fallback.',
                candidates: unresolved?.candidates ?? [] };
            group.recordIDs.push(row.recordID); unmapped.set(identity, group);
        }
        if (!dataset) row.issues.push('dataset_mapping_unresolved');
        if (!run) issue('run_configuration_unresolved', { modelId: sourceRow.modelId });
        if (rawSchema?.type?.toLowerCase() !== 'decimal(18,6)' || !fitsRawScore(row.quantization.storedPercent, rawSchema)) {
            issue('raw_score_storage_contract_changed', { required: 'DECIMAL(18,6)', columnType: rawSchema?.type ?? null });
        }
        if (sourceRow.duplicateOf) {
            row.duplicateOf = sourceRow.duplicateOf; row.action = row.issues.length ? 'blocked' : 'source_duplicate';
            plan.rows.push(row); continue;
        }
        if (model && dataset && run) {
            const partition = stableJSON([model.slug, dataset.conditionID, run.fields]);
            const previous = plannedPartitions.get(partition);
            if (previous && previous.recordID !== row.recordID) {
                issue('source_configuration_collision', { otherRecordID: previous.recordID, scorePercent: previous.scorePercent });
            } else plannedPartitions.set(partition, row);
            const imported = existingByKey.get(row.recordID) ?? [], accepted = imported.filter(item => item.status === 'accepted');
            if (imported.some(item => item.status === 'archived') || accepted.length > 1) issue('existing_import_status_conflict', { resultIDs: imported.map(item => item.ID) });
            const current = accepted[0];
            if (current) {
                const notes = parseNotes(current);
                if (Number(current.model_ID) !== Number(model.ID) || Number(current.benchmark_ID) !== dataset.benchmarkID
                    || Number(current.benchmark_condition_ID) !== dataset.conditionID || !sameFields(current.score_fields, run.fields, catalog)
                    || notes.arc_dataset_id !== sourceRow.datasetId || notes.arc_source_version !== sourceRow.sourceVersion
                    || notes.arc_model_id !== sourceRow.modelId || notes.arc_provider_id !== sourceRow.providerId
                    || current.source_url !== sourceRow.sourceURL) {
                    issue('existing_import_identity_changed', { resultID: current.ID });
                } else if (canonicalNumber(current.raw_score) === canonicalNumber(row.quantization.storedPercent)
                    && notes.arc_score_fraction === sourceRow.scoreFraction
                    && notes.arc_score_percent_exact === sourceRow.scorePercent
                    && stableJSON(notes.arc_score_quantization) === stableJSON(row.quantization)) {
                    row.action = 'unchanged'; row.existingResultID = Number(current.ID);
                } else { row.action = 'supersede'; row.existingResultID = Number(current.ID); row.previousScore = current.raw_score; }
            } else {
                const candidates = model.ID === null ? [] : tables.benchmark_results.filter(item => Number(item.model_ID) === Number(model.ID)
                    && Number(item.benchmark_ID) === dataset.benchmarkID && item.status === 'accepted'
                    && !parseNotes(item).arc_official_key);
                const exact = candidates.filter(item => Number(item.benchmark_condition_ID) === dataset.conditionID
                    && item.source_url === sourceRow.sourceURL
                    && canonicalNumber(item.raw_score) === canonicalNumber(row.quantization.storedPercent)
                    && (sameFields(item.score_fields, run.fields, catalog) || (mapping.existingScoreResolutions ?? []).some(resolution =>
                        resolution.resultID === Number(item.ID) && resolution.recordIDs?.includes(row.recordID)
                        && resolution.classification === 'same_run' && resolution.evidence?.length
                        && resolution.expectedRowHash === objectHash(item))));
                if (exact.length === 1) { row.action = 'adopt'; row.existingResultID = Number(exact[0].ID); }
                else if (exact.length > 1) issue('existing_score_duplicate', { resultIDs: exact.map(item => item.ID) });
                else row.action = 'insert';
                const unresolved = candidates.filter(item => !exact.includes(item) && (() => {
                    try { return new URL(item.source_url).hostname === 'arcprize.org'; } catch { return false; }
                })());
                for (const candidate of unresolved) {
                    const resolution = (mapping.existingScoreResolutions ?? []).find(item => item.resultID === Number(candidate.ID)
                        && item.recordIDs?.includes(row.recordID));
                    if (!resolution || resolution.classification !== 'distinct_run' || !resolution.evidence?.length
                        || resolution.expectedRowHash !== objectHash(candidate)) {
                        issue('legacy_official_score_overlap', { resultID: candidate.ID, rawScore: candidate.raw_score,
                            conditionID: candidate.benchmark_condition_ID, scoreFields: json(candidate.score_fields),
                            sourceURL: candidate.source_url, notes: candidate.notes });
                    }
                }
                if (candidates.length) row.existingEvidenceIDs = candidates.map(item => Number(item.ID));
                if (row.action === 'adopt' && !sameFields(exact[0].score_fields, run.fields, catalog)) {
                    row.previousScoreFields = json(exact[0].score_fields);
                }
            }
            if (imported.length && !accepted.length && !row.issues.length) issue('previous_import_has_no_accepted_row', { resultIDs: imported.map(item => item.ID) });
        }
        if (row.issues.length) row.action = 'blocked';
        const duplicateEvidence = sourceRows.filter(item => item.duplicateOf === row.recordID).map(item => item.evidencePointer);
        row.evidence = { arc_official_key: row.recordID, arc_source_version: sourceRow.sourceVersion,
            arc_dataset_id: sourceRow.datasetId, arc_model_id: sourceRow.modelId, arc_provider_id: sourceRow.providerId,
            arc_model_name: sourceRow.modelName, arc_score_fraction: sourceRow.scoreFraction,
            arc_score_percent_exact: sourceRow.scorePercent, arc_score_quantization: row.quantization,
            arc_cost_per_task_usd: sourceRow.costPerTaskUSD,
            arc_source_record: sourceRow.sourceRecord, arc_data_url: ARC_SOURCES.find(item => item.version === sourceRow.sourceVersion).url,
            arc_results_url: sourceRow.resultsURL, arc_evidence_pointer: sourceRow.evidencePointer,
            arc_duplicate_evidence: duplicateEvidence, arc_configuration_evidence: run?.evidence ?? [],
            ...(row.previousScoreFields ? { arc_previous_score_fields: row.previousScoreFields } : {}),
            source_fetched_at: snapshot.fetchedAt, source_generated_at: snapshot.sources.find(source => source.version === sourceRow.sourceVersion).generatedAt };
        row.conditionSnapshot = dataset?.conditionSnapshot ?? null;
        plan.rows.push(row);
    }
    for (const detail of unmapped.values()) block('model_identity_unresolved', detail.recordIDs, detail);
    for (const row of plan.rows.filter(item => item.duplicateOf)) {
        if (plan.rows.find(item => item.recordID === row.duplicateOf)?.action === 'blocked' && row.action !== 'blocked') {
            row.action = 'blocked'; row.issues.push('duplicate_target_blocked');
        }
    }
    plan.unresolvedIdentities = [...unmapped.values()];
    plan.counts = { collected: plan.rows.length, uniqueSourceEvaluations: plan.rows.filter(row => !row.duplicateOf).length,
        mapped: plan.rows.filter(row => row.modelSlug).length, unlabelled: plan.sources.reduce((n, source) => n + source.unlabelled, 0),
        quantized: plan.rows.filter(row => row.quantization.changed).length,
        uniqueQuantized: plan.rows.filter(row => row.quantization.changed && !row.duplicateOf).length,
        actions: Object.fromEntries(['insert', 'adopt', 'supersede', 'unchanged', 'source_duplicate', 'blocked'].map(action => [action, plan.rows.filter(row => row.action === action).length])),
        blockerTypes: Object.fromEntries([...new Set(plan.blockers.map(item => item.code))].map(code => [code, plan.blockers.filter(item => item.code === code).length])) };
    plan.intentHash = objectHash({ datasets: mapping.datasets, identities: mapping.identities, runs: mapping.runs,
        newOrganizations: mapping.newOrganizations ?? [], newModels: mapping.newModels ?? [],
        evaluations: sourceRows.map(row => [row.recordID, row.scoreFraction, row.scorePercent, row.sourceURL, row.costPerTaskUSD]) });
    plan.benchmarkTimestampUpdates = [...new Set(plan.rows.filter(row => ['insert', 'adopt', 'supersede'].includes(row.action))
        .map(row => row.benchmarkID))].sort((a, b) => a - b).map(benchmarkID => ({ benchmarkID,
        before: tables.benchmarks.find(row => Number(row.ID) === benchmarkID).scores_updated_at,
        afterRule: 'UTC_TIMESTAMP(3) at apply, only after an actual score/evidence mutation; not fetchedAt or release date' }));
    plan.canApply = plan.blockers.length === 0 && plan.counts.actions.blocked === 0;
    return plan;
}

export async function durableBackup(path, state, planHash) {
    await mkdir(dirname(path), { recursive: true });
    const body = { schemaVersion: 1, kind: 'arc-official-before-apply', createdAt: new Date().toISOString(),
        planHash, stateHash: objectHash(state.tables), state };
    const backup = { ...body, sha256: objectHash(body) };
    const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(backup, null, 2) + '\n', 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    const verified = JSON.parse(await readFile(path, 'utf8'));
    const { sha256: hash, ...savedBody } = verified;
    if (hash !== objectHash(savedBody) || verified.stateHash !== objectHash(state.tables)) throw new Error('Backup verification failed.');
    return hash;
}

export async function applyArcPlan(connection, { snapshot, mapping, hashes, approvedPlan, approvedPlanHash, backupPath,
    readState = readDatabaseState, backup = durableBackup, persistReceipt = async () => {} }) {
    if (!approvedPlan.canApply || approvedPlan.blockers?.length || approvedPlan.dryRun !== true
        || approvedPlan.snapshotHash !== hashes.snapshotHash || approvedPlan.mappingHash !== hashes.mappingHash) {
        throw new Error('An unblocked reviewed dry-run with identical input hashes is required.');
    }
    let locked = false;
    try {
        const [[lock]] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [LOCK]);
        if (Number(lock.acquired) !== 1) throw new Error('Could not acquire ARC import lock.');
        locked = true;
        await connection.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
        await connection.beginTransaction();
        const state = await readState(connection), current = buildArcPlan(snapshot, state, mapping, hashes);
        if (!current.canApply || current.intentHash !== approvedPlan.intentHash) throw new Error('Current plan is blocked or has different intent.');
        const pending = current.rows.filter(row => ['insert', 'adopt', 'supersede'].includes(row.action));
        if (!pending.length && !current.creates.models.length && !current.creates.organizations.length) {
            await connection.rollback(); return { applied: false, idempotent: true, counts: current.counts };
        }
        if (objectHash(current) !== objectHash(approvedPlan)) throw new Error('Database changed after reviewed dry-run; regenerate the plan.');
        const backupHash = await backup(backupPath, state, approvedPlanHash);
        const organizationIDs = new Map(state.tables.organizations.map(row => [row.slug, Number(row.ID)])),
            modelIDs = new Map(state.tables.models.map(row => [row.slug, Number(row.ID)])), receipt = [],
            touched = new Set(), created = { organizations: [], models: [] };
        for (const organization of current.creates.organizations) {
            const [inserted] = await connection.execute(`INSERT INTO organizations (slug,name,is_model_vendor,is_active,introduction_url)
                VALUES (?,?,1,1,?)`, [organization.slug, organization.name, organization.evidenceURL]);
            organizationIDs.set(organization.slug, Number(inserted.insertId));
            created.organizations.push(Number(inserted.insertId));
        }
        for (const model of current.creates.models) {
            const [inserted] = await connection.execute(`INSERT INTO models (vendor_ID,slug,name,is_active,introduction_url,notes)
                VALUES (?,?,?,1,?,?)`, [organizationIDs.get(model.vendorSlug), model.slug, model.name, model.evidenceURL,
                JSON.stringify({ arc_identity_evidence: model.evidenceURL })]);
            modelIDs.set(model.slug, Number(inserted.insertId));
            created.models.push(Number(inserted.insertId));
        }
        for (const row of pending) {
            if (row.action === 'adopt') {
                const existing = state.tables.benchmark_results.find(item => Number(item.ID) === row.existingResultID);
                const [updated] = await connection.execute(`UPDATE benchmark_results SET notes = ?, score_fields = ? WHERE ID = ? AND status = 'accepted'`,
                    [JSON.stringify({ ...parseNotes(existing), ...row.evidence }), JSON.stringify(row.fields), row.existingResultID]);
                if (updated.affectedRows !== 1) throw new Error('Existing evidence changed before adoption.');
                receipt.push({ recordID: row.recordID, action: row.action, resultID: row.existingResultID });
                touched.add(row.existingResultID);
                continue;
            }
            if (row.action === 'supersede') {
                const [updated] = await connection.execute(`UPDATE benchmark_results SET status = 'superseded' WHERE ID = ? AND status = 'accepted'`, [row.existingResultID]);
                if (updated.affectedRows !== 1) throw new Error('Existing evidence changed before supersession.');
                touched.add(row.existingResultID);
            }
            const [inserted] = await connection.execute(`INSERT INTO benchmark_results
                (model_ID,benchmark_ID,benchmark_condition_ID,raw_score,source_url,source_type,source_title,
                 benchmark_condition_snapshot,status,notes,score_fields)
                VALUES (?,?,?,?,?,'third_party_lab',?,?,'accepted',?,?)`, [modelIDs.get(row.modelSlug), row.benchmarkID,
                row.conditionID, row.quantization.storedPercent, row.sourceURL, SOURCE_TITLE, JSON.stringify(row.conditionSnapshot),
                JSON.stringify(row.evidence), JSON.stringify(row.fields)]);
            receipt.push({ recordID: row.recordID, action: row.action, resultID: Number(inserted.insertId) });
            touched.add(Number(inserted.insertId));
        }
        for (const { benchmarkID, before } of current.benchmarkTimestampUpdates) {
            const [updated] = await connection.execute(`UPDATE benchmarks SET scores_updated_at=UTC_TIMESTAMP(3)
                WHERE ID = ? AND scores_updated_at <=> ?`, [benchmarkID, before]);
            if (updated.affectedRows !== 1) throw new Error('Benchmark score-update timestamp changed before apply.');
        }
        const after = await readState(connection), verification = buildArcPlan(snapshot, after, mapping, hashes);
        if (!verification.canApply || verification.rows.some(row => !['unchanged', 'source_duplicate'].includes(row.action))) {
            throw new Error('Post-write exact score/configuration verification failed.');
        }
        const updatedBenchmarks = new Set(current.benchmarkTimestampUpdates.map(row => row.benchmarkID));
        if (state.tables.benchmarks.some(before => {
            const updated = after.tables.benchmarks.find(row => Number(row.ID) === Number(before.ID));
            return !updated || (updatedBenchmarks.has(Number(before.ID)) ? updated.scores_updated_at === null
                : updated.scores_updated_at !== before.scores_updated_at);
        })) throw new Error('Post-write benchmark timestamp scope verification failed.');
        const result = { schemaVersion: 1, kind: 'arc-official-apply-receipt', applied: true, idempotent: false,
            transactionState: 'prepared-for-commit', approvedPlanHash, backupPath, backupHash, receipt, created,
            mutations: [...touched].sort((a, b) => a - b).map(ID => ({ ID,
                before: state.tables.benchmark_results.find(row => Number(row.ID) === ID) ?? null,
                after: after.tables.benchmark_results.find(row => Number(row.ID) === ID) })),
            benchmarkMutations: current.benchmarkTimestampUpdates.map(({ benchmarkID, before }) => ({ benchmarkID, before,
                after: after.tables.benchmarks.find(row => Number(row.ID) === benchmarkID).scores_updated_at })),
            counts: verification.counts };
        await persistReceipt(result);
        await connection.commit();
        return { ...result, transactionState: 'committed' };
    } catch (error) { await connection.rollback(); throw error; }
    finally { if (locked) await connection.query('SELECT RELEASE_LOCK(?)', [LOCK]); }
}

export function verifyArcImport(snapshot, state, mapping, hashes) {
    const plan = buildArcPlan(snapshot, state, mapping, hashes);
    const pending = plan.rows.filter(row => !['unchanged', 'source_duplicate'].includes(row.action));
    return { schemaVersion: 1, kind: 'arc-official-verification', readOnly: true,
        verified: plan.canApply && pending.length === 0 && !plan.creates.models.length && !plan.creates.organizations.length,
        stateHash: plan.stateHash, counts: plan.counts, blockers: plan.blockers,
        pending: pending.map(row => ({ recordID: row.recordID, action: row.action, issues: row.issues })) };
}

export function buildArcRollbackPlan(state, savedBackup, receipt, hashes = {}) {
    assertState(state);
    const { sha256: backupHash, ...body } = savedBackup;
    if (savedBackup.kind !== 'arc-official-before-apply' || backupHash !== objectHash(body)
        || savedBackup.stateHash !== objectHash(savedBackup.state.tables) || receipt.backupHash !== backupHash
        || receipt.approvedPlanHash !== savedBackup.planHash || receipt.schemaVersion !== 1
        || receipt.kind !== 'arc-official-apply-receipt' || receipt.applied !== true || !receipt.mutations?.length
        || !Array.isArray(receipt.benchmarkMutations)) {
        throw new Error('A verified original backup and its matching apply receipt are required.');
    }
    const plan = { schemaVersion: 1, kind: 'arc-official-rollback-plan', dryRun: true, ...hashes,
        stateHash: objectHash(state.tables), originalBackupHash: backupHash, rows: [], benchmarkTimestamps: [], blockers: [],
        retainedIdentities: receipt.created,
        policy: 'Archive inserted scores; restore adopted/superseded score fields, notes, status and update time, and exact drift-guarded benchmark scores_updated_at. Retain identities; no cascading deletes.' };
    const ids = new Set();
    const withoutUpdateTime = row => { const copy = { ...row }; delete copy.updated_at; return copy; };
    for (const mutation of receipt.mutations) {
        const { ID, before, after } = mutation;
        const original = savedBackup.state.tables.benchmark_results.find(row => Number(row.ID) === ID) ?? null;
        if (!Number.isSafeInteger(ID) || ids.has(ID) || Number(after?.ID) !== ID || stableJSON(before) !== stableJSON(original)
            || !parseNotes(after).arc_official_key) throw new Error('Invalid or non-owned receipt mutation.');
        ids.add(ID);
        const current = state.tables.benchmark_results.find(row => Number(row.ID) === ID) ?? null;
        let action;
        if (before && stableJSON(current) === stableJSON(before)) action = 'unchanged';
        else if (!before && current?.status === 'archived'
            && stableJSON(withoutUpdateTime(current)) === stableJSON(withoutUpdateTime({ ...after, status: 'archived' }))) action = 'unchanged';
        else if (stableJSON(current) === stableJSON(after)) action = before ? 'restore' : 'archive';
        else { action = 'blocked'; plan.blockers.push({ code: 'rollback_row_changed', resultID: ID }); }
        plan.rows.push({ resultID: ID, action, before, after });
    }
    const benchmarkIDs = new Set(receipt.mutations.flatMap(mutation => [mutation.before?.benchmark_ID, mutation.after.benchmark_ID]
        .filter(ID => ID != null).map(Number))), timestampIDs = new Set();
    for (const { benchmarkID, before, after } of receipt.benchmarkMutations) {
        const original = savedBackup.state.tables.benchmarks.find(row => Number(row.ID) === benchmarkID);
        if (!Number.isSafeInteger(benchmarkID) || !benchmarkIDs.has(benchmarkID) || timestampIDs.has(benchmarkID)
            || !original || !['ARC-AGI-1', 'ARC-AGI-2'].includes(original.name) || before !== original.scores_updated_at
            || typeof after !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/.test(after)) {
            throw new Error('Invalid benchmark timestamp receipt mutation.');
        }
        timestampIDs.add(benchmarkID);
        const current = state.tables.benchmarks.find(row => Number(row.ID) === benchmarkID);
        let action;
        if (current && current.scores_updated_at === before) action = 'unchanged';
        else if (current && current.scores_updated_at === after) action = 'restore';
        else { action = 'blocked'; plan.blockers.push({ code: 'rollback_benchmark_timestamp_changed', benchmarkID }); }
        plan.benchmarkTimestamps.push({ benchmarkID, action, before, after });
    }
    if (timestampIDs.size !== benchmarkIDs.size) throw new Error('Missing benchmark timestamp receipt mutation.');
    plan.counts = Object.fromEntries(['restore', 'archive', 'unchanged', 'blocked'].map(action => [action, plan.rows.filter(row => row.action === action).length]));
    plan.benchmarkTimestampCounts = Object.fromEntries(['restore', 'unchanged', 'blocked'].map(action => [action,
        plan.benchmarkTimestamps.filter(row => row.action === action).length]));
    plan.canApply = plan.blockers.length === 0;
    return plan;
}

export async function rollbackArcImport(connection, { savedBackup, receipt, hashes, approvedPlan, approvedPlanHash,
    backupPath, readState = readDatabaseState, backup = durableBackup, persistReceipt = async () => {} }) {
    if (!approvedPlan.canApply || approvedPlan.kind !== 'arc-official-rollback-plan' || approvedPlan.dryRun !== true
        || approvedPlan.blockers?.length || approvedPlan.receiptHash !== hashes.receiptHash
        || approvedPlan.backupFileHash !== hashes.backupFileHash) throw new Error('An unblocked, matching reviewed rollback plan is required.');
    let locked = false;
    try {
        const [[lock]] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [LOCK]);
        if (Number(lock.acquired) !== 1) throw new Error('Could not acquire ARC rollback lock.');
        locked = true;
        await connection.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
        await connection.beginTransaction();
        const state = await readState(connection), current = buildArcRollbackPlan(state, savedBackup, receipt, hashes);
        if (!current.canApply) throw new Error('Rollback rows changed; regenerate and review the rollback plan.');
        if (!current.counts.archive && !current.counts.restore && !current.benchmarkTimestampCounts.restore) {
            await connection.rollback(); return { rolledBack: false, idempotent: true, counts: current.counts,
                benchmarkTimestampCounts: current.benchmarkTimestampCounts };
        }
        if (objectHash(current) !== objectHash(approvedPlan)) throw new Error('Database changed after rollback review.');
        const safetyBackupHash = await backup(backupPath, state, approvedPlanHash);
        for (const row of current.rows) {
            let result;
            if (row.action === 'archive') [result] = await connection.execute(`UPDATE benchmark_results SET status = 'archived' WHERE ID = ?`, [row.resultID]);
            if (row.action === 'restore') [result] = await connection.execute(`UPDATE benchmark_results SET notes = ?, score_fields = ?, status = ?, updated_at = ? WHERE ID = ?`,
                [row.before.notes, JSON.stringify(json(row.before.score_fields)), row.before.status, row.before.updated_at, row.resultID]);
            if (result && result.affectedRows !== 1) throw new Error('Rollback mutation did not affect exactly one row.');
        }
        for (const row of current.benchmarkTimestamps.filter(row => row.action === 'restore')) {
            const [updated] = await connection.execute(`UPDATE benchmarks SET scores_updated_at = ?
                WHERE ID = ? AND scores_updated_at <=> ?`, [row.before, row.benchmarkID, row.after]);
            if (updated.affectedRows !== 1) throw new Error('Benchmark timestamp changed before rollback.');
        }
        const after = await readState(connection), verification = buildArcRollbackPlan(after, savedBackup, receipt, hashes);
        if (!verification.canApply || verification.rows.some(row => row.action !== 'unchanged')
            || verification.benchmarkTimestamps.some(row => row.action !== 'unchanged')) throw new Error('Rollback verification failed.');
        const result = { schemaVersion: 1, kind: 'arc-official-rollback-receipt', rolledBack: true, idempotent: false,
            transactionState: 'prepared-for-commit', approvedPlanHash, safetyBackupHash, backupPath,
            originalBackupHash: receipt.backupHash, receiptHash: hashes.receiptHash,
            benchmarkMutations: current.benchmarkTimestamps.filter(row => row.action === 'restore').map(row => ({
                benchmarkID: row.benchmarkID, before: state.tables.benchmarks.find(item => Number(item.ID) === row.benchmarkID).scores_updated_at,
                after: after.tables.benchmarks.find(item => Number(item.ID) === row.benchmarkID).scores_updated_at })),
            retainedIdentities: receipt.created, counts: verification.counts, benchmarkTimestampCounts: verification.benchmarkTimestampCounts };
        await persistReceipt(result); await connection.commit();
        return { ...result, transactionState: 'committed' };
    } catch (error) { await connection.rollback(); throw error; }
    finally { if (locked) await connection.query('SELECT RELEASE_LOCK(?)', [LOCK]); }
}

function parseArguments(args) {
    const values = {}, booleans = new Set(['--apply', '--dry-run', '--verify', '--rollback']);
    const allowed = new Set(['--snapshot', '--state', '--mapping', '--output', '--capture-state', '--ssh-host', '--ssh-key',
        '--reviewed-plan', '--expect-plan-sha256', '--backup', '--receipt', '--rollback-backup']);
    for (const argument of args) {
        const equals = argument.indexOf('='), name = equals < 0 ? argument : argument.slice(0, equals),
            value = equals < 0 ? true : argument.slice(equals + 1);
        if ((!allowed.has(name) && !booleans.has(name)) || Object.hasOwn(values, name)
            || (allowed.has(name) && (value === true || value === '')) || (booleans.has(name) && value !== true)) throw new Error(`Invalid argument ${name}.`);
        values[name] = value;
    }
    if (values['--apply'] && values['--dry-run']) throw new Error('Choose dry-run or apply.');
    if (values['--verify'] && (values['--apply'] || values['--rollback'])) throw new Error('Verify is read-only, separate from apply/rollback.');
    return values;
}

async function main() {
    const args = parseArguments(process.argv.slice(2));
    if (args['--capture-state']) {
        if (Object.keys(args).some(name => !['--capture-state', '--ssh-host', '--ssh-key'].includes(name))) throw new Error('SSH supports read-only capture only.');
        const state = await captureReadOnlySSH({ host: args['--ssh-host'], identityFile: args['--ssh-key'] });
        await mkdir(dirname(resolve(args['--capture-state'])), { recursive: true });
        await writeFile(args['--capture-state'], JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        console.log(JSON.stringify({ captured: Object.fromEntries(Object.entries(state.tables).map(([name, rows]) => [name, rows.length])) }));
        return;
    }
    if (args['--rollback']) {
        if (!args['--backup'] || !args['--receipt'] || !args['--output'] || args['--snapshot'] || args['--mapping']
            || args['--ssh-host'] || args['--ssh-key']) throw new Error('Rollback requires --backup=<original> --receipt=<apply-receipt> --output=<file>.');
        const backupBytes = await readFile(args['--backup']), receiptBytes = await readFile(args['--receipt']),
            savedBackup = JSON.parse(backupBytes.toString('utf8')), receipt = JSON.parse(receiptBytes.toString('utf8')),
            hashes = { backupFileHash: sha256(backupBytes), receiptHash: sha256(receiptBytes) };
        if (!args['--apply']) {
            if (!args['--state'] || args['--reviewed-plan'] || args['--expect-plan-sha256'] || args['--rollback-backup']) {
                throw new Error('Rollback dry-run requires --state=<fresh-read-only-export>.');
            }
            const state = JSON.parse(await readFile(args['--state'], 'utf8')), plan = buildArcRollbackPlan(state, savedBackup, receipt, hashes);
            await writeFile(args['--output'], JSON.stringify(plan, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
            console.log(JSON.stringify({ canApply: plan.canApply, counts: plan.counts,
                benchmarkTimestampCounts: plan.benchmarkTimestampCounts, planHash: sha256(await readFile(args['--output'])) }));
            if (!plan.canApply) process.exitCode = 2;
            return;
        }
        if (args['--state'] || !args['--reviewed-plan'] || !/^[a-f0-9]{64}$/.test(args['--expect-plan-sha256'] ?? '')
            || !args['--rollback-backup']) throw new Error('Rollback apply requires reviewed hash and --rollback-backup=<new-safety-backup>.');
        const approvedBytes = await readFile(args['--reviewed-plan']), approvedPlanHash = sha256(approvedBytes);
        if (approvedPlanHash !== args['--expect-plan-sha256']) throw new Error('Reviewed rollback plan hash differs.');
        const approvedPlan = JSON.parse(approvedBytes.toString('utf8'));
        if (!approvedPlan.canApply || approvedPlan.blockers?.length) throw new Error('Blocked rollback plan cannot be applied.');
        await withReceiptOutput(args['--output'], async (connection, persistReceipt) => rollbackArcImport(connection,
            { savedBackup, receipt, hashes, approvedPlan, approvedPlanHash, persistReceipt, backupPath: resolve(args['--rollback-backup']) }));
        return;
    }
    if (!args['--snapshot'] || !args['--mapping'] || !args['--output'] || args['--ssh-host'] || args['--ssh-key']) {
        throw new Error('Usage: --snapshot=<file> --mapping=<file> --state=<read-only-state.json> --output=<plan.json> [--dry-run]');
    }
    const { snapshot, hash: snapshotHash } = await loadArcSnapshot(args['--snapshot']),
        mappingBytes = await readFile(args['--mapping']), mapping = JSON.parse(mappingBytes.toString('utf8')),
        hashes = { snapshotHash, mappingHash: sha256(mappingBytes) };
    if (!args['--apply']) {
        if (!args['--state'] || args['--reviewed-plan'] || args['--expect-plan-sha256'] || args['--backup']
            || args['--receipt'] || args['--rollback-backup']) throw new Error('Dry-run/verify requires only read-only exported state.');
        const state = JSON.parse(await readFile(args['--state'], 'utf8'));
        if (args['--verify']) {
            const result = verifyArcImport(snapshot, state, mapping, hashes);
            await writeFile(args['--output'], JSON.stringify(result, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
            console.log(JSON.stringify({ verified: result.verified, counts: result.counts }));
            if (!result.verified) process.exitCode = 2;
            return;
        }
        const plan = buildArcPlan(snapshot, state, mapping, hashes);
        await writeFile(args['--output'], JSON.stringify(plan, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
        console.log(JSON.stringify({ canApply: plan.canApply, counts: plan.counts, unresolvedIdentities: plan.unresolvedIdentities.length,
            plan: args['--output'], planHash: sha256(await readFile(args['--output'])) }));
        if (!plan.canApply) process.exitCode = 2;
        return;
    }
    if (args['--state'] || args['--receipt'] || args['--rollback-backup'] || !args['--reviewed-plan']
        || !/^[a-f0-9]{64}$/.test(args['--expect-plan-sha256'] ?? '') || !args['--backup']) {
        throw new Error('Apply requires a reviewed plan SHA256 and a new durable backup path; offline state is forbidden.');
    }
    const approvedBytes = await readFile(args['--reviewed-plan']), approvedPlanHash = sha256(approvedBytes);
    if (approvedPlanHash !== args['--expect-plan-sha256']) throw new Error('Reviewed plan hash differs.');
    const approvedPlan = JSON.parse(approvedBytes.toString('utf8'));
    if (!approvedPlan.canApply || approvedPlan.blockers?.length) throw new Error('Blocked review plan cannot be applied.');
    await withReceiptOutput(args['--output'], async (connection, persistReceipt) => applyArcPlan(connection,
        { snapshot, mapping, hashes, approvedPlan, approvedPlanHash, persistReceipt, backupPath: resolve(args['--backup']) }));
}

async function withReceiptOutput(path, action) {
    const database = process.env.BENCHPOLL_DB_NAME, socketPath = process.env.BENCHPOLL_DB_SOCKET,
        host = process.env.BENCHPOLL_DB_HOST, user = process.env.BENCHPOLL_DB_USER;
    if (!database || !user || (!socketPath && !host)) throw new Error('Apply requires explicit database target/user via environment; no implicit production defaults.');
    // Reserve receipt output before opening a write-capable database connection.
    const output = await open(path, 'wx', 0o600);
    let connection;
    try {
        connection = await mysql.createConnection({ socketPath, host, user, database,
            password: process.env.BENCHPOLL_DB_PASSWORD, charset: 'utf8mb4', dateStrings: true, supportBigNumbers: true });
        const persistReceipt = async value => {
            const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
            for (let offset = 0; offset < bytes.length;) {
                const { bytesWritten } = await output.write(bytes, offset, bytes.length - offset, offset);
                if (!bytesWritten) throw new Error('Receipt write made no progress.');
                offset += bytesWritten;
            }
            await output.truncate(bytes.length); await output.sync();
        };
        const receipt = await action(connection, persistReceipt);
        await persistReceipt(receipt);
        console.log(JSON.stringify({ applied: receipt.applied, rolledBack: receipt.rolledBack,
            idempotent: receipt.idempotent, counts: receipt.counts }));
    } finally { await connection?.end(); await output.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
