import { mountScoreFields, contributionScoreFields } from './contribution/score-fields.js?v=fixed-score-fields-20261015';
import './shared/help-popover.js?v=help-popovers-20261008';
import { validateContributionCatalog } from './contribution/contracts.js?v=contribution-catalog-20261028';
import {
    escapeHTML, option, finiteOrNull,
    integerOrNull, entityKey, sameEntityID,
    entityLocator, pendingBadge, evaluationScoreBounds,
    evaluationDisplayScoreBounds, evaluationStoredTargetValue, normalizedConditionName,
    isLiteralDefaultCondition, normalizedSearch,
    rankedMatches
} from './contribution/fields.js';
import * as G from '/js/global.js';
import { buildContributionURL, activateContributionURL, readContributionEntry, returnFromContribution } from './shared/contribution-navigation.js?v=taxonomy-20260929';
import { mergeRequestTemplate, bulkImportTemplate, feedbackGuidance, feedbackMessageLimit, feedbackSubmission } from './shared/feedback-templates.js';
import { createTaxonomyDrawer } from './shared/taxonomy-drawer.js?v=20260928';
import { mountDisclosureMotion } from './shared/motion.js';
import { searchItems } from './shared/search.js';
import { createOrganizationMark } from './shared/organization-logos.js?v=organization-logos-20261006';
import { postJSON, postWriteJSON } from './shared/http.js?v=write-replay-20261008';
import { pageAccountWriteScope, isAccountWriteError } from './shared/account-identity.js';
import { enhanceUI } from './shared/ui-components.js';
import { createFloatingSearchLayer } from './shared/floating-search-layer.js';
import { createEvidenceCount } from './shared/evidence-count.js';

const benchmarkSearchFields = object => [object.name, ...object.conditions.map(condition => condition.name)];
const vendorSearchFields = vendor => vendor.name;
const modelSearchFields = model => [model.name, model.vendorName];

const contributionEntry = readContributionEntry();
// A new handoff to this same form only changes the hash unless it is reloaded.
window.addEventListener('hashchange', () => {
    if (new URLSearchParams(location.hash.slice(1)).has('entry')) location.reload();
});
const params = contributionEntry.params;
const feedbackInstructions = feedbackGuidance(params.get('details'));
const formSurface = document.getElementById('form-surface');
const entryMissing = document.getElementById('entry-missing');
const authMissing = document.getElementById('auth-missing');
const form = document.getElementById('contribution-form');
const stepSurface = document.getElementById('contribution-step');
mountDisclosureMotion(stepSurface, '.condition-suggestion-fold');
const submitButton = document.getElementById('submit-contribution');
const title = document.getElementById('contribute-title');
const subtitle = document.getElementById('contribute-subtitle');
document.getElementById('contribution-back').addEventListener('click', () => returnFromContribution(params));
document.getElementById('contribution-bulk-import').addEventListener('click', () => {
    location.assign(activateContributionURL(buildContributionURL('feedback', {
        targetKind: 'bulk_import', details: bulkImportTemplate(), pageURL: `${location.origin}${location.pathname}`
    })));
});
const successDialog = document.getElementById('submit-success-dialog');
const errorDialog = document.getElementById('submit-error-dialog');
const errorCopy = document.getElementById('submit-error-copy');
const noticeDialog = document.getElementById('contribution-notice-dialog');
const noticeTitle = document.getElementById('contribution-notice-title');
const noticeCopy = document.getElementById('contribution-notice-copy');
const sidebarUser = document.getElementById('contribution-user');
const sidebarUserPicture = document.getElementById('contribution-user-picture');
const sidebarUserName = document.getElementById('contribution-user-name');
const sidebarLogin = document.getElementById('contribution-login');
const accountDialog = document.getElementById('contribution-account-dialog');
const accountDialogPicture = document.getElementById('contribution-account-picture');
const accountDialogName = document.getElementById('contribution-account-name');
const accountLogoutButton = document.getElementById('contribution-account-logout');
const accountDeleteButton = document.getElementById('contribution-account-delete');
const logoutConfirmDialog = document.getElementById('contribution-logout-confirm-dialog');
const deleteConfirmDialog = document.getElementById('contribution-delete-confirm-dialog');
const logoutConfirmButton = document.getElementById('contribution-logout-confirm');
const deleteConfirmButton = document.getElementById('contribution-delete-confirm');
const taxonomyToggle = document.getElementById('contribution-taxonomy-toggle');
const taxonomyClose = document.getElementById('contribution-taxonomy-close');
const taxonomyScrim = document.getElementById('contribution-taxonomy-scrim');
const authLogin = document.getElementById('auth-login-button');
const evaluationNameOptions = document.getElementById('evaluation-name-options');

const MODE_DETAILS = {
    report: {
        label: 'Report content', title: 'Report a discussion post',
        subtitle: 'Reports are private to reviewers. If upheld, the reported content will be hidden.',
        categoryEditable: false
    },
    new_benchmark: {
        label: 'New benchmark',
        title: 'Record a new benchmark',
        subtitle: 'Check for an existing benchmark first. Add a new one only if it is not listed.',
        categoryEditable: false
    },
    new_model: {
        label: 'New model',
        title: 'Record a new model',
        subtitle: 'Add the model itself. Record settings such as reasoning effort when submitting its scores.',
        categoryEditable: false
    },
    benchmark_result: {
        label: 'New scores',
        title: 'Contribute model scores',
        subtitle: 'Add a reported score and its source. Record test settings if the source provides them.',
        categoryEditable: false
    },
    edit_benchmark: {
        label: 'Change benchmark',
        title: 'Change benchmark',
        subtitle: 'Correct details, add a version, or merge a duplicate benchmark. Changes take effect after approval.',
        categoryEditable: false
    },
    edit_model: {
        label: 'Change model',
        title: 'Change model',
        subtitle: 'Correct the model details or report a duplicate. Changes take effect after approval.',
        categoryEditable: false
    },
    edit_result: {
        label: 'Change score',
        title: 'Change approved score',
        subtitle: 'Correct approved score evidence or request its removal.',
        categoryEditable: false
    },
    correct_or_add_info: {
        label: 'Benchmark correction',
        title: 'Correct benchmark information',
        subtitle: 'Point reviewers to the exact information and the source that supports it.',
        categoryEditable: false
    },
    feedback: {
        label: 'Feedback',
        title: 'Share feedback',
        subtitle: 'Tell us what would make BenchPoll clearer, more useful, or easier to trust.',
        categoryEditable: false
    }
};

let mode = param('mode');
if (mode === 'feedback') {
    if (!param('details')) {
        document.querySelector('.contribution-sidebar-actions a[href="/contribute/feedback"]')?.remove();
    } else if (param('targetKind') === 'bulk_import') {
        document.getElementById('contribution-bulk-import').remove();
    }
}
let catalog = { benchmarks: [], models: [], vendors: [], categories: [], rankingDimensions: [], scoreFields: [] };
let catalogRequestSequence = 0;
const pickerRefreshTokens = new WeakMap();
const contributionSearches = new Map();
let contributionSearchID = 0;
let expandedConditionKey = null;
let focusNewCondition = false;

const setTaxonomyOpen = createTaxonomyDrawer(taxonomyToggle, document.querySelector('.bp-sidebar'));
let authenticated = false;
let hasVerifiedEmail = false;

function isChangeMode(candidate = mode) {
    return candidate === 'edit_benchmark' || candidate === 'edit_model' || candidate === 'edit_result';
}

function param(name) {
    return String(params.get(name) ?? '').trim();
}

function makeProfile(index = 0) {
    return {
        clientRef: `benchmark-condition-${Date.now()}-${index}`,
        name: index === 0 ? 'default' : `Profile ${index + 1}`,
        differenceExplanation: '',
        isDefault: index === 0,
        isPrimary: index === 0,
        isExisting: false
    };
}

function makeEvaluation(index = 0) {
    return {
        name: '',
        introductionURL: '',
        description: '',
        requestOfficialSync: false,
        officialSyncURL: '',
        officialSyncInstructions: '',
        reviewerNotes: '',
        scoreDirection: 'higher',
        targetValue: '',
        usesPercentageScale: true,
        scoreMin: '',
        scoreMax: '',
        conditions: [makeProfile(0)],
        existingBenchmarkID: null,
        existingBenchmarkRef: null,
        clientRef: `benchmark-${Date.now()}-${index}`
    };
}



function makeSubject() {
    return {
        existingModelID: null,
        existingModelRef: null,
        modelQuery: '',
        name: '',
        introductionURL: '',
        reviewerNotes: '',
        vendorID: null,
        vendorRef: null,
        vendorQuery: '',
        vendor: {
            name: '',
            logoKey: ''
        },
        clientRef: `model-${Date.now()}`
    };
}

function makeResult(index = 0) {
    return {
        clientRef: `result-${Date.now()}-${index}`,
        modelQuery: '',
        modelID: null,
        modelRef: null,
        scoreFields: [],
        benchmarkQuery: '',
        benchmarkID: null,
        benchmarkRef: null,
        benchmarkConditionID: null,
        benchmarkConditionRef: null,
        rawScore: '',
        sourceURL: '',
        sourceType: 'other',
        sourceTitle: '',
    };
}

const draft = {
    benchmarks: [makeEvaluation(0)],
    subject: makeSubject(),
    results: [makeResult(0)],
    resultNotes: '',
    report: {
        postID: param('postID'),
        reason: 'spam',
        sourceURL: '',
        details: ''
    },
    feedback: {
        details: ''
    },
    change: {
        targetKind: '',
        targetID: null,
        operation: 'update',
        reviewNotes: '',
        baseline: null,
        before: null
    }
};

function modelInputValue(model) {
    return model.name;
}

function getBenchmark(benchmarkID) {
    return catalog.benchmarks.find(object => sameEntityID(object.ID, benchmarkID)) ?? null;
}

function getBenchmarkCondition(profileID) {
    for (const object of catalog.benchmarks) {
        const profile = object.conditions.find(candidate => sameEntityID(candidate.ID, profileID));
        if (profile) {
            return { object, profile };
        }
    }
    return null;
}

function getModel(modelID) {
    return catalog.models.find(model => sameEntityID(model.ID, modelID)) ?? null;
}

function getVendor(vendorID) {
    return catalog.vendors.find(vendor => sameEntityID(vendor.ID, vendorID)) ?? null;
}

function vendorMark(vendor) {
    return createOrganizationMark(vendor, 'vendor-mark').outerHTML;
}



function selectedContextLabel() {
    if (mode === 'new_benchmark' || mode === 'edit_benchmark') {
        return 'Global benchmark registry';
    }
    if (mode === 'benchmark_result' || mode === 'edit_result') {
        return 'Global score registry';
    }
    if (mode === 'new_model' || mode === 'edit_model') {
        return 'Global registry';
    }
    if (mode === 'feedback') {
        return 'No category required';
    }
    if (mode === 'correct_or_add_info') {
        return param('targetName') || 'Benchmark information';
    }
    return param('categoryPath') || 'BenchPoll';
}

function selectedEvaluation() {
    return draft.benchmarks[0];
}

function selectedExistingObject() {
    const evaluation = selectedEvaluation();
    return evaluation.existingBenchmarkID === null ? null : getBenchmark(evaluation.existingBenchmarkID);
}

function clearEvaluationSelection(name = '') {
    const evaluation = selectedEvaluation();
    const wasExisting = evaluation.existingBenchmarkID !== null;
    evaluation.existingBenchmarkID = null;
    evaluation.existingBenchmarkRef = null;
    evaluation.name = name;
    if (wasExisting) {
        evaluation.introductionURL = '';
        evaluation.scoreDirection = 'higher';
        evaluation.targetValue = '';
        evaluation.usesPercentageScale = true;
        evaluation.scoreMin = '';
        evaluation.scoreMax = '';
        evaluation.conditions = [makeProfile(0)];
    }
}

function evaluationSuggestions(query) {
    return searchItems(catalog.benchmarks, query, benchmarkSearchFields, { limit: 12 });
}

function conditionScoreCount(condition) {
    const known = Number.isSafeInteger(condition.scoreCount) && condition.scoreCount >= 0;
    const count = createEvidenceCount(known ? condition.scoreCount : 0);
    if (!known) {
        count.querySelector('.bp-evidence-count-value').textContent = '?';
        count.dataset.tooltip = 'Approved score count unavailable.';
        count.setAttribute('aria-label', count.dataset.tooltip);
    }
    count.classList.add('condition-score-count');
    // Picker options already own keyboard focus; retain the count's accessible description.
    count.removeAttribute('tabindex');
    return count.outerHTML;
}

function benchmarkSuggestionChoices(query) {
    return evaluationSuggestions(query).flatMap(object => searchItems(object.conditions, query,
        condition => [object.name, condition.name])
        .map(condition => ({ object, condition })));
}

function conditionSuggestionGroups(choices, render) {
    const primary = choices.filter(choice => choice.condition.isPrimary);
    const other = choices.filter(choice => !choice.condition.isPrimary && !choice.condition.lowCoverage);
    const lower = choices.filter(choice => !choice.condition.isPrimary && choice.condition.lowCoverage);
    const fold = (rows, label) => rows.length ? `<details class="condition-suggestion-fold"><summary>${rows.length} ${label} ${rows.length === 1 ? 'version' : 'versions'}</summary><div>${rows.map(render).join('')}</div></details>` : '';
    const nestedLower = fold(lower, 'lower-coverage');
    const otherFold = other.length || lower.length ? `<details class="condition-suggestion-fold"><summary>${other.length + lower.length} other versions</summary><div>${other.map(render).join('')}${nestedLower}</div></details>` : '';
    return primary.map(render).join('') + otherFold;
}

function benchmarkChoiceLabel(object, condition) {
    return `<span class="benchmark-suggestion-copy"><span>${escapeHTML(object.name)}${pendingBadge(object)}</span>${normalizedConditionName(condition.name) === 'default' ? '' : `<small>${escapeHTML(condition.name)}</small>`}</span>`;
}

function renderEvaluationSuggestions(query) {
    const suggestions = benchmarkSuggestionChoices(query);
    if (!String(query ?? '').trim() || suggestions.length === 0) {
        return '';
    }
    return `<div class="evaluation-suggestions" role="listbox" aria-label="Existing benchmarks">
        <p class="duplicate-check-heading"><strong>Is your benchmark already listed?</strong><span>Select a match to add a version to it.</span></p>
        ${conditionSuggestionGroups(suggestions, ({ object, condition }) => `<button type="button" role="option" data-select-evaluation="${escapeHTML(object.ID)}">
            ${benchmarkChoiceLabel(object, condition)}${conditionScoreCount(condition)}
        </button>`)}
    </div>`;
}

function updateEvaluationSuggestionMenu(input) {
    updateContributionSuggestions(input, renderEvaluationSuggestions(input.value));
}

