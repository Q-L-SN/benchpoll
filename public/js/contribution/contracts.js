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
        'benchmarks', 'models', 'vendors', 'categories', 'knownTags', 'rankingDimensions'
    ];
    arrayFields.forEach(field => requireContributionArray(response[field], field));
    response.benchmarks.forEach((benchmark, index) => {
        const current = requireContributionObject(benchmark, `benchmarks[${index}]`);
        requireContributionArray(current.conditions, `benchmarks[${index}].conditions`);
        requireContributionArray(current.tags, `benchmarks[${index}].tags`);
    });
    response.models.forEach((model, index) => {
        const current = requireContributionObject(model, `models[${index}]`);
        requireContributionArray(current.conditions, `models[${index}].conditions`);
    });
    response.rankingDimensions.forEach((dimension, index) => {
        const current = requireContributionObject(dimension, `rankingDimensions[${index}]`);
        requireContributionArray(current.options, `rankingDimensions[${index}].options`);
    });
    return response;
}

export { validateContributionCatalog, requireContributionObject, requireContributionArray };
