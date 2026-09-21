import { normalizeModelParameters } from './public/js/shared/model-parameters.js';

const fail = error => { throw { status: 400, body: { error } }; };
const average = values => values.reduce((sum, value) => sum + value / values.length, 0);

export function comparisonOptions(models, input = null) {
    const availableKeys = ['model', ...new Set(models.flatMap(model => Object.keys(model.condition.parameters ?? {})))].sort();
    const options = input ?? { mode: 'best', keys: [] };
    if (!options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some(key => !['mode', 'keys'].includes(key))) fail('invalid_comparison_options');
    if (!['best', 'matched'].includes(options.mode) || !Array.isArray(options.keys)
        || options.keys.some(key => typeof key !== 'string' || !key.trim()) || new Set(options.keys).size !== options.keys.length) fail('invalid_comparison_keys');
    if (options.keys.some(key => !availableKeys.includes(key))) {
        throw { status: 400, body: { error: 'comparison_keys_unavailable', availableKeys,
            unconfiguredCount: models.filter(model => model.condition.parameters === null).length } };
    }
    if (options.mode === 'matched' && options.keys.length === 0) fail('comparison_key_required');
    return { mode: options.mode, keys: [...options.keys].sort(), availableKeys,
        unconfiguredCount: models.filter(model => model.condition.parameters === null).length };
}

// Group only observed configurations. Unrecorded values are never evidence of equality.
export function groupComparisonModels(models, options, weightedEntries) {
    const groupKeys = options.mode === 'best'
        ? options.availableKeys.filter(key => !options.keys.includes(key))
        : options.keys;
    const groups = new Map();
    const descriptors = new Map();
    for (const model of models) {
        const parameters = model.condition.parameters === null ? null : normalizeModelParameters(model.condition.parameters);
        const values = { ...parameters, model: model.modelID };
        const projection = groupKeys.map(key => [key, values[key] ?? null]);
        const signature = JSON.stringify(projection);
        if (!groups.has(signature)) {
            const label = projection.map(([key, value]) => key === 'model' ? model.modelName : `${key}=${value ?? 'Unknown'}`).join(' / ');
            groups.set(signature, { ...model, name: label || 'All configurations', members: [], results: new Map(), comparisonScores: [], comparable: true });
        }
        groups.get(signature).members.push(model);
        descriptors.set(model.ID, { parameters, values });
    }
    const result = [...groups.values()];
    const benchmarkKeys = new Set(models.flatMap(model => [...model.results.keys()]));
    for (const benchmarkKey of benchmarkKeys) {
        if (options.mode === 'best') {
            for (const group of result) {
                const candidates = group.members.filter(member => member.results.has(benchmarkKey));
                if (!candidates.length) continue;
                const best = Math.max(...candidates.map(member => member.results.get(benchmarkKey).normalizedScore));
                group.results.set(benchmarkKey, { normalizedScore: best });
                group.comparisonScores.push({ conditionID: Number(benchmarkKey), normalizedScore: best,
                    memberIDs: candidates.filter(member => member.results.get(benchmarkKey).normalizedScore === best).map(member => member.ID), matchedCount: null });
            }
            continue;
        }
        const cells = result.map(group => {
            const map = new Map();
            for (const member of group.members) {
                const { parameters, values } = descriptors.get(member.ID);
                if (parameters === null || !member.results.has(benchmarkKey) || groupKeys.some(key => !Object.hasOwn(values, key))) continue;
                // Compare complete recorded control maps, not the global catalog's key union.
                // An absent key never matches an explicitly recorded value for that key.
                const signature = JSON.stringify(Object.keys(values).filter(key => !groupKeys.includes(key))
                    .sort().map(key => [key, values[key]]));
                if (!map.has(signature)) map.set(signature, []);
                map.get(signature).push(member);
            }
            return map;
        });
        const participants = cells.map((cell, index) => ({ cell, index })).filter(({ cell }) => cell.size > 0);
        const common = participants.length < 2 ? [] : [...participants[0].cell.keys()]
            .filter(key => participants.every(({ cell }) => cell.has(key)));
        if (!common.length) continue;
        participants.forEach(({ index }) => {
            const group = result[index];
            const value = average(common.map(key => average(cells[index].get(key).map(member => member.results.get(benchmarkKey).normalizedScore))));
            group.results.set(benchmarkKey, { normalizedScore: value });
            group.comparisonScores.push({ conditionID: Number(benchmarkKey), normalizedScore: value, matchedCount: common.length,
                memberIDs: common.flatMap(key => cells[index].get(key).map(member => member.ID)) });
        });
    }
    return result.map(group => ({ ...group,
        comparable: options.mode === 'best' || (result.length > 1 && weightedEntries.some(entry => entry.weightBasisPoints > 0) && weightedEntries.filter(entry => entry.weightBasisPoints > 0)
            .every(entry => group.results.has(String(entry.conditionID)))),
        comparisonMode: options.mode,
        members: group.members.map(member => ({ ID: member.ID, modelID: member.modelID, name: member.name,
            condition: member.condition, vendor: member.vendor, vendorSlug: member.vendorSlug, logoKey: member.logoKey }))
    }));
}