function bindContributionSearch(key, anchor, panel, { scope = anchor, maxHeight = 280, onClose = () => {} } = {}) {
    panel.id ||= `contribution-search-${++contributionSearchID}`;
    panel.hidden = true;
    anchor.setAttribute('aria-controls', panel.id);
    anchor.setAttribute('aria-expanded', 'false');
    const state = { panel, wanted: false };
    state.layer = createFloatingSearchLayer({ anchor, panel, scope, align: 'start', margin: 8, gap: 6, maxHeight,
        width: () => Math.max(anchor.getBoundingClientRect().width, 260),
        onClose(reason) {
            if (reason !== 'empty') state.wanted = false;
            anchor.setAttribute('aria-expanded', 'false');
            onClose(reason);
        }
    });
    // A portal no longer bubbles through the form; invoke the same validated handlers once.
    const handlers = new Map([['input', handleStepInput], ['keydown', handleStepKeydown], ['click', handleStepClick]]);
    const listeners = new Map();
    for (const [type, handler] of handlers) {
        const listener = event => { event.stopPropagation(); handler(event); };
        listeners.set(type, listener); panel.addEventListener(type, listener);
    }
    state.destroy = () => {
        state.layer.destroy();
        for (const [type, listener] of listeners) panel.removeEventListener(type, listener);
        contributionSearches.delete(key);
    };
    contributionSearches.set(key, state);
    return state;
}

function updateContributionSuggestions(input, markup) {
    const combobox = input.closest('.evaluation-combobox');
    if (!combobox) return;
    let state = contributionSearches.get(input);
    if (!state) {
        const panel = document.createElement('div');
        panel.className = 'evaluation-suggestions';
        combobox.append(panel);
        state = bindContributionSearch(input, input, panel, { scope: combobox });
    }
    state.wanted = true;
    if (!markup) { state.layer.close({ reason: 'empty' }); state.panel.replaceChildren(); return; }
    const template = document.createElement('template');
    template.innerHTML = markup;
    const content = template.content.firstElementChild;
    state.panel.className = content.className;
    state.panel.setAttribute('role', content.getAttribute('role'));
    state.panel.setAttribute('aria-label', content.getAttribute('aria-label'));
    state.panel.replaceChildren(...content.childNodes);
    if (state.layer.contains(document.activeElement)) {
        state.wanted = state.layer.open();
        input.setAttribute('aria-expanded', String(state.wanted));
    }
}

function mountVendorPicker(picker) {
    const anchor = picker.querySelector('summary'), panel = picker.querySelector('.picker-panel');
    const input = panel.querySelector('[data-vendor-search]');
    panel.classList.add('bp-vendor-search-panel');
    panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', 'Vendor search');
    input.setAttribute('aria-label', 'Search vendors');
    const state = bindContributionSearch(picker, anchor, panel, { maxHeight: 340,
        onClose() {
            picker.open = false;
            pickerRefreshTokens.delete(picker); picker.removeAttribute('aria-busy');
        }
    });
    state.input = input;
    const toggle = event => {
        event.preventDefault();
        if (state.layer.isOpen) state.layer.close();
        else openVendorPicker(picker);
    };
    anchor.addEventListener('click', toggle);
    const destroy = state.destroy;
    state.destroy = () => { anchor.removeEventListener('click', toggle); destroy(); };
}

function openVendorPicker(picker) {
    const state = contributionSearches.get(picker);
    if (!state || state.layer.isOpen) return;
    picker.open = true;
    if (!state.layer.open()) { picker.open = false; return; }
    picker.querySelector('summary').setAttribute('aria-expanded', 'true');
    state.input.focus({ preventScroll: true });
}

function existingConditionRows(existing) {
    if (!existing) {
        return '';
    }
    return existing.conditions.map(profile => `<details name="benchmark-versions" class="condition-row condition-version locked" data-existing-condition="${escapeHTML(profile.ID)}" data-condition-key="locked-${escapeHTML(profile.ID)}"${expandedConditionKey === `locked-${profile.ID}` ? ' open' : ''}>
        <summary data-condition-toggle><span>${escapeHTML(profile.name)}</span><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></summary>
        <div class="condition-version-fields">
            <label class="field condition-name"><span id="locked-condition-name-${escapeHTML(profile.ID)}">Name</span><textarea readonly rows="1" aria-labelledby="locked-condition-name-${escapeHTML(profile.ID)}">${escapeHTML(profile.name)}</textarea></label>
            <label class="field condition-difference"><span id="locked-condition-description-${escapeHTML(profile.ID)}">Description</span><textarea readonly rows="2" aria-labelledby="locked-condition-description-${escapeHTML(profile.ID)}">${escapeHTML(profile.differenceExplanation)}</textarea></label>
            <div class="condition-version-actions">
                <span>${profile.isPrimary ? 'Primary version' : 'Existing version'}</span>
                <button class="condition-delete locked" type="button" data-action="explain-existing-condition" aria-label="Existing versions cannot be removed here" data-tooltip="Existing versions cannot be removed here"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button>
            </div>
        </div>
    </details>`).join('');
}

function conditionRows(evaluation) {
    return evaluation.conditions.map((profile, profileIndex) => `<details name="benchmark-versions" class="condition-row condition-version${normalizedConditionName(profile.name) === 'default' ? ' is-default' : ''}" data-condition-key="${escapeHTML(conditionKey(profile))}"${expandedConditionKey === conditionKey(profile) ? ' open' : ''}>
        <summary data-condition-toggle><span data-condition-heading>${escapeHTML(profile.name || 'New version')}</span><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></summary>
        <div class="condition-version-fields">
        <label class="field condition-name">
            <span id="condition-name-${profileIndex}">Name</span>
            <textarea required rows="1" aria-labelledby="condition-name-${profileIndex}" maxlength="${Math.max(60, originalConditionName(profile)?.length ?? 0)}" data-bind="profile" data-condition-input data-evaluation-index="0" data-profile-index="${profileIndex}" data-field="name" placeholder="e.g. v2 overall">${escapeHTML(profile.name)}</textarea>
        </label>
        <label class="field condition-difference"><span>Description <small>Optional</small></span>
            <textarea data-bind="profile" data-evaluation-index="0" data-profile-index="${profileIndex}" data-field="differenceExplanation" maxlength="10000" rows="2" placeholder="What this version measures and how it differs from the other versions">${escapeHTML(profile.differenceExplanation)}</textarea>
        </label>
        <div class="condition-version-actions">
            <label class="condition-primary-choice"><input type="radio" name="primary-condition" data-action="set-primary-condition" data-profile-index="${profileIndex}"${profile.isPrimary ? ' checked' : ''} aria-label="Primary version: ${escapeHTML(profile.name || `version ${profileIndex + 1}`)}"><span>Primary version</span></label>
            <button class="condition-delete" type="button" data-action="remove-profile" data-evaluation-index="0" data-profile-index="${profileIndex}" aria-label="Remove version" data-tooltip="Remove version"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button>
        </div>
        </div>
    </details>`).join('');
}

function conditionKey(profile) {
    return profile.ID === undefined ? profile.clientRef : `existing-${profile.ID}`;
}

function setExpandedCondition(key, { focus = false } = {}) {
    expandedConditionKey = key;
    for (const panel of stepSurface.querySelectorAll('[data-condition-key]')) {
        panel.open = panel.dataset.conditionKey === key;
        if (panel.open && focus) panel.querySelector('[data-condition-input]')?.focus();
    }
}

function updateConditionHeading(input) {
    const panel = input.closest('[data-condition-key]');
    const heading = panel?.querySelector('[data-condition-heading]');
    if (heading) heading.textContent = input.value || 'New version';
    panel?.querySelector('[data-action="set-primary-condition"]')?.setAttribute('aria-label',
        `Primary version: ${input.value || `version ${Number(input.dataset.profileIndex) + 1}`}`);
}

function reportInvalidField(input = form.querySelector(':invalid')) {
    if (!input) return;
    const panel = input.closest('[data-condition-key]');
    if (panel) setExpandedCondition(panel.dataset.conditionKey);
    input.focus();
    input.reportValidity();
}

stepSurface.addEventListener('toggle', event => {
    const panel = event.target;
    if (!panel.matches('[data-condition-key]')) return;
    if (panel.open && expandedConditionKey !== panel.dataset.conditionKey) setExpandedCondition(panel.dataset.conditionKey);
    else if (!panel.open && expandedConditionKey === panel.dataset.conditionKey) setExpandedCondition(null);
}, true);

function originalConditionName(profile) {
    return mode === 'edit_benchmark' && profile.ID !== undefined
        ? draft.change.before?.conditions.find(condition => condition.ID === profile.ID)?.name : undefined;
}

function validateConditionNameLength(input, profile) {
    const name = profile.name.trim();
    const message = name.length > 60 && name !== originalConditionName(profile)
        ? 'New or renamed version names must be 60 characters or fewer.' : '';
    if (message) showFieldError(input, message);
    else {
        input.removeAttribute('aria-invalid');
        input.parentElement.querySelector('.field-validation-error')?.remove();
    }
    input.setCustomValidity(message);
    return !message;
}

function changeOperationSelector() {
    return `<section class="change-operation-section">
        <div><strong>What would you like to do?</strong></div>
        <div class="change-operation-switch" role="group" aria-label="Requested operation">
            ${[['update', 'Change'], ['delete', 'Delete'], ['merge', 'Merge into another']].map(([value, label]) => `<button type="button" data-change-operation="${value}" aria-pressed="${draft.change.operation === value}" class="${draft.change.operation === value ? 'active' : ''}">${label}</button>`).join('')}
        </div>
    </section>`;
}

function requestMerge() {
    const kind = draft.change.targetKind;
    const name = draft.change.before?.name || `Score #${draft.change.targetID}`;
    const details = mergeRequestTemplate({ name, kind, ID: draft.change.targetID });
    location.assign(activateContributionURL(buildContributionURL('feedback', { details, pageURL: `${location.origin}${location.pathname}` })));
}

function changeReviewNotesField({ required = false } = {}) {
    return `<section class="change-review-notes"><label class="field wide" data-final-notes>
        <span>${required ? 'Reason and notes' : 'Notes'} ${required ? '' : '<small>Optional</small>'}</span>
        <textarea data-bind="change" data-field="reviewNotes" maxlength="2000"${required ? ' required minlength="3"' : ''} placeholder="${required ? 'Why should this item be removed?' : 'What is wrong? Include a source if useful.'}">${escapeHTML(draft.change.reviewNotes)}</textarea>
    </label></section>`;
}

function reviewerNotesField({ binding, value, index = null, placeholder }) {
    const activeBinding = binding;
    const field = 'reviewerNotes';
    const activeValue = value;
    const indexAttribute = index === null ? '' : ` data-index="${index}"`;
    return `<label class="field wide" data-final-notes${isChangeMode() && binding === 'resultBatch' ? ' data-change-path="resultNotes"' : ''}><span>Public notes <small>Optional</small></span>
        <textarea data-bind="${activeBinding}"${indexAttribute} data-field="${field}" maxlength="${binding === 'subject' ? 10000 : 2000}" placeholder="${escapeHTML(placeholder)}">${escapeHTML(activeValue)}</textarea>
    </label>`;
}

function changeDeleteStep() {
    return `${changeOperationSelector()}
        <div class="step-heading form-section-heading"><div><h2>Request deletion</h2><p>This item stays published until a reviewer approves its removal.</p></div></div>
        ${changeReviewNotesField({ required: true })}`;
}

function evaluationDetailsStep() {
    const evaluation = selectedEvaluation();
    const existing = selectedExistingObject();
    const editing = mode === 'edit_benchmark';
    return `${editing ? changeOperationSelector() : ''}<div class="step-heading form-section-heading">
        <div><h2>Benchmark and versions</h2><p>Name the versions and explain what makes each one different.</p></div>
    </div>
    <section class="evaluation-identity-section">
        <label class="field evaluation-name-field">
            <span>Benchmark name</span>
            <div class="evaluation-combobox${existing || editing ? ' has-selection' : ''}">
                <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                <input required autocomplete="off"${editing ? ' data-bind="evaluation" data-index="0" data-field="name"' : ` role="combobox" aria-autocomplete="list" aria-expanded="${evaluation.name.trim() ? 'true' : 'false'}" data-evaluation-name`} value="${escapeHTML(evaluation.name)}" placeholder="Search existing or enter a new benchmark">
                ${existing || editing ? '' : renderEvaluationSuggestions(evaluation.name)}
            </div>
        </label>
    </section>
    <section class="condition-section">
        <div class="condition-section-heading">
            <div data-change-path="evaluation.primaryCondition"><h3>Versions</h3></div>
            <button class="add-row-button" type="button" data-action="add-profile" data-evaluation-index="0"><i class="fa-solid fa-plus" aria-hidden="true"></i><span>Add version</span></button>
        </div>
        <div class="condition-table" role="group" aria-label="Versions">
            ${existing && !editing ? existingConditionRows(existing) : ''}${conditionRows(evaluation)}
        </div>
    </section>
    ${existing && !editing ? '' : `<section class="evaluation-request-fields"><div class="field-grid">
        <label class="field"><span>Which scores are better?</span><select required data-bind="evaluation" data-index="0" data-field="scoreDirection">
            ${option('higher', 'Higher is better', evaluation.scoreDirection)}${option('lower', 'Lower is better', evaluation.scoreDirection)}${option('closer_to_target', 'Closer to a target value', evaluation.scoreDirection)}
        </select></label>
        ${evaluation.scoreDirection === 'closer_to_target' ? `<label class="field"><span>Target value</span><input required type="number" step="any" data-bind="evaluation" data-index="0" data-field="targetValue" value="${escapeHTML(evaluation.targetValue)}" placeholder="0"></label>` : ''}
        <label class="percentage-scale-toggle wide" data-change-path="evaluation.usesPercentageScale"><input type="checkbox" data-score-percentage${evaluation.usesPercentageScale ? ' checked' : ''}><span><strong>Scores use a percentage scale</strong></span></label>
        ${evaluation.usesPercentageScale ? '' : `<div class="score-range-combination wide" aria-label="Score range">
            <label class="field"><span>Lowest value</span><input required type="text" inputmode="text" autocapitalize="off" autocomplete="off" spellcheck="false" data-score-range-input data-bind="evaluation" data-index="0" data-field="scoreMin" value="${escapeHTML(evaluation.scoreMin)}" placeholder="Lowest value on the published scale"></label>
            <label class="field"><span>Highest value</span><input required type="text" inputmode="text" autocapitalize="off" autocomplete="off" spellcheck="false" data-score-range-input data-bind="evaluation" data-index="0" data-field="scoreMax" value="${escapeHTML(evaluation.scoreMax)}" placeholder="Highest value on the published scale"></label>
        </div>`}
        <label class="field wide"><span>Introduction URL <small>Optional</small></span><input type="url" data-bind="evaluation" data-index="0" data-field="introductionURL" value="${escapeHTML(evaluation.introductionURL)}" placeholder="https://paper-or-project.example"></label>
        <label class="field wide"><span>Introduction <small>Optional</small></span><textarea data-bind="evaluation" data-index="0" data-field="description" maxlength="10000" placeholder="What this benchmark measures and how its versions differ">${escapeHTML(evaluation.description)}</textarea></label>
        <label class="percentage-scale-toggle wide"><input type="checkbox" data-bind="evaluation" data-index="0" data-field="requestOfficialSync"${evaluation.requestOfficialSync ? ' checked' : ''}><span><strong>Request automatic updates from the official source</strong></span></label>
        ${evaluation.requestOfficialSync ? `<label class="field wide"><span>Official source URL <small>Optional</small></span><input type="url" data-bind="evaluation" data-index="0" data-field="officialSyncURL" value="${escapeHTML(evaluation.officialSyncURL)}" placeholder="https://official-leaderboard-or-dataset.example"></label>
        <label class="field wide"><span>Sync instructions <small>Optional</small></span><textarea data-bind="evaluation" data-index="0" data-field="officialSyncInstructions" maxlength="10000" placeholder="How to find the current scores in the official source">${escapeHTML(evaluation.officialSyncInstructions)}</textarea></label>` : ''}
    </div></section>`}
    <section class="evaluation-request-fields final-notes-section"><div class="field-grid">
        ${reviewerNotesField({ binding: 'evaluation', index: 0, value: evaluation.reviewerNotes, placeholder: 'Shown with this benchmark after approval.' })}
    </div></section>`;
}

