import { createOrganizationMark } from '../shared/organization-logos.js?v=organization-logos-20261006';
import { renderComparisonName } from '../shared/comparison-display.js?v=launch-layout-20261007';
import { rankingRowKey, captureRankingRows, animateRankingChanges } from './ranking-motion.js';
import { createRankingNotice } from './ranking-notice.js?v=percentile-ranking-20261007';
import { renderModelBarChart, captureModelColumns, animateModelColumns, modelBarColor } from './model-bar-chart.js';
import { mountBarEndpointLabel } from '../shared/bar-label.js';
import { rankingNumber } from '../shared/ranking-number.js';
import { markModelFocusTarget } from './model-focus-target.js';
import { createAction } from '../shared/ui-components.js';
import { RANKING_PAGE_SIZE } from '../shared/ranking-resume.js';

export function modelRankingEmptyMessage(state) {
    if (state.mode === 'personal' && !state.personalEntries.length) {
        return 'Add evaluation items to Personal Weights to calculate a model ranking.';
    }
    if (state.mode === 'public' && !state.publicEntries.length) {
        return 'No public weights for this topic or scene yet.';
    }
    const comparison = state.comparison ?? state.comparisonRequest;
    if (comparison?.keys?.length || comparison?.filters?.length) {
        return 'No models match these settings. Try combining run settings or removing a filter.';
    }
    return 'No measured results match these weights yet. Add another evaluation item or contribute scores.';
}

export function modelScoreScale(models, fixedScale = null, { fillTopBar = false } = {}) {
    let min = fixedScale?.min ?? 0;
    let max = fixedScale?.max ?? 100;
    for (const model of models) {
        if (model.comparable === false) continue;
        if (!Number.isFinite(model.lower) || !Number.isFinite(model.upper) || model.lower > model.upper) {
            throw new TypeError('Model score intervals must be finite and ordered');
        }
        if (!fixedScale) {
            min = Math.min(min, model.lower);
            max = Math.max(max, model.upper);
        }
    }
    const leader = models.find(model => model.comparable !== false && Number.isFinite(model.lower));
    const leaderFillsTrack = fillTopBar && leader && leader.lower > min;
    if (leaderFillsTrack) max = leader.lower;
    // Halving first also keeps the mapping finite for very large opposite endpoints.
    const position = value => (value / 2 - min / 2) / (max / 2 - min / 2) * 100;
    return { min, max, zero: position(0), barStart: leaderFillsTrack ? min : 0, position };
}

export function createCoveragePie(coverage) {
    const percent = Math.max(0, Math.min(100, Number.isFinite(coverage) ? coverage : 0));
    const label = percent > 0 && percent < 1 ? '<1' : percent > 99 && percent < 100 ? '>99' : rankingNumber(percent);
    const pie = document.createElement('span');
    pie.className = 'bp-model-coverage';
    pie.style.setProperty('--coverage-share', `${percent}%`);
    pie.dataset.tooltip = `Recorded scores cover ${label}% of this ranking's weight.`;
    pie.setAttribute('role', 'img');
    pie.setAttribute('aria-label', pie.dataset.tooltip);
    return pie;
}

