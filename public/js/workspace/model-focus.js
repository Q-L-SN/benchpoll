import { HOME_MODEL_FOCUS_PARAMS, findModelFocusIndex, findRenderedModelFocus } from './model-focus-target.js';
export { readHomeModelFocusIntent } from './model-focus-target.js';
import { validateRankingPagePayload } from './contracts.js?v=review-evidence-20261008';
import { RANKING_PAGE_SIZE } from '../shared/ranking-resume.js';
import { quickComparisonFields, readComparisonSettings, writeComparisonSettings } from './comparison-settings.js?v=comparison-experiment-20261007';
import { runFieldKind } from '../shared/score-field-presets.js';
import { modelWindowEdge } from './model-scroll-window.js';

const HIGHLIGHT_MS = 1900;

export function consumeHomeModelFocusURL(win = window) {
    const url = new URL(win.location.href);
    if (!url.searchParams.has('focusModel')) return;
    HOME_MODEL_FOCUS_PARAMS.forEach(key => url.searchParams.delete(key));
    win.history.replaceState(win.history.state, '', url.pathname + url.search + url.hash);
}

// The account's stored controls are untouched until an explicit comparison edit.
export function withHomeFocusComparison({ controls, intent, onChange, onApply, root = document, storage }) {
    let active = intent?.valid === true;
    let accountID = null;
    let metadata = null;
    let options = { mode: 'best', keys: intent?.keys ?? ['model'], filters: [] };
    const buttons = [...root.querySelectorAll('[data-quick-comparison]')];
    for (const button of buttons) button.addEventListener('click', event => {
        if (!active || button.disabled || !button.dataset.fieldKey) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const key = button.dataset.fieldKey;
        options = { ...options, keys: options.keys.includes(key)
            ? options.keys.filter(value => value !== key) : [...options.keys, key] };
        const normalFields = quickComparisonFields(metadata?.fields ?? [], metadata?.availableKeys ?? []);
        options.keys = [...new Set(options.keys.map(key => {
            const kind = runFieldKind(metadata?.fields?.find(field => `field:${field.ID}` === key) ?? {});
            return normalFields[kind === 'effort' ? 'reasoning' : kind] ?? key;
        }))];
        const settings = readComparisonSettings(accountID, storage);
        writeComparisonSettings({ ...settings, basic: options }, accountID, storage);
        active = false;
        controls.configureAccount(accountID);
        if (metadata) controls.render(metadata);
        onChange(structuredClone(options));
    }, { capture: true });
    return {
        configureAccount(userID) {
            accountID = userID;
            const saved = controls.configureAccount(userID);
            return active ? structuredClone(options) : saved;
        },
        render(incoming) {
            metadata = incoming;
            controls.render(incoming);
            if (!active) return;
            options = { mode: 'best', keys: [...incoming.keys], filters: [] };
            onApply(structuredClone(options));
            for (const button of buttons) {
                const kind = button.dataset.quickComparison === 'reasoning' ? 'effort' : 'harness';
                const field = (incoming.fields ?? []).filter(field => runFieldKind(field) === kind
                    && (incoming.availableKeys ?? []).includes(`field:${field.ID}`)).sort((a, b) => a.ID - b.ID)[0];
                const key = field ? `field:${field.ID}` : null;
                button.dataset.fieldKey = key ?? '';
                button.disabled = !key;
                button.setAttribute('aria-pressed', String(Boolean(key && options.keys.includes(key))));
            }
        },
        requestOptions: () => active ? { homeComparison: { ...intent.comparison } } : {},
        reset() {
            if (!active) return null;
            active = false;
            const saved = controls.configureAccount(accountID);
            if (metadata) controls.render(metadata);
            return saved;
        },
        resetToDefault() { active = false; controls.resetToDefault(); }
    };
}