function vendorSuggestions(query) {
    if (mode !== 'new_model' || normalizedSearch(query)) {
        return rankedMatches(catalog.vendors, query, vendorSearchFields);
    }
    const modelCounts = new Map();
    for (const model of catalog.models) {
        const vendorID = entityKey(model.vendorID);
        if (vendorID) modelCounts.set(vendorID, (modelCounts.get(vendorID) ?? 0) + 1);
    }
    return catalog.vendors.map((vendor, index) => ({ vendor, index }))
        .sort((left, right) => (
            (modelCounts.get(entityKey(right.vendor.ID)) ?? 0) - (modelCounts.get(entityKey(left.vendor.ID)) ?? 0)
            || String(left.vendor.name ?? '').localeCompare(String(right.vendor.name ?? ''), 'en-US', { sensitivity: 'base', numeric: true })
            || left.index - right.index
        ))
        .slice(0, 8)
        .map(({ vendor }) => vendor);
}

function modelSuggestions(query, vendorID = null) {
    const models = vendorID === null
        ? catalog.models
        : catalog.models.filter(model => sameEntityID(model.vendorID, vendorID));
    return rankedMatches(models, query, modelSearchFields);
}

function subjectModelSuggestions(query) {
    const subject = draft.subject;
    if (subject.vendorID === null && subject.vendorRef === null) {
        return [];
    }
    return modelSuggestions(query, subject.vendorID);
}

function renderVendorOptions(query, { allowCreate = mode !== 'edit_model' } = {}) {
    const value = String(query ?? '').trim().replace(/\s+/g, ' ');
    const suggestions = vendorSuggestions(value);
    const exact = catalog.vendors.some(vendor => normalizedSearch(vendor.name) === normalizedSearch(value));
    return `${suggestions.map((vendor, index) => `<button type="button" role="option" class="picker-option" data-select-vendor="${escapeHTML(vendor.ID)}">
        ${vendorMark(vendor)}<span>${escapeHTML(vendor.name)}${pendingBadge(vendor)}</span>${index === 0 ? '<small>Tab</small>' : ''}
    </button>`).join('')}
    ${allowCreate && value && !exact ? `<button type="button" role="option" class="picker-option create-option" data-create-vendor="${escapeHTML(value)}">
        <i class="fa-solid fa-plus" aria-hidden="true"></i><span>Record as a new vendor</span><strong>${escapeHTML(value)}</strong>
    </button>` : ''}`;
}

function updateVendorOptions(input) {
    const panel = input.closest('.picker-panel');
    const list = panel?.querySelector('.picker-option-list');
    if (list) {
        list.innerHTML = renderVendorOptions(input.value);
    }
}

function subjectVendorPicker() {
    const subject = draft.subject;
    const vendor = getVendor(subject.vendorID);
    const displayedName = vendor?.name || subject.vendor.name || 'Choose a vendor';
    return `<label class="field wide" data-change-path="subject.vendorID"><span>Vendor</span>
        <details class="picker-menu vendor-picker" data-catalog-picker="vendor">
            <summary class="picker-summary${vendor || subject.vendor.name ? ' has-value' : ''}">
                ${vendor ? vendorMark(vendor) : '<span class="vendor-mark fallback"><i class="fa-regular fa-building" aria-hidden="true"></i></span>'}
                <span>${escapeHTML(displayedName)}</span><i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
            </summary>
            <div class="picker-panel">
                <label class="picker-search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input type="search" autocomplete="off" data-vendor-search value="${escapeHTML(subject.vendorQuery)}" placeholder="Search vendors or add a new one"></label>
                <div class="picker-option-list" role="listbox">${renderVendorOptions(subject.vendorQuery)}</div>
            </div>
        </details>
    </label>`;
}

function renderSubjectModelSuggestions(query) {
    const suggestions = subjectModelSuggestions(query);
    if (!String(query ?? '').trim() || suggestions.length === 0) {
        return '';
    }
    return `<div class="evaluation-suggestions model-suggestions" role="listbox" aria-label="Existing models">
        ${suggestions.map((model, index) => `<button type="button" role="option" data-select-subject-model="${escapeHTML(model.ID)}">
            <span class="model-suggestion-main">${vendorMark(getVendor(model.vendorID) ?? model)}<span><span translate="no" class="notranslate">${escapeHTML(model.name)}</span>${pendingBadge(model)}</span></span>
            ${index === 0 ? '<small>Tab</small>' : ''}
        </button>`).join('')}
    </div>`;
}

function updateSubjectModelSuggestions(input) {
    updateContributionSuggestions(input, renderSubjectModelSuggestions(input.value));
}

function setSubjectVendor(vendorID) {
    const vendor = getVendor(vendorID);
    if (!vendor) {
        return;
    }
    draft.subject.vendorID = vendor.ID;
    draft.subject.vendorRef = vendor.reference ?? null;
    draft.subject.vendorQuery = vendor.name;
    draft.subject.vendor = { name: vendor.name, logoKey: vendor.logoKey ?? '' };
}

function setNewSubjectVendor(name) {
    const value = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!value) {
        return;
    }
    draft.subject.vendorID = null;
    draft.subject.vendorRef = null;
    draft.subject.vendorQuery = value;
    draft.subject.vendor = { name: value, logoKey: '' };
}

function setSubjectModel(modelID) {
    const model = getModel(modelID);
    if (!model) return;
    if (model.pending) { showNotice('Model already submitted', 'This model is pending review. You can reference it in a score submission.'); return; }
    location.href = buildContributionURL('edit_model', { targetModelID: model.ID });
}

function clearSubjectModel(name = '') {
    const subject = draft.subject;
    const wasExisting = subject.existingModelID !== null;
    subject.existingModelID = null;
    subject.existingModelRef = null;
    subject.modelQuery = name;
    subject.name = name;
    if (wasExisting) {
        subject.introductionURL = '';
        subject.reviewerNotes = '';
    }
}







function subjectDetailsStep() {
    const subject = draft.subject;
    const existing = getModel(subject.existingModelID);
    const editing = mode === 'edit_model';
    const vendorSelected = existing || subject.vendorID !== null || Boolean(subject.vendor.name.trim());
    return `${editing ? changeOperationSelector() : ''}<div class="step-heading form-section-heading"><div><h2>Model</h2><p>Record the model identity. Add run-specific fields when submitting scores.</p></div></div>
    <section class="evaluation-identity-section">
        ${existing && !editing ? '' : subjectVendorPicker()}
        ${vendorSelected ? `<label class="field evaluation-name-field"><span>Model name</span>
            <div class="evaluation-combobox${existing ? ' has-selection has-model-selection' : editing ? ' has-selection' : ''}">${existing ? vendorMark(getVendor(existing.vendorID) ?? existing) : '<i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>'}
                <input required autocomplete="off" translate="no" class="notranslate"${editing ? ' data-bind="subject" data-field="name"' : ' role="combobox" aria-autocomplete="list" aria-expanded="false" data-subject-model-name'} value="${escapeHTML(editing ? subject.name : subject.modelQuery)}" placeholder="Search existing or enter a new model">
                ${existing || editing ? '' : renderSubjectModelSuggestions(subject.modelQuery)}
            </div>
        </label>` : ''}
    </section>
    ${existing && !editing ? '' : `<section class="evaluation-request-fields"><div class="field-grid">
        <label class="field wide"><span>Introduction URL <small>Optional</small></span><input type="url" data-bind="subject" data-field="introductionURL" value="${escapeHTML(subject.introductionURL)}" placeholder="https://model-card.example"></label>
    </div></section>`}
    <section class="evaluation-request-fields final-notes-section"><div class="field-grid">
        ${reviewerNotesField({ binding: 'subject', value: subject.reviewerNotes, placeholder: 'Shown with this item after approval.' })}
    </div></section>`;
}

function renderResultModelSuggestions(result, index) {
    const suggestions = modelSuggestions(result.modelQuery);
    if (!result.modelQuery.trim()) {
        return '';
    }
    const parts = result.modelQuery.split('/').map(part => part.trim()).filter(Boolean);
    const modelName = parts.length > 1 ? parts.at(-1) : result.modelQuery.trim();
    const vendorName = parts.length > 1 ? parts.slice(0, -1).join(' / ') : '';
    const query = buildContributionURL('new_model', { modelName, vendorName });
    return `<div class="evaluation-suggestions model-suggestions" role="listbox" aria-label="Existing models">${suggestions.map((model, suggestionIndex) => `<button type="button" role="option" data-select-result-model="${escapeHTML(model.ID)}" data-index="${index}"><span class="model-suggestion-main">${vendorMark(getVendor(model.vendorID) ?? model)}<span><span translate="no" class="notranslate">${escapeHTML(model.name)}</span>${pendingBadge(model)}</span></span>${suggestionIndex === 0 ? '<small>Tab</small>' : ''}</button>`).join('')}<a class="picker-create-link suggestion-create-link" href="${escapeHTML(query)}" target="_blank" rel="noopener"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i><span>Can’t find the model? Record a new model</span></a></div>`;
}

function renderResultObjectSuggestions(result, index) {
    const suggestions = benchmarkSuggestionChoices(result.benchmarkQuery);
    if (!result.benchmarkQuery.trim() || suggestions.length === 0) {
        return '';
    }
    return `<div class="evaluation-suggestions" role="listbox" aria-label="Existing benchmarks">${conditionSuggestionGroups(suggestions,
        ({ object, condition }) => `<button type="button" role="option"${manualResultConditionAllowed(condition) ? '' : ' disabled aria-disabled="true"'} data-select-result-object="${escapeHTML(object.ID)}" data-condition-id="${escapeHTML(condition.ID)}" data-index="${index}"><span>${benchmarkChoiceLabel(object, condition)}${syncedConditionNotice(condition)}</span>${conditionScoreCount(condition)}</button>`)}</div>`;
}

function manualResultConditionAllowed(condition) {
    return mode === 'edit_result' || condition.scoreSource === null;
}

function syncedConditionNotice(condition) {
    return manualResultConditionAllowed(condition) ? ''
        : '<small class="condition-source-notice">Scores sync automatically. Existing scores can be corrected from their details.</small>';
}

function updateResultSuggestionMenu(input, kind) {
    const index = Number(input.dataset.index);
    const result = draft.results[index];
    const markup = kind === 'model'
        ? renderResultModelSuggestions(result, index)
        : renderResultObjectSuggestions(result, index);
    updateContributionSuggestions(input, markup);
}

function clearExistingChoiceValidity(input) {
    input.setCustomValidity('');
    input.removeAttribute('aria-invalid');
    input.closest('.evaluation-combobox')?.classList.remove('has-error');
    input.closest('.field')?.querySelector('.field-validation-error')?.remove();
}

function showFieldError(input, message) {
    input.setCustomValidity?.(message);
    input.setAttribute('aria-invalid', 'true');
    const field = input.closest('.field') || input.parentElement;
    let error = field.querySelector('.field-validation-error');
    if (!error) {
        error = document.createElement('span');
        error.className = 'field-validation-error';
        error.setAttribute('role', 'status');
        field.append(error);
    }
    error.textContent = message;
}

function validateExistingChoiceInput(input) {
    const index = Number(input.dataset.index);
    const result = draft.results[index];
    if (!result || !input.value.trim()) {
        clearExistingChoiceValidity(input);
        return Boolean(result);
    }
    const model = input.dataset.existingChoice === 'model'
        ? getModel(result.modelID)
        : null;
    const benchmark = input.dataset.existingChoice === 'benchmark'
        ? getBenchmark(result.benchmarkID)
        : null;
    const valid = model
        ? normalizedSearch(input.value) === normalizedSearch(modelInputValue(model))
        : benchmark
            ? normalizedSearch(input.value) === normalizedSearch(benchmark.name)
            : false;
    const message = valid
        ? ''
        : input.dataset.existingChoice === 'model'
            ? 'Choose an existing model from the suggestions.'
            : 'Choose an existing benchmark from the suggestions.';
    input.setCustomValidity(message);
    if (valid) {
        input.removeAttribute('aria-invalid');
    } else {
        input.setAttribute('aria-invalid', 'true');
    }
    input.closest('.evaluation-combobox')?.classList.toggle('has-error', !valid);
    if (!valid) showFieldError(input, message);
    else clearExistingChoiceValidity(input);
    return valid;
}

function validateRenderedExistingChoices() {
    let valid = true;
    stepSurface.querySelectorAll('[data-existing-choice]').forEach(input => {
        valid = validateExistingChoiceInput(input) && valid;
    });
    return valid;
}

let conditionCheckQueue = Promise.resolve();
const confirmedConditionNames = new Map();



function editedCondition(input) {
    return selectedEvaluation().conditions[Number(input.dataset.profileIndex)];
}

async function confirmConditionMutation(condition, action, previousName, nextName = '') {
    if (!isChangeMode() || !Number.isSafeInteger(condition.ID)) return true;
    const response = await fetch('/api/get_condition_impact', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetKind: draft.change.targetKind, targetID: draft.change.targetID, conditionID: condition.ID }) });
    if (!response.ok) throw Error('Could not check linked scores and weights. Please try again.');
    const impact = await response.json();
    if (![impact.resultCount, impact.pieCount].every(value => Number.isSafeInteger(value) && value >= 0)) {
        throw Error('The dependency check returned invalid counts.');
    }
    const summary = `“${previousName}” is linked to ${impact.resultCount} score${impact.resultCount === 1 ? '' : 's'} and ${impact.pieCount} personal weight mix${impact.pieCount === 1 ? '' : 'es'}.`;
    if (action === 'delete' && (impact.resultCount || impact.pieCount)) {
        await G.showAlert(`${summary} It cannot be deleted while these references exist. Keep this version or merge the duplicate object instead.`, { title: 'This version is in use' });
        return false;
    }
    return G.showConfirm(`${summary} ${action === 'delete'
        ? 'Request deletion of this version?'
        : `${action === 'parameters' ? 'Update its parameters to' : 'Rename it to'} “${nextName}”? Its ID and linked records will be preserved; they will use the new name after approval.`}`,
    { title: action === 'delete' ? 'Delete version?' : action === 'parameters' ? 'Change model parameters?' : 'Rename version?', confirmLabel: action === 'delete' ? 'Request deletion' : action === 'parameters' ? 'Confirm change' : 'Confirm rename' });
}

