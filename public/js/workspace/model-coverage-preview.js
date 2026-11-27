import { SVG_NS } from './constants.js';
import { mergeBenchmarkWeights } from './expanded-weights.js';
import { createPieRenderer } from './pie-renderer.js';
import { TREEMAP_ESTIMATION_METHOD, PEER_MEDIAN_METHOD } from '../shared/fallback-inference.js';

const blockKey = entry => entry.conditionID < 0 ? 'unresolved' : `benchmark:${entry.benchmarkID ?? entry.conditionID}`;

// These are presentation blocks, never inputs to the ranking or personal weights.
// Coverage rows describe direct measurements on each weighted benchmark version.
export function buildModelCoverageEntries(entries, coverageEntries, versions = [], estimates = []) {
    if (!Array.isArray(entries) || !Array.isArray(coverageEntries)) return null;
    const coverageByID = new Map();
    for (const item of coverageEntries) {
        if (!item || !Number.isSafeInteger(item.conditionID) || item.conditionID === 0
            || coverageByID.has(item.conditionID) || !Number.isFinite(item.weightBasisPoints) || item.weightBasisPoints <= 0
            || !Number.isFinite(item.coveredWeightBasisPoints) || item.coveredWeightBasisPoints < 0
            || item.coveredWeightBasisPoints > item.weightBasisPoints + 1e-6
            || (item.coveredWeightBasisPoints > 0 ? !Number.isFinite(item.normalizedScore) : item.normalizedScore !== null)) {
            throw new TypeError('Invalid adopted model coverage');
        }
        coverageByID.set(item.conditionID, item);
    }
    const estimatedByID = new Map();
    const totalWeight = coverageEntries.reduce((sum, item) => sum + item.weightBasisPoints, 0);
    for (const score of estimates) {
        const id = score.conditionID;
        if (!coverageByID.has(id) || !Number.isFinite(score.normalizedScore)) continue;
        const weight = score.weightBasisPoints ?? score.originalWeight / 100 * totalWeight;
        if (!Number.isFinite(weight) || weight <= 0) continue;
        const estimate = estimatedByID.get(id) ?? { weight: 0, contribution: 0, treemapWeight: 0, peerWeight: 0 };
        estimate.weight += weight;
        estimate.contribution += weight * score.normalizedScore;
        if (score.estimationMethod === TREEMAP_ESTIMATION_METHOD) estimate.treemapWeight += weight;
        if (score.estimationMethod === PEER_MEDIAN_METHOD) estimate.peerWeight += weight;
        estimatedByID.set(id, estimate);
    }
    const totals = new Map();
    for (const entry of entries) {
        if (!(entry.weightBasisPoints > 0)) continue;
        const key = blockKey(entry), total = totals.get(key)
            ?? { covered: 0, contribution: 0, estimated: 0, estimatedContribution: 0, treemapWeight: 0, peerWeight: 0 };
        const adopted = coverageByID.get(entry.conditionID);
        // Repeated references to the same condition retain their proportional share.
        const covered = adopted && entry.conditionID > 0 ? entry.weightBasisPoints * adopted.coveredWeightBasisPoints / adopted.weightBasisPoints : 0;
        total.covered += covered;
        if (covered > 0) total.contribution += covered * adopted.normalizedScore;
        const estimate = estimatedByID.get(entry.conditionID);
        if (adopted && estimate) {
            const share = entry.weightBasisPoints / adopted.weightBasisPoints;
            total.estimated += share * estimate.weight;
            total.estimatedContribution += share * estimate.contribution;
            total.treemapWeight += share * estimate.treemapWeight;
            total.peerWeight += share * estimate.peerWeight;
        }
        totals.set(key, total);
    }
    return mergeBenchmarkWeights(entries, versions).map(entry => {
        const total = totals.get(entry.isUnresolved ? 'unresolved' : blockKey(entry));
        const coveredWeightBasisPoints = total?.covered ?? 0;
        const estimatedWeightBasisPoints = total?.estimated ?? 0;
        const scoredWeight = coveredWeightBasisPoints + estimatedWeightBasisPoints;
        const contribution = (total?.contribution ?? 0) + (total?.estimatedContribution ?? 0);
        const unresolvedWeightBasisPoints = Math.max(0, entry.weightBasisPoints - scoredWeight);
        return { ...entry, coveredWeightBasisPoints, estimatedWeightBasisPoints, unresolvedWeightBasisPoints,
            treemapEstimatedWeightBasisPoints: total?.treemapWeight ?? 0,
            peerEstimatedWeightBasisPoints: total?.peerWeight ?? 0,
            coverage: Math.min(100, coveredWeightBasisPoints / entry.weightBasisPoints * 100),
            adoptedNormalizedScore: coveredWeightBasisPoints > 0 ? total.contribution / coveredWeightBasisPoints : null,
            estimatedNormalizedScore: estimatedWeightBasisPoints > 0 ? total.estimatedContribution / estimatedWeightBasisPoints : null,
            rankingNormalizedScore: contribution / entry.weightBasisPoints,
            availableNormalizedScore: scoredWeight > 0 ? contribution / scoredWeight : null };
    });
}

