function invalidContributionResponse(path, message) {
    const error = new Error(`Invalid contribution response: ${path} ${message}`);
    error.code = 'invalid_contribution_response';
    error.status = 422;
    return error;
}

function requireContributionObject(value, path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw invalidContributionResponse(path, 'must be an object');
    }
    return value;
}

function requireContributionArray(value, path) {
    if (!Array.isArray(value)) {
        throw invalidContributionResponse(path, 'must be an array');
    }
    return value;
}

function validateContributionCatalog(payload) {
    const response = requireContributionObject(payload, 'response');
    const arrayFields = [
        'benchmarks', 'models', 'vendors', 'categories', 'rankingDimensions', 'scoreFields'
    ];
    arrayFields.forEach(field => requireContributionArray(response[field], field));
    response.benchmarks.forEach((benchmark, index) => {
        const current = requireContributionObject(benchmark, `benchmarks[${index}]`);
        requireContributionArray(current.conditions, `benchmarks[${index}].conditions`);
        if (current.conditions.some(condition => typeof condition.isPrimary !== 'boolean')
            || current.conditions.filter(condition => condition.isPrimary).length !== 1) {
            throw invalidContributionResponse(`benchmarks[${index}].conditions`, 'must have exactly one primary version');
        }
        if (current.conditions.some(condition => condition.scoreSource !== null
            && (typeof condition.scoreSource !== 'string' || !condition.scoreSource))) {
            throw invalidContributionResponse(`benchmarks[${index}].conditions`, 'must include a valid scoreSource');
        }
        if (current.conditions.some(condition => typeof condition.differenceExplanation !== 'string')) {
            throw invalidContributionResponse(`benchmarks[${index}].conditions`, 'must include a difference explanation string');
        }
    });
    response.models.forEach((model, index) => {
        requireContributionObject(model, `models[${index}]`);
    });
    response.rankingDimensions.forEach((dimension, index) => {
        const current = requireContributionObject(dimension, `rankingDimensions[${index}]`);
        requireContributionArray(current.options, `rankingDimensions[${index}].options`);
    });
    return response;
}

export { validateContributionCatalog, requireContributionObject, requireContributionArray };
