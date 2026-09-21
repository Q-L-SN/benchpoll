import { createComparisonControls } from './workspace/comparison-controls.js?v=comparison-recovery-20260912';
import { workspaceChannel } from './shared/workspace-channel.js';
import { readRankingContext, rankingContextURL } from './shared/ranking-url.js?v=short-20260908';
import { categoryDiscussionURL, createDiscussionEntry } from './workspace/discussion-entry.js?v=compact-count-20260908';
const updateDiscussionEntry = createDiscussionEntry(document.getElementById('discussion-entry'));
import { initializeMobilePanels } from './shared/mobile-panels.js';
import {
    PIE_GRADIENTS, SAVE_DEBOUNCE_MS, WEIGHT_STEP_BASIS_POINTS,
    MIN_WEIGHT_BASIS_POINTS, WHEEL_WEIGHT_COMMIT_IDLE_MS, TOUCH_DRAG_THRESHOLD_PX,
    TOUCH_WEIGHT_BASIS_POINTS_PER_PIXEL, WORKSPACE_LOAD_RETRY_DELAYS_MS, FALLBACK_RULE_MODE,
    MAX_FALLBACK_COMPONENTS
} from './workspace/constants.js';
import { createWorkspaceState } from './workspace/state.js?v=public-fallback-preferences-20260921';
import { readWorkspacePreferences, writeWorkspacePreferences } from './workspace/preferences.js?v=public-fallback-preferences-20260921';
import { validateWorkspacePayload } from './workspace/contracts.js?v=model-parameters-20260912';
import {
    cloneEntries, cloneFallbackRules, clonePersonalPieSnapshot,
    clamp, humanizePathPart, benchmarkConditionLabel,
    benchmarkAccessibleName, distributeToTarget
} from './workspace/weights.js';
import { postJSON } from './shared/http.js';
import { buildBenchmarkEditURL } from './workspace/links.js?v=clean-urls-20260908';
import { createModelScoresView } from './workspace/model-scores.js?v=model-parameters-20260912';
import { createModelListView } from './workspace/model-list.js?v=comparison-recovery-20260912';
import { createPieRenderer } from './workspace/pie-renderer.js?v=personal-only-icon-20260907';

const pieSvg = document.getElementById('weight-pie');
const breadcrumb = document.getElementById('bp-breadcrumb');
const templateStrip = document.getElementById('bp-template-strip');
const benchmarkRows = document.getElementById('benchmark-rows');
const benchmarkSearch = document.getElementById('benchmark-search');
const benchmarkPersonalPin = document.getElementById('benchmark-personal-pin');
const modelRows = document.getElementById('model-rows');
const modeSwitch = document.querySelector('.bp-mode-switch');
const personalModeButton = document.getElementById('pie-mode-personal');
const publicModeButton = document.getElementById('pie-mode-public');
const personalPieCreate = document.getElementById('personal-pie-create');
const personalEmptyMode = document.getElementById('personal-empty-mode');
const personalEmptyPublicReturn = document.getElementById('personal-empty-public-return');
const pieInstruction = document.getElementById('pie-instruction');
const pieContextNote = document.getElementById('pie-context-note');
const undoButton = document.getElementById('workspace-undo');
const refreshButton = document.getElementById('workspace-refresh');
const lastUpdated = document.getElementById('last-updated');
const termsButton = document.getElementById('terms-button');
const termsDialog = document.getElementById('terms-dialog');
const loginButton = document.getElementById('login-button');
const contributeDataButton = document.getElementById('contribute-data-button');
const contributeEvaluationButton = document.getElementById('contribute-button');
const modelScoresDialog = document.getElementById('model-scores-dialog');
const modelScoresTitle = document.getElementById('model-scores-title');
const modelScoresSummary = document.getElementById('model-scores-summary');
const modelScoresList = document.getElementById('model-scores-list');
const benchmarkCard = document.getElementById('benchmark-card');
const modelCard = document.getElementById('model-card');
const leftWorkspace = document.querySelector('.bp-left-workspace');
const pieHomeSlot = document.getElementById('pie-home-slot');
const pieCard = document.getElementById('pie-card');
const rightWorkspace = document.getElementById('right-workspace');
const benchmarkSummaryCard = document.getElementById('benchmark-summary-card');
const benchmarkSummaryContent = document.getElementById('benchmark-summary-content');
const benchmarkLeaderboardOpen = document.getElementById('benchmark-leaderboard-open');
const benchmarkLeaderboardClose = document.getElementById('benchmark-leaderboard-close');
const inlineFallback = document.getElementById('inline-fallback');
const inlineFallbackPersonalControl = document.getElementById('inline-fallback-personal-control');
const inlineFallbackEnabled = document.getElementById('inline-fallback-enabled');
const publicFallbackToggle = document.getElementById('public-fallback-toggle');
const inlineFallbackRemove = document.getElementById('inline-fallback-remove');
const inlineFallbackGuide = document.getElementById('inline-fallback-guide');
const inlineFallbackChart = document.getElementById('inline-fallback-chart');

const state = createWorkspaceState();
Object.assign(state, readWorkspacePreferences());
state.comparisonRequest = null;
state.comparisonNeedsSelection = false;
state.comparisonPending = false;
state.comparisonError = '';
const renderComparisonControls = createComparisonControls({ onChange(options) {
    state.comparisonNeedsSelection = false;
    state.comparisonError = '';
    state.comparisonPending = true;
    state.comparisonRequest = options;
    renderModels();
    void loadWeightedWorkspace({ preserveUndo: true, comparisonChange: true });
}, onInvalid(message) {
    state.comparisonNeedsSelection = true;
    state.comparisonError = message;
    state.comparisonPending = false;
    state.comparisonRequest = null;
    renderModels();
} });
initializeMobilePanels(document.querySelector('.bp-workspace'));

let touchPieGesture = null;
let pendingWheelBasisPoints = 0;
let wheelWeightCommitTimer = null;
let wheelPreviewFrame = null;

let selectedFallbackPrimaryID = null;
let selectedFallbackComponentID = null;
let fallbackDraftPrimaryID = null;
let fallbackTargetPrimaryID = null;
let selectedPublicFallbackComponentID = null;
let pendingFallbackWheelBasisPoints = 0;
let fallbackWheelCommitTimer = null;
let fallbackWheelPreviewFrame = null;
let touchFallbackGesture = null;

const { openApprovedModelResults } = createModelScoresView({ state, modelScoresDialog, modelScoresTitle, modelScoresSummary, modelScoresList });
const { renderModels } = createModelListView({ state, modelRows, openApprovedModelResults });
const { renderPie } = createPieRenderer({
    state, pieSvg, orderedPieEntries, currentPieEntries, selectedObjectIndex,
    renderInlineFallback, fallbackRuleFor, publicFallbackRuleFor,
    async onSelect(objectID) {
        if (!await finishPendingWeightAdjustments()) return;
        deactivateInlineFallbackTarget({ discardDraft: true });
        selectedPublicFallbackComponentID = null;
        state.selectedObjectID = objectID;
        renderPie();
        renderBenchmarks();
        renderBenchmarkSummary();
    }
});

function snapshotPersonalPie() {
    return {
        entries: cloneEntries(state.personalEntries),
        fallbackRules: cloneFallbackRules(state.personalFallbackRules)
    };
}

function restorePersonalPieSnapshot(snapshot) {
    const restored = clonePersonalPieSnapshot(snapshot);
    state.personalEntries = restored.entries;
    state.personalFallbackRules = restored.fallbackRules;
}

function selectedObjectIndex(entries = currentPieEntries()) {
    return entries.findIndex(entry => Number(entry.conditionID) === Number(state.selectedObjectID));
}

function currentPieEntries() {
    return state.mode === 'personal' ? state.personalEntries : state.publicEntries;
}

function workspaceContextFingerprint(categoryID = state.categoryID, contextValues = state.selectedContextValues) {
    const normalizedContextValues = Object.entries(contextValues ?? {})
        .sort(([left], [right]) => left.localeCompare(right));
    return `${categoryID ?? ''}:${JSON.stringify(normalizedContextValues)}`;
}

function resetPieVisualState() {
    if (state.pieAnimationFrame !== null) {
        cancelAnimationFrame(state.pieAnimationFrame);
    }
    state.pieAnimationFrame = null;
    state.pieOrderByObjectID.clear();
    state.nextPieOrder = 0;
    state.visualPieWeights.clear();
    state.visualPieEntries.clear();
    pieCard?.classList.remove('is-adjusting-weight');
    inlineFallback?.classList.remove('is-adjusting-weight');
    selectedFallbackPrimaryID = null;
    selectedFallbackComponentID = null;
    fallbackDraftPrimaryID = null;
    fallbackTargetPrimaryID = null;
    selectedPublicFallbackComponentID = null;
}

function setPieAdjustmentActive(active) {
    pieCard?.classList.toggle('is-adjusting-weight', Boolean(active));
}

function setFallbackAdjustmentActive(active) {
    inlineFallback?.classList.toggle('is-adjusting-weight', Boolean(active));
}

function registerPieEntries(entries) {
    entries.forEach(entry => {
        const objectID = Number(entry.conditionID);
        if (!state.pieOrderByObjectID.has(objectID)) {
            state.pieOrderByObjectID.set(objectID, state.nextPieOrder);
            state.nextPieOrder += 1;
        }
    });
}

function orderedPieEntries(entries) {
    registerPieEntries(entries);
    return [...entries].sort((left, right) => {
        const leftOrder = state.pieOrderByObjectID.get(Number(left.conditionID));
        const rightOrder = state.pieOrderByObjectID.get(Number(right.conditionID));
        return leftOrder - rightOrder;
    });
}

