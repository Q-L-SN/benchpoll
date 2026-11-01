import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { modelRunConfiguration } from '../model-run-configuration.js';

export const stableJSON = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const objectHash = value => createHash('sha256').update(typeof value === 'string' ? value : stableJSON(value)).digest('hex');
export const nameKey = value => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');

export function scaleRunConfiguration(record, boardID) {
    let name = record.model.trim().replace(/\s+/g, ' ');
    const configuration = {};
    name = name.replace(/\((Codex|Claude Code|Gemini CLI|mini[- ]swe(?:[- ]agent)?|OpenCode|Pi)\)/ig, (_, harness) => {
        const normalized = { codex: 'Codex', claudecode: 'Claude Code', geminicli: 'Gemini CLI', opencode: 'OpenCode', pi: 'Pi' }[nameKey(harness)];
        configuration.agentHarness = normalized ?? 'mini-swe-agent'; return '';
    }).trim();
    if (boardID === 'swe_bench_pro' && /\*/.test(name) && !configuration.agentHarness) configuration.agentHarness = 'mini-swe-agent';
    if (boardID.startsWith('audiomc')) {
        configuration.generationMode = boardID === 'audiomc-audio' || /\u2020/.test(name) ? 'Audio output'
            : boardID === 'audiomc-text' || /\*/.test(name) ? 'Text output' : undefined;
    }
    name = name.replace(/[\*\u2020]+/g, '').trim();
    if (/^manus/i.test(name)) name = name.replace(/\((max|ultra)\)/ig, ' $1').trim();
    name = name.replace(/\((?:reasoning\s*effort\s*=\s*|thinking\s+)?(minimal|low|medium|high|xhigh|x-high|max|ultra|none)(?:\s+thinking)?\)/ig,
        (full, effort) => {
            configuration.reasoningEffort = effort.toLowerCase().replace('-', '');
            if (/thinking/i.test(full)) configuration.reasoningMode = 'enabled';
            return '';
        });
    if (!/^(?:qwen|manus).*[- ]max$/i.test(name) && !/codex[- ]max$/i.test(name)
        && !/^nemotron.*[- ]ultra$/i.test(name)) {
        name = name.replace(/(?:\s+|\s*-\s*)(xhigh|x-high|minimal|medium|high|low|max|ultra)$/i,
            (_, effort) => { configuration.reasoningEffort = effort.toLowerCase().replace('-', ''); return ''; }).trim();
    }
    name = name.replace(/\((non[- ]thinking|non[- ]extended thinking mode|thinking|reasoning)\)/ig,
        (_, mode) => { configuration.reasoningMode = /^non/i.test(mode) ? 'disabled' : 'enabled'; return ''; }).trim();
    if (/^(?:claude|gpt|o[134])[- ]/i.test(name)) {
        name = name.replace(/[- _](non[- ]thinking|thinking|reasoning|instant)(?=\s*\(|$)/ig, (_, mode) => {
            configuration.reasoningMode = /^(non|instant)/i.test(mode) ? 'disabled' : 'enabled'; return '';
        });
    }
    name = name.replace(/^Codex\s+(GPT[- ]?)/i, (_, prefix) => { configuration.agentHarness = 'Codex'; return prefix; });
    name = name.replace(/\s*\((CoWork|default)\)/ig, (_, value) => {
        if (/cowork/i.test(value)) configuration.agentHarness = 'Claude Cowork';
        else configuration.configurationSelection = 'Source default settings';
        return '';
    }).trim();
    const vendorSlug = inferVendor(name, record.company);
    const parsed = modelRunConfiguration(name, vendorSlug);
    return { baseName: parsed.baseName.replace(/\s+/g, ' ').trim(), vendorSlug,
        configuration: Object.fromEntries(Object.entries({ ...parsed.configuration, ...configuration }).filter(([, value]) => value !== undefined)) };
}

export function inferVendor(name, sourceCompany) {
    if (/^(?:openai\s+)?(?:gpt|chatgpt|o[134](?:\b|-|\s)|codex)/i.test(name)) return 'openai';
    if (/^(?:claude|opus|sonnet|fable|haiku)/i.test(name)) return 'anthropic';
    if (/^(?:gemini|gemma)/i.test(name)) return 'google';
    if (/^(?:qwen)/i.test(name)) return 'qwen';
    if (/^(?:glm|chatglm)/i.test(name)) return 'zhipu';
    if (/^kimi/i.test(name)) return 'moonshot-ai';
    if (/^(?:muse|llama|codellama)/i.test(name)) return 'meta';
    if (/^deepseek/i.test(name)) return 'deepseek';
    if (/^(?:inkling|tml)/i.test(name)) return 'thinking-machines';
    if (/^mimo/i.test(name)) return 'xiaomi';
    if (/^minimax/i.test(name)) return 'minimax';
    if (/^grok/i.test(name)) return 'xai';
    if (/^nemotron/i.test(name)) return 'nvidia';
    if (/^manus/i.test(name)) return 'manus';
    if (/^jais/i.test(name)) return 'inception-ai';
    if (/^yi[- ]/i.test(name)) return '01-ai';
    if (/^huatuo/i.test(name)) return 'freedomintelligence';
    if (/^medgemma/i.test(name)) return 'google';
    if (/^(?:pixtral|mixtral|mistral)/i.test(name)) return 'mistral';
    if (/^nova/i.test(name)) return 'amazon';
    const vendors = { openai: 'openai', anthropic: 'anthropic', google: 'google', alibaba: 'qwen', qwen: 'qwen',
        zai: 'zhipu', zhipu: 'zhipu', moonshot: 'moonshot-ai', moonshotai: 'moonshot-ai', meta: 'meta', xai: 'xai',
        mistral: 'mistral', deepseek: 'deepseek', microsoft: 'microsoft', amazon: 'amazon', cohere: 'cohere',
        minimax: 'minimax', thinkingmachines: 'thinking-machines', xiaomi: 'xiaomi', liquid: 'liquidai', manus: 'manus', nvidia: 'nvidia',
        kimi: 'moonshot-ai' };
    if (/^lfm/i.test(name)) return 'liquidai';
    return vendors[nameKey(sourceCompany)] ?? null;
}

export async function loadScaleEvidence(directory) {
    const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
    if (manifest.schemaVersion !== 1 || manifest.failures.length) throw new Error('Incomplete source capture.');
    const pages = [];
    for (const entry of manifest.pages) {
        const body = await readFile(resolve(directory, entry.file), 'utf8');
        if (objectHash(body) !== entry.sha256) throw new Error(`Source hash mismatch: ${entry.file}`);
        const page = JSON.parse(body);
        if (page.sourceURL !== entry.sourceURL) throw new Error('Source URL mismatch.');
        pages.push({ ...page, evidenceFile: entry.file, evidenceHash: entry.sha256 });
    }
    return { manifest, pages };
}

export function uniqueScaleTables(pages) {
    const tables = new Map();
    for (const page of pages.filter(page => page.evidenceFile !== 'directory.json')) {
        const boardID = new URL(page.sourceURL).pathname.split('/').at(-1);
        for (const table of page.tables) {
            const variant = table.data.key ?? 'overall';
            const ID = `${boardID}:${variant}`;
            const content = stableJSON(table.data.scores);
            const previous = tables.get(ID);
            if (previous && stableJSON(previous.records) !== content) throw new Error(`Publisher changed during capture: ${ID}`);
            if (!previous) tables.set(ID, { ID, boardID, variant, label: table.data.label ?? page.headings[0],
                records: table.data.scores, sourceURL: page.sourceURL, evidenceFile: page.evidenceFile,
                evidenceHash: page.evidenceHash, fetchedAt: page.fetchedAt });
        }
    }
    return [...tables.values()];
}

export function modelCandidates(identity, record, state) {
    const keys = new Set([nameKey(identity.baseName), nameKey(record.version || identity.baseName),
        nameKey(identity.baseName.replace(/^(OpenAI|Claude)\s*/i, ''))]);
    const vendorIDs = new Set(state.tables.organizations.filter(o => o.slug === identity.vendorSlug
        || (identity.vendorSlug === 'zhipu' && o.slug === 'z-ai') || (identity.vendorSlug === 'qwen' && o.slug === 'alibaba')).map(o => Number(o.ID)));
    return state.tables.models.filter(m => vendorIDs.has(Number(m.vendor_ID)) && Number(m.is_active) === 1
        && [nameKey(m.name), nameKey(m.name.replace(/^(OpenAI|Claude)\s*/i, '')), nameKey(m.slug.replace(/^(openai|anthropic|google|meta|qwen|deepseek|z-ai|zhipu|moonshot-ai|thinkingmachines|thinking-machines|xiaomi|xai|mistral|amazon|microsoft|cohere|minimax)-/, ''))].some(key => keys.has(key)));
}
