import { fieldKey, fieldDisplayValue, comparisonValueEligible, normalizeValueFilters, matchesValueFilters } from './public/js/shared/score-fields.js';
import { adaptRunComparison } from './public/js/shared/score-field-presets.js';

const fail = error => { throw { status: 400, body: { error } }; };
const average = values => values.reduce((sum, value) => sum + value / values.length, 0);

export function comparisonGroupIsComparable(group, groupCount, mode, weightedEntries) {
    return mode === 'best' || (groupCount > 1
        && weightedEntries.some(entry => entry.weightBasisPoints > 0 && group.results.has(String(entry.conditionID))));
}

export function comparisonOptions(models, input = null, fields = []) {
    const availableKeys = ['model', ...new Set([...fields.map(field => fieldKey(field.ID)), ...models.flatMap(model => Object.keys(model.condition.parameters ?? {}))])].sort();
    const options = input == null ? { mode: 'best', keys: ['model'] } : adaptRunComparison(input, fields);
    if (!options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some(key => !['mode', 'keys', 'filters'].includes(key))) fail('invalid_comparison_options');
    if (!['best', 'matched'].includes(options.mode) || !Array.isArray(options.keys)
        || options.keys.some(key => typeof key !== 'string' || !key.trim()) || new Set(options.keys).size !== options.keys.length) fail('invalid_comparison_keys');
    if (options.keys.some(key => !availableKeys.includes(key))) {
        throw { status: 400, body: { error: 'comparison_keys_unavailable', availableKeys,
            unconfiguredCount: models.filter(model => model.condition.parameters === null).length } };
    }
    if (options.mode === 'matched' && options.keys.length === 0) fail('comparison_key_required');
    let filters;
    try { filters = normalizeValueFilters(options.filters ?? [], availableKeys, fields); }
    catch (error) { fail(error.message); }
    if (filters.some(filter => filter.key === 'model' && !models.some(model => model.modelID === filter.value))) fail('comparison_model_unavailable');
    return { mode: options.mode, keys: [...options.keys].sort(), filters, availableKeys, fields,
        models: [...new Map(models.map(model => [model.modelID, { ID: model.modelID, name: model.modelName, vendor: model.vendor }])).values()],
        unconfiguredCount: models.filter(model => model.condition.parameters === null).length };
}