function sameContextValues(left = {}, right = {}) {
    const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
    const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
    return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function syncContextValuesToURL() {
    const url = rankingContextURL(window.location.href, state.dimensions, state.selectedContextValues);
    window.history.replaceState(window.history.state, '', url);
}

function setStatus(message = '') {
    state.statusMessage = message;
    updateLastUpdated();
}

function updateLastUpdated() {
    if (state.statusMessage) {
        lastUpdated.textContent = state.statusMessage;
        return;
    }
    const elapsedMinutes = Math.max(0, Math.floor((Date.now() - state.lastLoadTime) / 60000));
    lastUpdated.textContent = elapsedMinutes === 0
        ? 'Last updated just now'
        : `Last updated ${elapsedMinutes}m ago`;
}

function renderBreadcrumb() {
    breadcrumb.replaceChildren();
    const pathParts = String(state.categoryPath || '')
        .split('/')
        .filter(Boolean);
    const displayParts = pathParts.map(humanizePathPart);
    const rootOffset = displayParts.length > 1 ? 1 : 0;
    const visibleParts = displayParts.length > 0
        ? displayParts.slice(rootOffset)
        : ['All Categories'];
    visibleParts.forEach((part, index) => {
        const isCurrent = index === visibleParts.length - 1;
        const node = document.createElement(isCurrent ? 'span' : 'a');
        node.textContent = part;
        if (isCurrent) node.className = 'bp-breadcrumb-current';
        if (!isCurrent) {
            const path = pathParts
                .slice(0, rootOffset + index + 1)
                .map(segment => encodeURIComponent(segment))
                .join('/');
            node.href = `/rankings/${path}`;
        }
        breadcrumb.append(node);
        if (!isCurrent) {
            const separator = document.createElement('i');
            separator.className = 'fa-solid fa-chevron-right';
            separator.setAttribute('aria-hidden', 'true');
            breadcrumb.append(separator);
        }
    });
}

function templateValueClass(option) {
    if (option?.isNeutral) {
        return 'bp-template-neutral';
    }
    if (/disallowed/i.test(option?.name ?? '')) {
        return 'bp-template-negative';
    }
    return 'bp-template-positive';
}

function renderTemplateControls() {
    templateStrip.replaceChildren();
    const hasTemplateDimensions = state.dimensions.length > 0;
    templateStrip.hidden = !hasTemplateDimensions;
    document.body.classList.toggle('bp-no-template-context', !hasTemplateDimensions);

    if (!hasTemplateDimensions) {
        return;
    }

    state.dimensions.forEach(dimension => {
        const selected = dimension.options.find(option => option.key === dimension.selectedKey)
            ?? dimension.options[0];
        const picker = document.createElement('div');
        picker.className = 'bp-template-picker';
        picker.dataset.templateKey = dimension.key;
        const control = document.createElement('button');
        control.className = 'bp-template-control';
        control.type = 'button';
        control.dataset.templateKey = dimension.key;
        control.setAttribute('aria-haspopup', 'listbox');
        control.setAttribute('aria-expanded', 'false');
        control.setAttribute('aria-label', `${dimension.name}: ${selected?.name ?? 'Not specified'}. Hover to view options.`);
        const name = document.createElement('span');
        name.textContent = dimension.name;
        const value = document.createElement('strong');
        value.className = `bp-template-value ${templateValueClass(selected)}`;
        value.textContent = selected?.name ?? 'Not specified';
        control.append(name, value);

        const menu = document.createElement('div');
        menu.className = 'bp-template-menu';
        menu.setAttribute('role', 'listbox');
        menu.setAttribute('aria-label', dimension.name);

        let closeTimer = null;
        const openMenu = () => {
            if (dimension.options.length < 2) {
                return;
            }
            window.clearTimeout(closeTimer);
            closeTimer = null;
            picker.dataset.open = 'true';
            control.setAttribute('aria-expanded', 'true');
        };
        const closeMenu = () => {
            window.clearTimeout(closeTimer);
            closeTimer = null;
            delete picker.dataset.open;
            control.setAttribute('aria-expanded', 'false');
        };
        const scheduleMenuClose = () => {
            window.clearTimeout(closeTimer);
            closeTimer = window.setTimeout(closeMenu, 140);
        };

        dimension.options.forEach(option => {
            const choice = document.createElement('button');
            const isSelected = option.key === selected?.key;
            choice.className = 'bp-template-choice';
            choice.type = 'button';
            choice.setAttribute('role', 'option');
            choice.setAttribute('aria-selected', String(isSelected));
            choice.dataset.selected = String(isSelected);
            choice.textContent = option.name;
            choice.addEventListener('click', async event => {
                event.stopPropagation();
                if (state.loading || isSelected) {
                    closeMenu();
                    return;
                }
                closeMenu();
                if (!await finishPendingWeightAdjustments()) return;
                if (state.saving && state.savePromise) {
                    await state.savePromise.catch(() => {});
                }
                if (!await flushPendingPersonalPieSave()) {
                    return;
                }
                state.selectedContextValues = {
                    ...state.selectedContextValues,
                    [dimension.key]: option.key
                };
                state.workspaceView = 'overview';
                await loadWeightedWorkspace();
            });
            menu.append(choice);
        });

        picker.addEventListener('pointerenter', event => {
            if (event.pointerType !== 'touch') {
                openMenu();
            }
        });
        picker.addEventListener('pointerleave', event => {
            if (event.pointerType !== 'touch') {
                scheduleMenuClose();
            }
        });
        picker.addEventListener('focusin', openMenu);
        picker.addEventListener('focusout', () => {
            requestAnimationFrame(() => {
                if (!picker.contains(document.activeElement)) {
                    closeMenu();
                }
            });
        });
        control.addEventListener('click', event => {
            event.stopPropagation();
            if (window.matchMedia('(hover: none)').matches) {
                if (picker.dataset.open === 'true') {
                    closeMenu();
                } else {
                    openMenu();
                }
            } else {
                openMenu();
            }
        });
        control.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                closeMenu();
                control.focus();
                return;
            }
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                openMenu();
                menu.querySelector('[aria-selected="true"]')?.focus();
            }
        });
        menu.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                closeMenu();
                control.focus();
            }
        });

        picker.append(control, menu);
        templateStrip.append(picker);
    });
}

function updateUndoState() {
    undoButton.disabled = !state.authenticated
        || state.saving
        || state.gestureOpen
        || wheelWeightCommitTimer !== null
        || fallbackWheelCommitTimer !== null
        || !state.undoSnapshot;
}

function requestLogin() {
    loginButton?.click();
}

function beginMutation(isGesture = false) {
    if (!state.authenticated) {
        requestLogin();
        return false;
    }
    if (state.saving || state.loading) {
        return false;
    }
    if (isGesture) {
        let gestureStarted = false;
        if (!state.gestureOpen) {
            state.gestureOpen = true;
            state.gestureSnapshot = snapshotPersonalPie();
            gestureStarted = true;
        }
        window.clearTimeout(state.gestureTimer);
        state.gestureTimer = null;
        if (gestureStarted) {
            updateUndoState();
        }
    } else {
        if (state.gestureOpen) {
            return false;
        }
        state.undoSnapshot = snapshotPersonalPie();
        updateUndoState();
    }
    return true;
}

function finishWeightGesture({ persist = true } = {}) {
    if (!state.gestureOpen) {
        setPieAdjustmentActive(false);
        setFallbackAdjustmentActive(false);
        return state.persistPromise ?? Promise.resolve(true);
    }
    window.clearTimeout(state.gestureTimer);
    state.gestureTimer = null;
    state.gestureOpen = false;
    setPieAdjustmentActive(false);
    setFallbackAdjustmentActive(false);
    if (state.gestureSnapshot) {
        state.undoSnapshot = clonePersonalPieSnapshot(state.gestureSnapshot);
    }
    state.gestureSnapshot = null;
    renderInlineFallback();
    renderBenchmarks();
    renderModels();
    updateUndoState();
    return persist ? persistPersonalPie() : Promise.resolve(true);
}

async function finishPendingWeightAdjustments() {
    if (fallbackWheelCommitTimer !== null && !await commitPendingFallbackWheelAdjustment()) {
        return false;
    }
    if (wheelWeightCommitTimer !== null && !await commitPendingWheelAdjustment()) {
        return false;
    }
    if (state.gestureOpen && !await finishWeightGesture()) {
        return false;
    }
    return true;
}

function scheduleSave() {
    window.clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(() => {
        state.saveTimer = null;
        void persistPersonalPie();
    }, SAVE_DEBOUNCE_MS);
}

async function flushPendingPersonalPieSave() {
    let saved = true;
    if (state.saveTimer !== null) {
        window.clearTimeout(state.saveTimer);
        state.saveTimer = null;
        saved = await persistPersonalPie();
    }
    if (state.persistPromise) {
        saved = (await state.persistPromise) && saved;
    }
    return saved;
}

function adjustSelectedWeight(deltaBasisPoints, { animateWeights = true } = {}) {
    if (state.mode !== 'personal' || state.personalEntries.length === 0) {
        return;
    }
    const selectedIndex = selectedObjectIndex(state.personalEntries);
    if (selectedIndex < 0) {
        return;
    }
    const entries = cloneEntries(state.personalEntries);
    const selected = entries[selectedIndex];
    const others = entries.filter((_, index) => index !== selectedIndex);
    const minimum = others.length === 0
        ? state.limits.totalBasisPoints
        : MIN_WEIGHT_BASIS_POINTS;
    const maximum = state.limits.totalBasisPoints - (others.length * MIN_WEIGHT_BASIS_POINTS);
    const selectedWeight = clamp(
        selected.weightBasisPoints + deltaBasisPoints,
        minimum,
        maximum
    );
    if (selectedWeight === selected.weightBasisPoints || !beginMutation(true)) {
        return;
    }
    const redistributed = distributeToTarget(
        others,
        state.limits.totalBasisPoints - selectedWeight
    );
    selected.weightBasisPoints = selectedWeight;
    selected.weight = selectedWeight / 100;
    const redistributedByID = new Map(redistributed.map(entry => [Number(entry.conditionID), entry]));
    state.personalEntries = entries.map((entry, index) => (
        index === selectedIndex ? selected : redistributedByID.get(Number(entry.conditionID))
    ));
    renderPie({ animateWeights });
    renderBenchmarkSummary();
}

function commitPendingWheelAdjustment() {
    window.clearTimeout(wheelWeightCommitTimer);
    wheelWeightCommitTimer = null;
    if (wheelPreviewFrame !== null) {
        cancelAnimationFrame(wheelPreviewFrame);
        wheelPreviewFrame = null;
    }
    const deltaBasisPoints = Math.round(pendingWheelBasisPoints);
    pendingWheelBasisPoints = 0;
    if (deltaBasisPoints !== 0) {
        adjustSelectedWeight(deltaBasisPoints, { animateWeights: false });
    }
    renderBenchmarks();
    updateUndoState();
    return finishWeightGesture();
}

function scheduleWheelPreview() {
    if (wheelPreviewFrame !== null) {
        return;
    }
    wheelPreviewFrame = requestAnimationFrame(() => {
        wheelPreviewFrame = null;
        const deltaBasisPoints = Math.round(pendingWheelBasisPoints);
        pendingWheelBasisPoints = 0;
        if (deltaBasisPoints !== 0) {
            adjustSelectedWeight(deltaBasisPoints);
        }
    });
}

function objectTypeLabel(type) {
    const normalized = String(type ?? 'benchmark').toLowerCase();
    if (normalized === 'arena') return 'Arena';
    if (normalized === 'protocol') return 'Protocol';
    if (normalized === 'other') return 'Other Benchmark';
    return 'Benchmark';
}

const WORKSPACE_VIEWS = new Set(['overview', 'leaderboard', 'focus']);

function selectedBenchmark() {
    return state.benchmarks.find(object => Number(object.ID) === Number(state.selectedObjectID)) ?? null;
}

function benchmarkSummaryTags(object) {
    if (!object) {
        return [];
    }
    const tags = Array.isArray(object.tags) && object.tags.length > 0
        ? [...object.tags]
        : [objectTypeLabel(object.type)];
    return tags.slice(0, 4);
}

