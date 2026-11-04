import { setLoading } from './shared/loading.js';
import { postJSON } from './shared/http.js';
import { canonicalAccountID, pageAccountWriteScope } from './shared/account-identity.js';
import { createOrganizationMark } from './shared/organization-logos.js?v=organization-logos-20261006';
import { comparisonDisplayParts, renderComparisonName } from './shared/comparison-display.js?v=launch-layout-20261007';
import { rankingNumber } from './shared/ranking-number.js';
import { modelBarColor } from './workspace/score-colors.js';
import { referenceIssueMessage } from './workspace/topic-references.js';
import { isTopicReference, topicLabelText, topicLabelParts, renderTopicLabel, TOPIC_ICON_FONT } from './shared/topic-label.js';
import { readRecentTopics } from './navigation/preferences.js';
import { orderedScenes, sceneURL, searchTopicGroups, sceneMatchSummary } from './navigation/scenes.js';
import { mountSegmentedControl } from './shared/ui-components.js';
import { mountFittedHeadline } from './shared/fitted-headline.js';
import { createModelSearch } from './shared/model-search.js';
import { createFloatingSearchLayer } from './shared/floating-search-layer.js';
import { normalizeModelFocusTarget } from './workspace/model-focus-target.js';
import { topicURL } from './shared/topics.js';
import { createPrivateTopicEditor } from './shared/private-topic-editor.js';
import { createIdentityAvatar as avatar, createTopicCreator } from './shared/topic-identity.js';
import { AVAILABLE_INFERENCE_VERSION } from './shared/available-score.js';
import { buildContributionURL } from './shared/contribution-navigation.js?v=taxonomy-20260929';
import { betaFeedbackTemplate } from './shared/feedback-templates.js';
import { installSignInLinks, listenAccountChange } from './shared/sign-in.js';
import { mountSiteActions } from './shared/site-header.js';
import { FEATURED_TOPIC_ID, TREEMAP_FADE, MAX_BAR_RATIO, WEIGHT_LABEL_METRICS, MODEL_LABEL_ANGLE, MODEL_IDENTITY_HEIGHT, HOME_WEIGHT_THEME, topicCollection, modelTargetURL,
    scoreLabelLayout, orderTopics, modelKey, mergePreview, weightLayout, fitWeightLabel, columnLayout, modelColumnOpacity, modelLabelLayout, modelBarScale, barGeometry } from './topics-home/layout.js';

const $ = selector => document.querySelector(selector);
mountFittedHeadline($('#home-title'));
const siteNavigation = mountSiteActions($('.th-header-links'), { accountID: 'topics-account', moreID: 'topics-more' });
const grid = $('#topics-grid');
const listStatus = $('#topics-status');
const announcement = $('#topics-announcement');
const filters = { scoreMode: 'available', reasoning: false, harness: false, availableInferenceVersion: AVAILABLE_INFERENCE_VERSION };
const cards = new Map();
const scenesDialog = $('#topic-scenes-dialog'), scenesGrid = $('#topic-scenes-grid');
let openSceneTopicID = null;
const cardKey = topic => topic.sceneID == null ? String(topic.ID) : `${topic.ID}:scene:${topic.sceneID}`;
const sceneRequest = topic => topic.sceneID == null ? {} : { sceneID: Number(topic.sceneID) };

function topicsWithScenes(topics) {
    return topics.flatMap(topic => [topic, ...orderedScenes(topic.scenes).map(scene => ({ ...topic,
        sceneID: Number(scene.ID), sceneName: scene.name, topicName: topic.name,
        name: scene.name, description: '', creator: null,
        url: scene.url || sceneURL(canonicalTopicURL(topic), scene), scenes: [], isDefaultScene: scene.isDefault === true
    }))]);
}
const jobs = [];
const activeJobs = new Set();
const canvas = document.createElement('canvas').getContext('2d');
let epoch = 0;
let modelSearchTarget = null;
let modelSearchSequence = 0;
const locateQueue = [];
let activeLocates = 0;
let suspended = false;
let view = 'default';
let profile = null;
let profileReadFailed = false;
let profileLoading = true;
let topicsLoading = false;
let topicsRead = null;
let topicsRefreshQueued = false;
let topicsReadFailed = false;
let directoryView = 'popular';
let previousDirectoryView = 'popular';
let accountEpoch = 0;
let boundAccountID = null;
let accountSessionEnded = false;

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function icon(name) {
    const node = element('i', `fa-solid fa-${name}`);
    node.setAttribute('aria-hidden', 'true');
    return node;
}

function button(label, symbol, className = 'th-icon') {
    const node = element('button', className);
    node.type = 'button'; node.dataset.tooltip = label; node.setAttribute('aria-label', label);
    if (symbol) node.append(icon(symbol));
    return node;
}

function safeURL(value, sameOrigin = false) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
        const url = new URL(value, location.origin);
        if (!['http:', 'https:'].includes(url.protocol) || sameOrigin && url.origin !== location.origin) return null;
        return sameOrigin ? url.pathname + url.search + url.hash : url.href;
    } catch { return null; }
}

function canonicalTopicURL(topic) {
    if (topic.url) return safeURL(topic.url, true);
    try { return safeURL(topicURL(topic.ID, topic.name, topic.isPrivate, topic.slug), true); }
    catch { return null; }
}

function measure(text, kind = 'name') {
    const metrics = WEIGHT_LABEL_METRICS[kind] ?? { fontWeight: 700, fontSize: 12 };
    return topicLabelParts(text).reduce((width, part) => {
        canvas.font = `${part.icon ? 900 : metrics.fontWeight} ${metrics.fontSize}px ${part.icon ? TOPIC_ICON_FONT : 'Manrope'}`;
        return width + canvas.measureText(part.text).width;
    }, 0);
}

function measureModelLabel(text) {
    canvas.font = '400 11px Manrope';
    return canvas.measureText(text).width;
}

function modelColumns(preview, width, count = preview.models.length, total = Math.max(count, preview.pagination?.total ?? count)) {
    const parameters = preview.comparison?.keys?.some(key => key !== 'model');
    let slot = 0;
    if (parameters) for (const model of preview.models) {
        const label = modelLabelLayout(comparisonDisplayParts(model, preview.comparison), measureModelLabel);
        slot = Math.max(slot, label.height / Math.sin(MODEL_LABEL_ANGLE * Math.PI / 180) + 4);
    }
    return columnLayout(width, count, total, Math.ceil(slot), parameters ? 36 : 32);
}

const visibility = 'IntersectionObserver' in window ? new globalThis.IntersectionObserver(entries => {
    for (const entry of entries) {
        const state = cards.get(entry.target.dataset.cardKey);
        if (!state) continue;
        state.visible = entry.isIntersecting;
        if (state.visible && state.loadedEpoch !== epoch && state.status !== 'error') enqueue(state);
        if (state.visible && state.loadedEpoch === epoch) enqueueLocate(state);
    }
    pump();
}, { rootMargin: '160px 0px', threshold: 0 }) : null;

const pendingLayouts = new Set();
let layoutFrame = null;
const resize = new globalThis.ResizeObserver(entries => {
    for (const entry of entries) {
        const state = cards.get(entry.target.closest('.th-card')?.dataset.cardKey);
        if (state?.preview && state.status === 'loaded') pendingLayouts.add(state);
    }
    if (!pendingLayouts.size || layoutFrame !== null) return;
    layoutFrame = requestAnimationFrame(() => {
        layoutFrame = null;
        for (const state of pendingLayouts) {
            if (state.visual.clientWidth !== state.renderWidth || state.visual.clientHeight !== state.renderHeight) renderChart(state);
        }
        pendingLayouts.clear();
    });
});

