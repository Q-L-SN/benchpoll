#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { normalizeScoreFields } from '../public/js/shared/score-fields.js';
import { SCALE_EXPORT_COLUMNS, readScaleState } from './capture-scale-state.mjs';
import { scaleVersion } from './scale-benchmark-catalogue.mjs';
import { resolveScaleModel } from './scale-model-identities.mjs';
import { nameKey, objectHash, stableJSON } from './scale-official-data.mjs';

export const SCALE_SOURCE_TITLE = 'Scale Labs official leaderboard';
const LOCK = 'benchpoll-scale-official-import';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const slug = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const providerDefinitions = {
    manus: { name: 'Manus', url: 'https://manus.im/' },
    'inception-ai': { name: 'Inception AI (Jais)', url: 'https://huggingface.co/inceptionai' },
    '01-ai': { name: '01.AI', url: 'https://huggingface.co/01-ai' },
    freedomintelligence: { name: 'FreedomIntelligence', url: 'https://huggingface.co/FreedomIntelligence' }
};

export function quantizeScaleScore(input) {
    const match = String(input).trim().match(/^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
    if (!match) throw new Error(`Invalid decimal score: ${input}`);
    const exponent = Number(match[4] ?? 0) - (match[3] ?? '').length + 6;
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) throw new Error('Decimal exponent out of range.');
    let units = BigInt(match[2] + (match[3] ?? ''));
    if (exponent >= 0) units *= 10n ** BigInt(exponent);
    else {
        const divisor = 10n ** BigInt(-exponent), remainder = units % divisor;
        units = units / divisor + (remainder * 2n >= divisor ? 1n : 0n);
    }
    if (units >= 10n ** 18n) throw new Error('Score does not fit DECIMAL(18,6).');
    const digits = units.toString().padStart(7, '0');
    return `${match[1] === '-' && units !== 0n ? '-' : ''}${digits.slice(0, -6)}.${digits.slice(-6)}`;
}

export function scaleFieldCatalog(state) {
    return state.tables.score_fields.filter(row => Number(row.is_active) === 1).map(row => ({
        ID: Number(row.ID), name: row.name, type: row.field_type, allowEmpty: Boolean(row.allow_empty),
        excludeMissing: Boolean(row.exclude_missing), excludeEmpty: Boolean(row.exclude_empty),
        options: state.tables.score_field_options.filter(o => Number(o.field_ID) === Number(row.ID) && Number(o.is_active) === 1)
            .map(o => ({ ID: Number(o.ID), label: o.label, excluded: Boolean(o.excluded) }))
    }));
}

export function scaleConfigurationFields(configuration, catalog) {
    const specifications = {
        reasoningEffort: ['Reasoning effort', 'enum'], reasoningMode: ['Reasoning mode', 'enum'],
        agentHarness: ['Agent harness', 'text'], configurationSelection: ['Configuration selection', 'text'],
        generationMode: ['Generation mode', 'text'], searchContextSize: ['Search context size', 'enum'],
        toolConfiguration: ['Tool configuration', 'text']
    };
    return normalizeScoreFields(Object.entries(configuration).map(([key, value]) => {
        const specification = specifications[key];
        if (!specification || typeof value !== 'string' || !value.trim()) throw new Error(`Invalid run field: ${key}`);
        const canonical = { reasoningEffort: 'effort', agentHarness: 'harness' }[key];
        const named = canonical ? catalog.filter(f => f.name.toLowerCase() === canonical) : [];
        const matches = named.length ? named : catalog.filter(f => f.name.toLowerCase() === specification[0].toLowerCase());
        if (matches.length !== 1 || matches[0].type !== specification[1] && !(key === 'agentHarness' && matches[0].type === 'enum')) throw new Error(`Missing/ambiguous field: ${specification[0]}`);
        const field = matches[0];
        if (field.type === 'enum') {
            const options = field.options.filter(o => o.label.toLowerCase() === value.toLowerCase());
            if (options.length !== 1) throw new Error(`Missing/ambiguous ${field.name} option: ${value}`);
            return { fieldID: field.ID, value: options[0].ID };
        }
        return { fieldID: field.ID, value };
    }), catalog);
}

