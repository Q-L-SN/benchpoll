import { setLoading } from './shared/loading.js';
import { navigationChannel } from './shared/navigation-channel.js';
import { createBasicComparisonControls as createComparisonControls } from './workspace/basic-comparison-controls.js';
import { setHelpText } from './shared/help-popover.js?v=help-popovers-20261008';
import { workspaceChannel } from './shared/workspace-channel.js';
import { readRankingContext, rankingContextURL } from './shared/ranking-url.js?v=short-20260908';
import { categoryDiscussionURL, createDiscussionEntry } from './workspace/discussion-entry.js?v=arena-workspace-20261003';
const updateDiscussionEntry = createDiscussionEntry(document.getElementById('discussion-entry'));
import { initializeMobilePanels } from './shared/mobile-panels.js';
import {
    SAVE_DEBOUNCE_MS, WEIGHT_STEP_BASIS_POINTS,
    MIN_WEIGHT_BASIS_POINTS, WHEEL_WEIGHT_COMMIT_IDLE_MS, TOUCH_DRAG_THRESHOLD_PX,
    TOUCH_WEIGHT_BASIS_POINTS_PER_PIXEL, WORKSPACE_LOAD_RETRY_DELAYS_MS, FALLBACK_RULE_MODE
} from './workspace/constants.js';
import { createWorkspaceState } from './workspace/state.js?v=fallback-controls-20261009';
import { readWorkspacePreferences, writeWorkspacePreferences, readEstimationPreference, writeEstimationPreference } from './workspace/preferences.js?v=fallback-controls-20261009';
import { estimationRequest, normalizeEstimationAlgorithm } from './shared/estimation-algorithms.js';
import { createEstimationControl } from './workspace/estimation-control.js';
import { validateWorkspacePayload, validateRankingPagePayload } from './workspace/contracts.js?v=review-evidence-20261008';
import {
    cloneEntries, cloneFallbackRules, clonePersonalPieSnapshot,
    clamp,
    benchmarkAccessibleName, distributeToTarget
} from './workspace/weights.js';
import { postJSON, postWriteJSON } from './shared/http.js';
import { validatePersonalPieSave } from './workspace/pie-save.js';
import { accountWriteError, isAccountWriteError, canonicalAccountID, pageAccountWriteScope } from './shared/account-identity.js';
import { createModelScoresView } from './workspace/model-scores.js?v=help-popovers-20261008';
import { createModelListView } from './workspace/model-list.js?v=workspace-ui-20261008';
import { createPieRenderer } from './workspace/pie-renderer.js?v=lightweight-chains-20261007';
import { updateTopicSearchMetadata } from './shared/search-metadata.js';
import { createGuestDraftStore } from './workspace/guest-drafts.js?v=review-drafts-20261008';
import { createPersonalPieRecovery } from './workspace/pie-recovery.js';
import { familyKey, portableFamilyEntry, familyEntryKey, FALLBACK_CONFIGURATION_VERSION } from './shared/benchmark-families.js';
import { createFamilyView } from './workspace/family-view.js?v=percentile-ranking-20261007';
import { createBenchmarkRowFocus } from './workspace/benchmark-family-row.js?v=fallback-picker-20261008';
import { createBenchmarkFallbackCatalogue } from './workspace/benchmark-fallback-catalogue.js?v=fallback-picker-20261008';
import { createFallbackPicker } from './workspace/fallback-picker.js?v=fallback-controls-20261009';
import { createBenchmarkSettings } from './workspace/benchmark-settings.js';
import { createPersonalPieStart, publicWeightStart } from './workspace/personal-pie-start.js';
import { fallbackStatusLabel } from './shared/fallback-choice.js';
import { initializeFallbackAppearance } from './workspace/fallback-appearance.js?v=fallback-appearance-20261014';
import { createBenchmarkInformationLink } from './workspace/benchmark-link.js';
import { contributionEditURL } from './workspace/links.js';
import { createAction, mountSegmentedControl } from './shared/ui-components.js';
import { createEvidenceCount, updateEvidenceCount } from './shared/evidence-count.js';
import { bulkImportTemplate } from './shared/feedback-templates.js';
import { comparisonProfileKey } from './shared/comparison-profile-key.js';
import { animateContent, setVisible, flipPie } from './shared/motion.js?v=workspace-ui-20261008';
import { createSceneControls } from './workspace/scenes.js';
import { createPrivateTopicEditor } from './shared/private-topic-editor.js';
import { renderTopicReferences, isTopicReference, topicReferenceError } from './workspace/topic-references.js';
import { createReferenceCoverage } from './workspace/reference-coverage.js';
import { topicLabelText, renderTopicLabel } from './shared/topic-label.js';
import { BENCHMARK_GROUPS, benchmarkConditionGroup } from './shared/benchmark-condition-groups.js?v=fallback-discovery-20261005';
import { captureRankingResume } from './shared/ranking-resume.js';
import { createToast } from './shared/toast.js';
import { createTopicCreator } from './shared/topic-identity.js';
import { AVAILABLE_INFERENCE_VERSION } from './shared/available-score.js';
import { readHomeModelFocusIntent, consumeHomeModelFocusURL, withHomeFocusComparison,
    createHomeModelFocus, createModelFocusNotice } from './workspace/model-focus.js';
import { createModelSearch } from './shared/model-search.js';
import { normalizeModelFocusTarget } from './workspace/model-focus-target.js';
import { excludedFromRanking } from './shared/aa-ranking-policy.js';
import { mountSiteActions } from './shared/site-header.js';
import { createUpdateIndicator } from './shared/update-indicator.js';
import { mountDisclosureChevron } from './shared/disclosure-chevron.js';

mountSiteActions(document.getElementById('config-site-links'), { accountID: 'config-site-account', moreID: 'config-site-more',
    minimal: true, extraActions: [document.getElementById('taxonomy-toggle')] });

const pieSvg = document.getElementById('weight-pie');
const pieHoverTooltip = document.getElementById('pie-hover-tooltip');
const breadcrumb = document.getElementById('bp-breadcrumb');
const templateStrip = document.getElementById('bp-template-strip');
const benchmarkRows = document.getElementById('benchmark-rows');
const benchmarkSearch = document.getElementById('benchmark-search');
const benchmarkPersonalPin = document.getElementById('benchmark-personal-pin');
const modelRows = document.getElementById('model-rows');
const scoreModeButtons = [...document.querySelectorAll('[data-score-mode]')];
const scoringSwitch = document.querySelector('.bp-scoring-switch');
const modeSwitch = document.querySelector('.bp-mode-switch');
const workspaceHeadline = document.getElementById('workspace-headline');
const headlineVariants = [...workspaceHeadline.querySelectorAll('[data-headline-mode]')];
const personalModeButton = document.getElementById('pie-mode-personal');
const publicModeButton = document.getElementById('pie-mode-public');
const personalPieCreate = document.getElementById('personal-pie-create');
const personalPieEmpty = document.getElementById('personal-pie-empty');
const compactPieMessage = document.getElementById('pie-empty-compact-message');
const compactPieAction = document.getElementById('pie-empty-compact-action');
const personalPieFindBenchmarks = document.getElementById('personal-pie-find-benchmarks');
const guestDraftNotice = document.getElementById('guest-draft-notice');
const guestDraftMessage = document.getElementById('guest-draft-message');
const guestDraftSave = document.getElementById('guest-draft-save');
const guestDraftDiscard = document.getElementById('guest-draft-discard');
const pieInstruction = document.getElementById('pie-instruction');
const pieContextNote = document.getElementById('pie-context-note');
const pieModelCount = createEvidenceCount(0, { kind: 'models' });
const pieAdjustmentStatus = document.getElementById('pie-adjustment-status');
const pieAdjustmentDismiss = document.getElementById('pie-adjustment-dismiss');
const pieAdjustmentName = document.getElementById('pie-adjustment-name');
const pieAdjustmentValue = document.getElementById('pie-adjustment-value');
const pieAdjustmentLabel = document.getElementById('pie-adjustment-label');
const pieAdjustmentInstruction = document.getElementById('pie-adjustment-instruction');
const personalPieGuidance = document.getElementById('personal-pie-guidance');
const publicPieSummary = document.getElementById('public-pie-summary');
const publicPieCount = document.getElementById('public-pie-count');
const undoButton = document.getElementById('workspace-undo');
const redoButton = document.getElementById('workspace-redo');
const resetButton = document.getElementById('workspace-reset');
const addFallbackBenchmarkButton = document.getElementById('inline-fallback-add-benchmark');
const refreshButton = document.getElementById('workspace-refresh');
const lastUpdated = document.getElementById('last-updated');
const loginButton = document.getElementById('login-button');
const contributeDataButton = document.getElementById('contribute-data-button');
const contributeEvaluationButton = document.getElementById('contribute-button');
const modelScoresDialog = document.getElementById('model-scores-dialog');
const modelScoresTitle = document.getElementById('model-scores-title');
const modelScoresSummary = document.getElementById('model-scores-summary');
const modelScoresList = document.getElementById('model-scores-list');
const benchmarkCard = document.getElementById('benchmark-card');
const modelCard = document.getElementById('model-card');
const modelIndexHeading = document.getElementById('model-leaderboard-heading');
const modelIndexTab = document.getElementById('model-index-tab');
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
const inlineFallbackToggle = document.getElementById('inline-fallback-toggle');
const inlineFallbackSettings = document.getElementById('inline-fallback-settings');
const inlineFallbackEditor = document.getElementById('inline-fallback-editor');
const inlineFallbackPreviewSequence = document.getElementById('inline-fallback-preview-sequence');
const inlineFallbackPreview = document.getElementById('inline-fallback-preview');
const inlineFallbackEdit = document.getElementById('inline-fallback-edit');
const inlineFallbackConfigurations = document.getElementById('inline-fallback-configurations');
const inlineFallbackDone = document.getElementById('inline-fallback-done');
const inlineFallbackConfigurationLabel = document.getElementById('inline-fallback-configuration-label');
const inlineFallbackEntrance = document.getElementById('inline-fallback-entrance');
const inlineFallbackSaveError = document.getElementById('inline-fallback-save-error');
const inlineFallbackSaveRetry = document.getElementById('inline-fallback-save-retry');
const publicFallbackToggle = document.getElementById('public-fallback-toggle');
const inlineFallbackGuide = document.getElementById('inline-fallback-guide');
const inlineFallbackChart = document.getElementById('inline-fallback-chart');

const state = createWorkspaceState();
const updateIndicator = createUpdateIndicator();
updateIndicator.element.id = 'workspace-update-indicator';
window.addEventListener('pagehide', () => updateIndicator.destroy(), { once: true });
const sceneControls = createSceneControls({ host: templateStrip, getState: () => state,
    beforeWrite: prepareContextChange,
    write: (path, body) => pageAccountWriteScope.write(postWriteJSON, path, body),
    onSelect: selectScene,
    async onChanged(id) {
        state.selectedContextValues = { scene: String(id) };
        await loadWeightedWorkspace({ preserveUndo: false });
    }
});
const privateTopicEditor = createPrivateTopicEditor({
    beforeOpen: prepareContextChange,
    async onSaved(topic) {
        const selected = topic.scenes.find(scene => scene.ID === state.sceneID) ?? topic.scenes.find(scene => scene.isDefault);
        window.location.assign(selected?.url ?? topic.url);
    },
    async onDeleted() { window.location.assign('/'); }
});
const referenceCoverage = createReferenceCoverage({
    request: (body, options) => postJSON('/api/get_topic_preview', body, options),
    getScope: () => String(state.userID ?? 'guest') });
const additionToast = createToast({ avoid: pieAdjustmentStatus });
const guestDrafts = createGuestDraftStore();
const pieRecovery = createPersonalPieRecovery({ state, guestDrafts, snapshot: portablePersonalPie });
const hiddenPersonalBenchmarkIDs = new Set();
const getBenchmarkMemberURL = member => categoryDiscussionURL(state.categoryID, state.selectedContextValues,
    member.benchmarkID, member.conditionID ?? member.ID);
const benchmarkRowFocus = createBenchmarkRowFocus();
const benchmarkFallbackCatalogue = createBenchmarkFallbackCatalogue({
    request: body => postJSON('/api/get_ranking_page', body),
    onChange: () => { renderBenchmarks(); fallbackPicker.refresh(); benchmarkSettings.refresh(); },
    onExpired: page => { void recoverRankingPages(page); }
});
const fallbackPickerOptions = { catalogue: benchmarkFallbackCatalogue,
    getScope: () => `${workspaceContextFingerprint()}|${state.mode}|${state.userID ?? 'guest'}`,
    getPrimary: ID => state.benchmarks.find(object => Number(object.ID) === Number(ID))
        ?? state.benchmarkDetailsByID.get(Number(ID)),
    getComposition: publicFallbackRuleFor, getCurrent: fallbackRuleFor,
    canApply: (ID, action) => state.mode === 'personal' && !state.loading && !state.gestureOpen
        && (action === 'replace'
            ? state.personalEntries.some(entry => Number(entry.conditionID) === Number(ID) && entry.followCommunityVersion !== true)
            : !state.personalEntries.some(entry => Number(entry.conditionID) === Number(ID))),
    onApply: applyFallbackConfiguration, onCustomize: primary => state.versionComposition
        ? benchmarkSettings.open(primary, { custom: true }) : beginInlineFallbackEditing(primary),
    getMemberURL: getBenchmarkMemberURL, onInspectVersion: onBenchmarkInspection
};
const fallbackPicker = createFallbackPicker(fallbackPickerOptions);
const benchmarkSettings = createBenchmarkSettings({
    fallbackPickerOptions,
    getScope: () => `${workspaceContextFingerprint()}|${state.userID ?? 'guest'}`,
    getData(benchmarkID) {
        const group = state.versionComposition?.find(item => item.benchmarkID === benchmarkID);
        if (!group) return null;
        const IDs = new Set(group.versions.map(version => version.conditionID));
        const entries = state.personalEntries.filter(entry => IDs.has(entry.conditionID));
        return { group, entries, isPrivate: state.contextIsPrivate, rule: entries.length === 1 ? fallbackRuleFor(entries[0].conditionID) : null,
            editable: state.mode === 'personal' && entries.length > 0 && !state.loading && !state.gestureOpen,
            busy: state.loading || state.gestureOpen,
            allVersions: state.versionComposition.flatMap(item => item.versions) };
    },
    onVersion: chooseBenchmarkVersion,
    async onContribute(group) {
        const scope = workspaceContextFingerprint();
        await setMode('personal');
        if (scope !== workspaceContextFingerprint() || state.mode !== 'personal') return;
        const primary = group.versions.find(version => version.conditionID === group.primaryConditionID);
        if (!state.personalEntries.some(entry => entry.benchmarkID === group.benchmarkID)) addObjectToPersonalPie(primary);
    },
    onCustom: (primary, entries) => applyFallbackConfiguration(primary,
        { community: entries === null, entries: entries ?? [], selectionSource: 'custom' }, 'replace')
});
initializeFallbackAppearance();
const personalPieStart = createPersonalPieStart({
    stage: pieSvg.closest('.bp-pie-stage'),
    getScope: () => `${workspaceContextFingerprint()}|${state.userID ?? 'guest'}|${state.personalRevision}|${state.personalEditVersion}`,
    getPublicStart: () => publicWeightStart(state.publicEntries, state.versionComposition, state.limits),
    isPrivate: () => state.contextIsPrivate,
    onApply: startPersonalPie,
    onChange: () => { renderModeState(); renderPie(); }
});
let personalStartContext = null;
let benchmarkSearchTimer = null;
let lowCoverageExpanded = false;
let otherConditionsExpanded = false;

function benchmarkPageKey(group) {
    return group === 'primary' ? 'benchmarks' : group === 'other' ? 'benchmarkOther' : 'benchmarkLow';
}

function currentBenchmarkGroup(condition) {
    if (state.rankingPagination?.benchmarkGrouping === 'flat') return 'primary';
    if (condition.isFamily) return 'primary';
    const personal = state.personalEntries.find(entry => Number(entry.conditionID) === Number(condition.conditionID));
    const publicEntry = state.publicEntries.find(entry => Number(entry.conditionID) === Number(condition.conditionID));
    return benchmarkConditionGroup({ ...condition,
        personalWeightBasisPoints: personal?.weightBasisPoints ?? 0,
        publicWeightBasisPoints: publicEntry?.weightBasisPoints ?? condition.publicWeightBasisPoints ?? Number(condition.publicWeight ?? 0) * 100,
        personalWeight: (personal?.weightBasisPoints ?? 0) / 100,
        publicWeight: publicEntry ? publicEntry.weightBasisPoints / 100 : condition.publicWeight ?? 0 });
}

function currentBenchmarkPages() {
    const pages = structuredClone(state.rankingPagination?.benchmarks);
    if (state.rankingPagination?.benchmarkGrouping === 'flat') return pages;
    // Reclassify optimistic edits while the server snapshot remains unchanged.
    for (const object of state.benchmarks) {
        const previous = benchmarkConditionGroup(object);
        const current = currentBenchmarkGroup(object);
        if (previous !== current && pages) {
            pages[previous].total--;
            pages[current].total++;
        }
    }
    return pages;
}

function nextVisibleBenchmarkGroup() {
    const hasOtherVersions = (currentBenchmarkPages()?.other.total ?? 0) > 0;
    const groups = hasOtherVersions && otherConditionsExpanded
        ? ['other', lowCoverageExpanded && 'lowCoverage'].filter(Boolean)
        : !hasOtherVersions && lowCoverageExpanded ? ['lowCoverage'] : ['primary'];
    return groups.find(group => state.rankingPagination?.benchmarks[group]?.hasMore
        && !state.rankingPageLoading[benchmarkPageKey(group)] && !state.rankingPageError[benchmarkPageKey(group)]);
}

