import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../public/js/contribute.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../private/contribute.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/css/contribute.css', import.meta.url), 'utf8');

function sourceBetween(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
    assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
    return source.slice(start, end);
}

test('contribution forms are one-page forms without a progress stepper or review page', () => {
    assert.doesNotMatch(html, /progress-bar|step-progress|review-contribution/i);
    assert.match(html, /id="contribution-form"/);
    assert.match(html, /id="submit-contribution"/);
    assert.doesNotMatch(source, /currentStep|nextStep|previousStep|reviewStep/);
});

test('every contribution operation ends with a notes control', () => {
    const notesHelper = sourceBetween('function changeReviewNotesField(', 'function changeDeleteStep(');
    const deleteForm = sourceBetween('function changeDeleteStep(', 'function evaluationDetailsStep(');
    const benchmarkForm = sourceBetween('function evaluationDetailsStep(', 'function normalizedSearch(');
    const modelForm = sourceBetween('function subjectDetailsStep(', 'function renderResultModelSuggestions(');
    const scoreForm = sourceBetween('function resultsStep(', 'function categoryDetailsStep(');
    const categoryForm = sourceBetween('function categoryDetailsStep(', 'function contextOptionsEditor(');
    const reportForm = sourceBetween('function reportDetailsStep(', 'function feedbackDetailsStep(');
    const feedbackForm = sourceBetween('function feedbackDetailsStep(', 'function normalizedText(');

    assert.match(notesHelper, /data-final-notes/);
    assert.ok(deleteForm.lastIndexOf('changeReviewNotesField') > deleteForm.lastIndexOf('Request deletion'));
    assert.ok(benchmarkForm.lastIndexOf('reviewerNotesField') > benchmarkForm.lastIndexOf('Introduction URL'));
    assert.ok(modelForm.lastIndexOf('reviewerNotesField') > modelForm.lastIndexOf('Introduction URL'));
    assert.ok(scoreForm.lastIndexOf('reviewerNotesField') > scoreForm.lastIndexOf('data-field="sourceURL"'));
    assert.ok(categoryForm.lastIndexOf('data-final-notes') > categoryForm.lastIndexOf('contextOrderEditor'));
    assert.ok(reportForm.lastIndexOf('data-final-notes') > reportForm.lastIndexOf('data-field="sourceURL"'));
    assert.match(feedbackForm, /data-final-notes/);
});

test('new benchmark defaults to percentage scale without filling score bounds', () => {
    const makeEvaluation = sourceBetween('function makeEvaluation(', 'function makeConfiguration(');
    assert.match(makeEvaluation, /usesPercentageScale:\s*true/);
    assert.match(makeEvaluation, /scoreMin:\s*''/);
    assert.match(makeEvaluation, /scoreMax:\s*''/);
    assert.doesNotMatch(makeEvaluation, /scoreMax:\s*100/);
});

test('percentage scale hides custom bounds and serializes both bounds as null', () => {
    const bounds = sourceBetween('function evaluationScoreBounds(', 'function evaluationDisplayScoreBounds(');
    const form = sourceBetween('function evaluationDetailsStep(', 'function normalizedSearch(');
    assert.match(bounds, /usesPercentageScale[\s\S]*return \{ min: null, max: null \}/);
    assert.match(form, /evaluation\.usesPercentageScale \? '' :/);
    assert.match(form, /data-field="scoreMin"/);
    assert.match(form, /data-field="scoreMax"/);
});

test('custom normalization requires both anchors but does not constrain entered scores', () => {
    const form = sourceBetween('function evaluationDetailsStep(', 'function normalizedSearch(');
    const scoreCard = sourceBetween('function resultCard(', 'function resultsStep(');
    const benchmarkValidation = sourceBetween(
        'function validateEvaluationConditionNames(',
        'function validateSubjectConfigurationNames('
    );
    const submissionValidation = sourceBetween('function validateContribution()', 'function evaluationPayload()');
    assert.match(form, /data-field="scoreMin"[^>]*required|required[^>]*data-field="scoreMin"/);
    assert.match(form, /data-field="scoreMax"[^>]*required|required[^>]*data-field="scoreMax"/);
    assert.match(form, /type="text" inputmode="text"[^>]*data-field="scoreMin"/);
    assert.match(form, /type="text" inputmode="text"[^>]*data-field="scoreMax"/);
    assert.doesNotMatch(form, /inputmode="(?:decimal|numeric)"[^>]*data-field="score(?:Min|Max)"/);
    const scoreRange = form.slice(form.indexOf('class="score-range-combination'), form.indexOf('</div>`}', form.indexOf('class="score-range-combination')));
    assert.doesNotMatch(scoreRange, /type="number"|step="any"/);
    assert.match(css, /\.score-range-combination\s*>\s*\.field\s*\{[^}]*grid-column:\s*auto/s);
    assert.match(benchmarkValidation, /Enter both the lowest and highest values for normalization/);
    assert.match(submissionValidation, /percentage && \(score < 0 \|\| score > 100\)/);
    assert.doesNotMatch(scoreCard, /min="\$\{escapeHTML\(scoreMin\)\}"/);
    assert.doesNotMatch(scoreCard, /max="\$\{escapeHTML\(scoreMax\)\}"/);
    assert.doesNotMatch(submissionValidation, /to \+∞|−∞ to/);
});