function renderBenchmarkSummary() {
    benchmarkSummaryContent.replaceChildren();
    const object = selectedBenchmark();
    if (!object) {
        const empty = document.createElement('div');
        empty.className = 'bp-benchmark-summary-empty';
        empty.innerHTML = '<strong>No benchmark selected</strong><span>Select a weight slice to inspect its benchmark.</span>';
        benchmarkSummaryContent.append(empty);
        return;
    }

    const identity = document.createElement('div');
    identity.className = 'bp-benchmark-summary-identity';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'bp-benchmark-summary-eyebrow';
    eyebrow.textContent = 'Selected benchmark';
    const title = document.createElement('span');
    title.className = 'bp-benchmark-summary-title';
    const name = document.createElement('strong');
    name.textContent = object.name;
    title.append(name);
    const conditionLabel = benchmarkConditionLabel(object);
    if (conditionLabel) {
        const condition = document.createElement('span');
        condition.className = 'bp-benchmark-condition';
        condition.textContent = conditionLabel;
        title.append(condition);
    }
    const tags = document.createElement('span');
    tags.className = 'bp-benchmark-summary-tags';
    benchmarkSummaryTags(object).forEach(label => {
        const tag = document.createElement('span');
        tag.textContent = label;
        tags.append(tag);
    });
    identity.append(eyebrow, title, tags);

    const metric = document.createElement('div');
    metric.className = 'bp-benchmark-summary-metric';
    const label = document.createElement('span');
    label.textContent = state.mode === 'personal' ? 'Personal weight' : 'Public weight';
    const value = document.createElement('strong');
    const selectedEntry = currentPieEntries().find(entry => Number(entry.conditionID) === Number(object.ID));
    const weight = selectedEntry?.weight ?? (state.mode === 'personal' ? object.personalWeight : object.publicWeight);
    value.textContent = weight === null || weight === undefined
        ? 'Not added'
        : `${Number(weight).toFixed(2)}%`;
    metric.append(label, value);
    benchmarkSummaryContent.append(identity, metric);
}

function applyWorkspaceView({ animate = false } = {}) {
    const update = () => {
            if (pieCard.parentElement !== pieHomeSlot) {
            pieHomeSlot.append(pieCard);
        }
        pieCard.hidden = false;
        benchmarkSummaryCard.hidden = true;
        benchmarkCard.hidden = false;
        modelCard.hidden = false;
        leftWorkspace.dataset.workspaceView = state.workspaceView;
        rightWorkspace.dataset.workspaceView = state.workspaceView;
    };
    if (animate
        && typeof document.startViewTransition === 'function'
        && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        document.startViewTransition(update);
    } else {
        update();
    }
}

function setWorkspaceView(view, { animate = true } = {}) {
    if (!WORKSPACE_VIEWS.has(view)) {
        throw new TypeError(`Unsupported workspace view: ${view}`);
    }
    state.workspaceView = view;
    applyWorkspaceView({ animate });
    renderModeState();
    renderBenchmarks();
    renderBenchmarkSummary();
}

function fallbackRuleFor(primaryConditionID) {
    return state.personalFallbackRules.find(rule => (
        Number(rule.primaryConditionID) === Number(primaryConditionID)
    )) ?? null;
}

function publicFallbackRuleFor(primaryConditionID) {
    return state.publicFallbackRules.find(rule => (
        Number(rule.primaryConditionID) === Number(primaryConditionID)
    )) ?? null;
}

function fallbackIsEnabledFor(primaryConditionID) {
    return Boolean(fallbackRuleFor(primaryConditionID))
        || Number(fallbackDraftPrimaryID) === Number(primaryConditionID);
}

function selectedInlineFallbackPrimary() {
    if (!state.authenticated || state.mode !== 'personal') {
        return null;
    }
    const primary = selectedBenchmark();
    if (!primary || !state.personalEntries.some(entry => (
        Number(entry.conditionID) === Number(primary.ID)
    ))) {
        return null;
    }
    return primary;
}

function selectedPublicFallbackPrimary() {
    if (state.mode !== 'public') {
        return null;
    }
    const primary = selectedBenchmark();
    if (!primary || !state.publicEntries.some(entry => (
        Number(entry.conditionID) === Number(primary.ID)
    ))) {
        return null;
    }
    return primary;
}

function isInlineFallbackTargetActive() {
    const primary = selectedInlineFallbackPrimary();
    return Boolean(primary)
        && fallbackIsEnabledFor(primary.ID)
        && Number(fallbackTargetPrimaryID) === Number(primary.ID);
}

function deactivateInlineFallbackTarget({ discardDraft = false } = {}) {
    fallbackTargetPrimaryID = null;
    selectedFallbackPrimaryID = null;
    selectedFallbackComponentID = null;
    if (discardDraft) {
        fallbackDraftPrimaryID = null;
    }
    inlineFallback?.classList.remove('is-target-active');
    benchmarkCard?.classList.remove('is-fallback-target-active');
}

function activateInlineFallbackTarget(preferredComponentID = null) {
    const primary = selectedInlineFallbackPrimary();
    if (!primary || !fallbackIsEnabledFor(primary.ID) || state.loading || state.saving) {
        return false;
    }
    const rule = fallbackRuleFor(primary.ID);
    const componentIDs = new Set((rule?.entries ?? []).map(entry => Number(entry.conditionID)));
    fallbackTargetPrimaryID = Number(primary.ID);
    selectedFallbackPrimaryID = Number(primary.ID);
    selectedFallbackComponentID = componentIDs.has(Number(preferredComponentID))
        ? Number(preferredComponentID)
        : rule?.entries[0]?.conditionID ?? null;
    if (state.workspaceView === 'focus') {
        state.workspaceView = 'leaderboard';
        applyWorkspaceView({ animate: true });
        renderModeState();
    }
    renderInlineFallback();
    renderBenchmarks();
    return true;
}

function publicFallbackPercent(weight) {
    return weight > 0 && weight < 0.01 ? '<0.01%' : `${Number(weight.toFixed(2))}%`;
}

function renderInlineFallback() {
    if (!inlineFallback
        || !inlineFallbackPersonalControl
        || !inlineFallbackEnabled
        || !publicFallbackToggle
        || !inlineFallbackRemove
        || !inlineFallbackGuide
        || !inlineFallbackChart) {
        return;
    }
    const personal = state.mode === 'personal';
    const primary = personal ? selectedInlineFallbackPrimary() : selectedPublicFallbackPrimary();
    const primaryConditionID = Number(primary?.ID);
    const personalRule = primary && personal ? fallbackRuleFor(primaryConditionID) : null;
    const publicRule = primary && !personal ? publicFallbackRuleFor(primaryConditionID) : null;
    const enabled = Boolean(primary) && personal && fallbackIsEnabledFor(primaryConditionID);
    const publicExpanded = Boolean(primary) && !personal && state.publicFallbackVisible;
    const chartVisible = personal ? enabled : publicExpanded;
    const visible = Boolean(primary);
    inlineFallback.hidden = !visible;
    pieCard?.classList.toggle('has-inline-fallback', visible);
    inlineFallback.classList.toggle('is-readonly', !personal);
    inlineFallbackPersonalControl.hidden = !personal;
    publicFallbackToggle.hidden = personal;
    publicFallbackToggle.disabled = state.loading || state.saving;
    publicFallbackToggle.textContent = publicExpanded ? 'Hide fallback' : 'Show fallback';
    publicFallbackToggle.setAttribute('aria-expanded', String(publicExpanded));
    if (!primary) {
        deactivateInlineFallbackTarget({ discardDraft: personal });
        inlineFallbackEnabled.checked = false;
        inlineFallbackRemove.hidden = true;
        inlineFallbackGuide.hidden = true;
        inlineFallbackChart.hidden = true;
        inlineFallbackChart.tabIndex = -1;
        inlineFallbackChart.replaceChildren();
        return;
    }

    const rule = personal ? personalRule : publicRule;
    const targetActive = personal && chartVisible && Number(fallbackTargetPrimaryID) === primaryConditionID;
    const controlsBusy = state.loading || state.saving || state.gestureOpen;
    const interactionBusy = state.loading || state.saving;
    if (!personal || !targetActive) {
        selectedFallbackPrimaryID = null;
        selectedFallbackComponentID = null;
    }
    inlineFallback.classList.toggle('is-target-active', targetActive);
    benchmarkCard?.classList.toggle('is-fallback-target-active', targetActive);
    inlineFallbackEnabled.checked = enabled;
    inlineFallbackEnabled.disabled = controlsBusy;
    inlineFallbackRemove.hidden = !personal || !targetActive || !rule || selectedFallbackComponentID === null;
    inlineFallbackRemove.disabled = controlsBusy;
    if (!inlineFallbackRemove.hidden) {
        const selectedEntry = rule.entries.find(entry => (
            Number(entry.conditionID) === Number(selectedFallbackComponentID)
        ));
        const selectedName = benchmarkAccessibleName(selectedEntry);
        inlineFallbackRemove.setAttribute('aria-label', `Remove ${selectedName} from Fallback`);
        inlineFallbackRemove.title = `Remove ${selectedName} from Fallback`;
    }
    inlineFallbackGuide.hidden = !chartVisible;
    inlineFallbackGuide.textContent = personal
        ? 'Select the bar, add benchmarks from the leaderboard, then scroll to adjust.'
        : `When a model has no score for ${benchmarkAccessibleName(primary)}, use this benchmark mix instead.`;
    inlineFallbackChart.hidden = !chartVisible;
    inlineFallbackChart.tabIndex = chartVisible && !interactionBusy ? 0 : -1;
    inlineFallbackChart.classList.toggle('is-target-active', targetActive);
    inlineFallbackChart.classList.toggle('is-disabled', interactionBusy);
    inlineFallbackChart.setAttribute(
        'aria-label',
        personal
            ? targetActive
                ? `Fallback mix selected for ${benchmarkAccessibleName(primary)}. Choose benchmark rows to add.`
                : `Fallback mix for ${benchmarkAccessibleName(primary)}. Select this bar before choosing benchmarks.`
            : `Public fallback mix for ${benchmarkAccessibleName(primary)}`
    );

    if (!chartVisible) {
        inlineFallbackChart.classList.remove('has-single-component', 'is-empty');
        inlineFallbackChart.replaceChildren();
        return;
    }

    if (!rule) {
        inlineFallbackChart.classList.remove('has-single-component');
        inlineFallbackChart.classList.add('is-empty');
        const empty = document.createElement('span');
        empty.className = 'bp-inline-fallback-empty';
        empty.textContent = !personal ? 'No public fallback configured for this benchmark.' : targetActive
            ? 'Choose a benchmark from the leaderboard'
            : 'Select this bar to add benchmarks';
        inlineFallbackChart.replaceChildren(empty);
        return;
    }

    const componentIDs = new Set(rule.entries.map(entry => Number(entry.conditionID)));
    if (personal && targetActive && (selectedFallbackPrimaryID !== primaryConditionID
        || !componentIDs.has(Number(selectedFallbackComponentID)))) {
        selectedFallbackPrimaryID = primaryConditionID;
        selectedFallbackComponentID = rule.entries[0]?.conditionID ?? null;
    }
    if (!personal && selectedPublicFallbackComponentID !== null
        && !componentIDs.has(Number(selectedPublicFallbackComponentID))) {
        selectedPublicFallbackComponentID = null;
    }
    inlineFallbackChart.querySelector('.bp-inline-fallback-empty')?.remove();
    inlineFallbackChart.classList.remove('is-empty');
    inlineFallbackChart.classList.toggle('has-single-component', rule.entries.length === 1
        && (personal || rule.unconfiguredWeightBasisPoints === 0));
    inlineFallbackChart.querySelector('.bp-public-fallback-unconfigured')?.remove();
    const retainedSegments = new Set();
    rule.entries.forEach((entry, index) => {
        const conditionID = Number(entry.conditionID);
        const weight = Number(entry.weightBasisPoints) / 100;
        const percentage = personal ? `${Math.round(weight)}%` : publicFallbackPercent(weight);
        const selected = personal
            ? targetActive && conditionID === Number(selectedFallbackComponentID)
            : conditionID === Number(selectedPublicFallbackComponentID);
        const [startColor, endColor] = PIE_GRADIENTS[index % PIE_GRADIENTS.length];
        let segment = inlineFallbackChart.querySelector(
            `.bp-inline-fallback-segment[data-condition-id="${conditionID}"]`
        );
        if (!segment) {
            segment = document.createElement('button');
            segment.type = 'button';
            segment.className = 'bp-inline-fallback-segment';
            segment.append(
                document.createElement('strong'),
                document.createElement('small'),
                document.createElement('span')
            );
            segment.addEventListener('click', event => {
                event.stopPropagation();
                if (state.mode === 'public') {
                    selectedPublicFallbackComponentID = Number(segment.dataset.conditionId);
                    renderInlineFallback();
                } else {
                    activateInlineFallbackTarget(Number(segment.dataset.conditionId));
                }
            });
        }
        retainedSegments.add(segment);
        segment.classList.toggle('selected', selected);
        segment.dataset.primaryConditionId = String(primaryConditionID);
        segment.dataset.conditionId = String(conditionID);
        segment.style.setProperty('--bp-fallback-weight', `${weight}%`);
        segment.style.setProperty('--bp-fallback-color-start', `var(--bp-chart-${index % PIE_GRADIENTS.length}-start, ${startColor})`);
        segment.style.setProperty('--bp-fallback-color-end', `var(--bp-chart-${index % PIE_GRADIENTS.length}-end, ${endColor})`);
        segment.disabled = interactionBusy;
        segment.setAttribute('aria-pressed', String(selected));
        segment.setAttribute(
            'aria-label',
            `${benchmarkAccessibleName(entry)}: ${percentage} of the ${personal ? '' : 'public '}Fallback mix`
        );
        segment.title = `${benchmarkAccessibleName(entry)}: ${percentage}`;
        if (!personal && selected) {
            inlineFallbackGuide.textContent = segment.title;
        }

        const name = segment.querySelector('strong');
        name.textContent = entry.name;
        const conditionLabel = benchmarkConditionLabel(entry);
        const condition = segment.querySelector('small');
        condition.hidden = !conditionLabel;
        condition.textContent = conditionLabel;
        const value = segment.querySelector('span');
        value.textContent = percentage;
        const currentAtIndex = inlineFallbackChart.children[index];
        if (currentAtIndex !== segment) {
            inlineFallbackChart.insertBefore(segment, currentAtIndex ?? null);
        }
    });
    inlineFallbackChart.querySelectorAll('.bp-inline-fallback-segment').forEach(segment => {
        if (!retainedSegments.has(segment)) segment.remove();
    });
    if (!personal && rule.unconfiguredWeightBasisPoints > 0) {
        const remainder = document.createElement('span');
        const weight = rule.unconfiguredWeightBasisPoints / 100;
        remainder.className = 'bp-public-fallback-unconfigured';
        remainder.style.setProperty('--bp-fallback-weight', `${weight}%`);
        const label = document.createElement('span');
        label.textContent = 'No fallback';
        const percentage = document.createElement('span');
        percentage.textContent = publicFallbackPercent(weight);
        remainder.append(label, percentage);
        remainder.title = `No fallback ${percentage.textContent}`;
        remainder.tabIndex = 0;
        remainder.addEventListener('focus', () => {
            inlineFallbackGuide.textContent = remainder.title;
        });
        inlineFallbackChart.append(remainder);
    }
}

