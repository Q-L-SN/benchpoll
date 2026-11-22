export function calibrationModel(ID, scores, parameters = {}, metadata = {}) {
    return { ID, modelID: ID, name: 'Model ' + ID, modelName: 'Model ' + ID, condition: { parameters, scoreFields: [] },
        results: new Map(Object.entries(scores).map(([key, normalizedScore]) => [key, { normalizedScore }])), ...metadata };
}

// Five distinct, bracketing models with a known directional offset.
export function pairedModels(primary, source, center, offset = 0, parameters = {}) {
    return [-4, -2, 0, 2, 4].map((step, index) => calibrationModel(1001 + index,
        { [primary]: center + step + offset, [source]: center + step }, parameters));
}
