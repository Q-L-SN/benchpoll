#!/usr/bin/env node

import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { primaryFlagForNewCondition } from '../benchmark-primary-condition.js';

const SOURCE_TITLE = 'Artificial Analysis current public leaderboard';
const IMPORT_LOCK = 'benchpoll-aa-current-import';
const METRICS = {
    intelligenceIndex: {
        route: 'artificial-analysis-intelligence-index',
        benchmark: 'Artificial Analysis Intelligence Index v4.3.2',
        conditionKey: 'default', conditionName: 'default', isDefault: true,
        percentage: false, min: 0, max: 100
    },
    briefcaseElo: {
        route: 'aa-briefcase', benchmark: 'AA-Briefcase v1.1',
        conditionKey: 'default', conditionName: 'default', isDefault: true,
        percentage: false, min: 0, max: 2400
    },
    gdpval: {
        route: 'gdpval-aa', benchmark: 'GDPval-AA v2.1',
        conditionKey: 'default', conditionName: 'default', isDefault: true,
        percentage: false, min: 0, max: 2400
    },
    automationBenchPartialScore: {
        route: 'automationbench-aa', benchmark: 'automationbench-aa', benchmarkID: 1855,
        conditionKey: 'aa-official-score', conditionName: 'AA Score', percentage: true
    },
    apexAgents: {
        route: 'apex-agents-aa', benchmark: 'APEX-Agents-AA',
        conditionKey: 'aa-official-score', conditionName: 'AA Score', percentage: true,
        minScoredModels: 1
    },
    terminalBench40: {
        route: 'terminalbench-4-0', benchmark: 'Terminal-Bench 4.0', benchmarkID: 1125,
        conditionKey: 'aa-official-score-v4', conditionName: 'AA Score', percentage: true
    },
    terminalbenchHard: {
        route: 'terminalbench-hard', benchmark: 'Terminal-Bench Hard', benchmarkID: 1539,
        conditionKey: 'aa-official-score', conditionName: 'AA Score', percentage: true,
        minScoredModels: 1
    },
    scicode: {
        route: 'scicode', benchmark: 'SciCode', benchmarkID: 1334,
        conditionKey: 'aa-official-score', conditionName: 'AA Score', percentage: true
    },
    hle: {
        route: 'humanitys-last-exam', benchmark: "Humanity's Last Exam", benchmarkID: 1687,
        conditionKey: 'aa-official-score', conditionName: 'AA Score', percentage: true
    },
    gdpPdfAllPass: {
        route: 'gdp-pdf', benchmark: 'gdp-pdf', benchmarkID: 1795,
        conditionKey: 'aa-official-all-pass', conditionName: 'AA All-pass', percentage: true
    },
    critpt: {
        route: 'critpt', benchmark: 'CritPt', benchmarkID: 2034,
        conditionKey: 'aa-official-score', conditionName: 'AA Score', percentage: true
    },
    omniscience: {
        route: 'omniscience', benchmark: 'AA-Omniscience', benchmarkID: 1722,
        conditionKey: 'aa-official-index', conditionName: 'AA Index',
        percentage: false, min: -100, max: 100
    },
    lcr: {
        route: 'artificial-analysis-long-context-reasoning',
        benchmark: 'AA-LCR v1.1', benchmarkID: 1272,
        conditionKey: 'aa-official-score-v1-1', conditionName: 'AA Score', percentage: true
    }
};
const CREATOR_ORGANIZATIONS = {
    Anthropic: 'Anthropic', OpenAI: 'OpenAI', DeepSeek: 'DeepSeek', Google: 'Google',
    'Z AI': 'Zhipu AI', SpaceXAI: 'xAI', 'Thinking Machines': 'Thinking Machines',
    Kimi: 'Moonshot AI', Xiaomi: 'Xiaomi', Meta: 'Meta', MiniMax: 'MiniMax',
    Mistral: 'Mistral AI', NVIDIA: 'NVIDIA', Alibaba: 'Alibaba Qwen',
    StepFun: 'StepFun', 'Institute of Foundation Models': 'Institute of Foundation Models'
};
const CREATOR_PREFIXES = {
    Anthropic: 'anthropic', OpenAI: 'openai', DeepSeek: 'deepseek', Google: 'google',
    'Z AI': 'z-ai', SpaceXAI: 'x-ai', 'Thinking Machines': 'thinkingmachines',
    Kimi: 'moonshotai', Xiaomi: 'xiaomi', Meta: 'meta', MiniMax: 'minimax',
    Mistral: 'mistralai', NVIDIA: 'nvidia', Alibaba: 'qwen', StepFun: 'stepfun',
    'Institute of Foundation Models': 'ifm'
};
const MODEL_SLUG_OVERRIDES = {
    'mimo-v2-6-pro': 'arena-xiaomi-mimov26pro-h',
    'muse-glimmer': 'arena-meta-museglimmer-g',
    'nvidia-nemotron-3-ultra-550b-a55b': 'nvidia-nemotron-3-ultra-550b-a55b',
    'qwen3-8-max': 'qwen-qwen3-8-max-0902',
    'step-5': 'stepfun-step-5-preview',
    'k2-horizon-375b-a23b': 'ifm-k2-horizon-375b-a23b'
};
const CREATE_MODEL_NAMES = {
    'step-5': 'Step 5 Preview',
    'k2-horizon-375b-a23b': 'K2 Horizon 375B A23B'
};
const EFFORTS = new Set(['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none', 'ultra']);