function adjustSelectedFallbackWeight(deltaBasisPoints) {
    const primary = selectedInlineFallbackPrimary();
    if (!primary || !isInlineFallbackTargetActive()) return false;
    const rules = cloneFallbackRules(state.personalFallbackRules);
    const rule = rules.find(candidate => (
        Number(candidate.primaryConditionID) === Number(primary.ID)
    ));
    if (!rule || rule.entries.length < 2) return false;
    const selectedIndex = rule.entries.findIndex(entry => (
        Number(entry.conditionID) === Number(selectedFallbackComponentID)
    ));
    if (selectedIndex < 0) return false;

    const selected = { ...rule.entries[selectedIndex] };
    const others = rule.entries.filter((_, index) => index !== selectedIndex);
    const maximum = state.limits.totalBasisPoints - (others.length * MIN_WEIGHT_BASIS_POINTS);
    const nextWeight = clamp(
        Number(selected.weightBasisPoints) + deltaBasisPoints,
        MIN_WEIGHT_BASIS_POINTS,
        maximum
    );
    if (nextWeight === Number(selected.weightBasisPoints) || !beginMutation(true)) {
        return false;
    }

    selected.weightBasisPoints = nextWeight;
    selected.weight = nextWeight / 100;
    const redistributed = distributeToTarget(
        others,
        state.limits.totalBasisPoints - nextWeight,
        MIN_WEIGHT_BASIS_POINTS
    );
    const redistributedByID = new Map(redistributed.map(entry => [Number(entry.conditionID), entry]));
    rule.entries = rule.entries.map((entry, index) => (
        index === selectedIndex ? selected : redistributedByID.get(Number(entry.conditionID))
    ));
    state.personalFallbackRules = rules;
    renderInlineFallback();
    return true;
}

function scheduleFallbackWheelPreview() {
    if (fallbackWheelPreviewFrame !== null) return;
    fallbackWheelPreviewFrame = requestAnimationFrame(() => {
        fallbackWheelPreviewFrame = null;
        const deltaBasisPoints = Math.round(pendingFallbackWheelBasisPoints);
        pendingFallbackWheelBasisPoints = 0;
        if (deltaBasisPoints !== 0) {
            adjustSelectedFallbackWeight(deltaBasisPoints);
        }
    });
}

function commitPendingFallbackWheelAdjustment() {
    window.clearTimeout(fallbackWheelCommitTimer);
    fallbackWheelCommitTimer = null;
    if (fallbackWheelPreviewFrame !== null) {
        cancelAnimationFrame(fallbackWheelPreviewFrame);
        fallbackWheelPreviewFrame = null;
    }
    const deltaBasisPoints = Math.round(pendingFallbackWheelBasisPoints);
    pendingFallbackWheelBasisPoints = 0;
    if (deltaBasisPoints !== 0) {
        adjustSelectedFallbackWeight(deltaBasisPoints);
    }
    renderInlineFallback();
    updateUndoState();
    return finishWeightGesture();
}

async function removeInlineFallbackRule() {
    const primary = selectedInlineFallbackPrimary();
    if (!primary) {
        renderInlineFallback();
        return;
    }
    const primaryConditionID = Number(primary.ID);
    if (!fallbackRuleFor(primaryConditionID)) {
        if (Number(fallbackDraftPrimaryID) === primaryConditionID) {
            fallbackDraftPrimaryID = null;
        }
        deactivateInlineFallbackTarget();
        renderInlineFallback();
        renderBenchmarks();
        return;
    }
    if (!beginMutation()) {
        renderInlineFallback();
        return;
    }
    state.personalFallbackRules = state.personalFallbackRules.filter(rule => (
        Number(rule.primaryConditionID) !== primaryConditionID
    ));
    fallbackDraftPrimaryID = null;
    deactivateInlineFallbackTarget();
    renderPie();
    renderBenchmarks();
    await persistPersonalPie();
}

function fallbackComponentFromBenchmark(object, weightBasisPoints) {
    return {
        conditionID: Number(object.ID),
        benchmarkID: Number(object.benchmarkID),
        name: object.name,
        conditionKey: object.conditionKey,
        conditionName: object.conditionName,
        isDefaultCondition: Boolean(object.isDefaultCondition),
        type: object.type,
        weightBasisPoints,
        weight: weightBasisPoints / 100
    };
}

function fallbackRuleWouldCycle(primaryConditionID, candidateEntries) {
    const rulesByPrimary = new Map(state.personalFallbackRules
        .filter(rule => Number(rule.primaryConditionID) !== Number(primaryConditionID))
        .map(rule => [Number(rule.primaryConditionID), rule.entries.map(entry => Number(entry.conditionID))]));
    rulesByPrimary.set(Number(primaryConditionID), candidateEntries.map(entry => Number(entry.conditionID)));
    const targetID = Number(primaryConditionID);
    const canReachTarget = (conditionID, visited = new Set()) => {
        const normalizedID = Number(conditionID);
        if (normalizedID === targetID) return true;
        if (visited.has(normalizedID)) return false;
        visited.add(normalizedID);
        return (rulesByPrimary.get(normalizedID) ?? []).some(nextID => canReachTarget(nextID, visited));
    };
    return candidateEntries.some(entry => canReachTarget(entry.conditionID));
}

function replaceFallbackRuleEntries(primaryConditionID, entries) {
    const retained = state.personalFallbackRules.filter(rule => (
        Number(rule.primaryConditionID) !== Number(primaryConditionID)
    ));
    if (entries.length > 0) {
        retained.push({
            primaryConditionID: Number(primaryConditionID),
            mode: FALLBACK_RULE_MODE,
            entries: cloneEntries(entries)
        });
    }
    state.personalFallbackRules = retained.sort((left, right) => (
        Number(left.primaryConditionID) - Number(right.primaryConditionID)
    ));
}