function loadVisibleBenchmarkPage() {
    const group = nextVisibleBenchmarkGroup();
    if (group && shouldLoadMore(benchmarkRows)) void loadNextRankingPage('benchmarks', group);
}
Object.assign(state, readWorkspacePreferences());
state.estimationAlgorithm = readEstimationPreference();
state.availableInferenceVersion = AVAILABLE_INFERENCE_VERSION;
state.workspaceDisplay = 'standard';
const homeModelFocusIntent = readHomeModelFocusIntent(window.location.href);
if (homeModelFocusIntent?.valid) {
    state.mode = homeModelFocusIntent.mode;
    state.scoreMode = homeModelFocusIntent.scoreMode;
}
if (homeModelFocusIntent) consumeHomeModelFocusURL();
const estimationControl = createEstimationControl(document.getElementById('estimation-test-control'), {
    async onChange(algorithm) {
        const changeID = ++scoreModeChangeID;
        const adjustmentsSaved = await finishPendingWeightAdjustments();
        const pieSaved = adjustmentsSaved && await flushPendingPersonalPieSave();
        if (changeID !== scoreModeChangeID) return;
        if (!pieSaved) {
            setStatus('Your weight change was not saved. Try switching algorithms again.');
            renderScoringControls(); return;
        }
        if (state.estimationAlgorithm === algorithm) return;
        state.estimationAlgorithm = normalizeEstimationAlgorithm(algorithm);
        writeEstimationPreference(algorithm);
        renderScoringControls();
        void loadWeightedWorkspace({ preserveUndo: true });
    }
});
function renderScoringControls() {
    scoreModeButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.scoreMode === state.scoreMode)));
    scoringSwitch.dataset.mode = state.scoreMode;
    estimationControl.render(state);
    setHelpText(scoringSwitch.querySelector('.bp-scoring-help'), state.estimationAlgorithm === 'current'
        ? 'Estimated score combines available results and estimates, then adjusts the whole index for measured coverage. Score range keeps measured results fixed and fills gaps with 0 or 100.'
        : 'Estimated score adjusts missing weight using the selected method and keeps measured contributions fixed. Score range fills gaps with 0 or 100.');
}
renderScoringControls();
let scoreModeChangeID = 0;
scoreModeButtons.forEach(button => button.addEventListener('click', async () => {
    const requestedMode = button.dataset.scoreMode;
    const changeID = ++scoreModeChangeID;
    const adjustmentsSaved = await finishPendingWeightAdjustments();
    const pieSaved = adjustmentsSaved && await flushPendingPersonalPieSave();
    if (changeID !== scoreModeChangeID) return;
    if (!pieSaved) {
        setStatus('Your weight change was not saved. Try switching modes again.');
        return;
    }
    if (state.scoreMode === requestedMode) return;
    state.scoreMode = requestedMode;
    writeWorkspacePreferences(state);
    renderScoringControls();
    void loadWeightedWorkspace({ preserveUndo: true });
}));
state.comparisonRequest = null;
state.comparisonNeedsSelection = false;
state.comparisonPending = false;
state.comparisonError = '';
function onComparisonChange(options) {
    if (typeof modelFocus !== 'undefined') modelFocus.cancel({ clearPage: true });
    state.comparisonNeedsSelection = false;
    state.comparisonError = '';
    state.comparisonPending = true;
    state.comparisonRequest = options;
    comparisonProfileLoadError = '';
    renderModels();
    void loadWeightedWorkspace({ preserveUndo: true, comparisonChange: true });
}
const comparisonControls = withHomeFocusComparison({
    controls: createComparisonControls({ onChange: onComparisonChange }), intent: homeModelFocusIntent,
    onChange: onComparisonChange, onApply: options => { state.comparisonRequest = options; }
});
let comparisonProfileLoadError = '';
let comparisonProfileFailure = null;
let comparisonProfileLoading = false;
let comparisonProfilesReady;
function loadComparisonProfiles() {
    if (comparisonProfileLoading) return comparisonProfilesReady;
    comparisonProfileLoading = true;
    comparisonProfileFailure = null;
    comparisonProfilesReady = postJSON('/api/get_user_profile', {}, { timeoutMs: 10000, requireJSON: true }).then(profile => {
        const accountID = profile == null ? null : canonicalAccountID(profile.userID);
        if (profile != null && !accountID) throw new TypeError('Invalid account identity');
        state.comparisonRequest = comparisonControls.configureAccount(accountID);
        comparisonProfileLoadError = '';
        return true;
    }).catch(error => {
        comparisonProfileFailure = Object.assign(new Error('Your account could not be checked. Please retry.'),
            { code: 'comparison_settings_unavailable' });
        console.error('[BenchPoll] Comparison account unavailable', error);
        return false;
    }).finally(() => { comparisonProfileLoading = false; });
    return comparisonProfilesReady;
}
loadComparisonProfiles();
const defaultComparison = () => ({ mode: 'best', keys: ['model'], filters: [] });
const invalidSavedComparison = error => error.status === 400 && [
    'comparison_keys_unavailable', 'invalid_comparison_filter_key', 'comparison_model_unavailable',
        'invalid_comparison_keys', 'invalid_comparison_filters', 'score_field_option_unavailable'
].includes(error.payload?.error);
async function recoverComparison(error) {
    comparisonProfileLoadError = 'A saved comparison uses fields or values that are no longer available. It was reset to Model only.';
    console.warn('[BenchPoll] Saved comparison reset', error.payload?.error);
    state.comparisonRequest = defaultComparison();
    state.comparisonNeedsSelection = false;
    state.comparisonError = '';
    comparisonControls.resetToDefault();
}
initializeMobilePanels(document.querySelector('.bp-workspace'));

let touchPieGesture = null;
let pendingWheelBasisPoints = 0;
let wheelWeightCommitTimer = null;
let wheelPreviewFrame = null;
let weightCursorTarget = null;
let lastPointerPosition = null;
let gestureSettledResolvers = [];

function notifyGestureSettled() {
    const resolvers = gestureSettledResolvers;
    gestureSettledResolvers = [];
    resolvers.forEach(resolve => resolve());
}

async function waitForGestureToSettle() {
    while (state.gestureOpen) {
        await new Promise(resolve => gestureSettledResolvers.push(resolve));
    }
}

let fallbackTargetPrimaryID = null;
let fallbackEditorScope = null;
let pendingFallbackSave = false;
let fallbackSaveFailed = false;

const { openApprovedModelResults } = createModelScoresView({ state, modelScoresDialog, modelScoresTitle, modelScoresSummary, modelScoresList,
    getMemberURL: getBenchmarkMemberURL, onInspectVersion: onBenchmarkInspection });
const modelListView = createModelListView({
    state, modelRows, openApprovedModelResults,
    onUpdateStatus: updateLastUpdated,
    onRetrySave: () => state.personalSaveConflict ? window.location.reload() : void persistPersonalPie(),
    onNeedMore: () => {
        if (shouldLoadMore(modelRows)) void loadNextRankingPage(state.mode);
    },
    onFocusPageRequest: offset => { void modelFocus.loadPage(offset); },
    onFocusRefresh: () => { void loadWeightedWorkspace({ preserveUndo: true }); }
});
const { renderModels, clearRankingStatus } = modelListView;
const modelFocusNotice = createModelFocusNotice(modelRows);
const modelFocus = createHomeModelFocus({ intent: homeModelFocusIntent, state, rows: modelRows, view: modelListView,
    request: postJSON, onMessage: modelFocusNotice,
    showRanking() {
        setWorkspaceView('leaderboard', { animate: false });
        const workspace = document.querySelector('.bp-workspace');
        workspace.dataset.mobilePanel = 'models';
        workspace.querySelectorAll('[data-mobile-panel]').forEach(button =>
            button.setAttribute('aria-pressed', String(button.dataset.mobilePanel === 'models')));
    }
});
createModelSearch({ container: document.getElementById('ranking-model-search'),
    async search(query, { signal }) {
        const snapshotID = state.rankingPagination?.snapshotID, list = state.mode;
        if (!snapshotID || state.loading || state.comparisonPending) throw new Error('Ranking not ready');
        const result = await postJSON('/api/search_ranking_models', { snapshotID, list, query },
            { signal, timeoutMs: 15000, requireJSON: true });
        if (result.snapshotID !== snapshotID || result.list !== list
            || state.rankingPagination?.snapshotID !== snapshotID || state.mode !== list || !Array.isArray(result.items)) {
            throw new Error('Ranking changed');
        }
        return result.items.map(item => ({ ...item, targetModel: normalizeModelFocusTarget(item.targetModel), snapshotID, list }));
    },
    onSelect(item) {
        if (state.rankingPagination?.snapshotID !== item.snapshotID || state.mode !== item.list
            || state.loading || state.comparisonPending) {
            modelFocusNotice('This ranking changed. Search again.'); return;
        }
        void modelFocus.start(item.targetModel);
    }
});
const { renderPie: renderPieGraphic } = createPieRenderer({
    state, pieSvg, pieHoverTooltip, orderedPieEntries, currentPieEntries, selectedObjectIndex,
    getPreview: () => personalPieStart.previewPublic ? state.publicEntries : null,
    renderInlineFallback, fallbackRuleFor, publicFallbackRuleFor,
    async onSelect(objectID) {
        if (!await finishPendingWeightAdjustments()) return;
        deactivateInlineFallbackTarget();
        state.selectedObjectID = objectID;
        state.selectedFamilyKey = null;
        state.workspaceView = 'focus';
        applyWorkspaceView({ animate: true });
        renderModeState();
        renderPie();
        renderBenchmarks();
        renderBenchmarkSummary();
        revealBenchmarkRow(objectID);
    }
});

function renderPie(options) {
    renderPieGraphic(options);
    renderSelectedWeightHeading();
}

function snapshotPersonalPie() {
    return {
        entries: cloneEntries(state.personalEntries),
        fallbackRules: cloneFallbackRules(state.personalFallbackRules)
    };
}

function portablePersonalPie() {
    return {
        entries: state.personalEntries.map(entry => ({
            conditionID: Number(entry.conditionID),
            weightBasisPoints: Number(entry.weightBasisPoints),
            ...(entry.followCommunityVersion === true ? { followCommunityVersion: true } : {})
        })),
        fallbackRules: state.personalFallbackRules.map(rule => ({
            primaryConditionID: Number(rule.primaryConditionID),
            mode: FALLBACK_RULE_MODE,
            ...(rule.selectionSource ? { selectionSource: rule.selectionSource } : {}),
            entries: rule.entries.map(portableFamilyEntry)
        }))
    };
}

function recordGuestDraft() {
    const key = workspaceContextFingerprint();
    if (state.personalEntries.length === 0 && !state.hasSavedPersonalWeights) {
        state.guestDraftStorageAvailable = guestDrafts.delete(key);
        state.usingGuestDraft = false;
    } else {
        state.guestDraftStorageAvailable = guestDrafts.set(key, portablePersonalPie());
        state.usingGuestDraft = true;
    }
    state.personalIsDraft = true;
}

function recordPersonalDraft() {
    if (!state.authenticated || state.usingGuestDraft && !state.recoveredPersonalDraft) {
        recordGuestDraft();
        return true;
    }
    try {
        pieRecovery.checkpoint();
        return !state.personalRecoveryBlocked;
    } catch (error) {
        state.personalRecoveryBlocked = true;
        state.personalSaveConflict = true;
        state.personalSaveError = ['pie_recovery_changed', 'pie_save_scope_changed'].includes(error.code) ? error.message
            : 'Your draft could not be retained safely. Keep this tab open and review it before saving.';
        state.personalRankingError = state.personalSaveError;
        setStatus(state.personalSaveError);
        return false;
    }
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
    fallbackTargetPrimaryID = null;
    fallbackEditorScope = null;
    pendingFallbackSave = false;
    fallbackSaveFailed = false;
}

function setPieAdjustmentActive(active) {
    pieCard?.classList.toggle('is-adjusting-weight', Boolean(active));
    updatePieAdjustmentStatus();
}

function updatePieAdjustmentStatus() {
    updateWeightAdjustmentCursor();
    const entry = state.personalEntries.find(item => Number(item.conditionID) === Number(state.selectedObjectID));
    const single = state.personalEntries.length === 1;
    const visible = !personalPieStart.isOpen && state.mode === 'personal' && Boolean(entry)
        && (single || state.workspaceView === 'focus' || pieCard?.classList.contains('is-adjusting-weight'));
    if (!visible) {
        if (pieAdjustmentStatus.getAttribute('aria-hidden') !== 'true') void setVisible(pieAdjustmentStatus, false);
        return;
    }
    pieAdjustmentName.textContent = benchmarkAccessibleName(entry);
    pieAdjustmentName.dataset.tooltip = pieAdjustmentName.textContent;
    pieAdjustmentValue.textContent = `${Math.round(entry.weightBasisPoints / 100)}%`;
    pieAdjustmentLabel.textContent = single ? 'One benchmark' : 'Adjusting weight';
    pieAdjustmentStatus.classList.toggle('is-single-benchmark', single);
    pieAdjustmentDismiss.disabled = single;
    pieAdjustmentDismiss.setAttribute('aria-label', single ? 'One benchmark stays at 100%' : 'Stop adjusting weight');
    pieAdjustmentStatus.querySelector('i').className = single ? 'fa-solid fa-plus' : 'fa-solid fa-arrows-up-down';
    pieAdjustmentInstruction.textContent = single
        ? 'Add another benchmark to adjust weights. One benchmark stays at 100%.'
        : window.matchMedia('(pointer: coarse)').matches
        ? 'Swipe on the pie to adjust. Tap this prompt to stop adjusting.'
        : 'Scroll on the pie or list. Right-click or click this prompt to stop adjusting.';
    if (pieAdjustmentStatus.getAttribute('aria-hidden') !== 'false') void setVisible(pieAdjustmentStatus, true);
}

