import { frontendSource } from './helpers/frontend-source.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { entityKey, normalizedSearch, rankedMatches } from '../public/js/contribution/fields.js';
import { validateContributionCatalog } from '../public/js/contribution/contracts.js';
import { contributionPath, contributionRoute } from '../public/js/shared/contribution-navigation.js';

const source = frontendSource('public/js/contribute.js');
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

test('retired category creation is not offered as a contribution form or route', () => {
    assert.doesNotMatch(source, /new_category|function categoryDetailsStep\(/);
    assert.throws(() => contributionPath('new_category'), /Unknown contribution form/);
    assert.equal(contributionRoute('/contribute/categories/new'), null);
    assert.equal(contributionPath('new_benchmark'), '/contribute/benchmarks/new');
    assert.deepEqual(contributionRoute('/contribute/scores/new'), { mode: 'benchmark_result' });
});

test('contribution field-title annotations contain only Optional', () => {
    const titles = [...source.matchAll(/<label\b[^>]*>\s*<span>([\s\S]*?)<\/span>/g)];
    const annotations = titles.flatMap(([, title]) => [...title.matchAll(/<small\b[^>]*>([^<]*)<\/small>/g)]
        .map(([, text]) => text.trim()));
    assert.ok(annotations.length > 0, 'Keep the optional field annotations');
    assert.deepEqual([...new Set(annotations)], ['Optional']);
    assert.match(source, /Description <small>Optional<\/small>/);
    assert.match(source, /Introduction <small>Optional<\/small>/);
    assert.match(source, /Public notes <small>Optional<\/small>/);
    assert.doesNotMatch(`${html}\n${source}`,
        /<(?:span|small)\b[^>]*>\s*\(?required\)?\s*<\/(?:span|small)>/i);
});

test('plain-text feedback keeps its label and validation without an annotation', () => {
    const feedback = sourceBetween('function feedbackDetailsStep(', 'function discussionReportStep(');
    assert.match(feedback, /<span>Your message<\/span>/);
    assert.match(feedback, /<textarea required minlength="10" maxlength="\$\{feedbackMessageLimit\(feedbackInstructions\)\}"[^>]*data-bind="feedback"/);
    assert.match(feedback, /id="feedback-guidance"[^>]*translate="yes"/);
    assert.match(feedback, /aria-describedby="feedback-guidance"/);
});

test('every contribution operation ends with a notes control', () => {
    const notesHelper = sourceBetween('function changeReviewNotesField(', 'function changeDeleteStep(');
    const deleteForm = sourceBetween('function changeDeleteStep(', 'function evaluationDetailsStep(');
    const benchmarkForm = sourceBetween('function evaluationDetailsStep(', 'function vendorSuggestions(');
    const modelForm = sourceBetween('function subjectDetailsStep(', 'function renderResultModelSuggestions(');
    const scoreForm = sourceBetween('function resultsStep(', 'function reportDetailsStep(');
    const reportForm = sourceBetween('function reportDetailsStep(', 'function feedbackDetailsStep(');
    const feedbackForm = sourceBetween('function feedbackDetailsStep(', 'function normalizedText(');

    assert.match(notesHelper, /data-final-notes/);
    assert.ok(deleteForm.lastIndexOf('changeReviewNotesField') > deleteForm.lastIndexOf('Request deletion'));
    assert.ok(benchmarkForm.lastIndexOf('reviewerNotesField') > benchmarkForm.lastIndexOf('Introduction URL'));
    assert.ok(modelForm.lastIndexOf('reviewerNotesField') > modelForm.lastIndexOf('Introduction URL'));
    assert.ok(scoreForm.lastIndexOf('reviewerNotesField') > scoreForm.lastIndexOf('data-field="sourceURL"'));
    assert.ok(reportForm.lastIndexOf('data-final-notes') > reportForm.lastIndexOf('data-field="sourceURL"'));
    assert.match(feedbackForm, /data-final-notes/);
});

test('new benchmark defaults to percentage scale without filling score bounds', () => {
    const makeEvaluation = sourceBetween('function makeEvaluation(', 'function makeSubject(');
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

test('condition names remain single-line with a separate optional public explanation', () => {
    const benchmarkRows = sourceBetween('function conditionRows(', 'function changeOperationSelector(');
    assert.match(benchmarkRows, /<input required[^>]*data-condition-input/);
    assert.doesNotMatch(benchmarkRows, /Score direction|Status/);
    assert.match(benchmarkRows, /<textarea[^>]*data-field="differenceExplanation"[^>]*maxlength="10000"/);
    assert.match(benchmarkRows, /maxlength="\$\{Math\.max\(60, originalConditionName\(profile\)/);
    assert.match(source, /mountScoreFields/);
    assert.doesNotMatch(source, /function configurationRows|function makeConfiguration/);
});

test('existing benchmarks navigate to append a condition; existing models navigate to edit identity', () => {
    const hydration = sourceBetween('async function loadChangeTarget(', 'async function loadUser(');
    const selection = sourceBetween('function setSubjectModel(', 'function clearSubjectModel(');
    assert.match(hydration, /param\('addCondition'\) === '1'/);
    assert.match(hydration, /conditions\.push\(condition\)/);
    assert.match(selection, /edit_model/);
});

test('benchmark condition defaults derive from their name, never from row order', () => {
    const payload = sourceBetween('function evaluationPayload(', 'function subjectPayload(');
    assert.match(payload, /isDefault:\s*isLiteralDefaultCondition\(profile\.name\)/);
    assert.doesNotMatch(payload, /index\s*===\s*0|literalDefaultIndex/);
});

test('benchmark contribution forms, matching, and payloads have no tag dependencies', () => {
    const entry = fs.readFileSync(new URL('../public/js/contribute.js', import.meta.url), 'utf8');
    const contract = fs.readFileSync(new URL('../public/js/contribution/contracts.js', import.meta.url), 'utf8');
    assert.doesNotMatch(`${entry}\n${contract}\n${html}\n${css}`,
        /knownTags|known-tag-options|data-(?:tag|select-tag|remove-tag)|tag-editor|tag-suggestions|\.tags\b|\btags\s*:/i);
    assert.match(entry, /const benchmarkSearchFields = object => \[object\.name, \.\.\.object\.conditions\.map\(condition => condition\.name\)\]/);
    assert.match(entry, /condition => \[object\.name, condition\.name\]/);
});

test('the contribution catalog requires contexts and score fields but not benchmark tags', () => {
    const condition = { isPrimary: true, scoreSource: null, differenceExplanation: '' };
    const data = { benchmarks: [{ name: 'Example', conditions: [condition] }], models: [], vendors: [],
        categories: [], rankingDimensions: [{ options: [] }], scoreFields: [] };
    assert.equal(validateContributionCatalog(data), data);
    assert.equal(validateContributionCatalog({ ...data, knownTags: 'ignored', benchmarks: [{ ...data.benchmarks[0], tags: null }] }).benchmarks.length, 1);
    for (const field of ['categories', 'rankingDimensions', 'scoreFields']) {
        assert.throws(() => validateContributionCatalog({ ...data, [field]: undefined }), /must be an array/);
    }
    assert.throws(() => validateContributionCatalog({ ...data, rankingDimensions: [{}] }), /options must be an array/);
    assert.throws(() => validateContributionCatalog({ ...data, benchmarks: [{ conditions: [] }] }), /exactly one primary/);
});

test('new-model vendor suggestions count the full catalog and keep query relevance', () => {
    const vendors = [
        { ID: 1, name: 'Alpha Beta' }, { ID: 2, name: 'Beta Systems' }, { ID: 3, name: 'Beta' },
        ...Array.from({ length: 8 }, (_, index) => ({ ID: 10 + index, name: `Vendor ${index + 1}` })),
        { ID: 'pending:vendor', name: 'Pending Lab' }, { name: 'Missing A' }, { ID: null, name: 'Missing B' }
    ];
    const models = [
        ...Array.from({ length: 12 }, (_, index) => ({ ID: index + 1, vendorID: '17' })),
        ...Array.from({ length: 9 }, (_, index) => ({ ID: index + 20, vendorID: 1 })),
        { ID: 'pending:model', vendorID: 'pending:vendor' },
        { ID: 40, vendorID: 2 }, { ID: 41, vendorID: 3 },
        { ID: 42, vendorID: null }, { ID: 43 }, { ID: 44, vendorID: '' }
    ];
    const sandbox = { catalog: { vendors, models }, mode: 'new_model', entityKey, normalizedSearch, rankedMatches, vendorSearchFields: vendor => vendor.name };
    const suggestions = vm.runInNewContext(`(${sourceBetween('function vendorSuggestions(', 'function modelSuggestions(')})`, sandbox);
    const names = query => Array.from(suggestions(query), vendor => vendor.name);
    assert.deepEqual(names('  '), ['Vendor 8', 'Alpha Beta', 'Beta', 'Beta Systems', 'Pending Lab', 'Missing A', 'Missing B', 'Vendor 1']);
    assert.deepEqual(names('beta'), Array.from(rankedMatches(vendors, 'beta', vendor => vendor.name), vendor => vendor.name));
    assert.deepEqual(names('beta'), ['Beta', 'Beta Systems', 'Alpha Beta']);
    assert.equal(vendors[0].name, 'Alpha Beta', 'The original vendor catalog is not sorted in place');
    sandbox.mode = 'edit_model';
    assert.deepEqual(names(''), vendors.slice(0, 8).map(vendor => vendor.name));
});

test('new score form uses one shared source URL but emits it on every result', () => {
    const form = sourceBetween('function resultsStep(', 'function reportDetailsStep(');
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
    const scoreForm = sourceBetween('function resultsStep(', 'function reportDetailsStep(');
    const copy = sourceBetween('function copyResult(', 'function resultCard(');
    const action = sourceBetween("} else if (action === 'add-result')", "} else if (action === 'remove-result')");
    assert.match(scoreCard, /data-action="copy-result"[^>]*aria-label="Copy as a new score"/);
    assert.ok(scoreForm.indexOf('class="repeater-list"') < scoreForm.indexOf('data-action="add-result"'));
    assert.ok(scoreForm.indexOf('data-action="add-result"') < scoreForm.indexOf('class="result-submission-notes"'));
    assert.match(copy, /const identity = makeResult\(draft\.results\.length\)/);
    assert.match(copy, /draft\.results\.push\(\{[\s\S]*\.\.\.structuredClone\(source\),[\s\S]*clientRef: identity\.clientRef/);
    assert.match(action, /copyResult\(Number\(actionTarget\.dataset\.index\)\)/);
    assert.match(action, /data-result-card="\$\{copiedIndex\}"/);
});

test('server-backed contribution choices refresh every time their controls open', () => {
    const request = sourceBetween('async function requestContributionCatalog(', 'async function refreshContributionCatalog(');
    const refresh = sourceBetween('function refreshCatalogForControl(', 'function copyResult(');
    const focus = sourceBetween("stepSurface.addEventListener('focusin'", "stepSurface.addEventListener('toggle'");
    const toggle = sourceBetween("stepSurface.addEventListener('toggle'", "stepSurface.addEventListener('focusout'");
    assert.match(request, /cache:\s*'no-store'/);
    assert.match(request, /return validateContributionCatalog\(await response\.json\(\)\)/);
    assert.match(refresh, /refreshContributionCatalog\(\)/);
    assert.match(refresh, /control\.isConnected/);
    assert.match(refresh, /showError\(error\.message/);
    assert.doesNotMatch(refresh, /renderCurrentStep|loadCatalog/);
    assert.match(focus, /if \(evaluationName\) \{[\s\S]*refreshSuggestionControl\(evaluationName\)/);
    assert.match(focus, /if \(subjectModelName\) \{[\s\S]*refreshSuggestionControl\(subjectModelName\)/);
    assert.match(focus, /if \(resultModelQuery\) \{[\s\S]*refreshSuggestionControl\(resultModelQuery\)/);
    assert.match(focus, /if \(resultObjectQuery\) \{[\s\S]*refreshSuggestionControl\(resultObjectQuery\)/);
    assert.equal((focus.match(/refreshSuggestionControl\(/g) ?? []).length, 4);
    assert.match(source, /data-catalog-picker="vendor"/);
    assert.match(source, /refresh: refreshContributionCatalog/);
    assert.match(source, /data-catalog-picker="benchmark-condition"/);
    assert.match(toggle, /picker\?\.open/);
    assert.match(toggle, /refreshCatalogForControl\(picker/);
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
    assert.match(focusout, /validateExistingChoiceInput\(existingChoice\)/);
    assert.doesNotMatch(focusout, /reportValidity|showError/);
    assert.match(source, /const existingChoicesValid = validateRenderedExistingChoices\(\)/);
    assert.match(css, /\.evaluation-combobox\.has-model-selection > \.vendor-mark/);
    assert.doesNotMatch(source, /evaluation-selected-mark/);
});

test('percentage scores remain raw 0-100 values in the client payload', () => {
    const storedScore = sourceBetween('function resultStoredScore(', 'function addProfileLink(');
    assert.match(storedScore, /return displayScore/);
    assert.doesNotMatch(storedScore, /\/\s*100|\*\s*0\.01/);
});

test('change forms reuse ordinary fields and offer change, delete and merge controls', () => {
    assert.match(source, /mode === 'edit_benchmark'/);
    assert.match(source, /mode === 'edit_model'/);
    assert.match(source, /mode === 'edit_result'/);
    assert.match(source, /changeOperationSelector\(\)/);
    assert.match(source, /\['update', 'Change'\]/);
    assert.match(source, /\['delete', 'Delete'\]/);
    assert.match(source, /\['merge', 'Merge into another'\]/);
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
    assert.doesNotMatch(source, /model_condition_in_use:/);
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
