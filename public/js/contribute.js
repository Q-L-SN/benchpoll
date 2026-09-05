import * as G from '/js/global.js';

const params = new URLSearchParams(window.location.search);
const formSurface = document.getElementById('form-surface');
const entryMissing = document.getElementById('entry-missing');
const authMissing = document.getElementById('auth-missing');
const form = document.getElementById('contribution-form');
const stepSurface = document.getElementById('contribution-step');
const submitButton = document.getElementById('submit-contribution');
const contributionTree = document.getElementById('contribution-tree');
const treeModeNote = document.getElementById('tree-mode-note');
const templatePicker = document.getElementById('contribution-template-picker');
const title = document.getElementById('contribute-title');
const subtitle = document.getElementById('contribute-subtitle');
const breadcrumbLabel = document.getElementById('contribute-breadcrumb-label');
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
const knownTagOptions = document.getElementById('known-tag-options');
const evaluationNameOptions = document.getElementById('evaluation-name-options');

const MODE_DETAILS = {
    new_benchmark: {
        label: 'New benchmark',
        title: 'Record a new benchmark',
        subtitle: 'Create one benchmark and keep each reproducible test condition separate.',
        categoryEditable: false
    },
    new_model: {
        label: 'New model',
        title: 'Record a new model',
        subtitle: 'Add a model once, then keep each reproducible model test condition separate.',
        categoryEditable: false
    },
    benchmark_result: {
        label: 'New scores',
        title: 'Contribute model scores',
        subtitle: 'Link each score to an existing model condition, benchmark condition, and source.',
        categoryEditable: false
    },
    edit_benchmark: {
        label: 'Change benchmark',
        title: 'Change benchmark',
        subtitle: 'Update structured benchmark information or request removal. Every change is reviewed.',
        categoryEditable: false
    },
    edit_model: {
        label: 'Change model',
        title: 'Change model',
        subtitle: 'Update structured model information or request removal. Every change is reviewed.',
        categoryEditable: false
    },
    edit_result: {
        label: 'Change score',
        title: 'Change approved score',
        subtitle: 'Correct approved score evidence or request its removal.',
        categoryEditable: false
    },
    new_category: {
        label: 'New category',
        title: 'Add a category or context',
        subtitle: 'Choose a parent only when you are ready, then define the new taxonomy entry.',
        categoryEditable: false
    },
    correct_or_add_info: {
        label: 'Benchmark correction',
        title: 'Correct benchmark information',
        subtitle: 'Point reviewers to the exact information and the source that supports it.',
        categoryEditable: false
    },
    delete_or_migrate_category: {
        label: 'Category adjustment',
        title: 'Adjust a category',
        subtitle: 'Select the affected category and explain whether it should be corrected, moved, or removed.',
        categoryEditable: true
    },
    feedback: {
        label: 'Feedback',
        title: 'Share feedback',
        subtitle: 'Tell us what would make BenchPoll clearer, more useful, or easier to trust.',
        categoryEditable: false
    }
};

let mode = param('mode');
let catalog = { benchmarks: [], models: [], vendors: [], categories: [], knownTags: [], rankingDimensions: [] };
let categoryByID = new Map();
let selectedCategoryID = null;
let categorySelectionActive = false;
let categorySelectionPurpose = null;
let categorySelectionSnapshot = null;
let catalogRequestSequence = 0;
const pickerRefreshTokens = new WeakMap();

function setTaxonomyOpen(isOpen) {
    document.body.classList.toggle('taxonomy-open', isOpen);
    taxonomyToggle.setAttribute('aria-expanded', String(isOpen));
}
let authenticated = false;
let hasVerifiedEmail = false;

function isChangeMode(candidate = mode) {
    return candidate === 'edit_benchmark' || candidate === 'edit_model' || candidate === 'edit_result';
}

function param(name) {
    return String(params.get(name) ?? '').trim();
}

