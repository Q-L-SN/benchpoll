import { FALLBACK_RULE_MODE } from './constants.js';
import { familyKey, resolvedFamilyConditionIDs } from '../shared/benchmark-families.js';
import { FALLBACK_CONFIGURATION_PAGE_SIZE, FEATURED_FALLBACK_LIMIT, FEATURED_FALLBACK_MIN_BASIS_POINTS } from '../shared/fallback-catalogue-policy.js';
import { BENCHMARK_GROUPS, benchmarkConditionGroup } from '../shared/benchmark-condition-groups.js?v=fallback-discovery-20261005';
import { storedAvailableResultInference, PAIRWISE_INFERENCE_METHOD, PAIRWISE_COVERAGE_METHOD, PAIRWISE_COVERAGE_FACTOR_METHOD, PAIRWISE_RATIONAL_COVERAGE_FACTOR_METHOD } from '../shared/available-score.js?v=coverage-factor-20261019';
import { canonicalAccountID } from '../shared/account-identity.js';
import { normalizeRankingResume, RANKING_PAGE_SIZE } from '../shared/ranking-resume.js';

function invalidWorkspaceResponse(path, message) {
    const error = new Error(`Invalid workspace response: ${path} ${message}`);
    error.code = 'invalid_workspace_response';
    // A response-shape error is deterministic and must not enter the network retry loop.
    error.status = 422;
    return error;
}

function requireWorkspaceObject(value, path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw invalidWorkspaceResponse(path, 'must be an object');
    }
    return value;
}

function requireWorkspaceArray(value, path) {
    if (!Array.isArray(value)) {
        throw invalidWorkspaceResponse(path, 'must be an array');
    }
    return value;
}

function requireWorkspaceConditionIdentity(value, path) {
    const current = requireWorkspaceObject(value, path);
    if (typeof current.conditionKey !== 'string' || current.conditionKey.trim() === '') {
        throw invalidWorkspaceResponse(`${path}.conditionKey`, 'must be a non-empty string');
    }
    if (typeof current.conditionName !== 'string' || current.conditionName.trim() === '') {
        throw invalidWorkspaceResponse(`${path}.conditionName`, 'must be a non-empty string');
    }
    if (typeof current.isDefaultCondition !== 'boolean') {
        throw invalidWorkspaceResponse(`${path}.isDefaultCondition`, 'must be a boolean');
    }
    if (typeof current.isPrimaryCondition !== 'boolean' || typeof current.lowCoverage !== 'boolean') {
        throw invalidWorkspaceResponse(path, 'must include primary and coverage flags');
    }
    const literalDefault = current.conditionName.trim().toLocaleLowerCase('en-US') === 'default';
    if (current.isDefaultCondition !== literalDefault
        || (current.conditionKey === 'default') !== literalDefault) {
        throw invalidWorkspaceResponse(path, 'has inconsistent default-condition identity');
    }
    return current;
}

function requireWeightEntry(value, path) {
    const entry = requireWorkspaceObject(value, path);
    if (entry.type === 'topic' || Number(entry.conditionID) < 0) {
        if (entry.type !== 'topic' || !Number.isSafeInteger(entry.referenceContextID) || entry.referenceContextID < 1
            || entry.conditionID !== -entry.referenceContextID || typeof entry.name !== 'string' || !entry.name.trim()
            || !Number.isFinite(entry.weightBasisPoints) || entry.weightBasisPoints < 0 || entry.weightBasisPoints > 10000) {
            throw invalidWorkspaceResponse(path, 'must identify a concrete topic reference');
        }
        return entry;
    }
    return requireWorkspaceConditionIdentity(entry, path);
}

function validateReferenceStatus(pie, path) {
    if (pie.referenceIssues !== undefined) requireWorkspaceArray(pie.referenceIssues, `${path}.referenceIssues`).forEach((issue, index) => {
        if (!Number.isSafeInteger(issue?.targetContextID) || issue.targetContextID < 1 || typeof issue.reason !== 'string') {
            throw invalidWorkspaceResponse(`${path}.referenceIssues[${index}]`, 'must describe an unresolved reference');
        }
    });
    if (pie.effectiveEntries !== undefined) requireWorkspaceArray(pie.effectiveEntries, `${path}.effectiveEntries`).forEach((entry, index) => {
        if (!Number.isSafeInteger(entry?.conditionID) || entry.conditionID === 0 || !Number.isFinite(entry.weightBasisPoints)
            || entry.weightBasisPoints < 0) throw invalidWorkspaceResponse(`${path}.effectiveEntries[${index}]`, 'must describe a benchmark weight');
        if (entry.conditionID < 0) requireWeightEntry(entry, `${path}.effectiveEntries[${index}]`);
    });
}