function parsedNotes(row) {
    try { const value = json(row.notes); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch {}
    return row.notes ? { previous_notes: row.notes } : {};
}
function trustedURL(url, record = false) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
        || !['labs.scale.com', 'static.scale.com', 'rsi-benchmark.com'].includes(parsed.hostname)) throw new Error(`Nonofficial source URL: ${url}`);
    if (record && parsed.hostname === 'rsi-benchmark.com' && !/^\/(?:tasks|runs)\//.test(parsed.pathname)) throw new Error('RSI row lacks an official task/run source.');
}
export function validateScaleSnapshot(snapshot) {
    if (snapshot.schemaVersion !== 1 || snapshot.publisher !== 'Scale Labs' || !Number.isFinite(Date.parse(snapshot.collectedAt))
        || !Array.isArray(snapshot.records) || !snapshot.records.length || !Array.isArray(snapshot.versions)) throw new Error('Invalid Scale snapshot.');
    const keys = new Set();
    for (const version of snapshot.versions) {
        if (keys.has(version.key) || stableJSON(version) !== stableJSON(scaleVersion(version.key))) throw new Error(`Unreviewed metric definition: ${version.key}`);
        if (!version.name || version.name.length > 60 || !version.explanation || /snapshot|^v\d{4}\.\d{2}\.\d{2}$/i.test(version.name)) throw new Error('Invalid benchmark version name/explanation.');
        keys.add(version.key);
    }
    const actualCounts = {};
    for (const row of snapshot.records) {
        if (!keys.has(row.metricKey) || !row.record?.model || !Number.isFinite(row.record.score) || !row.boardID
            || !/^[a-f0-9]{64}$/.test(row.evidenceHash ?? '') || !Number.isFinite(Date.parse(row.fetchedAt))) throw new Error('Incomplete score evidence.');
        trustedURL(row.sourceURL, true);
        const version = scaleVersion(row.metricKey), min = version.percentage ? 0 : version.min, max = version.percentage ? 100 : version.max;
        if (row.record.score < min || row.record.score > max || row.status !== (version.archived ? 'archived' : 'accepted')) throw new Error(`Invalid score/status: ${row.metricKey}`);
        actualCounts[row.metricKey] = (actualCounts[row.metricKey] ?? 0) + 1;
    }
    if (stableJSON(actualCounts) !== stableJSON(snapshot.sourceRows) || keys.size !== Object.keys(actualCounts).length) throw new Error('Incomplete source row inventory.');
    const entryIDs = snapshot.directoryEntries?.map(e => e.ID) ?? [];
    if (entryIDs.length !== 44 || new Set(snapshot.directoryEntries.map(e => stableJSON([e.ID, e.name]))).size !== 44) throw new Error('Scale directory inventory is incomplete.');
    for (const ID of entryIDs) if (!snapshot.records.some(row => row.boardID === ID)) throw new Error(`Missing complete directory board: ${ID}`);
}

function validateState(state) {
    if (state.schemaVersion !== 1 || !state.tables) throw new Error('Invalid database state.');
    for (const [table, columns] of Object.entries(SCALE_EXPORT_COLUMNS)) {
        const rows = state.tables[table];
        if (!Array.isArray(rows) || new Set(rows.map(row => Number(row.ID))).size !== rows.length) throw new Error(`Invalid database table: ${table}`);
        if (state.tables.engines?.find(row => row.table === table)?.engine !== 'InnoDB') throw new Error(`Nontransactional database table: ${table}`);
        for (const column of columns) if (!state.tables.columns?.some(c => c.table === table && c.column === column)) throw new Error(`Missing schema: ${table}.${column}`);
    }
    if (state.tables.columns.find(c => c.table === 'benchmark_results' && c.column === 'raw_score')?.type !== 'decimal(18,6)'
        || state.tables.columns.find(c => c.table === 'benchmark_results' && c.column === 'score_fields')?.type !== 'json') throw new Error('Score schema differs from the reviewed importer.');
}