export function modelCoverageContext(state) {
    const comparison = state.comparison ?? state.comparisonRequest;
    return JSON.stringify([state.authenticated, state.userID, state.categoryID, state.selectedContextValues,
        state.mode, state.scoreMode, state.loadSequence, state.rankingVersion, state.rankingPagination?.snapshotID,
        comparison?.mode, comparison?.keys, comparison?.filters, state.estimationAlgorithm, state.availableInferenceVersion,
        state.workspaceView, state.workspaceDisplay, state.topicsExpanded,
        state.loading, state.comparisonPending, state.mode === 'personal' && state.personalRankingDirty]);
}

export function createModelCoveragePreview({ state, pieSvg, getExpandedEntries, getVersions = () => [],
    getContext = () => modelCoverageContext(state), resolveModel = model => model }) {
    let active = null, disposed = false, leaveTimer;
    const mounts = new Set();
    const mobile = window.matchMedia('(max-width: 760px)');
    const viewportChanged = () => { if (mobile.matches) clear(); };
    mobile.addEventListener('change', viewportChanged);
    const eligible = () => !disposed && !state.loading && !state.comparisonPending
        && !(state.mode === 'personal' && state.personalRankingDirty);

    function mount(container, model, { anchor, focusCoverage = false, onDestroy = () => {} } = {}) {
        const controller = new globalThis.AbortController(), context = getContext();
        let renderer = null, frame = null, destroyed = false;
        const current = () => !destroyed && !disposed && !controller.signal.aborted && context === getContext()
            && container.isConnected && (!anchor || anchor.isConnected) && eligible();
        const handle = { anchor, container, ready: null,
            resize() { renderer?.renderPie({ layoutOnly: true }); }, destroy() {
            if (destroyed) return;
            destroyed = true;
            controller.abort();
            if (frame !== null) cancelAnimationFrame(frame);
            renderer?.destroy();
            container.replaceChildren();
            mounts.delete(handle);
            onDestroy();
        } };
        mounts.add(handle);
        function watch() {
            if (!current()) { handle.destroy(); return; }
            frame = requestAnimationFrame(watch);
        }
        watch();
        function render(resolved) {
            if (!current()) return false;
            const estimates = state.scoreMode === 'available' ? resolved?.inferredScores : undefined;
            const entries = buildModelCoverageEntries(getExpandedEntries(), resolved?.coverageEntries, getVersions(), estimates);
            if (!entries) return unavailable();
            const svg = document.createElementNS(SVG_NS, 'svg');
            svg.classList.add('bp-model-coverage-treemap');
            container.replaceChildren(svg);
            // The ordinary renderer owns its own caches and visual state. Clone
            // every mutable field so hovering cannot select or rewrite user weights.
            const previewState = { mode: state.mode, categoryID: state.categoryID,
                selectedContextValues: state.selectedContextValues, selectedObjectID: null,
                limits: { ...state.limits }, pieOrderByObjectID: new Map(state.pieOrderByObjectID),
                visualPieWeights: new Map(), visualPieEntries: new Map(), pieAnimationFrame: null };
            renderer = createPieRenderer({ state: previewState, pieSvg: svg,
                orderedPieEntries: values => values, currentPieEntries: () => entries, selectedObjectIndex: () => -1,
                renderInlineFallback() {}, fallbackRuleFor: () => null, publicFallbackRuleFor: () => null,
                autoSelect: () => false, coveragePreview: true, coverageMode: state.scoreMode, focusCoverage });
            renderer.renderPie();
            return true;
        }
        function unavailable() {
            if (!current()) return false;
            const message = document.createElement('p');
            message.className = 'bp-model-coverage-unavailable';
            message.textContent = 'Coverage details are unavailable. Refresh this ranking to try again.';
            container.replaceChildren(message);
            return false;
        }
        try {
            const resolved = resolveModel(model, { signal: controller.signal });
            handle.ready = resolved && typeof resolved.then === 'function'
                ? Promise.resolve(resolved).then(render).catch(() => unavailable()) : Promise.resolve(render(resolved));
        } catch { handle.ready = Promise.resolve(unavailable()); }
        return handle;
    }

    function clear() {
        clearTimeout(leaveTimer);
        const previous = active;
        active = null;
        previous?.destroy();
    }

    function show(model, { anchor } = {}) {
        clear();
        if (!eligible() || mobile.matches || !pieSvg?.isConnected || !model) return Promise.resolve(false);
        const container = document.createElement('div');
        container.className = 'bp-model-coverage-overlay';
        // An invisible pending overlay must not cover the original treemap.
        container.hidden = true;
        pieSvg.after(container);
        const ariaHidden = pieSvg.getAttribute('aria-hidden');
        const originalClass = pieSvg.getAttribute('class');
        const handle = mount(container, model, { anchor, onDestroy() {
            container.remove();
            pieSvg.classList.remove('is-model-coverage-previewed');
            if (originalClass === null && !pieSvg.getAttribute('class')) pieSvg.removeAttribute('class');
            if (ariaHidden === null) pieSvg.removeAttribute('aria-hidden');
            else pieSvg.setAttribute('aria-hidden', ariaHidden);
            if (active?.container === container) active = null;
        } });
        active = handle;
        container.addEventListener('pointerenter', () => clearTimeout(leaveTimer));
        container.addEventListener('pointerleave', clear);
        container.addEventListener('click', clear);
        // Synchronous DTOs are already rendered when mount returns.
        void handle.ready.then(ready => {
            if (ready && active === handle) {
                container.hidden = false;
                handle.resize();
                pieSvg.classList.add('is-model-coverage-previewed');
                pieSvg.setAttribute('aria-hidden', 'true');
            } else if (active === handle) clear();
        });
        return handle.ready;
    }

    function renderInto(container, model) {
        container.classList.add('bp-model-coverage-stage');
        if (!eligible()) return { ready: Promise.resolve(false), destroy() {} };
        return mount(container, model, { focusCoverage: true });
    }

    function bindRow(row, model) {
        const enter = event => {
            if (event.pointerType === 'touch' || mobile.matches) return;
            void show(model, { anchor: row });
        };
        const leave = () => {
            if (active?.anchor !== row) return;
            clearTimeout(leaveTimer);
            leaveTimer = setTimeout(clear, 400);
        };
        const cancel = () => { if (active?.anchor === row) clear(); };
        row.addEventListener('pointerenter', enter);
        row.addEventListener('pointerleave', leave);
        row.addEventListener('pointercancel', cancel);
        return () => {
            cancel();
            row.removeEventListener('pointerenter', enter);
            row.removeEventListener('pointerleave', leave);
            row.removeEventListener('pointercancel', cancel);
        };
    }

    return { show, clear, renderInto, bindRow, destroy() {
        disposed = true;
        mobile.removeEventListener('change', viewportChanged);
        clear();
        for (const handle of [...mounts]) handle.destroy();
    } };
}