function escapeHTML(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function option(value, label, selectedValue) {
    return `<option value="${escapeHTML(value)}"${String(value) === String(selectedValue) ? ' selected' : ''}>${escapeHTML(label)}</option>`;
}

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

function finiteOrNull(value) {
    if (value === '' || value === null || value === undefined) {
        return null;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
    const number = finiteOrNull(value);
    return number !== null && Number.isInteger(number) && number > 0 ? number : null;
}

function entityKey(value) {
    return value === null || value === undefined ? '' : String(value);
}

function sameEntityID(left, right) {
    return entityKey(left) !== '' && entityKey(left) === entityKey(right);
}

function entityLocator(entity, idField, referenceField) {
    return entity?.reference
        ? { [idField]: null, [referenceField]: entity.reference }
        : { [idField]: entity ? Number(entity.ID) : null, [referenceField]: null };
}

function pendingBadge(entity) {
    return entity?.pending ? '<span class="pending-entity-badge">Pending review</span>' : '';
}

function evaluationScoreBounds(evaluation) {
    if (evaluation.usesPercentageScale) {
        return { min: null, max: null };
    }
    return {
        min: finiteOrNull(evaluation.scoreMin),
        max: finiteOrNull(evaluation.scoreMax)
    };
}

function evaluationDisplayScoreBounds(evaluation) {
    if (evaluation.usesPercentageScale) {
        return { min: 0, max: 100 };
    }
    return evaluationScoreBounds(evaluation);
}

function evaluationStoredTargetValue(evaluation) {
    if (evaluation.scoreDirection !== 'closer_to_target') {
        return null;
    }
    const targetValue = finiteOrNull(evaluation.targetValue);
    if (targetValue === null) {
        return null;
    }
    return targetValue;
}

function makeProfile(index = 0) {
    return {
        clientRef: `benchmark-condition-${Date.now()}-${index}`,
        name: index === 0 ? 'default' : `Profile ${index + 1}`,
        isDefault: index === 0,
        isExisting: false
    };
}

function makeEvaluation(index = 0) {
    return {
        name: '',
        introductionURL: '',
        tags: [],
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

function makeConfiguration(index = 0) {
    return {
        clientRef: `model-condition-${Date.now()}-${index}`,
        name: index === 0 ? 'default' : '',
        isDefault: index === 0,
        isExisting: false
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
        conditions: [makeConfiguration(0)],
        clientRef: `model-${Date.now()}`
    };
}

function makeResult(index = 0) {
    return {
        clientRef: `result-${Date.now()}-${index}`,
        modelQuery: '',
        modelID: null,
        modelRef: null,
        modelConditionID: null,
        modelConditionRef: null,
        benchmarkQuery: '',
        benchmarkID: null,
        benchmarkRef: null,
        benchmarkConditionID: null,
        benchmarkConditionRef: null,
        rawScore: '',
        sourceURL: '',
        sourceType: 'other',
        sourceTitle: ''
    };
}

function makeContextOption(index = 0) {
    return {
        clientRef: `context-option-${Date.now()}-${index}`,
        name: '',
        isDefault: index === 0,
        isNeutral: index === 0
    };
}

const draft = {
    benchmarks: [makeEvaluation(0)],
    subject: makeSubject(),
    results: [makeResult(0)],
    resultNotes: '',
    category: {
        requestKind: 'category',
        clientRef: `category-${Date.now()}`,
        name: '',
        details: '',
        contextOrder: [],
        options: [makeContextOption(0), makeContextOption(1)]
    },
    report: {
        sourceURL: '',
        details: ''
    },
    feedback: {
        details: ''
    },
    context: {
        confirmed: false,
        categoryID: null,
        categoryRef: null,
        categoryPath: '',
        dimensions: [],
        contextValues: {},
        contextDisplayValues: {},
        dimensionRefs: []
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

const vendorLogoFiles = new Set([
    'amazon', 'anthropic', 'cohere', 'deepseek', 'google', 'google-alt',
    'meta', 'microsoft', 'mistral', 'openai', 'qwen', 'xai', 'zhipu'
]);

function vendorLogoURL(vendor) {
    const key = String(vendor?.logoKey || vendor?.slug || '').trim().toLowerCase();
    return vendorLogoFiles.has(key) ? `/assets/vendors/${key}.png` : '';
}

function vendorMark(vendor) {
    const logoURL = vendorLogoURL(vendor);
    if (logoURL) {
        return `<span class="vendor-mark"><img src="${escapeHTML(logoURL)}" alt=""></span>`;
    }
    return `<span class="vendor-mark fallback" aria-hidden="true">${escapeHTML(String(vendor?.name ?? '?').slice(0, 1).toUpperCase())}</span>`;
}

function getModelCondition(modelID, configurationID) {
    return getModel(modelID)?.conditions.find(configuration => (
        sameEntityID(configuration.ID, configurationID)
    )) ?? null;
}

function categoryPath(categoryID) {
    const names = [];
    const visited = new Set();
    let cursor = categoryID === null ? null : categoryByID.get(entityKey(categoryID));
    while (cursor && !visited.has(entityKey(cursor.ID))) {
        visited.add(entityKey(cursor.ID));
        names.unshift(cursor.name);
        cursor = cursor.parentID === null ? null : categoryByID.get(entityKey(cursor.parentID));
    }
    return names.join('/');
}

function findCategoryByPath(path) {
    const normalized = String(path ?? '').split('/').filter(Boolean).join('/').toLowerCase();
    if (!normalized) {
        return null;
    }
    return catalog.categories.find(category => categoryPath(category.ID).toLowerCase() === normalized) ?? null;
}

function renderCategoryTree() {
    const details = MODE_DETAILS[mode];
    const editable = Boolean(details?.categoryEditable || categorySelectionActive);
    treeModeNote.textContent = categorySelectionActive
        ? 'Select parent'
        : details?.categoryEditable
            ? 'Select a category'
            : 'Locked';
    contributionTree.setAttribute('aria-disabled', String(!editable));
    contributionTree.classList.toggle('selection-active', categorySelectionActive);
    taxonomyToggle.disabled = !editable;
    const childrenByParent = new Map();
    catalog.categories.forEach(category => {
        const key = category.parentID === null ? 'root' : String(category.parentID);
        if (!childrenByParent.has(key)) {
            childrenByParent.set(key, []);
        }
        childrenByParent.get(key).push(category);
    });

    const renderList = parentID => {
        const key = parentID === null ? 'root' : String(parentID);
        const children = childrenByParent.get(key) ?? [];
        if (children.length === 0) {
            return '';
        }
        return `<ul class="${parentID === null ? 'contribution-tree-list' : 'contribution-tree-children'}">${children.map(category => {
            const hasChildren = (childrenByParent.get(String(category.ID)) ?? []).length > 0;
            const selected = sameEntityID(selectedCategoryID, category.ID);
            return `<li class="contribution-tree-item${hasChildren ? '' : ' leaf'}" data-category-node="${escapeHTML(category.ID)}">
                <button class="contribution-tree-row${selected ? ' selected' : ''}" type="button" data-category-id="${escapeHTML(category.ID)}"${editable ? '' : ' disabled'} title="${escapeHTML(categoryPath(category.ID))}">
                    ${hasChildren ? '<span class="tree-chevron" data-tree-toggle><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></span>' : '<span class="tree-spacer"></span>'}
                    <span class="tree-label">${escapeHTML(category.name)}${pendingBadge(category)}</span>
                </button>
                ${renderList(category.ID)}
            </li>`;
        }).join('')}</ul>`;
    };
    contributionTree.innerHTML = renderList(null) || '<p class="contribution-tree-empty">No categories yet.</p>';
}

function copyContextState() {
    return {
        selectedCategoryID,
        confirmed: draft.context.confirmed,
        categoryID: draft.context.categoryID,
        categoryRef: draft.context.categoryRef,
        categoryPath: draft.context.categoryPath,
        dimensions: structuredClone(draft.context.dimensions),
        contextValues: { ...draft.context.contextValues },
        contextDisplayValues: { ...draft.context.contextDisplayValues },
        dimensionRefs: structuredClone(draft.context.dimensionRefs)
    };
}

function restoreContextState(snapshot) {
    if (!snapshot) {
        return;
    }
    selectedCategoryID = snapshot.selectedCategoryID;
    Object.assign(draft.context, {
        confirmed: snapshot.confirmed,
        categoryID: snapshot.categoryID,
        categoryRef: snapshot.categoryRef,
        categoryPath: snapshot.categoryPath,
        dimensions: snapshot.dimensions,
        contextValues: snapshot.contextValues,
        contextDisplayValues: snapshot.contextDisplayValues,
        dimensionRefs: snapshot.dimensionRefs
    });
}

function renderTemplatePicker() {
    templatePicker.hidden = true;
    templatePicker.innerHTML = '';
}

function cancelCategorySelection() {
    restoreContextState(categorySelectionSnapshot);
    categorySelectionSnapshot = null;
    categorySelectionActive = false;
    categorySelectionPurpose = null;
    document.body.classList.remove('context-selection-active');
    renderCategoryTree();
    renderTemplatePicker();
    renderCurrentStep();
    setTaxonomyOpen(false);
}

function categoryDirectDimensions(categoryID) {
    return catalog.rankingDimensions
        .filter(dimension => sameEntityID(dimension.scopeCategoryID, categoryID))
        .sort((left, right) => Number(left.position) - Number(right.position));
}

function resetContextOrderForParent() {
    if (draft.category.requestKind !== 'context' || selectedCategoryID === null) {
        draft.category.contextOrder = [];
        return;
    }
    draft.category.contextOrder = [
        ...categoryDirectDimensions(selectedCategoryID).map(dimension => ({
            clientRef: `existing-${entityKey(dimension.ID)}`,
            dimensionID: dimension.ID,
            dimensionRef: dimension.reference ?? null,
            name: dimension.name,
            isNew: false
        })),
        {
            clientRef: draft.category.clientRef,
            dimensionID: null,
            dimensionRef: null,
            name: draft.category.name,
            isNew: true
        }
    ];
}

function completeParentSelection(categoryID) {
    const category = categoryByID.get(entityKey(categoryID));
    if (!category) return;
    selectedCategoryID = category.ID;
    draft.context.confirmed = true;
    draft.context.categoryID = category.reference ? null : Number(category.ID);
    draft.context.categoryRef = category.reference ?? null;
    draft.context.categoryPath = categoryPath(category.ID);
    categorySelectionActive = false;
    categorySelectionPurpose = null;
    categorySelectionSnapshot = null;
    document.body.classList.remove('context-selection-active');
    resetContextOrderForParent();
    renderCategoryTree();
    renderTemplatePicker();
    renderCurrentStep();
    setTaxonomyOpen(false);
}

async function beginParentSelection() {
    if (mode !== 'new_category') return;
    try {
        await refreshContributionCatalog();
    } catch (error) {
        showError(error.message || 'The category list could not be refreshed.');
        return;
    }
    categorySelectionSnapshot = copyContextState();
    categorySelectionActive = true;
    categorySelectionPurpose = 'parent';
    document.body.classList.add('context-selection-active');
    renderCategoryTree();
    renderTemplatePicker();
    if (window.matchMedia('(max-width: 760px)').matches) setTaxonomyOpen(true);
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
    if (mode === 'new_category') {
        return draft.context.confirmed ? draft.context.categoryPath.replaceAll('/', ' > ') : 'Parent not selected';
    }
    return selectedCategoryID === null ? 'Top level' : categoryPath(selectedCategoryID);
}

function renderTagEditor(evaluation, evaluationIndex) {
    return `<div class="tag-editor-shell" data-tag-editor-shell="${evaluationIndex}">
        <div class="tag-editor" data-tag-editor="${evaluationIndex}">
            ${evaluation.tags.map((tag, tagIndex) => `<span class="tag-chip">${escapeHTML(tag)}<button type="button" data-remove-tag="${tagIndex}" data-evaluation-index="${evaluationIndex}" aria-label="Remove ${escapeHTML(tag)}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></span>`).join('')}
            <input type="text" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="tag-suggestions-${evaluationIndex}" data-tag-input="${evaluationIndex}" placeholder="Search or add a tag">
        </div>
    </div>`;
}

function normalizedTagName(value) {
    return String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function validTagName(value) {
    const normalized = String(value ?? '').trim().replace(/\s+/g, ' ');
    return normalized.length >= 2 && normalized.length <= 48 && !/[<>\r\n]/.test(normalized);
}

function tagSuggestions(evaluation, query) {
    const normalizedQuery = normalizedTagName(query);
    if (!normalizedQuery) {
        return [];
    }
    const selectedTags = new Set(evaluation.tags.map(normalizedTagName));
    return catalog.knownTags
        .map(tag => String(tag.name ?? tag).trim())
        .filter(Boolean)
        .filter(tag => !selectedTags.has(normalizedTagName(tag)))
        .map(tag => {
            const normalized = normalizedTagName(tag);
            return {
                tag,
                matchIndex: normalized.indexOf(normalizedQuery),
                startsWith: normalized.startsWith(normalizedQuery)
            };
        })
        .filter(candidate => candidate.matchIndex >= 0)
        .sort((left, right) => (
            Number(right.startsWith) - Number(left.startsWith)
            || left.matchIndex - right.matchIndex
            || left.tag.length - right.tag.length
            || left.tag.localeCompare(right.tag)
        ))
        .slice(0, 6)
        .map(candidate => candidate.tag);
}

function renderTagSuggestions(evaluation, evaluationIndex, query) {
    const value = String(query ?? '').trim().replace(/\s+/g, ' ');
    if (!value) {
        return '';
    }
    const normalized = normalizedTagName(value);
    if (evaluation.tags.some(tag => normalizedTagName(tag) === normalized)) {
        return `<div class="tag-suggestions" id="tag-suggestions-${evaluationIndex}" role="listbox"><p>Already added</p></div>`;
    }
    const suggestions = tagSuggestions(evaluation, value);
    if (suggestions.length > 0) {
        return `<div class="tag-suggestions" id="tag-suggestions-${evaluationIndex}" role="listbox" aria-label="Known tag suggestions">
            ${suggestions.map((tag, index) => `<button type="button" role="option" data-select-tag="${escapeHTML(tag)}" data-evaluation-index="${evaluationIndex}">
                <span>${escapeHTML(tag)}</span>${index === 0 ? '<small>Tab</small>' : ''}
            </button>`).join('')}
        </div>`;
    }
    if (!validTagName(value)) {
        return `<div class="tag-suggestions" id="tag-suggestions-${evaluationIndex}" role="listbox"><p>Use 2–48 characters for a tag.</p></div>`;
    }
    return `<div class="tag-suggestions" id="tag-suggestions-${evaluationIndex}" role="listbox" aria-label="Create a new tag">
        <button class="create-tag-option" type="button" data-select-tag="${escapeHTML(value)}" data-evaluation-index="${evaluationIndex}">
            <i class="fa-solid fa-plus" aria-hidden="true"></i><span>Create new tag</span><strong>${escapeHTML(value)}</strong>
        </button>
    </div>`;
}

function updateTagSuggestionMenu(input) {
    const evaluationIndex = Number(input.dataset.tagInput);
    const evaluation = draft.benchmarks[evaluationIndex];
    const shell = input.closest('[data-tag-editor-shell]');
    shell?.querySelector('.tag-suggestions')?.remove();
    const markup = renderTagSuggestions(evaluation, evaluationIndex, input.value);
    if (markup) {
        shell?.insertAdjacentHTML('beforeend', markup);
    }
    input.setAttribute('aria-expanded', String(Boolean(markup)));
}

function commitTag(evaluationIndex, value) {
    const evaluation = draft.benchmarks[evaluationIndex];
    const tag = String(value ?? '').trim().replace(/\s+/g, ' ');
    if (!validTagName(tag) || evaluation.tags.some(existing => normalizedTagName(existing) === normalizedTagName(tag))) {
        return;
    }
    evaluation.tags.push(tag);
    renderCurrentStep();
    requestAnimationFrame(() => {
        stepSurface.querySelector(`[data-tag-input="${evaluationIndex}"]`)?.focus();
    });
}

function normalizedConditionName(value) {
    return String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function isLiteralDefaultCondition(value) {
    return normalizedConditionName(value) === 'default';
}

function normalizedIdentifierKey(value) {
    const normalized = String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase('en-US')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    return normalized || `text:${normalizedConditionName(value)}`;
}

function selectedEvaluation() {
    return draft.benchmarks[0];
}

function selectedExistingObject() {
    const evaluation = selectedEvaluation();
    return evaluation.existingBenchmarkID === null ? null : getBenchmark(evaluation.existingBenchmarkID);
}

function setEvaluationSelection(benchmarkID) {
    const evaluation = selectedEvaluation();
    const existing = getBenchmark(benchmarkID);
    if (!existing) {
        return;
    }
    evaluation.existingBenchmarkID = existing.ID;
    evaluation.existingBenchmarkRef = existing.reference ?? null;
    evaluation.name = existing.name;
    evaluation.introductionURL = existing.introductionURL ?? '';
    evaluation.tags = (existing.tags ?? []).map(tag => tag.name);
    const existingProfile = existing.conditions.find(profile => profile.isDefault) ?? existing.conditions[0];
    evaluation.scoreDirection = existingProfile?.scoreDirection ?? 'higher';
    evaluation.scoreMin = existingProfile?.scoreMin === null || existingProfile?.scoreMin === undefined
        ? ''
        : String(existingProfile.scoreMin);
    evaluation.scoreMax = existingProfile?.scoreMax === null || existingProfile?.scoreMax === undefined
        ? ''
        : String(existingProfile.scoreMax);
    evaluation.usesPercentageScale = profileUsesPercentage(existingProfile);
    evaluation.targetValue = existingProfile?.targetValue === null || existingProfile?.targetValue === undefined
        ? ''
        : String(existingProfile.targetValue);
    const newProfile = makeProfile(1);
    newProfile.name = '';
    newProfile.isDefault = false;
    evaluation.conditions = [newProfile];
}

function clearEvaluationSelection(name = '') {
    const evaluation = selectedEvaluation();
    const wasExisting = evaluation.existingBenchmarkID !== null;
    evaluation.existingBenchmarkID = null;
    evaluation.existingBenchmarkRef = null;
    evaluation.name = name;
    if (wasExisting) {
        evaluation.introductionURL = '';
        evaluation.tags = [];
        evaluation.scoreDirection = 'higher';
        evaluation.targetValue = '';
        evaluation.usesPercentageScale = true;
        evaluation.scoreMin = '';
        evaluation.scoreMax = '';
        evaluation.conditions = [makeProfile(0)];
    }
}

function evaluationSuggestions(query) {
    const normalized = String(query ?? '').trim().toLocaleLowerCase('en-US');
    if (!normalized) {
        return catalog.benchmarks.slice(0, 6);
    }
    return catalog.benchmarks
        .filter(object => object.name.toLocaleLowerCase('en-US').includes(normalized))
        .slice(0, 6);
}

function renderEvaluationSuggestions(query) {
    const suggestions = evaluationSuggestions(query);
    if (!String(query ?? '').trim() || suggestions.length === 0) {
        return '';
    }
    return `<div class="evaluation-suggestions" role="listbox" aria-label="Existing benchmarks">
        ${suggestions.map((object, index) => `<button type="button" role="option" data-select-evaluation="${escapeHTML(object.ID)}">
            <span>${escapeHTML(object.name)}${pendingBadge(object)}</span>
            <small>${index === 0 ? 'Tab · ' : ''}Existing benchmark</small>
        </button>`).join('')}
    </div>`;
}

function updateEvaluationSuggestionMenu(input) {
    const combobox = input.closest('.evaluation-combobox');
    combobox?.querySelector('.evaluation-suggestions')?.remove();
    const markup = renderEvaluationSuggestions(input.value);
    if (markup) {
        combobox?.insertAdjacentHTML('beforeend', markup);
    }
    input.setAttribute('aria-expanded', String(Boolean(markup)));
}

function existingConditionRows(existing) {
    if (!existing) {
        return '';
    }
    return existing.conditions.map(profile => `<div class="condition-row locked" data-existing-condition="${profile.ID}">
        <span class="condition-number"><i class="fa-solid fa-lock" aria-hidden="true"></i></span>
        <button class="condition-name condition-name-locked${normalizedConditionName(profile.name) === 'default' ? ' is-default' : ''}" type="button" data-action="explain-existing-condition">
            <span>${escapeHTML(profile.name)}</span>
            ${profile.isDefault ? '<small>Current default</small>' : '<small>Existing condition</small>'}
        </button>
        <button class="condition-delete locked" type="button" data-action="explain-existing-condition" aria-label="Existing conditions cannot be removed here"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button>
    </div>`).join('');
}

function conditionRows(evaluation) {
    return evaluation.conditions.map((profile, profileIndex) => `<div class="condition-row${normalizedConditionName(profile.name) === 'default' ? ' is-default' : ''}">
        <span class="condition-number">${profileIndex + 1}</span>
        <label class="condition-name">
            <span class="sr-only">Test condition ${profileIndex + 1}</span>
            <input required data-bind="profile" data-condition-input data-evaluation-index="0" data-profile-index="${profileIndex}" data-field="name" value="${escapeHTML(profile.name)}" placeholder="e.g. pass@1 with tools">
        </label>
        <button class="condition-delete" type="button" data-action="remove-profile" data-evaluation-index="0" data-profile-index="${profileIndex}" aria-label="Remove condition"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button>
    </div>`).join('');
}

function changeOperationSelector() {
    const deleting = draft.change.operation === 'delete';
    return `<section class="change-operation-section">
        <div><span class="section-eyebrow">Requested operation</span><strong>What should reviewers do?</strong></div>
        <div class="change-operation-switch" role="group" aria-label="Requested operation">
            <button type="button" data-change-operation="update" class="${deleting ? '' : 'active'}">Change this object</button>
            <button type="button" data-change-operation="delete" class="${deleting ? 'active danger' : ''}">Delete this object</button>
        </div>
    </section>`;
}

function changeReviewNotesField({ required = false } = {}) {
    return `<section class="change-review-notes"><label class="field wide" data-final-notes>
        <span>${required ? 'Reason and notes' : 'Notes for reviewers'} ${required ? '' : '<small>Optional</small>'}</span>
        <textarea data-bind="change" data-field="reviewNotes" maxlength="2000"${required ? ' required minlength="3"' : ''} placeholder="${required ? 'Explain why this object should be deleted.' : 'Add context that helps reviewers verify this change.'}">${escapeHTML(draft.change.reviewNotes)}</textarea>
    </label></section>`;
}

function reviewerNotesField({ binding, value, index = null, placeholder }) {
    const activeBinding = isChangeMode() ? 'change' : binding;
    const field = isChangeMode() ? 'reviewNotes' : 'reviewerNotes';
    const activeValue = isChangeMode() ? draft.change.reviewNotes : value;
    const indexAttribute = index === null ? '' : ` data-index="${index}"`;
    return `<label class="field wide" data-final-notes><span>Notes <small>Optional</small></span>
        <textarea data-bind="${activeBinding}"${indexAttribute} data-field="${field}" placeholder="${escapeHTML(placeholder)}">${escapeHTML(activeValue)}</textarea>
    </label>`;
}

function changeDeleteStep() {
    return `${changeOperationSelector()}
        <div class="step-heading form-section-heading"><div><h2>Request deletion</h2><p>The object remains published until a reviewer approves this request.</p></div></div>
        ${changeReviewNotesField({ required: true })}`;
}

function evaluationDetailsStep() {
    const evaluation = selectedEvaluation();
    const existing = selectedExistingObject();
    const editing = mode === 'edit_benchmark';
    return `${editing ? changeOperationSelector() : ''}<div class="step-heading form-section-heading">
        <div><h2>Benchmark and test conditions</h2><p>Keep the benchmark and each reproducible test condition together in one request.</p></div>
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
            <div><h3>Test conditions</h3><p>Each test condition is one short, single-line name.</p></div>
            <button class="add-row-button" type="button" data-action="add-profile" data-evaluation-index="0"><i class="fa-solid fa-plus" aria-hidden="true"></i><span>Add condition</span></button>
        </div>
        <div class="condition-table" role="group" aria-label="Test conditions">
            <div class="condition-table-head"><span>#</span><span>Condition name</span><span>Actions</span></div>
            ${existing && !editing ? existingConditionRows(existing) : ''}${conditionRows(evaluation)}
        </div>
    </section>
    ${existing && !editing ? '' : `<section class="evaluation-request-fields"><div class="field-grid">
        <label class="field wide" data-change-path="evaluation.tags"><span>Tags <small>Known or new</small></span>${renderTagEditor(evaluation, 0)}</label>
        <label class="field"><span>Score ranking rule</span><select required data-bind="evaluation" data-index="0" data-field="scoreDirection">
            ${option('higher', 'Higher is better', evaluation.scoreDirection)}${option('lower', 'Lower is better', evaluation.scoreDirection)}${option('closer_to_target', 'Closer to a target value', evaluation.scoreDirection)}
        </select></label>
        ${evaluation.scoreDirection === 'closer_to_target' ? `<label class="field"><span>Target value</span><input required type="number" step="any" data-bind="evaluation" data-index="0" data-field="targetValue" value="${escapeHTML(evaluation.targetValue)}" placeholder="0"></label>` : ''}
        <label class="percentage-scale-toggle wide" data-change-path="evaluation.usesPercentageScale"><input type="checkbox" data-score-percentage${evaluation.usesPercentageScale ? ' checked' : ''}><span><strong>Scores use a percentage scale</strong></span></label>
        ${evaluation.usesPercentageScale ? '' : `<div class="score-range-combination wide" aria-label="Score range">
            <label class="field"><span>Lowest value</span><input required type="text" inputmode="text" autocapitalize="off" autocomplete="off" spellcheck="false" data-score-range-input data-bind="evaluation" data-index="0" data-field="scoreMin" value="${escapeHTML(evaluation.scoreMin)}" placeholder="Enter the normalization minimum"></label>
            <label class="field"><span>Highest value</span><input required type="text" inputmode="text" autocapitalize="off" autocomplete="off" spellcheck="false" data-score-range-input data-bind="evaluation" data-index="0" data-field="scoreMax" value="${escapeHTML(evaluation.scoreMax)}" placeholder="Enter the normalization maximum"></label>
        </div>`}
        <label class="field wide"><span>Introduction URL <small>Optional</small></span><input type="url" data-bind="evaluation" data-index="0" data-field="introductionURL" value="${escapeHTML(evaluation.introductionURL)}" placeholder="https://paper-or-project.example"></label>
    </div></section>`}
    <section class="evaluation-request-fields final-notes-section"><div class="field-grid">
        ${reviewerNotesField({ binding: 'evaluation', index: 0, value: evaluation.reviewerNotes, placeholder: 'Anything else reviewers should know.' })}
    </div></section>`;
}

function normalizedSearch(value) {
    return String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function rankedMatches(items, query, label) {
    const normalizedQuery = normalizedSearch(query);
    return items
        .map(item => {
            const itemLabel = label(item);
            const normalizedLabel = normalizedSearch(itemLabel);
            const matchIndex = normalizedQuery ? normalizedLabel.indexOf(normalizedQuery) : 0;
            return { item, itemLabel, normalizedLabel, matchIndex, startsWith: normalizedLabel.startsWith(normalizedQuery) };
        })
        .filter(candidate => candidate.matchIndex >= 0)
        .sort((left, right) => (
            Number(right.startsWith) - Number(left.startsWith)
            || left.matchIndex - right.matchIndex
            || left.itemLabel.length - right.itemLabel.length
            || left.itemLabel.localeCompare(right.itemLabel)
        ))
        .slice(0, 8)
        .map(candidate => candidate.item);
}

function vendorSuggestions(query) {
    return rankedMatches(catalog.vendors, query, vendor => vendor.name);
}

function modelSuggestions(query, vendorID = null) {
    const models = vendorID === null
        ? catalog.models
        : catalog.models.filter(model => sameEntityID(model.vendorID, vendorID));
    return rankedMatches(models, query, model => `${model.name} ${model.vendorName}`);
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
    return `${suggestions.map((vendor, index) => `<button type="button" class="picker-option" data-select-vendor="${escapeHTML(vendor.ID)}">
        ${vendorMark(vendor)}<span>${escapeHTML(vendor.name)}${pendingBadge(vendor)}</span>${index === 0 ? '<small>Tab</small>' : ''}
    </button>`).join('')}
    ${allowCreate && value && !exact ? `<button type="button" class="picker-option create-option" data-create-vendor="${escapeHTML(value)}">
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
    const subject = draft.subject;
    const suggestions = subjectModelSuggestions(query);
    if (!String(query ?? '').trim() || suggestions.length === 0) {
        return '';
    }
    return `<div class="evaluation-suggestions model-suggestions" role="listbox" aria-label="Existing models">
        ${suggestions.map((model, index) => `<button type="button" role="option" data-select-subject-model="${escapeHTML(model.ID)}">
            <span class="model-suggestion-main">${vendorMark(getVendor(model.vendorID) ?? model)}<span>${escapeHTML(model.name)}${pendingBadge(model)}</span></span>
            ${index === 0 ? '<small>Tab</small>' : ''}
        </button>`).join('')}
    </div>`;
}

function updateSubjectModelSuggestions(input) {
    const combobox = input.closest('.evaluation-combobox');
    combobox?.querySelector('.evaluation-suggestions')?.remove();
    const markup = renderSubjectModelSuggestions(input.value);
    if (markup) {
        combobox?.insertAdjacentHTML('beforeend', markup);
    }
    input.setAttribute('aria-expanded', String(Boolean(markup)));
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
    if (!model) {
        return;
    }
    const subject = draft.subject;
    subject.existingModelID = model.ID;
    subject.existingModelRef = model.reference ?? null;
    subject.modelQuery = model.name;
    subject.name = model.name;
    subject.introductionURL = model.introductionURL ?? '';
    subject.vendorID = model.vendorID;
    subject.vendorRef = getVendor(model.vendorID)?.reference ?? null;
    subject.vendorQuery = model.vendorName;
    subject.vendor = { name: model.vendorName, logoKey: model.vendorLogoKey ?? '' };
    const configuration = makeConfiguration(1);
    configuration.name = '';
    configuration.isDefault = false;
    subject.conditions = [configuration];
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
        subject.conditions = [makeConfiguration(0)];
    }
}

function existingConfigurationRows(model) {
    if (!model) {
        return '';
    }
    return model.conditions.map(configuration => `<div class="condition-row locked" data-existing-configuration="${configuration.ID}">
        <span class="condition-number"><i class="fa-solid fa-lock" aria-hidden="true"></i></span>
        <button class="condition-name condition-name-locked${normalizedConditionName(configuration.name) === 'default' ? ' is-default' : ''}" type="button" data-action="explain-existing-configuration">
            <span>${escapeHTML(configuration.name)}</span><small>${configuration.isDefault ? 'Current default' : 'Existing model condition'}</small>
        </button>
        <button class="condition-delete locked" type="button" data-action="explain-existing-configuration" aria-label="Existing model conditions cannot be removed here"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button>
    </div>`).join('');
}

function configurationRows(subject) {
    return subject.conditions.map((configuration, index) => `<div class="condition-row${normalizedConditionName(configuration.name) === 'default' ? ' is-default' : ''}">
        <span class="condition-number">${index + 1}</span>
        <label class="condition-name"><span class="sr-only">Model test condition ${index + 1}</span><input required data-bind="configuration" data-configuration-input data-index="${index}" data-field="name" value="${escapeHTML(configuration.name)}" placeholder="e.g. high reasoning"></label>
        <button class="condition-delete" type="button" data-action="remove-configuration" data-index="${index}" aria-label="Remove configuration"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button>
    </div>`).join('');
}

function subjectDetailsStep() {
    const subject = draft.subject;
    const existing = getModel(subject.existingModelID);
    const editing = mode === 'edit_model';
    const vendorSelected = existing || subject.vendorID !== null || Boolean(subject.vendor.name.trim());
    return `${editing ? changeOperationSelector() : ''}<div class="step-heading form-section-heading"><div><h2>Model and test conditions</h2><p>Keep the model and each reproducible model test condition together in one request.</p></div></div>
    <section class="evaluation-identity-section">
        ${existing && !editing ? '' : subjectVendorPicker()}
        ${vendorSelected ? `<label class="field evaluation-name-field"><span>Model name</span>
            <div class="evaluation-combobox${existing ? ' has-selection has-model-selection' : editing ? ' has-selection' : ''}">${existing ? vendorMark(getVendor(existing.vendorID) ?? existing) : '<i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>'}
                <input required autocomplete="off"${editing ? ' data-bind="subject" data-field="name"' : ' role="combobox" aria-autocomplete="list" aria-expanded="false" data-subject-model-name'} value="${escapeHTML(editing ? subject.name : subject.modelQuery)}" placeholder="Search existing or enter a new model">
                ${existing || editing ? '' : renderSubjectModelSuggestions(subject.modelQuery)}
            </div>
        </label>` : '<p class="dependent-field-hint"><i class="fa-solid fa-arrow-up" aria-hidden="true"></i><span>Choose or add a vendor to continue.</span></p>'}
    </section>
    <section class="condition-section">
        <div class="condition-section-heading"><div><h3>Model test conditions</h3><p>Each model test condition is one short, single-line name.</p></div><button class="add-row-button" type="button" data-action="add-configuration"><i class="fa-solid fa-plus" aria-hidden="true"></i><span>Add condition</span></button></div>
        <div class="condition-table" role="group" aria-label="Model test conditions"><div class="condition-table-head"><span>#</span><span>Condition name</span><span>Actions</span></div>${existing && !editing ? existingConfigurationRows(existing) : ''}${configurationRows(subject)}</div>
    </section>
    ${existing && !editing ? '' : `<section class="evaluation-request-fields"><div class="field-grid">
        <label class="field wide"><span>Introduction URL <small>Optional</small></span><input type="url" data-bind="subject" data-field="introductionURL" value="${escapeHTML(subject.introductionURL)}" placeholder="https://model-card.example"></label>
    </div></section>`}
    <section class="evaluation-request-fields final-notes-section"><div class="field-grid">
        ${reviewerNotesField({ binding: 'subject', value: subject.reviewerNotes, placeholder: 'Anything else reviewers should know.' })}
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
    const query = new URLSearchParams({ mode: 'new_model', modelName });
    if (vendorName) query.set('vendorName', vendorName);
    return `<div class="evaluation-suggestions model-suggestions" role="listbox" aria-label="Existing models">${suggestions.map((model, suggestionIndex) => `<button type="button" role="option" data-select-result-model="${escapeHTML(model.ID)}" data-index="${index}"><span class="model-suggestion-main">${vendorMark(getVendor(model.vendorID) ?? model)}<span>${escapeHTML(model.name)}${pendingBadge(model)}</span></span>${suggestionIndex === 0 ? '<small>Tab</small>' : ''}</button>`).join('')}<a class="picker-create-link suggestion-create-link" href="/contribute?${escapeHTML(query)}" target="_blank" rel="noopener"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i><span>Can’t find the model? Record a new model</span></a></div>`;
}

function renderResultObjectSuggestions(result, index) {
    const suggestions = evaluationSuggestions(result.benchmarkQuery);
    if (!result.benchmarkQuery.trim() || suggestions.length === 0) {
        return '';
    }
    return `<div class="evaluation-suggestions" role="listbox" aria-label="Existing benchmarks">${suggestions.map((object, suggestionIndex) => `<button type="button" role="option" data-select-result-object="${escapeHTML(object.ID)}" data-index="${index}"><span>${escapeHTML(object.name)}${pendingBadge(object)}</span><small>${suggestionIndex === 0 ? 'Tab · ' : ''}Existing benchmark</small></button>`).join('')}</div>`;
}

function updateResultSuggestionMenu(input, kind) {
    const index = Number(input.dataset.index);
    const result = draft.results[index];
    const combobox = input.closest('.evaluation-combobox');
    combobox?.querySelector('.evaluation-suggestions')?.remove();
    const markup = kind === 'model'
        ? renderResultModelSuggestions(result, index)
        : renderResultObjectSuggestions(result, index);
    if (markup) {
        combobox?.insertAdjacentHTML('beforeend', markup);
    }
    input.setAttribute('aria-expanded', String(Boolean(markup)));
}

function clearExistingChoiceValidity(input) {
    input.setCustomValidity('');
    input.removeAttribute('aria-invalid');
    input.closest('.evaluation-combobox')?.classList.remove('has-error');
}

function validateExistingChoiceInput(input, { report = false } = {}) {
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
    if (!valid && report) {
        input.reportValidity();
    }
    return valid;
}

function validateRenderedExistingChoices() {
    let valid = true;
    stepSurface.querySelectorAll('[data-existing-choice]').forEach(input => {
        valid = validateExistingChoiceInput(input) && valid;
    });
    return valid;
}

function refreshSuggestionControl(input) {
    refreshCatalogForControl(input, () => {
        if (input.matches('[data-evaluation-name]')) {
            updateEvaluationSuggestionMenu(input);
        } else if (input.matches('[data-tag-input]')) {
            updateTagSuggestionMenu(input);
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
    const defaultConfiguration = model.conditions.find(configuration => configuration.isDefault) ?? model.conditions[0];
    result.modelConditionID = defaultConfiguration?.ID ?? null;
    result.modelConditionRef = defaultConfiguration?.reference ?? null;
}

function setResultObject(index, benchmarkID) {
    const object = getBenchmark(benchmarkID);
    const result = draft.results[index];
    if (!object || !result) {
        return;
    }
    result.benchmarkID = object.ID;
    result.benchmarkRef = object.reference ?? null;
    result.benchmarkQuery = object.name;
    const defaultProfile = object.conditions.find(profile => profile.isDefault) ?? object.conditions[0];
    result.benchmarkConditionID = defaultProfile?.ID ?? null;
    result.benchmarkConditionRef = defaultProfile?.reference ?? null;
}

function profileUsesPercentage(profile) {
    return Boolean(profile?.usesPercentageScale);
}

function resultStoredScore(result) {
    const profile = getBenchmarkCondition(result.benchmarkConditionID)?.profile;
    const displayScore = finiteOrNull(result.rawScore);
    if (displayScore === null) {
        return null;
    }
    return displayScore;
}

function addConfigurationLink(model) {
    if (!model) {
        return '';
    }
    const query = new URLSearchParams({
        mode: 'new_model',
        vendorName: model.vendorName,
        modelName: model.name
    });
    if (!model.reference) query.set('modelID', String(model.ID));
    if (!getVendor(model.vendorID)?.reference) query.set('vendorID', String(model.vendorID));
    return `/contribute?${query}`;
}

function addProfileLink(object) {
    if (!object) {
        return '';
    }
    const query = new URLSearchParams({
        mode: 'new_benchmark',
        benchmarkName: object.name
    });
    if (!object.reference) query.set('benchmarkID', String(object.ID));
    return `/contribute?${query}`;
}

function renderResultConfigurationOptions(model, index) {
    return model.conditions.map(configuration => `<button type="button" class="picker-option" data-select-result-configuration="${escapeHTML(configuration.ID)}" data-index="${index}"><span>${escapeHTML(configuration.name)}${pendingBadge(configuration)}</span>${configuration.isDefault ? '<small>Default</small>' : ''}</button>`).join('');
}

function renderResultProfileOptions(object, index) {
    return object.conditions.map(profile => `<button type="button" class="picker-option" data-select-result-profile="${escapeHTML(profile.ID)}" data-index="${index}"><span>${escapeHTML(profile.name)}${pendingBadge(profile)}</span>${profile.isDefault ? '<small>Default</small>' : ''}</button>`).join('');
}

function resultConfigurationPicker(result, index, model) {
    if (!model) {
        return '';
    }
    const selected = getModelCondition(model.ID, result.modelConditionID);
    return `<label class="field" data-change-path="result.modelConditionID"><span>Model test condition</span><details class="picker-menu" data-catalog-picker="model-condition" data-index="${index}"><summary class="picker-summary${selected ? ' has-value' : ''}"><span>${escapeHTML(selected?.name || 'Choose a model condition')}</span><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></summary><div class="picker-panel"><div class="picker-option-list" role="listbox">${renderResultConfigurationOptions(model, index)}</div><a class="picker-create-link" href="${escapeHTML(addConfigurationLink(model))}" target="_blank" rel="noopener"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i><span>Can’t find the condition? Add one</span></a></div></details></label>`;
}

function resultProfilePicker(result, index, object) {
    if (!object) {
        return '';
    }
    const selected = getBenchmarkCondition(result.benchmarkConditionID)?.profile;
    return `<label class="field" data-change-path="result.benchmarkConditionID"><span>Benchmark test condition</span><details class="picker-menu" data-catalog-picker="benchmark-condition" data-index="${index}"><summary class="picker-summary${selected ? ' has-value' : ''}"><span>${escapeHTML(selected?.name || 'Choose a benchmark condition')}</span><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></summary><div class="picker-panel"><div class="picker-option-list" role="listbox">${renderResultProfileOptions(object, index)}</div><a class="picker-create-link" href="${escapeHTML(addProfileLink(object))}" target="_blank" rel="noopener"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i><span>Can’t find the condition? Add one</span></a></div></details></label>`;
}

function refreshOpenCatalogPicker(picker) {
    const kind = picker.dataset.catalogPicker;
    if (kind === 'vendor') {
        const input = picker.querySelector('[data-vendor-search]');
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
    if (kind === 'model-condition') {
        const model = getModel(result.modelID);
        if (!model) throw new Error('The selected model is no longer available.');
        list.innerHTML = renderResultConfigurationOptions(model, index);
        if (createLink) createLink.href = addConfigurationLink(model);
        return;
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
        ...source,
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
        <header class="entry-card-header"><strong>Score ${index + 1}</strong><span class="entry-card-actions">${mode === 'benchmark_result' ? `<button class="soft-icon-button copy-result-button" type="button" data-action="copy-result" data-index="${index}" aria-label="Copy as a new score" title="Copy as a new score"><i class="fa-regular fa-copy" aria-hidden="true"></i></button>` : ''}${draft.results.length > 1 ? `<button class="soft-icon-button" type="button" data-action="remove-result" data-index="${index}" aria-label="Remove result"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>` : ''}</span></header>
        <div class="entry-card-body"><div class="field-grid">
            <label class="field" data-change-path="result.modelID"><span>Model</span><div class="evaluation-combobox${model ? ' has-selection has-model-selection' : ''}">${model ? vendorMark(getVendor(model.vendorID) ?? model) : '<i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>'}<input required autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" data-existing-choice="model" data-result-model-query data-index="${index}" value="${escapeHTML(result.modelQuery)}" placeholder="Search models">${model ? '' : renderResultModelSuggestions(result, index)}</div></label>
            ${resultConfigurationPicker(result, index, model)}
            <label class="field" data-change-path="result.benchmarkID"><span>Benchmark</span><div class="evaluation-combobox${object ? ' has-selection' : ''}"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input required autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" data-existing-choice="benchmark" data-result-object-query data-index="${index}" value="${escapeHTML(result.benchmarkQuery)}" placeholder="Search existing benchmarks">${object ? '' : renderResultObjectSuggestions(result, index)}</div></label>
            ${resultProfilePicker(result, index, object)}
            <label class="field wide"><span>Score</span><div class="score-input-shell${isPercentage ? ' percentage' : ''}"><input required type="text" inputmode="text" autocapitalize="off" autocomplete="off" spellcheck="false" data-score-value-input data-bind="result" data-index="${index}" data-field="rawScore" value="${escapeHTML(result.rawScore)}"${profile ? '' : ' disabled'} placeholder="${profile ? '0' : 'Choose a condition first'}">${isPercentage ? '<span>%</span>' : ''}</div></label>
        </div></div>
    </article>`;
}

function resultsStep() {
    const editing = mode === 'edit_result';
    const sourceLabel = draft.results.length > 1 ? 'All source URLs' : 'Source URL';
    const sharedSourceURL = draft.results[0]?.sourceURL ?? '';
    return `${editing ? changeOperationSelector() : ''}<div class="step-heading"><div><h2>Model scores</h2><p>Each row links one model condition to one benchmark condition and its original source. Your pending entries are available too.</p></div></div>
    <div class="repeater-list">${draft.results.map(resultCard).join('')}</div>
    ${editing ? '' : '<div class="score-repeater-actions"><button class="add-row-button" type="button" data-action="add-result"><i class="fa-solid fa-plus" aria-hidden="true"></i><span>Add score</span></button></div>'}
    <section class="result-submission-notes"><div class="field-grid">
        <label class="field wide" data-change-path="${editing ? 'result.sourceURL' : ''}"><span>${sourceLabel}</span><input required type="url" data-bind="result" data-index="0" data-field="sourceURL" value="${escapeHTML(sharedSourceURL)}" placeholder="https://official-source.example/results"></label>
        ${reviewerNotesField({ binding: 'resultBatch', value: draft.resultNotes, placeholder: 'Clarify shared caveats, table cells, or provenance details for this batch.' })}
    </div></section>`;
}

function categoryDetailsStep() {
    const isContext = draft.category.requestKind === 'context';
    return `<div class="step-heading"><div><h2>${isContext ? 'New context' : 'New category'}</h2><p>Select a parent only when you are ready; the taxonomy locks again after selection.</p></div></div>
    <div class="category-request-switch" role="group" aria-label="Taxonomy request type">
        <button type="button" data-category-kind="category" class="${isContext ? '' : 'active'}">Add a new category</button>
        <button type="button" data-category-kind="context" class="${isContext ? 'active' : ''}">Add a context to a category</button>
    </div>
    <section class="evaluation-context-block${draft.context.confirmed ? ' complete' : ''}">
        <div><span class="section-eyebrow">Parent category</span><strong>${escapeHTML(selectedContextLabel())}</strong><p>Contexts can be attached only to a category, not to another context.</p></div>
        <button class="quiet-button" type="button" data-action="start-parent-selection"><i class="fa-solid fa-sitemap" aria-hidden="true"></i><span>${draft.context.confirmed ? 'Change parent' : 'Choose parent'}</span></button>
    </section>
    <div class="source-panel category-request-fields"><div class="field-grid">
        <label class="field wide"><span>${isContext ? 'Context name' : 'Category name'}</span><input required data-bind="category" data-field="name" value="${escapeHTML(draft.category.name)}" placeholder="${isContext ? 'Web access' : 'Benchmark Reliability'}"></label>
    </div></div>
    ${isContext ? `${contextOptionsEditor()}${contextOrderEditor()}` : ''}
    <section class="evaluation-request-fields final-notes-section"><div class="field-grid">
        <label class="field wide" data-final-notes><span>Notes <small>Optional</small></span><textarea data-bind="category" data-field="details" maxlength="2000" placeholder="Anything else reviewers should know.">${escapeHTML(draft.category.details)}</textarea></label>
    </div></section>`;
}

function contextOptionsEditor() {
    return `<section class="condition-section context-option-section">
        <div class="condition-section-heading"><div><h3>Context options</h3><p>Add at least two distinct options. Choose exactly one default and one neutral option; they may be the same.</p></div><button class="add-row-button" type="button" data-action="add-context-option"><i class="fa-solid fa-plus" aria-hidden="true"></i><span>Add option</span></button></div>
        <div class="condition-table context-option-table" role="group" aria-label="Context options">
            <div class="condition-table-head context-option-grid"><span>#</span><span>Option name</span><span>Default</span><span>Neutral</span><span>Actions</span></div>
            ${draft.category.options.map((optionEntry, index) => `<div class="condition-row context-option-grid">
                <span class="condition-number">${index + 1}</span>
                <label class="condition-name"><span class="sr-only">Context option ${index + 1}</span><input required data-bind="contextOption" data-index="${index}" data-field="name" value="${escapeHTML(optionEntry.name)}" placeholder="e.g. Any"></label>
                <label class="context-option-radio"><input type="radio" name="context-default-option" data-context-option-role="default" data-index="${index}"${optionEntry.isDefault ? ' checked' : ''}><span>Default</span></label>
                <label class="context-option-radio"><input type="radio" name="context-neutral-option" data-context-option-role="neutral" data-index="${index}"${optionEntry.isNeutral ? ' checked' : ''}><span>Neutral</span></label>
                <button class="condition-delete" type="button" data-action="remove-context-option" data-index="${index}" aria-label="Remove option"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button>
            </div>`).join('')}
        </div>
    </section>`;
}

function contextOrderEditor() {
    return `<section class="context-order-section">
        <div class="condition-section-heading"><div><h3>Context order</h3><p>The new context starts last. Only its row can move; existing context order stays fixed.</p></div></div>
        <div class="context-order-list" data-context-order-list>${draft.category.contextOrder.map((entry, index) => `
            <div class="context-order-row${entry.isNew ? ' new' : ' locked'}" data-context-order-index="${index}"${entry.isNew ? ' draggable="true"' : ''}>
                <span class="context-order-grip"><i class="fa-solid ${entry.isNew ? 'fa-grip-lines' : 'fa-lock'}" aria-hidden="true"></i></span>
                <span>${escapeHTML(entry.isNew ? (draft.category.name || 'New context') : entry.name)}${entry.dimensionRef ? pendingBadge({ pending: true }) : ''}</span>
                ${entry.isNew ? `<span class="context-order-controls"><button type="button" data-action="move-context-up" aria-label="Move new context earlier"${index === 0 ? ' disabled' : ''}><i class="fa-solid fa-arrow-up" aria-hidden="true"></i></button><button type="button" data-action="move-context-down" aria-label="Move new context later"${index === draft.category.contextOrder.length - 1 ? ' disabled' : ''}><i class="fa-solid fa-arrow-down" aria-hidden="true"></i></button></span>` : '<small>Existing</small>'}
            </div>`).join('')}</div>
    </section>`;
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
    return `<div class="step-heading form-section-heading"><div><h2>Your feedback</h2><p>Share a problem, suggestion, or concern that does not fit another contribution form.</p></div></div>
    <section class="feedback-editor">
        <label class="field wide" data-final-notes>
            <span>Notes</span>
            <textarea required minlength="10" maxlength="4000" data-bind="feedback" data-field="details" placeholder="What should BenchPoll improve, and why?">${escapeHTML(draft.feedback.details)}</textarea>
        </label>
    </section>`;
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
        scoreMin,
        scoreMax,
        scoreDirection,
        targetValue,
        usesPercentageScale,
        isDefault: isLiteralDefaultCondition(profile.name)
    };
}

function evaluationChangeProposal() {
    const evaluation = selectedEvaluation();
    return {
        name: normalizedText(evaluation.name),
        introductionURL: normalizedText(evaluation.introductionURL),
        tags: [...new Set(evaluation.tags.map(normalizedText).filter(Boolean))]
            .sort((left, right) => left.localeCompare(right)),
        conditions: evaluation.conditions.map(profile => (
            evaluationProfileChangeProposal(profile, evaluation)
        ))
    };
}

function modelConfigurationChangeProposal(configuration) {
    return {
        ID: integerOrNull(configuration.ID),
        name: normalizedText(configuration.name),
        isDefault: isLiteralDefaultCondition(configuration.name)
    };
}

function modelChangeProposal() {
    const subject = draft.subject;
    return {
        vendorID: Number(subject.vendorID),
        name: normalizedText(subject.name),
        introductionURL: normalizedText(subject.introductionURL),
        conditions: subject.conditions.map(configuration => (
            modelConfigurationChangeProposal(configuration)
        ))
    };
}

function resultChangeProposal() {
    const payload = resultsPayload();
    return {
        result: (() => {
            const result = payload.results[0];
            return {
                modelID: result.modelID,
                modelConditionID: result.modelConditionID,
                benchmarkID: result.benchmarkID,
                benchmarkConditionID: result.benchmarkConditionID,
                rawScore: result.rawScore,
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
                modelRef: null,
                modelConditionRef: null,
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
        tags: 'Tags',
        rawScore: 'Score',
        source: 'Source'
    };
    const leaf = String(path).split('.').at(-1).replace(/([A-Z])/g, ' $1').trim();
    const base = labels[leaf] ?? leaf.replace(/^./, character => character.toUpperCase());
    const conditionMatch = String(path).match(/^(?:(?:evaluation|subject)\.)?conditions\[(\d+)\]\.(.+)$/);
    if (conditionMatch) {
        const conditions = mode === 'edit_model' ? draft.subject.conditions : selectedEvaluation().conditions;
        const condition = conditions.find(item => Number(item.ID) === Number(conditionMatch[1]));
        const fieldLabel = conditionMatch[2] === 'name'
            ? 'Condition name'
            : changeFieldLabel(conditionMatch[2]);
        return `${condition?.name || (mode === 'edit_model' ? 'Model condition' : 'Benchmark condition')} · ${fieldLabel}`;
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
    if (isChangeMode() && draft.change.operation === 'delete') {
        stepSurface.innerHTML = changeDeleteStep();
    } else if (mode === 'new_benchmark' || mode === 'edit_benchmark') {
        stepSurface.innerHTML = evaluationDetailsStep();
    } else if (mode === 'new_model' || mode === 'edit_model') {
        stepSurface.innerHTML = subjectDetailsStep();
    } else if (mode === 'benchmark_result' || mode === 'edit_result') {
        stepSurface.innerHTML = resultsStep();
    } else if (mode === 'new_category') {
        stepSurface.innerHTML = categoryDetailsStep();
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
    decorateChangedFields();
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
        result: draft.results[0]
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
    if (binding === 'configuration') {
        const condition = draft.subject.conditions[Number(control.dataset.index)];
        const conditionID = integerOrNull(condition?.ID);
        return conditionID === null ? '' : `subject.conditions[${conditionID}].${field}`;
    }
    if (binding === 'result') return `result.${field}`;
    return '';
}

function restoreChangePath(path) {
    const baseline = draft.change.baseline;
    if (!baseline || !path) {
        return;
    }
    const current = currentChangeDraftView();
    if (path === 'subject.vendorID') {
        for (const field of ['vendorID', 'vendorRef', 'vendorQuery', 'vendor']) {
            current.subject[field] = structuredClone(baseline.subject[field]);
        }
    } else if (path === 'result.modelID') {
        for (const field of ['modelID', 'modelRef', 'modelQuery', 'modelConditionID', 'modelConditionRef']) {
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
    renderCategoryTree();
    renderCurrentStep();
}

function decorateChangedFields() {
    if (!isChangeMode() || !draft.change.baseline) {
        return;
    }
    stepSurface.querySelectorAll('.field-restore-button').forEach(button => button.remove());
    stepSurface.querySelectorAll('.is-modified').forEach(element => element.classList.remove('is-modified'));
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
        const restore = document.createElement('button');
        restore.type = 'button';
        restore.className = 'field-restore-button';
        restore.dataset.restorePath = path;
        restore.title = 'Restore original value';
        restore.setAttribute('aria-label', `Restore ${changeFieldLabel(path)}`);
        restore.innerHTML = '<i class="fa-solid fa-rotate-left" aria-hidden="true"></i>';
        container.append(restore);
        decorated.add(path);
    }
}

function updateBoundField(target) {
    const binding = target.dataset.bind;
    const field = target.dataset.field;
    if (!binding || !field) {
        return;
    }
    let value = target.value;
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
    } else if (binding === 'configuration') {
        setNested(draft.subject.conditions[Number(target.dataset.index)], field, value);
    } else if (binding === 'result') {
        setNested(draft.results[Number(target.dataset.index)], field, value);
    } else if (binding === 'resultBatch') {
        draft.resultNotes = value;
    } else if (binding === 'category') {
        setNested(draft.category, field, value);
    } else if (binding === 'contextOption') {
        setNested(draft.category.options[Number(target.dataset.index)], field, value);
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
        showError('Add at least one new test condition.');
        return false;
    }

    const conditionNames = evaluation.conditions.map(profile => normalizedConditionName(profile.name));
    if (conditionNames.some(name => name === '')) {
        showError('Every new test condition needs a name.');
        return false;
    }
    if (new Set(conditionNames).size !== conditionNames.length) {
        showError('Test condition names must be unique, including default.');
        return false;
    }

    const existing = selectedExistingObject();
    if (existing && mode !== 'edit_benchmark') {
        const existingNames = new Set(existing.conditions.map(profile => normalizedConditionName(profile.name)));
        const duplicate = conditionNames.find(name => existingNames.has(name));
        if (duplicate) {
            showError(`The condition “${duplicate}” already exists. Use the Change benchmark information form to edit it.`);
            return false;
        }
    } else if (mode !== 'edit_benchmark') {
        const duplicateObject = catalog.benchmarks.find(object => (
            object.name.toLocaleLowerCase('en-US') === evaluation.name.trim().toLocaleLowerCase('en-US')
        ));
        if (duplicateObject) {
            showError('This benchmark already exists. Select it from the suggestions to add a new test condition.');
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
    if (!subject.name.trim()) {
        showError('Enter a model name before submitting.');
        return false;
    }
    if (subject.existingModelID === null && !subject.vendor.name.trim()) {
        showError('Choose an existing vendor or record a new vendor before submitting.');
        return false;
    }
    if (subject.conditions.length < 1) {
                showError('Add at least one new model test condition.');
        return false;
    }
    const names = subject.conditions.map(configuration => normalizedConditionName(configuration.name));
    if (names.some(name => name === '')) {
        showError('Every new model test condition needs a name.');
        return false;
    }
    if (new Set(names).size !== names.length) {
        showError('Model test condition names must be unique, including default.');
        return false;
    }
    const keys = subject.conditions.map(configuration => normalizedIdentifierKey(configuration.name));
    if (new Set(keys).size !== keys.length) {
        showError('Model test condition names must stay distinct after punctuation and spacing are normalized.');
        return false;
    }
    const existing = getModel(subject.existingModelID);
    if (existing && mode !== 'edit_model') {
        const existingNames = new Set(existing.conditions.map(configuration => normalizedConditionName(configuration.name)));
        const existingKeys = new Set(existing.conditions.map(configuration => normalizedIdentifierKey(configuration.name)));
        const duplicate = names.find(name => existingNames.has(name));
        const duplicateKeyIndex = keys.findIndex(key => existingKeys.has(key));
        if (duplicate || duplicateKeyIndex >= 0) {
            const duplicateName = duplicate || subject.conditions[duplicateKeyIndex].name;
            showError(`The condition “${duplicateName}” already exists. Use the Change model information form to edit it.`);
            return false;
        }
    } else if (mode !== 'edit_model') {
        const duplicateModel = catalog.models.find(model => (
            normalizedSearch(model.name) === normalizedSearch(subject.name)
            && normalizedSearch(model.vendorName) === normalizedSearch(subject.vendor.name)
        ));
        if (duplicateModel) {
            showError('This model already exists. Select it from the suggestions to add a new test condition.');
            return false;
        }
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
        if (control.disabled || control.matches('input[type="checkbox"], input[type="radio"]')) {
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
        form.reportValidity();
        return false;
    }
    if (isChangeMode() && draft.change.operation === 'delete') {
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
    if (mode === 'feedback' && draft.feedback.details.trim().length < 10) {
        showError('Please add a little more detail before submitting.');
        return false;
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
            const configuration = getModelCondition(result.modelID, result.modelConditionID);
            const score = resultStoredScore(result);
            if (!model || !configuration || !profileMatch || score === null) {
                showError('Every score needs a model, model condition, benchmark condition, and numeric score.');
                return false;
            }
            const percentage = profileUsesPercentage(profileMatch.profile);
            if (percentage && (score < 0 || score > 100)) {
                showError(`${profileMatch.object.name} / ${profileMatch.profile.name} accepts percentage scores from 0% to 100%.`);
                return false;
            }
            const pair = `${entityKey(configuration.ID)}:${entityKey(profileMatch.profile.ID)}`;
            if (seenPairs.has(pair)) {
                showError('This submission contains the same model condition and benchmark condition more than once.');
                return false;
            }
            seenPairs.add(pair);
        }
    }
    if (isChangeMode() && !validateChangeHasChanges()) {
        return false;
    }
    if (mode === 'new_category') {
        if (!draft.context.confirmed
            || (draft.context.categoryID === null && draft.context.categoryRef === null)) {
            showError('Choose a parent category before submitting.');
            return false;
        }
        if (draft.category.requestKind === 'context'
            && draft.category.contextOrder.filter(entry => entry.isNew).length !== 1) {
            showError('The new context must appear exactly once in the context order.');
            return false;
        }
        if (draft.category.requestKind === 'context') {
            const names = draft.category.options.map(optionEntry => optionEntry.name.trim());
            const normalizedNames = names.map(normalizedIdentifierKey);
            if (names.length < 2 || names.some(name => name === '')) {
                showError('Add at least two named context options.');
                return false;
            }
            if (new Set(normalizedNames).size !== normalizedNames.length) {
                showError('Context option names must remain distinct after punctuation and spacing are normalized.');
                return false;
            }
            if (draft.category.options.filter(optionEntry => optionEntry.isDefault).length !== 1
                || draft.category.options.filter(optionEntry => optionEntry.isNeutral).length !== 1) {
                showError('Choose exactly one default option and one neutral option.');
                return false;
            }
        }
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
            tags: candidate.tags,
            reviewerNotes: candidate.reviewerNotes,
            conditions: candidate.conditions.map(profile => ({
                clientRef: profile.clientRef,
                name: profile.name,
                scoreMin: evaluationScoreBounds(candidate).min,
                scoreMax: evaluationScoreBounds(candidate).max,
                scoreDirection: candidate.scoreDirection,
                targetValue: evaluationStoredTargetValue(candidate),
                usesPercentageScale: Boolean(candidate.usesPercentageScale),
                isDefault: isLiteralDefaultCondition(profile.name)
            }))
        }))
    };
}

function configurationPayload(configuration) {
    return {
        clientRef: configuration.clientRef,
        name: configuration.name,
        isDefault: isLiteralDefaultCondition(configuration.name)
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
            } : null,
            conditions: subject.conditions.map(configuration => configurationPayload(configuration))
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
            const configuration = getModelCondition(result.modelID, result.modelConditionID);
            const object = getBenchmark(result.benchmarkID);
            const profile = getBenchmarkCondition(result.benchmarkConditionID)?.profile;
            return {
                clientRef: result.clientRef,
                ...entityLocator(model, 'modelID', 'modelRef'),
                ...entityLocator(configuration, 'modelConditionID', 'modelConditionRef'),
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
    if (mode === 'new_category') {
        const parent = selectedCategoryID === null ? null : categoryByID.get(entityKey(selectedCategoryID));
        return {
            type: 'new_category',
            requestKind: draft.category.requestKind,
            clientRef: draft.category.clientRef,
            name: draft.category.name,
            parentPath: selectedCategoryID === null ? '' : categoryPath(selectedCategoryID),
            ...entityLocator(parent, 'parentCategoryID', 'parentCategoryRef'),
            pageURL: param('pageURL') || document.referrer,
            details: draft.category.details,
            contextOrder: draft.category.requestKind === 'context'
                ? draft.category.contextOrder.map(entry => ({
                    clientRef: entry.clientRef,
                    dimensionID: entry.dimensionRef ? null : entry.dimensionID,
                    dimensionRef: entry.dimensionRef,
                    isNew: entry.isNew
                }))
                : [],
            options: draft.category.requestKind === 'context'
                ? draft.category.options.map(optionEntry => ({
                    name: optionEntry.name,
                    isDefault: optionEntry.isDefault,
                    isNeutral: optionEntry.isNeutral
                }))
                : []
        };
    }
    if (mode === 'feedback') {
        return {
            type: 'feedback',
            details: draft.feedback.details,
            pageURL: param('pageURL') || document.referrer
        };
    }
    return {
        type: 'report_issue',
        issueType: mode,
        targetName: param('targetName') || selectedContextLabel(),
        targetKind: param('targetKind') || (mode === 'delete_or_migrate_category' ? 'category' : 'benchmark'),
        targetBenchmarkID: integerOrNull(param('targetBenchmarkID') || param('benchmarkID')),
        categoryPath: selectedCategoryID === null ? param('categoryPath') : categoryPath(selectedCategoryID),
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
        benchmark_condition_in_use: 'This benchmark test condition already has scores or personal weights, so it cannot be removed. Keep the condition or request deletion of the whole benchmark.',
        model_condition_in_use: 'This model test condition already has scores, so it cannot be removed. Keep the condition or request deletion of the whole model.',
        change_request_has_no_changes: 'The submitted fields still match the published object. Reload the latest version and make the intended change again.',
        change_target_modified_since_submission: 'This object changed after you opened the form. Reload the page and review the latest values before submitting again.'
    };
    return messages[error?.error] || error?.error || `Request failed (${status})`;
}

async function submitDraft() {
    if (!validateContribution()) {
        return;
    }
    if (!hasVerifiedEmail) {
        showError('Log out and sign in with GitHub again to authorize a verified email address for review notifications.');
        return;
    }
    submitButton.disabled = true;
    try {
        const response = await fetch('/api/submit_contribution', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(submissionPayload())
        });
        if (!response.ok) {
            let error = {};
            try {
                error = await response.json();
            } catch {
                error = {};
            }
            if (error.error === 'verified_email_required') {
                hasVerifiedEmail = false;
                throw new Error('Log out and sign in with GitHub again to authorize a verified email address for review notifications.');
            }
            throw new Error(contributionSubmissionError(error, response.status));
        }
        successDialog.hidden = false;
    } catch (error) {
        showError(error.message || 'The contribution could not be submitted.');
    } finally {
        submitButton.disabled = false;
    }
}

function configureMode() {
    const details = MODE_DETAILS[mode];
    if (!details) {
        entryMissing.hidden = false;
        formSurface.hidden = true;
        authMissing.hidden = true;
        title.textContent = 'Choose an entry point';
        subtitle.textContent = 'Open contribution controls from the BenchPoll workspace.';
        return false;
    }
    breadcrumbLabel.textContent = details.label;
    title.textContent = details.title;
    subtitle.textContent = details.subtitle;
    renderCategoryTree();
    renderCurrentStep();
    return true;
}

function applyContributionCatalog(nextCatalog) {
    catalog = nextCatalog;
    categoryByID = new Map(catalog.categories.map(category => [entityKey(category.ID), category]));
    knownTagOptions.innerHTML = catalog.knownTags.map(tag => `<option value="${escapeHTML(tag.name)}"></option>`).join('');
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

    const categoryRequestPath = mode === 'new_category'
        ? param('parentPath') || param('categoryPath')
        : mode === 'delete_or_migrate_category'
            ? param('categoryPath')
            : '';
    const requestedCategory = findCategoryByPath(categoryRequestPath);
    selectedCategoryID = requestedCategory?.ID ?? null;
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
        setEvaluationSelection(requestedObject.ID);
    } else if (requestedEvaluationName && mode === 'new_benchmark') {
        const exactObject = catalog.benchmarks.find(object => object.name.toLocaleLowerCase('en-US') === requestedEvaluationName.toLocaleLowerCase('en-US'));
        if (exactObject) {
            setEvaluationSelection(exactObject.ID);
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
    const defaultProfile = form.conditions.find(profile => profile.isDefault) ?? form.conditions[0];
    const usesPercentageScale = profileUsesPercentage(defaultProfile);
    draft.benchmarks = [{
        ...makeEvaluation(0),
        existingBenchmarkID: draft.change.targetID,
        name: form.name,
        introductionURL: form.introductionURL ?? '',
        tags: [...form.tags],
        scoreDirection: defaultProfile.scoreDirection,
        targetValue: defaultProfile.targetValue === null || defaultProfile.targetValue === undefined
            ? ''
            : String(defaultProfile.targetValue),
        usesPercentageScale,
        scoreMin: optionalNumberText(defaultProfile.scoreMin),
        scoreMax: optionalNumberText(defaultProfile.scoreMax),
        reviewerNotes: '',
        conditions: form.conditions.map(profile => {
            return {
                ...makeProfile(0),
                ID: Number(profile.ID),
                name: profile.name,
                usesPercentageScale: profileUsesPercentage(profile),
                scoreMin: optionalNumberText(profile.scoreMin),
                scoreMax: optionalNumberText(profile.scoreMax),
                scoreDirection: profile.scoreDirection,
                targetValue: optionalNumberText(profile.targetValue),
                isDefault: Boolean(profile.isDefault),
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
        name: form.name,
        introductionURL: form.introductionURL ?? '',
        vendorID: Number(form.vendorID),
        vendorQuery: vendor?.name ?? '',
        vendor: {
            name: vendor?.name ?? '',
            logoKey: vendor?.logoKey ?? ''
        },
        conditions: form.conditions.map(configuration => ({
            ...makeConfiguration(0),
            ID: Number(configuration.ID),
            name: configuration.name,
            isDefault: Boolean(configuration.isDefault),
            isExisting: true
        }))
    };
}

function hydrateResultChange(form) {
    const result = makeResult(0);
    const model = getModel(form.result.modelID);
    const object = getBenchmark(form.result.benchmarkID);
    const profile = getBenchmarkCondition(form.result.benchmarkConditionID)?.profile;
    result.modelID = form.result.modelID;
    result.modelQuery = model ? modelInputValue(model) : '';
    result.modelConditionID = form.result.modelConditionID;
    result.benchmarkID = form.result.benchmarkID;
    result.benchmarkQuery = object?.name ?? '';
    result.benchmarkConditionID = form.result.benchmarkConditionID;
    result.rawScore = String(form.result.rawScore);
    result.sourceURL = form.result.source.url;
    result.sourceType = form.result.source.type;
    result.sourceTitle = form.result.source.title ?? '';
    draft.results = [result];
    draft.resultNotes = '';
}

function captureChangeDraft() {
    if (mode === 'edit_benchmark') {
        return { evaluation: structuredClone(selectedEvaluation()) };
    }
    if (mode === 'edit_model') {
        return { subject: structuredClone(draft.subject) };
    }
    return { result: structuredClone(draft.results[0]) };
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
    draft.change.before = structuredClone(payload.form);
    draft.change.baseline = captureChangeDraft();
}

async function loadUser() {
    const response = await fetch('/api/get_user_profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
    });
    if (response.status === 204) {
        sidebarLogin.hidden = false;
        sidebarUser.hidden = true;
        return null;
    }
    if (!response.ok) {
        throw new Error('Unable to load your account.');
    }
    const user = await response.json();
    hasVerifiedEmail = user.hasVerifiedEmail === true;
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

contributionTree.addEventListener('click', event => {
    const row = event.target.closest('[data-category-id]');
    if (!row || row.disabled) {
        return;
    }
    if (event.target.closest('[data-tree-toggle]')) {
        row.closest('[data-category-node]')?.classList.toggle('collapsed');
        return;
    }
    selectedCategoryID = row.dataset.categoryId;
    if (categorySelectionActive && categorySelectionPurpose === 'parent') {
        completeParentSelection(selectedCategoryID);
        return;
    }
    renderCategoryTree();
    if (!categorySelectionActive) {
        renderCurrentStep();
    }
    if (!categorySelectionActive && window.matchMedia('(max-width: 760px)').matches) {
        setTaxonomyOpen(false);
    }
});

taxonomyToggle.addEventListener('click', () => {
    if (taxonomyToggle.disabled) {
        return;
    }
    setTaxonomyOpen(!document.body.classList.contains('taxonomy-open'));
});
function closeTaxonomy() {
    if (categorySelectionActive) {
        cancelCategorySelection();
        return;
    }
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

stepSurface.addEventListener('input', event => {
    const evaluationName = event.target.closest('[data-evaluation-name]');
    if (evaluationName) {
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
    const tagInput = event.target.closest('[data-tag-input]');
    if (tagInput) {
        tagInput.setCustomValidity('');
        tagInput.removeAttribute('aria-invalid');
        tagInput.closest('[data-tag-editor-shell]')?.classList.remove('has-error');
        updateTagSuggestionMenu(tagInput);
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
                const replacement = stepSurface.querySelector('[data-vendor-search]');
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
            result.modelConditionID = null;
            result.modelConditionRef = null;
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
    const categoryName = event.target.closest('[data-bind="category"][data-field="name"]');
    if (categoryName && draft.category.requestKind === 'context') {
        const newName = stepSurface.querySelector('.context-order-row.new > span:nth-child(2)');
        if (newName) newName.textContent = categoryName.value || 'New context';
        const newEntry = draft.category.contextOrder.find(entry => entry.isNew);
        if (newEntry) newEntry.name = categoryName.value;
    }
    const conditionInput = event.target.closest('[data-condition-input], [data-configuration-input]');
    if (conditionInput) {
        const row = conditionInput.closest('.condition-row');
        const isDefault = isLiteralDefaultCondition(conditionInput.value);
        if (conditionInput.matches('[data-condition-input]')) {
            const profile = draft.benchmarks[Number(conditionInput.dataset.evaluationIndex)]
                ?.conditions[Number(conditionInput.dataset.profileIndex)];
            if (profile) profile.isDefault = isDefault;
        } else {
            const configuration = draft.subject.conditions[Number(conditionInput.dataset.index)];
            if (configuration) configuration.isDefault = isDefault;
        }
        row?.classList.toggle('is-default', isDefault);
    }
    decorateChangedFields();
});

stepSurface.addEventListener('change', event => {
    const optionRole = event.target.closest('[data-context-option-role]');
    if (optionRole) {
        const selectedIndex = Number(optionRole.dataset.index);
        const field = optionRole.dataset.contextOptionRole === 'neutral' ? 'isNeutral' : 'isDefault';
        draft.category.options.forEach((optionEntry, index) => {
            optionEntry[field] = index === selectedIndex;
        });
        return;
    }
    updateBoundField(event.target);
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

stepSurface.addEventListener('keydown', event => {
    const vendorSearch = event.target.closest('[data-vendor-search]');
    if (vendorSearch && event.key === 'Tab' && vendorSearch.value.trim()) {
        const closest = vendorSuggestions(vendorSearch.value)[0];
        if (closest) {
            event.preventDefault();
            setSubjectVendor(closest.ID);
            renderCurrentStep();
            requestAnimationFrame(() => stepSurface.querySelector('[data-subject-model-name]')?.focus());
        }
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
        const closest = evaluationSuggestions(resultObjectQuery.value)[0];
        if (closest) {
            event.preventDefault();
            setResultObject(Number(resultObjectQuery.dataset.index), closest.ID);
            renderCurrentStep();
        }
        return;
    }
    const evaluationName = event.target.closest('[data-evaluation-name]');
    if (evaluationName && event.key === 'Tab' && evaluationName.value.trim()) {
        const closest = evaluationSuggestions(evaluationName.value)[0];
        if (closest) {
            event.preventDefault();
            setEvaluationSelection(closest.ID);
            renderCurrentStep();
            requestAnimationFrame(() => stepSurface.querySelector('[data-evaluation-name]')?.focus());
        }
        return;
    }
    const tagInput = event.target.closest('[data-tag-input]');
    if (!tagInput || !['Tab', 'Enter', ','].includes(event.key) || !tagInput.value.trim()) {
        return;
    }
    const evaluationIndex = Number(tagInput.dataset.tagInput);
    const closest = tagSuggestions(draft.benchmarks[evaluationIndex], tagInput.value)[0];
    if (closest) {
        event.preventDefault();
        commitTag(evaluationIndex, closest);
    } else if (event.key === 'Enter' || event.key === ',') {
        event.preventDefault();
    }
});

stepSurface.addEventListener('focusin', event => {
    const evaluationName = event.target.closest('[data-evaluation-name]');
    if (evaluationName) {
        updateEvaluationSuggestionMenu(evaluationName);
        refreshSuggestionControl(evaluationName);
    }
    const tagInput = event.target.closest('[data-tag-input]');
    if (tagInput) {
        updateTagSuggestionMenu(tagInput);
        refreshSuggestionControl(tagInput);
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
    const picker = event.target.closest('[data-catalog-picker]');
    if (picker?.open) {
        refreshCatalogForControl(picker, () => refreshOpenCatalogPicker(picker));
    }
}, true);

stepSurface.addEventListener('pointerdown', event => {
    const tagOption = event.target.closest('[data-select-tag]');
    tagOption?.closest('[data-tag-editor-shell]')?.setAttribute('data-tag-commit-pending', 'true');
});

stepSurface.addEventListener('focusout', event => {
    const evaluationCombobox = event.target.closest('.evaluation-combobox');
    if (evaluationCombobox) {
        setTimeout(() => {
            if (evaluationCombobox.isConnected && !evaluationCombobox.contains(document.activeElement)) {
                const existingChoice = evaluationCombobox.querySelector('[data-existing-choice]');
                if (existingChoice) {
                    validateExistingChoiceInput(existingChoice, { report: true });
                }
                evaluationCombobox.querySelector('.evaluation-suggestions')?.remove();
                evaluationCombobox.querySelector('[role="combobox"]')?.setAttribute('aria-expanded', 'false');
            }
        }, 120);
    }
    const shell = event.target.closest('[data-tag-editor-shell]');
    if (!shell) {
        return;
    }
    const input = shell.querySelector('[data-tag-input]');
    const nextFocus = event.relatedTarget;
    const isCommittingTag = shell.dataset.tagCommitPending === 'true';
    if (!isCommittingTag && (!nextFocus || !shell.contains(nextFocus)) && input?.value.trim()) {
        const message = 'Add the unfinished text as a tag or clear it before leaving this field.';
        input.setCustomValidity(message);
        input.setAttribute('aria-invalid', 'true');
        shell.classList.add('has-error');
        showError(message);
    }
    setTimeout(() => {
        if (shell.isConnected && !shell.contains(document.activeElement)) {
            shell.querySelector('.tag-suggestions')?.remove();
            input?.setAttribute('aria-expanded', 'false');
        }
    }, 120);
});

stepSurface.addEventListener('click', event => {
    const restore = event.target.closest('[data-restore-path]');
    if (restore) {
        restoreChangePath(restore.dataset.restorePath);
        return;
    }
    const changeOperation = event.target.closest('[data-change-operation]');
    if (changeOperation) {
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
        setResultObject(Number(resultObjectSuggestion.dataset.index), resultObjectSuggestion.dataset.selectResultObject);
        renderCurrentStep();
        return;
    }
    const resultConfiguration = event.target.closest('[data-select-result-configuration]');
    if (resultConfiguration) {
        const result = draft.results[Number(resultConfiguration.dataset.index)];
        const configuration = getModelCondition(result.modelID, resultConfiguration.dataset.selectResultConfiguration);
        result.modelConditionID = configuration?.ID ?? null;
        result.modelConditionRef = configuration?.reference ?? null;
        renderCurrentStep();
        return;
    }
    const resultProfile = event.target.closest('[data-select-result-profile]');
    if (resultProfile) {
        const result = draft.results[Number(resultProfile.dataset.index)];
        const profile = getBenchmarkCondition(resultProfile.dataset.selectResultProfile)?.profile;
        result.benchmarkConditionID = profile?.ID ?? null;
        result.benchmarkConditionRef = profile?.reference ?? null;
        renderCurrentStep();
        return;
    }
    const evaluationSuggestion = event.target.closest('[data-select-evaluation]');
    if (evaluationSuggestion) {
        setEvaluationSelection(evaluationSuggestion.dataset.selectEvaluation);
        renderCurrentStep();
        return;
    }
    const tagSuggestion = event.target.closest('[data-select-tag]');
    if (tagSuggestion) {
        commitTag(Number(tagSuggestion.dataset.evaluationIndex), tagSuggestion.dataset.selectTag);
        return;
    }
    const actionTarget = event.target.closest('[data-action]');
    if (actionTarget) {
        const action = actionTarget.dataset.action;
        if (action === 'start-parent-selection') {
            void beginParentSelection();
            return;
        } else if (action === 'explain-existing-condition') {
            showNotice(
                'Existing condition',
                'Existing test conditions cannot be changed in the Record benchmark form. Open Change benchmark information to edit or remove one.'
            );
            return;
        } else if (action === 'explain-existing-configuration') {
            showNotice(
                'Existing model condition',
                'Existing model test conditions cannot be changed in the Record model form. Open Change model information to edit or remove one.'
            );
            return;
        } else if (action === 'add-evaluation') {
            draft.benchmarks.push(makeEvaluation(draft.benchmarks.length));
        } else if (action === 'remove-evaluation') {
            draft.benchmarks.splice(Number(actionTarget.dataset.index), 1);
        } else if (action === 'add-profile') {
            const evaluation = draft.benchmarks[Number(actionTarget.dataset.evaluationIndex)];
            const profile = makeProfile(evaluation.conditions.length);
            profile.name = '';
            profile.isDefault = false;
            evaluation.conditions.push(profile);
        } else if (action === 'remove-profile') {
            const evaluation = draft.benchmarks[Number(actionTarget.dataset.evaluationIndex)];
            if (evaluation.conditions.length <= 1) {
                showNotice('Keep one condition', 'A benchmark request must contain at least one new test condition.');
                return;
            }
            const profileIndex = Number(actionTarget.dataset.profileIndex);
            evaluation.conditions.splice(profileIndex, 1);
        } else if (action === 'add-configuration') {
            const configuration = makeConfiguration(draft.subject.conditions.length);
            configuration.name = '';
            configuration.isDefault = false;
            draft.subject.conditions.push(configuration);
        } else if (action === 'remove-configuration') {
            if (draft.subject.conditions.length <= 1) {
                showNotice('Keep one condition', 'A model request must contain at least one new model test condition.');
                return;
            }
            const configurationIndex = Number(actionTarget.dataset.index);
            draft.subject.conditions.splice(configurationIndex, 1);
        } else if (action === 'move-context-up' || action === 'move-context-down') {
            const currentIndex = draft.category.contextOrder.findIndex(entry => entry.isNew);
            const nextIndex = action === 'move-context-up' ? currentIndex - 1 : currentIndex + 1;
            if (currentIndex >= 0 && nextIndex >= 0 && nextIndex < draft.category.contextOrder.length) {
                const [entry] = draft.category.contextOrder.splice(currentIndex, 1);
                draft.category.contextOrder.splice(nextIndex, 0, entry);
            }
        } else if (action === 'add-context-option') {
            draft.category.options.push(makeContextOption(draft.category.options.length));
        } else if (action === 'remove-context-option') {
            if (draft.category.options.length <= 2) {
                showNotice('Keep two options', 'A context must contain at least two distinct options.');
                return;
            }
            const optionIndex = Number(actionTarget.dataset.index);
            const removed = draft.category.options[optionIndex];
            draft.category.options.splice(optionIndex, 1);
            if (removed?.isDefault && draft.category.options[0]) {
                draft.category.options[0].isDefault = true;
            }
            if (removed?.isNeutral && draft.category.options[0]) {
                draft.category.options[0].isNeutral = true;
            }
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
    const removeTag = event.target.closest('[data-remove-tag]');
    if (removeTag) {
        const evaluation = draft.benchmarks[Number(removeTag.dataset.evaluationIndex)];
        evaluation.tags.splice(Number(removeTag.dataset.removeTag), 1);
        renderCurrentStep();
    }
});

stepSurface.addEventListener('click', event => {
    const categoryKind = event.target.closest('[data-category-kind]');
    if (!categoryKind) return;
    draft.category.requestKind = categoryKind.dataset.categoryKind;
    if (draft.category.requestKind === 'context' && draft.category.options.length < 2) {
        draft.category.options = [makeContextOption(0), makeContextOption(1)];
    }
    draft.category.clientRef = `${draft.category.requestKind}-${Date.now()}`;
    resetContextOrderForParent();
    renderCurrentStep();
});

stepSurface.addEventListener('dragstart', event => {
    const row = event.target.closest('.context-order-row.new[draggable="true"]');
    if (!row) {
        event.preventDefault();
        return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', 'new-context');
    row.classList.add('dragging');
});

stepSurface.addEventListener('dragend', event => {
    event.target.closest('.context-order-row')?.classList.remove('dragging');
});

stepSurface.addEventListener('dragover', event => {
    if (!event.target.closest('[data-context-order-list]')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
});

stepSurface.addEventListener('drop', event => {
    const targetRow = event.target.closest('[data-context-order-index]');
    if (!targetRow || event.dataTransfer.getData('text/plain') !== 'new-context') return;
    event.preventDefault();
    const currentIndex = draft.category.contextOrder.findIndex(entry => entry.isNew);
    if (currentIndex < 0) return;
    const targetIndex = Number(targetRow.dataset.contextOrderIndex);
    const rect = targetRow.getBoundingClientRect();
    const insertAfter = event.clientY > rect.top + rect.height / 2;
    const [newEntry] = draft.category.contextOrder.splice(currentIndex, 1);
    let insertionIndex = targetIndex + (insertAfter ? 1 : 0);
    if (currentIndex < insertionIndex) insertionIndex -= 1;
    draft.category.contextOrder.splice(Math.max(0, insertionIndex), 0, newEntry);
    renderCurrentStep();
});

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
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        if (!response.ok) {
            throw new Error(`Request failed (${response.status})`);
        }
        window.location.reload();
    } catch (error) {
        button.removeAttribute('disabled');
        showError(error.message || 'The account action could not be completed.');
    }
}

logoutConfirmButton.addEventListener('click', () => runAccountAction('/api/logout', logoutConfirmButton));
deleteConfirmButton.addEventListener('click', () => runAccountAction('/api/delete_account', deleteConfirmButton));
function showContributionGuide() {
    showNotice(
        'How contribution works',
        'Every contribution is attributed to your account and reviewed before publishing. Benchmark test conditions describe the protocol; model test conditions describe how a model was run; score evidence links exactly one of each.'
    );
}

document.getElementById('contribution-help').addEventListener('click', showContributionGuide);
document.getElementById('contribution-page-help').addEventListener('click', showContributionGuide);

async function initialize() {
    try {
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