function createCard(topic) {
    const card = element('article', 'th-card');
    card.dataset.topicId = String(topic.ID);
    card.dataset.cardKey = cardKey(topic);
    card.id = `topic-card-${cardKey(topic).replaceAll(':', '-')}`;
    if (topic.sceneID != null) card.dataset.sceneId = String(topic.sceneID);
    card.classList.toggle('is-featured', Number(topic.ID) === FEATURED_TOPIC_ID && topic.sceneID == null);
    const heading = element('header', 'th-card-header');
    const identity = element('div', 'th-card-identity');
    const title = element('h3', 'th-card-title');
    const href = canonicalTopicURL(topic);
    card.classList.toggle('is-clickable', Boolean(href));
    const link = element(href ? 'a' : 'span', 'th-topic-link');
    link.append(element('span', 'th-topic-name', topic.name), icon('chevron-right'));
    if (href) link.href = href;
    link.dataset.tooltip = topic.description || topic.name;
    title.append(link);
    if (topic.isPrivate) { const lock = icon('lock'); lock.dataset.tooltip = 'Private topic'; lock.setAttribute('aria-label', 'Private topic'); title.append(lock); }
    const creator = topic.creator ? createTopicCreator(topic.creator, 'th-creator') : element('span', 'th-creator');
    creator.hidden = !topic.creator;
    const summary = element('p', 'th-topic-summary', topic.description);
    summary.dataset.tooltip = topic.description || '';
    identity.append(title);
    const sceneToggle = button('Show scenes', 'arrow-up-right-from-square', 'th-scene-toggle');
    sceneToggle.prepend(element('span'));
    sceneToggle.hidden = true;
    sceneToggle.setAttribute('aria-haspopup', 'dialog');
    sceneToggle.setAttribute('aria-controls', 'topic-scenes-dialog');
    delete sceneToggle.dataset.tooltip;
    heading.append(identity);
    if (topic.sceneID == null) heading.append(summary, creator);
    if (topic.isPrivate && topic.sceneID == null) {
        const edit = button('Edit private topic', 'pen-to-square', 'th-quiet th-topic-edit');
        edit.addEventListener('click', event => { event.stopPropagation(); void privateTopicEditor.open(topic.ID, edit); });
        heading.append(edit);
    }
    const visual = element('div', 'th-visual'); visual.dataset.view = view;
    visual.setAttribute('aria-label', `${topic.name} preview`);
    const meta = element('span', 'th-card-notice th-sr-only'); meta.setAttribute('role', 'status');
    const referenceNotice = element('div', 'th-reference-notice'); referenceNotice.hidden = true; referenceNotice.setAttribute('role', 'status');
    const pagination = element('div', 'th-pagination');
    const retryPage = button('Retry more models', 'rotate-right'); retryPage.hidden = true;
    const previous = button('Previous models', 'chevron-left');
    const next = button('Next models', 'chevron-right');
    retryPage.classList.add('th-pagination-retry');
    previous.classList.add('th-pagination-previous'); next.classList.add('th-pagination-next');
    previous.disabled = true; previous.hidden = true; next.disabled = true; next.hidden = true;
    pagination.append(retryPage, previous, next);
    card.append(heading, visual, meta, referenceNotice, sceneToggle);
    const state = { topic, card, visual, meta, referenceNotice, pagination, retryPage, previous, next, sceneToggle,
        visible: !visibility, loadedEpoch: -1, status: 'idle', preview: null,
        queued: false, job: null, geometry: null, scrollLeft: 0, pageError: null, refreshAnchor: null, snapshotNotice: '',
        windowStart: 0, locateSequence: 0, locateQueued: false, locateController: null, loadingEarlier: false };
    let press = null;
    card.addEventListener('pointerdown', event => { press = { x: event.clientX, y: event.clientY, moved: false }; });
    card.addEventListener('pointermove', event => {
        if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 6) press.moved = true;
    });
    card.addEventListener('pointercancel', () => { if (press) press.moved = true; });
    const openCard = event => {
        if (event.defaultPrevented || press?.moved || globalThis.getSelection()?.isCollapsed === false
            || event.target.closest('a,button,input,select,textarea,summary,[role="button"],[contenteditable]')) return;
        const target = canonicalTopicURL(state.topic);
        if (!target || event.altKey) return;
        event.preventDefault();
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1) globalThis.open(target, '_blank', 'noopener');
        else location.assign(target);
    };
    const activateCard = event => {
        if (event.detail && press?.moved) event.preventDefault();
        else openCard(event);
        press = null;
    };
    card.addEventListener('click', event => { if (event.button === 0) activateCard(event); });
    card.addEventListener('auxclick', event => { if (event.button === 1) activateCard(event); });
    sceneToggle.addEventListener('click', () => openScenes(state));
    previous.addEventListener('click', () => moveModels(state, -1));
    next.addEventListener('click', () => moveModels(state, 1));
    retryPage.addEventListener('click', () => {
        if (state.queued || state.job) return;
        if (!snapshotExpired(state.pageError)) { enqueue(state, true, true); return; }
        const index = Math.round((state.scroll?.scrollLeft ?? state.scrollLeft) / state.geometry.slot);
        const model = state.preview.models[index];
        state.refreshAnchor = { index, key: model ? modelKey(model) : null };
        state.scrollLeft = state.scroll?.scrollLeft ?? state.scrollLeft;
        state.loadedEpoch = -1;
        state.snapshotNotice = 'Refreshing expired preview...';
        enqueue(state, false, true);
    });
    cards.set(cardKey(topic), state);
    renderCardState(state);
    return state;
}

function updateCardMetadata(state, topic) {
    state.topic = topic;
    state.card.classList.toggle('is-clickable', Boolean(canonicalTopicURL(topic)));
    const title = state.card.querySelector('.th-card-title a');
    if (title) {
        title.querySelector('.th-topic-name').textContent = topic.name; title.dataset.tooltip = topic.description || topic.name;
        const href = canonicalTopicURL(topic);
        if (href) title.href = href; else title.removeAttribute('href');
    }
    for (const model of state.card.querySelectorAll('a.th-model')) {
        const value = state.preview?.models.find(item => modelKey(item) === model.dataset.modelKey);
        const href = value && modelTargetURL(canonicalTopicURL(topic), value, filters, topic.isPrivate);
        if (href) model.href = href; else model.removeAttribute('href');
    }
    const creator = topic.creator ? createTopicCreator(topic.creator, 'th-creator') : element('span', 'th-creator');
    creator.hidden = !topic.creator;
    state.card.querySelector('.th-creator')?.replaceWith(creator);
    const summary = state.card.querySelector('.th-topic-summary');
    if (summary) { summary.textContent = topic.description || ''; summary.dataset.tooltip = topic.description || ''; }
    state.visual.setAttribute('aria-label', `${topic.name} preview`);
}

function renderScenes() {
    const parent = cards.get(String(openSceneTopicID));
    if (!parent?.topic.scenes?.length) { scenesDialog.close(); return; }
    $('#topic-scene-dialog-title').textContent = parent.topic.name;
    const matching = new Set((parent.matchingScenes ?? []).map(scene => Number(scene.ID)));
    const states = orderedScenes(parent.topic.scenes).map(scene => cards.get(`${parent.topic.ID}:scene:${scene.ID}`)).filter(Boolean);
    scenesGrid.replaceChildren(...states.map(state => state.card));
    for (const state of states) {
        state.card.hidden = false;
        state.card.classList.toggle('is-search-match', matching.has(state.topic.sceneID));
        if (visibility) { visibility.unobserve(state.card); visibility.observe(state.card); }
        else { state.visible = true; enqueue(state); }
        if (state.status === 'loaded') renderChart(state);
    }
    return states.find(state => matching.has(state.topic.sceneID));
}

function openScenes(state) {
    openSceneTopicID = state.topic.ID;
    scenesDialog.showModal();
    const matched = renderScenes();
    scenesGrid.scrollTop = 0;
    matched?.card.scrollIntoView({ block: 'start', behavior: 'instant' });
}

$('#topic-scenes-close').addEventListener('click', () => scenesDialog.close());
scenesDialog.addEventListener('click', event => {
    const box = scenesDialog.getBoundingClientRect();
    if (event.target === scenesDialog && (event.clientX < box.left || event.clientX > box.right
        || event.clientY < box.top || event.clientY > box.bottom)) scenesDialog.close();
});
scenesDialog.addEventListener('close', () => {
    const parent = cards.get(String(openSceneTopicID));
    openSceneTopicID = null;
    for (const state of cards.values()) if (state.topic.sceneID != null) {
        state.card.hidden = true; state.visible = false;
        state.job?.controller.abort(); state.locateController?.abort();
        if (state.status === 'loading') { state.status = 'idle'; renderCardState(state); }
    }
    if (parent && !parent.card.hidden) parent.sceneToggle.focus({ preventScroll: true });
});