function addObjectToFallbackMix(object) {
    const primary = selectedInlineFallbackPrimary();
    if (!primary || !isInlineFallbackTargetActive()) {
        return false;
    }
    const primaryConditionID = Number(primary.ID);
    const conditionID = Number(object.ID);
    if (conditionID === primaryConditionID) {
        setStatus('A benchmark cannot fall back to itself.');
        return false;
    }

    const existingRule = fallbackRuleFor(primaryConditionID);
    const existingEntry = existingRule?.entries.find(entry => (
        Number(entry.conditionID) === conditionID
    ));
    if (existingEntry) {
        selectedFallbackPrimaryID = primaryConditionID;
        selectedFallbackComponentID = conditionID;
        renderInlineFallback();
        renderBenchmarks();
        return true;
    }

    const existingEntries = cloneEntries(existingRule?.entries ?? []);
    if (existingEntries.length >= MAX_FALLBACK_COMPONENTS) {
        setStatus('Fallback can contain up to ' + MAX_FALLBACK_COMPONENTS + ' benchmarks.');
        return false;
    }

    const candidate = fallbackComponentFromBenchmark(object, state.limits.totalBasisPoints);
    let nextEntries;
    if (existingEntries.length === 0) {
        nextEntries = [candidate];
    } else {
        const initialWeight = Math.min(
            500,
            state.limits.totalBasisPoints - (existingEntries.length * MIN_WEIGHT_BASIS_POINTS)
        );
        const redistributed = distributeToTarget(
            existingEntries,
            state.limits.totalBasisPoints - initialWeight,
            MIN_WEIGHT_BASIS_POINTS
        );
        candidate.weightBasisPoints = initialWeight;
        candidate.weight = initialWeight / 100;
        nextEntries = [...redistributed, candidate];
    }

    if (fallbackRuleWouldCycle(primaryConditionID, nextEntries)) {
        setStatus('That benchmark would create a fallback loop.');
        return false;
    }
    if (!beginMutation()) {
        return false;
    }

    replaceFallbackRuleEntries(primaryConditionID, nextEntries);
    fallbackDraftPrimaryID = null;
    fallbackTargetPrimaryID = primaryConditionID;
    selectedFallbackPrimaryID = primaryConditionID;
    selectedFallbackComponentID = conditionID;
    setStatus('');
    renderPie();
    renderBenchmarks();
    scheduleSave();
    return true;
}

function removeSelectedFallbackComponent() {
    const primary = selectedInlineFallbackPrimary();
    const rule = primary ? fallbackRuleFor(primary.ID) : null;
    if (!primary || !rule || !isInlineFallbackTargetActive()) {
        return false;
    }
    const conditionID = Number(selectedFallbackComponentID);
    if (!rule.entries.some(entry => Number(entry.conditionID) === conditionID)) {
        return false;
    }
    if (!beginMutation()) {
        return false;
    }

    const remaining = rule.entries.filter(entry => Number(entry.conditionID) !== conditionID);
    const redistributed = distributeToTarget(
        remaining,
        state.limits.totalBasisPoints,
        MIN_WEIGHT_BASIS_POINTS
    );
    const primaryConditionID = Number(primary.ID);
    replaceFallbackRuleEntries(primaryConditionID, redistributed);
    fallbackDraftPrimaryID = redistributed.length === 0 ? primaryConditionID : null;
    fallbackTargetPrimaryID = primaryConditionID;
    selectedFallbackPrimaryID = primaryConditionID;
    selectedFallbackComponentID = redistributed[0]?.conditionID ?? null;
    renderPie();
    renderBenchmarks();
    scheduleSave();
    return true;
}
function addObjectToPersonalPie(object) {
    const existing = state.personalEntries.find(entry => Number(entry.conditionID) === Number(object.ID));
    if (existing) {
        state.selectedObjectID = existing.conditionID;
        return true;
    }
    if (!beginMutation()) {
        return false;
    }
    if (state.personalEntries.length >= state.limits.maxPieItems) {
        setStatus(`Personal Weights can contain up to ${state.limits.maxPieItems} benchmarks`);
        state.undoSnapshot = null;
        updateUndoState();
        return false;
    }
    const initialWeight = state.personalEntries.length === 0
        ? state.limits.totalBasisPoints
        : Math.min(
            500,
            state.limits.totalBasisPoints - (state.personalEntries.length * MIN_WEIGHT_BASIS_POINTS)
        );
    const existingEntries = distributeToTarget(
        state.personalEntries,
        state.limits.totalBasisPoints - initialWeight
    );
    const newEntry = {
        conditionID: Number(object.ID),
        benchmarkID: Number(object.benchmarkID),
        name: object.name,
        conditionKey: object.conditionKey,
        conditionName: object.conditionName,
        isDefaultCondition: Boolean(object.isDefaultCondition),
        type: object.type,
        weightBasisPoints: initialWeight,
        weight: initialWeight / 100
    };
    state.personalEntries = [...existingEntries, newEntry];
    registerPieEntries([newEntry]);
    state.selectedObjectID = newEntry.conditionID;
    scheduleSave();
    return true;
}

function removeObjectFromPersonalPie(object) {
    const objectID = Number(object.ID);
    if (!state.personalEntries.some(entry => Number(entry.conditionID) === objectID)) {
        return false;
    }
    if (!beginMutation()) {
        return false;
    }

    state.personalEntries = distributeToTarget(
        state.personalEntries.filter(entry => Number(entry.conditionID) !== objectID),
        state.limits.totalBasisPoints
    );
    state.personalFallbackRules = state.personalFallbackRules.filter(rule => (
        Number(rule.primaryConditionID) !== objectID
    ));
    if (state.mode === 'personal' && Number(state.selectedObjectID) === objectID) {
        deactivateInlineFallbackTarget({ discardDraft: true });
        state.selectedObjectID = state.personalEntries[0]?.conditionID ?? null;
        if (state.workspaceView === 'focus') {
            state.workspaceView = 'leaderboard';
        }
    }
    scheduleSave();
    return true;
}

function renderBenchmarks() {
    benchmarkRows.replaceChildren();
    const personalControlsActive = state.mode === 'personal';
    const fallbackTargetActive = isInlineFallbackTargetActive();
    const fallbackPrimary = fallbackTargetActive ? selectedInlineFallbackPrimary() : null;
    const activeFallbackRule = fallbackPrimary ? fallbackRuleFor(fallbackPrimary.ID) : null;
    const activeFallbackConditionIDs = new Set((activeFallbackRule?.entries ?? []).map(entry => (
        Number(entry.conditionID)
    )));
    benchmarkCard?.classList.toggle('is-fallback-target-active', fallbackTargetActive);
    const canPinPersonal = personalControlsActive
        && state.authenticated
        && state.personalEntries.length > 0;
    if (!canPinPersonal) {
        state.pinPersonalBenchmarks = false;
    }
    benchmarkPersonalPin.hidden = !canPinPersonal;
    benchmarkPersonalPin.disabled = !canPinPersonal;
    benchmarkPersonalPin.setAttribute('aria-pressed', String(state.pinPersonalBenchmarks));
    benchmarkPersonalPin.setAttribute(
        'aria-label',
        state.pinPersonalBenchmarks ? 'Stop pinning my benchmarks to the top' : 'Pin my benchmarks to the top'
    );
    benchmarkPersonalPin.title = canPinPersonal
        ? state.pinPersonalBenchmarks ? 'Restore public-weight order' : 'Pin my benchmarks to the top'
        : 'Add benchmarks to Personal Weights to use this';
    if (state.loading) {
        const loading = document.createElement('div');
        loading.className = 'bp-loading-state';
        loading.textContent = 'Loading benchmarks…';
        benchmarkRows.append(loading);
        return;
    }
    const query = benchmarkSearch.value.trim().toLowerCase();
    const personalWeightsByID = new Map(state.personalEntries.map(entry => [
        Number(entry.conditionID),
        Number(entry.weight)
    ]));
    const personalWeightFor = object => personalWeightsByID.has(Number(object.ID))
        ? personalWeightsByID.get(Number(object.ID))
        : object.personalWeight;
    const objects = state.benchmarks.filter(object => (
        !query
        || object.name.toLowerCase().includes(query)
        || benchmarkConditionLabel(object).toLowerCase().includes(query)
        || object.tags?.some(tag => tag.toLowerCase().includes(query))
    )).sort((left, right) => {
        const leftIsPinned = state.pinPersonalBenchmarks && personalWeightsByID.has(Number(left.ID));
        const rightIsPinned = state.pinPersonalBenchmarks && personalWeightsByID.has(Number(right.ID));
        if (leftIsPinned !== rightIsPinned) {
            return rightIsPinned - leftIsPinned;
        }
        if (leftIsPinned && rightIsPinned) {
            const personalDifference = personalWeightFor(right) - personalWeightFor(left);
            if (personalDifference !== 0) {
                return personalDifference;
            }
        }
        const publicDifference = Number(right.publicWeight) - Number(left.publicWeight);
        if (publicDifference !== 0) {
            return publicDifference;
        }
        return Number(left.rank) - Number(right.rank)
            || left.name.localeCompare(right.name)
            || benchmarkConditionLabel(left).localeCompare(benchmarkConditionLabel(right));
    });
    if (objects.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'bp-empty-state';
        empty.textContent = 'No benchmarks found';
        benchmarkRows.append(empty);
        return;
    }

    const hasPinnedObjects = state.pinPersonalBenchmarks
        && objects.some(object => personalWeightsByID.has(Number(object.ID)));
    let encounteredUnpinnedRow = false;
    objects.forEach(object => {
        const inPersonalPie = state.personalEntries.some(entry => Number(entry.conditionID) === Number(object.ID));
        const pinned = state.pinPersonalBenchmarks && inPersonalPie;
        const row = document.createElement('div');
        row.className = 'bp-benchmark-row';
        const selected = Number(state.selectedObjectID) === Number(object.ID);
        row.classList.toggle('selected', selected);
        row.classList.toggle('in-personal-pie', inPersonalPie);
        row.classList.toggle('is-personal-pinned', pinned);
        row.classList.toggle('in-fallback-mix', activeFallbackConditionIDs.has(Number(object.ID)));
        row.classList.toggle('is-fallback-primary', Number(fallbackPrimary?.ID) === Number(object.ID));
        if (hasPinnedObjects && !pinned && !encounteredUnpinnedRow) {
            row.classList.add('after-personal-pinned');
            encounteredUnpinnedRow = true;
        }
        row.classList.toggle('is-muted', state.workspaceView === 'focus' && state.mode === 'personal' && !selected);
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        const accessibleName = benchmarkAccessibleName(object);
        const focusedName = selected
            ? accessibleName
            : benchmarkAccessibleName(selectedBenchmark()) || 'the selected benchmark';
        const exitsPersonalFocus = state.workspaceView === 'focus' && state.mode === 'personal';
        row.setAttribute('aria-label', fallbackTargetActive
            ? activeFallbackConditionIDs.has(Number(object.ID))
                ? `Select ${accessibleName} in Fallback`
                : Number(fallbackPrimary?.ID) === Number(object.ID)
                    ? `${accessibleName} cannot be its own Fallback`
                    : `Add ${accessibleName} to Fallback`
            : exitsPersonalFocus
                ? `Exit weight adjustment for ${focusedName}`
                : state.mode === 'personal' && !inPersonalPie
                    ? `Add ${accessibleName} to Personal Weights and focus it`
                    : `${selected && state.workspaceView === 'focus' ? 'Close focus for' : 'Focus'} ${accessibleName}`);

        const rank = document.createElement('span');
        rank.className = 'bp-benchmark-rank';
        rank.textContent = String(object.rank);

        const identity = document.createElement('span');
        identity.className = 'bp-benchmark-identity';
        const name = document.createElement('span');
        name.className = 'bp-benchmark-name';
        name.textContent = object.name;
        identity.append(name);
        const conditionLabel = benchmarkConditionLabel(object);
        if (conditionLabel) {
            const condition = document.createElement('span');
            condition.className = 'bp-benchmark-condition';
            condition.textContent = conditionLabel;
            identity.append(condition);
        }
        identity.title = accessibleName;

        const publicValue = document.createElement('span');
        publicValue.className = 'bp-benchmark-weight';
        publicValue.textContent = `${Number(object.publicWeight).toFixed(2)}%`;

        const personalWeight = personalWeightFor(object);
        const personalValue = document.createElement('span');
        personalValue.className = 'bp-benchmark-weight';
        const personalWeightText = personalWeight === null ? '—' : `${Math.round(Number(personalWeight))}%`;
        personalValue.textContent = personalWeightText;
        if (personalControlsActive && inPersonalPie && fallbackRuleFor(object.ID)) {
            personalValue.classList.add('has-fallback');
            personalValue.title = `${accessibleName} has a Fallback`;
            const value = document.createElement('span');
            value.textContent = personalWeightText;
            const icon = document.createElement('i');
            icon.className = 'fa-solid fa-code-branch';
            icon.setAttribute('aria-hidden', 'true');
            personalValue.replaceChildren();
            personalValue.append(value, icon);
        }

        const actionCell = document.createElement('span');
        actionCell.className = 'bp-benchmark-action-cell';
        const discussion = document.createElement('a');
        discussion.className = 'bp-row-edit-action bp-benchmark-discuss';
        discussion.href = categoryDiscussionURL(state.categoryID, state.selectedContextValues, object.benchmarkID);
        discussion.title = 'Discuss benchmark';
        discussion.setAttribute('aria-label', `Discuss ${accessibleName}`);
        discussion.innerHTML = '<i class="fa-regular fa-comment" aria-hidden="true"></i>';
        discussion.addEventListener('click', event => event.stopPropagation());
        actionCell.append(discussion);
        if (state.authenticated) {
            const edit = document.createElement('a');
            edit.className = 'bp-row-edit-action bp-benchmark-edit';
            edit.href = buildBenchmarkEditURL(object);
            edit.title = 'Change benchmark';
            edit.setAttribute('aria-label', `Change ${accessibleName}`);
            edit.innerHTML = '<i class="fa-solid fa-pencil" aria-hidden="true"></i>';
            edit.addEventListener('click', event => event.stopPropagation());
            actionCell.append(edit);

            if (personalControlsActive && inPersonalPie) {
                actionCell.classList.add('has-personal-remove');
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'bp-personal-weight-remove';
                remove.title = 'Remove from Personal Weights';
                remove.setAttribute('aria-label', `Remove ${accessibleName} from Personal Weights`);
                remove.innerHTML = '<i class="fa-regular fa-trash-can" aria-hidden="true"></i>';
                remove.addEventListener('click', event => {
                    event.stopPropagation();
                    if (!removeObjectFromPersonalPie(object)) {
                        return;
                    }
                    renderAll();
                });
                actionCell.append(remove);
            }
        }

        const activate = event => {
            if (event.target.closest('a, button')) {
                return;
            }
            if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') {
                return;
            }
            if (event.type === 'keydown') {
                event.preventDefault();
            }
            if (fallbackTargetActive) {
                addObjectToFallbackMix(object);
                return;
            }
            deactivateInlineFallbackTarget({ discardDraft: true });
            if (state.workspaceView === 'focus' && state.mode === 'personal') {
                setWorkspaceView('leaderboard');
                return;
            }
            if (state.workspaceView === 'focus' && selected) {
                setWorkspaceView('leaderboard');
                return;
            }
            if (state.mode === 'personal' && !addObjectToPersonalPie(object)) {
                return;
            }
            state.selectedObjectID = Number(object.ID);
            state.workspaceView = 'focus';
            applyWorkspaceView({ animate: true });
            renderModeState();
            renderPie();
            renderBenchmarks();
            renderBenchmarkSummary();
        };
        row.addEventListener('click', activate);
        row.addEventListener('keydown', activate);
        row.append(rank, identity, personalValue, publicValue, actionCell);
        benchmarkRows.append(row);
    });
}