let benchmarkRevealSequence = 0;
function revealBenchmarkRow(objectID) {
    const sequence = ++benchmarkRevealSequence;
    if (Number(objectID) < 0) {
        const row = benchmarkRows.querySelector(`.bp-reference-option[data-context-id="${-Number(objectID)}"]`);
        if (row) {
            const viewport = benchmarkRows.getBoundingClientRect(), bounds = row.getBoundingClientRect();
            if (bounds.top < viewport.top || bounds.bottom > viewport.bottom) row.scrollIntoView({ block: 'nearest',
                behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
        }
        return;
    }
    const snapshotID = state.rankingPagination?.snapshotID;
    void (async () => {
        await new Promise(resolve => requestAnimationFrame(resolve));
        while (sequence === benchmarkRevealSequence
            && Number(state.selectedObjectID) === Number(objectID)
            && snapshotID === state.rankingPagination?.snapshotID) {
            const details = state.benchmarkDetailsByID.get(Number(objectID))
                ?? currentPieEntries().find(entry => Number(entry.conditionID) === Number(objectID));
            if (!details) return;
            const group = currentBenchmarkGroup(details);
            const nestedLowCoverage = group === 'lowCoverage' && (currentBenchmarkPages()?.other.total ?? 0) > 0;
            if ((group === 'lowCoverage' && (!lowCoverageExpanded || (nestedLowCoverage && !otherConditionsExpanded)))
                || (group === 'other' && !otherConditionsExpanded)) {
                if (group === 'lowCoverage') lowCoverageExpanded = true;
                if (group === 'other' || nestedLowCoverage) otherConditionsExpanded = true;
                renderBenchmarks();
            }
            const row = [...benchmarkRows.querySelectorAll('.bp-benchmark-row')]
                .find(item => Number(item.dataset.conditionId) === Number(objectID));
            if (row) {
                const viewport = benchmarkRows.getBoundingClientRect();
                const bounds = row.getBoundingClientRect();
                if (bounds.top < viewport.top || bounds.bottom > viewport.bottom) {
                    row.scrollIntoView({
                        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
                        block: 'nearest'
                    });
                }
                return;
            }
            if (benchmarkSearch.value.trim()) {
                benchmarkSearch.value = '';
                reloadBenchmarkPage();
            }
            if (!state.rankingPagination?.benchmarks[group]?.hasMore || state.rankingPageError[benchmarkPageKey(group)]) return;
            if (state.rankingPageLoading[benchmarkPageKey(group)] || state.loading) {
                await new Promise(resolve => window.setTimeout(resolve, 50));
            } else {
                await loadNextRankingPage('benchmarks', group);
            }
        }
    })();
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
    const url = rankingContextURL(window.location.href, state.dimensions, state.selectedContextValues, state.scenes);
    window.history.replaceState(window.history.state, '', url);
    updateTopicSearchMetadata({ name: state.topicName, description: state.topicSummary,
        url: '/' + state.categoryPath.replace(/^\/+/, ''), isPrivate: state.contextIsPrivate, scenes: state.scenes }, state.sceneID);
}

function setStatus(message = '') {
    state.statusMessage = message;
    updateLastUpdated();
}

function updateLastUpdated() {
    lastUpdated.hidden = !state.statusMessage;
    lastUpdated.textContent = state.statusMessage;
    updateIndicator.update({
        pending: state.loading || state.saving || state.comparisonPending
            || state.mode === 'personal' && state.personalRankingDirty,
        error: state.workspaceLoadError || state.personalSaveError || state.personalRankingError,
        version: state.lastLoadTime
    });
}

const categoryNavigationMedia = window.matchMedia('(max-width: 760px)');

function currentCategoryNode(name) {
    const node = document.createElement(categoryNavigationMedia.matches ? 'button' : 'span');
    node.className = 'bp-breadcrumb-current';
    node.textContent = name;
    if (categoryNavigationMedia.matches) {
        node.type = 'button';
        node.dataset.taxonomyTrigger = '';
        node.setAttribute('aria-label', `Open topics: ${name}`);
        node.setAttribute('aria-controls', 'tree-content');
        node.setAttribute('aria-expanded', String(document.body.classList.contains('taxonomy-open')
            && !document.body.classList.contains('taxonomy-closing')));
    }
    return node;
}

function renderBreadcrumb() {
    breadcrumb.replaceChildren();
    const name = currentCategoryNode(state.topicName || 'Topics');
    breadcrumb.append(name, updateIndicator.element);
    if (state.contextIsPrivate) {
        const label = document.createElement('small'); label.className = 'bp-private-context-label'; label.textContent = 'Private';
        breadcrumb.append(label);
        const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'bp-quiet-action';
        edit.setAttribute('aria-label', 'Edit private topic'); edit.dataset.tooltip = 'Edit private topic';
        const icon = document.createElement('i'); icon.className = 'fa-regular fa-pen-to-square'; icon.setAttribute('aria-hidden', 'true'); edit.append(icon);
        edit.disabled = !state.authenticated || state.accountWriteBlocked;
        edit.addEventListener('click', () => void privateTopicEditor.open(state.categoryID, edit)); breadcrumb.append(edit);
    }
    const creator = document.getElementById('workspace-topic-creator');
    creator.replaceChildren();
    creator.hidden = !state.topicCreator;
    if (state.topicCreator) creator.append(createTopicCreator(state.topicCreator));
    const summary = document.getElementById('workspace-topic-summary');
    summary.textContent = state.topicSummary;
    summary.hidden = !state.topicSummary;
}

async function prepareContextChange() {
    if (state.loading || !await finishPendingWeightAdjustments()) return false;
    if (state.saving && state.savePromise) await state.savePromise.catch(() => {});
    return flushPendingPersonalPieSave();
}

async function selectScene(id) {
    const category = state.categoryID;
    if (!state.scenes.some(scene => Number(scene.ID) === id) || !await prepareContextChange() || category !== state.categoryID) return;
    state.selectedContextValues = { scene: String(id) };
    state.workspaceView = 'overview';
    await loadWeightedWorkspace();
}

function renderTemplateControls() {
    sceneControls.render();
}

function updateUndoState() {
    undoButton.disabled = personalPieStart.isOpen || state.gestureOpen
        || wheelWeightCommitTimer !== null
        || !state.editHistory.canUndo;
    redoButton.hidden = !state.editHistory.canRedo;
    redoButton.disabled = personalPieStart.isOpen || state.gestureOpen || wheelWeightCommitTimer !== null || !state.editHistory.canRedo;
    resetButton.hidden = state.mode !== 'personal';
    resetButton.disabled = personalPieStart.isOpen || state.loading || state.gestureOpen || wheelWeightCommitTimer !== null
        || state.accountWriteBlocked || state.personalRecoveryBlocked || state.personalSaveConflict;
}

function requestLogin() {
    loginButton?.click();
}

function beginMutation(isGesture = false) {
    if (state.loading) {
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
        state.editHistory.record(snapshotPersonalPie());
        updateUndoState();
    }
    state.personalEditVersion += 1;
    state.personalSavePending = true;
    state.personalSaveError = '';
    state.personalRankingDirty = true;
    state.personalRankingError = '';
    renderModels();
    return true;
}

function finishWeightGesture({ persist = true } = {}) {
    if (!state.gestureOpen) {
        setPieAdjustmentActive(false);
        return Promise.resolve(true);
    }
    window.clearTimeout(state.gestureTimer);
    state.gestureTimer = null;
    state.gestureOpen = false;
    notifyGestureSettled();
    setPieAdjustmentActive(false);
    if (state.gestureSnapshot) {
        state.editHistory.record(state.gestureSnapshot);
    }
    state.gestureSnapshot = null;
    recordPersonalDraft();
    renderInlineFallback();
    renderBenchmarks();
    renderModels();
    updateUndoState();
    return persist ? persistPersonalPie() : Promise.resolve(true);
}

async function finishPendingWeightAdjustments() {
    if (wheelWeightCommitTimer !== null && !await commitPendingWheelAdjustment()) {
        return false;
    }
    if (state.gestureOpen && !await finishWeightGesture()) {
        return false;
    }
    return true;
}

function scheduleSave() {
    recordPersonalDraft();
    renderModeState();
    window.clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(() => {
        state.saveTimer = null;
        void persistPersonalPie();
    }, SAVE_DEBOUNCE_MS);
}

async function flushPendingPersonalPieSave() {
    let saved = true;
    if (state.saveTimer !== null || pendingFallbackSave || state.personalSavePending) {
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
    recordPersonalDraft();
    renderPie({ animateWeights });
    publishContextWeights();
    updatePieAdjustmentStatus();
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

const WORKSPACE_VIEWS = new Set(['overview', 'leaderboard', 'focus']);

function selectedBenchmark() {
    return state.benchmarks.find(object => !object.isFamily && Number(object.ID) === Number(state.selectedObjectID))
        ?? state.benchmarkDetailsByID.get(Number(state.selectedObjectID))
        ?? (() => {
            const entry = currentPieEntries().find(item => Number(item.conditionID) === Number(state.selectedObjectID));
            return entry ? { ...entry, ID: Number(entry.conditionID) } : null;
        })()
        ?? null;
}

function shouldLoadMore(container) {
    if (container.clientHeight <= 0 || container.closest('[inert]')) return false;
    const bounds = container.getBoundingClientRect();
    if (bounds.bottom < 0 || bounds.top > window.innerHeight) return false;
    // Mobile lists grow inside the vertically scrolling composition/ranking page.
    if (container.scrollHeight <= container.clientHeight + 1) {
        return bounds.bottom <= window.innerHeight + 180;
    }
    return container.scrollTop + container.clientHeight >= container.scrollHeight - 180;
}

function invalidateRankingPages() {
    for (const key of Object.keys(state.rankingPageSequence)) {
        state.rankingPageSequence[key] += 1;
        state.rankingPageLoading[key] = false;
        state.rankingPageError[key] = '';
    }
}

let rankingRecovery = null;
function rankingRecoveryScope() {
    return JSON.stringify([workspaceContextFingerprint(), state.scoreMode, state.availableInferenceVersion, state.estimationAlgorithm, state.personalEditVersion,
        comparisonProfileKey(state.comparisonRequest ?? { mode: 'best', keys: ['model'], filters: [] }),
        currentBenchmarkFilters()]);
}

function recoverRankingPages(failedPage) {
    const pagination = state.rankingPagination;
    if (!pagination || workspaceLoadFailed) return Promise.resolve();
    if (rankingRecovery?.snapshotID === pagination.snapshotID
        && rankingRecovery.scope === rankingRecoveryScope()) return rankingRecovery.promise;
    const requests = [failedPage];
    for (const list of ['personal', 'public']) {
        if (state.rankingPageLoading[list] && pagination[list].hasMore) requests.push({ list, offset: pagination[list].nextOffset });
    }
    for (const group of BENCHMARK_GROUPS) {
        if (state.rankingPageLoading[benchmarkPageKey(group)] && pagination.benchmarks[group].hasMore) {
            requests.push({ list: 'benchmarks', group, offset: pagination.benchmarks[group].nextOffset });
        }
    }
    const recovery = { snapshotID: pagination.snapshotID, scope: rankingRecoveryScope(),
        resume: captureRankingResume(pagination, { requests, fallbacks: benchmarkFallbackCatalogue.progress() }) };
    const task = loadWeightedWorkspace({ preserveUndo: true, pageRecovery: recovery });
    const promise = task.finally(() => { if (rankingRecovery?.promise === promise) rankingRecovery = null; });
    rankingRecovery = { snapshotID: pagination.snapshotID, scope: recovery.scope, mode: state.mode, promise };
    return promise;
}

async function loadNextRankingPage(list, group = 'primary') {
    if (list !== 'benchmarks' && typeof modelFocus !== 'undefined'
        && (modelFocus.blocksPaging || modelListView.getFocusPage()?.list === list)) return;
    const pagination = state.rankingPagination;
    const key = list === 'benchmarks' ? benchmarkPageKey(group) : list;
    const page = list === 'benchmarks' ? pagination?.benchmarks[group] : pagination?.[list];
    if (!pagination || !page?.hasMore || state.loading || workspaceLoadFailed || state.rankingPageLoading[key]) return;
    const snapshotID = pagination.snapshotID;
    const workspaceSequence = state.loadSequence;
    const sequence = ++state.rankingPageSequence[key];
    const offset = page.nextOffset;
    state.rankingPageLoading[key] = true;
    state.rankingPageError[key] = '';
    if (list === 'benchmarks') renderBenchmarks();
    else if (state.mode === list) renderModels();
    try {
        const response = validateRankingPagePayload(await postJSON('/api/get_ranking_page', {
            snapshotID, list, offset,
            ...(list === 'benchmarks' ? { group } : {}),
            query: list === 'benchmarks' ? benchmarkSearch.value.trim() : '',
            pinPersonal: list === 'benchmarks' ? state.pinPersonalBenchmarks : false
        }), { list, offset, group, scoreMode: state.scoreMode,
            grouping: !state.versionComposition && benchmarkSearch.value.trim() ? 'versions' : 'flat' });
        if (sequence !== state.rankingPageSequence[key] || workspaceSequence !== state.loadSequence
            || snapshotID !== state.rankingPagination?.snapshotID) return;
        if (list === 'benchmarks') {
            state.rankingPagination.benchmarkGrouping = response.grouping;
            state.benchmarks.push(...response.items);
            response.items.filter(object => !object.isFamily).forEach(object => state.benchmarkDetailsByID.set(Number(object.ID), object));
            for (const otherGroup of BENCHMARK_GROUPS) {
                const otherPage = state.rankingPagination.benchmarks[otherGroup];
                otherPage.total = response.groupTotals[otherGroup];
                otherPage.hasMore = otherPage.nextOffset < otherPage.total;
            }
            state.rankingPagination.benchmarks[group] = {
                total: response.total, nextOffset: response.nextOffset, hasMore: response.hasMore
            };
            renderBenchmarks();
            renderBenchmarkSummary();
            window.queueMicrotask(loadVisibleBenchmarkPage);
        } else {
            state.modelLeaderboards[list].push(...response.items);
            state.rankingPagination[list] = {
                total: response.total, nextOffset: response.nextOffset, hasMore: response.hasMore
            };
            if (state.mode === list) renderModels();
        }
    } catch (error) {
        if (sequence !== state.rankingPageSequence[key] || workspaceSequence !== state.loadSequence
            || snapshotID !== state.rankingPagination?.snapshotID) return;
        if (error.status === 410 || (error.status === 403 && error.payload?.error === 'ranking_snapshot_forbidden')) {
            void recoverRankingPages({ list, group: list === 'benchmarks' ? group : undefined, offset });
            return;
        }
        state.rankingPageError[key] = 'Could not load more results.';
        if (list === 'benchmarks') renderBenchmarks();
        else if (state.mode === list) renderModels();
    } finally {
        if (sequence === state.rankingPageSequence[key]) {
            state.rankingPageLoading[key] = false;
            if (list === 'benchmarks') renderBenchmarks();
            else if (state.mode === list) renderModels();
        }
    }
}

function reloadBenchmarkPage() {
    if (!state.rankingPagination || workspaceLoadFailed) return;
    state.rankingPagination.benchmarkGrouping = !state.versionComposition && benchmarkSearch.value.trim() ? 'versions' : 'flat';
    for (const group of BENCHMARK_GROUPS) {
        const key = benchmarkPageKey(group);
        state.rankingPageSequence[key] += 1;
        state.rankingPageLoading[key] = false;
        state.rankingPageError[key] = '';
        state.rankingPagination.benchmarks[group] = { total: null, nextOffset: 0, hasMore: true };
    }
    otherConditionsExpanded = false;
    lowCoverageExpanded = false;
    state.benchmarks = [];
    benchmarkRows.scrollTop = 0;
    renderBenchmarks();
    void loadNextRankingPage('benchmarks');
}

function currentBenchmarkFilters() {
    return { benchmarkQuery: benchmarkSearch.value.trim(), pinPersonal: state.pinPersonalBenchmarks };
}

function refreshChangedBenchmarkFilters(requested) {
    const current = currentBenchmarkFilters();
    if (Object.keys(current).some(key => current[key] !== requested[key])) reloadBenchmarkPage();
}

function renderBenchmarkSummary() {
    benchmarkSummaryContent.replaceChildren();
    const object = selectedBenchmark();
    if (!object) {
        const empty = document.createElement('div');
        empty.className = 'bp-benchmark-summary-empty';
        empty.innerHTML = '<strong>No benchmark selected</strong><span>Select a weight block to inspect its benchmark.</span>';
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
    identity.append(eyebrow, title);

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
    if (pieCard.parentElement !== pieHomeSlot) {
        pieHomeSlot.append(pieCard);
    }
    pieCard.hidden = false;
    benchmarkSummaryCard.hidden = true;
    benchmarkCard.hidden = false;
    modelCard.hidden = false;
    leftWorkspace.dataset.workspaceView = state.workspaceView;
    rightWorkspace.dataset.workspaceView = state.workspaceView;
    if (animate && window.matchMedia('(min-width: 761px)').matches) {
        // A transformed workspace changes the containing block of its fixed adjustment prompt.
        animateContent(leftWorkspace, { translate: false });
        animateContent(rightWorkspace, { translate: false });
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

function onBenchmarkInspection(event) {
    if (event && (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)) return;
    fallbackPicker.close({ restore: false });
    if (isPersonalBenchmarkFocus()) setWorkspaceView('leaderboard');
}

function appendBenchmarkDiscoveryActions(empty) {
    const query = benchmarkSearch.value.trim();
    const details = bulkImportTemplate({ query, categoryPath: state.categoryPath, contextValues: state.selectedContextValues });
    const actions = document.createElement('div'); actions.className = 'bp-benchmark-discovery-actions';
    actions.append(createAction({ label: 'Add a new benchmark', icon: 'fa-solid fa-plus',
        href: contributionEditURL('new_benchmark', { benchmarkName: query, categoryPath: state.categoryPath }), variant: 'secondary' }),
    createAction({ label: 'Request bulk import', icon: 'fa-solid fa-file-import',
        href: contributionEditURL('feedback', { targetKind: 'bulk_import', details, pageURL: window.location.href }), variant: 'secondary' }));
    empty.append(actions);
}

function onBenchmarkActivation(event, object) {
    if ((event.button !== undefined && event.button !== 0) || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const hasWeight = state.mode === 'personal' ? objectInPersonalPie(object) : Number(object.publicWeight) > 0;
    if (!hasWeight) return;
    event.preventDefault();
    void selectWeightedBenchmark(object, { toggle: true });
}

async function selectWeightedBenchmark(object, { toggle = false } = {}) {
    const context = workspaceContextFingerprint();
    if (state.loading || !await finishPendingWeightAdjustments()) return;
    if (state.loading || context !== workspaceContextFingerprint()
        || !(state.mode === 'personal' ? objectInPersonalPie(object) : Number(object.publicWeight) > 0)) return;
    const selected = state.workspaceView === 'focus' && Number(state.selectedObjectID) === Number(object.ID)
        && (object.isFamily ? state.selectedFamilyKey === object.familyKey : state.selectedFamilyKey === null);
    deactivateInlineFallbackTarget();
    state.selectedObjectID = object.ID;
    state.selectedFamilyKey = object.isFamily ? object.familyKey : null;
    state.workspaceView = toggle && selected ? 'leaderboard' : 'focus';
    applyWorkspaceView({ animate: true });
    renderModeState(); renderPie(); renderBenchmarks(); renderBenchmarkSummary();
}

function fallbackRuleFor(primaryConditionID) {
    return state.personalFallbackRules.find(rule => (
        Number(rule.primaryConditionID) === Number(primaryConditionID)
    )) ?? null;
}

function fallbackSignature(rules) {
    return rules.map(rule => JSON.stringify([familyKey(rule.primaryConditionID, rule.entries), rule.selectionSource ?? 'selected'])).sort().join('\n');
}

function publicFallbackRuleFor(primaryConditionID) {
    const composition = state.mode === 'personal'
        ? [...state.personalCommunityComposition, ...state.publicFamilyComposition, ...state.communityFallbackComposition]
        : [...state.publicFamilyComposition, ...state.communityFallbackComposition];
    return composition.find(rule => (
        Number(rule.primaryConditionID) === Number(primaryConditionID)
    )) ?? null;
}

function selectedInlineFallbackPrimary() {
    if (state.mode !== 'personal') {
        return null;
    }
    const primary = selectedBenchmark();
    if (!primary || isTopicReference(primary) || !state.personalEntries.some(entry => (
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
    if (!primary || isTopicReference(primary) || !state.publicEntries.some(entry => (
        Number(entry.conditionID) === Number(primary.ID)
    ))) {
        return null;
    }
    return primary;
}

function inlineFallbackScope(primaryID) {
    return `${workspaceContextFingerprint()}|${state.mode}|${state.userID ?? 'guest'}|${Number(primaryID)}`;
}

function isInlineFallbackEditing() {
    const primary = selectedInlineFallbackPrimary();
    return Boolean(primary) && state.personalFallbackExpanded
        && fallbackEditorScope === inlineFallbackScope(primary.ID);
}

function beginInlineFallbackEditing(primary = selectedInlineFallbackPrimary()) {
    if (!primary || isTopicReference(primary) || state.mode !== 'personal' || state.loading || state.gestureOpen
        || !state.personalEntries.some(entry => Number(entry.conditionID) === Number(primary.ID))) return false;
    if (Number(state.selectedObjectID) !== Number(primary.ID)) focusPersonalBenchmark(primary);
    const current = fallbackRuleFor(primary.ID);
    if (current?.selectionSource !== 'custom') {
        if (!beginMutation()) return false;
        replaceFallbackRuleEntries(primary.ID, current?.entries ?? [], 'custom');
        scheduleSave();
    }
    state.personalFallbackExpanded = true;
    fallbackEditorScope = inlineFallbackScope(primary.ID);
    deactivateInlineFallbackTarget();
    writeWorkspacePreferences(state);
    renderInlineFallback(); renderBenchmarks();
    requestAnimationFrame(() => {
        if (isInlineFallbackEditing()) inlineFallbackDone.focus({ preventScroll: true });
    });
    return true;
}

function finishInlineFallbackEditing() {
    fallbackEditorScope = null;
    deactivateInlineFallbackTarget();
    renderInlineFallback(); renderBenchmarks();
    requestAnimationFrame(() => {
        if (!inlineFallbackEdit.closest('[hidden], [inert]')) inlineFallbackEdit.focus({ preventScroll: true });
    });
}

function isInlineFallbackTargetActive() {
    const primary = selectedInlineFallbackPrimary();
    return Boolean(primary)
        && isInlineFallbackEditing()
        && Number(fallbackTargetPrimaryID) === Number(primary.ID);
}

function deactivateInlineFallbackTarget() {
    fallbackTargetPrimaryID = null;
    inlineFallback?.classList.remove('is-target-active');
    benchmarkCard?.classList.remove('is-fallback-target-active');
}

function activateInlineFallbackTarget() {
    const primary = selectedInlineFallbackPrimary();
    if (!primary || !isInlineFallbackEditing() || state.loading) {
        return false;
    }
    fallbackTargetPrimaryID = Number(primary.ID);
    if (state.workspaceView === 'focus') {
        state.workspaceView = 'leaderboard';
        applyWorkspaceView({ animate: true });
        renderModeState();
    }
    renderInlineFallback();
    renderBenchmarks();
    return true;
}

function renderInlineFallback() {
    fallbackPicker.refresh();
    benchmarkSettings.refresh();
    if (state.versionComposition) {
        const primary = state.mode === 'personal' ? selectedInlineFallbackPrimary() : selectedPublicFallbackPrimary();
        void setVisible(inlineFallback, Boolean(primary), { collapse: true });
        pieCard.classList.toggle('has-inline-fallback', Boolean(primary));
        inlineFallbackPersonalControl.hidden = state.mode !== 'personal';
        publicFallbackToggle.hidden = state.mode === 'personal';
        for (const control of [inlineFallbackToggle, publicFallbackToggle]) {
            (control.querySelector('span') ?? control).textContent = state.contextIsPrivate
                ? 'Configure this benchmark' : 'Contribute your expertise';
            control.setAttribute('aria-haspopup', 'dialog'); control.setAttribute('aria-controls', 'benchmark-settings');
            control.removeAttribute('aria-expanded'); control.disabled = state.loading;
        }
        inlineFallbackGuide.hidden = true;
        inlineFallbackSaveError.hidden = !fallbackSaveFailed;
        void setVisible(inlineFallbackSettings, false, { collapse: true });
        return;
    }
    if (!isInlineFallbackEditing()) {
        fallbackEditorScope = null;
        deactivateInlineFallbackTarget();
    }
    const personal = state.mode === 'personal';
    const primary = personal ? selectedInlineFallbackPrimary() : selectedPublicFallbackPrimary();
    const rule = primary && personal ? fallbackRuleFor(primary.ID) : null;
    const enabled = Boolean(primary) && personal && Boolean(rule) && state.personalFallbackExpanded;
    const editing = enabled && isInlineFallbackEditing();
    void setVisible(inlineFallback, Boolean(primary), { collapse: true });
    pieCard.classList.toggle('has-inline-fallback', Boolean(primary));
    inlineFallback.classList.toggle('is-readonly', !personal);
    inlineFallbackPersonalControl.hidden = !personal;
    publicFallbackToggle.hidden = personal;
    publicFallbackToggle.disabled = state.loading;
    inlineFallbackToggle.querySelector('span').textContent = `Fallback: ${fallbackStatusLabel(rule)}`;
    if (rule) {
        inlineFallbackToggle.removeAttribute('aria-haspopup');
        inlineFallbackToggle.setAttribute('aria-controls', 'inline-fallback-settings');
        inlineFallbackToggle.setAttribute('aria-expanded', String(enabled));
    } else {
        inlineFallbackToggle.setAttribute('aria-haspopup', 'dialog');
        inlineFallbackToggle.setAttribute('aria-controls', 'fallback-picker');
        inlineFallbackToggle.removeAttribute('aria-expanded');
    }
    inlineFallbackToggle.disabled = state.loading;
    inlineFallbackSaveError.hidden = !personal || !fallbackSaveFailed;
    inlineFallbackSaveRetry.disabled = state.saving || state.loading;
    inlineFallbackGuide.hidden = !primary;
    addFallbackBenchmarkButton.hidden = !personal;
    inlineFallbackEdit.hidden = !enabled || editing;
    inlineFallbackDone.hidden = !editing;
    inlineFallbackEdit.disabled = state.loading || state.gestureOpen;
    inlineFallbackPreview.hidden = !enabled || editing;
    inlineFallbackConfigurations.disabled = state.loading;
    addFallbackBenchmarkButton.disabled = state.loading;
    inlineFallbackChart.hidden = !primary;
    if (!primary) {
        deactivateInlineFallbackTarget();
        inlineFallbackChart.replaceChildren();
        void setVisible(inlineFallbackSettings, false, { collapse: true });
        return;
    }
    const active = personal && enabled && isInlineFallbackTargetActive();
    addFallbackBenchmarkButton.setAttribute('aria-pressed', String(active));
    addFallbackBenchmarkButton.querySelector('span').textContent = 'Add fallback benchmark';
    inlineFallback.classList.toggle('is-target-active', active);
    benchmarkCard.classList.toggle('is-fallback-target-active', active);
    inlineFallbackChart.classList.toggle('is-target-active', active);
    inlineFallbackChart.classList.toggle('bp-weight-setup-glow', editing && !rule?.entries.length);
    inlineFallbackChart.classList.toggle('is-empty', personal && !rule?.entries.length);
    inlineFallbackChart.tabIndex = -1;
    inlineFallbackChart.setAttribute('aria-label', personal
        ? `Fallback order for ${benchmarkAccessibleName(primary)}. Use Add fallback benchmark below to add backups.`
        : `Public fallback configurations for ${benchmarkAccessibleName(primary)}`);
    if (!enabled) {
        void setVisible(inlineFallbackSettings, false, { collapse: true });
        void setVisible(inlineFallbackEditor, false, { collapse: true });
        return;
    }
    inlineFallbackSettings.classList.toggle('is-editing', editing);
    inlineFallbackConfigurationLabel.textContent = fallbackStatusLabel(rule);
    inlineFallbackEntrance.textContent = benchmarkAccessibleName(primary);
    inlineFallbackGuide.textContent = 'If this version has no score, try these backups in order.';
    if (editing) familyView.renderPersonal({ primary, entries: rule?.entries ?? [], active, disabled: state.loading });
    else familyView.renderPreview(inlineFallbackPreviewSequence, { primary, entries: rule.entries });
    void setVisible(inlineFallbackEditor, editing, { collapse: true });
    void setVisible(inlineFallbackSettings, true, { collapse: true });
}

function fallbackComponentFromBenchmark(object) {
    return {
        conditionID: Number(object.ID), benchmarkID: Number(object.benchmarkID), name: object.name,
        conditionKey: object.conditionKey, conditionName: object.conditionName,
        isDefaultCondition: object.isDefaultCondition, isPrimaryCondition: object.isPrimaryCondition,
        lowCoverage: object.lowCoverage, type: object.type
    };
}

function replaceFallbackRuleEntries(primaryConditionID, entries, selectionSource = 'custom') {
    const retained = state.personalFallbackRules.filter(rule => rule.primaryConditionID !== primaryConditionID);
    if (entries !== null) retained.push({ primaryConditionID, mode: FALLBACK_RULE_MODE, familyID: null,
        selectionSource, entries: cloneEntries(entries) });
    state.personalFallbackRules = retained.sort((a, b) => a.primaryConditionID - b.primaryConditionID);
}

function addObjectToFallbackChain(object) {
    if (excludedFromRanking(object)) return false;
    const primary = selectedInlineFallbackPrimary();
    if (!primary || !isInlineFallbackTargetActive()) return false;
    if (object.isFamily) {
        setStatus('Choose a benchmark version to add as a backup.');
        return false;
    }
    const conditionID = Number(object.ID);
    if (conditionID === primary.ID) {
        setStatus('The entrance benchmark is already first.');
        return false;
    }
    const entries = fallbackRuleFor(primary.ID)?.entries ?? [];
    if (entries.some(entry => entry.conditionID === conditionID)) {
        return true;
    }
    if (!beginMutation()) return false;
    replaceFallbackRuleEntries(primary.ID, [...entries, fallbackComponentFromBenchmark(object)]);
    fallbackTargetPrimaryID = primary.ID;
    setStatus('');
    renderPie();
    renderBenchmarks();
    scheduleSave();
    additionToast.show('Added to your fallback list.');
    return true;
}

function moveFallbackMember(conditionID, targetIndex) {
    if (!isInlineFallbackEditing()) return false;
    const primary = selectedInlineFallbackPrimary();
    const entries = primary ? fallbackRuleFor(primary.ID)?.entries : null;
    const index = entries?.findIndex((entry, position) => familyEntryKey(entry, position) === conditionID) ?? -1;
    if (index < 0 || targetIndex < 0 || targetIndex >= entries.length || index === targetIndex) return false;
    const next = cloneEntries(entries);
    next.splice(targetIndex, 0, next.splice(index, 1)[0]);
    if (!beginMutation()) return false;
    replaceFallbackRuleEntries(primary.ID, next);
    renderPie();
    renderBenchmarks();
    scheduleSave();
    return true;
}

function removeFallbackMember(conditionID) {
    if (!isInlineFallbackEditing()) return false;
    const primary = selectedInlineFallbackPrimary();
    const rule = primary ? fallbackRuleFor(primary.ID) : null;
    if (!rule || !rule.entries.some((entry, index) => familyEntryKey(entry, index) === conditionID)) return false;
    const entries = rule.entries.filter((entry, index) => familyEntryKey(entry, index) !== conditionID);
    if (!beginMutation()) return false;
    replaceFallbackRuleEntries(primary.ID, entries);
    renderPie();
    renderBenchmarks();
    scheduleSave();
    return true;
}

const familyView = createFamilyView({ container: inlineFallbackChart,
    getMemberURL: getBenchmarkMemberURL, onInspectVersion: onBenchmarkInspection,
    onMove: moveFallbackMember, onRemove: removeFallbackMember });

function focusPersonalBenchmark(object) {
    state.selectedObjectID = Number(object.ID);
    deactivateInlineFallbackTarget();
    state.selectedFamilyKey = null;
    state.workspaceView = 'focus';
    applyWorkspaceView({ animate: true });
    renderModeState(); renderPie(); renderBenchmarks(); renderBenchmarkSummary();
}

function applyFallbackConfiguration(primary, choice, action) {
    if (state.mode !== 'personal' || state.loading) return false;
    if (state.personalEntries.find(entry => entry.conditionID === Number(primary.ID))?.followCommunityVersion === true) return false;
    if (!choice.community && (excludedFromRanking(primary) || choice.entries.some(excludedFromRanking))) {
        return false;
    }
    if (action === 'replace' || state.personalEntries.some(entry => Number(entry.conditionID) === Number(primary.ID))) {
        if (!state.personalEntries.some(entry => Number(entry.conditionID) === Number(primary.ID)) || !beginMutation()) return false;
        replaceFallbackRuleEntries(primary.ID, choice.community ? null : choice.entries,
            choice.configureOwn ? 'custom' : choice.selectionSource ?? 'selected');
        const rule = fallbackRuleFor(primary.ID);
        if (rule) rule.familyID = choice.familyID;
        state.selectedObjectID = primary.ID;
        scheduleSave();
    } else {
        const object = choice.entries.length ? { ...primary, isFamily: true, familyEntries: choice.entries,
            familyID: choice.familyID, familyKey: choice.key } : primary;
        if (!addObjectToPersonalPie(object)) return false;
    }
    fallbackEditorScope = null;
    deactivateInlineFallbackTarget();
    state.personalFallbackExpanded = true;
    writeWorkspacePreferences(state);
    focusPersonalBenchmark(primary);
    if (choice.configureOwn) {
        if (state.versionComposition) benchmarkSettings.open(primary, { custom: true });
        else beginInlineFallbackEditing(primary);
    }
    return true;
}

function chooseBenchmarkVersion(group, conditionID) {
    if (state.mode !== 'personal' || state.loading || state.gestureOpen) return false;
    const version = group.versions.find(item => item.conditionID === (conditionID ?? group.primaryConditionID));
    if (!version) return false;
    const IDs = new Set(group.versions.map(item => item.conditionID));
    const existing = state.personalEntries.filter(entry => IDs.has(entry.conditionID));
    if (!existing.length || !beginMutation()) return false;
    const weightBasisPoints = existing.reduce((sum, entry) => sum + entry.weightBasisPoints, 0);
    const entry = { ...version, weightBasisPoints, weight: weightBasisPoints / 100,
        ...(conditionID === null ? { followCommunityVersion: true } : {}) };
    state.personalEntries = [...state.personalEntries.filter(item => !IDs.has(item.conditionID)), entry];
    state.personalFallbackRules = state.personalFallbackRules.filter(rule => !IDs.has(rule.primaryConditionID));
    state.selectedObjectID = entry.conditionID;
    state.benchmarkDetailsByID.set(entry.conditionID, { ...entry, ID: entry.conditionID });
    registerPieEntries([entry]);
    renderPie(); renderBenchmarks(); scheduleSave();
    return true;
}

function openInlineFallbackPicker() {
    const primary = selectedInlineFallbackPrimary();
    if (primary && !state.loading && !isInlineFallbackEditing()) fallbackPicker.open(primary, { action: 'replace',
        getReturnFocus: () => inlineFallbackToggle });
}

inlineFallbackConfigurations.addEventListener('click', () => {
    if (isInlineFallbackEditing()) finishInlineFallbackEditing();
    openInlineFallbackPicker();
});

inlineFallbackEdit.addEventListener('click', () => beginInlineFallbackEditing());
inlineFallbackDone.addEventListener('click', finishInlineFallbackEditing);

addFallbackBenchmarkButton.addEventListener('click', () => {
    if (!activateInlineFallbackTarget()) return;
    if (window.matchMedia('(hover: hover)').matches) benchmarkSearch.focus({ preventScroll: true });
    benchmarkCard.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest' });
});

function addObjectToPersonalPie(object) {
    if (excludedFromRanking(object) || object.familyEntries?.some(excludedFromRanking)) {
        return false;
    }
    const existing = state.personalEntries.find(entry => Number(entry.conditionID) === Number(object.ID)
        || state.versionComposition && !isTopicReference(object) && !object.isFamily && entry.benchmarkID === object.benchmarkID);
    if (existing) {
        if (object.isFamily && familyKey(existing.conditionID, fallbackRuleFor(existing.conditionID)?.entries ?? []) !== object.familyKey) {
            if (!beginMutation()) return false;
            replaceFallbackRuleEntries(existing.conditionID, object.familyEntries);
            fallbackRuleFor(existing.conditionID).familyID = object.familyID;
            scheduleSave();
        }
        state.selectedObjectID = existing.conditionID;
        return true;
    }
    if (state.personalEntries.length >= state.limits.maxPieItems) {
        setStatus(`Personal Weights can contain up to ${state.limits.maxPieItems} entries`);
        return false;
    }
    if (!beginMutation()) return false;
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
        isPrimaryCondition: object.isPrimaryCondition,
        lowCoverage: object.lowCoverage,
        type: object.type,
        scoredModelCount: Number(object.scoredModelCount ?? 0),
        weightBasisPoints: initialWeight,
        weight: initialWeight / 100,
        ...(state.versionComposition && !isTopicReference(object) && !object.isFamily ? { followCommunityVersion: true } : {})
    };
    if (isTopicReference(object)) {
        Object.assign(newEntry, { referenceContextID: object.referenceContextID,
            categoryID: object.categoryID, topicName: object.topicName, sceneName: object.sceneName,
            sceneID: object.sceneID, url: object.url, description: object.description, isPrivate: object.isPrivate });
        delete newEntry.benchmarkID;
        delete newEntry.scoredModelCount;
    }
    state.personalEntries = [...existingEntries, newEntry];
    if (object.isFamily) {
        replaceFallbackRuleEntries(newEntry.conditionID, object.familyEntries);
        fallbackRuleFor(newEntry.conditionID).familyID = object.familyID;
    }
    hiddenPersonalBenchmarkIDs.delete(newEntry.conditionID);
    registerPieEntries([newEntry]);
    state.selectedObjectID = newEntry.conditionID;
    scheduleSave();
    if (!isTopicReference(newEntry)) additionToast.show('Added to Personal Weights.');
    return true;
}

function objectInPersonalPie(object) {
    const exists = state.personalEntries.some(entry => entry.conditionID === Number(object.ID)
        || object.isBenchmarkGroup && entry.benchmarkID === object.benchmarkID);
    return exists && (!object.isFamily || familyKey(Number(object.ID), fallbackRuleFor(object.ID)?.entries ?? []) === object.familyKey);
}

function removeObjectFromPersonalPie(object) {
    const objectID = Number(object.ID);
    if (!state.personalEntries.some(entry => Number(entry.conditionID) === objectID)) {
        return false;
    }
    if (!beginMutation()) {
        return false;
    }

    const removedIDs = new Set(state.personalEntries.filter(entry => entry.conditionID === objectID
        || object.isBenchmarkGroup && entry.benchmarkID === object.benchmarkID).map(entry => entry.conditionID));
    state.personalEntries = distributeToTarget(
        state.personalEntries.filter(entry => !removedIDs.has(entry.conditionID)),
        state.limits.totalBasisPoints
    );
    hiddenPersonalBenchmarkIDs.add(objectID);
    state.personalFallbackRules = state.personalFallbackRules.filter(rule => (
        !removedIDs.has(Number(rule.primaryConditionID))
    ));
    if (state.mode === 'personal' && Number(state.selectedObjectID) === objectID) {
        deactivateInlineFallbackTarget();
        state.selectedObjectID = state.personalEntries[0]?.conditionID ?? null;
        if (state.workspaceView === 'focus') {
            state.workspaceView = 'leaderboard';
        }
    }
    scheduleSave();
    return true;
}

let pendingBenchmarkFocus = null;
function renderBenchmarks() {
    // Keep the current list's geometry until its same-scope recovery is ready.
    if (state.loading && rankingRecovery?.snapshotID === state.rankingPagination?.snapshotID
        && rankingRecovery?.scope === rankingRecoveryScope() && rankingRecovery?.mode === state.mode) return;
    const scrollTop = benchmarkRows.scrollTop;
    const familyFocus = benchmarkRowFocus.captureFocus(benchmarkRows)
        ?? (document.activeElement === document.body ? pendingBenchmarkFocus : null);
    benchmarkRows.replaceChildren();
    referenceCoverage.begin();
    const personalControlsActive = state.mode === 'personal';
    benchmarkCard?.classList.toggle('has-personal-controls', personalControlsActive);
    const fallbackTargetActive = isInlineFallbackTargetActive();
    const fallbackPrimary = fallbackTargetActive ? selectedInlineFallbackPrimary() : null;
    const activeFallbackRule = fallbackPrimary ? fallbackRuleFor(fallbackPrimary.ID) : null;
    const activeFallbackConditionIDs = new Set((activeFallbackRule?.entries ?? []).map(entry => (
        Number(entry.conditionID)
    )));
    benchmarkCard?.classList.toggle('is-fallback-target-active', fallbackTargetActive);
    const canPinPersonal = personalControlsActive
        && state.personalEntries.length > 0;
    if (!canPinPersonal) {
        state.pinPersonalBenchmarks = false;
    }
    benchmarkPersonalPin.hidden = !canPinPersonal || fallbackTargetActive;
    benchmarkPersonalPin.disabled = !canPinPersonal || fallbackTargetActive;
    benchmarkPersonalPin.setAttribute('aria-pressed', String(state.pinPersonalBenchmarks));
    benchmarkPersonalPin.setAttribute(
        'aria-label',
        state.pinPersonalBenchmarks ? 'Stop pinning my benchmarks to the top' : 'Pin my benchmarks to the top'
    );
    benchmarkPersonalPin.dataset.tooltip = canPinPersonal
        ? state.pinPersonalBenchmarks ? 'Restore public-weight order' : 'Pin my benchmarks to the top'
        : 'Add benchmarks to Personal Weights to use this';
    if (state.loading) {
        const loading = document.createElement('div');
        loading.className = 'bp-loading-state';
        setLoading(loading, 'Loading benchmarks…');
        benchmarkRows.append(loading);
        return;
    }
    if (state.benchmarks.length === 0 && state.rankingPageLoading.benchmarks) {
        const loading = document.createElement('div');
        loading.className = 'bp-loading-state';
        setLoading(loading, 'Loading benchmarks…');
        benchmarkRows.append(loading);
        return;
    }
    const personalWeightsByID = new Map(state.personalEntries.map(entry => [
        Number(entry.conditionID),
        Number(entry.weight)
    ]));
    const personalWeightFor = object => object.isBenchmarkGroup ? object.personalWeight
        : object.isFamily && !objectInPersonalPie(object) ? null : personalWeightsByID.has(Number(object.ID))
        ? personalWeightsByID.get(Number(object.ID))
        : object.personalWeight;
    const availableObjects = state.mode === 'personal'
        ? state.benchmarks.filter(object => !hiddenPersonalBenchmarkIDs.has(Number(object.ID)))
        : state.benchmarks;
    const objects = (fallbackTargetActive ? availableObjects.filter(object => !isTopicReference(object)) : availableObjects).map(object => {
        if (!object.isBenchmarkGroup) return object;
        const entries = (state.mode === 'personal' ? state.personalEntries : state.publicEntries)
            .filter(entry => entry.benchmarkID === object.benchmarkID);
        const current = entries.find(entry => entry.conditionID === state.selectedObjectID) ?? entries[0];
        const personal = state.personalEntries.filter(entry => entry.benchmarkID === object.benchmarkID);
        const total = personal.reduce((sum, entry) => sum + entry.weightBasisPoints, 0);
        return { ...object, ...(current ? { ID: current.conditionID, conditionID: current.conditionID } : {}),
            personalWeight: personal.length ? total / 100 : null, personalWeightBasisPoints: personal.length ? total : null };
    });
    if (objects.length === 0 && !state.rankingPagination?.benchmarks.other.total
        && !state.rankingPagination?.benchmarks.lowCoverage.total) {
        if (state.benchmarks.length > 0 && state.rankingPagination?.benchmarks.primary.hasMore
            && !state.rankingPageError.benchmarks) {
            const loading = document.createElement('div');
            loading.className = 'bp-loading-state';
            setLoading(loading, 'Loading benchmarks…');
            benchmarkRows.append(loading);
            window.queueMicrotask(loadVisibleBenchmarkPage);
            return;
        }
        const empty = document.createElement('div');
        empty.className = 'bp-empty-state';
        empty.textContent = state.rankingPageError.benchmarks || (state.benchmarks.length > 0
            ? 'No other benchmarks in this view.'
            : 'No benchmarks found');
        benchmarkRows.append(empty);
        if (state.rankingPageError.benchmarks) {
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.textContent = 'Retry';
            retry.addEventListener('click', () => { void loadNextRankingPage('benchmarks'); });
            empty.append(retry);
        } else appendBenchmarkDiscoveryActions(empty);
    }

    const groupPages = currentBenchmarkPages();
    const hasOtherVersions = (groupPages?.other.total ?? 0) > 0;
    const lowCoverageRows = document.createElement('div');
    lowCoverageRows.id = 'benchmark-low-rows';
    lowCoverageRows.className = 'bp-benchmark-low-rows';
    const otherRows = document.createElement('div');
    otherRows.id = 'benchmark-other-rows';
    otherRows.className = 'bp-benchmark-low-rows';
    const hasPinnedObjects = state.pinPersonalBenchmarks
        && objects.some(object => (currentBenchmarkGroup(object) === 'primary'
            || (currentBenchmarkGroup(object) === 'other' && otherConditionsExpanded)
            || (currentBenchmarkGroup(object) === 'lowCoverage' && (!hasOtherVersions || otherConditionsExpanded) && lowCoverageExpanded))
            && objectInPersonalPie(object));
    let encounteredUnpinnedRow = false;
    const createRow = object => {
        const inPersonalPie = objectInPersonalPie(object);
        const pinned = !object.isFamily && state.pinPersonalBenchmarks && inPersonalPie;
        const row = document.createElement('div');
        row.className = 'bp-benchmark-row';
        row.dataset.conditionId = String(object.ID);
        if (isTopicReference(object)) row.dataset.contextId = String(object.referenceContextID);
        if (object.isFamily) row.dataset.familyKey = object.familyKey;
        row.classList.toggle('is-family', object.isFamily === true);
        const selected = !fallbackTargetActive && Number(state.selectedObjectID) === Number(object.ID)
            && (!object.isFamily || (state.mode === 'personal' ? inPersonalPie : state.selectedFamilyKey === object.familyKey));
        row.classList.toggle('selected', selected);
        row.classList.toggle('in-personal-pie', inPersonalPie && !fallbackTargetActive);
        row.classList.toggle('is-personal-pinned', pinned);
        row.classList.toggle('in-fallback-mix', activeFallbackConditionIDs.has(Number(object.ID)));
        row.classList.toggle('is-fallback-primary', Number(fallbackPrimary?.ID) === Number(object.ID));
        if (!object.isFamily && hasPinnedObjects && !pinned && !encounteredUnpinnedRow) {
            row.classList.add('after-personal-pinned');
            encounteredUnpinnedRow = true;
        }
        row.classList.toggle('is-muted', state.workspaceView === 'focus' && state.mode === 'personal' && !selected);
        row.setAttribute('role', 'group');
        const accessibleName = object.isFamily
            ? [benchmarkAccessibleName(object), ...object.familyEntries.map(benchmarkAccessibleName)].join(' → ')
            : benchmarkAccessibleName(object);
        row.setAttribute('aria-label', object.isFamily ? `Fallback configuration for ${accessibleName}` : `${isTopicReference(object) ? 'Topic' : 'Benchmark'} ${accessibleName}`);
        const hasWeight = state.mode === 'personal' ? inPersonalPie : Number(object.publicWeight) > 0;
        if (hasWeight) {
            row.tabIndex = 0;
            row.dataset.benchmarkControl = 'selection';
        }

        const rank = document.createElement('span');
        rank.className = 'bp-benchmark-rank';
        rank.textContent = object.isFamily ? '' : String(object.rank);

        let identity = document.createElement('span');
        identity.className = 'bp-benchmark-identity';
        const name = createBenchmarkInformationLink(object, { getURL: getBenchmarkMemberURL,
            onInspect: onBenchmarkInspection, className: 'bp-benchmark-name' });
        identity.append(name);
        const scoreCount = isTopicReference(object) ? referenceCoverage.create(object)
            : createEvidenceCount(object.scoreCount, { modelCount: object.isBenchmarkGroup ? undefined : object.scoredModelCount });
        scoreCount.classList.add('bp-benchmark-score-count');
        identity.append(scoreCount);
        identity.dataset.tooltip = isTopicReference(object) ? accessibleName
            : object.isBenchmarkGroup ? `${object.name}, ${object.scoreCount} approved scores across versions`
                : `${accessibleName}, ${object.scoreCount} approved scores from ${object.scoredModelCount} models`;

        const publicValue = document.createElement('span');
        publicValue.className = 'bp-benchmark-weight bp-benchmark-public-weight';
        publicValue.hidden = state.contextIsPrivate;
        publicValue.textContent = `${Number(object.publicWeight).toFixed(2)}%`;

        const personalWeight = personalWeightFor(object);
        const personalValue = document.createElement('span');
        personalValue.className = 'bp-benchmark-weight bp-benchmark-personal-weight';
        const personalWeightText = personalWeight === null ? '—' : `${Math.round(Number(personalWeight))}%`;
        personalValue.textContent = personalWeightText;

        const actionCell = document.createElement('span');
        actionCell.className = 'bp-benchmark-action-cell';
        if (personalControlsActive) {
            const alreadyAdded = fallbackTargetActive
                ? !object.isFamily && (activeFallbackConditionIDs.has(Number(object.ID)) || Number(fallbackPrimary?.ID) === Number(object.ID))
                : inPersonalPie;
            const unavailable = fallbackTargetActive && object.isFamily;
            if (!alreadyAdded && !unavailable) {
                const add = document.createElement('button'); add.type = 'button';
                add.className = 'bp-benchmark-add'; add.dataset.benchmarkControl = 'add';
                const missingReference = isTopicReference(object) && !object.hasWeights;
                const excluded = excludedFromRanking(object) || object.familyEntries?.some(excludedFromRanking) || missingReference;
                add.setAttribute('aria-disabled', String(Boolean(excluded)));
                const target = fallbackTargetActive ? 'Fallback' : 'Personal Weights';
                const label = `Add ${accessibleName} to ${target}`;
                const exclusionMessage = missingReference ? 'This topic has no weights yet.' : '';
                if (!excluded || exclusionMessage) add.dataset.tooltip = exclusionMessage || label;
                add.setAttribute('aria-label', exclusionMessage ? `${label}. ${exclusionMessage}` : label);
                add.innerHTML = '<i class="fa-solid fa-plus" aria-hidden="true"></i>';
                const addLabel = document.createElement('span');
                addLabel.className = 'bp-benchmark-add-label';
                addLabel.textContent = 'Add';
                const addTarget = document.createElement('span');
                addTarget.className = 'bp-benchmark-add-target';
                addTarget.textContent = fallbackTargetActive ? ' to Fallback' : ' to Pie';
                addLabel.append(addTarget);
                add.append(addLabel);
                add.addEventListener('click', event => {
                    event.stopPropagation();
                    if (excluded) { if (exclusionMessage) setStatus(exclusionMessage); return; }
                    if (isInlineFallbackTargetActive()) {
                        addObjectToFallbackChain(object);
                        return;
                    }
                    if (!addObjectToPersonalPie(object)) return;
                    focusPersonalBenchmark(object);
                });
                row.classList.add('has-add-action');
                actionCell.append(add);
            }
        }

        if (personalControlsActive && inPersonalPie && !fallbackTargetActive) {
            if (object.isFamily) {
                const applied = document.createElement('span');
                applied.className = 'bp-benchmark-applied';
                applied.setAttribute('role', 'img');
                applied.setAttribute('aria-label', `Applied fallback configuration for ${accessibleName}`);
                applied.dataset.tooltip = 'Applied to Personal Weights';
                applied.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i>';
                actionCell.append(applied);
            } else {
                actionCell.classList.add('has-personal-remove');
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'bp-personal-weight-remove';
                remove.dataset.benchmarkControl = 'remove';
                remove.dataset.tooltip = 'Remove from Personal Weights';
                remove.setAttribute('aria-label', `Remove ${accessibleName} from Personal Weights`);
                remove.innerHTML = '<i class="fa-regular fa-trash-can" aria-hidden="true"></i>';
                remove.addEventListener('click', event => {
                    event.stopPropagation();
                    if (!removeObjectFromPersonalPie(object)) return;
                    renderAll();
                });
                actionCell.append(remove);
            }
        }

        row.addEventListener('click', event => {
            if (event.defaultPrevented || event.target.closest('a, button')
                || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            onBenchmarkActivation(event, object);
        });
        row.addEventListener('keydown', event => {
            if (event.target !== row || (event.key !== 'Enter' && event.key !== ' ')) return;
            event.preventDefault();
            onBenchmarkActivation(event, object);
        });
        row.append(rank, identity, personalValue, publicValue);
        if (actionCell.childElementCount) row.append(actionCell);
        return row;
    };
    objects.forEach(object => {
        const entry = document.createElement('div'); entry.className = 'bp-benchmark-entry';
        entry.append(createRow(object));
        const group = currentBenchmarkGroup(object);
        if (group === 'lowCoverage') lowCoverageRows.append(entry);
        else if (group === 'other') otherRows.append(entry);
        else benchmarkRows.append(entry);
    });
    const appendPageFooter = (container, group) => {
        const page = groupPages?.[group];
        const key = benchmarkPageKey(group);
        if (!page?.hasMore && !state.rankingPageError[key]) return;
        const footer = document.createElement('div');
        footer.className = 'bp-ranking-page-footer';
        footer.dataset.benchmarkGroup = group;
        if (state.rankingPageLoading[key]) setLoading(footer, 'Loading benchmarks');
        else footer.textContent = state.rankingPageError[key] || '';
        if (!state.rankingPageLoading[key]) {
            const more = document.createElement('button');
            more.type = 'button';
            more.textContent = state.rankingPageError[key] ? 'Retry' : 'Load more';
            more.addEventListener('click', () => { void loadNextRankingPage('benchmarks', group); });
            footer.append(more);
        }
        container.append(footer);
    };
    appendPageFooter(benchmarkRows, 'primary');
    for (const group of ['lowCoverage', 'other']) {
        if (group === 'other' && !hasOtherVersions) continue;
        const count = (groupPages?.[group].total ?? 0) + (group === 'other' ? groupPages?.lowCoverage.total ?? 0 : 0);
        if (!count) continue;
        const rows = group === 'other' ? otherRows : lowCoverageRows;
        const expanded = group === 'other' ? otherConditionsExpanded : lowCoverageExpanded;
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'bp-benchmark-low-toggle';
        toggle.setAttribute('aria-controls', rows.id);
        toggle.setAttribute('aria-expanded', String(expanded));
        const title = document.createElement('span');
        title.textContent = `${count} ${group === 'other' ? 'other' : 'lower-coverage'} benchmark ${count === 1 ? 'version' : 'versions'}`;
        toggle.append(title);
        mountDisclosureChevron(toggle);
        const help = document.createElement('button');
        help.type = 'button';
        help.className = 'bp-coverage-help';
        help.setAttribute('aria-label', `About ${group === 'other' ? 'other' : 'lower-coverage'} benchmark versions`);
        setHelpText(help, group === 'other' ? 'More versions of the same tests. You can inspect or add any of them.'
            : 'These versions have far fewer scores than another version of the same benchmark. You can still inspect and add them.');
        help.innerHTML = '<i class="fa-regular fa-circle-question" aria-hidden="true"></i>';
        const controls = document.createElement('div'); controls.className = 'bp-benchmark-low-controls';
        controls.append(toggle, help);
        toggle.addEventListener('click', () => {
            const nextExpanded = !(group === 'other' ? otherConditionsExpanded : lowCoverageExpanded);
            if (group === 'other') otherConditionsExpanded = nextExpanded;
            else lowCoverageExpanded = nextExpanded;
            toggle.setAttribute('aria-expanded', String(nextExpanded));
            if (nextExpanded) {
                void setVisible(rows, true, { collapse: true }).then(() => {
                    if ((group === 'other' ? otherConditionsExpanded : lowCoverageExpanded) && rows.isConnected) {
                        renderBenchmarks();
                        void loadNextRankingPage('benchmarks', group);
                    }
                });
            }
            else void setVisible(rows, false, { collapse: true }).then(() => {
                if (!(group === 'other' ? otherConditionsExpanded : lowCoverageExpanded) && rows.isConnected) renderBenchmarks();
            });
        });
        const parent = group === 'other' || !hasOtherVersions ? benchmarkRows : otherRows;
        parent.append(controls);
        rows.hidden = !expanded;
        if (group === 'other') {
            const footer = document.createElement('div');
            appendPageFooter(footer, group);
            const nested = rows.querySelector('.bp-benchmark-low-controls');
            if (footer.firstChild) rows.insertBefore(footer.firstChild, nested);
        } else appendPageFooter(rows, group);
        parent.append(rows);
    }
    benchmarkRows.scrollTop = scrollTop;
    pendingBenchmarkFocus = document.body.classList.contains('discussion-open')
        || benchmarkRowFocus.restoreFocus(benchmarkRows, familyFocus) ? null : familyFocus;
    window.queueMicrotask(loadVisibleBenchmarkPage);
}

function renderModeState() {
    personalPieStart.refresh();
    const choosingStart = personalPieStart.isOpen;
    pieCard.classList.toggle('is-starting-personal-weights', choosingStart);
    renderReferenceState();
    const personal = state.mode === 'personal';
    const indexTitle = personal ? 'Personal AI Index' : 'Public AI Index';
    modelIndexHeading.textContent = indexTitle;
    modelIndexTab.textContent = 'AI Index';
    modelIndexTab.setAttribute('aria-label', indexTitle);
    if (workspaceHeadline.dataset.mode !== state.mode) {
        workspaceHeadline.dataset.mode = state.mode;
        headlineVariants.forEach(variant => { variant.hidden = variant.dataset.headlineMode !== state.mode; });
        animateContent(workspaceHeadline, { translate: false });
    }
    document.body.classList.toggle('bp-private-category', state.contextIsPrivate);
    const storageWarning = !state.guestDraftStorageAvailable && state.personalSavePending;
    guestDraftNotice.hidden = !state.usingGuestDraft && !state.legacyDraftAvailable
        && !state.personalRecoveryBlocked && !state.personalDraftUnavailable && !storageWarning;
    if (!guestDraftNotice.hidden) {
        guestDraftMessage.textContent = state.personalRecoveryBlocked
            ? state.personalSaveError || 'This stored draft cannot be safely restored. Discard it or refresh to review it.'
            : state.personalDraftUnavailable
                ? 'Your draft is kept, but its ranking could not be previewed. Retry or discard it.'
            : state.legacyDraftAvailable
                ? 'An older draft in this tab has no account information. Recover it only if it is yours.'
            : !state.guestDraftStorageAvailable
                ? 'Browser storage is unavailable. Keep this tab open until your changes are saved.'
            : state.recoveredPersonalDraft
                ? state.personalSaveRequest
                    ? 'Your changes were recovered. Confirm the earlier save before saving newer edits.'
                    : 'Your changes were recovered. Review this mix before replacing your saved weights.'
            : state.authenticated
            ? state.hasSavedPersonalWeights
                ? 'This preview is not saved. Saving will replace your weights for this topic or scene.'
                : 'This preview is not saved to your account yet.'
            : state.guestDraftStorageAvailable
                ? 'This preview is temporary. Sign in to save your weights.'
                : 'This preview is temporary and may be lost if this tab closes.';
        guestDraftSave.textContent = state.personalDraftUnavailable ? 'Retry preview'
            : state.legacyDraftAvailable ? 'Recover my draft'
            : state.recoveredPersonalDraft ? 'Confirm and save'
            : state.authenticated ? 'Save this mix' : 'Sign in to save';
        guestDraftSave.hidden = state.personalRecoveryBlocked || storageWarning && !state.usingGuestDraft;
        guestDraftSave.disabled = state.loading || state.saving || !state.guestDraftStorageAvailable && !state.authenticated;
        guestDraftDiscard.hidden = !state.authenticated && !state.legacyDraftAvailable;
    }
    personalPieGuidance.hidden = false;
    publicPieSummary.hidden = personal || choosingStart;
    publicPieCount.textContent = `${state.publicParticipantCount.toLocaleString('en-US')} saved weight ${state.publicParticipantCount === 1 ? 'set' : 'sets'}`;
    const hasPersonalWeights = state.personalEntries.length > 0;
    const emptyPie = !state.loading && currentPieEntries().length === 0 && !personalPieStart.previewPublic;
    pieCard.classList.toggle('has-empty-pie', emptyPie);
    pieCard.classList.toggle('has-mode-selector', (hasPersonalWeights || personal || choosingStart) && !state.contextIsPrivate);
    compactPieMessage.textContent = personal ? 'Add a benchmark or topic to start your index.' : 'No public weights for this topic or scene yet.';
    compactPieAction.hidden = personal;
    compactPieAction.textContent = hasPersonalWeights ? 'View your personal weights' : 'Create personal weights';
    pieSvg.style.touchAction = personal && state.personalEntries.length > 1 ? 'pan-x' : 'pan-x pan-y';
    const showCreatePersonal = !state.loading && !hasPersonalWeights && !personal;
    const showEmptyPersonal = !state.loading && !hasPersonalWeights && personal && !personalPieStart.previewPublic;
    pieSvg.toggleAttribute('hidden', showEmptyPersonal);
    personalPieEmpty.hidden = !showEmptyPersonal;
    pieCard.classList.toggle('has-empty-personal-pie', showEmptyPersonal);
    personalPieGuidance.hidden = emptyPie;
    modeSwitch.hidden = state.contextIsPrivate || !hasPersonalWeights && !personal && !choosingStart;
    personalPieCreate.hidden = !showCreatePersonal || choosingStart;
    pieCard.classList.toggle('has-personal-create-cta', showCreatePersonal);
    modeSwitch?.classList.toggle('is-public', !personal);
    personalModeButton.classList.toggle('selected', personal);
    publicModeButton.classList.toggle('selected', !personal);
    personalModeButton.setAttribute('aria-selected', String(personal));
    publicModeButton.setAttribute('aria-selected', String(!personal));
    renderSelectedWeightHeading();
    updatePieAdjustmentStatus();
    updateUndoState();
    publishContextWeights();
}

function renderSelectedWeightHeading() {
    const entries = currentPieEntries();
    const selected = entries.find(entry => Number(entry.conditionID) === Number(state.selectedObjectID)) ?? entries[0];
    personalPieGuidance.hidden = !selected || personalPieStart.isOpen;
    if (isTopicReference(selected)) renderTopicLabel(pieInstruction, topicLabelText(selected));
    else pieInstruction.textContent = selected ? benchmarkAccessibleName(selected) : '';
    if (selected && !isTopicReference(selected) && typeof selected.scoredModelCount === 'number') {
        updateEvidenceCount(pieModelCount, selected.scoredModelCount, { kind: 'models' });
        if (pieModelCount.parentElement !== pieContextNote) pieContextNote.replaceChildren(pieModelCount);
    } else pieContextNote.replaceChildren();
}

function renderReferenceState() {
    const personal = state.mode === 'personal';
    const actions = document.getElementById('weight-add-actions');
    actions.hidden = !personal;
    for (const button of actions.querySelectorAll('button')) button.disabled = state.loading;
    renderTopicReferences(document.getElementById('topic-reference-weights'), {
        entries: currentPieEntries(), issues: state.referenceIssues[state.mode], effectiveEntries: state.effectiveEntries[state.mode],
        dirty: personal && state.personalRankingDirty, personal, selectedID: state.selectedObjectID,
        onSelect: object => selectWeightedBenchmark({ ...object, publicWeight: object.weightBasisPoints / 100 }, { toggle: true }),
        onRemove: async object => {
            const scope = workspaceContextFingerprint();
            if (state.loading || !await finishPendingWeightAdjustments() || scope !== workspaceContextFingerprint()) return;
            removeObjectFromPersonalPie(object);
        }
    });
}

function publishContextWeights() {
    window.dispatchEvent(new CustomEvent('benchpoll:context-weights', { detail: {
        categoryID: state.categoryID, categoryPath: state.categoryPath, categoryName: state.topicName,
        contextValues: { ...state.selectedContextValues },
        isPrivate: state.contextIsPrivate, mode: state.mode,
        personal: state.personalEntries.map(entry => ({ conditionID: entry.conditionID, weightBasisPoints: entry.weightBasisPoints })),
        public: state.publicEntries.map(entry => ({ conditionID: entry.conditionID, weightBasisPoints: entry.weightBasisPoints }))
    } }));
}

let modeSwitchSequence = 0;
let pendingPieMode = null;
let workspaceSettledResolvers = [];
let workspaceLoadFailed = false;
function notifyWorkspaceSettled() {
    if (state.loading) return;
    const resolvers = workspaceSettledResolvers;
    workspaceSettledResolvers = [];
    resolvers.forEach(resolve => resolve());
}
function waitForWorkspace() {
    return state.loading ? new Promise(resolve => workspaceSettledResolvers.push(resolve)) : Promise.resolve();
}
function renderPendingPieMode() {
    for (const [mode, button] of [['personal', personalModeButton], ['public', publicModeButton]]) {
        const pending = mode === pendingPieMode;
        button.setAttribute('aria-busy', String(pending));
        button.querySelector('.bp-pie-mode-loading').hidden = !pending;
    }
    document.getElementById('pie-mode-status').textContent = pendingPieMode
        ? `Loading ${pendingPieMode === 'personal' ? 'Personal' : 'Public'} Weights` : '';
}
async function setMode(mode) {
    if (personalPieStart.isOpen) personalPieStart.close({ restore: false });
    const sequence = ++modeSwitchSequence;
    const requestedMode = mode === 'public' && !state.contextIsPrivate ? 'public' : 'personal';
    if (requestedMode === state.mode) {
        pendingPieMode = null; renderPendingPieMode();
        if (requestedMode === 'personal' && needsPersonalStart()) await openPersonalStart(personalModeButton);
        return;
    }
    const contextFingerprint = state.pieContextFingerprint;
    pendingPieMode = requestedMode;
    renderPendingPieMode();
    try {
        if (!await finishPendingWeightAdjustments() || !await flushPendingPersonalPieSave()) {
            setStatus('Your weight change was not saved. Try switching again.');
            return;
        }
        await waitForWorkspace();
        if (sequence !== modeSwitchSequence || contextFingerprint && contextFingerprint !== state.pieContextFingerprint) return;
        if (workspaceLoadFailed) { setStatus('Could not load these weights. Refresh to retry.'); return; }
        if (state.rankingPagination?.[requestedMode]?.hasMore && state.modelLeaderboards[requestedMode].length === 0) {
            await loadNextRankingPage(requestedMode);
        }
        await document.fonts.ready;
        if (sequence !== modeSwitchSequence || contextFingerprint && contextFingerprint !== state.pieContextFingerprint) return;
        if (requestedMode === 'personal' && needsPersonalStart()) await openPersonalStart(personalModeButton);
        else applyPieMode(requestedMode);
    } catch (error) {
        if (sequence === modeSwitchSequence) setStatus('Could not switch weights. Please try again.');
        console.error('[BenchPoll] Weight switch failed', error);
    } finally {
        if (sequence === modeSwitchSequence) { pendingPieMode = null; renderPendingPieMode(); }
    }
}
function applyPieMode(mode, { animate = true } = {}) {
    const previousMode = state.mode;
    const previousPie = pieSvg.cloneNode(true);
    deactivateInlineFallbackTarget();
    state.mode = mode === 'public' && !state.contextIsPrivate ? 'public' : 'personal';
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
    if (animate && state.mode !== previousMode) {
        void flipPie(pieSvg, previousPie, { from: previousMode, to: state.mode });
    }
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
    modelCard?.setAttribute('aria-busy', String(state.loading || state.comparisonPending
        || state.mode === 'personal' && state.personalRankingDirty && !state.personalRankingError));
    notifyWorkspaceSettled();
    if (!state.loading && state.categoryID !== null && state.rankingPagination) {
        const startContext = `${workspaceContextFingerprint()}|${state.userID ?? 'guest'}`;
        const enteredContext = startContext !== personalStartContext;
        personalStartContext = startContext;
        if (enteredContext && state.mode === 'personal' && needsPersonalStart()) void openPersonalStart(personalModeButton);
    }
}

function applyServerWorkspace(payload, {
    preserveUndo = true,
    personalSave = false,
    usingGuestDraft = false,
    recoveryRecord = null,
    legacyDraftAvailable = false,
    restoringRankingProgress = false,
    savedPersonalWeights = payload.personalPie.entries.length > 0 && !payload.personalPie.isDraft
} = {}) {
    if (state.userID !== null && payload.userID !== state.userID) throw accountWriteError();
    if (!preserveUndo) state.editHistory.clear();
    const nextContextFingerprint = workspaceContextFingerprint(
        payload.context.categoryID,
        payload.context.contextValues
    );
    const contextChanged = state.pieContextFingerprint !== nextContextFingerprint;
    if (contextChanged) {
        state.editHistory.clear();
        hiddenPersonalBenchmarkIDs.clear();
        resetPieVisualState();
        state.pieContextFingerprint = nextContextFingerprint;
        state.workspaceView = 'overview';
    }
    state.authenticated = Boolean(payload.authenticated);
    state.userID = payload.userID;
    state.usingGuestDraft = usingGuestDraft;
    state.hasSavedPersonalWeights = savedPersonalWeights;
    state.guestPreviewError = false;
    state.personalRankingDirty = false;
    state.personalRankingError = '';
    state.rankingVersion += 1;
    state.personalSavePending = false;
    state.personalSaveRequest = null;
    state.personalSaveError = '';
    state.personalSaveConflict = false;
    state.personalRankingRefreshNeeded = false;
    state.personalDraftUnavailable = false;
    state.legacyDraftAvailable = legacyDraftAvailable;
    state.categoryID = Number(payload.context.categoryID);
    state.categoryPath = String(payload.context.categoryPath || '');
    state.topicName = String(payload.context.categoryName ?? payload.context.lineage?.at(-1)?.name ?? state.topicName ?? '');
    state.topicSummary = String(payload.context.description ?? '');
    state.topicCreator = payload.context.creator ?? null;
    state.contextIsPrivate = payload.context.isPrivate === true;
    state.scenes = (payload.context.scenes ?? []).map(scene => ({ ...scene }));
    state.sceneID = payload.context.sceneID ?? null;
    state.contextID = Number(payload.context.ID ?? payload.context.contextID ?? state.sceneID) || null;
    if (state.contextIsPrivate) state.mode = 'personal';
    state.selectedContextValues = { ...payload.context.contextValues };
    state.dimensions = payload.context.dimensions.map(dimension => ({
        ...dimension,
        options: dimension.options.map(option => ({ ...option }))
    }));
    state.personalRevision = Number(payload.personalPie.revision);
    state.personalIsDraft = Boolean(payload.personalPie.isDraft);
    state.personalEntries = cloneEntries(payload.personalPie.entries);
    state.personalFallbackRules = cloneFallbackRules(payload.personalPie.fallbackRules);
    state.publicEntries = cloneEntries(payload.publicPie.entries);
    state.referenceIssues = { personal: structuredClone(payload.personalPie.referenceIssues ?? []), public: structuredClone(payload.publicPie.referenceIssues ?? []) };
    state.effectiveEntries = { personal: structuredClone(payload.personalPie.effectiveEntries ?? null), public: structuredClone(payload.publicPie.effectiveEntries ?? null) };
    state.publicFamilyComposition = structuredClone(payload.publicPie.familyComposition);
    state.personalCommunityComposition = structuredClone(payload.personalPie.communityFallbackComposition ?? []);
    state.versionComposition = payload.versionComposition ? structuredClone(payload.versionComposition) : null;
    state.communityFallbackComposition = structuredClone(payload.communityFallbackComposition ?? []);
    registerPieEntries(state.personalEntries);
    registerPieEntries(state.publicEntries);
    state.publicParticipantCount = payload.publicPie.participantCount;
    state.publicIsFallback = Boolean(payload.publicPie.isFallback);
    invalidateRankingPages();
    state.rankingPagination = payload.rankingPagination;
    benchmarkFallbackCatalogue.setSnapshot(payload.rankingPagination.snapshotID, { contextChanged,
        restoredPages: payload.rankingPagination.fallbacks ?? [] });
    if (contextChanged || !restoringRankingProgress) {
        lowCoverageExpanded = false;
        otherConditionsExpanded = false;
    }
    state.scoreMode = payload.scoreMode;
    renderScoringControls();
    state.benchmarks = payload.benchmarks.map(object => ({ ...object }));
    state.benchmarkDetailsByID = new Map(state.benchmarks.filter(object => !object.isFamily).map(object => [Number(object.ID), object]));
    for (const version of state.versionComposition?.flatMap(group => group.versions) ?? []) {
        state.benchmarkDetailsByID.set(version.conditionID, { ...version, ID: version.conditionID });
    }
    for (const entry of [...state.personalEntries, ...state.publicEntries]) {
        if (!state.benchmarkDetailsByID.has(Number(entry.conditionID))) {
            state.benchmarkDetailsByID.set(Number(entry.conditionID), { ...entry, ID: Number(entry.conditionID) });
        }
    }
    state.comparison = payload.comparison;
    comparisonControls.render(payload.comparison);
    const requestedComparison = state.comparisonRequest ?? { mode: 'best', keys: ['model'] };
    if (comparisonProfileKey(payload.comparison) === comparisonProfileKey({ ...requestedComparison, filters: requestedComparison.filters ?? [] })) {
        state.comparisonPending = false;
    }
    state.modelLeaderboards = {
        personal: payload.modelLeaderboards.personal.map(model => ({ ...model })),
        public: payload.modelLeaderboards.public.map(model => ({ ...model }))
    };
    if (contextChanged) {
        benchmarkRows.scrollTop = 0;
        modelRows.scrollTop = 0;
    }
    state.scoreScale = { ...payload.scoreScale };
    state.limits = { ...payload.limits };
    state.serverPersonalEntries = cloneEntries(state.personalEntries);
    state.serverPersonalFallbackRules = cloneFallbackRules(state.personalFallbackRules);
    pieRecovery.bind(recoveryRecord);
    state.lastLoadTime = Date.parse(payload.serverTime) || Date.now();
    state.statusMessage = '';
    const currentEntries = currentPieEntries();
    if (!currentEntries.some(entry => Number(entry.conditionID) === Number(state.selectedObjectID))) {
        state.selectedObjectID = currentEntries[0]?.conditionID ?? null;
    }
    if (state.workspaceView === 'focus' && state.selectedObjectID !== null) {
        window.queueMicrotask(() => revealBenchmarkRow(state.selectedObjectID));
    }
    syncContextValuesToURL();
    updateDiscussionEntry(state.categoryID, state.selectedContextValues, state.contextIsPrivate);
    navigationChannel.publish({
        context: payload.context,
        userID: payload.userID ?? null,
        authenticated: state.authenticated,
        hasPersonalWeights: state.hasSavedPersonalWeights,
        personalSave
    });
}

function workspaceLoadErrorMessage(error) {
    if (topicReferenceError(error)) return topicReferenceError(error);
    if (isAccountWriteError(error)) return 'Your account changed. Refresh this page before saving.';
    if (error?.code === 'comparison_profiles_unavailable') return error.message;
    if (error?.code === 'invalid_workspace_response') {
        return error.message;
    }
    if (error?.payload?.error === 'category_not_found') {
        return 'This topic no longer exists';
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
    return 'Could not load this ranking. Please retry.';
}

function renderLoadError(error) {
    state.workspaceLoadError = error;
    const accountChanged = isAccountWriteError(error);
    if (accountChanged) state.accountWriteBlocked = true;
    state.loading = false;
    clearRankingStatus();
    workspaceLoadFailed = true;
    invalidateRankingPages();
    benchmarkCard?.setAttribute('aria-busy', 'false');
    modelCard?.setAttribute('aria-busy', 'false');
    notifyWorkspaceSettled();
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
        retry.textContent = accountChanged ? 'Refresh page' : 'Retry';
        retry.addEventListener('click', () => accountChanged ? window.location.reload()
            : loadWeightedWorkspace({ retryProfiles: Boolean(comparisonProfileFailure) }));
        errorState.append(text, retry);
        container.append(errorState);
    });
    setStatus(message);
}

async function loadWeightedWorkspace({ resetTemplates = false, retryAttempt = 0, preserveUndo = false, comparisonChange = false, retryProfiles = false, pageRecovery = null, legacyClaim = false } = {}) {
    const sequence = ++state.loadSequence;
    if (typeof modelFocus !== 'undefined') modelFocus.suspend();
    benchmarkFallbackCatalogue.invalidate();
    if (retryProfiles && comparisonProfileFailure) loadComparisonProfiles();
    const profilesReady = await comparisonProfilesReady;
    if (sequence !== state.loadSequence) return;
    if (!profilesReady) { renderLoadError(comparisonProfileFailure); return; }
    if ((pendingFallbackSave || state.personalSavePending) && !await flushPendingPersonalPieSave()) return;
    const adjustmentsSaved = await finishPendingWeightAdjustments();
    if (sequence !== state.loadSequence || (!adjustmentsSaved && !comparisonChange)) return;
    if (state.saving && state.savePromise) {
        await state.savePromise.catch(() => {});
    }
    if (sequence !== state.loadSequence) return;
    invalidateRankingPages();
    state.loading = true;
    state.workspaceLoadError = null;
    workspaceLoadFailed = false;
    state.statusMessage = '';
    renderAll();
    const requestedContextValues = resetTemplates
        ? {}
        : { ...state.selectedContextValues };
    const requestedBenchmarkQuery = benchmarkSearch.value.trim();
    const requestedPinPersonal = state.pinPersonalBenchmarks;
    const requestedCategoryID = state.categoryID;
    const requestedComparison = structuredClone(state.comparisonRequest);
    const requestedScoreMode = state.scoreMode;
    const requestedInferenceVersion = state.availableInferenceVersion;
    const requestedAlgorithm = normalizeEstimationAlgorithm(state.estimationAlgorithm);
    const requestedMode = state.mode;
    const requestedURLSearch = window.location.search;
    const resume = !resetTemplates && pageRecovery?.snapshotID && pageRecovery.snapshotID === state.rankingPagination?.snapshotID
        && pageRecovery.scope === rankingRecoveryScope() ? pageRecovery.resume : null;
    let verifiedReadOwner;
    const requestWorkspace = async body => {
        const payload = validateWorkspacePayload(await postJSON('/api/get_weighted_workspace', {
            ...body, availableInferenceVersion: requestedInferenceVersion,
            ...estimationRequest(requestedAlgorithm),
            ...comparisonControls.requestOptions?.(), ...(resume ? { rankingResume: resume } : {})
        }, { timeoutMs: 60000 }), { resume, initialMode: body.initialMode });
        if (normalizeEstimationAlgorithm(payload.estimationAlgorithm) !== requestedAlgorithm) {
            throw Object.assign(new Error('The ranking did not use the selected test algorithm. Please retry.'), { status: 422 });
        }
        if (verifiedReadOwner === undefined) verifiedReadOwner = payload.userID;
        else if (payload.userID !== verifiedReadOwner) throw accountWriteError();
        return payload;
    };
    try {
        let payload = await requestWorkspace({
            categoryID: requestedCategoryID,
            contextValues: requestedContextValues,
            comparison: requestedComparison,
            scoreMode: requestedScoreMode,
            initialMode: requestedMode,
            benchmarkQuery: requestedBenchmarkQuery,
            pinPersonal: requestedPinPersonal
        });
        if (sequence !== state.loadSequence) return;
        if (state.userID !== null && payload.userID !== state.userID) throw accountWriteError();
        if (!resetTemplates) {
            const URLContextValues = readRankingContext(requestedURLSearch, payload.context.dimensions);
            const resolvedContextValues = payload.context.scenes !== undefined
                ? Object.keys(requestedContextValues).length ? requestedContextValues
                    : Object.keys(URLContextValues).length ? URLContextValues : payload.context.contextValues
                : {
                ...payload.context.contextValues,
                ...URLContextValues,
                ...requestedContextValues
            };
            if (!sameContextValues(resolvedContextValues, payload.context.contextValues)) {
                payload = await requestWorkspace({
                    categoryID: requestedCategoryID,
                    contextValues: resolvedContextValues,
                    comparison: requestedComparison,
                    scoreMode: requestedScoreMode,
                    initialMode: requestedMode,
                    benchmarkQuery: requestedBenchmarkQuery,
                    pinPersonal: requestedPinPersonal
                });
                if (sequence !== state.loadSequence) return;
            }
        }
        const draftKey = workspaceContextFingerprint(payload.context.categoryID, payload.context.contextValues);
        const recoveryRecord = payload.authenticated
            ? pieRecovery.lookup(payload.userID, Number(payload.context.categoryID), payload.context.contextValues,
                { revision: payload.personalPie.revision }) : null;
        const legacyDraft = !recoveryRecord && legacyClaim ? guestDrafts.getLegacy(draftKey) : null;
        const guestDraft = recoveryRecord ? recoveryRecord.value?.draft ?? null : guestDrafts.get(draftKey) ?? legacyDraft;
        const savedPersonalWeights = payload.personalPie.entries.length > 0;
        let draftUnavailable = false;
        if (guestDraft) {
            try {
                payload = await requestWorkspace({
                    categoryID: payload.context.categoryID,
                    contextValues: payload.context.contextValues,
                    comparison: requestedComparison,
                    scoreMode: requestedScoreMode,
                    previewPersonalPie: guestDraft,
                    initialMode: requestedMode,
                    benchmarkQuery: requestedBenchmarkQuery,
                    pinPersonal: requestedPinPersonal
                });
                if (sequence !== state.loadSequence) return;
            } catch (error) {
                if (sequence !== state.loadSequence) return;
                if (![400, 404].includes(error.status) || error.payload?.error !== 'pie_benchmark_condition_not_found') throw error;
                draftUnavailable = true;
            }
        }
        if (sequence !== state.loadSequence) {
            return;
        }
        state.loading = false;
        applyServerWorkspace(payload, {
            preserveUndo,
            usingGuestDraft: Boolean(guestDraft) && !draftUnavailable,
            recoveryRecord,
            legacyDraftAvailable: !guestDraft && !recoveryRecord && Boolean(guestDrafts.getLegacy(draftKey)),
            savedPersonalWeights,
            restoringRankingProgress: Boolean(resume)
        });
        state.personalDraftUnavailable = draftUnavailable;
        if (draftUnavailable && recoveryRecord) state.personalRecoveryBlocked = true;
        if (legacyDraft && !draftUnavailable) {
            state.recoveredPersonalDraft = state.authenticated;
            if (recordPersonalDraft() && state.guestDraftStorageAvailable) guestDrafts.discardLegacy(draftKey, legacyDraft);
        }
        renderAll();
        if (typeof modelFocus !== 'undefined') void modelFocus.reveal();
        if (requestedBenchmarkQuery !== benchmarkSearch.value.trim()
            || requestedPinPersonal !== state.pinPersonalBenchmarks) {
            reloadBenchmarkPage();
        }
        if (draftUnavailable) setStatus('Your draft refers to a benchmark that is no longer available. It is kept until you discard it.');
        else if (!adjustmentsSaved) setStatus('Your change was not saved');
        else if (comparisonProfileLoadError) setStatus(comparisonProfileLoadError);
    } catch (error) {
        if (sequence !== state.loadSequence) {
            return;
        }
        if (invalidSavedComparison(error)) {
            await recoverComparison(error);
            if (sequence !== state.loadSequence) return;
            await loadWeightedWorkspace({ resetTemplates, preserveUndo, comparisonChange, pageRecovery, legacyClaim });
            return;
        }
        const retryDelay = WORKSPACE_LOAD_RETRY_DELAYS_MS[retryAttempt];
        if (retryDelay !== undefined && (!error.status || error.status >= 500)) {
            state.loading = true;
            setStatus('Connection interrupted - retrying...');
            await new Promise(resolve => window.setTimeout(resolve, retryDelay));
            if (sequence === state.loadSequence) {
                    await loadWeightedWorkspace({ resetTemplates, retryAttempt: retryAttempt + 1, preserveUndo, comparisonChange, pageRecovery, legacyClaim });
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

async function previewGuestPersonalPie() {
    if (state.persistPromise) return state.persistPromise;
    recordPersonalDraft();
    const contextFingerprint = workspaceContextFingerprint();
    const usingGuestDraft = state.usingGuestDraft;
    const savedPersonalWeights = state.hasSavedPersonalWeights;
    const task = (async () => {
        state.saving = true;
        state.guestPreviewError = false;
        setStatus('');
        renderModeState();
        updateUndoState();
        try {
            while (true) {
                const editVersion = state.personalEditVersion;
                const requestedBenchmarkFilters = currentBenchmarkFilters();
                try {
                    state.savePromise = postJSON('/api/get_weighted_workspace', {
                        categoryID: state.categoryID,
                        contextValues: state.selectedContextValues,
                        comparison: state.comparisonRequest,
                        scoreMode: state.scoreMode,
                        availableInferenceVersion: state.availableInferenceVersion,
                        ...estimationRequest(state.estimationAlgorithm),
                        previewPersonalPie: portablePersonalPie(),
                        initialMode: state.mode,
                        ...requestedBenchmarkFilters
                    }, { timeoutMs: 60000 });
                    const payload = validateWorkspacePayload(await state.savePromise);
                    if (contextFingerprint !== workspaceContextFingerprint()) return true;
                    await waitForGestureToSettle();
                    if (contextFingerprint !== workspaceContextFingerprint()) return true;
                    if (editVersion !== state.personalEditVersion) {
                        recordPersonalDraft();
                        continue;
                    }
                    const recoveryRecord = state.recoveredPersonalDraft
                        ? pieRecovery.lookup(state.userID, state.categoryID, state.selectedContextValues) : null;
                    applyServerWorkspace(payload, { usingGuestDraft, savedPersonalWeights, recoveryRecord });
                    renderAll();
                    refreshChangedBenchmarkFilters(requestedBenchmarkFilters);
                    return true;
                } catch (error) {
                    if (contextFingerprint !== workspaceContextFingerprint()) return true;
                    await waitForGestureToSettle();
                    if (contextFingerprint !== workspaceContextFingerprint()) return true;
                    if (editVersion !== state.personalEditVersion) {
                        recordPersonalDraft();
                        continue;
                    }
                    state.guestPreviewError = true;
                    state.personalRankingError = 'Ranking update failed. Showing the previous calculation.';
                    setStatus('Could not calculate this temporary ranking. Refresh to retry.');
                    renderAll();
                    return false;
                }
            }
        } finally {
            state.saving = false;
            state.savePromise = null;
            updateLastUpdated();
            renderInlineFallback();
            renderModeState();
            updateUndoState();
        }
    })();
    state.persistPromise = task;
    try {
        return await task;
    } finally {
        if (state.persistPromise === task) state.persistPromise = null;
    }
}

async function persistPersonalPie({ forceSave = false } = {}) {
    window.clearTimeout(state.saveTimer);
    state.saveTimer = null;
    if (state.accountWriteBlocked) {
        setStatus('Your account changed. Refresh this page before saving.');
        return false;
    }
    if (state.personalRecoveryBlocked) {
        setStatus(state.personalSaveError || 'Refresh to review this draft before saving.');
        return false;
    }
    if (!state.authenticated) {
        return previewGuestPersonalPie();
    }
    if (state.usingGuestDraft && !forceSave) {
        return previewGuestPersonalPie();
    }
    if (state.persistPromise) {
        return state.persistPromise;
    }
    try {
        if (state.usingGuestDraft && !state.recoveredPersonalDraft) pieRecovery.adoptGuest();
        if (!recordPersonalDraft()) return false;
    } catch (error) {
        state.personalSaveError = error.message;
        setStatus(error.message);
        renderAll();
        return false;
    }
    const task = (async () => {
        const categoryID = state.categoryID;
        const expectedUserID = state.userID;
        const contextValues = { ...state.selectedContextValues };
        const contextFingerprint = workspaceContextFingerprint(categoryID, contextValues);
        state.saving = true;
        fallbackSaveFailed = false;
        setStatus('');
        updateUndoState();
        renderInlineFallback();
        try {
            while (true) {
                if (contextFingerprint !== workspaceContextFingerprint()) return true;
                if (state.userID !== expectedUserID) {
                    state.accountWriteBlocked = true;
                    state.personalSaveError = 'Your account changed. Refresh this page before saving.';
                    setStatus(state.personalSaveError);
                    renderAll();
                    return false;
                }
                if (state.personalSavePending || state.personalSaveRequest || !state.personalRankingRefreshNeeded || forceSave) {
                    const request = state.personalSaveRequest ?? pieRecovery.newRequest({
                        body: { expectedUserID, categoryID, contextValues,
                            expectedRevision: state.personalRevision, fallbackConfigurationVersion: FALLBACK_CONFIGURATION_VERSION,
                            ...portablePersonalPie() },
                        snapshot: snapshotPersonalPie(), editVersion: state.personalEditVersion
                    });
                    state.personalSaveRequest = request;
                    state.personalSavePending = true;
                    state.personalSaveError = '';
                    state.personalSaveConflict = false;
                    try {
                        if (request.body.expectedUserID !== expectedUserID
                            || workspaceContextFingerprint(request.body.categoryID, request.body.contextValues) !== contextFingerprint) {
                            throw Object.assign(new Error('A pending save belongs to another context. Refresh to review your drafts.'),
                                { code: 'pie_save_scope_changed' });
                        }
                        state.savePromise = postWriteJSON('/api/save_personal_pie', request.body,
                            { timeoutMs: 60000, validateResponse: validatePersonalPieSave,
                                requestKey: request.key, onIdentity: (key, body) => pieRecovery.capture(request, key, body) });
                        const receipt = await state.savePromise;
                        if (state.userID !== expectedUserID) throw accountWriteError();
                        if (contextFingerprint !== workspaceContextFingerprint()) return true;
                        pieRecovery.acknowledge(request, receipt.personalPie.revision);
                        state.serverPersonalEntries = cloneEntries(request.snapshot.entries);
                        state.serverPersonalFallbackRules = cloneFallbackRules(request.snapshot.fallbackRules);
                        state.hasSavedPersonalWeights = request.snapshot.entries.length > 0;
                        state.personalRankingRefreshNeeded = true;
                        state.personalSavePending = request.editVersion !== state.personalEditVersion;
                        forceSave = false;
                        await waitForGestureToSettle();
                        if (state.userID !== expectedUserID) throw accountWriteError();
                        if (contextFingerprint !== workspaceContextFingerprint()) return true;
                        if (request.editVersion !== state.personalEditVersion) {
                            state.personalSavePending = true;
                            setStatus('');
                            continue;
                        }
                        state.usingGuestDraft = false;
                        state.personalIsDraft = false;
                        pendingFallbackSave = false;
                        fallbackSaveFailed = false;
                    } catch (error) {
                        if (state.userID !== expectedUserID || isAccountWriteError(error) || error.status === 401) {
                            state.accountWriteBlocked = true;
                            state.personalSaveError = 'Your account changed. Refresh this page before saving.';
                        } else {
                            if (contextFingerprint !== workspaceContextFingerprint()) return true;
                            // Retain an uncertain request so later edits cannot replace its replay identity.
                            if (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)
                                && error.code !== 'invalid_personal_pie_receipt') state.personalSaveRequest = null;
                            state.personalRecoveryBlocked ||= error.code === 'pie_recovery_changed';
                            state.personalSaveConflict = error.payload?.error === 'pie_revision_conflict' || state.personalRecoveryBlocked;
                            state.personalSaveError = topicReferenceError(error) || (['pie_save_scope_changed', 'pie_recovery_changed'].includes(error.code) ? error.message : state.personalSaveConflict
                                ? 'This pie changed elsewhere. Your changes are kept; reload to review the saved version.'
                                : error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)
                                    ? 'Your changes could not be saved. They are kept here so you can correct them.'
                                    : 'Could not confirm saving. Your changes are kept; retry to confirm.');
                            fallbackSaveFailed = pendingFallbackSave || fallbackSignature(state.personalFallbackRules)
                                !== fallbackSignature(state.serverPersonalFallbackRules);
                        }
                        if (contextFingerprint === workspaceContextFingerprint()) {
                            if (state.userID === expectedUserID && !state.accountWriteBlocked) recordPersonalDraft();
                            state.personalRankingError = state.personalSaveError;
                            setStatus(state.personalSaveError);
                            renderAll();
                        }
                        if (error.status === 401) requestLogin();
                        return false;
                    }
                }
                const editVersion = state.personalEditVersion;
                const requestedBenchmarkFilters = currentBenchmarkFilters();
                const presentation = JSON.stringify([state.mode, state.scoreMode, state.availableInferenceVersion, state.estimationAlgorithm, state.comparisonRequest]);
                setStatus('');
                state.personalRankingError = '';
                renderModels();
                try {
                    state.savePromise = postJSON('/api/get_weighted_workspace', { categoryID, contextValues,
                        comparison: state.comparisonRequest, scoreMode: state.scoreMode,
                        availableInferenceVersion: state.availableInferenceVersion,
                        ...estimationRequest(state.estimationAlgorithm),
                        initialMode: state.mode, ...requestedBenchmarkFilters }, { timeoutMs: 60000 });
                    const payload = validateWorkspacePayload(await state.savePromise);
                    if (payload.userID !== expectedUserID || state.userID !== expectedUserID) throw accountWriteError();
                    if (contextFingerprint !== workspaceContextFingerprint()) return true;
                    if (workspaceContextFingerprint(payload.context.categoryID, payload.context.contextValues) !== contextFingerprint) {
                        throw new Error('The ranking response belongs to a different context.');
                    }
                    await waitForGestureToSettle();
                    if (state.userID !== expectedUserID) throw accountWriteError();
                    if (contextFingerprint !== workspaceContextFingerprint()) return true;
                    if (editVersion !== state.personalEditVersion) { state.personalSavePending = true; continue; }
                    if (presentation !== JSON.stringify([state.mode, state.scoreMode, state.availableInferenceVersion, state.estimationAlgorithm, state.comparisonRequest])) continue;
                    applyServerWorkspace(payload, { preserveUndo: true, personalSave: true });
                    state.personalIsDraft = false;
                    setStatus('');
                    renderAll();
                    refreshChangedBenchmarkFilters(requestedBenchmarkFilters);
                    return true;
                } catch (error) {
                    if (contextFingerprint !== workspaceContextFingerprint()) return true;
                    if (state.userID !== expectedUserID || isAccountWriteError(error)) {
                        state.accountWriteBlocked = true;
                        state.personalRankingError = 'Your account changed. Refresh this page before saving.';
                        setStatus(state.personalRankingError); renderAll(); return false;
                    }
                    if (editVersion !== state.personalEditVersion) { state.personalSavePending = true; continue; }
                    if (presentation !== JSON.stringify([state.mode, state.scoreMode, state.availableInferenceVersion, state.estimationAlgorithm, state.comparisonRequest])) continue;
                    state.personalRankingError = 'Your pie is saved. The ranking could not be updated.';
                    setStatus('Saved. Ranking update failed.');
                    renderAll();
                    return true;
                }
            }
        } finally {
            state.saving = false;
            state.savePromise = null;
            updateLastUpdated();
            updateUndoState();
            renderInlineFallback();
            renderModels();
        }
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
    const accountRefresh = detail.accountRefresh === true;
    if (!await finishPendingWeightAdjustments()) return;
    if (state.saving && state.savePromise) {
        await state.savePromise.catch(() => {});
    }
    if (!await flushPendingPersonalPieSave()) {
        return;
    }
    if (accountRefresh && state.usingGuestDraft && !recordPersonalDraft()) return;
    const nextCategoryID = detail.currentCategoryID ?? null;
    const nextCategoryPath = String(detail.categoryPath || '');
    const changed = Number(nextCategoryID) !== Number(state.categoryID)
        || (nextCategoryID === null && state.categoryID !== null)
        || nextCategoryPath !== state.categoryPath;
    const explicitContext = detail.contextValues !== undefined || detail.fromURL === true;
    if ((changed || explicitContext) && state.categoryID !== null && typeof modelFocus !== 'undefined') {
        modelFocus.cancel({ clearPage: true });
        state.comparisonRequest = comparisonControls.reset() ?? state.comparisonRequest;
    }
    state.categoryID = nextCategoryID;
    state.categoryPath = nextCategoryPath;
    state.topicName = String(detail.categoryName ?? state.topicName ?? '');
    state.topicSummary = String(detail.description ?? '');
    state.topicCreator = detail.creator ?? null;
    state.contextIsPrivate = detail.isPrivate === true;
    if (state.contextIsPrivate) state.mode = 'personal';
    if (changed || explicitContext) {
        state.selectedContextValues = { ...(detail.contextValues ?? {}) };
        state.dimensions = [];
        state.workspaceView = 'overview';
    }
    if (accountRefresh) {
        if (comparisonProfileLoading) await comparisonProfilesReady;
        await loadComparisonProfiles();
        await loadWeightedWorkspace({ preserveUndo: true });
    } else if (changed || explicitContext || !state.rankingPagination) {
        await loadWeightedWorkspace();
    }
}

personalModeButton.addEventListener('click', () => setMode('personal'));
publicModeButton.addEventListener('click', () => setMode('public'));
function needsPersonalStart() {
    return !state.loading && !state.personalEntries.length && !state.hasSavedPersonalWeights
        && !state.usingGuestDraft && !state.recoveredPersonalDraft && !state.personalDraftUnavailable && !state.legacyDraftAvailable;
}

async function openPersonalStart(trigger, reset = false) {
    const scope = workspaceContextFingerprint(), user = state.userID;
    if (state.loading || state.accountWriteBlocked || state.personalRecoveryBlocked || state.personalSaveConflict
        || !await prepareContextChange() || scope !== workspaceContextFingerprint() || user !== state.userID) return;
    if (reset && state.mode !== 'personal') return;
    fallbackPicker.close({ restore: false }); benchmarkSettings.close();
    await personalPieStart.open({ reset, trigger, beforeReveal: !reset && state.mode !== 'personal' ? async isCurrent => {
        const segmented = mountSegmentedControl(modeSwitch);
        segmented.refresh();
        // Paint the newly visible Public selection before moving its indicator.
        if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }
        if (!isCurrent()) return;
        applyPieMode('personal', { animate: false });
        segmented.refresh();
        getComputedStyle(modeSwitch, '::before').transform;
        await Promise.allSettled(modeSwitch.getAnimations({ subtree: true }).map(animation => animation.finished));
    } : null });
}

function startPersonalPie(entries, isCurrent) {
    if (!isCurrent() || state.loading || state.accountWriteBlocked || state.personalRecoveryBlocked || state.personalSaveConflict) return false;
    const changed = entries.length > 0 || state.personalEntries.length > 0 || state.personalFallbackRules.length > 0;
    personalPieStart.close({ restore: false });
    modeSwitchSequence++; pendingPieMode = null; renderPendingPieMode();
    state.loadSequence++;
    state.mode = 'personal'; writeWorkspacePreferences(state);
    if (changed && !beginMutation()) return false;
    resetPieVisualState(); hiddenPersonalBenchmarkIDs.clear();
    state.personalEntries = cloneEntries(entries); state.personalFallbackRules = [];
    state.personalCommunityComposition = [];
    state.referenceIssues.personal = []; state.effectiveEntries.personal = null;
    state.selectedObjectID = entries[0]?.conditionID ?? null; state.selectedFamilyKey = null;
    state.workspaceView = 'overview'; state.personalFallbackExpanded = false;
    registerPieEntries(state.personalEntries);
    setStatus(''); renderAll();
    if (changed) scheduleSave();
    (entries.length ? personalModeButton : document.getElementById('weight-add-benchmark')).focus({ preventScroll: true });
    return true;
}

personalPieCreate.addEventListener('click', () => { void openPersonalStart(personalPieCreate); });
resetButton.addEventListener('click', () => { void openPersonalStart(resetButton, true); });
compactPieAction.addEventListener('click', () => {
    if (state.personalEntries.length) void setMode('personal');
    else void openPersonalStart(compactPieAction);
});
personalPieFindBenchmarks.addEventListener('click', async () => {
    const scope = workspaceContextFingerprint();
    if (state.mode !== 'personal' || state.loading || !await finishPendingWeightAdjustments()
        || scope !== workspaceContextFingerprint()) return;
    deactivateInlineFallbackTarget();
    benchmarkSearch.focus({ preventScroll: true });
    benchmarkSearch.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'center'
    });
});

document.getElementById('weight-add-benchmark').addEventListener('click', () => personalPieFindBenchmarks.click());
guestDraftSave.addEventListener('click', async () => {
    if (state.legacyDraftAvailable || state.personalDraftUnavailable) {
        await loadWeightedWorkspace({ preserveUndo: true, legacyClaim: state.legacyDraftAvailable });
        return;
    }
    if (!state.authenticated) {
        requestLogin();
        return;
    }
    if (!await flushPendingPersonalPieSave()) return;
    await persistPersonalPie({ forceSave: true });
});
guestDraftDiscard.addEventListener('click', async () => {
    if ((!state.authenticated && !state.legacyDraftAvailable) || state.saving) return;
    window.clearTimeout(state.saveTimer);
    state.saveTimer = null;
    const key = workspaceContextFingerprint();
    if (state.legacyDraftAvailable) guestDrafts.discardLegacy(key, guestDrafts.getLegacy(key));
    else if (state.recoveredPersonalDraft || state.personalRecoveryToken !== null) {
        try { pieRecovery.discard(); }
        catch (error) { setStatus(error.message); return; }
    } else guestDrafts.delete(key);
    state.usingGuestDraft = false;
    state.personalSavePending = false;
    state.personalSaveRequest = null;
    state.legacyDraftAvailable = false;
    state.editHistory.clear();
    await loadWeightedWorkspace();
});

function isPersonalBenchmarkFocus() {
    return state.workspaceView === 'focus' && state.mode === 'personal';
}

function isWeightAdjustmentMode() {
    return state.mode === 'personal' && state.personalEntries.length > 1
        && selectedObjectIndex(state.personalEntries) >= 0
        && (isPersonalBenchmarkFocus() || pieCard.classList.contains('is-adjusting-weight'));
}

function isWeightWheelTarget(target) {
    return target instanceof Element && Boolean(target.closest('.bp-left-workspace'))
        && (isPersonalBenchmarkFocus() || Boolean(target.closest('#weight-pie')))
        && !target.closest('.bp-inline-fallback, .bp-benchmark-fallbacks, input, textarea, select, button, a, [contenteditable="true"], global-dialog, [role="dialog"]');
}

function updateWeightAdjustmentCursor() {
    const active = !state.loading && isWeightAdjustmentMode();
    const target = active && lastPointerPosition
        ? document.elementFromPoint(lastPointerPosition.x, lastPointerPosition.y) : null;
    const next = isWeightWheelTarget(target) ? target : null;
    if (next === weightCursorTarget) return;
    weightCursorTarget?.classList.remove('bp-weight-wheel-target');
    weightCursorTarget = next;
    weightCursorTarget?.classList.add('bp-weight-wheel-target');
}

document.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch') return;
    lastPointerPosition = { x: event.clientX, y: event.clientY };
    updateWeightAdjustmentCursor();
}, { passive: true });
document.addEventListener('pointerout', event => {
    if (event.relatedTarget !== null) return;
    lastPointerPosition = null;
    updateWeightAdjustmentCursor();
});
window.addEventListener('blur', () => {
    lastPointerPosition = null;
    updateWeightAdjustmentCursor();
});

function queueSelectedWeightWheel(event) {
    if (!isWeightAdjustmentMode() || event.ctrlKey
        || !isWeightWheelTarget(event.target)) {
        return;
    }
    event.preventDefault();
    if (state.loading || selectedObjectIndex(state.personalEntries) < 0) {
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

function stopWeightAdjustment() {
    if (!isWeightAdjustmentMode()) return;
    const returnFocus = pieAdjustmentStatus.contains(document.activeElement);
    if (touchPieGesture) {
        const gesture = touchPieGesture;
        touchPieGesture = null;
        flushTouchPiePreview(gesture);
        if (pieSvg.hasPointerCapture(gesture.pointerID)) pieSvg.releasePointerCapture(gesture.pointerID);
    }
    // Flush queued wheel input before leaving focus; saving continues independently.
    if (wheelWeightCommitTimer !== null || pendingWheelBasisPoints !== 0) void commitPendingWheelAdjustment();
    else if (state.gestureOpen) void finishWeightGesture();
    setPieAdjustmentActive(false);
    setWorkspaceView('leaderboard');
    renderPie();
    if (returnFocus) {
        const row = benchmarkRows.querySelector(`.bp-benchmark-row[data-condition-id="${Number(state.selectedObjectID)}"][data-benchmark-control="selection"]`);
        (row?.getClientRects().length ? row : personalModeButton).focus({ preventScroll: true });
    }
}

pieAdjustmentDismiss.addEventListener('click', stopWeightAdjustment);
document.addEventListener('contextmenu', event => {
    if (!isWeightAdjustmentMode() || event.pointerType === 'touch' || touchPieGesture
        || !(event.target instanceof Element)
        || event.target.closest('input, textarea, select, [contenteditable="true"], global-dialog, [role="dialog"]')) return;
    event.preventDefault();
    stopWeightAdjustment();
});


document.addEventListener('wheel', event => {
    if (!isPersonalBenchmarkFocus()) {
        return;
    }
    if (!isWeightWheelTarget(event.target)) {
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

pieSvg.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') {
        return;
    }
    const slice = event.target.closest('[data-object-id]');
    if (state.mode !== 'personal' || state.personalEntries.length < 2) {
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
        pointerType: event.pointerType,
        startX: event.clientX,
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
    if (!touchPieGesture || touchPieGesture.pointerID !== event.pointerId
        || touchPieGesture.pointerType !== event.pointerType) {
        return;
    }
    if (!touchPieGesture.adjusted && Math.abs(event.clientX - touchPieGesture.startX) > TOUCH_DRAG_THRESHOLD_PX
        && Math.abs(event.clientX - touchPieGesture.startX) > Math.abs(event.clientY - touchPieGesture.startY) * 1.2) {
        touchPieGesture = null;
        if (pieSvg.hasPointerCapture(event.pointerId)) pieSvg.releasePointerCapture(event.pointerId);
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

// Cancel the native pan only after this finger has begun adjusting a weight.
// Preventing pointermove alone does not stop the browser from later claiming a
// slightly diagonal drag for horizontal paging and issuing pointercancel.
pieSvg.addEventListener('touchmove', event => {
    if (touchPieGesture?.adjusted && event.touches.length === 1 && event.cancelable) event.preventDefault();
}, { passive: false });

const endTouchPieGesture = (event, cancelled = false) => {
    if (!touchPieGesture || touchPieGesture.pointerID !== event.pointerId
        || touchPieGesture.pointerType !== event.pointerType) {
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
        deactivateInlineFallbackTarget();
        state.selectedObjectID = completedGesture.candidateObjectID;
        state.selectedFamilyKey = null;
        state.workspaceView = 'focus';
        applyWorkspaceView({ animate: true });
        renderModeState();
        renderPie();
        renderBenchmarks();
        renderBenchmarkSummary();
        revealBenchmarkRow(completedGesture.candidateObjectID);
        return;
    }
    if (cancelled && state.gestureOpen) {
        restorePersonalPieSnapshot(state.gestureSnapshot ?? snapshotPersonalPie());
        state.gestureOpen = false;
        notifyGestureSettled();
        state.gestureSnapshot = null;
        recordPersonalDraft();
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


function restoreHistory(direction) {
    if (state.gestureOpen
        || wheelWeightCommitTimer !== null) {
        return;
    }
    window.clearTimeout(state.saveTimer);
    state.saveTimer = null;
    const snapshot = state.editHistory[direction](snapshotPersonalPie());
    if (!snapshot) return;
    // A history edit must outlive any workspace result requested before it.
    state.loadSequence += 1;
    state.loading = false;
    benchmarkFallbackCatalogue.setSnapshot(state.rankingPagination?.snapshotID ?? null);
    restorePersonalPieSnapshot(snapshot);
    state.personalEditVersion += 1;
    state.personalSavePending = true;
    state.personalSaveError = '';
    state.personalRankingDirty = true;
    state.personalRankingError = '';
    recordPersonalDraft();
    for (const entry of state.personalEntries) {
        hiddenPersonalBenchmarkIDs.delete(Number(entry.conditionID));
    }
    if (!state.personalEntries.some(entry => Number(entry.conditionID) === Number(state.selectedObjectID))) {
        state.selectedObjectID = state.personalEntries[0]?.conditionID ?? null;
    }
    renderAll();
    void persistPersonalPie();
}
function bindHistoryControl(button, direction) {
    let touchStart = null;
    button.addEventListener('pointerdown', event => {
        if (event.pointerType === 'touch' && event.isPrimary && !button.disabled) {
            touchStart = { ID: event.pointerId, x: event.clientX, y: event.clientY };
        }
    });
    button.addEventListener('pointercancel', () => { touchStart = null; });
    button.addEventListener('pointerup', event => {
        if (!touchStart || touchStart.ID !== event.pointerId) return;
        const start = touchStart; touchStart = null;
        const bounds = button.getBoundingClientRect();
        if (button.disabled || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10
            || event.clientX < bounds.left || event.clientX > bounds.right
            || event.clientY < bounds.top || event.clientY > bounds.bottom) return;
        // Touch activation must not depend on a delayed compatibility click after dragging.
        event.preventDefault();
        restoreHistory(direction);
    });
    button.addEventListener('touchend', event => event.preventDefault(), { passive: false });
    button.addEventListener('click', () => restoreHistory(direction));
}
bindHistoryControl(undoButton, 'undo');
bindHistoryControl(redoButton, 'redo');

function retainPieBeforeExit() {
    if (touchPieGesture) flushTouchPiePreview(touchPieGesture);
    const delta = Math.round(pendingWheelBasisPoints);
    pendingWheelBasisPoints = 0;
    if (delta) adjustSelectedWeight(delta, { animateWeights: false });
    if (state.personalSavePending || state.personalSaveRequest || state.usingGuestDraft) recordPersonalDraft();
}
window.addEventListener('pagehide', retainPieBeforeExit);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') retainPieBeforeExit();
});

benchmarkSearch.addEventListener('input', () => {
    hiddenPersonalBenchmarkIDs.clear();
    window.clearTimeout(benchmarkSearchTimer);
    if (!state.rankingPagination || state.loading || workspaceLoadFailed) return;
    state.rankingPageSequence.benchmarks += 1;
    state.rankingPageLoading.benchmarks = true;
    state.benchmarks = [];
    renderBenchmarks();
    benchmarkSearchTimer = window.setTimeout(() => {
        state.rankingPageLoading.benchmarks = false;
        reloadBenchmarkPage();
    }, 180);
});

benchmarkPersonalPin.addEventListener('click', () => {
    if (benchmarkPersonalPin.disabled) {
        return;
    }
    state.pinPersonalBenchmarks = !state.pinPersonalBenchmarks;
    reloadBenchmarkPage();
});

function loadVisibleRankingPages() {
    loadVisibleBenchmarkPage();
    if (shouldLoadMore(modelRows)) void loadNextRankingPage(state.mode);
}
// Capture also covers scrolling the document or a containing mobile panel.
window.addEventListener('scroll', loadVisibleRankingPages, { passive: true, capture: true });
window.addEventListener('resize', loadVisibleRankingPages, { passive: true });

inlineFallbackToggle.addEventListener('click', () => {
    const primary = selectedInlineFallbackPrimary();
    if (!primary || state.loading) return;
    if (state.versionComposition) { benchmarkSettings.open(primary); return; }
    if (!fallbackRuleFor(primary.ID)) { openInlineFallbackPicker(); return; }
    state.personalFallbackExpanded = !state.personalFallbackExpanded;
    if (!state.personalFallbackExpanded) {
        fallbackEditorScope = null;
        deactivateInlineFallbackTarget();
    }
    writeWorkspacePreferences(state);
    renderInlineFallback(); renderBenchmarks();
});
inlineFallbackSaveRetry.addEventListener('click', () => { void persistPersonalPie(); });
publicFallbackToggle.addEventListener('click', () => {
    const primary = selectedPublicFallbackPrimary();
    if (state.mode !== 'public' || state.loading || !primary) return;
    if (state.versionComposition) { benchmarkSettings.open(primary); return; }
    fallbackPicker.open(primary, { action: 'view', getReturnFocus: () => publicFallbackToggle });
});
inlineFallbackChart.addEventListener('keydown', event => {
    if (state.mode !== 'personal') return;
    if (event.key === 'Escape' && isInlineFallbackTargetActive()) {
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
    hiddenPersonalBenchmarkIDs.clear();
    await loadWeightedWorkspace({ retryProfiles: Boolean(comparisonProfileFailure) });
});

workspaceChannel.beforeChange(async () => {
    if (!await finishPendingWeightAdjustments()) return false;
    return flushPendingPersonalPieSave();
});

categoryNavigationMedia.addEventListener('change', renderBreadcrumb);

workspaceChannel.subscribe(detail => applyWorkspaceState(detail));