export function validateModelLocatePayload(response, { snapshotID, list, targetModel, scoreMode, total }) {
    const invalid = () => { throw new TypeError('Invalid model location response'); };
    if (!response || response.snapshotID !== snapshotID || response.list !== list || response.targetModel !== targetModel
        || typeof response.found !== 'boolean') invalid();
    if (!response.found) {
        if (response.targetOffset !== null || response.offset !== null || response.page !== null) invalid();
        return response;
    }
    const size = RANKING_PAGE_SIZE[list];
    if (!Number.isSafeInteger(response.targetOffset) || response.targetOffset < 0
        || response.offset !== Math.floor(response.targetOffset / size) * size) invalid();
    const page = validateRankingPagePayload(response.page, { list, offset: response.offset, scoreMode });
    if (page.items.length !== Math.min(size, page.total - response.offset) || page.total !== total || response.targetOffset >= page.nextOffset
        || findModelFocusIndex(page.items, targetModel) !== response.targetOffset - response.offset) invalid();
    return response;
}

export function loadModelFocusStyles(doc = document) {
    if (doc.getElementById('model-focus-styles')) return Promise.resolve();
    const link = doc.createElement('link');
    link.id = 'model-focus-styles';
    link.rel = 'stylesheet';
    link.href = '/css/workspace-model-focus.css?v=home-model-focus-20261024';
    return new Promise(resolve => {
        const finish = () => { globalThis.clearTimeout(timer); resolve(); };
        const timer = globalThis.setTimeout(finish, 1500);
        link.addEventListener('load', finish, { once: true });
        link.addEventListener('error', finish, { once: true });
        doc.head.append(link);
    });
}

export function createModelFocusNotice(rows, doc = document) {
    const notice = doc.createElement('div');
    notice.className = 'bp-model-focus-status';
    notice.setAttribute('role', 'status');
    notice.hidden = true;
    rows.before(notice);
    return message => { notice.textContent = message; notice.hidden = !message; };
}