test('benchmark and model conditions are single-line names with no status column', () => {
    const benchmarkRows = sourceBetween('function conditionRows(', 'function changeOperationSelector(');
    const modelRows = sourceBetween('function configurationRows(', 'function subjectDetailsStep(');
    assert.match(benchmarkRows, /<input required[^>]*data-condition-input/);
    assert.match(modelRows, /<input required[^>]*data-configuration-input/);
    assert.doesNotMatch(benchmarkRows, /textarea|Score direction|Status/);
    assert.doesNotMatch(modelRows, /textarea|Thinking effort|Status/);
});

test('selecting an existing benchmark or model starts with one blank new condition', () => {
    const benchmarkSelection = sourceBetween('function setEvaluationSelection(', 'function clearEvaluationSelection(');
    const modelSelection = sourceBetween('function setSubjectModel(', 'function clearSubjectModel(');
    assert.match(benchmarkSelection, /const newProfile = makeProfile\(1\)/);
    assert.match(benchmarkSelection, /newProfile\.name = ''/);
    assert.match(benchmarkSelection, /newProfile\.isDefault = false/);
    assert.match(benchmarkSelection, /evaluation\.conditions = \[newProfile\]/);
    assert.match(modelSelection, /const configuration = makeConfiguration\(1\)/);
    assert.match(modelSelection, /configuration\.name = ''/);
    assert.match(modelSelection, /configuration\.isDefault = false/);
    assert.match(modelSelection, /subject\.conditions = \[configuration\]/);
});

test('condition payloads derive default identity from the name and never from row order', () => {
    const benchmarkPayload = sourceBetween('function evaluationPayload(', 'function configurationPayload(');
    const modelPayload = sourceBetween('function configurationPayload(', 'function resultsPayload(');
    const conditionInput = sourceBetween(
        "const conditionInput = event.target.closest('[data-condition-input], [data-configuration-input]');",
        'decorateChangedFields();'
    );
    assert.match(benchmarkPayload, /isDefault:\s*isLiteralDefaultCondition\(profile\.name\)/);
    assert.match(modelPayload, /isDefault:\s*isLiteralDefaultCondition\(configuration\.name\)/);
    assert.doesNotMatch(benchmarkPayload, /index\s*===\s*0|literalDefaultIndex/);
    assert.doesNotMatch(modelPayload, /index\s*===\s*0|literalDefaultIndex/);
    assert.match(conditionInput, /profile\.isDefault = isDefault/);
    assert.match(conditionInput, /configuration\.isDefault = isDefault/);
    assert.doesNotMatch(source, /removedDefault[\s\S]{0,180}conditions\[0\]\.isDefault = true/);
});

test('tag editor supports inline tags, Tab for known matches, and click-only creation', () => {
    assert.match(source, /class="tag-chip"/);
    assert.match(source, /event\.key === 'Tab'[\s\S]*tagSuggestions/);
    assert.match(source, /class="create-tag-option"/);
    assert.match(source, /data-select-tag/);
    assert.match(source, /Add the unfinished text as a tag or clear it before leaving this field/);
});

test('new score form uses one shared source URL but emits it on every result', () => {
    const form = sourceBetween('function resultsStep(', 'function categoryDetailsStep(');
    const payload = sourceBetween('function resultsPayload(', 'function submissionPayload(');
    assert.match(form, /draft\.results\.length > 1 \? 'All source URLs' : 'Source URL'/);
    assert.equal((form.match(/data-field="sourceURL"/g) ?? []).length, 1);
    assert.match(payload, /const sharedSourceURL = draft\.results\[0\]\?\.sourceURL/);
    assert.match(payload, /results:\s*draft\.results\.map/);
    assert.match(payload, /source:[\s\S]*url:\s*sharedSourceURL/);
    assert.doesNotMatch(form, /Category and context|start-context-selection|resultContextEditor/);
    assert.doesNotMatch(payload, /\bcontext\s*:/);
});

