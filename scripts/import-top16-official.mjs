#!/usr/bin/env node

import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { primaryFlagForNewCondition } from '../benchmark-primary-condition.js';

const SOURCE_TITLE = 'Official benchmark publisher snapshot';
const LOCK_NAME = 'benchpoll-top16-official-import';
const SOURCE_URLS = {
    'arc-agi-3': 'https://arcprize.org/leaderboard',
    'deepswe-v1.1': 'https://deepswe.datacurve.ai/',
    spatialviz: 'https://wangst0181.github.io/SpatialViz-Bench/',
    'agents-last-exam': 'https://agents-last-exam.org/leaderboard',
    'swe-bench-pro-public': 'https://labs.scale.com/leaderboard/swe_bench_pro',
    'terminal-bench-v4': 'https://www.tbench.ai/?version=4.0',
    'scale-hle-finalized': 'https://labs.scale.com/leaderboard/humanitys_last_exam',
    'scicode-official': 'https://scicode-bench.github.io/leaderboard/',
    'critpt-official': 'https://github.com/CritPt-Benchmark/CritPt/blob/main/README.md'
};
const METRICS = {
    'semi-private-v3': { benchmarkID: 1028, benchmark: 'ARC-AGI-3',
        key: 'official-v3-semi-private', name: 'Official v3 semi-private' },
    'v1.1-pass-at-1': { benchmarkID: 1786, benchmark: 'DeepSWE 1.1',
        key: 'official-v1-1-pass-at-1', name: 'v1.1 pass@1' },
    'v1.1-pass-at-4': { benchmarkID: 1786, benchmark: 'DeepSWE 1.1',
        key: 'official-v1-1-pass-at-4', name: 'v1.1 pass@4' },
    direct: { benchmark: 'SpatialViz', key: 'official-direct', name: 'Direct' },
    cot: { benchmark: 'SpatialViz', key: 'official-cot', name: 'Chain-of-thought' },
    overall: { benchmark: 'SpatialViz', key: 'official-reported-overall',
        name: 'Publisher-reported overall' },
    'ale-v1-pass-rate': { benchmarkID: 1454, benchmark: "Agents' Last Exam",
        key: 'official-ale-v1-pass-rate', name: 'ALE-V1 pass rate' },
    'ale-v1-partial-score': { benchmarkID: 1454, benchmark: "Agents' Last Exam",
        key: 'official-ale-v1-partial-score', name: 'ALE-V1 partial score' },
    'v1-public-resolve-rate': { benchmarkID: 2166, benchmark: 'SWE-Bench Pro',
        key: 'scale-v1-public-resolve-rate', name: 'Scale v1 public resolve rate' },
    'tbench-v4-resolve-rate': { benchmarkID: 1125, benchmark: 'Terminal-Bench 4.0',
        key: 'official-tbench-v4-resolve-rate', name: 'Official v4 resolve rate' },
    'scale-hle-finalized-public-accuracy': { benchmarkID: 1687, benchmark: "Humanity's Last Exam",
        key: 'scale-finalized-public-accuracy', name: 'Scale finalized public accuracy (2500 questions)' },
    'scicode-official-main': { benchmarkID: 1334, benchmark: 'SciCode',
        key: 'publisher-main-problem', name: 'Publisher main-problem resolve rate' },
    'scicode-official-subproblem': { benchmarkID: 1334, benchmark: 'SciCode',
        key: 'publisher-subproblem', name: 'Publisher subproblem resolve rate' },
    'critpt-official-challenge-accuracy': { benchmarkID: 2034, benchmark: 'CritPt',
        key: 'publisher-challenge-accuracy', name: 'Publisher challenge accuracy (5 runs)' }
};
const DEEP_PREFIXES = [
    [/^gpt-/, 'openai'], [/^gemini-/, 'google'], [/^claude-/, 'anthropic'],
    [/^glm-/, 'z-ai'], [/^kimi-/, 'moonshotai'], [/^grok-/, 'x-ai'],
    [/^qwen/, 'qwen'], [/^muse-/, 'meta'], [/^deepseek-/, 'deepseek']
];
const ALIASES = {
    'GPT-6 Astra': 'openai-gpt-6-astra',
    'Kimi K3': 'moonshotai-kimi-k3',
    'Muse Spark 1.3': 'meta-muse-spark-1-3',
    'Qwen-3-8-max': null,
    'Grok 4.5': 'x-ai-grok-4-5',
    'composer-2-5': 'cursor-composer-2-5',
    'seed-2.1-pro': 'bytedance-seed-2-1-pro',
    'gemini-3-1-pro': 'google-gemini-3-1-pro',
    'qwen3-7-max': 'qwen-qwen3-7-max',
    'mimo-v2-5': 'xiaomi-mimo-v2-5',
    'claude-opus-4-7': 'anthropic-claude-opus-4-7',
    'claude-opus-4-8': 'anthropic-claude-opus-4-8',
    'claude-opus-5': 'anthropic-claude-opus-5',
    'claude-opus-5-5': 'anthropic-claude-opus-5-5',
    'claude-fable-5': 'anthropic-claude-fable-5',
    'gpt-5-4': 'openai-gpt-5-4',
    'gpt-5-5': 'openai-gpt-5-5',
    'gpt-5-6-sol': 'openai-gpt-5-6-sol',
    'gpt-5-6-luna': 'openai-gpt-5-6-luna',
    'gpt-5-6-terra': 'openai-gpt-5-6-terra',
    'gpt-6-sol': 'openai-gpt-6-sol',
    'gpt-6-luna': 'openai-gpt-6-luna',
    'glm-5-1': 'z-ai-glm-5-1',
    'glm-5-2': 'z-ai-glm-5-2',
    'kimi-k2-6': 'moonshotai-kimi-k2-6',
    'qwen3-6-plus': 'qwen-qwen3-6-plus',
    'grok-4-3': 'x-ai-grok-4-3',
    'minimax-m2-7': 'minimax-minimax-m2-7',
    'deepseek-v4-pro': 'deepseek-deepseek-v4-pro',
    'Gemini-2.5-pro': 'google-gemini-2-5-pro',
    o1: 'openai-o1',
    'Doubao-1-5-vision-pro': 'bytedance-doubao-1-5-vision-pro',
    'Gemini-2.5-flash': 'google-gemini-2-5-flash',
    'Qwen-VL-max': 'qwen-qwen-vl-max',
    'Qwen2.5-VL-72B-Instruct': 'qwen-qwen2-5-vl-72b-instruct',
    'Qwen2.5-VL-32B-Instruct': 'model-qwen2-5-vl-32b-instruct',
    'Claude-3.7-sonnet': 'anthropic-claude-sonnet-3-7',
    'Claude-3.5-sonnet': 'claude-3-5-sonnet',
    'Kimi-VL-A3B-Instruct(16B)': 'moonshotai-kimi-vl-a3b-instruct-16b',
    'InternVL3-78B': 'shanghai-ai-lab-internvl3-78b',
    'QvQ-72B-preview': 'qwen-qvq-72b-preview',
    'Qwen2.5-Omni-7B': 'qwen-qwen2-5-omni-7b',
    'Deepseek-VL2(27B)': 'deepseek-deepseek-vl2-27b',
    'InternVL3-38B': 'shanghai-ai-lab-internvl3-38b',
    'Qwen2.5-VL-7B-Instruct': 'model-qwen2-5-vl-7b-instruct',
    'GPT-4o': 'gpt-4o',
    'InternVL3-8B': 'shanghai-ai-lab-internvl3-8b',
    'Kimi-VL-A3B-thinking(16B)': 'moonshotai-kimi-vl-a3b-thinking-16b',
    'Qwen2.5-VL-3B-Instruct': 'model-qwen2-5-vl-3b-instruct',
    'SAIL-VL-1.5-2B': 'bytedance-sail-vl-1-5-2b',
    'Deepseek-VL2-tiny(3B)': 'deepseek-deepseek-vl2-tiny-3b',
    'SAIL-VL-1.6-8B': 'bytedance-sail-vl-1-6-8b',
    'InternVL3-2B': 'shanghai-ai-lab-internvl3-2b',
    'Deepseek-VL2-small(16B)': 'deepseek-deepseek-vl2-small-16b',
    'Llama-4-Maverick-17B-128E-Instruct': 'meta-llama-llama-4-maverick',
    'Muse Spark 1.1': 'meta-muse-spark-1-1',
    'gpt-5.4 (xHigh)': 'openai-gpt-5-4',
    'Muse Spark': 'arena-meta-musespark-e',
    'claude-opus-4-6 (thinking)': 'anthropic-claude-opus-4-6',
    'gemini-3.1-pro (thinking)': 'google-gemini-3-1-pro',
    'claude-opus-4-5-20251101': 'arena-anthropic-claudeopus4520251101-u',
    'claude-4-5-Sonnet': 'anthropic-claude-sonnet-4-5',
    'gemini-3-pro-preview': 'google-gemini-3-pro-preview',
    'claude-4-Sonnet': 'anthropic-claude-sonnet-4',
    'gpt-5-2025-08-07 (High)': 'openai-gpt-5-2025-08-07',
    'gpt-5.2-codex': 'openai-gpt-5-2-codex',
    'claude-4-5-haiku': 'anthropic-claude-haiku-4-5',
    'qwen3-coder-480b-a35b': 'qwen-qwen3-coder',
    'minimax-2.1': 'minimax-minimax-m2-1',
    'gemini-3-flash': null,
    'gpt-5.2': 'openai-gpt-5-2',
    'kimi-k2-instruct': 'moonshotai-kimi-k2',
    'qwen3-235b-a22b': 'qwen-qwen3-235b-a22b',
    'gpt-oss-120b': 'openai-gpt-oss-120b',
    'deepseek-v3p2': 'deepseek-deepseek-v3-2',
    'gemma-3-27b-it': 'google-gemma-3-27b-it',
    'llama3-1-405b-instruct': 'llama-3-1-405b',
    'glm-4.6': 'z-ai-glm-4-6',
    'llama4-maverick-17b-instruct': 'meta-llama-llama-4-maverick',
    'codestral-2405': 'mistralai-codestral-2405',
    'Fable 5.1': 'anthropic-claude-fable-5-1',
    'Opus 5': 'anthropic-claude-opus-5',
    'Fable 5': 'anthropic-claude-fable-5',
    'GLM-5.3': 'z-ai-glm-5-3',
    'Grok 4.7': 'x-ai-grok-4-7',
    'GPT-5.6 Sol': 'openai-gpt-5-6-sol',
    'Opus 4.8': 'anthropic-claude-opus-4-8',
    'GPT-5.6 Terra': 'openai-gpt-5-6-terra',
    'Grok 4.6': 'x-ai-grok-4-6',
    'Gemini 3.8 Flash': 'google-gemini-3-8-flash',
    'GPT-5.6 Luna': 'openai-gpt-5-6-luna',
    'Sonnet 5': 'anthropic-claude-sonnet-5',
    'Gemini 3.7 Flash': 'google-gemini-3-7-flash',
    'GPT 6 Astra': 'openai-gpt-6-astra',
    'Fable 5.1 (xhigh)': 'anthropic-claude-fable-5-1',
    'gemini-3.1-pro-preview (thinking high)': 'google-gemini-3-1-pro-preview',
    'gpt-5.4-pro-2026-03-05': 'openai-gpt-5-4-pro',
    'gpt-5.4-2026-03-05 (xhigh thinking)': 'openai-gpt-5-4',
    'claude-opus-4-6-thinking-max': 'anthropic-claude-opus-4-6',
    'gpt-5-pro-2025-10-06': 'openai-gpt-5-pro',
    'gpt-5.2-2025-12-11': 'openai-gpt-5-2',
    'gpt-5-2025-08-07': 'openai-gpt-5-2025-08-07',
    'claude-opus-4-5-20251101-thinking': 'arena-anthropic-claudeopus4520251101-u',
    'kimi-k2.5': 'moonshotai-kimi-k2-5',
    'gpt-5.1-thinking': 'openai-gpt-5-1',
    'o3 (high) (April 2025)': 'openai-o3',
    'o3 (medium) (April 2025)': 'openai-o3',
    'o4-mini (high) (April 2025)': 'openai-o4-mini-2025-04-16',
    'o4-mini (medium) (April 2025)': 'openai-o4-mini-2025-04-16',
    'claude-opus-4-6 (Non-Thinking)': 'anthropic-claude-opus-4-6',
    'Gemini 2.5 Pro Preview (May 06 2025)': 'google-gemini-2-5-pro-preview-05-06',
    'claude-sonnet-4-5-20250929-thinking': 'anthropic-claude-sonnet-4-5',
    'claude-opus-4-1-20250805-thinking': 'anthropic-claude-opus-4-1',
    'Claude Opus 4 (Thinking)': 'anthropic-claude-opus-4',
    'gemini-3.1-flash-lite-preview': 'google-gemini-3-1-flash-lite',
    'glm-4p5': 'z-ai-glm-4-5',
    'glm-4p5-air': 'z-ai-glm-4-5-air',
    'claude-opus-4-1-20250805': 'anthropic-claude-opus-4-1',
    'Claude Sonnet 4 (Thinking)': 'anthropic-claude-sonnet-4',
    'claude-sonnet-4-5-20250929': 'anthropic-claude-sonnet-4-5',
    'Claude Opus 4': 'anthropic-claude-opus-4',
    'Llama 4 Maverick': 'meta-llama-llama-4-maverick',
    'Claude Sonnet 4': 'anthropic-claude-sonnet-4',
    'GPT-4.1': 'openai-gpt-4-1',
    'Mistral Medium 3': 'mistralai-mistral-medium-3',
    'Nova Pro': 'amazon-nova-pro',
    'Nova Lite': 'amazon-nova-lite-v1',
    'Claude 3.7 Sonnet (Thinking)': 'anthropic-claude-sonnet-3-7',
    'o1 (December 2024)': 'openai-o1-2024-12-17',
    'GPT-4o (November 2024)': 'openai-gpt-4o-2024-11-20',
    'OpenAI o3-mini-low': 'openai-o3-mini',
    'OpenAI o3-mini-high': 'openai-o3-mini',
    'OpenAI o3-mini-medium': 'openai-o3-mini',
    'OpenAI o1-preview': 'openai-o1-preview',
    'Deepseek-R1': 'deepseek-deepseek-r1',
    'Claude3.5-Sonnet': 'claude-3-5-sonnet',
    'Deepseek-Coder-v2': 'deepseek-coder-v2',
    'GPT-4-Turbo': 'openai-gpt-4-turbo',
    'OpenAI o1-mini': 'arena-openai-o1mini-d',
    'Llama-3.1-405B-Chat': 'llama-3-1-405b',
    'Qwen2-72B-Instruct': 'arena-qwen-qwen272binstruct-l',
    'Claude3-Opus': 'anthropic-claude-3-opus',
    'Llama-3.1-70B-Chat': 'meta-llama-llama-3-1-70b-instruct',
    'Mixtral-8x22B-Instruct': 'mistralai-mixtral-8x22b-instruct',
    'GPT-5 (high, code & web)': 'openai-gpt-5',
    'GPT-5 (high, code)': 'openai-gpt-5',
    'GPT-5 (high)': 'openai-gpt-5',
    'Gemini-3 Pro': 'google-gemini-3-pro-preview',
    'GPT-5 (minimal)': 'openai-gpt-5',
    'Gemini-2.5 Pro': 'google-gemini-2-5-pro',
    'DeepSeek R1': 'deepseek-deepseek-r1',
    'Gemini-2.5 Flash': 'google-gemini-2-5-flash',
    'o4-mini (high)': 'openai-o4-mini',
    'o3 (high)': 'openai-o3',
    'Llama-4 Maverick': 'meta-llama-llama-4-maverick'
};
const NEW_MODELS = {
    'cursor-composer-2-5': ['Cursor', 'Composer 2.5'],
    'bytedance-seed-2-1-pro': ['ByteDance', 'Seed 2.1 Pro'],
    'bytedance-doubao-1-5-vision-pro': ['ByteDance', 'Doubao 1.5 Vision Pro'],
    'qwen-qwen-vl-max': ['Alibaba Qwen', 'Qwen-VL Max'],
    'anthropic-claude-sonnet-3-7': ['Anthropic', 'Claude Sonnet 3.7'],
    'moonshotai-kimi-vl-a3b-instruct-16b': ['Moonshot AI', 'Kimi-VL A3B Instruct (16B)'],
    'shanghai-ai-lab-internvl3-78b': ['Shanghai AI Lab', 'InternVL3 78B'],
    'qwen-qvq-72b-preview': ['Alibaba Qwen', 'QvQ 72B Preview'],
    'qwen-qwen2-5-omni-7b': ['Alibaba Qwen', 'Qwen2.5 Omni 7B'],
    'deepseek-deepseek-vl2-27b': ['DeepSeek', 'DeepSeek VL2 (27B)'],
    'shanghai-ai-lab-internvl3-38b': ['Shanghai AI Lab', 'InternVL3 38B'],
    'shanghai-ai-lab-internvl3-8b': ['Shanghai AI Lab', 'InternVL3 8B'],
    'moonshotai-kimi-vl-a3b-thinking-16b': ['Moonshot AI', 'Kimi-VL A3B Thinking (16B)'],
    'deepseek-deepseek-vl2-tiny-3b': ['DeepSeek', 'DeepSeek VL2 Tiny (3B)'],
    'bytedance-sail-vl-1-5-2b': ['ByteDance', 'SAIL-VL 1.5 2B'],
    'bytedance-sail-vl-1-6-8b': ['ByteDance', 'SAIL-VL 1.6 8B'],
    'shanghai-ai-lab-internvl3-2b': ['Shanghai AI Lab', 'InternVL3 2B'],
    'deepseek-deepseek-vl2-small-16b': ['DeepSeek', 'DeepSeek VL2 Small (16B)'],
    'mistralai-codestral-2405': ['Mistral AI', 'Codestral 2405']
};