const args = process.argv.slice(2);
const option = name => args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const APPLY = args.includes('--apply');
const snapshotPath = option('--snapshot');
const expectedHash = option('--expect-sha256');
const expectedCount = Number(option('--expect-score-count'));
const backupPath = option('--backup-path');
if (!snapshotPath || args.some(arg => !arg.startsWith('--snapshot=')
    && !arg.startsWith('--expect-sha256=') && !arg.startsWith('--expect-score-count=')
    && !arg.startsWith('--backup-path=') && arg !== '--apply')) {
    throw new Error('Usage: --snapshot=<file> [--apply --expect-sha256=<hash> --expect-score-count=<n> --backup-path=<file>]');
}
if (APPLY && (!expectedHash || !Number.isSafeInteger(expectedCount) || expectedCount < 1
    || !backupPath)) {
    throw new Error('Apply requires a snapshot hash, expected score count and backup path.');
}

function databaseConfig() {
    const password = process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD;
    if (password === undefined && !process.env.BENCHPOLL_DB_SOCKET) {
        throw new Error('Database credentials are unavailable.');
    }
    return {
        socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
        host: process.env.BENCHPOLL_DB_HOST || 'localhost',
        port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
        user: process.env.BENCHPOLL_DB_USER || 'root',
        password,
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks',
        dateStrings: true,
        charset: 'utf8mb4'
    };
}

function asJSON(value) {
    return typeof value === 'string' ? JSON.parse(value) : value;
}

function canonicalScoreFields(value) {
    const fields = asJSON(value);
    if (!Array.isArray(fields)) throw new Error('Score fields are not an array.');
    return JSON.stringify(fields.map(field => [Number(field.fieldID), field.value])
        .sort((left, right) => left[0] - right[0]));
}

function baseSlug(slug) {
    return slug.replace(/-(xhigh|high|medium|low)$/, '');
}

function modelDatabaseSlug(model) {
    const base = baseSlug(model.slug);
    const prefix = CREATOR_PREFIXES[model.creator];
    if (!prefix) throw new Error(`Unrecognized AA creator ${model.creator}.`);
    return MODEL_SLUG_OVERRIDES[base] ?? `${prefix}-${base}`;
}