function queueConditionRename(input) {
    const condition = editedCondition(input);
    if (!validateConditionNameLength(input, condition)) return;
    if (!isChangeMode() || !Number.isSafeInteger(condition?.ID)) return;
    const nextName = input.value;
    conditionCheckQueue = conditionCheckQueue.then(async () => {
        const previousName = confirmedConditionNames.get(condition.ID)
            ?? draft.change.before.conditions.find(item => item.ID === condition.ID)?.name;
        if (previousName === undefined || previousName === nextName) return;
        input.readOnly = true;
        let confirmed = false;
        try {
            confirmed = await confirmConditionMutation(condition, 'rename', previousName, nextName);
        } catch (error) { showFieldError(input, error.message); }
        if (confirmed) confirmedConditionNames.set(condition.ID, nextName);
        else {
            condition.name = previousName;
            condition.isDefault = isLiteralDefaultCondition(previousName);
            input = [...stepSurface.querySelectorAll('[data-condition-key]')]
                .find(panel => panel.dataset.conditionKey === conditionKey(condition))?.querySelector('[data-condition-input]') ?? input;
            input.value = previousName;
            input.closest('.condition-row')?.classList.toggle('is-default', condition.isDefault);
            validateConditionNameLength(input, condition);
            updateConditionHeading(input);
        }
        input.readOnly = false;
        decorateChangedFields();
    });
}

function queueConditionDeletion(conditions, index, button) {
    const condition = conditions[index];
    conditionCheckQueue = conditionCheckQueue.then(async () => {
        button.disabled = true;
        try {
            if (await confirmConditionMutation(condition, 'delete', condition.name)) {
                const currentIndex = conditions.indexOf(condition);
                if (currentIndex >= 0 && conditions.length > 1) {
                    conditions.splice(currentIndex, 1);
                    if (condition.isPrimary) conditions[0].isPrimary = true;
                    if (expandedConditionKey === conditionKey(condition)) {
                        expandedConditionKey = conditionKey(conditions[Math.min(currentIndex, conditions.length - 1)]);
                        focusNewCondition = true;
                    }
                }
                renderCurrentStep();
            }
        } catch (error) { showNotice('Could not check this version', error.message); }
        finally { button.disabled = false; }
    });
}

function refreshSuggestionControl(input) {
    refreshCatalogForControl(input, () => {
        if (!contributionSearches.get(input)?.wanted || document.activeElement !== input) return;
        if (input.matches('[data-evaluation-name]')) {
            updateEvaluationSuggestionMenu(input);
        } else if (input.matches('[data-subject-model-name]')) {
            updateSubjectModelSuggestions(input);
        } else if (input.matches('[data-result-model-query]')) {
            updateResultSuggestionMenu(input, 'model');
        } else if (input.matches('[data-result-object-query]')) {
            updateResultSuggestionMenu(input, 'object');
        }
    });
}

function setResultModel(index, modelID) {
    const model = getModel(modelID);
    const result = draft.results[index];
    if (!model || !result) {
        return;
    }
    result.modelID = model.ID;
    result.modelRef = model.reference ?? null;
    result.modelQuery = modelInputValue(model);
}

function setResultObject(index, benchmarkID, conditionID = null) {
    const object = getBenchmark(benchmarkID);
    const result = draft.results[index];
    if (!object || !result) {
        return;
    }
    const requested = object.conditions.find(profile => sameEntityID(profile.ID, conditionID));
    if (requested && !manualResultConditionAllowed(requested)) return;
    result.benchmarkID = object.ID;
    result.benchmarkRef = object.reference ?? null;
    result.benchmarkQuery = object.name;
    const defaultProfile = requested
        ?? object.conditions.find(profile => profile.isPrimary && manualResultConditionAllowed(profile))
        ?? object.conditions.find(manualResultConditionAllowed);
    result.benchmarkConditionID = defaultProfile?.ID ?? null;
    result.benchmarkConditionRef = defaultProfile?.reference ?? null;
}

function profileUsesPercentage(profile) {
    return Boolean(profile?.usesPercentageScale);
}

function resultStoredScore(result) {
    const displayScore = finiteOrNull(result.rawScore);
    if (displayScore === null) {
        return null;
    }
    return displayScore;
}



function addProfileLink(object) {
    if (!object) {
        return '';
    }
    const values = {
        benchmarkName: object.name
    };
    if (!object.reference) values.benchmarkID = String(object.ID);
    return buildContributionURL('new_benchmark', values);
}



function renderResultProfileOptions(object, index) {
    return conditionSuggestionGroups(object.conditions.map(condition => ({ condition })), ({ condition }) =>
        `<button type="button" class="picker-option"${manualResultConditionAllowed(condition) ? '' : ' disabled aria-disabled="true"'} data-select-result-profile="${escapeHTML(condition.ID)}" data-index="${index}"><span>${escapeHTML(condition.name)}${pendingBadge(condition)}${syncedConditionNotice(condition)}</span>${conditionScoreCount(condition)}</button>`);
}



function resultProfilePicker(result, index, object) {
    if (!object) {
        return '';
    }
    const selected = getBenchmarkCondition(result.benchmarkConditionID)?.profile;
    return `<div class="field" data-change-path="result.benchmarkConditionID"><span>Version</span><details class="picker-menu" data-catalog-picker="benchmark-condition" data-index="${index}"><summary aria-label="Choose version" class="picker-summary${selected ? ' has-value' : ''}"><span>${escapeHTML(selected?.name || 'Choose a version')}</span><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></summary><div class="picker-panel"><div class="picker-option-list" role="listbox">${renderResultProfileOptions(object, index)}</div><a class="picker-create-link" href="${escapeHTML(addProfileLink(object))}" target="_blank" rel="noopener"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i><span>Can’t find the version? Add one</span></a></div></details></div>`;
}

function refreshOpenCatalogPicker(picker) {
    const kind = picker.dataset.catalogPicker;
    if (kind === 'vendor') {
        const state = contributionSearches.get(picker);
        const input = state?.input;
        if (!state?.layer.isOpen || state.panel.contains(document.activeElement) && document.activeElement !== input) return;
        if (input) updateVendorOptions(input);
        return;
    }
    const index = Number(picker.dataset.index);
    const result = draft.results[index];
    const list = picker.querySelector('.picker-option-list');
    const createLink = picker.querySelector('.picker-create-link');
    if (!result || !list) {
        throw new Error('The opened selector no longer matches this form row.');
    }
    if (kind === 'benchmark-condition') {
        const object = getBenchmark(result.benchmarkID);
        if (!object) throw new Error('The selected benchmark is no longer available.');
        list.innerHTML = renderResultProfileOptions(object, index);
        if (createLink) createLink.href = addProfileLink(object);
    }
}

function refreshCatalogForControl(control, updateControl) {
    const token = Symbol('catalog-refresh');
    pickerRefreshTokens.set(control, token);
    control.setAttribute('aria-busy', 'true');
    void refreshContributionCatalog()
        .then(applied => {
            if (applied && control.isConnected && pickerRefreshTokens.get(control) === token) {
                updateControl();
            }
        })
        .catch(error => {
            if (pickerRefreshTokens.get(control) === token) {
                showError(error.message || 'Choices could not be refreshed. Your draft is unchanged.');
            }
        })
        .finally(() => {
            if (pickerRefreshTokens.get(control) === token) {
                pickerRefreshTokens.delete(control);
                control.removeAttribute('aria-busy');
            }
        });
}

function copyResult(index) {
    const source = draft.results[index];
    if (!source) return null;
    const identity = makeResult(draft.results.length);
    draft.results.push({
        ...structuredClone(source),
        clientRef: identity.clientRef
    });
    return draft.results.length - 1;
}

function resultCard(result, index) {
    const model = getModel(result.modelID);
    const object = getBenchmark(result.benchmarkID);
    const profile = getBenchmarkCondition(result.benchmarkConditionID)?.profile;
    const isPercentage = profileUsesPercentage(profile);
    return `<article class="entry-card score-entry-card" data-result-card="${index}">
        <header class="entry-card-header"><strong>Score ${index + 1}</strong><span class="entry-card-actions">${mode === 'benchmark_result' ? `<button class="soft-icon-button copy-result-button" type="button" data-action="copy-result" data-index="${index}" aria-label="Copy as a new score" data-tooltip="Copy as a new score"><i class="fa-regular fa-copy" aria-hidden="true"></i></button>` : ''}${draft.results.length > 1 ? `<button class="soft-icon-button" type="button" data-action="remove-result" data-index="${index}" aria-label="Remove result"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>` : ''}</span></header>
        <div class="entry-card-body"><div class="field-grid">
            <label class="field" data-change-path="result.modelID"><span>Model</span><div class="evaluation-combobox${model ? ' has-selection has-model-selection' : ''}">${model ? vendorMark(getVendor(model.vendorID) ?? model) : '<i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>'}<input required autocomplete="off" translate="no" class="notranslate" role="combobox" aria-autocomplete="list" aria-expanded="false" data-existing-choice="model" data-result-model-query data-index="${index}" value="${escapeHTML(result.modelQuery)}" placeholder="Search models">${model ? '' : renderResultModelSuggestions(result, index)}</div></label>
            <label class="field" data-change-path="result.benchmarkID"><span>Benchmark</span><div class="evaluation-combobox${object ? ' has-selection' : ''}"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input required autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" data-existing-choice="benchmark" data-result-object-query data-index="${index}" value="${escapeHTML(result.benchmarkQuery)}" placeholder="Search existing benchmarks">${object ? '' : renderResultObjectSuggestions(result, index)}</div></label>
            ${resultProfilePicker(result, index, object)}
            <label class="field wide"><span>Score</span><div class="score-input-shell${isPercentage ? ' percentage' : ''}"><input required type="text" inputmode="text" autocapitalize="off" autocomplete="off" spellcheck="false" data-score-value-input data-bind="result" data-index="${index}" data-field="rawScore" value="${escapeHTML(result.rawScore)}"${profile ? '' : ' disabled'} placeholder="${profile ? '0' : 'Choose a version first'}">${isPercentage ? '<span>%</span>' : ''}</div></label>
        </div><section class="score-field-editor" data-score-fields-editor="${index}" data-change-path="result.scoreFields"></section></div>
    </article>`;
}

function resultsStep() {
    const editing = mode === 'edit_result';
    const sourceLabel = draft.results.length > 1 ? 'All source URLs' : 'Source URL';
    const sharedSourceURL = draft.results[0]?.sourceURL ?? '';
    return `${editing ? changeOperationSelector() : ''}<div class="step-heading"><div><h2>Model scores</h2></div></div>
    <div class="repeater-list">${draft.results.map(resultCard).join('')}</div>
    ${editing ? '' : '<div class="score-repeater-actions"><button class="add-row-button" type="button" data-action="add-result"><i class="fa-solid fa-plus" aria-hidden="true"></i><span>Add score</span></button></div>'}
    <section class="result-submission-notes"><div class="field-grid">
        <label class="field wide" data-change-path="${editing ? 'result.sourceURL' : ''}"><span>${sourceLabel}</span><input required type="url" data-bind="result" data-index="0" data-field="sourceURL" value="${escapeHTML(sharedSourceURL)}" placeholder="https://official-source.example/results"></label>
        ${reviewerNotesField({ binding: 'resultBatch', value: draft.resultNotes, placeholder: 'Shown with each score after approval.' })}
    </div></section>`;
}

function reportDetailsStep() {
    const target = param('targetName') || selectedContextLabel();
    return `<div class="step-heading"><div><h2>Describe the requested change</h2><p>The target remains visible while you add the evidence a reviewer needs.</p></div></div>
    <div class="source-panel"><div class="field-grid">
        <label class="field wide"><span>Target</span><input value="${escapeHTML(target)}" disabled></label>
        <label class="field wide"><span>Source URL <small>Optional</small></span><input type="url" data-bind="report" data-field="sourceURL" value="${escapeHTML(draft.report.sourceURL)}" placeholder="https://authoritative-source.example"></label>
        <label class="field wide" data-final-notes><span>Notes</span><textarea required data-bind="report" data-field="details" placeholder="Explain exactly what should change and why.">${escapeHTML(draft.report.details)}</textarea></label>
    </div></div>`;
}

function feedbackDetailsStep() {
    return `<section class="feedback-editor">
        <p id="feedback-guidance" class="feedback-guidance" translate="yes">${escapeHTML(feedbackInstructions)}</p>
        <label class="field wide" data-final-notes>
            <span>Your message</span>
            <textarea required minlength="10" maxlength="${feedbackMessageLimit(feedbackInstructions)}" data-bind="feedback" data-field="details" aria-describedby="feedback-guidance" placeholder="Write your message">${escapeHTML(draft.feedback.details)}</textarea>
        </label>
    </section>`;
}

function discussionReportStep() {
    return `<div class="form-grid">
        <label class="field wide"><span>Discussion post ID</span><input required inputmode="numeric" pattern="[1-9][0-9]*" data-bind="report" data-field="postID" value="${escapeHTML(draft.report.postID)}" placeholder="Post number"></label>
        <label class="field wide"><span>Reason</span><select data-bind="report" data-field="reason">${[
            ['spam', 'Spam or advertising'], ['harassment', 'Harassment or abuse'], ['misinformation', 'Misleading information'], ['other', 'Other']
        ].map(([value, label]) => option(value, label, draft.report.reason)).join('')}</select></label>
        <label class="field wide" data-final-notes><span>Reason and notes</span><textarea required minlength="10" maxlength="4000" data-bind="report" data-field="details" placeholder="Explain the problem and include supporting details.">${escapeHTML(draft.report.details)}</textarea></label>
    </div>`;
}

function normalizedText(value) {
    return String(value ?? '').trim();
}

function evaluationScoreFieldsChanged(evaluation) {
    if (mode !== 'edit_benchmark' || !draft.change.baseline?.evaluation) {
        return false;
    }
    const baseline = draft.change.baseline.evaluation;
    return ['scoreDirection', 'targetValue', 'usesPercentageScale', 'scoreMin', 'scoreMax']
        .some(field => !sameClientValue(evaluation[field], baseline[field]));
}