const args = process.argv.slice(2);
const option = name => args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const APPLY = args.includes('--apply');
const snapshotPath = option('--snapshot');
const expectedHash = option('--expect-sha256');
const expectedCount = Number(option('--expect-score-count'));
const expectedStaged = Number(option('--expect-staged'));
const backupPath = option('--backup-path');
if (!snapshotPath || args.some(arg => !arg.startsWith('--snapshot=')
    && !arg.startsWith('--expect-sha256=') && !arg.startsWith('--expect-score-count=')
    && !arg.startsWith('--expect-staged=') && !arg.startsWith('--backup-path=')
    && arg !== '--apply')) {
    throw new Error('Usage: --snapshot=<file> [--apply --expect-sha256=<hash> --expect-score-count=<n> --expect-staged=<n> --backup-path=<file>]');
}
if (APPLY && (!expectedHash || !Number.isSafeInteger(expectedCount) || expectedCount < 1
    || !Number.isSafeInteger(expectedStaged) || expectedStaged < 0 || !backupPath)) {
    throw new Error('Apply requires snapshot hash, score count, staged count and backup path.');
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
        user: process.env.BENCHPOLL_DB_USER || 'root', password,
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks',
        dateStrings: true, charset: 'utf8mb4'
    };
}

function modelSlug(sourceKey, row) {
    if (sourceKey === 'arc-agi-3') {
        const base = row.modelSlug.replace(/-(max|xhigh|high|medium|low|none)(?:-effort)?(?:-provider-adapter)?$/, '')
            .replace(/-2026-\d\d-\d\d/, '').replace(/^xai-/, 'x-ai-')
            .replace(/^anthropic-opus/, 'anthropic-claude-opus');
        return base === 'x-ai-grok-4-20-beta-0309-reasoning'
            ? 'arena-xai-grok420beta0309reasoning-s' : base;
    }
    if (sourceKey === 'deepswe-v1.1') {
        const prefix = DEEP_PREFIXES.find(([pattern]) => pattern.test(row.modelSlug))?.[1];
        return prefix ? `${prefix}-${row.modelSlug}` : null;
    }
    return Object.hasOwn(ALIASES, row.modelName) ? ALIASES[row.modelName] : null;
}