function rawScore(metric, value) {
    const config = METRICS[metric];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Invalid ${metric} score.`);
    }
    if (config.percentage && (value < 0 || value > 1)) {
        throw new Error(`${metric} is not a fraction in [0,1].`);
    }
    if (!config.percentage && (value < config.min || value > config.max)) {
        throw new Error(`${metric} is outside its audited score range.`);
    }
    return (value * (config.percentage ? 100 : 1)).toFixed(6);
}

function validateSnapshot(snapshot) {
    for (const config of Object.values(METRICS)) {
        const isDefault = Boolean(config.isDefault);
        if (isDefault !== (config.conditionName === 'default')
            || isDefault !== (config.conditionKey === 'default')) {
            throw new Error(`Invalid default-condition contract for ${config.benchmark}.`);
        }
    }
    if (snapshot.schemaVersion !== 1 || snapshot.indexVersion !== 'v4.3.2'
        || !Array.isArray(snapshot.sources) || !Array.isArray(snapshot.models)
        || snapshot.sources.length !== Object.keys(METRICS).length) {
        throw new Error('Snapshot schema or Index version differs from the audited format.');
    }
    const age = Date.now() - Date.parse(snapshot.fetchedAt);
    if (!Number.isFinite(age) || age < 0 || age > 24 * 60 * 60 * 1000) {
        throw new Error('Snapshot is stale or has an invalid collection time.');
    }
    const sourceByMetric = new Map(snapshot.sources.map(source => [source.metric, source]));
    if (sourceByMetric.size !== snapshot.sources.length) throw new Error('Duplicate source metric.');
    for (const [metric, config] of Object.entries(METRICS)) {
        const source = sourceByMetric.get(metric);
        if (!source || source.url !== `https://artificialanalysis.ai/evaluations/${config.route}`
            || !source.heading || source.scoredModels < (config.minScoredModels ?? 10)) {
            throw new Error(`Unrecognized source for ${metric}.`);
        }
    }
    const seen = new Set();
    let scoreCount = 0;
    for (const model of snapshot.models) {
        if (!model.slug || seen.has(model.slug) || !model.name
            || !CREATOR_ORGANIZATIONS[model.creator] || !model.scores) {
            throw new Error(`Invalid or duplicate AA model ${model.slug}.`);
        }
        seen.add(model.slug);
        for (const [metric, score] of Object.entries(model.scores)) {
            const source = sourceByMetric.get(metric);
            if (!source || score.sourceURL !== source.url) {
                throw new Error(`Invalid source for ${model.slug}/${metric}.`);
            }
            rawScore(metric, score.value);
            scoreCount += 1;
        }
    }
    for (const source of snapshot.sources) {
        const count = snapshot.models.filter(model => model.scores[source.metric]).length;
        if (count !== source.scoredModels) {
            throw new Error(`Score count differs from ${source.metric} source summary.`);
        }
    }
    return scoreCount;
}

function scoreFields(name, options) {
    const detail = name.match(/\(([^()]*)\)$/)?.[1] ?? '';
    const fields = [];
    const fallback = detail.match(/(?:Default|Opus 4\.8) Fallback/i)?.[0];
    if (/Fallback/i.test(detail) && !fallback) {
        throw new Error(`Unknown fallback configuration in ${name}.`);
    }
    if (fallback) fields.push({ fieldID: 5, value: fallback });
    const effort = detail.match(/\b(max|xhigh|high|medium|low|minimal|none|ultra)(?:\s+effort)?\b/i)?.[1]?.toLowerCase();
    if (effort) {
        if (!EFFORTS.has(effort)) throw new Error(`Unknown reasoning effort in ${name}.`);
        fields.push({ fieldID: 20, value: options.get(`20:${effort}`) });
    }
    if (/Adaptive Reasoning/i.test(detail)) {
        fields.push({ fieldID: 22, value: options.get('22:adaptive') });
    } else if (/\bReasoning\b/i.test(detail)) {
        fields.push({ fieldID: 22, value: options.get('22:enabled') });
    }
    if (fields.some(field => field.value === undefined)) {
        throw new Error(`Missing score-field option for ${name}.`);
    }
    return fields;
}