function requireBenchmarkRow(value, path) {
    const row = requireWorkspaceConditionIdentity(value, path);
    if (!Number.isSafeInteger(row.scoreCount) || row.scoreCount < 0
        || !Number.isSafeInteger(row.scoredModelCount) || row.scoredModelCount < 0
        || typeof row.lowCoverage !== 'boolean') {
        throw invalidWorkspaceResponse(path, 'must include approved score and model counts and coverage status');
    }
    if (row.isFamily) {
        const entries = requireWorkspaceArray(row.familyEntries, `${path}.familyEntries`);
        if (!entries.length || row.familyKey !== familyKey(row.conditionID, entries)
            || (row.familyID !== null && (!Number.isSafeInteger(row.familyID) || row.familyID < 1))) {
            throw invalidWorkspaceResponse(path, 'has an invalid family identity');
        }
        entries.forEach((entry, index) => requireFamilyEntry(entry, `${path}.familyEntries[${index}]`));
    } else {
        if (!Number.isSafeInteger(row.fallbackConfigCount) || row.fallbackConfigCount < 0) {
            throw invalidWorkspaceResponse(`${path}.fallbackConfigCount`, 'must be a non-negative integer');
        }
        if (typeof row.searchPromoted !== 'boolean') throw invalidWorkspaceResponse(`${path}.searchPromoted`, 'must be a boolean');
        requireFeaturedConfigurations(row.featuredFallbackConfigurations, row.conditionID, row.fallbackConfigCount, path);
    }
    return row;
}

function requireFeaturedConfigurations(value, conditionID, total, path) {
    const featured = requireWorkspaceArray(value, `${path}.featuredFallbackConfigurations`);
    if (featured.length > FEATURED_FALLBACK_LIMIT || featured.length > total) {
        throw invalidWorkspaceResponse(path, 'has too many featured fallback configurations');
    }
    const keys = new Set();
    featured.forEach((item, index) => {
        if (item?.isFamily !== true) throw invalidWorkspaceResponse(path, 'must feature only fallback configurations');
        requireBenchmarkRow(item, `${path}.featuredFallbackConfigurations[${index}]`);
        if (item.conditionID !== conditionID || !Number.isFinite(item.publicWeightBasisPoints)
            || item.publicWeightBasisPoints < FEATURED_FALLBACK_MIN_BASIS_POINTS || keys.has(item.familyKey)
            || index > 0 && item.publicWeightBasisPoints > featured[index - 1].publicWeightBasisPoints) {
            throw invalidWorkspaceResponse(path, 'has invalid or unsorted featured fallback configurations');
        }
        keys.add(item.familyKey);
    });
    return featured;
}

function requireFamilyEntry(entry, path) {
    if (Object.hasOwn(requireWorkspaceObject(entry, path), 'kind')) throw invalidWorkspaceResponse(path, 'must be a concrete benchmark version');
    return requireWorkspaceConditionIdentity(entry, path);
}

