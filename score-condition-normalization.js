import { canonicalNumber } from './public/js/shared/score-fields.js';

const CONFIGURATION_KEYS = new Map([
    ['harness', ['Agent harness', 'text']],
    ['agent', ['Agent harness', 'text']],
    ['first_stage', ['Retriever', 'text']],
    ['configuration', ['Configuration selection', 'text']],
    ['model_variant', ['Model variant', 'text']],
    ['model_label', ['Model variant', 'text']],
    ['sequence_length', ['Sequence length', 'number']],
    ['route', ['Serving route', 'text']],
    ['tools', ['Tool configuration', 'text']],
    ['client', ['Client', 'text']],
    ['configured_effort', ['Configured effort', 'text']],
    ['experiment', ['Experiment', 'text']],
    ['autonudge', ['AutoNudge', 'text']],
    ['turn_budget', ['Turn budget', 'number']],
    ['embedding_dim', ['Embedding dimension', 'number']],
    ['temperature', ['Temperature', 'number']],
    ['top_p', ['Top-p', 'number']],
    ['reasoning effort', ['Reasoning effort', 'enum']],
    ['reasoning_mode', ['Reasoning mode', 'enum']]
]);

const OMNISCIENCE_INDEX_NAMES = new Set([
    'snapshot20260919;metric=index',
    '2025-11-16 launch;metric=index',
    'Omniscience index;not accuracy',
    'index not accuracy',
    'AA-Omniscience Index;native index range -100 to 100;2026-09-23',
    'AA-Omniscience;Index (-100 to 100);2026-03-25 release article'
]);
const OMNISCIENCE_ACCURACY_NAMES = new Set([
    'AA-Omniscience',
    'snapshot20260919;metric=accuracy',
    'Accuracy',
    'accuracy;rounded chart percentage;2026-04-08 snapshot',
    '2025-11-16 launch;metric=accuracy',
    'accuracy;not index',
    'accuracy;not Omniscience index;native radar radar-inkling',
    'accuracy;not Omniscience index;native radar radar-small',
    'AA-Omniscience, accuracy;QAD study final recipe'
]);
const OMNISCIENCE_HALLUCINATION_NAMES = new Set([
    'hallucination rate;official prose snapshot;exact AA harness/version unspecified',
    '2025-11-16 launch;metric=hallucination_rate',
    'AA-Omniscience;hallucination rate;2026-03-25 release article',
    'hallucination rate',
    'snapshot20260919;metric=hallucinationRate'
]);
const OMNISCIENCE_NON_HALLUCINATION_NAMES = new Set([
    'non-hallucination=1-hallucination;rounded chart percentage;2026-04-08 snapshot',
    'Non-Hallucination',
    'AA-Omniscience, non-halluc.;QAD study final recipe'
]);

export const REQUIRED_SCORE_FIELDS = [
    ['Model variant', 'text'],
    ['Client', 'text'],
    ['Configured effort', 'text'],
    ['Experiment', 'text'],
    ['AutoNudge', 'text'],
    ['Turn budget', 'number'],
    ['Embedding dimension', 'number'],
    ['Sequence length', 'number']
];

function scoreSignature(condition) {
    return JSON.stringify([condition.score_direction, condition.target_value,
        Number(condition.uses_percentage_scale), condition.score_min, condition.score_max]);
}

function fieldValue(value, type, options) {
    if (type === 'text') return value;
    if (type === 'number') {
        if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return null;
        try { return canonicalNumber(value); }
        catch { return null; }
    }
    return options.find(option => option.label.toLowerCase() === value.toLowerCase())?.ID ?? null;
}

