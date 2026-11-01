const aaBenchmarks = new Set([
    'artificial-analysis-long-context-reasoning', 'automationbench-aa',
    'gdpval-stirrup', 'terminal-bench hard'
]);
// Audited AA variants whose current display names no longer identify their operator.
// Scope keys to the benchmark identity so a similarly named independent version stays available.
const aaVersions = new Set([
    '1152:crawl-5fbb9c71e353ee518fb5ccba', // MMMU-Pro, AA Standard-10 before May corrections.
    '1152:crawl-a18a684f6a452ca14ea603b6', // MMMU-Pro, Thinking Machines republication of AA results.
    '1313:verified-anthropic-120-held-out-tasks-all-pass',
    '1313:verified-anthropic-120-held-out-tasks-criteria-pass-rate',
    '1334:verified-pass-1', // SciCode Verified, publisher chart evaluated by AA.
    '1428:crawl-151562e6b464d951cfafd948', // Tau3-Banking, publisher comparison sourced from AA.
    '1489:end-to-end-reproduction-and-patching', // CyberGym-E2E, AA task variant.
    '1655:crawl-2c79c5b97186b2b435e8cf01', // VibeDex composite incorporating AA Elo.
    '1687:crawl-6c6f1535abb4a0c68af896bc' // HLE, BenchmarkList republication of the AA API.
]);
export const AA_EXCLUSION_MESSAGE = 'Artificial Analysis benchmarks and versions do not count in rankings.';
export const AA_DISPLAY_RESTRICTION = 'artificial_analysis';
export const AA_DISPLAY_MESSAGE = "To respect Artificial Analysis's data-use terms, details and scores for this benchmark version are not displayed here.";

export function isAABenchmark(name) {
    const value = String(name ?? '').trim().toLowerCase();
    return /(?:^|[^a-z0-9])aa(?:$|[^a-z0-9])/i.test(value)
        || /^artificial[\s_-]+analysis(?:$|[\s_-])/.test(value) || aaBenchmarks.has(value);
}

export function isAACondition(condition) {
    const benchmark = condition?.baseName ?? condition?.benchmarkName ?? condition?.name;
    const benchmarkID = Number(condition?.benchmarkID ?? condition?.benchmark_ID);
    const key = String(condition?.conditionKey ?? condition?.condition_key ?? condition?.benchmarkConditionKey ?? '').trim().toLowerCase();
    const name = String(condition?.conditionName ?? condition?.condition_name ?? condition?.benchmarkConditionName ?? '').trim();
    const source = String(condition?.scoreSource ?? condition?.score_source ?? '').trim().toLowerCase();
    return isAABenchmark(benchmark) || /^aa(?:[-_]|$)/.test(key)
        || aaVersions.has(`${benchmarkID}:${key}`)
        || /^(?:aa|artificial[\s_-]*analysis)(?:$|[\s_-])/.test(source)
        || /\bartificial[\s_-]+analysis\b/i.test(name)
        || /(?:^|[^a-z0-9])aa(?:$|[^a-z0-9])/i.test(name);
}

export const excludedFromRanking = condition => condition?.excludedFromRanking === true || isAACondition(condition);
export const hasAADisplayRestriction = condition => condition?.displayRestriction === AA_DISPLAY_RESTRICTION || isAACondition(condition);