function evaluationProfileChangeProposal(profile, evaluation) {
    const useSharedScoreFields = integerOrNull(profile.ID) === null
        || evaluationScoreFieldsChanged(evaluation);
    const usesPercentageScale = useSharedScoreFields
        ? Boolean(evaluation.usesPercentageScale)
        : Boolean(profile.usesPercentageScale);
    const scoreMin = useSharedScoreFields
        ? evaluationScoreBounds(evaluation).min
        : usesPercentageScale ? null : finiteOrNull(profile.scoreMin);
    const scoreMax = useSharedScoreFields
        ? evaluationScoreBounds(evaluation).max
        : usesPercentageScale ? null : finiteOrNull(profile.scoreMax);
    const scoreDirection = useSharedScoreFields ? evaluation.scoreDirection : profile.scoreDirection;
    const targetValue = useSharedScoreFields
        ? evaluationStoredTargetValue(evaluation)
        : scoreDirection === 'closer_to_target'
            ? finiteOrNull(profile.targetValue)
            : null;
    return {
        ID: integerOrNull(profile.ID),
        name: normalizedText(profile.name),
        differenceExplanation: normalizedText(profile.differenceExplanation),
        scoreMin,
        scoreMax,
        scoreDirection,
        targetValue,
        usesPercentageScale,
        isDefault: isLiteralDefaultCondition(profile.name),
        isPrimary: profile.isPrimary
    };
}

function evaluationChangeProposal() {
    const evaluation = selectedEvaluation();
    return {
        name: normalizedText(evaluation.name),
        introductionURL: normalizedText(evaluation.introductionURL),
        description: normalizedText(evaluation.description),
        requestOfficialSync: evaluation.requestOfficialSync,
        officialSyncURL: normalizedText(evaluation.officialSyncURL),
        officialSyncInstructions: normalizedText(evaluation.officialSyncInstructions),
        notes: normalizedText(evaluation.reviewerNotes),
        conditions: evaluation.conditions.map(profile => (
            evaluationProfileChangeProposal(profile, evaluation)
        ))
    };
}



function modelChangeProposal() {
    const subject = draft.subject;
    return {
        vendorID: Number(subject.vendorID),
        name: normalizedText(subject.name),
        introductionURL: normalizedText(subject.introductionURL),
        notes: normalizedText(subject.reviewerNotes)
    };
}

function resultChangeProposal() {
    const payload = resultsPayload();
    return {
        result: (() => {
            const result = payload.results[0];
            return {
                modelID: result.modelID,
                scoreFields: structuredClone(draft.results[0].scoreFields).sort((left, right) => left.fieldID - right.fieldID),
                benchmarkID: result.benchmarkID,
                benchmarkConditionID: result.benchmarkConditionID,
                rawScore: result.rawScore,
                notes: normalizedText(draft.resultNotes),
                source: result.source
            };
        })()
    };
}

function entityChangeSubmissionProposal() {
    const proposed = currentChangeProposal();
    if (mode === 'edit_model') {
        const { vendorID, ...modelFields } = proposed;
        return {
            ...modelFields,
            vendor: {
                existingVendorID: vendorID,
                existingVendorRef: null
            }
        };
    }
    if (mode === 'edit_result') {
        return {
            results: [{
                clientRef: 'edited-result',
                ...proposed.result,
                scoreFields: contributionScoreFields(proposed.result.scoreFields, catalog.scoreFields),
                modelRef: null,
                benchmarkRef: null,
                benchmarkConditionRef: null
            }]
        };
    }
    return proposed;
}

function currentChangeProposal() {
    if (mode === 'edit_benchmark') {
        return evaluationChangeProposal();
    }
    if (mode === 'edit_model') {
        return modelChangeProposal();
    }
    return resultChangeProposal();
}

function canonicalClientValue(value) {
    if (Array.isArray(value)) {
        return value.map(canonicalClientValue);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalClientValue(value[key])]));
    }
    return value ?? null;
}

function sameClientValue(left, right) {
    return JSON.stringify(canonicalClientValue(left)) === JSON.stringify(canonicalClientValue(right));
}

function describeClientChanges(before, after, path = '', changes = []) {
    if (sameClientValue(before, after)) {
        return changes;
    }
    if (Array.isArray(before) && Array.isArray(after)
        && before.every(item => item && typeof item === 'object' && Number.isInteger(item.ID))
        && after.every(item => item && typeof item === 'object' && Number.isInteger(item.ID))) {
        const afterByID = new Map(after.map(item => [item.ID, item]));
        before.forEach(item => describeClientChanges(item, afterByID.get(item.ID), `${path}[${item.ID}]`, changes));
        return changes;
    }
    if (before && after && typeof before === 'object' && typeof after === 'object'
        && !Array.isArray(before) && !Array.isArray(after)) {
        const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
        keys.forEach(key => {
            if (key !== 'ID' && key !== 'clientRef') {
                describeClientChanges(before[key], after[key], path ? `${path}.${key}` : key, changes);
            }
        });
        return changes;
    }
    changes.push({ field: path || 'value', before, after });
    return changes;
}

function changeFieldLabel(path) {
    const labels = {
        name: mode === 'edit_model' ? 'Model name' : 'Benchmark name',
        vendorID: 'Vendor',
        introductionURL: 'Introduction URL',
        description: 'Introduction',
        requestOfficialSync: 'Official-source score sync request',
        officialSyncURL: 'Official source URL',
        officialSyncInstructions: 'Sync instructions',
        rawScore: 'Score',
        source: 'Source',
        differenceExplanation: 'Version differences'
    };
    const key = String(path).split('.').at(-1);
    const leaf = key.replace(/([A-Z])/g, ' $1').trim();
    const base = labels[key] ?? leaf.replace(/^./, character => character.toUpperCase());
    const conditionMatch = String(path).match(/^(?:(?:evaluation|subject)\.)?conditions\[(\d+)\]\.(.+)$/);
    if (conditionMatch) {
        const conditions = selectedEvaluation().conditions;
        const condition = conditions.find(item => Number(item.ID) === Number(conditionMatch[1]));
        const fieldLabel = conditionMatch[2] === 'name'
            ? 'Version name'
            : changeFieldLabel(conditionMatch[2]);
        return `${condition?.name || (mode === 'edit_model' ? 'Model condition' : 'Version')}, ${fieldLabel}`;
    }
    if (String(path).startsWith('result.')) {
        return changeFieldLabel(String(path).slice(7));
    }
    return base;
}