function requireRankedModel(value, path, scoreMode) {
    const model = requireWorkspaceObject(value, path);
    if (!Number.isSafeInteger(model.ID) || model.ID === 0 || typeof model.name !== 'string' || !model.name) {
        throw invalidWorkspaceResponse(path, 'must identify a model');
    }
    if (model.comparable === false) {
        if (model.rank !== null) throw invalidWorkspaceResponse(`${path}.rank`, 'must be null when incomparable');
    } else if (!Number.isSafeInteger(model.rank) || model.rank < 1
        || !Number.isFinite(model.lower) || !Number.isFinite(model.upper) || model.lower > model.upper) {
        throw invalidWorkspaceResponse(path, 'must have an ordered finite score and a rank');
    }
    const scores = requireWorkspaceArray(model.calculationScores, `${path}.calculationScores`);
    const memberIDs = new Set((model.members ?? [model]).map(member => member.ID));
    scores.forEach((score, index) => {
        const currentPath = `${path}.calculationScores[${index}]`;
        if (!Number.isSafeInteger(score.conditionID) || score.conditionID < 1
            || !Number.isFinite(score.normalizedScore) || !Number.isFinite(score.effectiveWeight)
            || score.effectiveWeight <= 0 || score.effectiveWeight > 100 + 1e-6
            || !Number.isFinite(score.contribution)
            || (score.fallbackFor !== null && (!Number.isSafeInteger(score.fallbackFor) || score.fallbackFor < 1))
            || !Array.isArray(score.memberIDs) || !score.memberIDs.length
            || score.memberIDs.some(ID => !memberIDs.has(ID))
            || !Array.isArray(score.memberWeights) || !score.memberWeights.length
            || score.memberWeights.some(item => !score.memberIDs.includes(item.ID) || !Number.isFinite(item.weight) || item.weight <= 0)
            || !Array.isArray(score.memberEvidence) || score.memberEvidence.length !== new Set(score.memberIDs).size
            || new Set(score.memberEvidence.map(item => item.ID)).size !== score.memberEvidence.length
            || score.memberEvidence.some(item => !score.memberIDs.includes(item.ID) || !/^[a-f0-9]{64}$/.test(item.hash))
            || Math.abs(score.memberWeights.reduce((sum, item) => sum + item.weight, 0) - 1) > 1e-6) {
            throw invalidWorkspaceResponse(currentPath, 'must describe an actual weighted score and its source configurations');
        }
    });
    const inferredScores = requireWorkspaceArray(model.inferredScores, `${path}.inferredScores`);
    let traceScore = model.lower;
    if (scoreMode === 'available' && scores.length) {
        const inference = requireWorkspaceObject(model.availableInference, `${path}.availableInference`);
        const pairwise = [PAIRWISE_INFERENCE_METHOD, PAIRWISE_COVERAGE_METHOD, PAIRWISE_COVERAGE_FACTOR_METHOD, PAIRWISE_RATIONAL_COVERAGE_FACTOR_METHOD].includes(inference.method);
        inferredScores.forEach((score, index) => {
            if (!Number.isSafeInteger(score.conditionID) || score.conditionID < 1
                || !Number.isFinite(score.normalizedScore)
                || (pairwise ? !Number.isFinite(score.percentile) || score.percentile < 0 || score.percentile > 1
                    || !Number.isSafeInteger(score.sourceCount) || score.sourceCount < 1 || score.sourceCount > inference.sourceCount
                    : score.percentile !== inference.percentile)
                || !Number.isSafeInteger(score.referenceCount) || score.referenceCount < (pairwise ? 2 : 1)
                || !Number.isFinite(score.originalWeight) || score.originalWeight <= 0 || score.originalWeight > 100 + 1e-6
                || !Number.isFinite(score.effectiveWeight) || score.effectiveWeight <= 0 || score.effectiveWeight > 100 + 1e-6
                || !Number.isFinite(score.contribution) || Math.abs(score.contribution - score.normalizedScore * (score.effectiveWeight / 100)) > .000001
                || (score.familyID !== null && (!Number.isSafeInteger(score.familyID) || score.familyID < 1))) {
                throw invalidWorkspaceResponse(`${path}.inferredScores[${index}]`, 'must describe an estimate, not an observed score');
            }
        });
        let expected;
        try { expected = storedAvailableResultInference(inference.observedScore, inference.coverageFraction,
            inferredScores.map(score => ({ normalizedScore: score.normalizedScore, weightFraction: score.originalWeight / 100 })),
            inference.percentile, inference.sourceCount, { method: inference.method }); }
        catch { throw invalidWorkspaceResponse(path, 'has an invalid missing-score estimate'); }
        for (const key of Object.keys(expected)) {
            if (typeof expected[key] === 'number' ? !Number.isFinite(inference[key]) || Math.abs(inference[key] - expected[key]) > 0.000001
                : inference[key] !== expected[key]) {
                throw invalidWorkspaceResponse(`${path}.availableInference.${key}`, 'must match the missing-score estimate');
            }
        }
        const denominator = inference.coverageFraction + inference.inferredFraction;
        if (Math.abs(inference.coverageFraction * 100 - model.coverage) > 0.011
            || Math.abs(inference.totalScore - model.lower) > 0.011 || model.lower !== model.upper
            || Math.abs(scores.reduce((sum, score) => sum + score.contribution, 0) - inference.observedContribution) > .000001
            || Math.abs(scores.reduce((sum, score) => sum + score.effectiveWeight, 0) - inference.coverageFraction / denominator * 100) > .000001
            || inferredScores.some(score => Math.abs(score.effectiveWeight - score.originalWeight / denominator) > .000001)) {
            throw invalidWorkspaceResponse(path, 'has an inconsistent inferred total');
        }
        traceScore = [PAIRWISE_COVERAGE_METHOD, PAIRWISE_COVERAGE_FACTOR_METHOD, PAIRWISE_RATIONAL_COVERAGE_FACTOR_METHOD].includes(inference.method)
            ? inference.unpenalizedScore : inference.totalScore;
    } else if (model.availableInference !== null || inferredScores.length) {
        throw invalidWorkspaceResponse(path, 'must not infer a score range or an empty ranking');
    }
    if (!Number.isFinite(model.missingWeight) || model.missingWeight < -1e-6 || model.missingWeight > 100 + 1e-6
        || Math.abs(model.coverage + model.missingWeight - 100) > .011
        || scores.some(score => Math.abs(score.contribution - score.normalizedScore * (score.effectiveWeight / 100)) > .000001)
        || (model.comparable !== false && Math.abs([...scores, ...inferredScores].reduce((sum, score) => sum + score.contribution, 0) - traceScore) > 0.011)) {
        throw invalidWorkspaceResponse(path, 'has an inconsistent calculation trace');
    }
    return model;
}