export function buildScalePlan(snapshot, state, snapshotHash) {
    validateScaleSnapshot(snapshot); validateState(state);
    if (!/^[a-f0-9]{64}$/.test(snapshotHash)) throw new Error('Snapshot hash required.');
    const tables = state.tables, catalog = scaleFieldCatalog(state);
    const plan = { schemaVersion: 1, kind: 'scale-official-import-plan', snapshotHash,
        stateHash: objectHash(tables), creates: { organizations: [], models: [], benchmarks: [], conditions: [] },
        updates: { models: [], benchmarks: [], conditions: [] }, rows: [], duplicates: [], cleanup: [], blockers: [], warnings: snapshot.warnings ?? [] };
    const block = (code, detail) => plan.blockers.push({ code, detail });
    const organizationRefs = new Map(tables.organizations.map(o => [o.slug, Number(o.ID)]));
    const modelRefs = new Map(), benchmarkRefs = new Map(), versions = new Map();
    for (const version of snapshot.versions) {
        if (!benchmarkRefs.has(version.benchmark)) {
            const matches = version.benchmarkID ? tables.benchmarks.filter(b => Number(b.ID) === version.benchmarkID)
                : tables.benchmarks.filter(b => nameKey(b.name) === nameKey(version.benchmark));
            if (matches.length > 1 || (version.benchmarkID && matches.length !== 1)) { block('ambiguous_benchmark', version.benchmark); continue; }
            let ref;
            if (matches.length) {
                const existing = matches[0]; ref = Number(existing.ID);
                if (version.benchmarkID && nameKey(existing.name) !== nameKey(version.benchmark)) { block('benchmark_identity_changed', version); continue; }
                if (!Number(existing.is_active) && snapshot.versions.some(v => v.benchmark === version.benchmark && !v.archived)) {
                    plan.updates.benchmarks.push({ ID: ref, changes: { is_active: 1 } });
                }
                if (version.previousBenchmarkDescription && existing.description !== version.explanation) {
                    if (existing.description !== version.previousBenchmarkDescription || !parsedNotes(existing).scale_import) {
                        block('benchmark_description_correction_requires_review', existing.ID);
                    } else plan.updates.benchmarks.push({ ID: ref, changes: { description: version.explanation } });
                }
            } else {
                ref = `new:benchmark:${nameKey(version.benchmark)}`;
                const first = snapshot.records.find(r => r.metricKey === version.key);
                plan.creates.benchmarks.push({ ref, name: version.benchmark, introduction_url: first.sourceURL,
                    is_active: version.archived ? 0 : 1, description: version.explanation,
                    notes: JSON.stringify({ scale_import: true, source: first.sourceURL }) });
            }
            benchmarkRefs.set(version.benchmark, ref);
        }
        const benchmarkRef = benchmarkRefs.get(version.benchmark), conditionKey = `scale-${slug(version.key)}`;
        const matches = version.conditionID ? tables.benchmark_conditions.filter(c => Number(c.ID) === version.conditionID)
            : tables.benchmark_conditions.filter(c => Number(c.benchmark_ID) === benchmarkRef && c.condition_key === conditionKey);
        if (matches.length > 1 || (version.conditionID && matches.length !== 1)) { block('ambiguous_version', version.key); continue; }
        const numeric = v => v == null ? null : quantizeScaleScore(v);
        const expected = { score_direction: version.direction, target_value: null, uses_percentage_scale: version.percentage ? 1 : 0,
            score_min: numeric(version.min), score_max: numeric(version.max) };
        let ref;
        if (matches.length) {
            const existing = matches[0]; ref = Number(existing.ID);
            if (Number(existing.benchmark_ID) !== benchmarkRef || existing.deleted_at
                || Object.entries(expected).some(([key, value]) => key === 'score_min' || key === 'score_max'
                    ? numeric(existing[key]) !== value : existing[key] !== value)) { block('incompatible_existing_version', { key: version.key, existing, expected }); continue; }
            const changes = {};
            const literalDefault = String(existing.name).trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US') === 'default';
            if (Boolean(Number(existing.is_default)) !== literalDefault || (existing.condition_key === 'default') !== literalDefault) {
                if (!literalDefault && existing.score_source === 'scale-labs' && existing.condition_key === conditionKey) {
                    changes.is_default = 0;
                } else block('version_default_invariant_requires_review', existing.ID);
            }
            if (existing.difference_explanation !== version.explanation) changes.difference_explanation = version.explanation;
            if (version.previousName && existing.name !== version.name) {
                if (existing.name !== version.previousName || existing.score_source !== 'scale-labs' || existing.condition_key !== conditionKey) {
                    block('version_name_correction_requires_review', existing.ID);
                } else changes.name = version.name;
            }
            if (Object.keys(changes).length) plan.updates.conditions.push({ ID: ref, changes });
        } else {
            ref = `new:version:${version.key}`;
            const hasPrimary = tables.benchmark_conditions.some(c => Number(c.benchmark_ID) === benchmarkRef && !c.deleted_at && Number(c.is_primary))
                || plan.creates.conditions.some(c => c.benchmarkRef === benchmarkRef && c.is_primary);
            plan.creates.conditions.push({ ref, benchmarkRef, condition_key: conditionKey, name: version.name, ...expected,
                is_default: 0, is_primary: hasPrimary ? 0 : 1,
                score_source: 'scale-labs', difference_explanation: version.explanation });
        }
        versions.set(version.key, { ref, benchmarkRef, version });
    }
    const sourceRows = new Map();
    for (const source of snapshot.records) {
        try {
            const metric = versions.get(source.metricKey);
            if (!metric) continue;
            const identity = resolveScaleModel(source.record, source.boardID, state), configuration = { ...identity.configuration };
            for (const [key, value] of Object.entries(source.configuration ?? {})) {
                if (configuration[key] !== undefined && configuration[key] !== value) throw new Error(`Conflicting explicit score field: ${key}`);
                configuration[key] = value;
            }
            const fields = scaleConfigurationFields(configuration, catalog);
            const identityKey = `${identity.vendorSlug}:${nameKey(identity.baseName)}`;
            if (!modelRefs.has(identityKey)) {
                let ref = identity.existingID == null ? null : Number(identity.existingID);
                if (ref === null) {
                    let organizationRef = organizationRefs.get(identity.vendorSlug);
                    if (!organizationRef) {
                        const definition = providerDefinitions[identity.vendorSlug];
                        if (!definition) throw new Error(`Unreviewed new provider: ${identity.vendorSlug}`);
                        organizationRef = `new:organization:${identity.vendorSlug}`;
                        organizationRefs.set(identity.vendorSlug, organizationRef);
                        plan.creates.organizations.push({ ref: organizationRef, slug: identity.vendorSlug, name: definition.name,
                            introduction_url: definition.url, is_active: 1, is_model_vendor: 1 });
                    }
                    ref = `new:model:${identityKey}`;
                    let modelSlug = slug(`${identity.vendorSlug}-${identity.baseName}`);
                    if (modelSlug.length > 128) modelSlug = `${modelSlug.slice(0, 110)}-${objectHash(identityKey).slice(0, 12)}`;
                    if (tables.models.some(m => m.slug === modelSlug)) modelSlug = `scale-${modelSlug}`;
                    if (modelSlug.length > 128 || tables.models.some(m => m.slug === modelSlug)) throw new Error(`Model slug collision: ${modelSlug}`);
                    if (identity.baseName.length > 192) throw new Error('Model name too long.');
                    plan.creates.models.push({ ref, organizationRef, slug: modelSlug, name: identity.baseName, introduction_url: source.sourceURL,
                        is_active: 1, notes: JSON.stringify({ scale_import: true, publisher_name: source.record.model, identity_rule: identity.identityRule }) });
                } else if (!Number(tables.models.find(m => Number(m.ID) === ref).is_active)) {
                    if (!plan.updates.models.some(m => m.ID === ref)) plan.updates.models.push({ ID: ref, changes: { is_active: 1 } });
                }
                modelRefs.set(identityKey, ref);
            }
            const key = objectHash([source.metricKey, identityKey, configuration, source.measurementID ?? null]);
            const rawScore = quantizeScaleScore(source.record.score), evidence = { ...source };
            const previous = sourceRows.get(key);
            if (previous) {
                if (previous.rawScore !== rawScore || previous.status !== source.status) throw new Error(`Conflicting rows for one published run: ${source.metricKey} ${source.record.model}`);
                previous.evidence.push(evidence); plan.duplicates.push({ key, metricKey: source.metricKey, model: source.record.model }); continue;
            }
            sourceRows.set(key, { key, metricKey: source.metricKey, modelRef: modelRefs.get(identityKey), modelName: identity.baseName,
                identityKey, benchmarkRef: metric.benchmarkRef, conditionRef: metric.ref, rawScore, fields,
                configuration, status: source.status, sourceURL: source.sourceURL, evidence: [evidence] });
        } catch (error) { block('source_row_requires_review', { metricKey: source.metricKey, model: source.record.model, message: error.message }); }
    }
    const notesByID = new Map(tables.benchmark_results.map(row => [Number(row.ID), parsedNotes(row)]));
    const ownByKey = new Map(), legacyByCondition = new Map();
    for (const result of tables.benchmark_results) {
        const notes = notesByID.get(Number(result.ID));
        if (notes.scale_official_key) {
            const list = ownByKey.get(notes.scale_official_key) ?? []; list.push(result); ownByKey.set(notes.scale_official_key, list);
        } else if (result.submitted_by == null && ((notes.official_import_key && notes.official_model_name)
            || (notes.post_astra_import?.nativeID?.startsWith('scale:') && notes.sourceDetails?.sourceRow?.name))) {
            const list = legacyByCondition.get(Number(result.benchmark_condition_ID)) ?? [];
            list.push(result); legacyByCondition.set(Number(result.benchmark_condition_ID), list);
        }
    }
    const usedLegacy = new Set();
    for (const row of sourceRows.values()) {
        const own = ownByKey.get(row.key) ?? [];
        if (own.length > 1) { block('duplicate_import_key', row.key); continue; }
        const sourceNames = new Set(row.evidence.map(e => nameKey(e.record.model)));
        const candidates = own.length ? own : (legacyByCondition.get(row.conditionRef) ?? []).filter(result => {
            const notes = notesByID.get(Number(result.ID));
            if (result.status !== row.status) return false;
            try {
                trustedURL(result.source_url);
                if (new URL(result.source_url).pathname !== new URL(row.sourceURL).pathname) return false;
                const publisherName = notes.official_model_name ?? notes.sourceDetails.sourceRow.name;
                return sourceNames.has(nameKey(publisherName));
            } catch { return false; }
        });
        candidates.sort((a, b) => {
            const quality = r => (Number(r.model_ID) === row.modelRef ? 4 : 0)
                + (stableJSON(normalizeScoreFields(r.score_fields, catalog)) === stableJSON(row.fields) ? 2 : 0)
                + (quantizeScaleScore(r.raw_score) === row.rawScore ? 1 : 0);
            return quality(b) - quality(a) || Number(a.ID) - Number(b.ID);
        });
        const existing = candidates[0];
        if (candidates.some(r => usedLegacy.has(Number(r.ID)))) { block('legacy_score_reused', candidates.map(r => r.ID)); continue; }
        for (const result of candidates) usedLegacy.add(Number(result.ID));
        for (const result of candidates.slice(1)) plan.cleanup.push({ ID: Number(result.ID), key: row.key, benchmarkRef: row.benchmarkRef,
            status: row.status === 'archived' ? 'archived' : 'superseded', notes: notesByID.get(Number(result.ID)) });
        const same = existing && quantizeScaleScore(existing.raw_score) === row.rawScore && Number(existing.model_ID) === row.modelRef
            && Number(existing.benchmark_ID) === row.benchmarkRef && Number(existing.benchmark_condition_ID) === row.conditionRef
            && existing.status === row.status && stableJSON(normalizeScoreFields(existing.score_fields, catalog)) === stableJSON(row.fields);
        const action = !existing ? 'insert' : same ? (own.length ? 'unchanged' : 'adopt')
            : own.length && existing.status === row.status ? 'replace' : 'adopt_replace';
        plan.rows.push({ ...row, action, existingID: existing ? Number(existing.ID) : null,
            previousNotes: existing ? notesByID.get(Number(existing.ID)) : {} });
    }
    const sourceCount = plan.rows.length + plan.duplicates.length;
    if (sourceCount !== snapshot.records.length && !plan.blockers.length) block('incomplete_import_plan', { sourceCount, expected: snapshot.records.length });
    plan.counts = { sourceRows: snapshot.records.length, uniqueScores: plan.rows.length, sourceDuplicates: plan.duplicates.length,
        supersededDuplicates: plan.cleanup.length,
        ...Object.fromEntries(['insert', 'adopt', 'replace', 'adopt_replace', 'unchanged'].map(action => [action, plan.rows.filter(row => row.action === action).length])),
        ...Object.fromEntries(Object.entries(plan.creates).map(([table, rows]) => [`new_${table}`, rows.length])) };
    plan.canApply = plan.blockers.length === 0;
    return plan;
}

