import { comparisonOptions } from '../../model-comparison.js';
import { scoreComparison } from '../../ranking-service.js';
import { createRankingPager } from '../../ranking-pagination.js';
import { availableResultInference, AVAILABLE_INFERENCE_VERSION } from '../../public/js/shared/available-score.js';
import { familyKey } from '../../public/js/shared/benchmark-families.js';
// Synthetic records for the isolated frontend harness; never imported by the app.
const fixtureRankingPager = createRankingPager();
export function rankingPage(state, body) {
    return fixtureRankingPager.getPage({ ...body, userID: state.authenticated ? state.userID : null });
}
export function rankingModelLocation(state, body) {
    return fixtureRankingPager.locateModel({ ...body, userID: state.authenticated ? state.userID : null });
}
export function rankingModelSearch(state, body) {
    return fixtureRankingPager.searchModels({ ...body, userID: state.authenticated ? state.userID : null });
}
export const categories = [
    { ID: 1, name: 'Language models', parentID: null, path: 'Language-models', hasChildren: true, expanded: true,
        children: [{ ID: 2, name: 'Reasoning', parentID: 1, path: 'Language-models/Reasoning' }, { ID: 3, name: 'Coding', parentID: 1, path: 'Language-models/Coding' }] }
];
export const benchmarks = ['General knowledge', 'Advanced reasoning', 'Code generation', 'Mathematics', 'Instruction following', 'Long context', 'Multilingual', 'Tool use'].map((name, index) => ({
    ID: index + 1, rank: index + 1, conditionID: index + 1, benchmarkID: index + 101, name,
    conditionKey: 'default', conditionName: 'default', isDefaultCondition: true, isPrimaryCondition: true,
    scoreCount: 8 + index, scoredModelCount: 6 + index, lowCoverage: false,
    tags: [['Knowledge', 'Reasoning', 'Code', 'Math'][index % 4]],
    introductionURL: 'https://example.com/benchmark',
    publicWeight: [26, 22, 18, 14, 10, 6, 4, 0][index], personalWeight: [35, 25, 20, 20, 0, 0, 0, 0][index]
}));
export const secondaryBenchmark = { ...benchmarks[0], ID: 901, conditionID: 901, conditionKey: 'extended',
    conditionName: 'Extended', isDefaultCondition: false, isPrimaryCondition: false,
    scoreCount: 6, scoredModelCount: 4, publicWeight: 0, personalWeight: null };
export const sparseBenchmark = { ...benchmarks[0], ID: 900, conditionID: 900, conditionKey: 'experimental',
    conditionName: 'Experimental', isDefaultCondition: false, isPrimaryCondition: false,
    scoreCount: 1, scoredModelCount: 1, lowCoverage: true, publicWeight: 0, personalWeight: null };
