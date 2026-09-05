// Synthetic records for the isolated frontend harness; never imported by the app.
export const categories = [
    { ID: 1, name: 'Language models', parentID: null, path: 'Language-models', hasChildren: true, expanded: true,
        children: [{ ID: 2, name: 'Reasoning', parentID: 1, path: 'Language-models/Reasoning' }, { ID: 3, name: 'Coding', parentID: 1, path: 'Language-models/Coding' }] }
];
export const benchmarks = ['General knowledge', 'Advanced reasoning', 'Code generation', 'Mathematics', 'Instruction following', 'Long context', 'Multilingual', 'Tool use'].map((name, index) => ({
    ID: index + 1, rank: index + 1, conditionID: index + 1, benchmarkID: index + 101, name,
    conditionKey: 'default', conditionName: 'default', isDefaultCondition: true,
    tags: [['Knowledge', 'Reasoning', 'Code', 'Math'][index % 4]],
    introductionURL: 'https://example.com/benchmark',
    publicWeight: [26, 22, 18, 14, 10, 6, 4, 0][index], personalWeight: [35, 25, 20, 20, 0, 0, 0, 0][index]
}));
const modelNames = ['Aster Pro', 'Cedar Sonnet', 'Meridian Flash', 'Atlas Large', 'Cedar Opus', 'Aster Mini', 'Meridian Pro', 'Atlas Small'];
export const models = modelNames.map((name, index) => ({
    ID: index + 201, modelID: index + 301, name, vendorName: ['Aster', 'Cedar', 'Meridian', 'Atlas'][index % 4],
    vendorSlug: ['openai', 'anthropic', 'google', 'meta'][index % 4], vendorID: index % 4 + 1,
    modelConditionName: 'default', modelConditionKey: 'default', isDefaultCondition: true,
    lower: 86.2 - index * 3.75, upper: 92.2 - index * 2.1, coverage: 94 - index * 2,
    resultCount: 7, fallbackUsageCount: 0
}));
export function weightedEntries(weights) {
    return weights.map(entry => ({ ...benchmarks.find(item => item.conditionID === entry.conditionID), ...entry, weight: entry.weightBasisPoints / 100 }));
}
export function createFixtureState(options = {}) {
    return {
        authenticated: true, isSenior: true, empty: false, workspaceFailure: null, saveFailure: null,
        workspaceDelay: 0, saveDelay: 0, evidenceDelay: 0, requests: [], revision: 1,
        personalEntries: weightedEntries(benchmarks.slice(0, 4).map(item => ({ conditionID: item.conditionID, weightBasisPoints: item.personalWeight * 100 }))),
        fallbackRules: [], logs: [{ ID: 901, status: 'pending', content: { type: 'feedback', details: 'Please make score sources easier to inspect.', pageURL: 'https://example.com/' }, created_at: '2026-09-01T08:00:00Z', userName: 'Preview contributor' }],
        ...options
    };
}
export function workspace(state, body) {
    const category = [categories[0], ...categories[0].children].find(item => item.ID === Number(body.categoryID)) ?? categories[0];
    const selectedKey = body.contextValues?.budget ?? 'standard';
    return {
        authenticated: state.authenticated,
        context: { categoryID: category.ID, categoryPath: category.path, categoryName: category.name,
            contextValues: { budget: selectedKey }, dimensions: [{ key: 'budget', name: 'Budget', selectedKey,
                options: [{ key: 'standard', name: 'Standard' }, { key: 'extended', name: 'Extended' }] }] },
        personalPie: { revision: state.revision, isDraft: false, editable: state.authenticated,
            entries: state.empty || !state.authenticated ? [] : state.personalEntries,
            fallbackRules: state.empty || !state.authenticated ? [] : state.fallbackRules },
        publicPie: { participantCount: 128, isFallback: false, fallbackRules: [],
            entries: state.empty ? [] : weightedEntries(benchmarks.filter(item => item.publicWeight).map(item => ({ conditionID: item.conditionID, weightBasisPoints: item.publicWeight * 100 }))) },
        benchmarks: state.empty ? [] : benchmarks,
        modelLeaderboards: { public: state.empty ? [] : models, personal: state.empty || !state.authenticated ? [] : models.map(item => ({ ...item, lower: item.lower - 2 })) },
        scoreScale: { min: 0, max: 100 }, limits: { totalBasisPoints: 10000, maxPieItems: 100 }, serverTime: new Date().toISOString()
    };
}
export function catalog() {
    return {
        benchmarks: benchmarks.map(item => ({ ...item, ID: item.benchmarkID,
            conditions: [{ ID: item.conditionID, name: 'default', key: 'default', isDefault: true, usesPercentageScale: true, scoreMin: 0, scoreMax: 100, scoreDirection: 'higher' }] })),
        models: models.map(item => ({ ...item, ID: item.modelID, conditions: [{ ID: item.ID, name: 'default', key: 'default', isDefault: true }] })),
        vendors: ['Aster', 'Cedar', 'Meridian', 'Atlas'].map((name, i) => ({ ID: i + 1, name })),
        categories: [categories[0], ...categories[0].children], knownTags: [{ name: 'Reasoning' }, { name: 'Knowledge' }], rankingDimensions: []
    };
}
export function approvedResults(body) {
    const model = models.find(item => item.ID === body.modelConditionID);
    return { model: { modelID: model.modelID, modelConditionID: model.ID, modelName: model.name, vendorName: model.vendorName, modelConditionName: 'default' },
        scoreGroups: benchmarks.slice(0, 5).map((item, index) => ({
            benchmarkConditionID: item.conditionID, benchmarkName: item.name, benchmarkConditionName: 'default', benchmarkConditionIsDefault: true,
            medianRawScore: 89 - index * 2, medianNormalizedScore: 89 - index * 2, usesPercentageScale: true, sampleCount: 2,
            samples: [0, 1].map(sample => ({ ID: 501 + index * 2 + sample, rawScore: 88 - index * 2 + sample * 2, normalizedScore: 88 - index * 2 + sample * 2,
                sourceURL: 'https://example.com/evidence', sourceTitle: 'Evaluation report (synthetic fixture)', sourceType: 'independent', createdAt: '2026-09-01T08:00:00Z' }))
        })) };
}