function validateWorkspaceFallbackRules(value, pieEntries, piePath) {
    const rulesPath = `${piePath}.fallbackRules`;
    const rules = requireWorkspaceArray(value, rulesPath);
    const pieConditionIDs = new Set(pieEntries.map(entry => Number(entry.conditionID)));
    const primaryIDs = new Set();
    rules.forEach((valueRule, ruleIndex) => {
        const path = `${rulesPath}[${ruleIndex}]`;
        const rule = requireWorkspaceObject(valueRule, path);
        if (rule.selectionSource !== undefined && !['selected', 'custom'].includes(rule.selectionSource)) {
            throw invalidWorkspaceResponse(path, 'has an invalid fallback selection source');
        }
        const primaryConditionID = Number(rule.primaryConditionID);
        if (!Number.isSafeInteger(primaryConditionID)
            || primaryConditionID < 1
            || !pieConditionIDs.has(primaryConditionID)
            || primaryIDs.has(primaryConditionID)
            || rule.mode !== FALLBACK_RULE_MODE) {
            throw invalidWorkspaceResponse(path, 'has an invalid primary or mode');
        }
        primaryIDs.add(primaryConditionID);
        const componentIDs = new Set();
        const entries = requireWorkspaceArray(rule.entries, `${path}.entries`);
        entries.forEach((valueEntry, entryIndex) => {
            const entryPath = `${path}.entries[${entryIndex}]`;
            const entry = requireFamilyEntry(valueEntry, entryPath);
            const conditionID = Number(entry.conditionID);
            if (!Number.isSafeInteger(conditionID)
                || conditionID < 1
                || conditionID === primaryConditionID
                || componentIDs.has(conditionID) || Object.hasOwn(entry, 'weightBasisPoints')) {
                throw invalidWorkspaceResponse(entryPath, 'has an invalid ordered condition');
            }
            componentIDs.add(conditionID);
        });
        try { resolvedFamilyConditionIDs(primaryConditionID, entries); }
        catch { throw invalidWorkspaceResponse(path, 'has an invalid fallback order'); }
    });
    return rules;
}

function validateFamilyComposition(value, pieEntries, compositionPath) {
    const familyComposition = requireWorkspaceArray(value, compositionPath);
    const familyPrimaries = new Set();
    familyComposition.forEach((group, index) => {
        const path = `${compositionPath}[${index}]`;
        const entrance = pieEntries.find(entry => entry.conditionID === group.primaryConditionID);
        const families = requireWorkspaceArray(group.families, `${path}.families`);
        if (!entrance || familyPrimaries.has(group.primaryConditionID) || !families.length) throw invalidWorkspaceResponse(path, 'has an invalid entrance');
        familyPrimaries.add(group.primaryConditionID);
        if (group.configuredPieCount !== undefined || group.isDefault !== undefined) {
            if (!Number.isSafeInteger(group.configuredPieCount) || group.configuredPieCount < 0
                || group.isDefault !== (group.configuredPieCount === 0)
                || group.isDefault && (families.length !== 1 || families[0].entries?.length !== 0)) {
                throw invalidWorkspaceResponse(path, 'has inconsistent community choice metadata');
            }
        }
        let total = 0;
        const seen = new Set();
        families.forEach((family, familyIndex) => {
            const familyPath = `${path}.families[${familyIndex}]`;
            const entries = requireWorkspaceArray(family.entries, `${familyPath}.entries`);
            let key;
            try { key = familyKey(group.primaryConditionID, entries); }
            catch { throw invalidWorkspaceResponse(familyPath, 'has an invalid chain'); }
            if (seen.has(key) || family.primaryConditionID !== group.primaryConditionID
                || !Number.isFinite(family.weightBasisPoints) || family.weightBasisPoints <= 0 || family.weightBasisPoints > 10000
                || !Number.isFinite(family.overallWeightBasisPoints) || family.overallWeightBasisPoints < 0
                || Math.abs(family.overallWeightBasisPoints - entrance.weightBasisPoints * family.weightBasisPoints / 10000) > 1.000001
                || (entries.length === 0 ? family.familyID !== null
                    : !Number.isSafeInteger(family.familyID) || family.familyID < 1)) {
                throw invalidWorkspaceResponse(familyPath, 'has an invalid family share');
            }
            seen.add(key);
            total += family.weightBasisPoints;
            entries.forEach((entry, entryIndex) => requireFamilyEntry(entry, `${familyPath}.entries[${entryIndex}]`));
        });
        if (Math.abs(total - 10000) > 1e-6) throw invalidWorkspaceResponse(path, 'must account for all family shares');
    });
    if (familyPrimaries.size !== pieEntries.filter(entry => entry.type !== 'topic' && Number(entry.conditionID) > 0).length) {
        throw invalidWorkspaceResponse(compositionPath, 'must account for every benchmark entrance');
    }
}