// Best-performance groups retain unknown values; matched controls still require eligible evidence.
export function groupComparisonModels(models, options, weightedEntries, { includeReferenceVersions = false } = {}) {
    const groupKeys = options.keys;
    const groups = new Map();
    const descriptors = new Map();
    const selectedFields = (options.fields ?? []).filter(field => groupKeys.includes(fieldKey(field.ID)));
    for (const model of models) {
        const parameters = model.condition.parameters;
        const values = { ...parameters, model: model.modelID };
        if (!matchesValueFilters(values, options.filters ?? [])) continue;
        if (selectedFields.some(field => {
            const key = fieldKey(field.ID);
            const unspecified = !Object.hasOwn(values, key) || values[key] === null;
            return !(options.mode === 'best' && unspecified) && !comparisonValueEligible(field, values);
        })) continue;
        const projection = groupKeys.map(key => [key, Object.hasOwn(values, key), values[key] ?? null]);
        const signature = JSON.stringify(projection);
        if (!groups.has(signature)) {
            const label = projection.map(([key, present, value]) => {
                if (key === 'model') return model.modelName;
                const field = options.fields?.find(item => fieldKey(item.ID) === key);
                if (!present) return `${field?.name ?? key}=Not recorded`;
                return field ? `${field.name}=${fieldDisplayValue(field, value)}` : `${key}=${value ?? 'Empty'}`;
            }).join(' / ');
            groups.set(signature, { ...model, comparisonIdentity: signature, name: label || 'All configurations', members: [], results: new Map(), comparisonScores: [], comparable: true });
        }
        groups.get(signature).members.push(model);
        descriptors.set(model.ID, { parameters, values });
    }
    const result = [...groups.values()];
    if (options.mode === 'best') {
        for (const group of result) {
            const bestByBenchmark = new Map();
            for (const member of group.members) {
                for (const [benchmarkKey, score] of member.results) {
                    const previous = bestByBenchmark.get(benchmarkKey);
                    if (!previous || score.normalizedScore > previous.normalizedScore) {
                        bestByBenchmark.set(benchmarkKey, {
                            normalizedScore: score.normalizedScore, memberIDs: [member.ID]
                        });
                    } else if (score.normalizedScore === previous.normalizedScore) {
                        previous.memberIDs.push(member.ID);
                    }
                }
            }
            for (const [benchmarkKey, best] of bestByBenchmark) {
                group.results.set(benchmarkKey, { normalizedScore: best.normalizedScore });
                group.comparisonScores.push({ conditionID: Number(benchmarkKey),
                    normalizedScore: best.normalizedScore, memberIDs: best.memberIDs, matchedCount: null,
                    memberWeights: best.memberIDs.map(ID => ({ ID, weight: 1 / best.memberIDs.length })) });
            }
            group.comparisonScores.sort((left, right) => left.conditionID - right.conditionID);
        }
    } else {
        const weightedConditions = includeReferenceVersions ? new Set(models.flatMap(model => [...model.results.keys()]))
            : new Set(weightedEntries.filter(entry => entry.weightBasisPoints > 0).map(entry => String(entry.conditionID)));
        const recordedByBenchmark = new Map();
        for (const group of result) {
            for (const member of group.members) {
                for (const benchmarkKey of member.results.keys()) {
                    if (!weightedConditions.has(benchmarkKey)) continue;
                    if (!recordedByBenchmark.has(benchmarkKey)) recordedByBenchmark.set(benchmarkKey, new Set());
                    for (const key of Object.keys(descriptors.get(member.ID).values)) recordedByBenchmark.get(benchmarkKey).add(key);
                }
            }
        }
        const controlsByBenchmark = new Map([...recordedByBenchmark].map(([key, recorded]) => [key,
            (options.fields ?? []).filter(field => !groupKeys.includes(fieldKey(field.ID)) && recorded.has(fieldKey(field.ID)))]));
        const cellsByBenchmark = new Map();
        result.forEach((group, index) => {
            for (const member of group.members) {
                const { parameters, values } = descriptors.get(member.ID);
                if (parameters === null || groupKeys.some(key => !Object.hasOwn(values, key)
                    && !(options.fields ?? []).some(field => fieldKey(field.ID) === key && !field.excludeMissing))) continue;
                // An absent control key never matches an explicitly recorded value.
                const controls = Object.keys(values).filter(key => !groupKeys.includes(key));
                const signature = JSON.stringify(controls.sort().map(key => [key, Object.hasOwn(values, key), values[key] ?? null]));
                for (const benchmarkKey of member.results.keys()) {
                    if (!weightedConditions.has(benchmarkKey)
                        || controlsByBenchmark.get(benchmarkKey).some(field => !comparisonValueEligible(field, values))) continue;
                    if (!cellsByBenchmark.has(benchmarkKey)) cellsByBenchmark.set(benchmarkKey, new Map());
                    const cells = cellsByBenchmark.get(benchmarkKey);
                    if (!cells.has(index)) cells.set(index, new Map());
                    const cell = cells.get(index);
                    if (!cell.has(signature)) cell.set(signature, []);
                    cell.get(signature).push(member);
                }
            }
        });
        for (const [benchmarkKey, cells] of cellsByBenchmark) {
            // A single outlier must not destroy a larger, strictly matched comparison.
            const cohorts = new Map();
            for (const [index, cell] of cells) for (const signature of cell.keys()) {
                if (!cohorts.has(signature)) cohorts.set(signature, []);
                cohorts.get(signature).push(index);
            }
            const candidates = new Map();
            for (const participants of cohorts.values()) {
                if (participants.length < 2) continue;
                const indices = participants.sort((a, b) => a - b);
                const identity = indices.map(index => JSON.stringify(groupKeys.map(key => {
                    const values = descriptors.get(result[index].members[0].ID).values;
                    return [key, Object.hasOwn(values, key), values[key] ?? null];
                }))).sort();
                const key = JSON.stringify(identity);
                if (!candidates.has(key)) candidates.set(key, { indices, identity: key, common: [] });
            }
            for (const candidate of candidates.values()) {
                candidate.common = [...cells.get(candidate.indices[0]).keys()]
                    .filter(key => candidate.indices.every(index => cells.get(index).has(key))).sort();
            }
            const selected = [...candidates.values()].sort((a, b) => b.indices.length - a.indices.length
                || b.common.length - a.common.length || a.identity.localeCompare(b.identity))[0];
            const participants = selected?.indices.map(index => ({ index })) ?? [];
            const common = selected?.common ?? [];
            if (!common.length) continue;
            participants.forEach(({ index }) => {
                const group = result[index];
                const value = average(common.map(key => average(cells.get(index).get(key).map(member => member.results.get(benchmarkKey).normalizedScore))));
                group.results.set(benchmarkKey, { normalizedScore: value });
                group.comparisonScores.push({ conditionID: Number(benchmarkKey), normalizedScore: value, matchedCount: common.length,
                    memberIDs: common.flatMap(key => cells.get(index).get(key).map(member => member.ID)),
                    memberWeights: common.flatMap(key => cells.get(index).get(key).map(member => ({ ID: member.ID,
                        weight: 1 / common.length / cells.get(index).get(key).length }))) });
            });
        }
    }
    for (const group of result) {
        const membersByID = new Map(group.members.map(member => [member.ID, member]));
        for (const score of group.comparisonScores) score.memberEvidence = score.memberIDs.flatMap(ID => {
            const hash = membersByID.get(ID).results.get(String(score.conditionID)).evidenceHash;
            return hash ? [{ ID, hash }] : [];
        });
    }
    return result.map(group => ({ ...group,
        comparable: comparisonGroupIsComparable(group, result.length, options.mode, weightedEntries),
        comparisonMode: options.mode,
        members: group.members.map(member => ({ ID: member.ID, modelID: member.modelID, name: member.name,
            condition: member.condition, vendor: member.vendor, vendorSlug: member.vendorSlug, logoKey: member.logoKey }))
    }));
}