function renderCurrentStep() {
    const details = MODE_DETAILS[mode];
    if (!details) {
        return;
    }
    for (const state of contributionSearches.values()) state.destroy();
    if (isChangeMode() && draft.change.operation === 'delete') {
        stepSurface.innerHTML = changeDeleteStep();
    } else if (mode === 'new_benchmark' || mode === 'edit_benchmark') {
        stepSurface.innerHTML = evaluationDetailsStep();
    } else if (mode === 'new_model' || mode === 'edit_model') {
        stepSurface.innerHTML = subjectDetailsStep();
    } else if (mode === 'benchmark_result' || mode === 'edit_result') {
        stepSurface.innerHTML = resultsStep();
    } else if (mode === 'report') {
        stepSurface.innerHTML = discussionReportStep();
    } else if (mode === 'feedback') {
        stepSurface.innerHTML = feedbackDetailsStep();
    } else {
        stepSurface.innerHTML = reportDetailsStep();
    }
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        stepSurface.animate([
            { opacity: 0.55, transform: 'translateY(3px)' },
            { opacity: 1, transform: 'translateY(0)' }
        ], { duration: 210, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    }
    stepSurface.querySelectorAll('[data-score-fields-editor]').forEach(host => {
        const result = draft.results[Number(host.dataset.scoreFieldsEditor)];
        mountScoreFields(host, { assignments: result.scoreFields, getFields: () => catalog.scoreFields,
            refresh: refreshContributionCatalog, onChange: decorateChangedFields });
    });
    decorateChangedFields();
    stepSurface.querySelectorAll('.evaluation-suggestions').forEach(panel => panel.remove());
    stepSurface.querySelectorAll('[data-catalog-picker="vendor"]').forEach(mountVendorPicker);
    enhanceUI(stepSurface);
    if (focusNewCondition) {
        focusNewCondition = false;
        requestAnimationFrame(() => setExpandedCondition(expandedConditionKey, { focus: true }));
    }
}

function setNested(target, path, value) {
    const parts = path.split('.');
    let cursor = target;
    for (let index = 0; index < parts.length - 1; index++) {
        cursor = cursor[parts[index]];
    }
    cursor[parts.at(-1)] = value;
}

function getNested(target, path) {
    return String(path).split('.').reduce((value, part) => value?.[part], target);
}

function parsedConditionChangePath(path) {
    const match = String(path).match(/^(evaluation|subject)\.conditions\[(\d+)\]\.(.+)$/);
    if (!match) {
        return null;
    }
    return {
        root: match[1],
        conditionID: Number(match[2]),
        fieldPath: match[3]
    };
}

function changePathValue(target, path) {
    if (path === 'evaluation.primaryCondition') {
        const primary = target.evaluation.conditions.find(condition => condition.isPrimary);
        return primary?.ID ?? primary?.clientRef;
    }
    const conditionPath = parsedConditionChangePath(path);
    if (!conditionPath) {
        return getNested(target, path);
    }
    const condition = target[conditionPath.root]?.conditions?.find(candidate => (
        Number(candidate.ID) === conditionPath.conditionID
    ));
    return condition ? getNested(condition, conditionPath.fieldPath) : undefined;
}

function setChangePathValue(target, path, value) {
    const conditionPath = parsedConditionChangePath(path);
    if (!conditionPath) {
        setNested(target, path, value);
        return true;
    }
    const condition = target[conditionPath.root]?.conditions?.find(candidate => (
        Number(candidate.ID) === conditionPath.conditionID
    ));
    if (!condition) {
        return false;
    }
    setNested(condition, conditionPath.fieldPath, value);
    return true;
}

function currentChangeDraftView() {
    return {
        evaluation: selectedEvaluation(),
        subject: draft.subject,
        result: draft.results[0],
        get resultNotes() { return draft.resultNotes; },
        set resultNotes(value) { draft.resultNotes = value; }
    };
}

function changePathForControl(control) {
    const explicitPath = control.closest('[data-change-path]')?.dataset.changePath;
    if (explicitPath) {
        return explicitPath;
    }
    const binding = control.dataset.bind;
    const field = control.dataset.field;
    if (!binding || !field || binding === 'change' || binding === 'resultBatch') {
        return '';
    }
    if (binding === 'evaluation') return `evaluation.${field}`;
    if (binding === 'profile') {
        const condition = selectedEvaluation().conditions[Number(control.dataset.profileIndex)];
        const conditionID = integerOrNull(condition?.ID);
        return conditionID === null ? '' : `evaluation.conditions[${conditionID}].${field}`;
    }
    if (binding === 'subject') return `subject.${field}`;
    if (binding === 'result') return `result.${field}`;
    return '';
}

function restoreChangePath(path) {
    const baseline = draft.change.baseline;
    if (!baseline || !path) {
        return;
    }
    const current = currentChangeDraftView();
    if (path === 'evaluation.primaryCondition') {
        const original = baseline.evaluation.conditions.find(condition => condition.isPrimary);
        if (!original) return;
        let restored = current.evaluation.conditions.find(condition => condition.ID === original.ID);
        if (!restored) {
            restored = structuredClone(original);
            current.evaluation.conditions.push(restored);
        }
        current.evaluation.conditions.forEach(condition => { condition.isPrimary = condition === restored; });
    } else if (path === 'subject.vendorID') {
        for (const field of ['vendorID', 'vendorRef', 'vendorQuery', 'vendor']) {
            current.subject[field] = structuredClone(baseline.subject[field]);
        }
    } else if (path === 'result.modelID') {
        for (const field of ['modelID', 'modelRef', 'modelQuery']) {
            current.result[field] = structuredClone(baseline.result[field]);
        }
    } else if (path === 'result.benchmarkID') {
        for (const field of ['benchmarkID', 'benchmarkRef', 'benchmarkQuery', 'benchmarkConditionID', 'benchmarkConditionRef']) {
            current.result[field] = structuredClone(baseline.result[field]);
        }
    } else {
        const baselineValue = changePathValue(baseline, path);
        if (baselineValue === undefined
            || !setChangePathValue(current, path, structuredClone(baselineValue))) {
            return;
        }
    }
    const restoredCondition = path.match(/\.conditions\[(\d+)\]\.name$/);
    if (restoredCondition) confirmedConditionNames.delete(Number(restoredCondition[1]));
    renderCurrentStep();
}

function decorateChangedFields() {
    if (!isChangeMode() || !draft.change.baseline) {
        return;
    }
    // Keep focused buttons stable when blur/change follows pointerdown.
    const existing = new Map([...stepSurface.querySelectorAll('.field-restore-button')]
        .map(button => [button.dataset.restorePath, button]));
    const modifiedContainers = new Set();
    const candidates = [
        ...stepSurface.querySelectorAll('[data-bind]'),
        ...stepSurface.querySelectorAll('[data-change-path]')
    ];
    const decorated = new Set();
    for (const candidate of candidates) {
        const path = changePathForControl(candidate);
        if (!path || decorated.has(path)) {
            continue;
        }
        const currentValue = changePathValue(currentChangeDraftView(), path);
        const baselineValue = changePathValue(draft.change.baseline, path);
        if (sameClientValue(currentValue, baselineValue)) {
            continue;
        }
        const container = candidate.matches('[data-change-path]')
            ? candidate
            : candidate.closest('.field, .condition-name, .percentage-scale-toggle') ?? candidate.parentElement;
        if (!container) {
            continue;
        }
        container.classList.add('is-modified');
        modifiedContainers.add(container);
        decorated.add(path);
        if (existing.get(path)?.parentElement === container) continue;
        existing.get(path)?.remove();
        const restore = document.createElement('button');
        restore.type = 'button';
        restore.className = 'field-restore-button';
        restore.dataset.restorePath = path;
        restore.dataset.tooltip = 'Restore original value';
        restore.setAttribute('aria-label', `Restore ${changeFieldLabel(path)}`);
        restore.innerHTML = '<i class="fa-solid fa-rotate-left" aria-hidden="true"></i>';
        container.append(restore);
    }
    for (const [path, button] of existing) {
        if (!decorated.has(path)) button.remove();
    }
    stepSurface.querySelectorAll('.is-modified').forEach(container => {
        if (!modifiedContainers.has(container)) container.classList.remove('is-modified');
    });
}

function updateBoundField(target) {
    const binding = target.dataset.bind;
    const field = target.dataset.field;
    if (!binding || !field) {
        return;
    }
    let value = target.type === 'checkbox' ? target.checked : target.value;
    if (binding === 'evaluation') {
        setNested(draft.benchmarks[Number(target.dataset.index)], field, value);
    } else if (binding === 'profile') {
        setNested(
            draft.benchmarks[Number(target.dataset.evaluationIndex)].conditions[Number(target.dataset.profileIndex)],
            field,
            value
        );
    } else if (binding === 'subject') {
        setNested(draft.subject, field, value);
    } else if (binding === 'result') {
        setNested(draft.results[Number(target.dataset.index)], field, value);
    } else if (binding === 'resultBatch') {
        draft.resultNotes = value;

    } else if (binding === 'report') {
        setNested(draft.report, field, value);
    } else if (binding === 'feedback') {
        setNested(draft.feedback, field, value);
    } else if (binding === 'change') {
        setNested(draft.change, field, value);
    }
}

function validateEvaluationConditionNames() {
    const evaluation = selectedEvaluation();
    if (!evaluation.name.trim()) {
        showError('Enter a benchmark name before submitting.');
        return false;
    }
    if (evaluation.conditions.length < 1) {
        showError('Add at least one new version.');
        return false;
    }
    if ((!selectedExistingObject() || mode === 'edit_benchmark')
        && evaluation.conditions.filter(condition => condition.isPrimary).length !== 1) {
        showError('Choose one primary version.');
        return false;
    }

    const conditionNames = evaluation.conditions.map(profile => normalizedConditionName(profile.name));
    let lengthsValid = true;
    evaluation.conditions.forEach((profile, index) => {
        const input = stepSurface.querySelector(`[data-condition-input][data-profile-index="${index}"]`);
        if (input && !validateConditionNameLength(input, profile)) lengthsValid = false;
    });
    if (!lengthsValid) {
        reportInvalidField();
        return false;
    }
    if (conditionNames.some(name => name === '')) {
        const input = stepSurface.querySelector(`[data-condition-input][data-profile-index="${conditionNames.indexOf('')}"]`);
        showFieldError(input, 'Every new version needs a name.');
        reportInvalidField(input);
        return false;
    }
    if (new Set(conditionNames).size !== conditionNames.length) {
        const beforeByID = mode === 'edit_benchmark'
            ? new Map(draft.change.before.conditions.map(condition => [condition.ID, condition])) : new Map();
        const repeated = evaluation.conditions.filter((profile, index) => conditionNames.some((name, otherIndex) =>
            index !== otherIndex && name === conditionNames[index]));
        if (repeated.some(profile => !profile.ID || beforeByID.get(profile.ID)?.name !== profile.name)) {
            const profile = repeated.find(profile => !profile.ID || beforeByID.get(profile.ID)?.name !== profile.name);
            const input = stepSurface.querySelector(`[data-condition-input][data-profile-index="${evaluation.conditions.indexOf(profile)}"]`);
            showFieldError(input, 'New or renamed versions must have unique names, including default.');
            reportInvalidField(input);
            return false;
        }
    }

    const existing = selectedExistingObject();
    if (existing && mode !== 'edit_benchmark') {
        const existingNames = new Set(existing.conditions.map(profile => normalizedConditionName(profile.name)));
        const duplicate = conditionNames.find(name => existingNames.has(name));
        if (duplicate) {
            showError(`The version “${duplicate}” already exists. Use the Change benchmark information form to edit it.`);
            return false;
        }
    } else if (mode !== 'edit_benchmark') {
        const duplicateObject = catalog.benchmarks.find(object => (
            object.name.toLocaleLowerCase('en-US') === evaluation.name.trim().toLocaleLowerCase('en-US')
        ));
        if (duplicateObject) {
            const input = stepSurface.querySelector('[data-evaluation-name]');
            showFieldError(input, 'Already listed. Select the matching row above to add a version on its change form.');
            input.focus();
            return false;
        }
    }

    const { min: scoreMin, max: scoreMax } = evaluationDisplayScoreBounds(evaluation);
    if (!evaluation.usesPercentageScale && (scoreMin === null || scoreMax === null)) {
        showError('Enter both the lowest and highest values for normalization.');
        return false;
    }
    if (scoreMin !== null && scoreMax !== null && scoreMax <= scoreMin) {
        showError('The highest score must be greater than the lowest score.');
        return false;
    }
    const targetValue = finiteOrNull(evaluation.targetValue);
    if (evaluation.scoreDirection === 'closer_to_target'
        && (targetValue === null
            || (scoreMin !== null && targetValue < scoreMin)
            || (scoreMax !== null && targetValue > scoreMax))) {
        showError('Enter a target value inside the score range.');
        return false;
    }

    return true;
}

function validateSubjectConfigurationNames() {
    const subject = draft.subject;
    if (!subject.name.trim() || !subject.vendor.name.trim()) { showError('Enter a model name and choose a vendor.'); return false; }
    if (mode !== 'edit_model' && catalog.models.some(model =>
        normalizedSearch(model.name) === normalizedSearch(subject.name) && normalizedSearch(model.vendorName) === normalizedSearch(subject.vendor.name))) {
        showError('This model already exists. Open its change form instead.'); return false;
    }
    return true;
}

function validateChangeHasChanges() {
    if (draft.change.operation === 'delete') {
        if (draft.change.reviewNotes.trim().length < 3) {
            showError('Explain why this object should be deleted.');
            return false;
        }
        return true;
    }
    let proposed;
    try {
        proposed = currentChangeProposal();
    } catch (error) {
        showError(error.message || 'One of the changed fields is invalid.');
        return false;
    }
    if (describeClientChanges(draft.change.before, proposed).length === 0) {
        showError('Change at least one structured field before requesting review.');
        return false;
    }
    return true;
}

function syncRenderedFormFields() {
    stepSurface.querySelectorAll('[data-bind][data-field]').forEach(control => {
        if (control.disabled || control.matches('input[type="radio"]')) {
            return;
        }
        updateBoundField(control);
    });
    const percentageScale = stepSurface.querySelector('[data-score-percentage]');
    if (percentageScale) {
        selectedEvaluation().usesPercentageScale = percentageScale.checked;
    }
}

function validateContribution() {
    syncRenderedFormFields();
    const existingChoicesValid = validateRenderedExistingChoices();
    const fieldsValid = form.checkValidity();
    if (!existingChoicesValid || !fieldsValid) {
        reportInvalidField();
        return false;
    }
    if (isChangeMode() && draft.change.operation !== 'update') {
        return validateChangeHasChanges();
    }
    if (mode === 'new_benchmark' || mode === 'edit_benchmark') {
        if (!validateEvaluationConditionNames()) {
            return false;
        }
    }
    if (mode === 'new_model' || mode === 'edit_model') {
        if (!validateSubjectConfigurationNames()) {
            return false;
        }
    }
    if (mode === 'feedback') {
        try { feedbackSubmission(feedbackInstructions, draft.feedback.details); }
        catch (error) { showError(error.message); return false; }
    }
    if (mode === 'benchmark_result' || mode === 'edit_result') {
        if (!draft.results[0]?.sourceURL.trim()) {
            showError('Add the source URL for this score submission.');
            return false;
        }
        const seenPairs = new Set();
        for (const result of draft.results) {
            const profileMatch = getBenchmarkCondition(result.benchmarkConditionID);
            const model = getModel(result.modelID);
            const score = resultStoredScore(result);
            if (!model || !profileMatch || score === null) {
                showError('Every score needs a model, version, and numeric score.');
                return false;
            }
            if (!manualResultConditionAllowed(profileMatch.profile)) {
                showError('This version syncs automatically. To correct an existing score, open its score details.');
                return false;
            }
            const percentage = profileUsesPercentage(profileMatch.profile);
            if (percentage && (score < 0 || score > 100)) {
                showError(`${profileMatch.object.name} / ${profileMatch.profile.name} accepts percentage scores from 0% to 100%.`);
                return false;
            }
            const pair = JSON.stringify([entityKey(model.ID), entityKey(profileMatch.profile.ID), result.scoreFields, score]);
            if (seenPairs.has(pair)) {
                showError('This submission contains the same model, fields, version and score more than once.');
                return false;
            }
            seenPairs.add(pair);
        }
    }
    if (isChangeMode() && !validateChangeHasChanges()) {
        return false;
    }
    return true;
}

function evaluationPayload() {
    return {
        type: 'new_benchmark',
        benchmarks: draft.benchmarks.map(candidate => ({
            existingBenchmarkID: candidate.existingBenchmarkRef ? null : candidate.existingBenchmarkID,
            existingBenchmarkRef: candidate.existingBenchmarkRef,
            clientRef: candidate.clientRef,
            name: candidate.name,
            introductionURL: candidate.introductionURL,
            description: candidate.description,
            requestOfficialSync: candidate.requestOfficialSync,
            officialSyncURL: candidate.officialSyncURL,
            officialSyncInstructions: candidate.officialSyncInstructions,
            reviewerNotes: candidate.reviewerNotes,
            conditions: candidate.conditions.map(profile => ({
                clientRef: profile.clientRef,
                name: profile.name,
                differenceExplanation: profile.differenceExplanation,
                scoreMin: evaluationScoreBounds(candidate).min,
                scoreMax: evaluationScoreBounds(candidate).max,
                scoreDirection: candidate.scoreDirection,
                targetValue: evaluationStoredTargetValue(candidate),
                usesPercentageScale: Boolean(candidate.usesPercentageScale),
                isDefault: isLiteralDefaultCondition(profile.name),
                isPrimary: profile.isPrimary
            }))
        }))
    };
}



function subjectPayload() {
    const subject = draft.subject;
    return {
        type: 'new_model',
        models: [{
            clientRef: subject.clientRef,
            existingModelID: subject.existingModelRef ? null : subject.existingModelID,
            existingModelRef: subject.existingModelRef,
            name: subject.name,
            introductionURL: subject.introductionURL,
            reviewerNotes: subject.reviewerNotes,
            vendor: subject.existingModelID === null ? {
                existingVendorID: subject.vendorRef ? null : subject.vendorID,
                existingVendorRef: subject.vendorRef,
                name: subject.vendor.name,
                logoKey: subject.vendor.logoKey
            } : null
        }]
    };
}

function resultsPayload() {
    const sharedSourceURL = draft.results[0]?.sourceURL ?? '';
    return {
        type: 'benchmark_result',
        reviewerNotes: draft.resultNotes,
        results: draft.results.map(result => {
            const model = getModel(result.modelID);
            const object = getBenchmark(result.benchmarkID);
            const profile = getBenchmarkCondition(result.benchmarkConditionID)?.profile;
            return {
                clientRef: result.clientRef,
                ...entityLocator(model, 'modelID', 'modelRef'),
                scoreFields: contributionScoreFields(result.scoreFields, catalog.scoreFields),
                ...entityLocator(object, 'benchmarkID', 'benchmarkRef'),
                ...entityLocator(profile, 'benchmarkConditionID', 'benchmarkConditionRef'),
                rawScore: resultStoredScore(result),
                source: {
                    type: result.sourceType || 'other',
                    url: sharedSourceURL,
                    title: result.sourceTitle || ''
                }
            };
        })
    };
}

function submissionPayload() {
    if (isChangeMode()) {
        return {
            type: 'entity_change',
            targetKind: draft.change.targetKind,
            targetID: draft.change.targetID,
            operation: draft.change.operation,
            reviewNotes: draft.change.reviewNotes,
            proposed: draft.change.operation === 'update'
                ? entityChangeSubmissionProposal()
                : null
        };
    }
    if (mode === 'new_benchmark') {
        return evaluationPayload();
    }
    if (mode === 'new_model') {
        return subjectPayload();
    }
    if (mode === 'benchmark_result') {
        return resultsPayload();
    }
    if (mode === 'report') {
        return { type: 'discussion_report', postID: Number(draft.report.postID), reason: draft.report.reason,
            details: draft.report.details };
    }
    if (mode === 'feedback') {
        return {
            type: 'feedback',
            details: feedbackSubmission(feedbackInstructions, draft.feedback.details),
            pageURL: param('pageURL') || document.referrer
        };
    }
    return {
        type: 'report_issue',
        issueType: mode,
        targetName: param('targetName') || selectedContextLabel(),
        targetKind: param('targetKind') || (mode === 'delete_or_migrate_category' ? 'category' : 'benchmark'),
        targetBenchmarkID: integerOrNull(param('targetBenchmarkID') || param('benchmarkID')),
        categoryPath: param('categoryPath'),
        pageURL: param('pageURL') || document.referrer,
        sourceURL: draft.report.sourceURL,
        details: draft.report.details
    };
}

function showError(message) {
    errorCopy.textContent = message;
    errorDialog.hidden = false;
}

function showNotice(dialogTitle, message) {
    noticeTitle.textContent = dialogTitle;
    noticeCopy.textContent = message;
    noticeDialog.hidden = false;
}

function contributionSubmissionError(error, status) {
    const messages = {
        verified_email_required: 'Log out and sign in with GitHub again to authorize a verified email address for review notifications.',
        authentication_required: 'Your session ended. Refresh this page and sign in again before submitting.',
        dynamic_scores_are_synced: 'This version syncs automatically. To correct an existing score, open its score details.',
        dynamic_score_condition_immutable: 'A synced score must keep its original version. Report a source-mapping problem through feedback.',
        discussion_already_reported: 'You already have a pending report for this message.',
        discussion_report_daily_limit: 'You have reached the daily report limit. Please try again tomorrow.',
        discussion_post_unavailable: 'That discussion post could not be found. Check its post number.',
        report_details_required: 'Explain the report in at least 10 characters.',
        benchmark_condition_in_use: 'This version already has scores or personal weights, so it cannot be removed. Keep the version or request deletion of the whole benchmark.',
        change_request_has_no_changes: 'The submitted fields still match the published object. Reload the latest version and make the intended change again.',
        change_target_modified_since_submission: 'This object changed after you opened the form. Reload the page and review the latest values before submitting again.',
        write_identity_required: 'This form needs a refresh before submitting safely. Keep your draft and reopen the form.',
        write_identity_reused: 'This retry no longer matches the original submission. Keep your draft and reopen the form.'
    };
    return messages[error?.error] || error?.error || `Request failed (${status})`;
}

let submissionPending = false;
async function submitDraft() {
    if (submissionPending) return;
    submissionPending = true;
    submitButton.disabled = true;
    try {
        await conditionCheckQueue;
        if (!validateContribution()) return;
        if (!hasVerifiedEmail) {
            showError('Log out and sign in with GitHub again to authorize a verified email address for review notifications.');
            return;
        }
        await pageAccountWriteScope.write(postWriteJSON, '/api/submit_contribution', submissionPayload());
        successDialog.hidden = false;
    } catch (error) {
        if (error.payload?.error === 'verified_email_required') hasVerifiedEmail = false;
        showError(isAccountWriteError(error) ? error.message : error.payload
            ? contributionSubmissionError(error.payload, error.status)
            : error.message || 'The contribution could not be submitted.');
    } finally {
        submissionPending = false;
        submitButton.disabled = false;
    }
}

function configureMode() {
    const details = MODE_DETAILS[mode];
    if (!details) {
        entryMissing.hidden = false;
        formSurface.hidden = true;
        authMissing.hidden = true;
        title.textContent = 'Choose what to add or change';
        subtitle.textContent = 'Start from a benchmark or model in the rankings.';
        return false;
    }
    title.textContent = details.title;
    subtitle.textContent = details.subtitle;
    subtitle.hidden = mode === 'feedback';
    renderCurrentStep();
    return true;
}

function applyContributionCatalog(nextCatalog) {
    if (nextCatalog.benchmarks.some(benchmark => !Array.isArray(benchmark.conditions)
        || benchmark.conditions.some(condition => typeof condition.lowCoverage !== 'boolean'))) {
        throw new Error('Benchmark coverage information could not be loaded.');
    }
    catalog = nextCatalog;
    evaluationNameOptions.innerHTML = catalog.benchmarks.map(object => `<option value="${escapeHTML(object.name)}"></option>`).join('');
}

async function requestContributionCatalog() {
    const response = await fetch('/api/get_contribution_catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: '{}'
    });
    if (!response.ok) {
        throw new Error(`Unable to load the contribution catalog (${response.status}).`);
    }
    return validateContributionCatalog(await response.json());
}