function renderModeState() {
    const personal = state.mode === 'personal';
    const hasPersonalWeights = state.personalEntries.length > 0;
    const showCreatePersonal = !state.loading && !hasPersonalWeights && !personal;
    const showEmptyPersonal = !state.loading && !hasPersonalWeights && personal;
    modeSwitch.hidden = !hasPersonalWeights;
    personalPieCreate.hidden = !showCreatePersonal;
    personalEmptyMode.hidden = !showEmptyPersonal;
    pieCard.classList.toggle('has-personal-create-cta', showCreatePersonal);
    modeSwitch?.classList.toggle('is-public', !personal);
    personalModeButton.classList.toggle('selected', personal);
    publicModeButton.classList.toggle('selected', !personal);
    personalModeButton.setAttribute('aria-selected', String(personal));
    publicModeButton.setAttribute('aria-selected', String(!personal));
    if (personal && !state.authenticated) {
        pieInstruction.textContent = 'Sign in to create Personal Weights.';
        pieContextNote.textContent = '';
    } else if (personal) {
        const focusedName = state.workspaceView === 'focus'
            ? benchmarkAccessibleName(selectedBenchmark())
            : '';
        pieInstruction.textContent = focusedName
            ? window.matchMedia('(pointer: coarse)').matches
                ? `Swipe to adjust ${focusedName}.`
                : `Scroll to adjust ${focusedName}.`
            : state.personalEntries.length === 0
                ? 'Choose a benchmark on the right to begin.'
            : window.matchMedia('(pointer: coarse)').matches
                ? 'Tap a slice, then swipe to adjust.'
                : 'Select a slice, then scroll to adjust.';
        pieContextNote.textContent = state.personalEntries.length === 0 ? '' : 'This context only.';
    } else {
        pieInstruction.textContent = 'Select a slice to inspect.';
        if (state.publicEntries.length > 0) {
            const people = state.publicParticipantCount === 1 ? 'person' : 'people';
            pieContextNote.textContent = `Community average · ${state.publicParticipantCount} ${people}.`;
        } else {
            pieContextNote.textContent = 'No community weights yet.';
        }
    }
}

function setMode(mode) {
    if (fallbackWheelCommitTimer !== null) {
        void commitPendingFallbackWheelAdjustment();
    } else if (wheelWeightCommitTimer !== null) {
        void commitPendingWheelAdjustment();
    }
    if (state.gestureOpen) {
        void finishWeightGesture();
    }
    deactivateInlineFallbackTarget({ discardDraft: true });
    selectedPublicFallbackComponentID = null;
    state.mode = mode === 'public' ? 'public' : 'personal';
    writeWorkspacePreferences(state);
    const entries = currentPieEntries();
    if (!entries.some(entry => Number(entry.conditionID) === Number(state.selectedObjectID))) {
        state.selectedObjectID = entries[0]?.conditionID ?? null;
    }
    if (state.workspaceView === 'focus' && entries.length === 0) {
        state.workspaceView = 'leaderboard';
    }
    applyWorkspaceView({ animate: true });
    renderModeState();
    renderPie();
    renderBenchmarks();
    renderBenchmarkSummary();
    renderModels();
}

function renderAll() {
    updateLastUpdated();
    renderBreadcrumb();
    renderTemplateControls();
    renderModeState();
    renderPie();
    renderBenchmarks();
    renderBenchmarkSummary();
    renderModels();
    applyWorkspaceView();
    contributeDataButton.hidden = !state.authenticated;
    contributeEvaluationButton.hidden = !state.authenticated;
    const evaluationContributionURL = new URL('/contribute', window.location.origin);
    evaluationContributionURL.searchParams.set('mode', 'new_benchmark');
    evaluationContributionURL.searchParams.set('pageURL', window.location.href);
    contributeEvaluationButton.href = evaluationContributionURL.pathname + evaluationContributionURL.search;
    const contributionURL = new URL('/contribute', window.location.origin);
    contributionURL.searchParams.set('mode', 'benchmark_result');
    contributionURL.searchParams.set('categoryPath', state.categoryPath);
    contributionURL.searchParams.set('pageURL', window.location.href);
    contributeDataButton.href = contributionURL.pathname + contributionURL.search;
    updateUndoState();
    benchmarkCard?.setAttribute('aria-busy', String(state.loading));
    modelCard?.setAttribute('aria-busy', String(state.loading));
}

function applyServerWorkspace(payload, { preserveUndo = true } = {}) {
    const previousUndo = preserveUndo ? state.undoSnapshot : null;
    const nextContextFingerprint = workspaceContextFingerprint(
        payload.context.categoryID,
        payload.context.contextValues
    );
    const contextChanged = state.pieContextFingerprint !== nextContextFingerprint;
    if (contextChanged) {
        resetPieVisualState();
        state.pieContextFingerprint = nextContextFingerprint;
        state.workspaceView = 'overview';
    }
    state.authenticated = Boolean(payload.authenticated);
    state.categoryID = Number(payload.context.categoryID);
    state.categoryPath = String(payload.context.categoryPath || '');
    state.selectedContextValues = { ...payload.context.contextValues };
    updateDiscussionEntry(state.categoryID, state.selectedContextValues);
    state.dimensions = payload.context.dimensions.map(dimension => ({
        ...dimension,
        options: dimension.options.map(option => ({ ...option }))
    }));
    state.personalRevision = Number(payload.personalPie.revision);
    state.personalIsDraft = Boolean(payload.personalPie.isDraft);
    state.personalEntries = cloneEntries(payload.personalPie.entries);
    state.personalFallbackRules = cloneFallbackRules(payload.personalPie.fallbackRules);
    state.publicEntries = cloneEntries(payload.publicPie.entries);
    state.publicFallbackRules = cloneFallbackRules(payload.publicPie.fallbackRules);
    registerPieEntries(state.personalEntries);
    registerPieEntries(state.publicEntries);
    state.publicParticipantCount = Number(payload.publicPie.participantCount) || 0;
    state.publicIsFallback = Boolean(payload.publicPie.isFallback);
    state.benchmarks = payload.benchmarks.map(object => ({ ...object }));
    state.comparison = payload.comparison;
    renderComparisonControls(payload.comparison);
    const requestedComparison = state.comparisonRequest ?? { mode: 'best', keys: [] };
    if (payload.comparison.mode === requestedComparison.mode
        && JSON.stringify([...payload.comparison.keys].sort()) === JSON.stringify([...requestedComparison.keys].sort())) {
        state.comparisonPending = false;
    }
    state.modelLeaderboards = {
        personal: payload.modelLeaderboards.personal.map(model => ({ ...model })),
        public: payload.modelLeaderboards.public.map(model => ({ ...model }))
    };
    state.scoreScale = { ...payload.scoreScale };
    state.limits = { ...payload.limits };
    state.serverPersonalEntries = cloneEntries(state.personalEntries);
    state.serverPersonalFallbackRules = cloneFallbackRules(state.personalFallbackRules);
    state.lastLoadTime = Date.parse(payload.serverTime) || Date.now();
    state.statusMessage = '';
    state.undoSnapshot = previousUndo;
    const currentEntries = currentPieEntries();
    if (!currentEntries.some(entry => Number(entry.conditionID) === Number(state.selectedObjectID))) {
        state.selectedObjectID = currentEntries[0]?.conditionID ?? null;
    }
    syncContextValuesToURL();
}