function validateWorkspacePayload(payload, { resume = null, initialMode = 'public' } = {}) {
    const progress = normalizeRankingResume(resume);
    const response = requireWorkspaceObject(payload, 'response');
    if (typeof response.authenticated !== 'boolean'
        || (response.authenticated ? typeof response.userID !== 'string' || canonicalAccountID(response.userID) !== response.userID
            : response.userID !== null)) {
        throw invalidWorkspaceResponse('userID', 'must match the authenticated account identity');
    }
    if (!['range', 'available'].includes(response.scoreMode)) {
        throw invalidWorkspaceResponse('scoreMode', 'must be range or available');
    }
    const context = requireWorkspaceObject(response.context, 'context');
    const dimensions = requireWorkspaceArray(context.dimensions, 'context.dimensions');
    dimensions.forEach((dimension, index) => {
        const current = requireWorkspaceObject(dimension, `context.dimensions[${index}]`);
        requireWorkspaceArray(current.options, `context.dimensions[${index}].options`);
    });
    if (context.scenes !== undefined) {
        const scenes = requireWorkspaceArray(context.scenes, 'context.scenes');
        const ids = new Set();
        scenes.forEach((scene, index) => {
            if (!Number.isSafeInteger(scene?.ID) || scene.ID < 1 || typeof scene.name !== 'string' || !scene.name
                || typeof scene.isDefault !== 'boolean' || ids.has(scene.ID)) {
                throw invalidWorkspaceResponse(`context.scenes[${index}]`, 'must identify a unique scene');
            }
            ids.add(scene.ID);
        });
        if (dimensions.length || (scenes.length ? scenes.filter(scene => scene.isDefault).length !== 1
            || !ids.has(context.sceneID) || String(context.sceneID) !== context.contextValues?.scene
            || Object.keys(context.contextValues).length !== 1 : context.sceneID != null || Object.keys(context.contextValues ?? {}).length)) {
            throw invalidWorkspaceResponse('context.scenes', 'must match the current scene and one default');
        }
    }
    const personalPie = requireWorkspaceObject(response.personalPie, 'personalPie');
    const personalEntries = requireWorkspaceArray(personalPie.entries, 'personalPie.entries');
    personalEntries.forEach((entry, index) => {
        requireWeightEntry(entry, `personalPie.entries[${index}]`);
    });
    validateReferenceStatus(personalPie, 'personalPie');
    validateWorkspaceFallbackRules(personalPie.fallbackRules, personalEntries, 'personalPie');
    if (personalPie.communityFallbackComposition !== undefined) {
        validateFamilyComposition(personalPie.communityFallbackComposition, personalEntries, 'personalPie.communityFallbackComposition');
    }
    const publicPie = requireWorkspaceObject(response.publicPie, 'publicPie');
    if (!Number.isSafeInteger(publicPie.participantCount) || publicPie.participantCount < 0) {
        throw invalidWorkspaceResponse('publicPie.participantCount', 'must be a non-negative integer');
    }
    const publicEntries = requireWorkspaceArray(publicPie.entries, 'publicPie.entries');
    publicEntries.forEach((entry, index) => {
        requireWeightEntry(entry, `publicPie.entries[${index}]`);
    });
    validateReferenceStatus(publicPie, 'publicPie');
    validateFamilyComposition(publicPie.familyComposition, publicEntries, 'publicPie.familyComposition');
    requireWorkspaceArray(response.benchmarks, 'benchmarks').forEach((entry, index) => {
        requireBenchmarkRow(entry, `benchmarks[${index}]`);
    });
    const comparison = requireWorkspaceObject(response.comparison, 'comparison');
    const availableKeys = requireWorkspaceArray(comparison.availableKeys, 'comparison.availableKeys');
    const selectedKeys = requireWorkspaceArray(comparison.keys, 'comparison.keys');
    if (!['best', 'matched'].includes(comparison.mode) || !availableKeys.includes('model')
        || (comparison.mode === 'matched' && selectedKeys.length === 0)
        || availableKeys.some(key => typeof key !== 'string' || !key)
        || new Set(availableKeys).size !== availableKeys.length
        || new Set(selectedKeys).size !== selectedKeys.length
        || selectedKeys.some(key => !availableKeys.includes(key))
        || !Number.isSafeInteger(comparison.unconfiguredCount) || comparison.unconfiguredCount < 0) {
        throw invalidWorkspaceResponse('comparison', 'has invalid keys or configuration counts');
    }
    const modelLeaderboards = requireWorkspaceObject(response.modelLeaderboards, 'modelLeaderboards');
    requireWorkspaceArray(modelLeaderboards.personal, 'modelLeaderboards.personal')
        .forEach((model, index) => requireRankedModel(model, `modelLeaderboards.personal[${index}]`, response.scoreMode));
    requireWorkspaceArray(modelLeaderboards.public, 'modelLeaderboards.public')
        .forEach((model, index) => requireRankedModel(model, `modelLeaderboards.public[${index}]`, response.scoreMode));
    const pagination = requireWorkspaceObject(response.rankingPagination, 'rankingPagination');
    if (!['flat', 'versions'].includes(pagination.benchmarkGrouping)) {
        throw invalidWorkspaceResponse('rankingPagination.benchmarkGrouping', 'must identify the list grouping');
    }
    if (typeof pagination.snapshotID !== 'string' || !/^[0-9a-f-]{36}$/.test(pagination.snapshotID)) {
        throw invalidWorkspaceResponse('rankingPagination.snapshotID', 'must be a snapshot ID');
    }
    for (const list of ['personal', 'public']) {
        validateRankingPageMeta(pagination[list], `rankingPagination.${list}`);
    }
    const benchmarkPages = requireWorkspaceObject(pagination.benchmarks, 'rankingPagination.benchmarks');
    for (const group of BENCHMARK_GROUPS) {
        validateRankingPageMeta(benchmarkPages[group], `rankingPagination.benchmarks.${group}`);
        if (!progress && group !== 'primary' && benchmarkPages[group].nextOffset !== 0) {
            throw invalidWorkspaceResponse(`rankingPagination.benchmarks.${group}`, 'must start unloaded');
        }
    }
    if (response.benchmarks.some(row => row.isFamily || (!progress && pagination.benchmarkGrouping === 'versions' && benchmarkConditionGroup(row) !== 'primary'))
        || (pagination.benchmarkGrouping === 'flat' && (benchmarkPages.other.total || benchmarkPages.lowCoverage.total))) {
        throw invalidWorkspaceResponse('benchmarks', 'must initially contain only unfolded conditions');
    }
    const scales = requireWorkspaceObject(pagination.modelScales, 'rankingPagination.modelScales');
    for (const mode of ['personal', 'public']) {
        const scale = requireWorkspaceObject(scales[mode], `rankingPagination.modelScales.${mode}`);
        if (!Number.isFinite(scale.min) || !Number.isFinite(scale.max) || scale.min >= scale.max) {
            throw invalidWorkspaceResponse(`rankingPagination.modelScales.${mode}`, 'must have ordered finite bounds');
        }
    }
    if (response.benchmarks.length !== BENCHMARK_GROUPS.reduce((sum, group) => sum + benchmarkPages[group].nextOffset, 0)
        || modelLeaderboards.personal.length !== pagination.personal.nextOffset
        || modelLeaderboards.public.length !== pagination.public.nextOffset) {
        throw invalidWorkspaceResponse('rankingPagination', 'does not match the first page lengths');
    }
    if (progress) {
        const activeMode = context.isPrivate ? 'personal' : initialMode;
        if (!['personal', 'public'].includes(activeMode)) throw invalidWorkspaceResponse('initialMode', 'is invalid');
        for (const mode of ['personal', 'public']) {
            const expected = Math.min(pagination[mode].total,
                Math.max(activeMode === mode ? RANKING_PAGE_SIZE[mode] : 0, progress[mode]));
            if (pagination[mode].nextOffset !== expected) throw invalidWorkspaceResponse(`rankingPagination.${mode}`, 'must restore the requested prefix');
        }
        const seen = new Set();
        for (const group of BENCHMARK_GROUPS) {
            const expected = Math.min(benchmarkPages[group].total,
                Math.max(group === 'primary' ? RANKING_PAGE_SIZE.benchmarks : 0, progress.benchmarks[group]));
            const actual = response.benchmarks.filter(row => pagination.benchmarkGrouping === 'flat' ? group === 'primary' : benchmarkConditionGroup(row) === group);
            if (benchmarkPages[group].nextOffset !== expected || actual.length !== expected) {
                throw invalidWorkspaceResponse(`rankingPagination.benchmarks.${group}`, 'must restore the requested group prefix');
            }
            for (const row of actual) {
                if (seen.has(Number(row.ID))) throw invalidWorkspaceResponse('benchmarks', 'must not contain duplicate versions');
                seen.add(Number(row.ID));
            }
        }
        const restoredFallbacks = requireWorkspaceArray(pagination.fallbacks, 'rankingPagination.fallbacks');
        const entrances = new Set();
        for (const page of restoredFallbacks) {
            const requested = progress.fallbacks.find(item => item.conditionID === page.conditionID);
            if (!requested?.depth || entrances.has(page.conditionID)) throw invalidWorkspaceResponse('rankingPagination.fallbacks', 'has an unrequested or duplicate entrance');
            entrances.add(page.conditionID);
            validateRankingPagePayload(page, { list: 'fallbacks', conditionID: page.conditionID, offset: 0, maxItems: requested.depth });
            if (page.nextOffset !== Math.min(page.total, requested.depth)) {
                throw invalidWorkspaceResponse('rankingPagination.fallbacks', 'must restore the requested configuration prefix');
            }
        }
    } else if (pagination.fallbacks !== undefined) {
        throw invalidWorkspaceResponse('rankingPagination.fallbacks', 'requires an explicit recovery request');
    }
    return response;
}

