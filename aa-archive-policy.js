const aaOnlyBenchmarks = new Set([
    'artificial-analysis-long-context-reasoning',
    'automationbench-aa',
    'gdpval-stirrup',
    'terminal-bench hard'
]);

export function aaBenchmarkReason(name) {
    const normalized = String(name ?? '').trim().toLowerCase();
    if (normalized.startsWith('aa-')
        || normalized.startsWith('artificial analysis ')
        || normalized.startsWith('gdpval-aa')) return 'aa_specific_benchmark';
    if (aaOnlyBenchmarks.has(normalized)) return 'aa_specific_evaluation_variant';
    return null;
}

function sourceHost(sourceURL) {
    try {
        return new URL(sourceURL).hostname.toLowerCase();
    } catch {
        return '';
    }
}

const aaHost = host => host === 'artificialanalysis.ai' || host.endsWith('.artificialanalysis.ai')
    || host === 'artificialanalysiscdn.com' || host.endsWith('.artificialanalysiscdn.com');

function provenanceIsAA(value) {
    if (!value || typeof value !== 'object') return false;
    for (const [key, entry] of Object.entries(value)) {
        const field = key.replaceAll('_', '').replaceAll('-', '').toLowerCase();
        if (typeof entry === 'string') {
            if (['originalevaluator', 'operator', 'evaluator'].includes(field)
                && /^(?:aa|artificial[ _-]+analysis)$/i.test(entry.trim())) return true;
            if (field === 'originalsourcehost' && aaHost(entry.trim().toLowerCase())) return true;
            if (['originalsourceurl', 'nativesourceurl'].includes(field) && aaHost(sourceHost(entry))) return true;
        } else if (provenanceIsAA(entry)) return true;
    }
    return false;
}

function evaluationProviderIsAA(assignments, fields) {
    if (typeof assignments === 'string') {
        try { assignments = JSON.parse(assignments); } catch { return false; }
    }
    if (!Array.isArray(assignments)) return false;
    return assignments.some(assignment => {
        const field = fields.find(field => Number(field.ID) === Number(assignment.fieldID));
        const name = String(field?.name ?? '').trim().toLowerCase();
        if (!['published evaluation provider', 'evaluation provider', 'evaluator', 'original evaluator', 'operator'].includes(name)) return false;
        const value = field.type === 'enum'
            ? field.options?.find(option => Number(option.ID) === Number(assignment.value))?.label : assignment.value;
        return typeof value === 'string' && /^(?:aa|artificial[ _-]+analysis)$/i.test(value.trim());
    });
}

export function aaResultReason(row, aaBenchmarkIDs = new Set(), fields = []) {
    if (aaBenchmarkIDs.has(Number(row.benchmark_ID))) return 'aa_specific_benchmark';

    const host = sourceHost(row.source_url);
    if (aaHost(host)) {
        return 'aa_direct_source';
    }
    if (evaluationProviderIsAA(row.scoreFields ?? row.score_fields, fields)) return 'aa_mirrored_result';

    let metadata = row.notes;
    if (typeof metadata === 'string') {
        try { metadata = JSON.parse(metadata); } catch { metadata = null; }
    }
    if (provenanceIsAA(metadata)) return 'aa_mirrored_result';
    // This imported Solar result lost its AA attribution; other SciCode default rows are independent.
    if (Number(row.benchmark_ID ?? row.benchmarkID) === 1334
        && ['upstage.ai', 'www.upstage.ai'].includes(host)
        && sourceHost(row.source_url) && new URL(row.source_url).pathname.replace(/\/$/, '') === '/blog/en/solar-mini-4'
        && (Number(row.ID) === 173021 || metadata?.post_astra_import?.nativeID === 'solar-mini4:SciCode')) {
        return 'aa_mirrored_result';
    }

    const title = String(row.source_title ?? '').toLowerCase();
    const notes = (typeof row.notes === 'object' ? JSON.stringify(row.notes) : String(row.notes ?? '')).toLowerCase();
    if (title.includes('artificial analysis comparison values')
        || notes.includes('"original_evaluator":"artificial analysis"')
        || notes.includes('"original_source_host":"artificialanalysis.ai"')
        || notes.includes('"operator":"artificial analysis"')
        || notes.includes('artificial analysis operator-reported comparator')
        || notes.includes('provider-specific harnesses run by artificial analysis')) {
        return 'aa_mirrored_result';
    }
    if (notes.includes('blended with artificial analysis elo')
        || notes.includes('third-party leaderboard (artificial analysis)')
        || notes.includes('tps sourced from artificial analysis')) {
        return 'possibly_aa_derived_result';
    }
    return null;
}