test('score entry accepts signed text without native number-wheel mutation', () => {
    const scoreCard = sourceBetween('function resultCard(', 'function resultsStep(');
    assert.match(scoreCard, /type="text" inputmode="text"[^>]*data-score-value-input[^>]*data-field="rawScore"/);
    assert.match(scoreCard, /autocapitalize="off" autocomplete="off" spellcheck="false"/);
    assert.doesNotMatch(scoreCard, /type="number"|step="any"|inputmode="(?:decimal|numeric)"/);
});

test('score repeater adds below the list and copies a score to a fresh final row', () => {
    const scoreCard = sourceBetween('function resultCard(', 'function resultsStep(');
    const scoreForm = sourceBetween('function resultsStep(', 'function categoryDetailsStep(');
    const copy = sourceBetween('function copyResult(', 'function resultCard(');
    const action = sourceBetween("} else if (action === 'add-result')", "} else if (action === 'remove-result')");
    assert.match(scoreCard, /data-action="copy-result"[^>]*aria-label="Copy as a new score"/);
    assert.ok(scoreForm.indexOf('class="repeater-list"') < scoreForm.indexOf('data-action="add-result"'));
    assert.ok(scoreForm.indexOf('data-action="add-result"') < scoreForm.indexOf('class="result-submission-notes"'));
    assert.match(copy, /const identity = makeResult\(draft\.results\.length\)/);
    assert.match(copy, /draft\.results\.push\(\{[\s\S]*\.\.\.source,[\s\S]*clientRef: identity\.clientRef/);
    assert.match(action, /copyResult\(Number\(actionTarget\.dataset\.index\)\)/);
    assert.match(action, /data-result-card="\$\{copiedIndex\}"/);
});

test('server-backed contribution choices refresh every time their controls open', () => {
    const request = sourceBetween('async function requestContributionCatalog(', 'async function refreshContributionCatalog(');
    const refresh = sourceBetween('function refreshCatalogForControl(', 'function copyResult(');
    const focus = sourceBetween("stepSurface.addEventListener('focusin'", "stepSurface.addEventListener('toggle'");
    const toggle = sourceBetween("stepSurface.addEventListener('toggle'", "stepSurface.addEventListener('pointerdown'");
    const parentSelection = sourceBetween('async function beginParentSelection(', 'function selectedContextLabel(');
    assert.match(request, /cache:\s*'no-store'/);
    assert.match(request, /return validateContributionCatalog\(await response\.json\(\)\)/);
    assert.match(refresh, /refreshContributionCatalog\(\)/);
    assert.match(refresh, /control\.isConnected/);
    assert.match(refresh, /showError\(error\.message/);
    assert.doesNotMatch(refresh, /renderCurrentStep|loadCatalog/);
    assert.match(focus, /if \(evaluationName\) \{[\s\S]*refreshSuggestionControl\(evaluationName\)/);
    assert.match(focus, /if \(tagInput\) \{[\s\S]*refreshSuggestionControl\(tagInput\)/);
    assert.match(focus, /if \(subjectModelName\) \{[\s\S]*refreshSuggestionControl\(subjectModelName\)/);
    assert.match(focus, /if \(resultModelQuery\) \{[\s\S]*refreshSuggestionControl\(resultModelQuery\)/);
    assert.match(focus, /if \(resultObjectQuery\) \{[\s\S]*refreshSuggestionControl\(resultObjectQuery\)/);
    assert.equal((focus.match(/refreshSuggestionControl\(/g) ?? []).length, 5);
    assert.match(source, /data-catalog-picker="vendor"/);
    assert.match(source, /data-catalog-picker="model-condition"/);
    assert.match(source, /data-catalog-picker="benchmark-condition"/);
    assert.match(toggle, /picker\?\.open/);
    assert.match(toggle, /refreshCatalogForControl\(picker/);
    assert.match(parentSelection, /await refreshContributionCatalog\(\)/);
});

test('existing score choices validate on blur and selected models use vendor marks without status badges', () => {
    const scoreCard = sourceBetween('function resultCard(', 'function resultsStep(');
    const choiceValidation = sourceBetween(
        'function clearExistingChoiceValidity(',
        'function refreshSuggestionControl('
    );
    const focusout = sourceBetween(
        "stepSurface.addEventListener('focusout'",
        "stepSurface.addEventListener('click'"
    );
    assert.match(source, /function modelInputValue\(model\) \{\s*return model\.name;/);
    assert.match(scoreCard, /has-model-selection[\s\S]*vendorMark\(getVendor\(model\.vendorID\) \?\? model\)/);
    assert.match(scoreCard, /data-existing-choice="model"/);
    assert.match(scoreCard, /data-existing-choice="benchmark"/);
    assert.doesNotMatch(scoreCard, /evaluation-selected-mark|>Selected<|>Pending</);
    assert.match(choiceValidation, /Choose an existing model from the suggestions/);
    assert.match(choiceValidation, /Choose an existing benchmark from the suggestions/);
    assert.match(choiceValidation, /input\.setCustomValidity\(message\)/);
    assert.match(focusout, /validateExistingChoiceInput\(existingChoice, \{ report: true \}\)/);
    assert.match(source, /const existingChoicesValid = validateRenderedExistingChoices\(\)/);
    assert.match(css, /\.evaluation-combobox\.has-model-selection > \.vendor-mark/);
    assert.doesNotMatch(source, /evaluation-selected-mark/);
});

test('percentage scores remain raw 0-100 values in the client payload', () => {
    const storedScore = sourceBetween('function resultStoredScore(', 'function addConfigurationLink(');
    assert.match(storedScore, /return displayScore/);
    assert.doesNotMatch(storedScore, /\/\s*100|\*\s*0\.01/);
});

test('change forms reuse ordinary fields and only add change-or-delete controls', () => {
    assert.match(source, /mode === 'edit_benchmark'/);
    assert.match(source, /mode === 'edit_model'/);
    assert.match(source, /mode === 'edit_result'/);
    assert.match(source, /changeOperationSelector\(\)/);
    assert.match(source, /data-change-operation="update"/);
    assert.match(source, /data-change-operation="delete"/);
    assert.match(source, /data-restore-path/);
});

test('submission synchronizes rendered fields before computing change diffs', () => {
    const synchronization = sourceBetween('function syncRenderedFormFields(', 'function validateContribution(');
    const validation = sourceBetween('function validateContribution(', 'function evaluationPayload(');
    assert.match(synchronization, /\[data-bind\]\[data-field\]/);
    assert.match(synchronization, /updateBoundField\(control\)/);
    assert.match(validation, /^function validateContribution\(\) \{\s*syncRenderedFormFields\(\);/);
    assert.match(source, /change_request_has_no_changes:\s*'The submitted fields still match the published object/);
});

test('benchmark change hydration preserves every existing condition score contract', () => {
    const hydration = sourceBetween('function hydrateEvaluationChange(', 'function hydrateModelChange(');
    assert.match(hydration, /usesPercentageScale:\s*profileUsesPercentage\(profile\)/);
    assert.match(hydration, /scoreMin:\s*optionalNumberText\(profile\.scoreMin\)/);
    assert.match(hydration, /scoreMax:\s*optionalNumberText\(profile\.scoreMax\)/);
    assert.match(hydration, /scoreDirection:\s*profile\.scoreDirection/);
    assert.match(hydration, /targetValue:\s*optionalNumberText\(profile\.targetValue\)/);
});

test('client maps only canonical condition-protection errors', () => {
    assert.match(source, /benchmark_condition_in_use:/);
    assert.match(source, /model_condition_in_use:/);
    assert.doesNotMatch(source, /benchmark_condition_range_conflicts_with_results:/);
    assert.doesNotMatch(source, /evaluation_profile_in_use:|model_configuration_in_use:/);
});

test('catalog responses fail clearly before UI arrays are mapped', () => {
    assert.match(source, /function validateContributionCatalog\(payload\)/);
    assert.match(source, /return validateContributionCatalog\(await response\.json\(\)\)/);
    assert.match(source, /function applyContributionCatalog\(nextCatalog\)/);
    assert.match(source, /applyContributionCatalog\(nextCatalog\)/);
    assert.doesNotMatch(source, /function validateContributionWorkspace\(payload\)/);
    assert.doesNotMatch(source, /workspace\.context\.dimensions/);
});