async function run(connection, snapshot, apply) {
    const report = {
        dryRun: !apply, snapshotPath, snapshotHash,
        fetchedAt: snapshot.fetchedAt, modelCount: snapshot.models.length,
        scoreCount,
        newOrganizations: [], newModels: [], newBenchmarks: [], newConditions: [],
        insertedResults: 0, supersededResults: 0, unchangedResults: 0
    };
    const [organizations] = await connection.query(
        'SELECT ID, name, slug, is_active, is_model_vendor FROM organizations');
    const [models] = await connection.query(
        'SELECT ID, vendor_ID, slug, name, is_active FROM models');
    const [benchmarks] = await connection.query(
        'SELECT ID, name, introduction_url, is_active FROM benchmarks');
    const [conditions] = await connection.query(`SELECT ID, benchmark_ID, condition_key, name,
        score_direction, target_value, uses_percentage_scale, score_min, score_max,
        is_default, deleted_at FROM benchmark_conditions`);
    const [fields] = await connection.query(
        'SELECT ID, field_type, is_active FROM score_fields WHERE ID IN (5,20,22)');
    if (fields.length !== 3 || fields.some(field => Number(field.is_active) !== 1)
        || fields.find(field => Number(field.ID) === 5)?.field_type !== 'text'
        || fields.find(field => Number(field.ID) === 20)?.field_type !== 'enum'
        || fields.find(field => Number(field.ID) === 22)?.field_type !== 'enum') {
        throw new Error('The expected score-field schema is unavailable.');
    }
    const [optionRows] = await connection.query(`SELECT field_ID, ID, label
        FROM score_field_options WHERE field_ID IN (20,22) AND is_active = 1`);
    const options = new Map(optionRows.map(row =>
        [`${row.field_ID}:${row.label.toLowerCase()}`, Number(row.ID)]));
    const organizationByName = new Map(organizations.map(row => [row.name, row]));
    const modelBySlug = new Map(models.map(row => [row.slug, row]));
    const benchmarkByName = new Map(benchmarks.map(row => [row.name, row]));
    const conditionByKey = new Map(conditions.map(row =>
        [`${row.benchmark_ID}:${row.condition_key}`, row]));

    async function organizationFor(creator) {
        const name = CREATOR_ORGANIZATIONS[creator];
        let row = organizationByName.get(name);
        if (!row && creator !== 'Institute of Foundation Models') {
            throw new Error(`Missing existing organization ${name}.`);
        }
        if (!row) {
            if (organizations.some(item => item.slug === 'institute-of-foundation-models')) {
                throw new Error('Institute of Foundation Models slug is occupied.');
            }
            report.newOrganizations.push(name);
            if (apply) {
                const [created] = await connection.execute(`INSERT INTO organizations
                    (slug, name, is_model_vendor, is_active) VALUES (?, ?, 1, 1)`,
                ['institute-of-foundation-models', name]);
                row = { ID: created.insertId, name, slug: 'institute-of-foundation-models',
                    is_active: 1, is_model_vendor: 1 };
                organizationByName.set(name, row);
            }
        }
        if (row && (Number(row.is_active) !== 1 || Number(row.is_model_vendor) !== 1)) {
            throw new Error(`Organization ${name} cannot own an active model.`);
        }
        return row;
    }

    const modelIDs = new Map();
    const modelFields = new Map();
    for (const model of snapshot.models) {
        const base = baseSlug(model.slug);
        const slug = modelDatabaseSlug(model);
        const organization = await organizationFor(model.creator);
        let row = modelBySlug.get(slug);
        if (!row) {
            const newName = CREATE_MODEL_NAMES[base];
            if (!newName || model.name !== newName) {
                throw new Error(`Unmapped model ${model.slug}; refusing a guessed identity.`);
            }
            if (models.some(item => item.name.toLowerCase() === newName.toLowerCase()
                && Number(item.vendor_ID) === Number(organization?.ID))) {
                throw new Error(`A model named ${newName} already exists under another slug.`);
            }
            if (!report.newModels.includes(newName)) report.newModels.push(newName);
            if (apply) {
                const [created] = await connection.execute(`INSERT INTO models
                    (vendor_ID, slug, name, is_active) VALUES (?, ?, ?, 1)`,
                [organization.ID, slug, newName]);
                row = { ID: created.insertId, vendor_ID: organization.ID,
                    slug, name: newName, is_active: 1 };
                modelBySlug.set(slug, row);
            }
        }
        if (row && (Number(row.is_active) !== 1
            || Number(row.vendor_ID) !== Number(organization?.ID))) {
            throw new Error(`Model ${model.slug} maps to the wrong vendor or is inactive.`);
        }
        modelIDs.set(model.slug, row?.ID ?? null);
        modelFields.set(model.slug, scoreFields(model.name, options));
    }

    const conditionIDs = new Map();
    const conditionSnapshots = new Map();
    for (const [metric, config] of Object.entries(METRICS)) {
        let benchmark = benchmarkByName.get(config.benchmark);
        if (!benchmark) {
            if (config.benchmarkID) throw new Error(`Existing benchmark ${config.benchmark} is missing.`);
            report.newBenchmarks.push(config.benchmark);
            if (apply) {
                const [created] = await connection.execute(`INSERT INTO benchmarks
                    (name, introduction_url, is_active) VALUES (?, ?, 1)`,
                [config.benchmark, `https://artificialanalysis.ai/evaluations/${config.route}`]);
                benchmark = { ID: created.insertId, name: config.benchmark, is_active: 1,
                    introduction_url: `https://artificialanalysis.ai/evaluations/${config.route}` };
                benchmarkByName.set(config.benchmark, benchmark);
            }
        }
        if (benchmark && (Number(benchmark.is_active) !== 1
            || (config.benchmarkID && Number(benchmark.ID) !== config.benchmarkID)
            || (!config.benchmarkID && benchmark.introduction_url
                !== `https://artificialanalysis.ai/evaluations/${config.route}`))) {
            throw new Error(`Benchmark ${config.benchmark} differs from the audited mapping.`);
        }
        const key = `${benchmark?.ID}:${config.conditionKey}`;
        let condition = benchmark ? conditionByKey.get(key) : undefined;
        if (!condition) {
            report.newConditions.push(`${config.benchmark}: ${config.conditionName}`);
            if (apply) {
                const [created] = await connection.execute(`INSERT INTO benchmark_conditions
                    (benchmark_ID, condition_key, name, score_direction, target_value,
                     uses_percentage_scale, score_min, score_max, is_default, is_primary)
                    VALUES (?, ?, ?, 'higher', NULL, ?, ?, ?, ?, ?)`,
                [benchmark.ID, config.conditionKey, config.conditionName,
                    config.percentage ? 1 : 0, config.percentage ? null : config.min,
                    config.percentage ? null : config.max, config.isDefault ? 1 : 0,
                    await primaryFlagForNewCondition(connection, benchmark.ID)]);
                condition = { ID: created.insertId, benchmark_ID: benchmark.ID,
                    condition_key: config.conditionKey, name: config.conditionName,
                    score_direction: 'higher', target_value: null,
                    uses_percentage_scale: config.percentage ? 1 : 0,
                    score_min: config.percentage ? null : config.min,
                    score_max: config.percentage ? null : config.max,
                    is_default: config.isDefault ? 1 : 0, deleted_at: null };
                conditionByKey.set(key, condition);
            }
        }
        if (condition && (condition.deleted_at !== null
            || condition.name !== config.conditionName
            || condition.score_direction !== 'higher'
            || condition.target_value !== null
            || Number(condition.uses_percentage_scale) !== Number(Boolean(config.percentage))
            || Number(condition.is_default) !== Number(Boolean(config.isDefault))
            || (config.percentage
                ? condition.score_min !== null || condition.score_max !== null
                : Number(condition.score_min) !== config.min
                    || Number(condition.score_max) !== config.max))) {
            throw new Error(`Condition ${config.benchmark}/${config.conditionKey} differs from the audited metric.`);
        }
        conditionIDs.set(metric, condition?.ID ?? null);
        conditionSnapshots.set(metric, condition && benchmark ? {
            name: condition.name, scoreMax: config.percentage ? null : config.max,
            scoreMin: config.percentage ? null : config.min,
            benchmarkID: benchmark.ID, conditionID: condition.ID,
            targetValue: null, scoreDirection: 'higher',
            usesPercentageScale: Boolean(config.percentage)
        } : null);
    }

    const [previousRows] = await connection.execute(`SELECT ID, model_ID, benchmark_ID,
        benchmark_condition_ID, raw_score, source_url, status, score_fields, notes
        FROM benchmark_results WHERE source_title = ? FOR UPDATE`, [SOURCE_TITLE]);
    const previousByKey = new Map();
    for (const row of previousRows) {
        const key = asJSON(row.notes)?.aa_import_key;
        if (typeof key !== 'string') throw new Error(`Import result ${row.ID} lacks an audit key.`);
        const list = previousByKey.get(key) ?? [];
        list.push(row);
        previousByKey.set(key, list);
    }

    for (const model of snapshot.models) {
        for (const [metric, score] of Object.entries(model.scores)) {
            const key = `${model.slug}:${metric}`;
            const existing = previousByKey.get(key) ?? [];
            if (existing.some(row => row.status === 'archived')) {
                throw new Error(`Previously archived import ${key} requires manual review.`);
            }
            const accepted = existing.filter(row => row.status === 'accepted');
            if (accepted.length > 1) throw new Error(`Duplicate accepted import ${key}.`);
            const config = METRICS[metric];
            const benchmarkID = benchmarkByName.get(config.benchmark)?.ID ?? null;
            const conditionID = conditionIDs.get(metric);
            const modelID = modelIDs.get(model.slug);
            const raw = rawScore(metric, score.value);
            const scoreFieldsForModel = modelFields.get(model.slug);
            const fieldsJSON = JSON.stringify(scoreFieldsForModel);
            if (accepted.length) {
                const old = accepted[0];
                if (Number(old.model_ID) !== Number(modelID)
                    || Number(old.benchmark_ID) !== Number(benchmarkID)
                    || Number(old.benchmark_condition_ID) !== Number(conditionID)
                    || old.source_url !== score.sourceURL
                    || canonicalScoreFields(old.score_fields)
                        !== canonicalScoreFields(scoreFieldsForModel)) {
                    throw new Error(`Imported identity or configuration changed for ${key}.`);
                }
                if (Number(old.raw_score).toFixed(6) === raw) {
                    report.unchangedResults += 1;
                    continue;
                }
                report.supersededResults += 1;
                if (apply) {
                    const [updated] = await connection.execute(`UPDATE benchmark_results
                        SET status = 'superseded' WHERE ID = ? AND status = 'accepted'`, [old.ID]);
                    if (updated.affectedRows !== 1) throw new Error(`Could not supersede ${key}.`);
                }
            }
            report.insertedResults += 1;
            if (apply) {
                const notes = JSON.stringify({
                    aa_import_key: key, official_model_name: model.name,
                    official_model_slug: model.slug, official_metric: metric,
                    source_fetched_at: snapshot.fetchedAt,
                    source_index_version: snapshot.indexVersion
                });
                await connection.execute(`INSERT INTO benchmark_results
                    (model_ID, benchmark_ID, benchmark_condition_ID, raw_score,
                     source_url, source_type, source_title, benchmark_condition_snapshot,
                     status, notes, score_fields)
                    VALUES (?, ?, ?, ?, ?, 'third_party_lab', ?, ?, 'accepted', ?, ?)`,
                [modelID, benchmarkID, conditionID, raw, score.sourceURL,
                    SOURCE_TITLE, JSON.stringify(conditionSnapshots.get(metric)), notes, fieldsJSON]);
            }
        }
    }
    if (report.insertedResults + report.unchangedResults !== scoreCount) {
        throw new Error('The import plan does not account for every collected score.');
    }
    return report;
}

const snapshotBytes = await readFile(snapshotPath);
const snapshotHash = createHash('sha256').update(snapshotBytes).digest('hex');
const snapshot = JSON.parse(snapshotBytes.toString('utf8'));
const scoreCount = validateSnapshot(snapshot);
if (APPLY && (expectedHash !== snapshotHash || expectedCount !== scoreCount)) {
    throw new Error('The snapshot hash or score count differs from the approved input.');
}

const connection = await mysql.createConnection(databaseConfig());
try {
    const [[lock]] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [IMPORT_LOCK]);
    if (Number(lock.acquired) !== 1) throw new Error('Could not acquire AA import lock.');
    try {
        await connection.beginTransaction();
        try {
            const report = await run(connection, snapshot, APPLY);
            if (APPLY) await connection.commit();
            else await connection.rollback();
            console.log(JSON.stringify({ ...report, backupPath: APPLY ? backupPath : undefined }, null, 2));
        } catch (error) {
            await connection.rollback();
            throw error;
        }
    } finally {
        await connection.query('SELECT RELEASE_LOCK(?)', [IMPORT_LOCK]);
    }
} finally {
    await connection.end();
}