async function writeDurable(path, value) {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    await mkdir(dirname(resolve(path)), { recursive: true });
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    if (sha256(await readFile(path)) !== sha256(bytes)) throw new Error('Durable output read-back failed.');
    return sha256(bytes);
}
function conditionSnapshot(condition, benchmarkID) {
    return { conditionID: Number(condition.ID), benchmarkID, name: condition.name, scoreDirection: condition.score_direction,
        targetValue: condition.target_value, usesPercentageScale: Boolean(Number(condition.uses_percentage_scale)),
        scoreMin: condition.score_min, scoreMax: condition.score_max };
}

export async function applyScalePlan(connection, { snapshot, snapshotHash, approvedPlan, approvedPlanHash, backupPath,
    persistReceipt, readState = readScaleState, backup = writeDurable }) {
    if (!approvedPlan.canApply || approvedPlan.blockers?.length || approvedPlan.kind !== 'scale-official-import-plan'
        || approvedPlan.snapshotHash !== snapshotHash) throw new Error('Matching, unblocked reviewed plan required.');
    let locked = false;
    try {
        const [[lock]] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [LOCK]);
        if (Number(lock.acquired) !== 1) throw new Error('Could not acquire Scale import lock.');
        locked = true;
        await connection.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'); await connection.beginTransaction();
        const state = await readState(connection), plan = buildScalePlan(snapshot, state, snapshotHash);
        if (!plan.canApply || objectHash(plan) !== objectHash(approvedPlan)) throw new Error('Database changed after review; generate a fresh plan.');
        const backupHash = await backup(backupPath, { schemaVersion: 1, kind: 'scale-official-backup', approvedPlanHash, snapshotHash, state });
        const refs = new Map(), mutations = [], created = {};
        const lookup = ref => typeof ref === 'number' ? ref : refs.get(ref) ?? (() => { throw new Error(`Missing inserted reference: ${ref}`); })();
        const insert = async (table, values, ref) => {
            const [result] = await connection.execute(`INSERT INTO \`${table}\` (${Object.keys(values).map(k => `\`${k}\``).join(',')}) VALUES (${Object.keys(values).map(() => '?').join(',')})`, Object.values(values));
            const ID = Number(result.insertId); if (!Number.isSafeInteger(ID) || ID < 1) throw new Error('Unsafe inserted ID.');
            refs.set(ref, ID); (created[table] ??= []).push(ID); mutations.push({ table, ID, before: null, inserted: values }); return ID;
        };
        const update = async (table, ID, changes) => {
            const before = state.tables[table].find(r => Number(r.ID) === ID);
            if (!before) throw new Error('Update target absent from backup.');
            const [result] = await connection.execute(`UPDATE \`${table}\` SET ${Object.keys(changes).map(k => `\`${k}\`=?`).join(',')} WHERE ID=?`, [...Object.values(changes), ID]);
            if (result.affectedRows !== 1) throw new Error('Update did not affect one row.');
            mutations.push({ table, ID, before, changes });
        };
        for (const row of plan.creates.organizations) { const { ref, ...values } = row; await insert('organizations', values, ref); }
        for (const row of plan.creates.models) { const { ref, organizationRef, ...values } = row; await insert('models', { ...values, vendor_ID: lookup(organizationRef) }, ref); }
        for (const row of plan.creates.benchmarks) { const { ref, ...values } = row; await insert('benchmarks', values, ref); }
        for (const row of plan.creates.conditions) { const { ref, benchmarkRef, ...values } = row; await insert('benchmark_conditions', { ...values, benchmark_ID: lookup(benchmarkRef) }, ref); }
        for (const [table, rows] of Object.entries(plan.updates)) for (const row of rows) await update(table === 'conditions' ? 'benchmark_conditions' : table, row.ID, row.changes);
        const conditions = new Map(state.tables.benchmark_conditions.map(c => [Number(c.ID), c]));
        for (const row of plan.creates.conditions) conditions.set(lookup(row.ref), { ...row, ID: lookup(row.ref) });
        const scoreChanges = new Set();
        for (const row of plan.cleanup) {
            await update('benchmark_results', row.ID, { status: row.status, notes: JSON.stringify({ ...row.notes,
                scale_duplicate_of_key: row.key, scale_deduplicated_by_snapshot: snapshotHash }) });
            scoreChanges.add(lookup(row.benchmarkRef));
        }
        for (const row of plan.rows.filter(row => row.action !== 'unchanged')) {
            const benchmarkID = lookup(row.benchmarkRef), conditionID = lookup(row.conditionRef), modelID = lookup(row.modelRef);
            const notes = JSON.stringify({ ...row.previousNotes, scale_official_key: row.key, scale_metric_key: row.metricKey,
                scale_run_configuration: row.configuration, scale_publisher_evidence: row.evidence,
                scale_snapshot_sha256: snapshotHash, scale_storage: { rule: 'ROUND_HALF_UP', decimal_places: 6, exact_source_value: String(row.evidence[0].record.score) } });
            if (row.action === 'adopt') {
                await update('benchmark_results', row.existingID, { notes }); continue;
            }
            if (row.action === 'replace' || row.action === 'adopt_replace') await update('benchmark_results', row.existingID, { status: row.status === 'archived' ? 'archived' : 'superseded',
                notes: JSON.stringify({ ...row.previousNotes, scale_superseded_key: row.key, scale_superseded_by_snapshot: snapshotHash, scale_official_key: undefined }) });
            const values = { model_ID: modelID, benchmark_ID: benchmarkID, benchmark_condition_ID: conditionID, raw_score: row.rawScore,
                source_url: row.sourceURL, source_type: 'third_party_lab', source_title: SCALE_SOURCE_TITLE,
                benchmark_condition_snapshot: JSON.stringify(conditionSnapshot(conditions.get(conditionID), benchmarkID)), status: row.status, notes,
                score_fields: JSON.stringify(row.fields), accepted_at: new Date().toISOString().slice(0, 19).replace('T', ' ') };
            await insert('benchmark_results', values, `score:${row.key}`); scoreChanges.add(benchmarkID);
        }
        const [[clock]] = await connection.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%d %H:%i:%s.%f') AS stamp");
        for (const ID of scoreChanges) {
            if (state.tables.benchmarks.some(b => Number(b.ID) === ID)) await update('benchmarks', ID, { scores_updated_at: clock.stamp });
            else {
                await connection.execute('UPDATE benchmarks SET scores_updated_at=? WHERE ID=?', [clock.stamp, ID]);
                mutations.push({ table: 'benchmarks', ID, changes: { scores_updated_at: clock.stamp }, created: true });
            }
        }
        const after = await readState(connection), verification = buildScalePlan(snapshot, after, snapshotHash);
        if (!verification.canApply || verification.rows.some(r => r.action !== 'unchanged')
            || Object.values(verification.creates).some(rows => rows.length) || Object.values(verification.updates).some(rows => rows.length)) throw new Error('Post-write idempotency verification failed.');
        for (const mutation of mutations) mutation.after = after.tables[mutation.table].find(r => Number(r.ID) === mutation.ID);
        const touched = new Set(mutations.map(m => `${m.table}:${m.ID}`));
        for (const [table, rows] of Object.entries(state.tables).filter(([name]) => Object.hasOwn(SCALE_EXPORT_COLUMNS, name))) {
            const afterRows = new Map(after.tables[table].map(r => [Number(r.ID), r]));
            for (const before of rows) if (!touched.has(`${table}:${before.ID}`)
                && stableJSON(before) !== stableJSON(afterRows.get(Number(before.ID)))) throw new Error(`Unrelated database row changed: ${table} ${before.ID}`);
        }
        const receipt = { schemaVersion: 1, kind: 'scale-official-import-receipt', transactionState: 'prepared-for-commit',
            approvedPlanHash, snapshotHash, backupHash, backupPath, counts: plan.counts, created, mutations,
            verified: true, verifiedScoreCount: verification.rows.length, committedAt: clock.stamp };
        await persistReceipt(receipt); await connection.commit();
        return { ...receipt, transactionState: 'committed' };
    } catch (error) { await connection.rollback(); throw error; }
    finally { if (locked) await connection.query('SELECT RELEASE_LOCK(?)', [LOCK]); }
}

async function connectionFromEnvironment() {
    const { BENCHPOLL_DB_SOCKET: socketPath, BENCHPOLL_DB_HOST: host, BENCHPOLL_DB_USER: user, BENCHPOLL_DB_NAME: database } = process.env;
    if (!user || !database || (!socketPath && !host)) throw new Error('Explicit database target/user required.');
    return mysql.createConnection({ socketPath, host, user, database, password: process.env.BENCHPOLL_DB_PASSWORD, charset: 'utf8mb4', dateStrings: true });
}
async function main() {
    const args = {};
    for (const item of process.argv.slice(2)) {
        const [key, ...value] = item.split('=');
        if (!['--snapshot', '--state', '--output', '--local-db', '--apply', '--reviewed-plan', '--expect-plan-sha256', '--backup'].includes(key)
            || Object.hasOwn(args, key)) throw new Error(`Invalid argument: ${key}`);
        args[key] = value.length ? value.join('=') : true;
    }
    if (typeof args['--snapshot'] !== 'string' || typeof args['--output'] !== 'string') throw new Error('Use --snapshot=<file> --output=<new plan or receipt>.');
    const bytes = await readFile(args['--snapshot']), snapshot = JSON.parse(bytes.toString('utf8')), snapshotHash = sha256(bytes);
    validateScaleSnapshot(snapshot);
    if (!args['--apply']) {
        let state, connection;
        if (args['--state']) state = JSON.parse(await readFile(args['--state'], 'utf8'));
        else if (args['--local-db']) {
            connection = await connectionFromEnvironment();
            try { await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'); state = await readScaleState(connection); }
            finally { await connection.rollback(); await connection.end(); }
        } else throw new Error('Plan requires --state=<export> or --local-db.');
        const plan = buildScalePlan(snapshot, state, snapshotHash), planHash = await writeDurable(args['--output'], plan);
        console.log(JSON.stringify({ canApply: plan.canApply, counts: plan.counts, blockers: plan.blockers, planHash }));
        if (!plan.canApply) process.exitCode = 2; return;
    }
    if (args['--state'] || !args['--reviewed-plan'] || !/^[a-f0-9]{64}$/.test(args['--expect-plan-sha256'] ?? '') || typeof args['--backup'] !== 'string') throw new Error('Apply requires reviewed plan/hash and a new backup path, never offline state.');
    const approvedBytes = await readFile(args['--reviewed-plan']);
    if (sha256(approvedBytes) !== args['--expect-plan-sha256']) throw new Error('Reviewed plan file hash changed.');
    const output = await open(args['--output'], 'wx', 0o600); let connection;
    const persistReceipt = async value => {
        const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
        for (let offset = 0; offset < bytes.length;) {
            const { bytesWritten } = await output.write(bytes, offset, bytes.length - offset, offset);
            if (!bytesWritten) throw new Error('Receipt persistence stalled.'); offset += bytesWritten;
        }
        await output.truncate(bytes.length); await output.sync();
    };
    try {
        connection = await connectionFromEnvironment();
        const receipt = await applyScalePlan(connection, { snapshot, snapshotHash, approvedPlan: JSON.parse(approvedBytes),
            approvedPlanHash: sha256(approvedBytes), backupPath: args['--backup'], persistReceipt });
        await persistReceipt(receipt);
        console.log(JSON.stringify({ transactionState: receipt.transactionState, counts: receipt.counts, verified: receipt.verified, verifiedScoreCount: receipt.verifiedScoreCount }));
    } finally { await connection?.end(); await output.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