function renderCardState(state) {
    state.referenceNotice.hidden = state.status !== 'loaded' || !state.preview?.referenceIssues?.length;
    state.card.dataset.previewState = state.status;
    state.visual.setAttribute('aria-busy', String(['idle', 'loading'].includes(state.status)));
    if (state.status === 'loaded') { renderChart(state); return; }
    const container = element('div', 'th-preview-state');
    container.setAttribute('role', 'status');
    if (state.status === 'loading') setLoading(container, state.snapshotNotice || 'Loading preview');
    else {
        container.append(icon(state.status === 'error' ? 'cloud-arrow-down' : 'chart-simple'));
        container.append(element('span', '', state.status === 'error' ? state.refreshAnchor ? 'Could not refresh this preview.' : 'Could not load this preview.'
            : 'Preview loads when in view'));
    }
    if (state.status === 'error') {
        const retry = button('Retry preview', 'rotate-right', 'th-state-action');
        retry.append(element('span', '', 'Retry')); retry.addEventListener('click', () => enqueue(state, false, true));
        container.append(retry);
    }
    state.visual.replaceChildren(container);
    state.scroll = null;
    state.pagination.hidden = true;
    state.meta.textContent = '';
}

function enqueue(state, page = false, force = false) {
    if (suspended) return;
    if (state.queued || state.job?.epoch === epoch || !force && (!state.visible || state.card.hidden)) return;
    if (page && state.pageError && !force) return;
    if (page && (!state.preview?.pagination?.hasMore || !state.preview.pagination.snapshotID)) return;
    if (!page && state.loadedEpoch === epoch) return;
    state.queued = true;
    jobs.push({ state, page, epoch, filters: { ...filters } });
    pump();
}

function snapshotExpired(error) {
    return error?.status === 410 && error.payload?.error === 'ranking_snapshot_expired';
}

function pump() {
    if (suspended) return;
    while (activeJobs.size < 2 && jobs.length) {
        const job = jobs.shift();
        const { state } = job;
        state.queued = false;
        if (job.epoch !== epoch || state.card.hidden || !state.visible) continue;
        void loadPreview(job);
    }
}

window.addEventListener('pagehide', () => {
    suspended = true;
    jobs.length = 0;
    locateQueue.length = 0;
    for (const state of cards.values()) { state.queued = false; state.locateQueued = false; state.locateController?.abort(); }
    for (const job of activeJobs) job.controller.abort();
});
window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    suspended = false;
    for (const state of cards.values()) {
        if (state.visible && state.status !== 'error' && state.loadedEpoch !== epoch) enqueue(state);
        else enqueueLocate(state);
    }
    pump();
    pumpLocates();
});

async function loadPreview(job) {
    const { state, page } = job;
    const controller = new globalThis.AbortController(); job.controller = controller;
    activeJobs.add(job); state.job = job;
    state.pageError = null;
    if (!page) {
        state.status = 'loading';
        if (state.refreshAnchor) state.preview = null;
    }
    if (page) updatePagination(state); else renderCardState(state);
    const previousPreview = state.preview;
    const pagination = state.preview?.pagination;
    const body = { categoryID: Number(state.topic.ID), ...sceneRequest(state.topic), ...job.filters,
        ...(page ? { snapshotID: pagination.snapshotID, offset: pagination.nextOffset } : {}) };
    const previousOffset = page ? pagination.nextOffset : null;
    try {
        const result = await postJSON('/api/get_topic_preview', body, { signal: controller.signal, timeoutMs: 20000, requireJSON: true });
        if (controller.signal.aborted || job.epoch !== epoch || state.job !== job) return;
        if (Number(result?.topicID) !== Number(state.topic.ID)) throw new TypeError('Wrong topic preview.');
        if (state.topic.sceneID != null && String(result.contextValues?.scene) !== String(state.topic.sceneID)) throw new TypeError('Wrong scene preview.');
        if (page && result.pagination?.snapshotID !== pagination.snapshotID) throw new TypeError('Preview snapshot changed.');
        const incoming = { ...result, topicID: Number(result.topicID) };
        state.preview = mergePreview(page ? state.preview : null, incoming, page);
        if (page && state.preview.pagination?.hasMore && !(state.preview.pagination.nextOffset > previousOffset)) {
            throw new TypeError('Preview pagination did not advance.');
        }
        state.loadedEpoch = epoch; state.status = 'loaded';
        if (!page) state.windowStart = 0;
        if (!page && state.refreshAnchor) {
            state.snapshotNotice = 'Preview refreshed.';
            announcement.textContent = `${state.topic.name}: preview refreshed.`;
        }
    } catch (error) {
        if (controller.signal.aborted || job.epoch !== epoch || state.job !== job) return;
        if (page) {
            state.pageError = error;
            if (snapshotExpired(error)) {
                state.snapshotNotice = 'Preview expired. Retry to refresh.';
                announcement.textContent = `${state.topic.name}: ${state.snapshotNotice}`;
            }
        }
        else { state.status = 'error'; state.error = error; }
    } finally {
        activeJobs.delete(job);
        if (state.job === job) {
            state.job = null;
            if (job.epoch === epoch) {
                if (page && state.status === 'loaded') {
                    if (!state.pageError && !appendModelPage(state, previousPreview)) renderChart(state);
                    updatePagination(state);
                } else renderCardState(state);
                maybeFillPage(state);
                enqueueLocate(state);
                if (controller.signal.aborted && state.visible && !state.card.hidden && state.loadedEpoch !== epoch) enqueue(state);
            }
        }
        pump();
    }
}

function enqueueLocate(state) {
    if (suspended || !modelSearchTarget || state.card.hidden || !state.visible || state.loadedEpoch !== epoch
        || state.status !== 'loaded' || state.job || state.queued || state.locateQueued || state.locateController
        || state.locateSequence === modelSearchTarget.sequence || !state.preview?.pagination?.snapshotID) return;
    state.locateQueued = true;
    locateQueue.push({ state, target: modelSearchTarget, epoch, filters: { ...filters }, snapshotID: state.preview.pagination.snapshotID });
    pumpLocates();
}

function pumpLocates() {
    if (suspended) return;
    while (activeLocates < 3 && locateQueue.length) {
        const job = locateQueue.shift(), { state } = job;
        state.locateQueued = false;
        if (job.epoch !== epoch || job.target !== modelSearchTarget || state.card.hidden || !state.visible) continue;
        void locateInCard(job);
    }
}