const modelNames = ['Aster Pro', 'Cedar Sonnet', 'Meridian Flash', 'Atlas Large', 'Cedar Opus', 'Aster Mini', 'Meridian Pro', 'Atlas Small'];
export const models = modelNames.map((name, index) => ({
    ID: index + 201, modelID: index + 301, name, vendorName: ['Aster', 'Cedar', 'Meridian', 'Atlas'][index % 4],
    vendorSlug: ['openai', 'anthropic', 'google', 'meta'][index % 4], vendorID: index % 4 + 1,
    condition: { name: '', parameters: {}, scoreFields: [] },
    modelConditionName: 'default', modelConditionKey: 'default', isDefaultCondition: true,
    lower: 86.2 - index * 3.75, upper: 92.2 - index * 2.1, coverage: 94 - index * 2,
    resultCount: 7, fallbackUsageCount: 0
}));
export function weightedEntries(weights) {
    return weights.map(entry => ({ ...[...benchmarks, secondaryBenchmark, sparseBenchmark].find(item => item.conditionID === entry.conditionID), ...entry, weight: entry.weightBasisPoints / 100 }));
}
export function familyEntries(entries) {
    const catalogue = [...benchmarks, secondaryBenchmark, sparseBenchmark];
    return entries.map(entry => ({ ...catalogue.find(item => item.conditionID === entry.conditionID), ...entry }));
}
export function createFixtureState(options = {}) {
    return {
        userID: '1', authenticated: true, isSenior: true, empty: false, workspaceFailure: null, saveFailure: null,
        workspaceDelay: 0, saveDelay: 0, evidenceDelay: 0, requests: [], revision: 1, publicFamilyComposition: null, families: [],
        comparisonLast: null, comparisonProfiles: [],
        personalEntries: weightedEntries(benchmarks.slice(0, 4).map(item => ({ conditionID: item.conditionID, weightBasisPoints: item.personalWeight * 100 }))),
        fallbackRules: [], logs: [{ ID: 901, status: 'pending', content: { type: 'feedback', details: 'Please make score sources easier to inspect.', pageURL: 'https://example.com/' }, created_at: '2026-09-01T08:00:00Z', userName: 'Preview contributor' }],
        ...options
    };
}
export function workspace(state, body, { paginate = true } = {}) {
    const scoreMode = body.scoreMode ?? 'range';
    if (!['range', 'available'].includes(scoreMode)) {
        throw { status: 400, body: { error: 'invalid_score_mode' } };
    }
    const category = [categories[0], ...categories[0].children].find(item => item.ID === Number(body.categoryID)) ?? categories[0];
    const selectedKey = body.contextValues?.budget ?? 'standard';
    const options = state.comparisonModels ? comparisonOptions(state.comparisonModels, body.comparison, state.comparisonFields ?? []) : null;
    const publicWeights = state.publicWeights ?? benchmarks.filter(item => item.publicWeight).map(item => ({ conditionID: item.conditionID, weightBasisPoints: item.publicWeight * 100 }));
    const publicEmpty = state.empty || publicWeights.length === 0;
    const preview = body.previewPersonalPie ?? null;
    const personalEntries = preview
        ? weightedEntries(preview.entries)
        : state.empty || !state.authenticated ? [] : state.personalEntries;
    const personalFallbackRules = preview
        ? preview.fallbackRules.map(rule => ({ ...rule, entries: familyEntries(rule.entries, rule.primaryConditionID) }))
        : state.empty || !state.authenticated ? [] : state.fallbackRules;
    const extraBenchmarks = state.rankingStress ? Array.from({ length: 85 }, (_, index) => ({
        ...benchmarks[0], ID: index + 9, conditionID: index + 9, benchmarkID: index + 109,
        rank: index + 9, name: `Additional benchmark ${index + 1}`,
        publicWeight: 0, personalWeight: null
    })) : [];
    const sparseBenchmarks = state.sparseBenchmark ? [{ ...sparseBenchmark, rank: 8 }] : [];
    const secondaryBenchmarks = state.secondaryBenchmark ? [{ ...secondaryBenchmark, rank: 8 }] : [];
    const aaBenchmarks = state.aaBenchmarks ? [{ ...benchmarks[0], ID: 9901, conditionID: 9901, benchmarkID: 9902,
        name: 'AA Example', rank: 9, excludedFromRanking: true, publicWeight: 0, personalWeight: null }] : [];
    const extraModels = state.rankingStress ? Array.from({ length: 58 }, (_, index) => ({
        ...models[0], ID: index + 1001, modelID: index + 2001,
        name: `Additional model ${index + 1}`, lower: 58 - index,
        upper: 64 - index, coverage: 80
    })) : [];
    const data = {
        scoreMode,
        authenticated: state.authenticated,
        userID: state.authenticated ? state.userID : null,
        context: { ...(state.isPrivate ? { isPrivate: true } : {}), categoryID: category.ID, categoryPath: category.path, categoryName: category.name,
            description: category.description ?? `Compare models on ${category.name.toLowerCase()} tasks.`,
            creator: { name: 'BenchPoll', avatarURL: '/assets/benchpoll-mark.svg' },
            lineage: (category.ID === 1 ? [categories[0]] : [categories[0], category]).map(item => ({ ID: item.ID, name: item.name })),
            contextValues: { budget: selectedKey }, dimensions: [{ key: 'budget', name: 'Budget', selectedKey,
                options: [{ key: 'standard', name: 'Standard' }, { key: 'extended', name: 'Extended' }] }] },
        personalPie: { revision: state.revision, isDraft: Boolean(preview) || !state.authenticated, editable: true,
            entries: personalEntries, fallbackRules: personalFallbackRules },
        publicPie: { participantCount: publicEmpty ? 0 : 128, isFallback: false,
            familyComposition: publicEmpty ? [] : publicWeights.map(entry => state.publicFamilyComposition?.find(group => group.primaryConditionID === entry.conditionID)
                ?? { primaryConditionID: entry.conditionID, families: [{ primaryConditionID: entry.conditionID,
                    familyID: null, entries: [], weightBasisPoints: 10000, overallWeightBasisPoints: entry.weightBasisPoints }] }),
            composition: (category.ID === 1 ? [
                { categoryID: 1, name: 'Language models', pieCount: 32, weightBasisPoints: 2500 },
                { categoryID: 2, name: 'Reasoning', pieCount: 80, weightBasisPoints: 6250 },
                { categoryID: 3, name: 'Coding', pieCount: 16, weightBasisPoints: 1250 }
            ] : [{ categoryID: category.ID, name: category.name, pieCount: 128, weightBasisPoints: 10000 }])
                .map(source => publicEmpty ? { ...source, pieCount: 0, weightBasisPoints: 0 } : source),
            entries: publicEmpty ? [] : weightedEntries(publicWeights) },
        benchmarks: state.empty ? [] : [...benchmarks, ...extraBenchmarks, ...secondaryBenchmarks, ...sparseBenchmarks, ...aaBenchmarks].map(benchmark => ({
            ...benchmark,
            publicWeightBasisPoints: publicWeights.find(entry => entry.conditionID === benchmark.conditionID)?.weightBasisPoints ?? 0,
            publicWeight: (publicWeights.find(entry => entry.conditionID === benchmark.conditionID)?.weightBasisPoints ?? 0) / 100,
            personalWeight: personalEntries.find(entry => entry.conditionID === benchmark.conditionID)?.weight ?? null
        })),
        comparison: options ?? { mode: body.comparison?.mode ?? 'best', keys: body.comparison?.keys ?? ['model'], controlKeys: body.comparison?.controlKeys ?? null,
            filters: body.comparison?.filters ?? [], availableKeys: ['model', 'field:1', 'field:2', 'field:3'], fields: catalog().scoreFields,
            models: models.map(model => ({ ID: model.modelID, name: model.name, vendor: model.vendorName })), unconfiguredCount: 0 },
        modelLeaderboards: { public: [], personal: [] },
        scoreScale: { min: 0, max: 100 }, limits: { totalBasisPoints: 10000, maxPieItems: 100 }, serverTime: new Date().toISOString()
    };
    data.personalPie.communityFallbackComposition = personalEntries.map(entry => {
        const group = data.publicPie.familyComposition.find(group => group.primaryConditionID === entry.conditionID)
            ?? { primaryConditionID: entry.conditionID, configuredPieCount: 0, isDefault: true,
                families: [{ primaryConditionID: entry.conditionID, familyID: null, entries: [], weightBasisPoints: 10000 }] };
        return { ...group, families: group.families.map(family => ({ ...family,
            overallWeightBasisPoints: entry.weightBasisPoints * family.weightBasisPoints / 10000 })) };
    });
    data.modelLeaderboards = options ? {
        public: scoreComparison(state.comparisonModels, publicWeights, 10000, {
            scoreMode, availableInferenceVersion: body.availableInferenceVersion ?? AVAILABLE_INFERENCE_VERSION, fallbackScope: 'public', familyComposition: data.publicPie.familyComposition
        }, options),
        personal: scoreComparison(state.comparisonModels, personalEntries, 10000, { fallbackRules: personalFallbackRules,
            familyComposition: data.personalPie.communityFallbackComposition, scoreMode,
            availableInferenceVersion: body.availableInferenceVersion ?? AVAILABLE_INFERENCE_VERSION }, options)
    } : {
        public: publicEmpty ? [] : [...models, ...extraModels].map(item => scoreMode === 'available' ? { ...item, upper: item.lower } : item),
        personal: personalEntries.length === 0 ? [] : [...models, ...extraModels].map(item => ({ ...item, lower: item.lower - 2,
            upper: scoreMode === 'available' ? item.lower - 2 : item.upper }))
    };
    for (const family of [...state.families, ...personalFallbackRules]) {
        if (!family.entries.length) continue;
        const key = familyKey(family.primaryConditionID, family.entries);
        if (data.benchmarks.some(row => row.isFamily && row.familyKey === key)) continue;
        const primary = data.benchmarks.find(row => row.conditionID === family.primaryConditionID);
        const personal = personalFallbackRules.some(rule => familyKey(rule.primaryConditionID, rule.entries) === key);
        const publicFamily = data.publicPie.familyComposition.find(group => group.primaryConditionID === family.primaryConditionID)
            ?.families.find(value => familyKey(family.primaryConditionID, value.entries) === key);
        data.benchmarks.push({ ...primary, familyID: family.familyID ?? null, familyKey: key, isFamily: true,
            familyEntries: familyEntries(family.entries), publicWeightBasisPoints: publicFamily?.overallWeightBasisPoints ?? 0,
            publicWeight: (publicFamily?.overallWeightBasisPoints ?? 0) / 100,
            personalWeight: personal ? primary.personalWeight : null });
    }
    if (!options) {
        for (const mode of ['personal', 'public']) {
            const entries = mode === 'personal' ? personalEntries : weightedEntries(publicWeights);
            data.modelLeaderboards[mode] = data.modelLeaderboards[mode].map(model => {
                const observedScore = model.lower * 100 / model.coverage;
                const availableInference = scoreMode === 'available' ? availableResultInference(observedScore, model.coverage / 100, []) : null;
                return { ...model, availableInference, inferredScores: [],
                lower: availableInference ? Number(availableInference.totalScore.toFixed(2)) : model.lower,
                upper: availableInference ? Number(availableInference.totalScore.toFixed(2)) : model.upper,
                missingWeight: 100 - model.coverage,
                calculationScores: entries.map(entry => ({ conditionID: entry.conditionID,
                    normalizedScore: observedScore,
                    weightBasisPoints: entry.weightBasisPoints * model.coverage / 100,
                    effectiveWeight: entry.weightBasisPoints / 100 * (scoreMode === 'available' ? 1 : model.coverage / 100),
                    contribution: (scoreMode === 'available' ? observedScore : model.lower) * entry.weightBasisPoints / 10000,
                    fallbackFor: null, memberIDs: [model.ID], memberWeights: [{ ID: model.ID, weight: 1 }],
                    memberEvidence: [{ ID: model.ID, hash: 'f'.repeat(64) }], matchedCount: null }))
            }; });
        }
    }
    if (options) for (const mode of ['personal', 'public']) for (const model of data.modelLeaderboards[mode]) {
        for (const score of model.calculationScores) score.memberEvidence = [...new Set(score.memberIDs)].map(ID => ({ ID, hash: 'f'.repeat(64) }));
    }
    if (!paginate) return data;
    return fixtureRankingPager.create(data, {
        userID: state.authenticated ? state.userID : null,
        initialMode: body.initialMode ?? 'public',
        query: body.benchmarkQuery ?? '',
        pinPersonal: body.pinPersonal ?? false,
        groupVersions: body.groupVersions ?? false,
        resume: body.rankingResume
    });
}
export function catalog(state = {}) {
    const data = {
        benchmarks: benchmarks.map(item => ({ ...item, ID: item.benchmarkID,
            description: 'A reproducible benchmark of model capabilities.', requestOfficialSync: false,
            officialSyncURL: '', officialSyncInstructions: '',
            conditions: [{ ID: item.conditionID, name: 'default', differenceExplanation: 'Uses the complete test set, rather than a task subset.', key: 'default', isDefault: true, isPrimary: true, usesPercentageScale: true, scoreMin: 0, scoreMax: 100, scoreDirection: 'higher', scoreCount: item.scoreCount, lowCoverage: false, scoreSource: null }] })),
        models: models.map(item => ({ ...item, ID: item.modelID })),
        scoreFields: [
            { ID: 1, name: 'Harness', type: 'enum', revision: 1, allowEmpty: true, excludeMissing: true, excludeEmpty: false,
                options: [{ ID: 11, label: 'Agent A', excluded: false, revision: 1 }, { ID: 12, label: 'Agent B', excluded: false, revision: 1 }] },
            { ID: 2, name: 'Thinking', type: 'presence', revision: 1, allowEmpty: false, excludeMissing: true, excludeEmpty: false, options: [] },
            { ID: 3, name: 'Token budget', type: 'number', revision: 1, allowEmpty: false, excludeMissing: true, excludeEmpty: false, options: [] }
        ],
        vendors: ['Aster', 'Cedar', 'Meridian', 'Atlas'].map((name, i) => ({ ID: i + 1, name })),
        categories: [categories[0], ...categories[0].children], knownTags: [{ name: 'Reasoning' }, { name: 'Knowledge' }], rankingDimensions: []
    };
    if (state.comparisonFields) data.scoreFields = structuredClone(state.comparisonFields);
    for (const [enabled, row] of [[state.secondaryBenchmark, secondaryBenchmark], [state.sparseBenchmark, sparseBenchmark]]) {
        if (enabled) data.benchmarks[0].conditions.push({ ID: row.conditionID, name: row.conditionName, differenceExplanation: '',
            key: row.conditionKey, isDefault: false, isPrimary: false, usesPercentageScale: true,
            scoreMin: null, scoreMax: null, scoreDirection: 'higher', targetValue: null,
            scoreCount: row.scoreCount, lowCoverage: row.lowCoverage, scoreSource: null });
    }
    return data;
}
export function approvedResults(body) {
    const model = models.find(item => item.modelID === body.modelID);
    return { model: { modelID: model.modelID, scoreFields: body.scoreFields, modelName: model.name, vendorName: model.vendorName, configurationName: '' },
        scoreGroups: benchmarks.slice(0, 5).map((item, index) => ({
            benchmarkID: item.benchmarkID, benchmarkConditionID: item.conditionID, benchmarkName: item.name, benchmarkConditionName: 'default', benchmarkConditionIsDefault: true,
            medianRawScore: 89 - index * 2, medianNormalizedScore: 89 - index * 2, usesPercentageScale: true, sampleCount: 2, distinctScoreCount: 2,
            samples: [0, 1].map(sample => ({ ID: 501 + index * 2 + sample, rawScore: 88 - index * 2 + sample * 2, normalizedScore: 88 - index * 2 + sample * 2,
                sourceURL: 'https://example.com/evidence', excludedAsDuplicate: false, sourceTitle: 'Evaluation report (synthetic fixture)', sourceType: 'independent', createdAt: '2026-09-01T08:00:00Z' }))
        })) };
}
