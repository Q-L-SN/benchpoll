import { nameKey, scaleRunConfiguration } from './scale-official-data.mjs';

const aliases = new Map();
function alias(target, ...names) { for (const name of names) aliases.set(nameKey(name), target); }
alias('Claude Sonnet 5', 'Claude Sonnet 5.0', 'Sonnet 5');
alias('Claude Fable 5.1', 'Fable 5.1');
alias('Claude Opus 5', 'Opus 5');
alias('Claude Opus 5.5', 'Opus 5.5');
alias('Claude Haiku 5.5', 'Haiku 5.5');
alias('Claude Haiku 4.5', 'Haiku 4.5', 'claude-4-5-haiku', 'claude-haiku-4-5-20251001');
alias('Claude Sonnet 4', 'Claude 4 Sonnet', 'claude-4-sonnet-20250514', 'claude-sonnet-4-20250514');
alias('Claude Opus 4', 'Claude 4 Opus', 'claude-4-opus-20250514', 'claude-opus-4-20250514');
alias('Claude Sonnet 4.5', 'claude-4-5-sonnet', 'claude-sonnet-4-5-20250929');
alias('Claude Opus 4.5', 'claude-opus-4-5-20251101');
alias('Claude Opus 4.1', 'claude-opus-4-1-20250805', 'claude-opus-4-1-20250805_anthropic');
alias('Claude Sonnet 3.7', 'Claude 3.7 Sonnet', 'claude-37-sonnet', 'Claude 3.7 Sonnet (February 2025)',
    'Claude 3.7 Sonnet (Feb 2025)', 'claude-3-7-sonnet-20250219', 'claude-3-7-sonnet-20250219_normal');
alias('Claude 3.5 Haiku', 'claude-3-5-haiku');
alias('claude-3-5-sonnet-20240620', 'Claude 3.5 Sonnet (June 2024)');
alias('claude-3-5-sonnet-20241022', 'Claude 3.5 Sonnet (October 2024)');
alias('Claude 3 Opus', 'claude-3-opus-20240229');
alias('Claude 3 Sonnet', 'claude-3-sonnet-20240229');
alias('Claude 3 Haiku', 'claude-3-haiku-20240307');
alias('GPT-5.2', 'gpt-5.2-2025-12-11');
alias('GPT-5.2 Pro', 'gpt-5.2-pro-2025-12-11');
alias('GPT-5.4', 'gpt-5.4-2026-03-05');
alias('GPT-5.4 Pro', 'gpt-5.4-pro-2026-03-05');
alias('GPT-5.1', 'gpt-5.1-2025-11-13');
alias('GPT-5 Pro', 'gpt-5-pro-2025-10-06');
alias('GPT-5 Mini', 'gpt-5-mini-2025-08-07');
alias('o3-mini', 'o3-mini-2025-01-31');
alias('o3-pro-2025-06-10', 'o3 Pro', 'o3 Pro (June 2025)');
alias('o3-2025-04-03', 'o3 (April 2025)');
alias('o4-mini-2025-04-03', 'o4-mini (April 2025)');
alias('o1-pro', 'o1 Pro (March 2025)');
alias('gpt-4o-2024-05-13', 'GPT-4o (May 2024)');
alias('gpt-4o-2024-08-06', 'GPT-4o (August 2024)');
alias('gpt-4o-2024-11-20', 'GPT-4o (November 2024)');
alias('gpt-4.5-2025-02-21-alpha', 'GPT-4.5 Preview (February 2025)');
alias('gemini-2.5-pro-exp-03-25', 'Gemini 2.5 Pro Experimental (March 2025)', 'Gemini 2.5 Pro (03-25)');
alias('gemini-2.5-pro-preview-06-05', 'Gemini 2.5 Pro (06-05)');
alias('gemini-2.5-flash-preview-04-17', 'Gemini 2.5 Flash (April 2025)');
alias('gemini-2.0-pro-exp-02-05', 'Gemini 2.0 Pro Experimental (February 2025)', 'Gemini 2.0 Pro Experimental (Feb 2025)');
alias('gemini-2.0-pro-exp-12-06', 'Gemini 2.0 Pro (December 2024)');
alias('gemini-2.0-flash-thinking-exp-01-21', 'Gemini 2.0 Flash Thinking (January 2025)', 'Gemini 2.0 Flash Thinking Experimental (January 2025)');
alias('gemini-2.0-flash-exp', 'Gemini 2.0 Flash Experimental (December 2024)', 'Gemini Pro Flash 2');
alias('Gemini 2.0 Flash', 'Gemini 2.0 Flash (February 2025)', 'gemini-2-0-flash');
alias('Gemini 2.0 Flash', 'gemini-2.0-flash-001');
alias('gemini-2.5-pro-preview-03-25', 'gemini-2.5-pro-exp-03-25');
alias('gemini-2.5-pro-preview-05-06', 'Gemini 2.5 Pro Preview (May 06 2025)');
alias('gemini-2.5-flash-preview-05-20', 'Gemini 2.5 Flash Preview (May 2025)');
alias('DeepSeek R1', 'Deepseek R1 (Jan 2025)');
alias('gemini-2.0-flash-lite-preview-02-05', 'Gemini 2.0 Flash Lite Preview (February 2025)', 'Gemini 2.0 Flash Lite Preview');
alias('Gemini 2.0 Flash-Lite', 'Gemini 2.0 Flash-Lite (February 2025)');
alias('gemini-1.5-pro-preview-0514', 'Gemini 1.5 Pro (May 2024)');
alias('gemini-1.5-pro-preview-0409', 'Gemini 1.5 Pro (April 2024)');
alias('gemini-1.5-pro-exp-0827', 'Gemini 1.5 Pro (August 2024)', 'Gemini 1.5 Pro (August 27, 2024)');
alias('gemini-exp-1121', 'Gemini 1.5 Pro (November 2024)');
alias('DeepSeek V3-0324', 'Deepseek V3 (March 2025)', 'llmengine/deepseek-v3-0324');
alias('DeepSeek V3', 'Deepseek V3 (December 2024)');
alias('Llama 4 Maverick 17B-128E Instruct', 'llama-4-maverick', 'llama4-maverick', 'Llama 4 Maverick',
    'llama4-maverick-17b-instruct', 'llama4-maverick-instruct-basic', 'llama4-maverick-17b-instruct-v1:0');
