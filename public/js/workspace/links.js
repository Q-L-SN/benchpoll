function contributionEditURL(mode, values) {
    const url = new URL('/contribute', window.location.origin);
    url.searchParams.set('mode', mode);
    Object.entries(values).forEach(([key, value]) => {
        if (value !== null && value !== undefined && String(value) !== '') {
            url.searchParams.set(key, String(value));
        }
    });
    url.searchParams.set('pageURL', window.location.href);
    return url.pathname + url.search;
}

function buildBenchmarkEditURL(object) {
    return contributionEditURL('edit_benchmark', {
        targetBenchmarkID: object.benchmarkID,
        targetConditionID: object.ID
    });
}

function buildModelEditURL(model) {
    return contributionEditURL('edit_model', {
        targetModelID: model.modelID,
        targetConditionID: model.ID
    });
}

function buildResultEditURL(result) {
    return contributionEditURL('edit_result', { targetResultID: result.ID });
}

export { contributionEditURL, buildBenchmarkEditURL, buildModelEditURL, buildResultEditURL };