async function locateInCard({ state, target, epoch: currentEpoch, filters: currentFilters, snapshotID }) {
    const controller = new globalThis.AbortController();
    state.locateController = controller; activeLocates++;
    try {
        const result = await postJSON('/api/locate_topic_model', { categoryID: Number(state.topic.ID), ...sceneRequest(state.topic), ...currentFilters,
            snapshotID, targetModel: target.id }, { signal: controller.signal, timeoutMs: 20000, requireJSON: true });
        if (controller.signal.aborted || currentEpoch !== epoch || target !== modelSearchTarget
            || state.card.hidden || !state.visible || state.preview?.pagination?.snapshotID !== snapshotID) return;
        if (Number(result?.topicID) !== Number(state.topic.ID) || result.targetModel !== target.id || typeof result.found !== 'boolean') {
            throw new TypeError('Invalid model location');
        }
        state.locateSequence = target.sequence;
        if (!result.found) return;
        const start = result.pagination?.offset;
        if (!Array.isArray(result.models) || result.pagination?.snapshotID !== snapshotID
            || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(result.targetOffset)
            || result.targetOffset < start || result.targetOffset >= start + result.models.length
            || modelKey(result.models[result.targetOffset - start]) !== target.id) throw new TypeError('Invalid model location page');
        state.windowStart = start;
        state.preview = { ...state.preview, models: result.models, pagination: result.pagination };
        state.scrollLeft = 0;
        state.pendingScroll = 0;
        renderChart(state);
        const index = result.targetOffset - start;
        const left = Math.max(0, (index - Math.floor((state.geometry.visible - 1) / 2)) * state.geometry.slot);
        state.scroll?.scrollTo({ left, behavior: globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        const column = [...state.visual.querySelectorAll('.th-model')].find(node => node.dataset.modelKey === target.id);
        if (column) {
            clearTimeout(state.modelHighlightTimer);
            column.classList.add('is-model-jump-focus');
            state.modelHighlightTimer = setTimeout(() => column.classList.remove('is-model-jump-focus'), 1900);
        }
    } catch (error) {
        if (controller.signal.aborted || currentEpoch !== epoch || target !== modelSearchTarget) return;
        state.locateSequence = target.sequence;
        state.meta.textContent = 'Could not locate this model in this topic.';
        announcement.textContent = `${state.topic.name}: could not locate this model.`;
    } finally {
        activeLocates--;
        if (state.locateController === controller) state.locateController = null;
        enqueueLocate(state);
        pumpLocates();
    }
}

async function loadEarlierModels(state) {
    if (state.loadingEarlier || state.job || state.windowStart <= 0 || !state.preview?.pagination?.snapshotID) return;
    const start = state.windowStart, offset = Math.max(0, start - 25), snapshotID = state.preview.pagination.snapshotID;
    const currentEpoch = epoch, previous = state.preview, scrollLeft = state.scroll?.scrollLeft ?? 0;
    state.loadingEarlier = true; updatePagination(state);
    try {
        const result = await postJSON('/api/get_topic_preview', { categoryID: Number(state.topic.ID), ...sceneRequest(state.topic), ...filters, snapshotID, offset },
            { timeoutMs: 20000, requireJSON: true });
        if (currentEpoch !== epoch || state.preview !== previous || result.pagination?.snapshotID !== snapshotID
            || Number(result.topicID) !== Number(state.topic.ID) || !Array.isArray(result.models)
            || result.models.length < start - offset) return;
        const prefix = result.models.slice(0, start - offset);
        state.windowStart = offset;
        state.preview = { ...previous, models: [...prefix, ...previous.models] };
        state.pendingScroll = Math.max(0, scrollLeft + (prefix.length - state.geometry.visible) * state.geometry.slot);
        renderChart(state);
    } catch {
        if (currentEpoch === epoch) state.meta.textContent = 'Could not load earlier models. Try again.';
    } finally { state.loadingEarlier = false; updatePagination(state); }
}

function maybeFillPage(state) {
    if (view !== 'default' || state.status !== 'loaded' || state.pageError || !state.visible) return;
    const preview = state.preview;
    const count = preview?.models.length ?? 0;
    const total = Math.max(count, preview?.pagination?.total ?? count);
    const desired = modelColumns(preview, state.visual.clientWidth, total, total).visible;
    if (count <= desired && preview?.pagination?.hasMore) globalThis.queueMicrotask(() => enqueue(state, true));
}

function weightTooltip(tile) {
    const label = `${tile.name}${tile.conditionName ? ` (${tile.conditionName})` : ''}: ${rankingNumber(tile.share * 100)}%`;
    return tile.members ? `${label}\n${tile.members.map(member => `${member.name}${member.conditionName ? ` (${member.conditionName})` : ''}: ${Number((member.weightBasisPoints / tile.total * 100).toFixed(2))}%`).join('\n')}` : label;
}

function renderWeights(container, weights, width, height, isPrivate = false) {
    const tiles = weightLayout(weights, width, height);
    container.style.setProperty('--th-tile-ink', HOME_WEIGHT_THEME.ink);
    container.style.setProperty('--th-tile-divider', HOME_WEIGHT_THEME.divider);
    container.dataset.texture = HOME_WEIGHT_THEME.texture;
    container.dataset.totalWeight = String(tiles.reduce((sum, tile) => sum + tile.weightBasisPoints, 0));
    container.setAttribute('role', 'img');
    container.setAttribute('aria-label', `${isPrivate ? 'Personal' : 'Community'} benchmark weights. ${tiles.map(weightTooltip).join('; ')}`);
    tiles.forEach((tile, index) => {
        const node = element('div', 'th-tile');
        node.style.cssText = `left:${tile.x}px;top:${tile.y}px;width:${tile.width}px;height:${tile.height}px;background-color:${HOME_WEIGHT_THEME.colors[index % HOME_WEIGHT_THEME.colors.length]}`;
        node.dataset.weightKey = tile.key;
        node.style.setProperty('--th-hatch-angle', index % 2 ? '45deg' : '135deg');
        node.dataset.weight = String(tile.weightBasisPoints);
        node.dataset.share = String(tile.share);
        node.dataset.tooltip = weightTooltip(tile);
        // Foreground bars must not cover the priority labels in the exposed band.
        const labelTile = view === 'default' ? { ...tile, conditionName: '',
            height: Math.min(tile.height, Math.max(0, height * Math.min(TREEMAP_FADE.start, 1 - MAX_BAR_RATIO) - tile.y)) } : tile;
        const fit = fitWeightLabel(isTopicReference(tile) ? { ...labelTile, name: topicLabelText(tile) } : labelTile, measure);
        node.dataset.labelKind = fit.kind;
        const label = element('div', 'th-tile-label'); label.setAttribute('aria-hidden', 'true');
        for (const line of fit.lines) {
            const text = element('span', `th-tile-${line.kind}`, line.text);
            if (line.kind === 'name' && isTopicReference(tile)) renderTopicLabel(text, line.text);
            text.dataset.overflow = String(line.overflow);
            label.append(text);
        }
        const shareTop = fit.height + 6, remainingHeight = tile.height - shareTop - 6;
        const shareSize = Math.floor(Math.min(96, Math.max(32, Math.min(tile.width * .72, remainingHeight / 1.05))));
        if (tile.width >= 20 && remainingHeight >= 18) {
            const number = element('span', 'th-tile-share');
            number.append(element('span', 'th-tile-share-value', String(Math.round(tile.share * 100))), element('span', 'th-tile-share-symbol', '%'));
            number.style.cssText = `top:${shareTop}px;font-size:${shareSize}px`;
            label.append(number);
        }
        node.append(label); container.append(node);
    });
    return tiles.length;
}

function renderModel(model, preview, geometry, plotHeight, scoreScale, topicHref, isPrivate = false) {
    const href = modelTargetURL(topicHref, model, filters, isPrivate);
    const column = element(href ? 'a' : 'div', 'th-model');
    if (href) column.href = href;
    column.classList.toggle('has-many-parts', (preview.comparison?.keys?.length ?? 1) > 2);
    column.dataset.modelKey = modelKey(model);
    column.dataset.rank = String(model.rank ?? '');
    column.style.setProperty('--th-vendor-color', modelBarColor(model));
    const plot = element('div', 'th-model-plot');
    const bar = barGeometry(model, scoreScale, plotHeight);
    const label = bar.comparable ? rankingNumber(model.lower) : '-';
    const labelWidth = measure(label, 'share');
    const scoreLayout = scoreLabelLayout(labelWidth, geometry.barWidth, bar.known, bar.comparable);
    const { outside } = scoreLayout;
    const score = element('span', 'th-model-score', label);
    score.style.fontSize = `${scoreLayout.fontSize}px`; score.style.lineHeight = `${scoreLayout.lineHeight}px`;
    let barLeft = (geometry.slot - geometry.barWidth) / 2;
    if (outside) barLeft = Math.max(2, (geometry.slot - geometry.barWidth - labelWidth - 4) / 2);
    const known = element('span', 'th-model-bar');
    known.style.cssText = `left:${barLeft}px;height:${bar.known}px`;
    known.dataset.scoreHeight = String(bar.known);
    if (filters.scoreMode === 'range' && bar.upper > bar.known) {
        const range = element('span', 'th-model-range');
        range.style.cssText = `left:${barLeft}px;height:${bar.upper}px`;
        range.dataset.scoreHeight = String(bar.upper); plot.append(range);
    }
    if (outside) {
        score.classList.add('is-outside'); score.style.left = `${barLeft + geometry.barWidth + 3}px`;
        score.style.bottom = `${Math.max(0, bar.known - 8)}px`;
        score.style.fontSize = `${Math.min(12, 12 * (geometry.slot - barLeft - geometry.barWidth - 4) / Math.max(1, labelWidth))}px`;
        plot.append(score);
    } else known.append(score);
    plot.append(known);
    const identity = element('div', 'th-model-identity');
    const name = element('span', 'th-model-name'); renderComparisonName(name, model, preview.comparison, { fitParameters: false });
    const labelLayout = modelLabelLayout(comparisonDisplayParts(model, preview.comparison), measureModelLabel);
    const barCenter = barLeft + geometry.barWidth / 2;
    name.style.cssText = `width:${labelLayout.width}px;height:${labelLayout.height}px;left:${barCenter - labelLayout.anchorX}px;top:${labelLayout.top}px;transform:rotate(-${MODEL_LABEL_ANGLE}deg)`;
    [...name.children].forEach((part, index) => {
        part.dataset.lines = String(labelLayout.rows[index].lines);
        part.style.setProperty('--th-label-lines', String(labelLayout.rows[index].lines));
        part.style.height = `${labelLayout.rows[index].lines * 13}px`;
        const text = part.querySelector('span');
        text.replaceChildren(...text.textContent.split(/(\s+)/).filter(Boolean).map(word =>
            /^\s+$/.test(word) ? document.createTextNode(word) : element('span', 'th-label-word', word)));
    });
    const mark = createOrganizationMark(model, 'th-vendor-mark');
    mark.style.transform = `translateX(${barCenter - geometry.slot / 2}px)`;
    identity.append(mark, name);
    const scoreText = !bar.comparable ? 'No comparable score' : filters.scoreMode === 'range'
        ? `Score range ${label} to ${rankingNumber(model.upper)}` : `Score ${label}`;
    column.dataset.tooltip = `${model.modelName || model.name}\n${scoreText}\n${rankingNumber(model.coverage ?? 0)}% benchmark coverage`;
    if (!href) column.setAttribute('role', 'img');
    column.setAttribute('aria-label', `${href ? 'Open ' : ''}${column.dataset.tooltip.replaceAll('\n', '. ')}`);
    column.append(plot, identity);
    return column;
}

function appendModelPage(state, previous) {
    if (view !== 'default' || !state.scroll || !previous) return false;
    const preview = state.preview;
    if (['weights', 'comparison', 'scoreScale'].some(key => preview[key] !== previous[key])
        || previous.models.some((model, index) => preview.models[index] !== model)) return false;
    const geometry = modelColumns(preview, state.visual.clientWidth);
    if (['slot', 'visible', 'width', 'barWidth'].some(key => geometry[key] !== state.geometry[key])
        || state.renderHeight !== state.visual.clientHeight) return false;
    const track = state.scroll.querySelector('.th-model-track');
    if (track.children.length !== previous.models.length) return false;
    const scroll = state.scroll;
    const offset = scroll.scrollLeft;
    // Clear WebKit's constrained end snap target before extending the scroll range.
    scroll.style.scrollSnapType = 'none';
    void scroll.offsetWidth;
    const scoreScale = modelBarScale(preview, filters.scoreMode);
    track.append(...preview.models.slice(previous.models.length).map(model => renderModel(model, preview, geometry, state.visual.clientHeight - state.identityHeight - 1, scoreScale, canonicalTopicURL(state.topic), state.topic.isPrivate)));
    syncModelEdges(state);
    if (Math.abs(scroll.scrollLeft - offset) > .5) scroll.scrollLeft = offset;
    requestAnimationFrame(() => { if (state.scroll === scroll) scroll.style.removeProperty('scroll-snap-type'); });
    state.meta.textContent = state.snapshotNotice;
    state.card.dataset.snapshotId = preview.pagination?.snapshotID ?? '';
    return true;
}

function syncModelEdges(state) {
    if (!state.scroll) return;
    const offset = Math.max(0, Math.min(state.scroll.scrollLeft, state.scroll.scrollWidth - state.scroll.clientWidth));
    for (const [index, model] of [...state.scroll.querySelector('.th-model-track').children].entries()) {
        const opacity = modelColumnOpacity(index, offset, state.geometry);
        model.style.opacity = String(opacity);
        model.setAttribute('aria-hidden', String(opacity === 0));
        model.inert = opacity === 0;
    }
}

function renderChart(state) {
    const preview = state.preview;
    if (!preview || !state.visual.clientWidth || !state.visual.clientHeight) return;
    state.referenceNotice.hidden = !preview.referenceIssues?.length;
    state.referenceNotice.replaceChildren(...(preview.referenceIssues ?? []).map(issue => element('p', '', referenceIssueMessage(issue))));
    state.renderWidth = state.visual.clientWidth; state.renderHeight = state.visual.clientHeight;
    const oldSlot = state.geometry?.slot;
    const oldScroll = state.scroll?.scrollLeft ?? state.scrollLeft;
    const hadFocus = state.scroll === document.activeElement;
    const models = preview.models;
    const total = Math.max(models.length, preview.pagination?.total ?? models.length);
    const geometry = modelColumns(preview, state.visual.clientWidth, models.length, total);
    state.geometry = geometry;
    const frameWidth = view === 'weights' || !models.length ? state.visual.clientWidth : geometry.frameWidth;
    const frame = element('div', 'th-chart-frame'); frame.style.width = `${frameWidth}px`;
    state.identityHeight = preview.comparison?.keys?.some(key => key !== 'model') ? MODEL_IDENTITY_HEIGHT.compared : MODEL_IDENTITY_HEIGHT.normal;
    frame.style.setProperty('--th-identity-height', `${state.identityHeight}px`);
    frame.style.setProperty('--th-label-inset', `${geometry.inset ?? 0}px`);
    const treemap = element('div', 'th-treemap');
    const plotHeight = state.visual.clientHeight - (view === 'default' ? state.identityHeight + 1 : 0);
    treemap.dataset.fadeStart = String(TREEMAP_FADE.start);
    treemap.dataset.fadeEnd = String(TREEMAP_FADE.end);
    const weightCount = renderWeights(treemap, preview.weights ?? [], frameWidth, plotHeight, state.topic.isPrivate);
    frame.append(treemap);
    state.scroll = null;
    if (view === 'default' && models.length) {
        const scroll = element('div', 'th-model-scroll'); scroll.tabIndex = 0;
        scroll.setAttribute('role', 'group'); scroll.setAttribute('aria-label', `${state.topic.name} model results`);
        const track = element('div', 'th-model-track');
        track.style.setProperty('--th-slot', `${geometry.slot}px`);
        track.style.setProperty('--th-bar-width', `${geometry.barWidth}px`);
        const scoreScale = modelBarScale(preview, filters.scoreMode);
        track.append(...models.map(model => renderModel(model, preview, geometry, plotHeight, scoreScale, canonicalTopicURL(state.topic), state.topic.isPrivate)));
        scroll.append(track); frame.append(scroll);
        state.scroll = scroll;
    }
    if (!weightCount && !models.length || view === 'weights' && !weightCount) {
        const empty = element('div', 'th-preview-state');
        empty.append(icon('table-cells-large'), element('span', '', state.topic.isPrivate ? 'No personal weights yet.' : 'No community weights yet.'));
        frame.append(empty);
    } else if (view === 'default' && !models.length) {
        frame.append(element('span', 'th-inline-empty', 'No model results for these settings.'));
    }
    frame.append(state.pagination);
    state.visual.dataset.view = view;
    state.visual.replaceChildren(frame);
    if (state.scroll) {
        const max = Math.max(0, (models.length - geometry.visible) * geometry.slot);
        const anchorIndex = state.refreshAnchor ? models.findIndex(model => modelKey(model) === state.refreshAnchor.key) : -1;
        const offset = state.pendingScroll ?? (state.refreshAnchor ? (anchorIndex < 0 ? state.refreshAnchor.index : anchorIndex) * geometry.slot
            : oldSlot && oldSlot !== geometry.slot ? Math.round(oldScroll / oldSlot) * geometry.slot : oldScroll);
        state.pendingScroll = null;
        state.scroll.scrollLeft = Math.min(max, offset);
        state.scrollLeft = state.scroll.scrollLeft;
        syncModelEdges(state);
        state.refreshAnchor = null;
        if (hadFocus) state.scroll.focus({ preventScroll: true });
        let settle;
        state.scroll.addEventListener('scroll', () => {
            const scroll = state.scroll;
            if (!scroll) return;
            const previousLeft = state.scrollLeft;
            state.scrollLeft = scroll.scrollLeft; syncModelEdges(state); updatePagination(state);
            const remaining = scroll.scrollWidth - scroll.clientWidth - scroll.scrollLeft;
            if (remaining <= geometry.slot * 2 && scroll.scrollLeft > 0 && !state.pageError) enqueue(state, true);
            if (scroll.scrollLeft < previousLeft && scroll.scrollLeft <= geometry.slot * 2 && state.windowStart > 0) void loadEarlierModels(state);
            clearTimeout(settle);
            settle = setTimeout(() => {
                if (state.scroll !== scroll) return;
                const target = Math.round(scroll.scrollLeft / geometry.slot) * geometry.slot;
                if (Math.abs(scroll.scrollLeft - target) > .5) scroll.scrollTo({ left: target,
                    behavior: globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
                state.scrollLeft = scroll.scrollLeft; syncModelEdges(state); updatePagination(state);
            }, 160);
        }, { passive: true });
        state.scroll.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const currentMax = state.scroll.scrollWidth - state.scroll.clientWidth;
            const target = event.key === 'Home' ? 0 : event.key === 'End' ? currentMax
                : state.scroll.scrollLeft + (event.key === 'ArrowRight' ? 1 : -1) * geometry.slot;
            state.scroll.scrollTo({ left: Math.max(0, Math.min(currentMax, target)), behavior: 'auto' });
            if (event.key === 'End') enqueue(state, true);
        });
    } else state.scrollLeft = oldScroll;
    state.meta.textContent = state.snapshotNotice;
    state.card.dataset.snapshotId = preview.pagination?.snapshotID ?? '';
    updatePagination(state);
}

function updatePagination(state) {
    state.pagination.hidden = view === 'weights' || !state.preview?.models.length;
    const scroll = state.scroll;
    if (!scroll) return;
    const noPrevious = scroll.scrollLeft < .5 && state.windowStart === 0;
    const atEnd = scroll.scrollLeft >= scroll.scrollWidth - scroll.clientWidth - .5;
    const noNext = atEnd && (!state.preview.pagination?.hasMore || Boolean(state.pageError));
    if (noPrevious && document.activeElement === state.previous || noNext && document.activeElement === state.next) {
        scroll.focus({ preventScroll: true });
    }
    state.previous.disabled = noPrevious || state.loadingEarlier; state.previous.hidden = noPrevious;
    state.next.disabled = noNext; state.next.hidden = noNext;
    state.retryPage.hidden = !state.pageError;
    const retryLabel = snapshotExpired(state.pageError) ? 'Refresh preview' : 'Retry more models';
    state.retryPage.dataset.tooltip = retryLabel; state.retryPage.setAttribute('aria-label', retryLabel);
    if (snapshotExpired(state.pageError)) {
        state.meta.textContent = state.snapshotNotice;
        state.meta.dataset.tooltip = state.snapshotNotice;
    } else state.meta.removeAttribute('data-tooltip');
    if (state.pageError && !snapshotExpired(state.pageError)) state.meta.textContent = 'Could not load more models. Retry when ready.';
}

function moveModels(state, direction) {
    const scroll = state.scroll;
    if (!scroll) return;
    if (direction < 0 && scroll.scrollLeft < .5 && state.windowStart > 0) { void loadEarlierModels(state); return; }
    const { slot, visible } = state.geometry;
    const target = Math.max(0, Math.min(scroll.scrollWidth - scroll.clientWidth, scroll.scrollLeft + direction * visible * slot));
    scroll.scrollTo({ left: target, behavior: globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    if (direction > 0 && scroll.scrollWidth - scroll.clientWidth - target <= slot * 2) enqueue(state, true);
}

function resetFilters() {
    epoch++;
    modelSearchTarget = null; modelSearchSequence++; locateQueue.length = 0;
    jobs.length = 0;
    for (const job of activeJobs) job.controller.abort();
    for (const state of cards.values()) {
        state.locateController?.abort(); state.locateQueued = false; state.locateSequence = 0; state.windowStart = 0;
        state.queued = false; state.preview = null; state.loadedEpoch = -1; state.status = 'idle';
        state.pageError = null; state.scrollLeft = 0; state.geometry = null; state.refreshAnchor = null; state.snapshotNotice = '';
        renderCardState(state);
        if (state.visible && !state.card.hidden) enqueue(state);
    }
    announcement.textContent = 'Loading updated topic previews.';
}

function filterTopics() {
    const searchAction = $('#topic-search-close');
    const actionLabel = $('#topic-search').value ? 'Clear search' : 'Close search';
    searchAction.setAttribute('aria-label', actionLabel); searchAction.dataset.tooltip = actionLabel;
    const query = $('#topic-search').value.trim().toLocaleLowerCase();
    const topics = topicCollection([...cards.values()].map(state => state.topic).filter(topic => topic.sceneID == null), directoryView,
        readRecentTopics(profile?.userID ?? null), profile?.userID ?? null);
    const groups = directoryView === 'search' ? searchTopicGroups(topics, query)
        : topics.filter(topic => `${topic.name} ${topic.description ?? ''} ${topic.creator?.name ?? ''}`.toLocaleLowerCase().includes(query))
            .map(topic => ({ topic, scenes: [] }));
    const matches = groups.map(group => group.topic);
    const matchedScenes = new Map(groups.map(group => [cardKey(group.topic), group.scenes]));
    for (const state of cards.values()) {
        state.matchingScenes = matchedScenes.get(cardKey(state.topic)) ?? [];
        const summary = sceneMatchSummary(state.matchingScenes);
        state.sceneToggle.hidden = !state.topic.scenes?.length;
        state.sceneToggle.querySelector('span').textContent = summary || `Scenes (${state.topic.scenes?.length ?? 0})`;
        state.sceneToggle.classList.toggle('has-matches', Boolean(summary));
        state.sceneToggle.setAttribute('aria-label', `Show scenes in ${state.topic.name}${summary ? '. ' + summary : ''}`);
        if (summary) state.sceneToggle.dataset.tooltip = summary;
        else delete state.sceneToggle.dataset.tooltip;
    }
    const selected = new Set(matches.map(cardKey));
    const previouslyHidden = new Set();
    for (const state of cards.values()) {
        if (state.card.hidden) previouslyHidden.add(state);
        else if (state.scroll) state.scrollLeft = state.scroll.scrollLeft;
    }
    const orderedCards = matches.map(topic => cards.get(cardKey(topic)).card);
    for (const state of cards.values()) {
        if (state.topic.sceneID != null) {
            if (scenesDialog.open && Number(state.topic.ID) === Number(openSceneTopicID)) continue;
            state.card.hidden = true; state.visible = false; state.job?.controller.abort();
            continue;
        }
        state.card.hidden = !selected.has(cardKey(state.topic));
        if (state.card.hidden) {
            state.visible = false; state.job?.controller.abort();
            if (state.status === 'loading') { state.status = 'idle'; renderCardState(state); }
            orderedCards.push(state.card);
        }
    }
    // Keep unchanged cards connected so focused disclosures retain their transition.
    orderedCards.forEach((card, index) => {
        if (grid.children[index] !== card) grid.insertBefore(card, grid.children[index] ?? null);
    });
    if (scenesDialog.open) renderScenes();
    for (const state of cards.values()) if (!state.card.hidden) {
        if (previouslyHidden.has(state)) {
            // A hide/show within one frame may not produce a new intersection entry.
            if (visibility) { visibility.unobserve(state.card); visibility.observe(state.card); }
            else { state.visible = true; if (state.loadedEpoch !== epoch && state.status !== 'error') enqueue(state); }
        }
        if (previouslyHidden.has(state) && state.status === 'loaded') renderChart(state);
        else if (state.scroll) state.scroll.scrollLeft = state.scrollLeft;
    }
    for (let index = jobs.length - 1; index >= 0; index--) if (jobs[index].state.card.hidden) {
        jobs[index].state.queued = false; jobs.splice(index, 1);
    }
    const count = matches.length;
    announcement.textContent = query ? `${count} matching topic${count === 1 ? '' : 's'}.` : `${count} topics.`;
    if (!topicsLoading && !topicsReadFailed) {
        listStatus.hidden = count > 0;
        if (!count) {
            const accountOnly = directoryView === 'configured' && !profile;
            const message = query ? 'No topics match your search.' : accountOnly ? profileLoading ? 'Loading your account...'
                : 'Sign in to see your topics.'
                : directoryView === 'recent' ? 'No recent topics yet.'
                    : directoryView === 'configured' ? 'No topics in Mine yet.' : 'No topics yet.';
            if (!query && accountOnly && profileLoading) setLoading(listStatus, 'Loading your account');
            else listStatus.replaceChildren(element('span', '', message));
            if (accountOnly && !profileLoading) { const link = element('a', 'th-quiet', 'Sign in'); link.href = '/login'; listStatus.append(link); }
            if (query) {
                const clear = button('Clear search', 'xmark', 'th-state-action'); clear.append(element('span', '', 'Clear search'));
                clear.addEventListener('click', clearSearch);
                listStatus.append(clear);
            }
        }
    }
    pump();
}

const topicSearchPanel = $('#topic-search-panel');
const topicSearchToggle = $('#topic-search-toggle');
const topicSearchLayer = createFloatingSearchLayer({ anchor: topicSearchToggle, panel: topicSearchPanel,
    align: 'start', gap: 8, closeOnFocusOut: false,
    getAnchorRect() {
        const header = $('.th-header').getBoundingClientRect(), content = $('.th-header-inner').getBoundingClientRect();
        return { top: header.top, bottom: header.bottom, left: content.left, right: content.right };
    },
    onClose(reason) {
        $('#topics-navigation').classList.remove('is-searching');
        topicSearchToggle.setAttribute('aria-expanded', 'false');
        if (reason === 'escape') selectDirectoryView(previousDirectoryView);
    }
});

function selectDirectoryView(next, reveal = false) {
    if (next === 'mine') next = 'configured';
    if (next === 'search') {
        if (directoryView !== 'search') previousDirectoryView = directoryView;
    } else { previousDirectoryView = next; $('#topic-search').value = ''; }
    directoryView = next;
    const searching = next === 'search';
    if (!searching) topicSearchLayer.close();
    $('#mine-actions').hidden = next !== 'configured';
    for (const tab of document.querySelectorAll('[data-topics-view]')) {
        const selected = tab.dataset.topicsView === next;
        tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    }
    if (searching) { grid.removeAttribute('aria-labelledby'); grid.setAttribute('aria-label', 'Search results'); }
    else { grid.removeAttribute('aria-label'); grid.setAttribute('aria-labelledby', `topics-${next}`); }
    document.body.dataset.collection = next;
    filterTopics();
    if (reveal) $('#topics').scrollIntoView({ block: 'start', behavior: 'auto' });
    if (searching && document.body.classList.contains('is-scrolled') && topicSearchLayer.open()) {
        $('#topics-navigation').classList.add('is-searching');
        topicSearchToggle.setAttribute('aria-expanded', 'true');
        $('#topic-search').focus({ preventScroll: true });
    }
}

function closeSearch() {
    selectDirectoryView(previousDirectoryView);
    $('#topic-search-toggle').focus({ preventScroll: true });
}

function clearSearch() {
    $('#topic-search').value = '';
    filterTopics();
    $('#topic-search').focus({ preventScroll: true });
}

mountSegmentedControl(document.querySelector('.th-topic-tabs'), { presentation: false });
for (const tab of document.querySelectorAll('[data-topics-view]')) {
    tab.addEventListener('click', () => {
        if (tab.dataset.topicsView === 'search' && topicSearchLayer.isOpen) closeSearch();
        else selectDirectoryView(tab.dataset.topicsView);
    });
    tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const tabs = [...document.querySelectorAll('[data-topics-view]')], index = tabs.indexOf(tab);
        const target = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        selectDirectoryView(target.dataset.topicsView); target.focus({ preventScroll: true });
    });
}
$('#topic-search-close').addEventListener('click', () => {
    if ($('#topic-search').value) clearSearch();
    else closeSearch();
});
for (const control of document.querySelectorAll('[data-open-mine]')) control.addEventListener('click', () => selectDirectoryView('mine', true));
const filterBar = $('#topics-filters');
createModelSearch({ container: $('#home-model-search'),
    async search(query, { signal }) {
        const { reasoning, harness } = filters;
        const result = await postJSON('/api/search_home_models', { query, reasoning, harness },
            { signal, timeoutMs: 20000, requireJSON: true });
        if (filters.reasoning !== reasoning || filters.harness !== harness || !Array.isArray(result?.items)) throw new Error('Comparison changed');
        return result.items.map(item => ({ ...item, targetModel: normalizeModelFocusTarget(item.targetModel), reasoning, harness }));
    },
    onSelect(item) {
        if (filters.reasoning !== item.reasoning || filters.harness !== item.harness) {
            announcement.textContent = 'Comparison settings changed. Search again.'; return;
        }
        if (view !== 'default') $('#topics-view-toggle').click();
        modelSearchTarget = { id: item.targetModel, sequence: ++modelSearchSequence };
        locateQueue.length = 0;
        for (const state of cards.values()) {
            state.locateQueued = false; state.locateController?.abort();
            enqueueLocate(state);
        }
        announcement.textContent = 'Locating the selected model in each topic.';
    }
});
const header = $('.th-header');
const headerPlaceholder = $('.th-header-placeholder');
let headerVisible = false, headerMotion = [], headerMotionRevision = 0, headerReturnFocus = null, headerFocusOrigin = null;
function setHeaderVisible(visible) {
    if (visible === headerVisible) return;
    const floating = document.body.classList.contains('is-scrolled');
    const opacity = floating ? Number.parseFloat(getComputedStyle(header).opacity) : 0;
    const revision = ++headerMotionRevision;
    headerVisible = visible;
    headerMotion.forEach(animation => animation.cancel());
    if (visible) {
        document.body.classList.add('is-scrolled');
        filterBar.hidden = false;
    } else {
        const active = document.activeElement;
        headerFocusOrigin = active;
        headerReturnFocus = header.contains(active) ? active : filterBar.contains(active) ? $('.th-brand') : null;
        if ($('#topics-navigation').contains(active) || topicSearchPanel.contains(active)) headerReturnFocus = $('.th-brand');
        siteNavigation.more.open = false;
    }
    header.inert = !visible;
    filterBar.inert = !visible;
    siteNavigation.refreshLayout();
    const finish = () => {
        if (revision !== headerMotionRevision) return;
        // Keep the fixed layout until its fade finishes, then restore the hero navigation.
        document.body.classList.toggle('is-scrolled', visible);
        filterBar.hidden = !visible;
        header.inert = false;
        headerMotion.forEach(animation => animation.cancel());
        headerMotion = [];
        if (headerReturnFocus && (document.activeElement === document.body || document.activeElement === headerFocusOrigin)) {
            headerReturnFocus.focus({ preventScroll: true });
        }
        headerReturnFocus = null;
        headerFocusOrigin = null;
        siteNavigation.refreshLayout();
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { finish(); return; }
    headerMotion = [header, filterBar].map(node => node.animate([{ opacity }, { opacity: visible ? 1 : 0 }],
        { duration: 220, easing: 'ease-in-out', fill: 'both' }));
    Promise.all(headerMotion.map(animation => animation.finished)).then(finish, () => {});
}
function syncHeader() {
    const restingHeight = headerPlaceholder.getBoundingClientRect().height;
    const threshold = document.body.classList.contains('is-scrolled')
        ? Math.max(restingHeight, header.getBoundingClientRect().height) : restingHeight;
    const passed = $('#home-hero').getBoundingClientRect().bottom <= threshold + 96;
    setHeaderVisible(passed);
    if (!passed) topicSearchLayer.close({ reason: 'header-hidden' });
    document.documentElement.style.setProperty('--th-header-height', `${Math.ceil(header.getBoundingClientRect().height)}px`);
}
const headerResize = new globalThis.ResizeObserver(syncHeader);
headerResize.observe(header);
window.addEventListener('scroll', syncHeader, { passive: true });
window.addEventListener('resize', syncHeader);
syncHeader();
window.addEventListener('focus', () => { if (directoryView === 'recent') filterTopics(); });
window.addEventListener('storage', () => {
    if (directoryView === 'recent') filterTopics();
});

function loadTopics() {
    topicsRefreshQueued = true;
    if (!topicsRead) topicsRead = (async () => {
        do { topicsRefreshQueued = false; await readTopics(); } while (topicsRefreshQueued);
    })().finally(() => { topicsRead = null; });
    return topicsRead;
}

async function readTopics() {
    topicsLoading = true; grid.setAttribute('aria-busy', 'true'); listStatus.hidden = false;
    topicsReadFailed = false;
    setLoading(listStatus, 'Loading topics');
    const requestAccount = accountEpoch;
    try {
        const data = await postJSON('/api/get_topics', {}, { timeoutMs: 20000, requireJSON: true });
        if (requestAccount !== accountEpoch) { topicsRefreshQueued = true; return; }
        if (!Array.isArray(data?.topics)) throw new TypeError('Invalid topics.');
        const fragment = document.createDocumentFragment();
        const discovered = topicsWithScenes(orderTopics(data.topics));
        for (const topic of discovered) {
            const state = cards.get(cardKey(topic)) ?? createCard(topic);
            state.scrollLeft = state.scroll?.scrollLeft ?? state.scrollLeft;
            updateCardMetadata(state, topic);
            cards.delete(cardKey(topic)); cards.set(cardKey(topic), state);
            if (topic.sceneID == null) fragment.append(state.card);
            else state.card.hidden = true;
        }
        grid.querySelectorAll('.th-server-card').forEach(card => card.remove());
        grid.append(fragment);
        const returned = new Set(discovered.map(cardKey));
        for (const [key, state] of cards) if (!returned.has(key)) {
            state.visible = false;
            state.job?.controller.abort(); visibility?.unobserve(state.card); resize.unobserve(state.visual);
            state.card.remove(); cards.delete(key);
        }
        for (const state of cards.values()) {
            if (state.scroll) state.scroll.scrollLeft = state.scrollLeft;
            resize.observe(state.visual);
            if (visibility) visibility.observe(state.card);
            else enqueue(state);
        }
        topicsLoading = false; filterTopics();
    } catch {
        topicsReadFailed = true;
        listStatus.replaceChildren(element('span', '', 'Could not load topics.'));
        const retry = button('Retry topics', 'rotate-right', 'th-state-action'); retry.append(element('span', '', 'Retry'));
        retry.addEventListener('click', loadTopics); listStatus.append(retry);
    } finally { topicsLoading = false; grid.setAttribute('aria-busy', 'false'); }
}

function renderAccount() {
    const account = $('#topics-account');
    if (!profile) {
        account.href = '/login'; account.replaceChildren(icon('user'), element('span', '', 'Sign in'));
        account.removeAttribute('aria-haspopup'); account.setAttribute('aria-label', 'Sign in');
        return;
    }
    account.href = '/account/privacy';
    account.setAttribute('aria-haspopup', 'dialog');
    const name = profile.userName || 'Your account';
    account.replaceChildren(avatar(name, profile.userProfilePictureURL), element('span', '', name));
    account.setAttribute('aria-label', `Open account center: ${name}`);
}

async function loadProfile() {
    profileReadFailed = false;
    profileLoading = true;
    const requestAccount = accountEpoch;
    try {
        const result = await postJSON('/api/get_user_profile', {}, { timeoutMs: 15000, requireJSON: true });
        if (requestAccount !== accountEpoch) return;
        if (!result) {
            if (boundAccountID !== null) { accountSessionEnded = true; pageAccountWriteScope.invalidate(); }
            profile = null; renderAccount(); return;
        }
        const userID = canonicalAccountID(result.userID);
        if (!userID) throw new TypeError('Invalid account identity');
        if (accountSessionEnded || boundAccountID !== null && userID !== boundAccountID) {
            accountSessionEnded = true;
            pageAccountWriteScope.invalidate();
            location.reload();
            return;
        }
        pageAccountWriteScope.bind(userID);
        boundAccountID = userID;
        profile = { ...result, userID }; renderAccount();
    } catch (error) {
        if (requestAccount !== accountEpoch) return;
        if (error.status === 401) {
            if (boundAccountID !== null) accountSessionEnded = true;
            profile = null; pageAccountWriteScope.invalidate(); renderAccount();
        }
        else { profileReadFailed = true; profile = null; renderAccount(); }
    } finally {
        if (requestAccount === accountEpoch) { profileLoading = false; filterTopics(); }
    }
}

async function accountSignedOut({ signedOut = true } = {}) {
    scenesDialog.close();
    if (!signedOut && accountSessionEnded) { location.reload(); return; }
    if (signedOut && boundAccountID !== null) {
        accountSessionEnded = true;
        pageAccountWriteScope.invalidate();
    }
    accountEpoch++; profile = null; profileLoading = false;
    for (const [key, state] of cards) if (state.topic.isPrivate) {
        state.visible = false; state.job?.controller.abort();
        visibility?.unobserve(state.card); resize.unobserve(state.visual); state.card.remove(); cards.delete(key);
    }
    renderAccount(); filterTopics(); await loadProfile(); await loadTopics();
}

const profileReady = loadProfile();
installSignInLinks();
listenAccountChange(signal => { void accountSignedOut({ signedOut: signal === null }); });
const betaFeedbackLink = $('#beta-feedback-link');
function prepareBetaFeedback() {
    betaFeedbackLink.href = buildContributionURL('feedback', {
        details: betaFeedbackTemplate(), pageURL: `${location.origin}${location.pathname}`
    });
}
prepareBetaFeedback();
betaFeedbackLink.addEventListener('click', prepareBetaFeedback);
$('#topics-account').addEventListener('click', async event => {
    if (!profile) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    try {
        const { openAccountCenter } = await import('./shared/account-center.js');
        await openAccountCenter({ profile, onProfileSaved: async saved => {
            profile = { ...profile, ...saved }; renderAccount(); await loadProfile(); await loadTopics();
        }, onSignedOut: accountSignedOut });
    } catch {
        const status = $('#account-status'); status.hidden = false;
        status.replaceChildren(element('span', '', 'Account center is unavailable. '));
        const link = element('a', 'th-quiet', 'Privacy & account choices'); link.href = '/account/privacy'; status.append(link);
    }
});

const privateTopicEditor = createPrivateTopicEditor({
    async beforeOpen() { await profileReady; if (profileReadFailed) await loadProfile(); return true; },
    async onSaved(topic) {
        $('#topic-search').value = '';
        await loadTopics(); resetFilters();
        const card = cards.get(String(topic.ID))?.card;
        card?.scrollIntoView({ block: 'center', behavior: 'auto' });
        card?.querySelector('.th-topic-link')?.focus({ preventScroll: true });
        announcement.textContent = `${topic.name} saved.`;
    },
    async onDeleted() { await loadTopics(); announcement.textContent = 'Private topic deleted.'; }
});
$('#new-private-topic').addEventListener('click', event => void privateTopicEditor.open(null, event.currentTarget));

$('#topics-score-toggle').addEventListener('click', event => {
    filters.scoreMode = filters.scoreMode === 'available' ? 'range' : 'available';
    const range = filters.scoreMode === 'range';
    event.currentTarget.setAttribute('aria-pressed', String(range));
    event.currentTarget.dataset.tooltip = range ? 'Switch to estimated score' : 'Switch to score range';
    event.currentTarget.setAttribute('aria-label', event.currentTarget.dataset.tooltip);
    event.currentTarget.querySelector('span').textContent = range ? 'Score range' : 'Estimated score';
    resetFilters();
});
for (const control of document.querySelectorAll('[data-comparison]')) control.addEventListener('click', () => {
    const key = control.dataset.comparison; filters[key] = !filters[key];
    control.setAttribute('aria-pressed', String(filters[key])); resetFilters();
});
$('#topics-view-toggle').addEventListener('click', event => {
    view = view === 'default' ? 'weights' : 'default';
    const weights = view === 'weights';
    $('#topics-score-toggle').hidden = weights;
    event.currentTarget.setAttribute('aria-pressed', String(weights));
    event.currentTarget.dataset.tooltip = weights ? 'Switch to default view' : 'Switch to benchmark weights';
    event.currentTarget.setAttribute('aria-label', event.currentTarget.dataset.tooltip);
    event.currentTarget.querySelector('span').textContent = weights ? 'Weights' : 'Models';
    event.currentTarget.querySelector('.th-view-indicator').className = `fa-solid fa-${weights ? 'table-cells-large' : 'chart-column'} th-view-indicator`;
    for (const state of cards.values()) if (state.status === 'loaded') { renderChart(state); maybeFillPage(state); }
});
$('#topic-search').addEventListener('input', filterTopics);
document.fonts?.ready.then(() => { for (const state of cards.values()) if (state.status === 'loaded') renderChart(state); });
selectDirectoryView('popular');
void loadTopics();