function scoreFields(config, options) {
    const fields = [];
    if (config.harness) fields.push({ fieldID: 1, value: options.get(`1:${config.harness.toLowerCase()}`) ?? (options.harnessIsEnum ? undefined : config.harness) });
    if (config.reasoningEffort === 'adaptive') {
        fields.push({ fieldID: 22, value: options.get('22:adaptive') });
    } else if (config.reasoningEffort) {
        fields.push({ fieldID: 20, value: options.get(`20:${config.reasoningEffort}`) });
    }
    if (config.reasoningMode && config.reasoningEffort !== 'adaptive') {
        fields.push({ fieldID: 22, value: options.get(`22:${config.reasoningMode}`) });
    }
    if (config.tools) fields.push({ fieldID: 34, value: config.tools });
    if (fields.some(field => field.value === undefined)) {
        throw new Error(`Unknown score-field option in ${JSON.stringify(config)}.`);
    }
    return fields;
}

function canonicalFields(value) {
    const fields = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(fields)) throw new Error('Existing score fields are invalid.');
    return JSON.stringify(fields.map(field => [Number(field.fieldID), field.value])
        .sort((left, right) => left[0] - right[0]));
}

function validate(snapshot) {
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.sources)
        || snapshot.sources.length !== Object.keys(SOURCE_URLS).length) {
        throw new Error('Unexpected snapshot schema or source count.');
    }
    const age = Date.now() - Date.parse(snapshot.fetchedAt);
    if (!Number.isFinite(age) || age < 0 || age > 24 * 60 * 60 * 1000) {
        throw new Error('Snapshot collection time is invalid or stale.');
    }
    const counts = { 'arc-agi-3': 50, 'deepswe-v1.1': 100,
        spatialviz: 40, 'agents-last-exam': 100, 'swe-bench-pro-public': 20,
        'terminal-bench-v4': 10, 'scale-hle-finalized': 45,
        'scicode-official': 40, 'critpt-official': 13 };
    let total = 0;
    const seenSources = new Set();
    for (const source of snapshot.sources) {
        if (seenSources.has(source.key) || source.url !== SOURCE_URLS[source.key]
            || !Array.isArray(source.entries) || source.entries.length < counts[source.key]) {
            throw new Error(`Unexpected ${source.key} source.`);
        }
        seenSources.add(source.key);
        const seenRows = new Set();
        for (const row of source.entries) {
            if (!row.recordID || seenRows.has(row.recordID) || !row.modelName
                || !METRICS[row.metric] || !Number.isFinite(row.score)
                || row.score < 0 || row.score > 100 || !row.config) {
                throw new Error(`Invalid ${source.key} score row.`);
            }
            seenRows.add(row.recordID);
            total += 1;
        }
    }
    return total;
}