alias('Llama 4 Scout 17B-16E Instruct', 'llama4-scout', 'llama-4-scout');
alias('Llama 3.1 405B', 'Llama 3.1 405B Instruct', 'llama3-1-405b-instruct');
alias('Llama 3.1 70B Instruct', 'Llama 3.1 70B');
alias('Llama 3.1 8B Instruct', 'Llama 3.1 8B');
alias('Llama 3.3 70B Instruct', 'Llama 3.3 70B');
alias('Qwen3 235B A22B', 'Qwen3-235B');
alias('Qwen3-235B-A22B-Instruct-2507', 'qwen.qwen3-235b-a22b-2507-v1:0');
alias('Qwen3 Coder 480B A35B Instruct', 'qwen3-coder-480b-a35b');
alias('Qwen3.8 2.4T A95B', 'qwen3p8-2p4t-a95b');
alias('Nova Lite', 'Nova LIte');
alias('Nova Micro', 'Nova Mirco');
alias('Nova Lite', 'Amazon Nova Lite', 'amazon-nova-lite-v1.0');
alias('Nova Micro', 'Amazon Nova Micro', 'amazon-nova-micro-v1.0');
alias('Manus 1.6 Max', 'Manus_1.6 Max');
alias('o1', 'o1 (December 2024)');
alias('GPT-4 Turbo Preview', 'GPT-4 Turbo Preview', 'gpt-4-0125-preview');
alias('gpt-4-1106-preview', 'GPT-4 (November 2024)');
alias('magistral-medium-2506', 'Mistral Magistral');
alias('Pixtral Large 2411', 'Pixtral Large (November 2024)');
alias('Pixtral 12B 2409', 'Pixtral 12B (September 2024)');
alias('gemini-2.0-flash-exp', 'Gemini 2.0 Flash Experimental');
alias('gemini-2.0-flash-thinking-exp-01-21', 'Gemini 2.0 Flash Thinking Experimental');
alias('MiniMax M2.1', 'minimax-2.1');