export function extractScoreConfiguration(condition, fieldsByName) {
    if (Number(condition.is_default)) return null;
    if (condition.benchmark_name === 'AA-Omniscience') {
        const name = String(condition.name);
        const index = OMNISCIENCE_INDEX_NAMES.has(name)
            && condition.score_direction === 'higher'
            && Number(condition.uses_percentage_scale) === 0
            && Number(condition.score_min) === -100 && Number(condition.score_max) === 100;
        const accuracy = (OMNISCIENCE_ACCURACY_NAMES.has(name)
            || /^AA metric=AA-Omniscience Accuracy;OpenRouter-rendered AA snapshot=2026-09-23;revision_condition=.+$/.test(name))
            && condition.score_direction === 'higher'
            && Number(condition.uses_percentage_scale) === 1
            && condition.score_min == null && condition.score_max == null;
        const hallucination = OMNISCIENCE_HALLUCINATION_NAMES.has(name)
            && condition.score_direction === 'lower'
            && Number(condition.uses_percentage_scale) === 1
            && condition.score_min == null && condition.score_max == null;
        const nonHallucination = (OMNISCIENCE_NON_HALLUCINATION_NAMES.has(name)
            || /^AA metric=AA-Omniscience Non-Hallucination Rate;OpenRouter-rendered AA snapshot=2026-09-23;revision_condition=.+$/.test(name))
            && condition.score_direction === 'higher'
            && Number(condition.uses_percentage_scale) === 1
            && condition.score_min == null && condition.score_max == null;
        if (index || accuracy || hallucination || nonHallucination) {
            const normalized = index ? 'Index' : accuracy ? 'Accuracy'
                : hallucination ? 'Hallucination rate' : 'Non-hallucination rate';
            return { name: normalized, assignments: [], canonical: normalized.toLowerCase() };
        }
    }
    const retained = [];
    const assignments = new Map();
    let removedProvenance = 0;
    const clauses = String(condition.name ?? '').split(';');
    let operatorRowIndex = -1;
    if (condition.benchmark_name === 'Terminal-Bench 4.0') {
        operatorRowIndex = clauses.findIndex(part => /^\s*operator leaderboard row=[0-9a-f-]{36}\s*$/i.test(part));
        if (operatorRowIndex >= 1) {
            const match = clauses[operatorRowIndex - 1].trim().match(/^(.+?)@(.+)$/);
            const harness = fieldsByName.get('harness') ?? fieldsByName.get('agent harness');
            const version = fieldsByName.get('harness version') ?? fieldsByName.get('agent harness version');
            if (!match || !match[1].trim() || !match[2].trim()
                || !['text', 'enum'].includes(harness?.type) || version?.type !== 'text') return null;
            const value = fieldValue(match[1].trim(), harness.type, harness.options ?? []);
            if (value === null) return null;
            assignments.set(harness.name, value);
            assignments.set(version.name, match[2].trim());
        }
    }
    for (const [index, raw] of clauses.entries()) {
        if (index === operatorRowIndex || index === operatorRowIndex - 1 && operatorRowIndex >= 1) {
            if (index === operatorRowIndex) removedProvenance++;
            continue;
        }
        const clause = raw.trim();
        const separator = clause.indexOf('=');
        const key = separator < 0 ? '' : clause.slice(0, separator).trim().toLowerCase();
        if (condition.benchmark_name === 'PinchBench' && ['run_id', 'listed_time'].includes(key)) {
            if (!clause.slice(separator + 1).trim()) return null;
            removedProvenance++;
            continue;
        }
        if (condition.benchmark_name === 'Context Arena' && key === 'reasoning_mode'
            && clause.slice(separator + 1).trim().toLowerCase() === 'not_reported') {
            removedProvenance++;
            continue;
        }
        const definition = CONFIGURATION_KEYS.get(key);
        if (!definition) {
            if (clause) retained.push(clause);
            continue;
        }
        const [fieldName, type] = definition;
        const alias = { 'Agent harness': 'harness', 'Reasoning effort': 'effort' }[fieldName];
        const field = fieldsByName.get(alias) ?? fieldsByName.get(fieldName.toLowerCase());
        const rawValue = clause.slice(separator + 1).trim();
        if (!rawValue || !field || field.type !== type && !(alias === 'harness' && field.type === 'enum')) return null;
        const value = fieldValue(rawValue, field.type, field.options ?? []);
        if (value === null) return null;
        const existing = assignments.get(field.name);
        if (existing !== undefined && existing !== value) return null;
        assignments.set(field.name, value);
    }
    if (!assignments.size && !removedProvenance) return null;
    const name = retained.join('; ');
    if (!name || name.length > 192 || name.toLowerCase() === 'default') return null;
    return { name, assignments: [...assignments].map(([fieldName, value]) => ({ fieldName, value })),
        canonical: retained.map(part => part.toLowerCase().replace(/\s+/g, ' ')).sort().join(';') };
}

function matching(existing, requested) {
    return existing === requested || typeof existing === 'string' && typeof requested === 'string'
        && existing.trim().toLowerCase() === requested.trim().toLowerCase();
}