export function createHomeModelFocus({ intent, state, rows, view, request, showRanking, onMessage,
    win = window, events = document, loadStyles = loadModelFocusStyles }) {
    let pending = Boolean(intent);
    let generation = 0;
    let operation = null;
    let task = null;
    let highlighted = null;
    let highlightTimer = null;
    let automaticFocus = null;
    let stylesReady = intent ? loadStyles() : null;
    let pageOperation = null;
    let pageGeneration = 0;
    let edgeFrame = null;
    const scope = () => JSON.stringify([state.loadSequence, state.categoryID, state.selectedContextValues,
        state.userID, state.mode, state.scoreMode, state.comparisonRequest, state.rankingPagination?.snapshotID]);

    function releaseAutomaticFocus({ blur = false } = {}) {
        const row = automaticFocus;
        automaticFocus = null;
        row?.removeEventListener('blur', releaseAutomaticFocus);
        if (blur && row?.ownerDocument?.activeElement === row) row.blur();
        row?.classList.remove('is-model-jump-auto-focus');
    }

    // Keep the keyboard's starting position without treating a navigation jump as keyboard input.
    function focusAutomatically(row) {
        releaseAutomaticFocus();
        if (!row) return;
        automaticFocus = row;
        row.classList.add('is-model-jump-auto-focus');
        row.addEventListener('blur', releaseAutomaticFocus, { once: true });
        row.focus({ preventScroll: true });
    }

    function clearHighlight({ stopScroll = false } = {}) {
        win.clearTimeout(highlightTimer);
        if (highlighted && stopScroll) {
            const chart = rows.querySelector('.bp-model-chart-scroll');
            for (const scroll of [rows, chart].filter(Boolean)) {
                scroll.scrollTo?.({ top: scroll.scrollTop, left: scroll.scrollLeft, behavior: 'instant' });
            }
            win.scrollTo?.({ top: win.scrollY, left: win.scrollX, behavior: 'instant' });
        }
        highlighted?.classList.remove('is-model-jump-focus');
        highlighted = null;
    }

    function invalidate() {
        ++generation;
        operation?.abort();
        operation = null;
        task = null;
        clearHighlight({ stopScroll: true });
    }

    function stopPaging({ clearPage = false } = {}) {
        ++pageGeneration;
        pageOperation?.abort();
        pageOperation = null;
        const page = view.getFocusPage();
        if (!clearPage && page?.loading) view.setFocusPage({ ...page, loading: false });
    }

    function cancel({ clearPage = false } = {}) {
        pending = false;
        invalidate();
        stopPaging({ clearPage });
        if (clearPage) { view.setFocusPage(null); onMessage(''); }
    }

    const onAction = event => {
        if (event.type === 'keydown' && ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
        if (event.type === 'keydown') releaseAutomaticFocus();
        // Scrolling cancels a one-shot jump, never an adjacent segment download.
        pending = false;
        invalidate();
    };
    const actionEvents = ['pointerdown', 'click', 'keydown', 'wheel', 'touchstart', 'input'];
    for (const type of actionEvents) {
        events.addEventListener(type, onAction, { capture: true, passive: type !== 'keydown' });
    }
    const onExit = () => { cancel({ clearPage: true }); releaseAutomaticFocus({ blur: true }); };
    win.addEventListener('pagehide', onExit);
    win.addEventListener('popstate', onExit);

    async function reveal() {
        if (!pending || task || state.loading || state.comparisonPending || !state.rankingPagination) return task;
        if (!intent.valid) {
            pending = false;
            showRanking();
            onMessage('This model link is invalid. The current ranking is shown.');
            return;
        }
        const focusMode = state.contextIsPrivate ? 'personal' : intent.mode;
        if (state.mode !== focusMode || state.scoreMode !== intent.scoreMode) {
            cancel();
            return;
        }
        const token = ++generation;
        const current = scope();
        const controller = new globalThis.AbortController();
        operation = controller;
        const isCurrent = () => token === generation && current === scope() && !controller.signal.aborted;
        const work = (async () => {
            try {
                onMessage('');
                const list = state.mode;
                const snapshotID = state.rankingPagination.snapshotID;
                const loaded = state.modelLeaderboards[list];
                const index = findModelFocusIndex(loaded, intent.targetModel);
                // Numeric IDs need a full-snapshot uniqueness check, including unloaded variants.
                if (index < 0 || intent.centered || /^[1-9]\d*$/.test(intent.targetModel)) {
                    const result = await request('/api/locate_ranking_model', { snapshotID, list, targetModel: intent.targetModel },
                        { signal: controller.signal, timeoutMs: 15000, requireJSON: true });
                    if (!isCurrent()) return;
                    validateModelLocatePayload(result, { snapshotID, list, targetModel: intent.targetModel,
                        scoreMode: state.scoreMode, total: state.rankingPagination[list].total });
                    if (!result.found) {
                        pending = false;
                        showRanking();
                        onMessage('This model is no longer available in this ranking.');
                        return;
                    }
                    if (index < 0 || intent.centered) {
                        let offset = result.offset;
                        let page = result.page;
                        if (intent.centered) {
                            const size = RANKING_PAGE_SIZE[list];
                            const offsets = [offset - size, offset + size].filter(value => value >= 0 && value < page.total);
                            const adjacent = await Promise.all(offsets.map(async value => ({ offset: value,
                                page: validateRankingPagePayload(await request('/api/get_ranking_page', { snapshotID, list, offset: value },
                                    { signal: controller.signal, timeoutMs: 15000, requireJSON: true }),
                                { list, offset: value, scoreMode: state.scoreMode }) })));
                            if (!isCurrent()) return;
                            const pages = [{ offset, page }, ...adjacent].sort((a, b) => a.offset - b.offset);
                            if (pages.some(item => item.page.total !== page.total)) throw new TypeError('Ranking page changed');
                            offset = pages[0].offset;
                            const last = pages.at(-1).page;
                            page = { ...page, items: pages.flatMap(item => item.page.items),
                                nextOffset: last.nextOffset, hasMore: last.hasMore };
                        }
                        view.setFocusPage({ snapshotID, list, offset, ...page });
                    }
                }
                if (!isCurrent()) return;
                showRanking();
                await (stylesReady ??= loadStyles());
                await new Promise(resolve => win.requestAnimationFrame(resolve));
                if (!isCurrent()) return;
                const row = findRenderedModelFocus(rows, intent.targetModel);
                pending = false;
                if (!row || row.closest('[hidden], [inert]') || !row.getClientRects().length) {
                    onMessage('This model could not be displayed. The current ranking is shown.');
                    return;
                }
                focusAutomatically(row);
                const reduced = win.matchMedia('(prefers-reduced-motion: reduce)').matches;
                row.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center', inline: 'center' });
                row.classList.add('is-model-jump-focus');
                highlighted = row;
                highlightTimer = win.setTimeout(() => { clearHighlight(); scheduleEdges(); }, HIGHLIGHT_MS);
            } catch (error) {
                if (!isCurrent()) return;
                pending = false;
                showRanking();
                onMessage([403, 410].includes(error.status)
                    ? 'This ranking changed. Open the model again from Home.'
                    : 'Could not locate this model. The current ranking is still available.');
            } finally {
                if (token === generation) { operation = null; task = null; }
            }
        })();
        task = work;
        return work;
    }

    async function loadPage(offset) {
        const previous = view.getFocusPage();
        if (!previous || state.loading || state.comparisonPending || previous.loading || !Number.isSafeInteger(offset) || offset < 0
            || offset >= previous.total || offset % RANKING_PAGE_SIZE[previous.list] !== 0
            || ![previous.offset - RANKING_PAGE_SIZE[previous.list], previous.nextOffset].includes(offset)) return;
        const direction = offset < previous.offset ? 'previous' : 'next';
        const token = ++pageGeneration;
        const current = scope();
        const controller = new globalThis.AbortController();
        pageOperation = controller;
        view.setFocusPage({ ...previous, loading: direction, error: '', errorDirection: null });
        try {
            const page = validateRankingPagePayload(await request('/api/get_ranking_page', {
                snapshotID: previous.snapshotID, list: previous.list, offset
            }, { signal: controller.signal, timeoutMs: 15000, requireJSON: true }),
            { list: previous.list, offset, scoreMode: state.scoreMode });
            if (token !== pageGeneration || current !== scope() || controller.signal.aborted) return;
            if (page.items.length !== Math.min(RANKING_PAGE_SIZE[previous.list], previous.total - offset)
                || page.total !== previous.total) throw new TypeError('Ranking page changed');
            view.setFocusPage({ ...previous, loading: false, error: '', errorDirection: null,
                offset: direction === 'previous' ? offset : previous.offset,
                items: direction === 'previous' ? [...page.items, ...previous.items] : [...previous.items, ...page.items],
                nextOffset: direction === 'next' ? page.nextOffset : previous.nextOffset,
                hasMore: direction === 'next' ? page.hasMore : previous.hasMore });
            scheduleEdges();
        } catch (error) {
            if (token !== pageGeneration || current !== scope() || controller.signal.aborted) return;
            view.setFocusPage({ ...previous, loading: false, errorDirection: direction,
                expired: [403, 410].includes(error.status), error: [403, 410].includes(error.status)
                    ? 'Refresh to continue this ranking.' : 'Could not load more models.' });
        } finally { if (token === pageGeneration) pageOperation = null; }
    }

    function checkEdges() {
        const page = view.getFocusPage();
        if (!page || pending || highlighted || state.loading || state.comparisonPending || page.loading || page.error) return;
        const direction = modelWindowEdge(rows, page);
        if (direction) void loadPage(direction === 'previous' ? page.offset - RANKING_PAGE_SIZE[page.list] : page.nextOffset);
    }
    function scheduleEdges() {
        if (edgeFrame !== null || !rows.isConnected) return;
        edgeFrame = win.requestAnimationFrame(() => { edgeFrame = null; checkEdges(); });
    }
    win.addEventListener('scroll', scheduleEdges, { capture: true, passive: true });
    win.addEventListener('resize', scheduleEdges, { passive: true });

    return {
        reveal, cancel, loadPage,
        start(targetModel) {
            cancel();
            intent = { valid: true, targetModel, mode: state.mode, scoreMode: state.scoreMode, centered: true };
            pending = true;
            return reveal();
        },
        get pending() { return pending; },
        get blocksPaging() { return pending || highlighted !== null; },
        suspend() { invalidate(); stopPaging({ clearPage: true }); releaseAutomaticFocus({ blur: true }); view.setFocusPage(null, { render: false }); onMessage(''); },
        destroy() {
            cancel({ clearPage: true });
            releaseAutomaticFocus({ blur: true });
            for (const type of actionEvents) events.removeEventListener(type, onAction, true);
            win.removeEventListener('pagehide', onExit);
            win.removeEventListener('popstate', onExit);
            win.removeEventListener('scroll', scheduleEdges, true);
            win.removeEventListener('resize', scheduleEdges);
            if (edgeFrame !== null) win.cancelAnimationFrame(edgeFrame);
        }
    };
}