export function canonicalScaleName(value) {
    let name = String(value).replace(/^OpenAI[ /-]+/i, '').trim();
    name = name.replace(/(?<=\d)p(?=\d)/ig, '.');
    const visited = new Set();
    while (aliases.has(nameKey(name))) {
        const key = nameKey(name);
        if (visited.has(key)) throw new Error(`Cyclic model alias: ${value}`);
        visited.add(key); name = aliases.get(key);
        if (nameKey(name) === key) break;
    }
    if (/^(?:opus|sonnet|haiku|fable)[- ]\d/i.test(name)) name = `Claude ${name}`;
    name = name.replace(/^claude[- ](\d+(?:[-.]\d+)?)[- ](opus|sonnet|haiku)/i,
        (_, number, series) => `Claude ${series} ${number.replace('-', '.')}`);
    name = name.replace(/^claude[- ](sonnet|opus|haiku)[- ](\d+(?:[-]\d+)?)$/i,
        (_, series, number) => `Claude ${series} ${number.replace('-', '.')}`);
    return name;
}

function canonicalCandidateName(model) {
    return canonicalScaleName(model.name.replace(/^(?:model:\s*|(?:Meta|Google|Qwen|Anthropic|OpenAI|Amazon|Mistral|Microsoft):\s*)/i, ''));
}

export function resolveScaleModel(record, boardID, state) {
    const identity = scaleRunConfiguration(record, boardID);
    if (!identity.vendorSlug) throw new Error(`Unknown source model provider: ${record.model}`);
    const API = String(record.version ?? '').trim();
    const preciseAPI = /\d{8}|\d{4}-\d{2}-\d{2}|exp-|preview-\d|(?:mistral-large|magistral-medium)-\d{4}|gpt-4-(?:1106|0125|0613)-?/.test(API);
    const apiIdentity = preciseAPI ? scaleRunConfiguration({ ...record, model: API.replace(/^(?:openai|anthropic|google)\//i, '') }, boardID) : null;
    const baseName = canonicalScaleName(apiIdentity?.baseName ?? identity.baseName);
    const keys = new Set([nameKey(baseName)]);
    if (!preciseAPI) keys.add(nameKey(canonicalScaleName(identity.baseName)));
    const vendorIDs = state.tables.organizations.filter(o => o.slug === identity.vendorSlug
        || (identity.vendorSlug === 'zhipu' && o.slug === 'z-ai') || (identity.vendorSlug === 'qwen' && o.slug === 'alibaba')).map(o => Number(o.ID));
    let candidates = state.tables.models.filter(m => vendorIDs.includes(Number(m.vendor_ID))
        && (keys.has(nameKey(canonicalCandidateName(m))) || (Number(m.is_active) === 1
            && keys.has(nameKey(m.slug.replace(/^(?:openai|anthropic|google|meta-llama|meta|qwen|z-ai|deepseek|thinkingmachines|xiaomi|nvidia|mistral|cohere|amazon|moonshotai)[-]/i, ''))))));
    candidates = candidates.sort((a, b) => {
        const priority = m => (!m.slug.startsWith('arena-') && !m.slug.startsWith('model-') ? 10 : 0)
            + (/^(openai|anthropic|google|z-ai|thinkingmachines|qwen|deepseek|meta|nvidia)-/.test(m.slug) ? 5 : 0);
        return Number(b.is_active) - Number(a.is_active) || priority(b) - priority(a) || Number(a.ID) - Number(b.ID);
    });
    for (const [key, value] of Object.entries(apiIdentity?.configuration ?? {})) {
        if (identity.configuration[key] !== undefined && identity.configuration[key] !== value) {
            throw new Error(`Conflicting publisher configuration for ${record.model}: ${key}`);
        }
    }
    return { baseName, vendorSlug: identity.vendorSlug, configuration: { ...apiIdentity?.configuration, ...identity.configuration },
        existingID: candidates[0]?.ID ?? null, candidateIDs: candidates.map(m => m.ID),
        identityRule: preciseAPI ? 'Explicit publisher API version, with curated release aliases' : 'Publisher model name, with curated spelling aliases' };
}