export function buildScoreConfigurationPlan(conditions, results, fields) {
    const fieldsByName = new Map(fields.map(field => [field.name.toLowerCase(), field]));
    const rowsByCondition = new Map();
    for (const result of results) {
        const ID = Number(result.conditionID);
        if (!rowsByCondition.has(ID)) rowsByCondition.set(ID, []);
        rowsByCondition.get(ID).push(result);
    }
    const normalized = new Map();
    const fieldUpdates = [];
    const skipped = { invalidConfiguration: 0, conflictingScoreFields: 0, incompatibleScoreScale: 0,
        protectedGroups: 0 };
    for (const condition of conditions) {
        const parsed = extractScoreConfiguration(condition, fieldsByName);
        if (!parsed) {
            if (String(condition.name).split(';').some(part => CONFIGURATION_KEYS.has(part.split('=')[0].trim().toLowerCase()))) {
                skipped.invalidConfiguration++;
            }
            continue;
        }
        const updates = [];
        let conflict = false;
        for (const result of rowsByCondition.get(Number(condition.ID)) ?? []) {
            const assignments = typeof result.scoreFields === 'string'
                ? JSON.parse(result.scoreFields) : result.scoreFields;
            const additions = [];
            for (const entry of parsed.assignments) {
                const field = fieldsByName.get(entry.fieldName.toLowerCase());
                const existing = assignments.find(item => Number(item.fieldID) === Number(field.ID));
                if (existing && !matching(existing.value, entry.value)) {
                    conflict = true;
                    break;
                }
                if (!existing) additions.push(entry);
            }
            if (conflict) break;
            if (additions.length) updates.push({ resultID: Number(result.resultID),
                conditionID: Number(condition.ID), additions });
        }
        if (conflict) {
            skipped.conflictingScoreFields++;
            continue;
        }
        normalized.set(Number(condition.ID), parsed);
        fieldUpdates.push(...updates);
    }

    const groups = new Map();
    const names = new Map();
    for (const condition of conditions) {
        const ID = Number(condition.ID);
        const parsed = normalized.get(ID);
        const name = parsed?.name ?? String(condition.name);
        const canonical = parsed?.canonical ?? name.split(';').map(part => part.trim().toLowerCase().replace(/\s+/g, ' ')).sort().join(';');
        const nameKey = JSON.stringify([Number(condition.benchmark_ID), canonical]);
        if (!names.has(nameKey)) names.set(nameKey, []);
        names.get(nameKey).push(condition);
        const key = JSON.stringify([nameKey, scoreSignature(condition)]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(condition);
    }
    const merges = [];
    const renames = [];
    const protectedIDs = new Set(conditions.filter(item => item.protected).map(item => Number(item.ID)));
    const skippedIDs = new Set();
    for (const members of names.values()) {
        if (new Set(members.map(scoreSignature)).size > 1) {
            skipped.incompatibleScoreScale += members.length;
            for (const item of members) skippedIDs.add(Number(item.ID));
        }
    }
    for (const group of groups.values()) {
        const changed = group.filter(item => normalized.has(Number(item.ID)) && !skippedIDs.has(Number(item.ID)));
        if (!changed.length) continue;
        if (group.some(item => skippedIDs.has(Number(item.ID)))) continue;
        const protectedMembers = group.filter(item => protectedIDs.has(Number(item.ID)));
        if (protectedMembers.length > 1) {
            skipped.protectedGroups++;
            continue;
        }
        const sorted = [...group].sort((a, b) => Number(protectedIDs.has(Number(b.ID))) - Number(protectedIDs.has(Number(a.ID)))
            || Number(normalized.has(Number(a.ID))) - Number(normalized.has(Number(b.ID)))
            || Number(b.resultCount) - Number(a.resultCount) || Number(a.ID) - Number(b.ID));
        const survivor = sorted[0];
        const survivorName = normalized.get(Number(survivor.ID))?.name ?? survivor.name;
        if (survivorName !== survivor.name) renames.push({ ID: Number(survivor.ID), name: survivorName });
        for (const source of sorted.slice(1)) merges.push({ sourceID: Number(source.ID), targetID: Number(survivor.ID),
            resultCount: Number(source.resultCount) });
    }
    const acceptedIDs = new Set([...renames.map(item => item.ID), ...merges.map(item => item.sourceID)]);
    const applicableFieldUpdates = fieldUpdates.filter(item => acceptedIDs.has(item.conditionID));
    merges.sort((a, b) => a.sourceID - b.sourceID);
    renames.sort((a, b) => a.ID - b.ID);
    applicableFieldUpdates.sort((a, b) => a.resultID - b.resultID);
    return { merges, renames, fieldUpdates: applicableFieldUpdates, skipped,
        renamedConditions: renames.length, mergedConditions: merges.length };
}