async function refreshContributionCatalog() {
    const requestSequence = ++catalogRequestSequence;
    const nextCatalog = await requestContributionCatalog();
    if (requestSequence !== catalogRequestSequence) {
        return false;
    }
    applyContributionCatalog(nextCatalog);
    return true;
}

async function loadCatalog() {
    if (!await refreshContributionCatalog()) {
        throw new Error('The initial contribution catalog request was superseded.');
    }

    const requestedModel = getModel(param('modelID'));
    const requestedVendor = getVendor(param('vendorID'));
    const requestedObject = getBenchmark(param('benchmarkID') || param('targetBenchmarkID'));
    const requestedEvaluationName = param('benchmarkName');
    if (requestedModel && mode === 'new_model') {
        setSubjectModel(requestedModel.ID);
    } else if (mode === 'new_model') {
        if (requestedVendor) {
            setSubjectVendor(requestedVendor.ID);
        } else if (param('vendorName')) {
            setNewSubjectVendor(param('vendorName'));
        }
        if (param('modelName')) {
            const exactModel = catalog.models.find(model => (
                normalizedSearch(model.name) === normalizedSearch(param('modelName'))
                && (!param('vendorName') || normalizedSearch(model.vendorName) === normalizedSearch(param('vendorName')))
            ));
            if (exactModel) {
                setSubjectModel(exactModel.ID);
            } else {
                draft.subject.name = param('modelName');
                draft.subject.modelQuery = param('modelName');
            }
        }
    }
    if (requestedModel && mode === 'benchmark_result') {
        setResultModel(0, requestedModel.ID);
    }
    if (requestedObject && mode === 'new_benchmark') {
        selectedEvaluation().name = requestedObject.name;
    } else if (requestedEvaluationName && mode === 'new_benchmark') {
        const exactObject = catalog.benchmarks.find(object => object.name.toLocaleLowerCase('en-US') === requestedEvaluationName.toLocaleLowerCase('en-US'));
        if (exactObject) {
            selectedEvaluation().name = exactObject.name;
        } else {
            selectedEvaluation().name = requestedEvaluationName;
        }
    }
    if (requestedObject && mode === 'benchmark_result') {
        setResultObject(0, requestedObject.ID);
    }
}

function optionalNumberText(value) {
    return value === null || value === undefined ? '' : String(value);
}

function hydrateEvaluationChange(form) {
    const defaultProfile = form.conditions.find(profile => profile.isPrimary);
    if (!defaultProfile || form.conditions.filter(profile => profile.isPrimary).length !== 1) {
        throw new Error('The benchmark must have exactly one primary version.');
    }
    const usesPercentageScale = profileUsesPercentage(defaultProfile);
    draft.benchmarks = [{
        ...makeEvaluation(0),
        existingBenchmarkID: draft.change.targetID,
        name: form.name,
        introductionURL: form.introductionURL ?? '',
        description: form.description,
        requestOfficialSync: form.requestOfficialSync,
        officialSyncURL: form.officialSyncURL,
        officialSyncInstructions: form.officialSyncInstructions,
        scoreDirection: defaultProfile.scoreDirection,
        targetValue: defaultProfile.targetValue === null || defaultProfile.targetValue === undefined
            ? ''
            : String(defaultProfile.targetValue),
        usesPercentageScale,
        scoreMin: optionalNumberText(defaultProfile.scoreMin),
        scoreMax: optionalNumberText(defaultProfile.scoreMax),
        reviewerNotes: form.notes,
        conditions: form.conditions.map(profile => {
            return {
                ...makeProfile(0),
                ID: Number(profile.ID),
                name: profile.name,
                differenceExplanation: profile.differenceExplanation,
                usesPercentageScale: profileUsesPercentage(profile),
                scoreMin: optionalNumberText(profile.scoreMin),
                scoreMax: optionalNumberText(profile.scoreMax),
                scoreDirection: profile.scoreDirection,
                targetValue: optionalNumberText(profile.targetValue),
                isDefault: Boolean(profile.isDefault),
                isPrimary: profile.isPrimary,
                isExisting: true
            };
        })
    }];
}

function hydrateModelChange(form) {
    const vendor = getVendor(form.vendorID);
    draft.subject = {
        ...makeSubject(),
        existingModelID: draft.change.targetID,
        modelQuery: form.name,
        reviewerNotes: form.notes,
        name: form.name,
        introductionURL: form.introductionURL ?? '',
        vendorID: Number(form.vendorID),
        vendorQuery: vendor?.name ?? '',
        vendor: {
            name: vendor?.name ?? '',
            logoKey: vendor?.logoKey ?? ''
        }
    };
}

function hydrateResultChange(form) {
    const result = makeResult(0);
    const model = getModel(form.result.modelID);
    const object = getBenchmark(form.result.benchmarkID);
    result.modelID = form.result.modelID;
    result.modelQuery = model ? modelInputValue(model) : '';
    result.scoreFields = structuredClone(form.result.scoreFields);
    result.benchmarkID = form.result.benchmarkID;
    result.benchmarkQuery = object?.name ?? '';
    result.benchmarkConditionID = form.result.benchmarkConditionID;
    result.rawScore = String(form.result.rawScore);
    result.sourceURL = form.result.source.url;
    result.sourceType = form.result.source.type;
    result.sourceTitle = form.result.source.title ?? '';
    draft.results = [result];
    draft.resultNotes = form.result.notes;
}

function captureChangeDraft() {
    if (mode === 'edit_benchmark') {
        return { evaluation: structuredClone(selectedEvaluation()) };
    }
    if (mode === 'edit_model') {
        return { subject: structuredClone(draft.subject) };
    }
    return { result: structuredClone(draft.results[0]), resultNotes: draft.resultNotes };
}

async function loadChangeTarget() {
    if (!isChangeMode()) {
        return;
    }
    const targetKind = mode === 'edit_benchmark' ? 'benchmark' : mode === 'edit_model' ? 'model' : 'result';
    const targetID = integerOrNull(
        targetKind === 'benchmark'
            ? param('targetBenchmarkID')
            : targetKind === 'model'
                ? param('targetModelID')
                : param('targetResultID')
    );
    if (targetID === null) {
        throw new Error('This change link does not identify a valid object.');
    }
    const response = await fetch('/api/get_contribution_target', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetKind, targetID })
    });
    if (!response.ok) {
        throw new Error('The object could not be converted into an editable form.');
    }
    const payload = await response.json();
    draft.change.targetKind = payload.targetKind;
    draft.change.targetID = Number(payload.targetID);
    draft.change.operation = param('operation') === 'delete' ? 'delete' : 'update';
    if (targetKind === 'benchmark') {
        hydrateEvaluationChange(payload.form);
    } else if (targetKind === 'model') {
        hydrateModelChange(payload.form);
    } else {
        hydrateResultChange(payload.form);
    }
    draft.change.before = targetKind === 'benchmark'
        ? Object.fromEntries(Object.keys(evaluationChangeProposal()).map(key => [key, structuredClone(payload.form[key])]))
        : structuredClone(payload.form);
    draft.change.baseline = captureChangeDraft();
    if (param('addCondition') === '1' && targetKind !== 'result') {
        const conditions = selectedEvaluation().conditions;
        const condition = makeProfile(conditions.length);
        condition.name = '';
        condition.isDefault = false;
        condition.isPrimary = false;
        conditions.push(condition);
        expandedConditionKey = conditionKey(condition);
        focusNewCondition = true;
    }
}

async function loadUser() {
    const response = await fetch('/api/get_user_profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
    });
    if (response.status === 204) {
        pageAccountWriteScope.bind(null);
        sidebarLogin.hidden = false;
        sidebarUser.hidden = true;
        return null;
    }
    if (!response.ok) {
        throw new Error('Unable to load your account.');
    }
    const user = await response.json();
    pageAccountWriteScope.bind(user.userID);
    hasVerifiedEmail = user.hasVerifiedEmail === true;
    const emailNotice = document.querySelector('.submission-email-notice > span');
    const emailHeading = document.createElement('strong');
    emailHeading.textContent = user.reviewEmailEnabled === true
        ? 'You will receive the review result by email.' : 'Your contribution will be reviewed.';
    emailNotice.replaceChildren(emailHeading, document.createTextNode(user.reviewEmailEnabled === true
        ? ' We will use the verified address linked to your GitHub account.'
        : ' Email notifications are currently unavailable.'));
    successDialog.querySelector('[slot="body"]').textContent = user.reviewEmailEnabled === true
        ? 'Your contribution is waiting for review. We will email the verified address from your GitHub account when the review is complete.'
        : 'Your contribution is waiting for review. Email notifications are currently unavailable.';
    sidebarUserName.textContent = user.userName;
    accountDialogName.textContent = user.userName;
    [sidebarUserPicture, accountDialogPicture].forEach(picture => {
        if (user.userProfilePictureURL) {
            picture.textContent = '';
            picture.style.backgroundImage = `url(${JSON.stringify(user.userProfilePictureURL)})`;
            picture.style.backgroundPosition = 'center';
            picture.style.backgroundSize = 'cover';
        } else {
            picture.style.backgroundImage = '';
            picture.textContent = String(user.userName ?? '?').slice(0, 1).toUpperCase();
        }
    });
    sidebarUser.hidden = false;
    sidebarLogin.hidden = true;
    return user;
}

taxonomyToggle.addEventListener('click', () => {
    setTaxonomyOpen(!document.body.classList.contains('taxonomy-open'));
});
function closeTaxonomy() {
    setTaxonomyOpen(false);
}
taxonomyClose.addEventListener('click', closeTaxonomy);
taxonomyScrim.addEventListener('click', closeTaxonomy);
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.body.classList.contains('taxonomy-open')) {
        closeTaxonomy();
        taxonomyToggle.focus();
    }
});

function handleStepInput(event) {
    const evaluationName = event.target.closest('[data-evaluation-name]');
    if (evaluationName) {
        clearExistingChoiceValidity(evaluationName);
        const current = selectedEvaluation();
        if (current.existingBenchmarkID !== null && evaluationName.value !== selectedExistingObject()?.name) {
            clearEvaluationSelection(evaluationName.value);
            renderCurrentStep();
            requestAnimationFrame(() => {
                const replacement = stepSurface.querySelector('[data-evaluation-name]');
                replacement?.focus();
                replacement?.setSelectionRange(replacement.value.length, replacement.value.length);
            });
            return;
        }
        current.name = evaluationName.value;
        updateEvaluationSuggestionMenu(evaluationName);
        return;
    }
    const vendorSearch = event.target.closest('[data-vendor-search]');
    if (vendorSearch) {
        draft.subject.vendorQuery = vendorSearch.value;
        if (mode === 'edit_model') {
            updateVendorOptions(vendorSearch);
            return;
        }
        const selectedVendor = getVendor(draft.subject.vendorID);
        const selectedVendorName = selectedVendor?.name || draft.subject.vendor.name;
        if (selectedVendorName && normalizedSearch(selectedVendorName) !== normalizedSearch(vendorSearch.value)) {
            draft.subject.vendorID = null;
            draft.subject.vendorRef = null;
            draft.subject.vendor = { name: '', logoKey: '' };
            clearSubjectModel('');
            renderCurrentStep();
            requestAnimationFrame(() => {
                const picker = stepSurface.querySelector('[data-catalog-picker="vendor"]');
                openVendorPicker(picker);
                const replacement = contributionSearches.get(picker)?.input;
                replacement?.focus();
                replacement?.setSelectionRange(replacement.value.length, replacement.value.length);
            });
            return;
        }
        updateVendorOptions(vendorSearch);
        return;
    }
    const subjectModelName = event.target.closest('[data-subject-model-name]');
    if (subjectModelName) {
        const subject = draft.subject;
        const existing = getModel(subject.existingModelID);
        if (existing && subjectModelName.value !== existing.name) {
            clearSubjectModel(subjectModelName.value);
            renderCurrentStep();
            requestAnimationFrame(() => {
                const replacement = stepSurface.querySelector('[data-subject-model-name]');
                replacement?.focus();
                replacement?.setSelectionRange(replacement.value.length, replacement.value.length);
            });
            return;
        }
        subject.modelQuery = subjectModelName.value;
        subject.name = subjectModelName.value;
        updateSubjectModelSuggestions(subjectModelName);
        return;
    }
    const resultModelQuery = event.target.closest('[data-result-model-query]');
    if (resultModelQuery) {
        clearExistingChoiceValidity(resultModelQuery);
        const index = Number(resultModelQuery.dataset.index);
        const result = draft.results[index];
        const model = getModel(result.modelID);
        if (model && resultModelQuery.value !== modelInputValue(model)) {
            result.modelID = null;
            result.modelRef = null;
            result.modelQuery = resultModelQuery.value;
            renderCurrentStep();
            requestAnimationFrame(() => {
                const replacement = stepSurface.querySelector(`[data-result-model-query][data-index="${index}"]`);
                replacement?.focus();
                replacement?.setSelectionRange(replacement.value.length, replacement.value.length);
            });
            return;
        }
        result.modelQuery = resultModelQuery.value;
        updateResultSuggestionMenu(resultModelQuery, 'model');
        return;
    }
    const resultObjectQuery = event.target.closest('[data-result-object-query]');
    if (resultObjectQuery) {
        clearExistingChoiceValidity(resultObjectQuery);
        const index = Number(resultObjectQuery.dataset.index);
        const result = draft.results[index];
        const object = getBenchmark(result.benchmarkID);
        if (object && resultObjectQuery.value !== object.name) {
            result.benchmarkID = null;
            result.benchmarkRef = null;
            result.benchmarkConditionID = null;
            result.benchmarkConditionRef = null;
            result.benchmarkQuery = resultObjectQuery.value;
            renderCurrentStep();
            requestAnimationFrame(() => {
                const replacement = stepSurface.querySelector(`[data-result-object-query][data-index="${index}"]`);
                replacement?.focus();
                replacement?.setSelectionRange(replacement.value.length, replacement.value.length);
            });
            return;
        }
        result.benchmarkQuery = resultObjectQuery.value;
        updateResultSuggestionMenu(resultObjectQuery, 'object');
        return;
    }
    updateBoundField(event.target);
    const conditionInput = event.target.closest('[data-condition-input]');
    if (conditionInput) {
        updateConditionHeading(conditionInput);
        clearExistingChoiceValidity(conditionInput);
        const row = conditionInput.closest('.condition-row');
        const isDefault = isLiteralDefaultCondition(conditionInput.value);
        if (conditionInput.matches('[data-condition-input]')) {
            const profile = draft.benchmarks[Number(conditionInput.dataset.evaluationIndex)]
                ?.conditions[Number(conditionInput.dataset.profileIndex)];
            if (profile) {
                profile.isDefault = isDefault;
                validateConditionNameLength(conditionInput, profile);
            }
        }
        row?.classList.toggle('is-default', isDefault);
        // Correcting either side of a duplicate must clear the other row's stale error.
        for (const sibling of stepSurface.querySelectorAll('[data-condition-input]')) {
            if (sibling === conditionInput) continue;
            clearExistingChoiceValidity(sibling);
            validateConditionNameLength(sibling, editedCondition(sibling));
        }
    }
    decorateChangedFields();
}
stepSurface.addEventListener('input', handleStepInput);