async function run(connection, snapshot, apply, hash, total) {
    const report = { dryRun: !apply, snapshotHash: hash, snapshotPath,
        fetchedAt: snapshot.fetchedAt, scoreCount: total,
        newOrganizations: [], newModels: [], newBenchmarks: [], newConditions: [],
        staged: [], insertedResults: 0, unchangedResults: 0, supersededResults: 0 };
    const [organizationRows] = await connection.query(
        'SELECT ID, name, slug, is_model_vendor, is_active FROM organizations');
    const [modelRows] = await connection.query(
        'SELECT ID, name, slug, vendor_ID, is_active FROM models');
    const [benchmarkRows] = await connection.query(
        'SELECT ID, name, introduction_url, is_active FROM benchmarks');
    const [conditionRows] = await connection.query(`SELECT ID, benchmark_ID, condition_key,
        name, score_direction, target_value, uses_percentage_scale, score_min, score_max,
        is_default, deleted_at FROM benchmark_conditions`);
    const [fieldRows] = await connection.query(
        'SELECT ID, field_type, is_active FROM score_fields WHERE ID IN (1,20,22,34)');
    if (fieldRows.length !== 4 || fieldRows.some(row => Number(row.is_active) !== 1)
        || !['text', 'enum'].includes(fieldRows.find(row => Number(row.ID) === 1)?.field_type)
        || fieldRows.find(row => Number(row.ID) === 34)?.field_type !== 'text'
        || fieldRows.filter(row => [20, 22].includes(Number(row.ID)))
            .some(row => row.field_type !== 'enum')) {
        throw new Error('Score-field schema differs from the audited version.');
    }
    const [optionRows] = await connection.query(`SELECT ID, field_ID, label
        FROM score_field_options WHERE field_ID IN (1,20,22) AND is_active = 1`);
    const options = new Map(optionRows.map(row =>
        [`${row.field_ID}:${row.label.toLowerCase()}`, Number(row.ID)]));
    options.harnessIsEnum = fieldRows.find(row => Number(row.ID) === 1)?.field_type === 'enum';
    const organizations = new Map(organizationRows.map(row => [row.name, row]));
    const models = new Map(modelRows.map(row => [row.slug, row]));
    const benchmarks = new Map(benchmarkRows.map(row => [row.name, row]));
    const conditions = new Map(conditionRows.map(row =>
        [`${row.benchmark_ID}:${row.condition_key}`, row]));

    async function organizationFor(name) {
        let row = organizations.get(name);
        if (!row && name !== 'Cursor') throw new Error(`Unverified organization ${name}.`);
        if (!row) {
            if (!report.newOrganizations.includes(name)) report.newOrganizations.push(name);
            if (apply) {
                const [result] = await connection.execute(`INSERT INTO organizations
                    (slug, name, is_model_vendor, is_active) VALUES ('cursor', ?, 1, 1)`, [name]);
                row = { ID: result.insertId, name, is_model_vendor: 1, is_active: 1 };
                organizations.set(name, row);
            }
        }
        if (row && (Number(row.is_active) !== 1 || Number(row.is_model_vendor) !== 1)) {
            throw new Error(`Organization ${name} is not an active model vendor.`);
        }
        return row;
    }

    async function modelFor(slug) {
        let row = models.get(slug);
        if (row) return Number(row.is_active) === 1 ? row : null;
        const definition = NEW_MODELS[slug];
        if (!definition) return null;
        const [vendorName, name] = definition;
        const vendor = await organizationFor(vendorName);
        if (modelRows.some(item => item.name.toLowerCase() === name.toLowerCase()
            && (!vendor || Number(item.vendor_ID) === Number(vendor.ID)))) {
            throw new Error(`A model named ${name} already exists under another slug.`);
        }
        if (!report.newModels.some(item => item.slug === slug)) {
            report.newModels.push({ slug, name, vendor: vendorName });
        }
        if (apply) {
            const [created] = await connection.execute(`INSERT INTO models
                (vendor_ID, slug, name, is_active) VALUES (?, ?, ?, 1)`,
            [vendor.ID, slug, name]);
            row = { ID: created.insertId, slug, name, vendor_ID: vendor.ID, is_active: 1 };
            models.set(slug, row);
        }
        return row ?? { ID: null, slug, name, vendor_ID: null, is_active: 1 };
    }

    async function benchmarkFor(config) {
        let row = benchmarks.get(config.benchmark);
        if (!row) {
            if (config.benchmarkID || config.benchmark !== 'SpatialViz') {
                throw new Error(`Benchmark ${config.benchmark} is unexpectedly missing.`);
            }
            if (!report.newBenchmarks.includes(config.benchmark)) {
                report.newBenchmarks.push(config.benchmark);
            }
            if (apply) {
                const [created] = await connection.execute(`INSERT INTO benchmarks
                    (name, introduction_url, is_active) VALUES (?, ?, 1)`,
                ['SpatialViz', SOURCE_URLS.spatialviz]);
                row = { ID: created.insertId, name: config.benchmark, is_active: 1 };
                benchmarks.set(config.benchmark, row);
            }
        }
        if (row && (Number(row.is_active) !== 1
            || (config.benchmarkID && Number(row.ID) !== config.benchmarkID))) {
            throw new Error(`Benchmark identity differs for ${config.benchmark}.`);
        }
        return row ?? { ID: null, name: config.benchmark, is_active: 1 };
    }

    const metricState = new Map();
    for (const [metric, config] of Object.entries(METRICS)) {
        const benchmark = await benchmarkFor(config);
        let condition = benchmark.ID ? conditions.get(`${benchmark.ID}:${config.key}`) : null;
        if (!condition) {
            report.newConditions.push(`${config.benchmark}: ${config.name}`);
            if (apply) {
                const [created] = await connection.execute(`INSERT INTO benchmark_conditions
                    (benchmark_ID, condition_key, name, score_direction, target_value,
                     uses_percentage_scale, score_min, score_max, is_default, is_primary)
                    VALUES (?, ?, ?, 'higher', NULL, 1, NULL, NULL, 0, ?)`,
                [benchmark.ID, config.key, config.name, await primaryFlagForNewCondition(connection, benchmark.ID)]);
                condition = { ID: created.insertId, benchmark_ID: benchmark.ID,
                    condition_key: config.key, name: config.name,
                    score_direction: 'higher', target_value: null,
                    uses_percentage_scale: 1, score_min: null, score_max: null,
                    is_default: 0, deleted_at: null };
                conditions.set(`${benchmark.ID}:${config.key}`, condition);
            }
        }
        if (condition && (condition.deleted_at !== null
            || condition.name !== config.name || condition.score_direction !== 'higher'
            || condition.target_value !== null || Number(condition.uses_percentage_scale) !== 1
            || condition.score_min !== null || condition.score_max !== null
            || Number(condition.is_default) !== 0)) {
            throw new Error(`Condition ${config.benchmark}/${config.key} differs from the source metric.`);
        }
        metricState.set(metric, { benchmark, condition });
    }

    const [oldRows] = await connection.execute(`SELECT ID, model_ID, benchmark_ID,
        benchmark_condition_ID, raw_score, source_url, status, score_fields, notes
        FROM benchmark_results WHERE source_title = ? FOR UPDATE`, [SOURCE_TITLE]);
    const oldByKey = new Map();
    for (const row of oldRows) {
        const notes = typeof row.notes === 'string' ? JSON.parse(row.notes) : row.notes;
        const key = notes?.official_import_key;
        if (!key) throw new Error(`Existing official import ${row.ID} has no audit key.`);
        const list = oldByKey.get(key) ?? [];
        list.push(row);
        oldByKey.set(key, list);
    }

    for (const source of snapshot.sources) {
        for (const score of source.entries) {
            const slug = modelSlug(source.key, score);
            const model = slug ? await modelFor(slug) : null;
            if (!model) {
                report.staged.push({ source: source.key, recordID: score.recordID,
                    modelName: score.modelName, reason: slug
                        ? `No verified active model mapping for ${slug}`
                        : 'Model identity or version is ambiguous' });
                continue;
            }
            const state = metricState.get(score.metric);
            const importKey = `${source.key}:${score.recordID}`;
            const existing = oldByKey.get(importKey) ?? [];
            if (existing.some(row => row.status === 'archived')) {
                throw new Error(`Previously archived import ${importKey} requires manual review.`);
            }
            const accepted = existing.filter(row => row.status === 'accepted');
            if (accepted.length > 1) throw new Error(`Duplicate accepted import ${importKey}.`);
            const raw = score.score.toFixed(6);
            const fields = scoreFields(score.config, options);
            if (accepted.length) {
                const old = accepted[0];
                if (Number(old.model_ID) !== Number(model.ID)
                    || Number(old.benchmark_ID) !== Number(state.benchmark.ID)
                    || Number(old.benchmark_condition_ID) !== Number(state.condition.ID)
                    || old.source_url !== source.url
                    || canonicalFields(old.score_fields) !== canonicalFields(fields)) {
                    throw new Error(`Imported identity or configuration changed for ${importKey}.`);
                }
                if (Number(old.raw_score).toFixed(6) === raw) {
                    report.unchangedResults += 1;
                    continue;
                }
                report.supersededResults += 1;
                if (apply) {
                    const [updated] = await connection.execute(`UPDATE benchmark_results
                        SET status = 'superseded' WHERE ID = ? AND status = 'accepted'`, [old.ID]);
                    if (updated.affectedRows !== 1) throw new Error(`Could not supersede ${importKey}.`);
                }
            }
            report.insertedResults += 1;
            if (apply) {
                const condition = state.condition;
                const notes = {
                    official_import_key: importKey, official_model_name: score.modelName,
                    official_model_record: score.recordID, official_metric: score.metric,
                    source_fetched_at: snapshot.fetchedAt,
                    source_generated_at: source.generatedAt ?? null,
                    source_data_url: source.dataURL ?? null
                };
                const conditionSnapshot = { name: condition.name, scoreMax: null,
                    scoreMin: null, benchmarkID: state.benchmark.ID,
                    conditionID: condition.ID, targetValue: null,
                    scoreDirection: 'higher', usesPercentageScale: true };
                await connection.execute(`INSERT INTO benchmark_results
                    (model_ID, benchmark_ID, benchmark_condition_ID, raw_score,
                     source_url, source_type, source_title, benchmark_condition_snapshot,
                     status, notes, score_fields)
                    VALUES (?, ?, ?, ?, ?, 'third_party_lab', ?, ?, 'accepted', ?, ?)`,
                [model.ID, state.benchmark.ID, condition.ID, raw, source.url,
                    SOURCE_TITLE, JSON.stringify(conditionSnapshot),
                    JSON.stringify(notes), JSON.stringify(fields)]);
            }
        }
    }
    if (report.insertedResults + report.unchangedResults + report.staged.length !== total) {
        throw new Error('The import plan does not account for every score.');
    }
    return report;
}

const bytes = await readFile(snapshotPath);
const hash = createHash('sha256').update(bytes).digest('hex');
const snapshot = JSON.parse(bytes.toString('utf8'));
const total = validate(snapshot);
if (APPLY && (hash !== expectedHash || total !== expectedCount)) {
    throw new Error('Snapshot hash or score count differs from approved input.');
}
const connection = await mysql.createConnection(databaseConfig());
try {
    const [[lock]] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [LOCK_NAME]);
    if (Number(lock.acquired) !== 1) throw new Error('Could not acquire import lock.');
    try {
        await connection.beginTransaction();
        try {
            const report = await run(connection, snapshot, APPLY, hash, total);
            if (APPLY && report.staged.length !== expectedStaged) {
                throw new Error(`Staged score count changed: ${report.staged.length}.`);
            }
            if (APPLY) await connection.commit();
            else await connection.rollback();
            console.log(JSON.stringify({ ...report,
                backupPath: APPLY ? backupPath : undefined }, null, 2));
        } catch (error) {
            await connection.rollback();
            throw error;
        }
    } finally {
        await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
    }
} finally {
    await connection.end();
}