export function createModelListView({ state, modelRows, openApprovedModelResults, onNeedMore, onRetrySave,
    onFocusPageRequest, onFocusPageClose, onUpdateStatus }) {
    const status = document.getElementById('model-ranking-status');
    const notice = createRankingNotice({ status, rows: modelRows });
    let renderedScope = '';
    let renderedModels = null;
    let renderedVersion = -1;
    let renderedSignature = '';
    let focusPage = null;
    function getFocusPage() {
        return focusPage && focusPage.snapshotID === state.rankingPagination?.snapshotID && focusPage.list === state.mode ? focusPage : null;
    }
    function renderFocusPagination(page) {
        const navigation = document.createElement('nav');
        navigation.className = 'bp-model-focus-pagination';
        navigation.setAttribute('aria-label', 'Model ranking pages');
        const add = (label, icon, action, disabled = false) => {
            const control = createAction({ label, icon: `fa-solid fa-${icon}`, iconOnly: true });
            control.dataset.modelFocusAction = label;
            control.disabled = disabled;
            control.setAttribute('aria-disabled', String(disabled || Boolean(page.loading)));
            control.addEventListener('click', () => { if (!page.loading && !disabled) action(); });
            navigation.append(control);
        };
        add('Top of ranking', 'angles-up', () => onFocusPageClose());
        add('Previous models', 'chevron-left', () => onFocusPageRequest(Math.max(0, page.offset - RANKING_PAGE_SIZE[page.list])), page.offset === 0);
        const range = document.createElement('span');
        range.textContent = `${page.offset + 1}-${page.nextOffset} / ${page.total}`;
        navigation.append(range);
        add('Next models', 'chevron-right', () => onFocusPageRequest(page.nextOffset), !page.hasMore);
        if (page.loading || page.error) {
            const message = document.createElement('span');
            message.className = 'bp-model-focus-error';
            message.setAttribute('role', 'status');
            message.textContent = page.loading ? 'Loading models...' : page.error;
            navigation.append(message);
        }
        modelRows.append(navigation);
    }
    function renderRankingStatus(scope) {
        const pending = state.loading || state.comparisonPending || state.mode === 'personal' && state.personalRankingDirty;
        const error = state.mode === 'personal' && state.personalRankingError;
        notice.update({ pending, error, version: state.rankingVersion, scope });
        onUpdateStatus?.();
    }
    function renderModels() {
        const focused = getFocusPage();
        const models = focused?.items ?? state.modelLeaderboards[state.mode] ?? [];
        const showVendorMarks = (state.comparison ?? state.comparisonRequest ?? { keys: ['model'] }).keys.includes('model');
        const charts = state.workspaceDisplay === 'charts';
        const scope = JSON.stringify([state.categoryID, state.selectedContextValues, state.mode, state.scoreMode, state.workspaceDisplay,
            focused?.snapshotID, focused?.offset]);
        renderRankingStatus(JSON.stringify([state.categoryID, state.selectedContextValues, state.mode, state.scoreMode]));
        const pending = state.loading || state.comparisonPending || state.mode === 'personal' && state.personalRankingDirty;
        // Keep the last calculation intact until a current response supplies its replacement.
        if (renderedScope === scope && renderedModels === models && pending
            && !state.personalRankingError && !state.comparisonNeedsSelection) return;
        const signature = JSON.stringify([scope, state.rankingVersion, models.length, state.rankingPageLoading[state.mode],
            state.rankingPageError[state.mode], state.comparisonNeedsSelection, state.comparisonError, showVendorMarks,
            state.guestPreviewError, state.personalRankingError, state.personalSaveError,
            state.personalSaveConflict, state.personalRankingRefreshNeeded, state.saving, focused?.loading, focused?.error]);
        if (renderedModels === models && renderedSignature === signature) return;
        const sameScope = renderedScope === scope;
        const changed = sameScope && renderedVersion !== state.rankingVersion;
        const focusKey = modelRows.contains(document.activeElement) ? document.activeElement.closest('[data-model-key]')?.dataset.modelKey : null;
        const focusAction = modelRows.contains(document.activeElement) ? document.activeElement.closest('[data-model-focus-action]')?.dataset.modelFocusAction : null;
        const previous = changed ? charts ? captureModelColumns(modelRows) : captureRankingRows(modelRows) : new Map();
        renderedScope = scope; renderedVersion = state.rankingVersion;
        renderedModels = models; renderedSignature = signature;
        const scrollTop = sameScope ? modelRows.scrollTop : 0;
        const scrollLeft = sameScope ? modelRows.querySelector('.bp-model-chart-scroll')?.scrollLeft ?? 0 : 0;
        notice.resetRows();
        if (state.mode === 'personal' && (state.personalSaveError || state.personalRankingRefreshNeeded && state.personalRankingError)) {
            const error = document.createElement('div');
            error.className = 'bp-error-state bp-pie-save-error';
            const message = document.createElement('span');
            message.textContent = state.personalSaveError || state.personalRankingError;
            error.append(message);
            if (onRetrySave) {
                const retry = document.createElement('button');
                retry.type = 'button';
                retry.className = 'bp-button';
                retry.textContent = state.personalSaveConflict ? 'Review saved pie'
                    : state.personalSaveError ? 'Retry save' : 'Retry calculation';
                retry.disabled = state.saving;
                retry.addEventListener('click', onRetrySave);
                error.append(retry);
            }
            modelRows.append(error);
            if (!models.length) return;
        }
        if (state.mode === 'personal' && state.guestPreviewError && !models.length) {
            const error = document.createElement('div');
            error.className = 'bp-error-state';
            error.textContent = 'Could not calculate this temporary ranking. Refresh to retry.';
            modelRows.append(error);
            return;
        }
        if (state.comparisonNeedsSelection) {
            const message = document.createElement('div');
            message.className = 'bp-empty-state';
            message.textContent = state.comparisonError || 'Select at least one key to compare.';
            modelRows.append(message);
            return;
        }
        if (pending && !models.length) {
            const loading = document.createElement('div');
            loading.className = 'bp-loading-state';
            loading.textContent = 'Calculating model ranking…';
            modelRows.append(loading);
            return;
        }
        const page = focused ?? state.rankingPagination?.[state.mode];
        if (models.length === 0) {
            if (state.rankingPageLoading[state.mode] || (page?.hasMore && !state.rankingPageError[state.mode])) {
                const loading = document.createElement('div');
                loading.className = 'bp-loading-state';
                loading.textContent = 'Loading models…';
                modelRows.append(loading);
                if (!charts && !state.rankingPageLoading[state.mode]) window.queueMicrotask(onNeedMore);
                return;
            }
            const empty = document.createElement('div');
            empty.className = 'bp-empty-state';
            empty.textContent = state.rankingPageError[state.mode] || modelRankingEmptyMessage(state);
            modelRows.append(empty);
            if (state.rankingPageError[state.mode]) {
                const retry = document.createElement('button');
                retry.type = 'button';
                retry.textContent = 'Retry';
                retry.addEventListener('click', onNeedMore);
                empty.append(retry);
            }
            return;
        }
        const fillTopBar = state.scoreMode === 'available';
        const scaleModels = focused ? [...(state.modelLeaderboards[state.mode] ?? []).slice(0, 1), ...models] : models;
        const scale = modelScoreScale(scaleModels, state.rankingPagination?.modelScales?.[state.mode], { fillTopBar });
        if (focused) renderFocusPagination(focused);
        if (charts) {
            renderModelBarChart({ container: modelRows, models, state, scale, showVendorMarks,
                onActivate: openApprovedModelResults, onNeedMore: focused ? () => {} : onNeedMore,
                hasMore: !focused && page?.hasMore, initialScrollLeft: scrollLeft });
        } else models.forEach(model => {
            const comparable = model.comparable !== false;
            const selectedScore = Number(model.lower);

            const row = document.createElement('div');
            row.className = 'bp-model-row';
            row.dataset.modelKey = rankingRowKey(model);
            row.dataset.rank = String(model.rank ?? 0);
            row.classList.toggle('is-incomparable', !comparable);
            row.classList.toggle('has-inline-score', comparable);
            row.dataset.tooltip = !comparable
                ? 'No comparable recorded scores for the weighted benchmarks.'
                : state.scoreMode === 'available'
                    ? `${rankingNumber(model.lower)}, ${rankingNumber(model.coverage)}% benchmark coverage`
                    : `${rankingNumber(model.lower)}–${rankingNumber(model.upper)}, ${rankingNumber(model.coverage)}% benchmark coverage`;
            row.tabIndex = 0;
            row.setAttribute('role', 'button');
            row.setAttribute('aria-label', `View approved scores for ${model.name}`);
            const rank = document.createElement('span');
            rank.className = 'bp-model-rank';
            rank.textContent = comparable ? String(model.rank) : '-';
            const identity = document.createElement('span');
            identity.className = 'bp-model-name-wrap';
            const name = document.createElement('span');
            name.className = 'bp-model-name';
            renderComparisonName(name, model, state.comparison ?? state.comparisonRequest);
            if (showVendorMarks) {
                identity.append(createOrganizationMark(model, 'bp-vendor-mark'));
            }
            identity.append(name);
            if (Number(model.fallbackUsageCount) > 0) {
                row.dataset.tooltip += `, Fallback used for ${model.fallbackUsageCount} benchmark${Number(model.fallbackUsageCount) === 1 ? '' : 's'}`;
            }

            const track = document.createElement('span');
            track.className = 'bp-score-track';
            track.style.setProperty('--score-vendor-color', modelBarColor(model));
            const relative = fillTopBar && comparable;
            row.classList.toggle('is-leader-relative', relative);
            track.classList.toggle('is-leader-relative', relative);
            track.setAttribute('aria-label', !comparable ? 'No observed total score' : state.scoreMode === 'available'
                ? `Score ${rankingNumber(model.lower)} including estimates from shared-test comparisons where possible; ${rankingNumber(model.coverage)}% measured coverage; chart scale ${rankingNumber(scale.min)} to ${rankingNumber(scale.max)}.`
                : `Score range ${rankingNumber(model.lower)} to ${rankingNumber(model.upper)}; chart scale ${rankingNumber(scale.min)} to ${rankingNumber(scale.max)}.`);
            const position = value => Math.max(0, Math.min(100, scale.position(value)));
            const lowerPosition = comparable ? position(model.lower) : 0;
            const upperPosition = comparable ? position(model.upper) : 0;
            const startPosition = position(scale.barStart);
            track.classList.toggle('bp-score-negative-range', !fillTopBar && model.lower < 0 && model.upper > model.lower);
            const known = document.createElement('span');
            known.className = 'bp-score-known';
            known.style.left = `${Math.min(startPosition, lowerPosition)}%`;
            known.style.width = `${Math.abs(lowerPosition - startPosition)}%`;
            const uncertain = document.createElement('span');
            uncertain.className = 'bp-score-uncertain';
            uncertain.style.left = `${lowerPosition}%`;
            uncertain.style.width = `${Math.max(0, upperPosition - lowerPosition)}%`;
            const fill = document.createElement('span');
            fill.className = 'bp-score-fill';
            const fillStart = Math.min(startPosition, lowerPosition);
            const fillEnd = Math.max(startPosition, upperPosition);
            // Clip the combined fill, not each segment, so their join stays continuous.
            fill.style.clipPath = `inset(0 ${100 - fillEnd}% 0 ${fillStart}% round 3px)`;
            fill.style.transformOrigin = `${fillStart}% center`;
            // The gray bed fills the rounded orange cap without changing score endpoints.
            if (comparable && model.lower >= 0 && upperPosition > lowerPosition && lowerPosition > startPosition) {
                const bed = document.createElement('span');
                bed.className = 'bp-score-range-base';
                fill.append(bed);
            }
            fill.append(known, uncertain);
            track.append(fill);

            const score = document.createElement('span');
            score.className = 'bp-model-score';
            const scoreValue = document.createElement('span');
            scoreValue.textContent = comparable ? rankingNumber(selectedScore) : 'No data';
            score.append(scoreValue);
            if (comparable && state.scoreMode === 'available') {
                const coverage = createCoveragePie(model.coverage);
                identity.append(coverage);
                row.setAttribute('aria-label', `${row.getAttribute('aria-label')}. ${coverage.dataset.tooltip}`);
            }
            const activate = event => {
                if (event.defaultPrevented || event.target.closest('a, button')
                    || event.type === 'keydown' && event.target.closest('.bp-model-parameters')) {
                    return;
                }
                if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') {
                    return;
                }
                if (event.type === 'keydown') {
                    event.preventDefault();
                }
                void openApprovedModelResults(model);
            };
            row.addEventListener('click', activate);
            row.addEventListener('keydown', activate);
            row.append(rank, identity, track);
            if (comparable) mountBarEndpointLabel(track, score, Math.max(startPosition, lowerPosition), Math.min(startPosition, lowerPosition));
            else row.append(score);
            modelRows.append(row);
        });
        [...modelRows.querySelectorAll('[data-model-key]')].forEach((row, index) => markModelFocusTarget(row, models[index]));
        if (!focused && ((!charts && page?.hasMore) || state.rankingPageLoading[state.mode] || state.rankingPageError[state.mode])) {
            const footer = document.createElement('div');
            footer.className = 'bp-ranking-page-footer';
            footer.classList.toggle('is-chart', charts);
            footer.setAttribute('role', 'status');
            footer.textContent = state.rankingPageLoading[state.mode]
                ? 'Loading more models…'
                : state.rankingPageError[state.mode] || '';
            if (state.rankingPageError[state.mode] && !state.rankingPageLoading[state.mode]) {
                const retry = document.createElement('button');
                retry.type = 'button';
                retry.textContent = 'Retry';
                retry.addEventListener('click', onNeedMore);
                footer.append(retry);
            }
            modelRows.append(footer);
        }
        modelRows.scrollTop = scrollTop;
        if (focusKey) [...modelRows.querySelectorAll('[data-model-key]')].find(row => row.dataset.modelKey === focusKey)?.focus({ preventScroll: true });
        if (focusAction) {
            const controls = [...modelRows.querySelectorAll('[data-model-focus-action]')];
            (controls.find(control => control.dataset.modelFocusAction === focusAction && !control.disabled)
                ?? controls.find(control => !control.disabled))?.focus({ preventScroll: true });
        }
        if (changed) {
            if (charts) animateModelColumns(modelRows, previous);
            else animateRankingChanges(modelRows, previous);
        }
        if (!charts && !focused) window.queueMicrotask(() => {
            if (modelRows.isConnected && !modelRows.hidden && page?.hasMore
                && !state.rankingPageLoading[state.mode] && modelRows.clientHeight > 0
                && modelRows.scrollHeight <= modelRows.clientHeight + 120) onNeedMore();
        });
    }

    return { renderModels, clearRankingStatus: () => notice.hide(), getFocusPage,
        setFocusPage(page, { render = true } = {}) {
            focusPage = page;
            if (render) renderModels();
        } };
}