function validateRankingPageMeta(value, path) {
    const page = requireWorkspaceObject(value, path);
    if (!Number.isSafeInteger(page.total) || page.total < 0
        || !Number.isSafeInteger(page.nextOffset) || page.nextOffset < 0
        || page.nextOffset > page.total || typeof page.hasMore !== 'boolean'
        || page.hasMore !== (page.nextOffset < page.total)) {
        throw invalidWorkspaceResponse(path, 'has invalid pagination metadata');
    }
    return page;
}

function validateRankingPagePayload(payload, { list, offset, group, conditionID, grouping, scoreMode, maxItems = FALLBACK_CONFIGURATION_PAGE_SIZE }) {
    const response = requireWorkspaceObject(payload, 'response');
    const page = validateRankingPageMeta(response, 'response');
    const items = requireWorkspaceArray(response.items, 'response.items');
    if (page.nextOffset !== offset + items.length || (page.hasMore && items.length === 0)) {
        throw invalidWorkspaceResponse('response', 'does not advance the requested page');
    }
    if (list === 'benchmarks') {
        if (!['flat', 'versions'].includes(response.grouping) || response.grouping !== grouping) {
            throw invalidWorkspaceResponse('response.grouping', 'must match the requested grouping');
        }
        if (!BENCHMARK_GROUPS.includes(group) || response.group !== group) {
            throw invalidWorkspaceResponse('response.group', 'must match the requested condition group');
        }
        const totals = requireWorkspaceObject(response.groupTotals, 'response.groupTotals');
        for (const key of BENCHMARK_GROUPS) {
            if (!Number.isSafeInteger(totals[key]) || totals[key] < 0) {
                throw invalidWorkspaceResponse(`response.groupTotals.${key}`, 'must be a non-negative count');
            }
        }
        if (totals[group] !== response.total) {
            throw invalidWorkspaceResponse('response.total', 'must match the requested group count');
        }
        items.forEach((entry, index) => requireBenchmarkRow(entry, `response.items[${index}]`));
        if (items.some(row => row.isFamily || (response.grouping === 'versions' && benchmarkConditionGroup(row) !== group))
            || (response.grouping === 'flat' && (group !== 'primary' || totals.other || totals.lowCoverage))) {
            throw invalidWorkspaceResponse('response.items', 'must belong to the requested condition group');
        }
    } else if (list === 'fallbacks') {
        if (items.length > maxItems) throw invalidWorkspaceResponse('response.items', 'exceeds the requested configuration prefix');
        if (response.conditionID !== conditionID) throw invalidWorkspaceResponse('response.conditionID', 'must match the requested entrance');
        if (!Number.isSafeInteger(response.fallbackConfigCount) || response.fallbackConfigCount < 0) {
            throw invalidWorkspaceResponse('response.fallbackConfigCount', 'must be a non-negative count');
        }
        const featured = requireFeaturedConfigurations(response.featuredFallbackConfigurations, conditionID, response.fallbackConfigCount, 'response');
        if (response.total + featured.length !== response.fallbackConfigCount) {
            throw invalidWorkspaceResponse('response.total', 'must account for non-featured configurations');
        }
        const keys = new Set(featured.map(row => row.familyKey));
        items.forEach((entry, index) => {
            const row = requireBenchmarkRow(entry, `response.items[${index}]`);
            if (!row.isFamily || row.conditionID !== conditionID || keys.has(row.familyKey)) {
                throw invalidWorkspaceResponse(`response.items[${index}]`, 'must identify a unique fallback configuration of this entrance');
            }
            keys.add(row.familyKey);
        });
    } else if (['personal', 'public'].includes(list)) {
        if (!['range', 'available'].includes(response.scoreMode) || response.scoreMode !== scoreMode) {
            throw invalidWorkspaceResponse('response.scoreMode', 'must match the current score mode');
        }
        items.forEach((entry, index) => requireRankedModel(entry, `response.items[${index}]`, scoreMode));
    } else if (!['personal', 'public'].includes(list)) {
        throw invalidWorkspaceResponse('list', 'is unsupported');
    }
    return response;
}