function workspaceLoadErrorMessage(error) {
    if (error?.code === 'invalid_workspace_response') {
        return error.message;
    }
    if (error?.payload?.error === 'category_not_found') {
        return 'This category no longer exists';
    }
    if (error?.payload?.error === 'ranking_root_missing') {
        return 'No ranking root is configured';
    }
    if (!error?.status) {
        return 'Connection interrupted';
    }
    if (error.status >= 500) {
        return 'The ranking service is temporarily unavailable';
    }
    return 'Could not load this ranking context';
}

function renderLoadError(error) {
    state.loading = false;
    const message = workspaceLoadErrorMessage(error);
    benchmarkRows.replaceChildren();
    modelRows.replaceChildren();
    [benchmarkRows, modelRows].forEach(container => {
        const errorState = document.createElement('div');
        errorState.className = 'bp-error-state';
        const text = document.createElement('span');
        text.textContent = message;
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = 'Retry';
        retry.addEventListener('click', () => loadWeightedWorkspace());
        errorState.append(text, retry);
        container.append(errorState);
    });
    setStatus(message);
}

async function loadWeightedWorkspace({ resetTemplates = false, retryAttempt = 0, preserveUndo = false, comparisonChange = false } = {}) {
    const sequence = ++state.loadSequence;
    const adjustmentsSaved = await finishPendingWeightAdjustments();
    if (sequence !== state.loadSequence || (!adjustmentsSaved && !comparisonChange)) return;
    if (state.saving && state.savePromise) {
        await state.savePromise.catch(() => {});
    }
    if (sequence !== state.loadSequence) return;
    state.loading = true;
    state.statusMessage = 'Updating…';
    renderAll();
    const requestedContextValues = resetTemplates
        ? {}
        : { ...state.selectedContextValues };
    try {
        let payload = validateWorkspacePayload(await postJSON('/api/get_weighted_workspace', {
            categoryID: state.categoryID,
            contextValues: requestedContextValues,
            comparison: state.comparisonRequest
        }));
        if (!resetTemplates) {
            const URLContextValues = readRankingContext(window.location.search, payload.context.dimensions);
            const resolvedContextValues = {
                ...payload.context.contextValues,
                ...URLContextValues,
                ...state.selectedContextValues
            };
            if (!sameContextValues(resolvedContextValues, payload.context.contextValues)) {
                payload = validateWorkspacePayload(await postJSON('/api/get_weighted_workspace', {
                    categoryID: state.categoryID,
                    contextValues: resolvedContextValues,
                    comparison: state.comparisonRequest
                }));
            }
        }
        if (sequence !== state.loadSequence) {
            return;
        }
        state.loading = false;
        applyServerWorkspace(payload, { preserveUndo });
        renderAll();
        if (!adjustmentsSaved) setStatus('Your change was not saved');
    } catch (error) {
        if (sequence !== state.loadSequence) {
            return;
        }
        if (error.status === 400 && error.payload?.error === 'comparison_keys_unavailable') {
            renderComparisonControls(error.payload);
            // Refresh weights and the key catalog, but keep model results hidden until
            // the user explicitly resolves the unavailable comparison selection.
            await loadWeightedWorkspace({ resetTemplates, preserveUndo, comparisonChange });
            return;
        }
        const retryDelay = WORKSPACE_LOAD_RETRY_DELAYS_MS[retryAttempt];
        if (retryDelay !== undefined && (!error.status || error.status >= 500)) {
            state.loading = true;
            setStatus('Connection interrupted - retrying...');
            await new Promise(resolve => window.setTimeout(resolve, retryDelay));
            if (sequence === state.loadSequence) {
                    await loadWeightedWorkspace({ resetTemplates, retryAttempt: retryAttempt + 1, preserveUndo, comparisonChange });
            }
            return;
        }
        console.error('[BenchPoll] Workspace update failed', {
            status: error.status ?? null,
            error: error.payload?.error ?? error.message
        });
        renderLoadError(error);
    }
}

async function persistPersonalPie() {
    window.clearTimeout(state.saveTimer);
    state.saveTimer = null;
    if (!state.authenticated) {
        return false;
    }
    if (state.persistPromise) {
        return state.persistPromise;
    }
    const task = (async () => {
        const categoryID = state.categoryID;
        const contextValues = { ...state.selectedContextValues };
        const entries = state.personalEntries.map(entry => ({
            conditionID: Number(entry.conditionID),
            weightBasisPoints: Number(entry.weightBasisPoints)
        }));
        const fallbackRules = state.personalFallbackRules.map(rule => ({
            primaryConditionID: Number(rule.primaryConditionID),
            mode: FALLBACK_RULE_MODE,
            entries: rule.entries.map(entry => ({
                conditionID: Number(entry.conditionID),
                weightBasisPoints: Number(entry.weightBasisPoints)
            }))
        }));
        const expectedRevision = state.personalRevision;
        const contextFingerprint = workspaceContextFingerprint(categoryID, contextValues);
        let reloadAfterConflict = false;
        let reloadAfterComparisonError = false;
        let saved = false;
        state.saving = true;
        setStatus('Saving your pie…');
        updateUndoState();
        renderInlineFallback();
        state.savePromise = postJSON('/api/save_personal_pie', {
            categoryID,
            contextValues,
            expectedRevision,
            entries,
            fallbackRules,
            comparison: state.comparisonRequest
        });
        try {
            const payload = validateWorkspacePayload(await state.savePromise);
            const currentFingerprint = workspaceContextFingerprint();
            if (contextFingerprint === currentFingerprint) {
                applyServerWorkspace(payload, { preserveUndo: true });
                state.personalIsDraft = false;
                setStatus('Saved');
                window.setTimeout(() => {
                    if (state.statusMessage === 'Saved') {
                        setStatus('');
                    }
                }, 1200);
                renderAll();
            }
            saved = true;
        } catch (error) {
            if (error.status === 401) {
                requestLogin();
            }
            state.personalEntries = cloneEntries(state.serverPersonalEntries);
            state.personalFallbackRules = cloneFallbackRules(state.serverPersonalFallbackRules);
            state.undoSnapshot = null;
            if (error.status === 400 && error.payload?.error === 'comparison_keys_unavailable') {
                renderComparisonControls(error.payload);
                reloadAfterComparisonError = true;
            }
            if (error.status === 409 && error.payload?.error === 'pie_revision_conflict') {
                reloadAfterConflict = true;
            } else {
                setStatus('Your change was not saved');
                renderAll();
            }
        } finally {
            state.saving = false;
            state.savePromise = null;
            updateUndoState();
            renderInlineFallback();
        }
        if (reloadAfterConflict || reloadAfterComparisonError) {
            await loadWeightedWorkspace();
            if (reloadAfterComparisonError) setStatus('Your change was not saved');
        }
        return saved;
    })();
    state.persistPromise = task;
    try {
        return await task;
    } finally {
        if (state.persistPromise === task) {
            state.persistPromise = null;
        }
    }
}

async function applyWorkspaceState(detail = {}) {
    if (!await finishPendingWeightAdjustments()) return;
    if (state.saving && state.savePromise) {
        await state.savePromise.catch(() => {});
    }
    if (!await flushPendingPersonalPieSave()) {
        return;
    }
    const nextCategoryID = detail.currentCategoryID ?? null;
    const nextCategoryPath = String(detail.categoryPath || '');
    const changed = Number(nextCategoryID) !== Number(state.categoryID)
        || (nextCategoryID === null && state.categoryID !== null)
        || nextCategoryPath !== state.categoryPath;
    state.categoryID = nextCategoryID;
    state.categoryPath = nextCategoryPath;
    if (changed) {
        state.selectedContextValues = {};
        state.dimensions = [];
        state.workspaceView = 'overview';
    }
    if (changed || state.benchmarks.length === 0) {
        await loadWeightedWorkspace();
    }
}

personalModeButton.addEventListener('click', () => setMode('personal'));
publicModeButton.addEventListener('click', () => setMode('public'));
personalPieCreate.addEventListener('click', () => {
    if (!state.authenticated) {
        requestLogin();
        return;
    }
    setMode('personal');
});
personalEmptyPublicReturn.addEventListener('click', () => setMode('public'));

function isPersonalBenchmarkFocus() {
    return state.workspaceView === 'focus' && state.mode === 'personal';
}

function queueSelectedWeightWheel(event) {
    if (state.mode !== 'personal') {
        return;
    }
    if (fallbackWheelCommitTimer !== null) {
        void commitPendingFallbackWheelAdjustment();
        return;
    }
    event.preventDefault();
    if (!state.authenticated) {
        requestLogin();
        return;
    }
    if (state.loading || state.saving || selectedObjectIndex(state.personalEntries) < 0) {
        return;
    }
    if (event.deltaY === 0) {
        return;
    }
    pendingWheelBasisPoints += event.deltaY < 0
        ? WEIGHT_STEP_BASIS_POINTS
        : -WEIGHT_STEP_BASIS_POINTS;
    setPieAdjustmentActive(true);
    scheduleWheelPreview();
    window.clearTimeout(wheelWeightCommitTimer);
    wheelWeightCommitTimer = window.setTimeout(() => {
        void commitPendingWheelAdjustment();
    }, WHEEL_WEIGHT_COMMIT_IDLE_MS);
    updateUndoState();
}

function queueSelectedFallbackWeightWheel(event) {
    const primary = selectedInlineFallbackPrimary();
    const rule = primary ? fallbackRuleFor(primary.ID) : null;
    if (!rule || !isInlineFallbackTargetActive() || rule.entries.length < 2 || event.deltaY === 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (wheelWeightCommitTimer !== null) {
        void commitPendingWheelAdjustment();
        return;
    }
    if (state.loading || state.saving || !state.authenticated) return;
    const wheelSteps = Math.max(1, Math.min(4, Math.round(Math.abs(event.deltaY) / 100)));
    pendingFallbackWheelBasisPoints += (event.deltaY < 0 ? 1 : -1)
        * MIN_WEIGHT_BASIS_POINTS
        * wheelSteps;
    setFallbackAdjustmentActive(true);
    scheduleFallbackWheelPreview();
    window.clearTimeout(fallbackWheelCommitTimer);
    fallbackWheelCommitTimer = window.setTimeout(() => {
        void commitPendingFallbackWheelAdjustment();
    }, WHEEL_WEIGHT_COMMIT_IDLE_MS);
    updateUndoState();
}

document.addEventListener('wheel', event => {
    if (!isPersonalBenchmarkFocus()) {
        return;
    }
    if (!(event.target instanceof Element)
        || event.target.closest('.bp-inline-fallback')
        || !event.target.closest('.bp-left-workspace')) {
        return;
    }
    queueSelectedWeightWheel(event);
}, { passive: false, capture: true });

pieSvg.addEventListener('wheel', event => {
    if (isPersonalBenchmarkFocus()) {
        return;
    }
    queueSelectedWeightWheel(event);
}, { passive: false });

inlineFallbackChart.addEventListener('wheel', queueSelectedFallbackWeightWheel, { passive: false });

pieSvg.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') {
        return;
    }
    const slice = event.target.closest('[data-object-id]');
    if (state.mode !== 'personal') {
        return;
    }
    if (fallbackWheelCommitTimer !== null) {
        void commitPendingFallbackWheelAdjustment();
        return;
    }
    if (wheelWeightCommitTimer !== null) {
        void commitPendingWheelAdjustment();
        return;
    }
    if (selectedObjectIndex(state.personalEntries) < 0) {
        return;
    }
    touchPieGesture = {
        pointerID: event.pointerId,
        startY: event.clientY,
        lastY: event.clientY,
        candidateObjectID: slice ? Number(slice.dataset.objectId) : null,
        adjusted: false,
        pendingBasisPoints: 0,
        previewFrame: null
    };
    pieSvg.setPointerCapture(event.pointerId);
});

