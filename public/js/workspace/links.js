import { buildContributionURL } from '../shared/contribution-navigation.js?v=clean-20260908';

function contributionEditURL(mode, values) {
    return buildContributionURL(mode, values);
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