function invalidModelScoresResponse(path, message) {
    const error = new Error(`Invalid model-score response: ${path} ${message}`);
    error.code = 'invalid_model_scores_response';
    error.status = 422;
    return error;
}

function requireModelScoresObject(value, path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw invalidModelScoresResponse(path, 'must be an object');
    }
    return value;
}

function requireModelScoresArray(value, path) {
    if (!Array.isArray(value)) {
        throw invalidModelScoresResponse(path, 'must be an array');
    }
    return value;
}

function requireModelScoresNumber(value, path) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw invalidModelScoresResponse(path, 'must be a finite number');
    }
    return value;
}

function validateApprovedModelResultsPayload(payload) {
    const response = requireModelScoresObject(payload, 'response');
    const model = requireModelScoresObject(response.model, 'model');
    requireModelScoresNumber(model.modelID, 'model.modelID');
    requireModelScoresArray(model.scoreFields, 'model.scoreFields');
    if (typeof model.modelName !== 'string'
        || typeof model.vendorName !== 'string'
        || typeof model.configurationName !== 'string') {
        throw invalidModelScoresResponse('model', 'must include vendor, model, and condition names');
    }
    const scoreGroups = requireModelScoresArray(response.scoreGroups, 'scoreGroups');
    scoreGroups.forEach((groupValue, groupIndex) => {
        const group = requireModelScoresObject(groupValue, `scoreGroups[${groupIndex}]`);
        requireModelScoresNumber(group.benchmarkConditionID, `scoreGroups[${groupIndex}].benchmarkConditionID`);
        requireModelScoresNumber(group.medianRawScore, `scoreGroups[${groupIndex}].medianRawScore`);
        requireModelScoresNumber(group.medianNormalizedScore, `scoreGroups[${groupIndex}].medianNormalizedScore`);
        if (typeof group.benchmarkName !== 'string' || typeof group.benchmarkConditionName !== 'string') {
            throw invalidModelScoresResponse(`scoreGroups[${groupIndex}]`, 'must include benchmark and condition names');
        }
        const samples = requireModelScoresArray(group.samples, `scoreGroups[${groupIndex}].samples`);
        if (samples.length === 0 || group.sampleCount !== samples.length) {
            throw invalidModelScoresResponse(`scoreGroups[${groupIndex}].sampleCount`, 'must match a non-empty samples array');
        }
        samples.forEach((sampleValue, sampleIndex) => {
            const sample = requireModelScoresObject(sampleValue, `scoreGroups[${groupIndex}].samples[${sampleIndex}]`);
            requireModelScoresNumber(sample.ID, `scoreGroups[${groupIndex}].samples[${sampleIndex}].ID`);
            requireModelScoresNumber(sample.rawScore, `scoreGroups[${groupIndex}].samples[${sampleIndex}].rawScore`);
            requireModelScoresNumber(sample.normalizedScore, `scoreGroups[${groupIndex}].samples[${sampleIndex}].normalizedScore`);
            if (sample.sourceURL !== null && typeof sample.sourceURL !== 'string') {
                throw invalidModelScoresResponse(`scoreGroups[${groupIndex}].samples[${sampleIndex}].sourceURL`, 'must be a string or null');
            }
            if (sample.sourceURL?.trim()) {
                let source;
                try { source = new URL(sample.sourceURL); } catch { /* Rejected below. */ }
                if (!source || !['http:', 'https:'].includes(source.protocol)) {
                    throw invalidModelScoresResponse(`scoreGroups[${groupIndex}].samples[${sampleIndex}].sourceURL`, 'must be an absolute HTTP(S) URL');
                }
            }
            if (typeof sample.excludedAsDuplicate !== 'boolean') {
                throw invalidModelScoresResponse('sample.excludedAsDuplicate', 'must be a boolean');
            }
        });
        if (group.distinctScoreCount !== samples.filter(sample => !sample.excludedAsDuplicate).length
            || group.distinctScoreCount < 1) {
            throw invalidModelScoresResponse('group.distinctScoreCount', 'must match the distinct score values being counted');
        }
    });
    return response;
}

export { validateWorkspacePayload, validateRankingPagePayload, validateApprovedModelResultsPayload, invalidModelScoresResponse };
