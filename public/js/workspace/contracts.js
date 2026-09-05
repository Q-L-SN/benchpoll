import { FALLBACK_RULE_MODE, MAX_FALLBACK_COMPONENTS, MIN_WEIGHT_BASIS_POINTS } from './constants.js';

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
    const literalDefault = current.conditionName.trim().toLocaleLowerCase('en-US') === 'default';
    if (current.isDefaultCondition !== literalDefault
        || (current.conditionKey === 'default') !== literalDefault) {
        throw invalidWorkspaceResponse(path, 'has inconsistent default-condition identity');
    }
    return current;
}

function validateWorkspaceFallbackRules(value, pieEntries, piePath) {
    const rulesPath = `${piePath}.fallbackRules`;
    const rules = requireWorkspaceArray(value, rulesPath);
    const pieConditionIDs = new Set(pieEntries.map(entry => Number(entry.conditionID)));
    const primaryIDs = new Set();
    rules.forEach((valueRule, ruleIndex) => {
        const path = `${rulesPath}[${ruleIndex}]`;
        const rule = requireWorkspaceObject(valueRule, path);
        const primaryConditionID = Number(rule.primaryConditionID);
        if (!Number.isSafeInteger(primaryConditionID)
            || !pieConditionIDs.has(primaryConditionID)
            || primaryIDs.has(primaryConditionID)
            || rule.mode !== FALLBACK_RULE_MODE) {
            throw invalidWorkspaceResponse(path, 'has an invalid primary or mode');
        }
        primaryIDs.add(primaryConditionID);
        const componentIDs = new Set();
        let totalBasisPoints = 0;
        const entries = requireWorkspaceArray(rule.entries, `${path}.entries`);
        if (entries.length === 0 || entries.length > MAX_FALLBACK_COMPONENTS) {
            throw invalidWorkspaceResponse(`${path}.entries`, 'has an invalid size');
        }
        entries.forEach((valueEntry, entryIndex) => {
            const entryPath = `${path}.entries[${entryIndex}]`;
            const entry = requireWorkspaceConditionIdentity(valueEntry, entryPath);
            const conditionID = Number(entry.conditionID);
            const weightBasisPoints = Number(entry.weightBasisPoints);
            if (!Number.isSafeInteger(conditionID)
                || conditionID < 1
                || conditionID === primaryConditionID
                || componentIDs.has(conditionID)
                || !Number.isSafeInteger(weightBasisPoints)
                || weightBasisPoints < MIN_WEIGHT_BASIS_POINTS
                || weightBasisPoints > 10000) {
                throw invalidWorkspaceResponse(entryPath, 'has an invalid condition or weight');
            }
            componentIDs.add(conditionID);
            totalBasisPoints += weightBasisPoints;
        });
        if (totalBasisPoints !== 10000) {
            throw invalidWorkspaceResponse(`${path}.entries`, 'must total 100 percent');
        }
    });
    return rules;
}

function validateWorkspacePayload(payload) {
    const response = requireWorkspaceObject(payload, 'response');
    const context = requireWorkspaceObject(response.context, 'context');
    const dimensions = requireWorkspaceArray(context.dimensions, 'context.dimensions');
    dimensions.forEach((dimension, index) => {
        const current = requireWorkspaceObject(dimension, `context.dimensions[${index}]`);
        requireWorkspaceArray(current.options, `context.dimensions[${index}].options`);
    });
    const personalPie = requireWorkspaceObject(response.personalPie, 'personalPie');
    const personalEntries = requireWorkspaceArray(personalPie.entries, 'personalPie.entries');
    personalEntries.forEach((entry, index) => {
        requireWorkspaceConditionIdentity(entry, `personalPie.entries[${index}]`);
    });
    validateWorkspaceFallbackRules(personalPie.fallbackRules, personalEntries, 'personalPie');
    const publicPie = requireWorkspaceObject(response.publicPie, 'publicPie');
    const publicEntries = requireWorkspaceArray(publicPie.entries, 'publicPie.entries');
    publicEntries.forEach((entry, index) => {
        requireWorkspaceConditionIdentity(entry, `publicPie.entries[${index}]`);
    });
    validateWorkspaceFallbackRules(publicPie.fallbackRules, publicEntries, 'publicPie');
    requireWorkspaceArray(response.benchmarks, 'benchmarks').forEach((entry, index) => {
        requireWorkspaceConditionIdentity(entry, `benchmarks[${index}]`);
    });
    const modelLeaderboards = requireWorkspaceObject(response.modelLeaderboards, 'modelLeaderboards');
    requireWorkspaceArray(modelLeaderboards.personal, 'modelLeaderboards.personal');
    requireWorkspaceArray(modelLeaderboards.public, 'modelLeaderboards.public');
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
    requireModelScoresNumber(model.modelConditionID, 'model.modelConditionID');
    if (typeof model.modelName !== 'string'
        || typeof model.vendorName !== 'string'
        || typeof model.modelConditionName !== 'string') {
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
            if (typeof sample.sourceURL !== 'string' || sample.sourceURL.trim() === '') {
                throw invalidModelScoresResponse(`scoreGroups[${groupIndex}].samples[${sampleIndex}].sourceURL`, 'must be a non-empty string');
            }
        });
    });
    return response;
}

export { validateWorkspacePayload, validateApprovedModelResultsPayload, invalidModelScoresResponse };