const flushTouchPiePreview = gesture => {
    if (gesture.previewFrame !== null) {
        cancelAnimationFrame(gesture.previewFrame);
        gesture.previewFrame = null;
    }
    const deltaBasisPoints = Math.round(gesture.pendingBasisPoints);
    gesture.pendingBasisPoints = 0;
    if (deltaBasisPoints !== 0) {
        adjustSelectedWeight(deltaBasisPoints, { animateWeights: false });
    }
};

pieSvg.addEventListener('pointermove', event => {
    if (!touchPieGesture || touchPieGesture.pointerID !== event.pointerId) {
        return;
    }
    const deltaY = touchPieGesture.lastY - event.clientY;
    touchPieGesture.lastY = event.clientY;
    if (!touchPieGesture.adjusted
        && Math.abs(event.clientY - touchPieGesture.startY) < TOUCH_DRAG_THRESHOLD_PX) {
        return;
    }
    event.preventDefault();
    touchPieGesture.adjusted = true;
    setPieAdjustmentActive(true);
    touchPieGesture.pendingBasisPoints += deltaY * TOUCH_WEIGHT_BASIS_POINTS_PER_PIXEL;
    if (touchPieGesture.previewFrame === null) {
        const gesture = touchPieGesture;
        gesture.previewFrame = requestAnimationFrame(() => flushTouchPiePreview(gesture));
    }
});

const endTouchPieGesture = (event, cancelled = false) => {
    if (!touchPieGesture || touchPieGesture.pointerID !== event.pointerId) {
        return;
    }
    const completedGesture = touchPieGesture;
    if (!cancelled) {
        flushTouchPiePreview(completedGesture);
    } else if (completedGesture.previewFrame !== null) {
        cancelAnimationFrame(completedGesture.previewFrame);
        completedGesture.previewFrame = null;
    }
    if (pieSvg.hasPointerCapture(event.pointerId)) {
        pieSvg.releasePointerCapture(event.pointerId);
    }
    touchPieGesture = null;
    setPieAdjustmentActive(false);
    if (!cancelled && !completedGesture.adjusted && completedGesture.candidateObjectID !== null) {
        deactivateInlineFallbackTarget({ discardDraft: true });
        state.selectedObjectID = completedGesture.candidateObjectID;
        renderPie();
        renderBenchmarks();
        renderBenchmarkSummary();
        return;
    }
    if (cancelled && state.gestureOpen) {
        restorePersonalPieSnapshot(state.gestureSnapshot ?? snapshotPersonalPie());
        state.gestureOpen = false;
        state.gestureSnapshot = null;
        renderPie();
        renderBenchmarkSummary();
        updateUndoState();
        return;
    }
    if (completedGesture.adjusted && state.gestureOpen) {
        renderBenchmarks();
        void finishWeightGesture();
    }
};
pieSvg.addEventListener('pointerup', endTouchPieGesture);
pieSvg.addEventListener('pointercancel', event => endTouchPieGesture(event, true));

inlineFallbackChart.addEventListener('pointerdown', event => {
    const segment = event.target instanceof Element
        ? event.target.closest('.bp-inline-fallback-segment')
        : null;
    if (segment) {
        activateInlineFallbackTarget(Number(segment.dataset.conditionId));
    } else if (event.pointerType === 'touch' || event.pointerType === 'pen') {
        activateInlineFallbackTarget();
    }
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    const primary = selectedInlineFallbackPrimary();
    const rule = primary ? fallbackRuleFor(primary.ID) : null;
    if (!rule || rule.entries.length < 2 || wheelWeightCommitTimer !== null) return;
    touchFallbackGesture = {
        pointerID: event.pointerId,
        startY: event.clientY,
        lastY: event.clientY,
        adjusted: false,
        pendingBasisPoints: 0,
        previewFrame: null
    };
    inlineFallbackChart.setPointerCapture(event.pointerId);
});

const flushTouchFallbackPreview = gesture => {
    if (gesture.previewFrame !== null) {
        cancelAnimationFrame(gesture.previewFrame);
        gesture.previewFrame = null;
    }
    const deltaBasisPoints = Math.round(gesture.pendingBasisPoints);
    gesture.pendingBasisPoints = 0;
    if (deltaBasisPoints !== 0) {
        adjustSelectedFallbackWeight(deltaBasisPoints);
    }
};

inlineFallbackChart.addEventListener('pointermove', event => {
    if (!touchFallbackGesture || touchFallbackGesture.pointerID !== event.pointerId) return;
    const deltaY = touchFallbackGesture.lastY - event.clientY;
    touchFallbackGesture.lastY = event.clientY;
    if (!touchFallbackGesture.adjusted
        && Math.abs(event.clientY - touchFallbackGesture.startY) < TOUCH_DRAG_THRESHOLD_PX) {
        return;
    }
    event.preventDefault();
    touchFallbackGesture.adjusted = true;
    setFallbackAdjustmentActive(true);
    touchFallbackGesture.pendingBasisPoints += deltaY * TOUCH_WEIGHT_BASIS_POINTS_PER_PIXEL;
    if (touchFallbackGesture.previewFrame === null) {
        const gesture = touchFallbackGesture;
        gesture.previewFrame = requestAnimationFrame(() => flushTouchFallbackPreview(gesture));
    }
});

const endTouchFallbackGesture = (event, cancelled = false) => {
    if (!touchFallbackGesture || touchFallbackGesture.pointerID !== event.pointerId) return;
    const completedGesture = touchFallbackGesture;
    if (!cancelled) {
        flushTouchFallbackPreview(completedGesture);
    } else if (completedGesture.previewFrame !== null) {
        cancelAnimationFrame(completedGesture.previewFrame);
        completedGesture.previewFrame = null;
    }
    if (inlineFallbackChart.hasPointerCapture(event.pointerId)) {
        inlineFallbackChart.releasePointerCapture(event.pointerId);
    }
    touchFallbackGesture = null;
    setFallbackAdjustmentActive(false);
    if (cancelled && state.gestureOpen) {
        restorePersonalPieSnapshot(state.gestureSnapshot ?? snapshotPersonalPie());
        state.gestureOpen = false;
        state.gestureSnapshot = null;
        renderInlineFallback();
        updateUndoState();
        return;
    }
    if (completedGesture.adjusted && state.gestureOpen) {
        void finishWeightGesture();
    }
};
inlineFallbackChart.addEventListener('pointerup', endTouchFallbackGesture);
inlineFallbackChart.addEventListener('pointercancel', event => endTouchFallbackGesture(event, true));

undoButton.addEventListener('click', () => {
    if (!state.undoSnapshot
        || state.saving
        || state.gestureOpen
        || wheelWeightCommitTimer !== null
        || fallbackWheelCommitTimer !== null
        || !state.authenticated) {
        return;
    }
    window.clearTimeout(state.saveTimer);
    state.saveTimer = null;
    const current = snapshotPersonalPie();
    restorePersonalPieSnapshot(state.undoSnapshot);
    state.undoSnapshot = current;
    if (!state.personalEntries.some(entry => Number(entry.conditionID) === Number(state.selectedObjectID))) {
        state.selectedObjectID = state.personalEntries[0]?.conditionID ?? null;
    }
    renderAll();
    void persistPersonalPie();
});

benchmarkSearch.addEventListener('input', renderBenchmarks);

benchmarkPersonalPin.addEventListener('click', () => {
    if (benchmarkPersonalPin.disabled) {
        return;
    }
    state.pinPersonalBenchmarks = !state.pinPersonalBenchmarks;
    renderBenchmarks();
});

inlineFallbackEnabled.addEventListener('change', () => {
    const primary = selectedInlineFallbackPrimary();
    const rule = primary ? fallbackRuleFor(primary.ID) : null;
    if (!primary) {
        renderInlineFallback();
        return;
    }
    if (inlineFallbackEnabled.checked && !rule) {
        fallbackDraftPrimaryID = Number(primary.ID);
        deactivateInlineFallbackTarget();
        renderInlineFallback();
        renderBenchmarks();
        return;
    }
    if (!inlineFallbackEnabled.checked) {
        void removeInlineFallbackRule();
        return;
    }
    renderInlineFallback();
});
publicFallbackToggle.addEventListener('click', () => {
    if (state.mode !== 'public' || state.loading || state.saving || !selectedPublicFallbackPrimary()) return;
    state.publicFallbackVisible = !state.publicFallbackVisible;
    writeWorkspacePreferences(state);
    selectedPublicFallbackComponentID = null;
    renderInlineFallback();
});
inlineFallbackRemove.addEventListener('click', () => {
    removeSelectedFallbackComponent();
});
inlineFallbackChart.addEventListener('click', event => {
    if (state.mode !== 'personal') {
        return;
    }
    if (event.target instanceof Element && event.target.closest('.bp-inline-fallback-segment')) {
        return;
    }
    activateInlineFallbackTarget();
});
inlineFallbackChart.addEventListener('keydown', event => {
    if (event.target !== inlineFallbackChart || state.mode !== 'personal') return;
    if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activateInlineFallbackTarget();
    } else if (event.key === 'Escape' && isInlineFallbackTargetActive()) {
        event.preventDefault();
        deactivateInlineFallbackTarget();
        renderInlineFallback();
        renderBenchmarks();
    }
});

benchmarkLeaderboardOpen.addEventListener('click', () => setWorkspaceView('leaderboard'));
benchmarkLeaderboardClose.addEventListener('click', () => setWorkspaceView('overview'));

refreshButton.addEventListener('click', async () => {
    if (!await flushPendingPersonalPieSave()) {
        return;
    }
    await loadWeightedWorkspace();
});

workspaceChannel.beforeChange(async () => {
    if (!await finishPendingWeightAdjustments()) return false;
    return flushPendingPersonalPieSave();
});

termsButton.addEventListener('click', () => {
    termsDialog.hidden = false;
});

workspaceChannel.subscribe(detail => {
    void applyWorkspaceState(detail);
});