stepSurface.addEventListener('change', event => {
    updateBoundField(event.target);
    if (event.target.matches('[data-field="requestOfficialSync"]')) {
        renderCurrentStep();
        return;
    }
    if (event.target.matches('[data-condition-input]')) {
        queueConditionRename(event.target);
    }
    const percentageScale = event.target.closest('[data-score-percentage]');
    if (percentageScale) {
        const evaluation = selectedEvaluation();
        evaluation.usesPercentageScale = percentageScale.checked;
        if (percentageScale.checked) {
            evaluation.scoreMin = '';
            evaluation.scoreMax = '';
        }
        renderCurrentStep();
        return;
    }
    const scoreDirection = event.target.closest('[data-bind="evaluation"][data-field="scoreDirection"]');
    if (scoreDirection) {
        renderCurrentStep();
        return;
    }
    const profileScoreDirection = event.target.closest('[data-bind="profile"][data-field="scoreDirection"]');
    if (profileScoreDirection) {
        renderCurrentStep();
        return;
    }
    decorateChangedFields();
});

function handleStepKeydown(event) {
    if (event.isComposing || event.key === 'Tab' && event.shiftKey) return;
    const vendorSearch = event.target.closest('[data-vendor-search]');
    if (vendorSearch && ['Tab', 'Enter'].includes(event.key) && vendorSearch.value.trim()) {
        const closest = vendorSuggestions(vendorSearch.value)[0];
        if (closest) {
            event.preventDefault();
            setSubjectVendor(closest.ID);
            renderCurrentStep();
            requestAnimationFrame(() => stepSurface.querySelector('[data-subject-model-name]')?.focus());
        }
        if (event.key === 'Enter') event.preventDefault();
        return;
    }
    const subjectModelName = event.target.closest('[data-subject-model-name]');
    if (subjectModelName && event.key === 'Tab' && subjectModelName.value.trim()) {
        const closest = subjectModelSuggestions(subjectModelName.value)[0];
        if (closest) {
            event.preventDefault();
            setSubjectModel(closest.ID);
            renderCurrentStep();
            requestAnimationFrame(() => stepSurface.querySelector('[data-subject-model-name]')?.focus());
        }
        return;
    }
    const resultModelQuery = event.target.closest('[data-result-model-query]');
    if (resultModelQuery && event.key === 'Tab' && resultModelQuery.value.trim()) {
        const closest = modelSuggestions(resultModelQuery.value)[0];
        if (closest) {
            event.preventDefault();
            setResultModel(Number(resultModelQuery.dataset.index), closest.ID);
            renderCurrentStep();
        }
        return;
    }
    const resultObjectQuery = event.target.closest('[data-result-object-query]');
    if (resultObjectQuery && event.key === 'Tab' && resultObjectQuery.value.trim()) {
        const source = contributionSearches.get(resultObjectQuery)?.panel;
        const closest = [...source?.querySelectorAll('[data-select-result-object]') ?? []]
            .find(button => !button.disabled && !button.closest('details:not([open])') && button.getClientRects().length > 0);
        if (closest) {
            event.preventDefault();
            setResultObject(Number(resultObjectQuery.dataset.index), closest.dataset.selectResultObject, closest.dataset.conditionId);
            renderCurrentStep();
        }
        return;
    }
    const evaluationName = event.target.closest('[data-evaluation-name]');
    if (evaluationName && event.key === 'Tab' && evaluationName.value.trim()) {
        const closest = evaluationSuggestions(evaluationName.value)[0];
        if (closest) {
            event.preventDefault();
            [...contributionSearches.get(evaluationName)?.panel.querySelectorAll('[data-select-evaluation]') ?? []]
                .find(button => button.getClientRects().length > 0)?.focus();
        }
        return;
    }
}
stepSurface.addEventListener('keydown', handleStepKeydown);

stepSurface.addEventListener('focusin', event => {
    const evaluationName = event.target.closest('[data-evaluation-name]');
    if (evaluationName) {
        updateEvaluationSuggestionMenu(evaluationName);
        refreshSuggestionControl(evaluationName);
    }
    const subjectModelName = event.target.closest('[data-subject-model-name]');
    if (subjectModelName) {
        updateSubjectModelSuggestions(subjectModelName);
        refreshSuggestionControl(subjectModelName);
    }
    const resultModelQuery = event.target.closest('[data-result-model-query]');
    if (resultModelQuery) {
        updateResultSuggestionMenu(resultModelQuery, 'model');
        refreshSuggestionControl(resultModelQuery);
    }
    const resultObjectQuery = event.target.closest('[data-result-object-query]');
    if (resultObjectQuery) {
        updateResultSuggestionMenu(resultObjectQuery, 'object');
        refreshSuggestionControl(resultObjectQuery);
    }
});

stepSurface.addEventListener('toggle', event => {
    const picker = event.target.matches('[data-catalog-picker]') ? event.target : null;
    if (picker?.dataset.catalogPicker === 'vendor') {
        if (picker.open) openVendorPicker(picker);
        else contributionSearches.get(picker)?.layer.close();
    }
    if (picker?.open) {
        refreshCatalogForControl(picker, () => refreshOpenCatalogPicker(picker));
    }
}, true);

stepSurface.addEventListener('focusout', event => {
    const evaluationCombobox = event.target.closest('.evaluation-combobox');
    if (evaluationCombobox) {
        setTimeout(() => {
            const input = evaluationCombobox.querySelector('input');
            const state = contributionSearches.get(input);
            if (evaluationCombobox.isConnected && !(state?.layer.contains(document.activeElement) ?? evaluationCombobox.contains(document.activeElement))) {
                const existingChoice = evaluationCombobox.querySelector('[data-existing-choice]');
                if (existingChoice) {
                    validateExistingChoiceInput(existingChoice);
                }
                state?.layer.close();
                evaluationCombobox.querySelector('[role="combobox"]')?.setAttribute('aria-expanded', 'false');
            }
        }, 120);
    }
});

function handleStepClick(event) {
    const conditionToggle = event.target.closest('[data-condition-toggle]');
    if (conditionToggle) {
        event.preventDefault();
        const panel = conditionToggle.closest('[data-condition-key]');
        setExpandedCondition(panel.open ? null : panel.dataset.conditionKey);
        return;
    }
    const restore = event.target.closest('[data-restore-path]');
    if (restore) {
        restoreChangePath(restore.dataset.restorePath);
        return;
    }
    const changeOperation = event.target.closest('[data-change-operation]');
    if (changeOperation) {
        if (changeOperation.dataset.changeOperation === 'merge') {
            requestMerge();
            return;
        }
        draft.change.operation = changeOperation.dataset.changeOperation;
        renderCurrentStep();
        return;
    }
    const vendorSuggestion = event.target.closest('[data-select-vendor]');
    if (vendorSuggestion) {
        setSubjectVendor(vendorSuggestion.dataset.selectVendor);
        renderCurrentStep();
        return;
    }
    const createVendor = event.target.closest('[data-create-vendor]');
    if (createVendor) {
        setNewSubjectVendor(createVendor.dataset.createVendor);
        renderCurrentStep();
        return;
    }
    const subjectModelSuggestion = event.target.closest('[data-select-subject-model]');
    if (subjectModelSuggestion) {
        setSubjectModel(subjectModelSuggestion.dataset.selectSubjectModel);
        renderCurrentStep();
        return;
    }
    const resultModelSuggestion = event.target.closest('[data-select-result-model]');
    if (resultModelSuggestion) {
        setResultModel(Number(resultModelSuggestion.dataset.index), resultModelSuggestion.dataset.selectResultModel);
        renderCurrentStep();
        return;
    }
    const resultObjectSuggestion = event.target.closest('[data-select-result-object]');
    if (resultObjectSuggestion) {
        if (resultObjectSuggestion.disabled) return;
        setResultObject(Number(resultObjectSuggestion.dataset.index), resultObjectSuggestion.dataset.selectResultObject, resultObjectSuggestion.dataset.conditionId);
        renderCurrentStep();
        return;
    }
    const resultProfile = event.target.closest('[data-select-result-profile]');
    if (resultProfile) {
        if (resultProfile.disabled) return;
        const result = draft.results[Number(resultProfile.dataset.index)];
        const profile = getBenchmarkCondition(resultProfile.dataset.selectResultProfile)?.profile;
        if (profile && !manualResultConditionAllowed(profile)) return;
        result.benchmarkConditionID = profile?.ID ?? null;
        result.benchmarkConditionRef = profile?.reference ?? null;
        renderCurrentStep();
        return;
    }
    const evaluationSuggestion = event.target.closest('[data-select-evaluation]');
    if (evaluationSuggestion) {
        const benchmark = getBenchmark(evaluationSuggestion.dataset.selectEvaluation);
        if (benchmark?.pending) {
            showFieldError(stepSurface.querySelector('[data-evaluation-name]'), 'This benchmark has already been submitted and is awaiting review.');
        } else if (benchmark) {
            const url = new URL(buildContributionURL('edit_benchmark', { targetBenchmarkID: benchmark.ID, addCondition: '1' }), location.origin);
            location.assign(activateContributionURL(url.href));
        }
        return;
    }
    const actionTarget = event.target.closest('[data-action]');
    if (actionTarget) {
        const action = actionTarget.dataset.action;
        if (action === 'explain-existing-condition') {
            showNotice(
                'Existing version',
                'Existing versions cannot be changed in the Record benchmark form. Open Change benchmark information to edit or remove one.'
            );
            return;
        } else if (action === 'add-evaluation') {
            draft.benchmarks.push(makeEvaluation(draft.benchmarks.length));
        } else if (action === 'remove-evaluation') {
            draft.benchmarks.splice(Number(actionTarget.dataset.index), 1);
        } else if (action === 'set-primary-condition') {
            const evaluation = selectedEvaluation();
            evaluation.conditions.forEach((profile, index) => {
                profile.isPrimary = index === Number(actionTarget.dataset.profileIndex);
            });
        } else if (action === 'add-profile') {
            const evaluation = draft.benchmarks[Number(actionTarget.dataset.evaluationIndex)];
            const profile = makeProfile(evaluation.conditions.length);
            profile.name = '';
            profile.isDefault = false;
            profile.isPrimary = false;
            evaluation.conditions.push(profile);
            expandedConditionKey = conditionKey(profile);
            focusNewCondition = true;
        } else if (action === 'remove-profile') {
            const evaluation = draft.benchmarks[Number(actionTarget.dataset.evaluationIndex)];
            if (evaluation.conditions.length <= 1) {
                showNotice('Keep one version', 'A benchmark request must contain at least one new version.');
                return;
            }
            const profileIndex = Number(actionTarget.dataset.profileIndex);
            queueConditionDeletion(evaluation.conditions, profileIndex, actionTarget);
            return;
        } else if (action === 'add-result') {
            draft.results.push(makeResult(draft.results.length));
        } else if (action === 'copy-result') {
            const copiedIndex = copyResult(Number(actionTarget.dataset.index));
            renderCurrentStep();
            if (copiedIndex !== null) {
                requestAnimationFrame(() => {
                    stepSurface.querySelector(`[data-result-card="${copiedIndex}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                });
            }
            return;
        } else if (action === 'remove-result') {
            const sharedSourceURL = draft.results[0]?.sourceURL ?? '';
            draft.results.splice(Number(actionTarget.dataset.index), 1);
            if (draft.results[0]) {
                draft.results[0].sourceURL = sharedSourceURL;
            }
        }
        renderCurrentStep();
        return;
    }
}
stepSurface.addEventListener('click', handleStepClick);

form.addEventListener('submit', event => {
    event.preventDefault();
    submitDraft();
});

document.querySelectorAll('.dialog-close-button').forEach(button => {
    button.addEventListener('click', () => {
        button.closest('global-dialog').hidden = true;
    });
});

successDialog.querySelector('.dialog-close-button').addEventListener('click', () => {
    window.location.href = '/';
});

authLogin.addEventListener('click', () => G.loginWithGitHub());
sidebarLogin.addEventListener('click', () => G.loginWithGitHub());
sidebarUser.addEventListener('click', () => {
    accountDialog.hidden = false;
    requestAnimationFrame(() => accountLogoutButton.focus());
});
accountLogoutButton.addEventListener('click', () => {
    accountDialog.hidden = true;
    logoutConfirmDialog.hidden = false;
});
accountDeleteButton.addEventListener('click', () => {
    accountDialog.hidden = true;
    deleteConfirmDialog.hidden = false;
});

async function runAccountAction(url, button) {
    button.setAttribute('disabled', '');
    try {
        await pageAccountWriteScope.write(postJSON, url);
        window.location.reload();
    } catch (error) {
        button.removeAttribute('disabled');
        showError(error.message || 'The account action could not be completed.');
    }
}

logoutConfirmButton.addEventListener('click', () => runAccountAction('/api/logout', logoutConfirmButton));
deleteConfirmButton.addEventListener('click', () => runAccountAction('/api/delete_account', deleteConfirmButton));
const contributionGuide = document.getElementById('contribution-guide-dialog');
let guideTrigger = null;
function showContributionGuide(event) {
    guideTrigger = event.currentTarget;
    contributionGuide.hidden = false;
    contributionGuide.returnFocus = guideTrigger;
    contributionGuide.shadowRoot.querySelector('.dialog-body').scrollTop = 0;
}
function closeContributionGuide() {
    contributionGuide.hidden = true;
    guideTrigger?.focus({ preventScroll: true });
}
contributionGuide.querySelector('.dialog-close-button').addEventListener('click', closeContributionGuide);

const contributionHelpButton = document.getElementById('contribution-help');
contributionHelpButton.addEventListener('click', showContributionGuide);
contributionHelpButton.disabled = false;

async function initialize() {
    try {
        if (contributionEntry.error) throw new Error(contributionEntry.error);
        if (mode === 'feedback' && feedbackMessageLimit(feedbackInstructions) < 10) {
            throw new Error('The prefilled instructions are too long. Please open a fresh feedback form.');
        }
        await loadCatalog();
        const user = await loadUser();
        authenticated = Boolean(user);
        if (authenticated) {
            await loadChangeTarget();
        }
        if (!configureMode()) {
            return;
        }
        if (!authenticated) {
            authMissing.hidden = false;
            formSurface.hidden = true;
            entryMissing.hidden = true;
            return;
        }
        formSurface.hidden = false;
        authMissing.hidden = true;
        entryMissing.hidden = true;
    } catch (error) {
        showError(error.message || 'The contribution page could not be loaded.');
    }
}

initialize();
