import { setLoading } from './shared/loading.js';
import { postJSON } from './shared/http.js';
import { loginWithGitHub } from './global.js';
import { buildContributionURL } from './shared/contribution-navigation.js?v=clean-20260908';
import { animateContent, setVisible, mountDisclosureMotion, setDisclosureOpen } from './shared/motion.js?v=workspace-ui-20261008';
import { readRankingContext } from './shared/ranking-url.js';
import { orderedScenes } from './navigation/scenes.js';
import { scenePath, topicSlug } from './shared/topics.js';
import { relativeDateAge } from './shared/relative-date.js';
import { createBenchmarkScoresView } from './workspace/benchmark-scores.js?v=model-name-translation-20261006';
import { pageAccountWriteScope, isAccountWriteError } from './shared/account-identity.js';
import { setDiscussionEntryView, readDiscussionEntryContext } from './workspace/discussion-entry.js';
import { createDiscussionAutoLoader } from './shared/discussion-auto-load.js';
import { createAction, mountDisclosureChevron, mountSegmentedControl } from './shared/ui-components.js';
import { profileAvatarURL } from './shared/profile-editor.js';
import { publicGitHubURL } from './shared/topic-identity.js';
import { hasAADisplayRestriction, AA_DISPLAY_MESSAGE } from './shared/aa-ranking-policy.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const state = { categoryID: params.has('categoryID') ? Number(params.get('categoryID')) : null,
    contextValues: {},
    benchmarkID: params.has('benchmarkID') ? Number(params.get('benchmarkID')) : null,
    conditionID: params.has('conditionID') ? Number(params.get('conditionID')) : null,
    threadID: params.has('threadID') ? Number(params.get('threadID')) : null,
    contextID: null, sort: 'hot', allCategories: false, allScenes: false, offset: 0, mentions: [], authenticated: false };
let loadSequence = 0;
let viewSequence = 0;
let profileSequence = 0;
let informationSequence = 0;
let benchmarkInformation = null;
let mentionSequence = 0;
let mentionIndex = 0;
let mentionMatches = [];
let mentionStart = null;
let loading = false;
let readController = null;
let hasMore = false;
let retryAppend = null;
let feedLoaded = false;
let showingScores = false;
let discussionScenes = [];
const sceneTabs = $('discussion-context');
const sceneSegments = mountSegmentedControl(sceneTabs, { presentation: false });
let sceneTabScope = null;
function refreshSceneTabs(reveal = false) {
    sceneSegments.refresh();
    const selected = sceneTabs.querySelector('[aria-selected="true"]');
    if (reveal && selected && sceneTabs.clientWidth) {
        const left = selected.offsetLeft - 16, right = selected.offsetLeft + selected.offsetWidth + 16;
        sceneTabs.scrollTo({ left: Math.max(0, left < sceneTabs.scrollLeft ? left : right > sceneTabs.scrollLeft + sceneTabs.clientWidth
            ? right - sceneTabs.clientWidth : sceneTabs.scrollLeft), behavior: 'instant' });
    }
    const end = sceneTabs.scrollWidth - sceneTabs.clientWidth;
    sceneTabs.classList.toggle('has-overflow-start', sceneTabs.scrollLeft > 1);
    sceneTabs.classList.toggle('has-overflow-end', end > 1 && sceneTabs.scrollLeft < end - 1);
}
sceneTabs.addEventListener('scroll', () => refreshSceneTabs(), { passive: true });
new ResizeObserver(() => refreshSceneTabs(true)).observe(sceneTabs);
function renderSceneScope() {
    const all = $('discussion-all-scenes');
    all.setAttribute('aria-pressed', String(state.allScenes));
    all.setAttribute('aria-label', state.allScenes ? 'Return to selected scene' : 'Show all scenes');
    all.dataset.tooltip = state.allScenes ? 'Showing all scenes · click to return to the selected scene' : 'Show all scenes';
    sceneTabs.classList.toggle('is-all-scenes', state.allScenes);
    sceneTabs.setAttribute('aria-disabled', String(state.allScenes));
    sceneTabs.querySelectorAll('button').forEach(button => { button.disabled = state.allScenes; });
}
const text = $('discussion-text');
const panel = $('discussion-panel');
mountDisclosureMotion(panel, '#benchmark-information-differences');
mountDisclosureChevron($('discussion-compose-toggle'));
const sidebar = document.querySelector('.bp-shell > .bp-sidebar');
const brand = sidebar.querySelector('.bp-brand');
const workspace = document.querySelector('.bp-workspace');
const mobile = window.matchMedia('(max-width: 760px)');
const mobileDiscussionPage = $('workspace-discussion-page');
const discussionHome = panel.parentElement;
const isMobilePage = () => mobile.matches && mobileDiscussionPage?.parentElement?.id === 'workspace-scene-panel';
let mobileReturnPanel = 'models', hasMobileView = false;
const drafts = new Map();
let isOpen = false;
let returnFocus = null;
let workspaceScrollY = 0;
let workspaceContext = null;
let contextWeights = null;
let informationOnly = false;
const autoLoader = createDiscussionAutoLoader({ root: panel.querySelector('.discussion-scroll'), sentinel: $('discussion-more'),
    canLoad: () => canReadDiscussion() && !loading && hasMore && retryAppend === null,
    loadMore: () => load(true) });
$('discussion-more').setAttribute('aria-live', 'polite');
const benchmarkScores = createBenchmarkScoresView({ onViewChange(showScores) {
    const returningToDiscussion = showingScores && !showScores;
    showingScores = showScores;
    $('benchmark-scores-view').hidden = !showScores;
    $('benchmark-discussion-view').hidden = showScores || informationOnly;
    $('discussion-composer').hidden = showScores || informationOnly;
    $('private-benchmark-discussion-notice').hidden = showScores || !informationOnly;
    $('benchmark-information-condition').hidden = true;
    $('benchmark-information-status').hidden = showScores;
    for (const [id, selected] of [['benchmark-scores-back', !showScores], ['benchmark-scores-open', showScores]]) {
        $(id).setAttribute('aria-selected', String(selected));
        $(id).tabIndex = selected ? 0 : -1;
    }
    if (showScores) stopDiscussionRead();
    else if (returningToDiscussion && canReadDiscussion() && !feedLoaded && retryAppend === null) void load();
    syncDiscussionAutoLoad();
    if (!showScores) animateContent($('benchmark-discussion-view'));
} });
$('benchmark-scores-open').addEventListener('click', () => {
    if (!benchmarkInformation) return;
    if ($('benchmark-scores-view').hidden) benchmarkScores.open(benchmarkInformation);
});
document.querySelector('.benchmark-view-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !benchmarkInformation) return;
    event.preventDefault();
    const tab = event.key === 'Home' || event.key === 'ArrowLeft' ? $('benchmark-scores-back') : $('benchmark-scores-open');
    tab.focus(); tab.click();
});
const draftKey = () => `${state.categoryID}:${state.benchmarkID ?? ''}:${state.conditionID ?? ''}:${state.threadID ?? 'new'}:${JSON.stringify(Object.entries(state.contextValues).sort(([left], [right]) => left.localeCompare(right)))}`;
const draftSnapshot = () => ({ text: text.value, mentions: structuredClone(state.mentions) });
const sameDraft = (left, right) => left && left.text === right.text
    && JSON.stringify(left.mentions) === JSON.stringify(right.mentions);
function saveDraft() {
    drafts.set(draftKey(), { ...draftSnapshot(), error: drafts.get(draftKey())?.error });
}
function restoreDraft() {
    const draft = drafts.get(draftKey());
    text.value = draft?.text || '';
    state.mentions = structuredClone(draft?.mentions || []);
    $('composer-status').textContent = draft?.error || '';
    renderMentions();
}
function setComposerExpanded(expanded, focus = false) {
    setVisible($('discussion-compose-fields'), expanded, { collapse: true });
    $('discussion-compose-toggle').setAttribute('aria-expanded', String(expanded));
    if (!expanded) closeSuggestions();
    if (focus) (expanded ? text : $('discussion-compose-toggle')).focus({ preventScroll: true });
}
function updatePanelAccess() {
    const embedded = isMobilePage();
    if (embedded && panel.parentElement !== mobileDiscussionPage) mobileDiscussionPage.append(panel);
    else if (!embedded && panel.parentElement !== discussionHome) discussionHome.append(panel);
    if (isOpen && !embedded) document.body.classList.add('discussion-open');
    else document.body.classList.remove('discussion-open');
    if (isOpen && !embedded) $('discussion-brand-slot').append(brand);
    else sidebar.prepend(brand);
    const entry = $('discussion-entry');
    $('workspace-refresh').before(entry);
    sidebar.inert = isOpen && !embedded;
    sidebar.setAttribute('aria-hidden', String(sidebar.inert));
    workspace.inert = isOpen && mobile.matches && !embedded;
    panel.inert = !isOpen;
    panel.setAttribute('aria-hidden', String(!isOpen));
    panel.setAttribute('role', embedded ? 'region' : mobile.matches ? 'dialog' : 'complementary');
    if (mobile.matches && !embedded) panel.setAttribute('aria-modal', String(isOpen));
    else panel.removeAttribute('aria-modal');
}
function closeDiscussion() {
    if (!isOpen) return;
    saveDraft();
    isOpen = false;
    viewSequence++;
    informationSequence++;
    stopDiscussionRead();
    $('benchmark-information').setAttribute('aria-busy', 'false');
    $('discussion-feed').setAttribute('aria-busy', 'false');
    benchmarkScores.reset();
    document.body.classList.remove('discussion-open');
    $('discussion-entry').setAttribute('aria-expanded', 'false');
    setDiscussionEntryView($('discussion-entry'), false);
    updatePanelAccess();
    closeSuggestions();
    if (isMobilePage()) {
        workspace.dataset.mobilePanel = mobileReturnPanel;
        document.querySelector(`[data-mobile-panel="${mobileReturnPanel}"]`)?.focus({ preventScroll: true });
        return;
    }
    if (mobile.matches) window.scrollTo({ top: workspaceScrollY, behavior: 'instant' });
    const sourceRow = returnFocus?.closest('.bp-benchmark-row');
    const familyKey = sourceRow?.dataset.familyKey;
    const memberKey = returnFocus?.dataset.familyMemberKey;
    const currentRow = sourceRow ? [...document.querySelectorAll('.bp-benchmark-row')].find(row => familyKey
        ? row.dataset.familyKey === familyKey
        : !row.classList.contains('is-family') && row.dataset.conditionId === sourceRow.dataset.conditionId) : null;
    const currentControl = memberKey
        ? [...currentRow?.querySelectorAll('[data-family-member-key]') ?? []].find(link => link.dataset.familyMemberKey === memberKey)
        : currentRow?.querySelector('[data-benchmark-control="information"], [data-family-control="information"]');
    (returnFocus?.isConnected ? returnFocus : currentControl ?? $('discussion-entry')).focus({ preventScroll: true });
}
async function openDiscussion(url, trigger = null, { allCategories = false, navigate = true } = {}) {
    let contextValues;
    try { contextValues = readRankingContext(url.search); }
    catch (error) { showError(error); return; }
    if (isOpen) saveDraft();
    viewSequence++;
    stopDiscussionRead();
    hasMore = false; retryAppend = null; feedLoaded = false; showingScores = false;
    state.offset = 0;
    $('discussion-more').hidden = true;
    closeSuggestions();
    const query = url.searchParams;
    informationOnly = workspaceContext?.isPrivate === true;
    state.categoryID = query.has('categoryID') ? Number(query.get('categoryID')) : workspaceContext?.categoryID ?? null;
    const namedScene = [...discussionScenes, ...(workspaceContext?.scenes ?? [])]
        .find(scene => (scene.slug || topicSlug(scene.name)) === url.pathname.split('/').filter(Boolean).at(-1));
    state.contextValues = namedScene ? { scene: String(namedScene.ID) } : url.pathname === location.pathname && workspaceContext
        && Number(state.categoryID) === Number(workspaceContext.categoryID)
        ? { ...contextValues, ...workspaceContext.contextValues } : contextValues;
    state.benchmarkID = query.has('benchmarkID') ? Number(query.get('benchmarkID')) : null;
    state.conditionID = query.has('conditionID') ? Number(query.get('conditionID')) : null;
    state.threadID = query.has('threadID') ? Number(query.get('threadID')) : null;
    panel.dataset.view = state.threadID ? 'thread' : 'feed';
    state.contextID = null; state.allCategories = Boolean(state.benchmarkID && !state.threadID && allCategories);
    state.allScenes = query.get('allScenes') === '1';
    renderDiscussionScope();
    restoreDraft();
    setComposerExpanded(Boolean(state.threadID || text.value || state.mentions.length));
    if (!isOpen) {
        returnFocus = trigger || $('discussion-entry');
        workspaceScrollY = window.scrollY;
    } else if (trigger === $('discussion-entry')) returnFocus = trigger;
    isOpen = true;
    if (isMobilePage()) {
        hasMobileView = true;
        if (navigate) workspace.dataset.mobilePanel = 'discussion';
    }
    document.body.classList.remove('taxonomy-open');
    $('taxonomy-toggle').setAttribute('aria-expanded', 'false');
    document.body.classList.add('discussion-open');
    $('discussion-entry').setAttribute('aria-expanded', 'true');
    setDiscussionEntryView($('discussion-entry'), state.benchmarkID !== null && !informationOnly);
    updatePanelAccess();
    if (!isMobilePage()) $('discussion-close').focus({ preventScroll: true });
    await Promise.all([loadBenchmarkInformation(), informationOnly ? Promise.resolve() : load()]);
}
document.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (!link || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    const url = new URL(link.href);
    if (url.origin !== location.origin || url.searchParams.get('discussion') !== '1') return;
    event.preventDefault();
    openDiscussion(url, link);
});
function updateWorkspaceContext(event) {
    const next = event.detail;
    const firstContext = workspaceContext === null;
    if (firstContext && params.get('discussion') === '1') {
        workspaceContext = next;
        void openDiscussion(new URL(location.href));
        return;
    }
    if (next.isPrivate && !isMobilePage()) { workspaceContext = next; if (isOpen) closeDiscussion(); return; }
    const changed = workspaceContext && JSON.stringify(workspaceContext) !== JSON.stringify(next);
    const initialContext = !workspaceContext && isOpen && !state.threadID
        && (state.categoryID === null || Number(state.categoryID) === Number(next.categoryID));
    workspaceContext = next;
    if ((changed || initialContext) && isOpen) {
        const url = new URL(location.href);
        url.search = new URLSearchParams({ discussion: '1', categoryID: String(next.categoryID),
            ...Object.fromEntries(Object.entries(next.contextValues).filter(([key]) => key !== 'scene').map(([key, value]) => [`context_${key}`, value])) });
        if (state.benchmarkID !== null) url.searchParams.set('benchmarkID', state.benchmarkID);
        if (state.conditionID !== null) url.searchParams.set('conditionID', state.conditionID);
        openDiscussion(url, null, { allCategories: state.allCategories, navigate: !isMobilePage() || workspace.dataset.mobilePanel === 'discussion' });
    }
    if (isMobilePage() && workspace.dataset.mobilePanel === 'discussion' && !isOpen) activateMobileDiscussion();
}
function activateMobileDiscussion() {
    if (!isMobilePage() || isOpen || !workspaceContext) return;
    const url = new URL(location.href);
    url.search = new URLSearchParams({ discussion: '1', categoryID: String(workspaceContext.categoryID) });
    const sameContext = Number(state.categoryID) === Number(workspaceContext.categoryID)
        && JSON.stringify(state.contextValues) === JSON.stringify(workspaceContext.contextValues);
    if (hasMobileView && sameContext) {
        for (const key of ['benchmarkID', 'conditionID', 'threadID']) if (state[key] !== null) url.searchParams.set(key, String(state[key]));
    }
    void openDiscussion(url, null, { navigate: false, allCategories: hasMobileView && sameContext && state.allCategories });
}
window.addEventListener('benchpoll:mobile-panel-preview', event => {
    if (event.detail.panel === 'discussion') activateMobileDiscussion();
});
window.addEventListener('benchpoll:mobile-panel', event => {
    if (!isMobilePage()) return;
    if (event.detail.panel === 'discussion') { activateMobileDiscussion(); return; }
    mobileReturnPanel = event.detail.panel;
    if (!isOpen) return;
    saveDraft(); isOpen = false; viewSequence++; informationSequence++;
    stopDiscussionRead(); closeSuggestions(); updatePanelAccess();
});
window.addEventListener('benchpoll:discussion-context', updateWorkspaceContext);
window.addEventListener('benchpoll:context-weights', event => {
    contextWeights = event.detail;
    renderInformationWeights();
});

function renderInformationWeights() {
    const host = $('benchmark-information-weights');
    const sameValues = (left, right) => JSON.stringify(Object.entries(left).sort(([a], [b]) => a.localeCompare(b)))
        === JSON.stringify(Object.entries(right).sort(([a], [b]) => a.localeCompare(b)));
    host.hidden = !benchmarkInformation || hasAADisplayRestriction(benchmarkInformation)
        || !contextWeights || contextWeights.categoryID !== state.categoryID
        || !sameValues(contextWeights.contextValues, state.contextValues);
    if (host.hidden) return;
    const personal = contextWeights.personal.find(entry => Number(entry.conditionID) === state.conditionID)?.weightBasisPoints ?? 0;
    const publicWeight = contextWeights.public.find(entry => Number(entry.conditionID) === state.conditionID)?.weightBasisPoints ?? 0;
    $('benchmark-personal-weight').textContent = `${Math.round(personal / 100)}%`;
    $('benchmark-public-weight').textContent = `${(publicWeight / 100).toFixed(2)}%`;
    $('benchmark-public-weight-group').hidden = contextWeights.isPrivate;
    const scope = `${contextWeights.categoryName ?? contextWeights.lineage?.at(-1)?.name ?? (contextWeights.categoryPath ?? '').replaceAll('/', ' / ')}${Object.keys(state.contextValues).length ? ` / ${contextLabel(state.contextValues)}` : ''}`;
    $('benchmark-weight-context').textContent = scope;
    $('benchmark-weight-context').dataset.tooltip = scope;
    host.setAttribute('aria-label', `Benchmark weights in ${scope}`);
    host.dataset.mode = contextWeights.mode;
}

const errors = {
    discussion_post_cooldown: 'Please wait 30 seconds between messages.',
    discussion_daily_limit: 'You have reached the daily message limit. Please try again tomorrow.',
    discussion_self_vote: 'You cannot vote on your own message.',
    discussion_post_unavailable: 'This discussion is unavailable or has been hidden by a reviewer.',
    discussion_parent_unavailable: 'This thread is no longer available.',
    authentication_required: 'Please sign in to participate.',
    discussion_text_length: 'Write between 2 and 4,000 characters.',
    discussion_benchmark_unavailable: 'A referenced benchmark is no longer available. Remove it and try again.',
    discussion_condition_unavailable: 'A referenced benchmark version is no longer available. Remove it and try again.'
};
function showError(error) {
    $('discussion-error').hidden = false;
    $('discussion-error').textContent = isAccountWriteError(error) ? error.message
        : errors[error.message] || 'Could not complete the request. Please try again.';
}
function node(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = content;
    return element;
}
async function loadBenchmarkInformation() {
    const sequence = ++informationSequence;
    const host = $('benchmark-information');
    benchmarkInformation = null;
    benchmarkScores.reset();
    host.hidden = state.conditionID === null;
    const discussionView = $('benchmark-discussion-view');
    if (host.hidden) { discussionView.removeAttribute('role'); discussionView.removeAttribute('aria-labelledby'); }
    else { discussionView.setAttribute('role', 'tabpanel'); discussionView.setAttribute('aria-labelledby', 'benchmark-scores-back'); }
    host.setAttribute('aria-busy', String(!host.hidden));
    $('benchmark-discussion-heading').hidden = host.hidden || informationOnly;
    $('category-path').hidden = !host.hidden;
    $('discussion-title').textContent = host.hidden ? 'Discussion' : 'Benchmark';
    for (const id of ['benchmark-information-name', 'benchmark-information-condition', 'benchmark-information-description', 'benchmark-information-updated', 'benchmark-information-age']) $(id).textContent = '';
    $('benchmark-information-change').hidden = true;
    $('benchmark-scores-open').hidden = true;
    $('benchmark-information-description').hidden = true;
    $('benchmark-information-differences').hidden = true;
    void setDisclosureOpen($('benchmark-information-differences'), false, { animate: false });
    $('benchmark-information-difference-explanation').textContent = '';
    $('benchmark-information-weights').hidden = true;
    $('benchmark-information-updated').removeAttribute('datetime');
    host.querySelector('.benchmark-information-meta').hidden = true;
    if (host.hidden) return;
    host.setAttribute('aria-busy', 'true');
    setLoading($('benchmark-information-status'), 'Loading benchmark information');
    try {
        const info = await postJSON('/api/get_benchmark_information', { conditionID: state.conditionID }, { timeoutMs: 60000 });
        if (sequence !== informationSequence || !isOpen) return;
        if (Number(info.benchmarkID) !== state.benchmarkID || Number(info.conditionID) !== state.conditionID) throw new Error('Benchmark identity changed');
        if (typeof info.isPrimaryCondition !== 'boolean') throw new Error('Benchmark primary-version flag is missing');
        benchmarkInformation = info;
        renderInformationWeights();
        const heading = $('benchmark-information-name');
        heading.textContent = info.name;
        try {
            const url = new URL(info.introductionURL);
            if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
                const link = document.createElement('a');
                link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
                link.textContent = info.name; link.dataset.tooltip = 'Open benchmark website in a new tab';
                heading.replaceChildren(link);
            }
        } catch { /* Benchmarks without a valid public URL keep a plain title. */ }
        $('benchmark-scores-open').hidden = false;
        if (hasAADisplayRestriction(info)) {
            $('benchmark-information-status').textContent = AA_DISPLAY_MESSAGE;
            return;
        }
        host.querySelector('.benchmark-information-meta').hidden = false;
        $('benchmark-information-description').textContent = info.description;
        $('benchmark-information-description').hidden = !info.description;
        $('benchmark-information-difference-explanation').textContent = info.differenceExplanation;
        void setDisclosureOpen($('benchmark-information-differences'), !info.isPrimaryCondition, { animate: false });
        $('benchmark-information-differences').hidden = !info.differenceExplanation;
        const updated = $('benchmark-information-updated');
        if (info.scoresUpdatedAt) {
            const date = new Date(info.scoresUpdatedAt);
            updated.dateTime = date.toISOString();
            updated.textContent = date.toLocaleDateString(document.documentElement.lang || 'en', { year: 'numeric', month: 'short', day: 'numeric' });
            updated.dataset.tooltip = date.toLocaleString();
            $('benchmark-information-age').textContent = `(${relativeDateAge(date)})`;
        } else updated.textContent = 'No scores yet';
        const change = $('benchmark-information-change');
        change.href = buildContributionURL('edit_benchmark', { targetBenchmarkID: info.benchmarkID });
        change.hidden = false;
        $('benchmark-scores-open').hidden = false;
        $('benchmark-information-status').textContent = '';
    } catch (error) {
        if (sequence !== informationSequence) return;
        $('benchmark-information-status').textContent = 'Could not load benchmark information. Close and reopen to retry.';
        console.error(error);
    } finally { if (sequence === informationSequence) host.setAttribute('aria-busy', 'false'); }
}
function contextLabel(values) {
    if (values.scene) return discussionScenes.find(scene => Number(scene.ID) === Number(values.scene))?.name ?? `Scene ${values.scene}`;
    return Object.values(values).filter(Boolean).join(' / ');
}
function discussionURL(extra = {}) {
    const url = new URL(location.pathname, location.origin);
    const scene = discussionScenes.find(item => String(item.ID) === state.contextValues.scene);
    if (scene) url.pathname = scenePath(url.pathname, scene);
    url.searchParams.set('discussion', '1');
    if (state.allScenes) url.searchParams.set('allScenes', '1');
    if (state.categoryID) url.searchParams.set('categoryID', state.categoryID);
    Object.entries(state.contextValues).forEach(([key, value]) => { if (key !== 'scene') url.searchParams.set(`context_${key}`, value); });
    Object.entries(extra).forEach(([key, value]) => { if (value != null) url.searchParams.set(key, value); });
    return url.pathname + url.search;
}
let currentPublicProfile = null;
function renderAuthorIdentity(host, displayName, avatarURL, githubURL = null) {
    host.replaceChildren();
    const github = githubURL ? publicGitHubURL(githubURL) : null;
    const identity = github ? node('a', 'bp-public-github-link') : host;
    if (github) {
        identity.href = github; identity.target = '_blank'; identity.rel = 'noopener noreferrer nofollow';
        identity.referrerPolicy = 'no-referrer';
        host.append(identity);
    }
    const url = profileAvatarURL(avatarURL);
    if (url) {
        const avatar = node('img');
        avatar.src = url;
        avatar.alt = '';
        avatar.width = avatar.height = 24;
        avatar.referrerPolicy = 'no-referrer';
        avatar.addEventListener('error', () => avatar.remove(), { once: true });
        identity.append(avatar);
    }
    identity.append(node('strong', '', displayName));
}
document.addEventListener('benchpoll:profile-updated', event => {
    const profile = event.detail;
    try { if (profile?.userID !== pageAccountWriteScope.capture() || typeof profile.userName !== 'string') return; }
    catch { return; }
    currentPublicProfile = profile;
    document.querySelectorAll('.bp-discussion-author[data-profile-self="true"]').forEach(author => {
        renderAuthorIdentity(author, profile.userName, profile.userProfilePictureURL,
            profile.showGitHubProfile === true ? profile.githubURL : null);
    });
});
function renderPost(post, isRoot = false) {
    const view = viewSequence;
    const isCurrentView = () => view === viewSequence && isOpen;
    const article = node('article', 'discussion-post');
    if (isRoot) article.classList.add('is-root');
    else if (post.parentID != null) article.classList.add('is-reply');
    article.id = `post-${post.ID}`;
    const meta = node('div', 'discussion-post-meta');
    const date = new Date(post.createdAt);
    const time = node('time', '', date.toLocaleDateString(document.documentElement.lang || 'en', { month: 'short', day: 'numeric',
        ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) }));
    time.dataset.tooltip = date.toLocaleString();
    time.dateTime = new Date(post.createdAt).toISOString();
    const author = node('span', 'bp-discussion-author');
    author.dataset.profileSelf = String(Boolean(post.isOwn && !post.isDeleted));
    let updatedProfile = post.isOwn && !post.isDeleted ? currentPublicProfile : null;
    if (updatedProfile) {
        try { if (updatedProfile.userID !== pageAccountWriteScope.capture()) updatedProfile = null; }
        catch { currentPublicProfile = updatedProfile = null; }
    }
    renderAuthorIdentity(author, updatedProfile?.userName ?? post.authorName,
        post.isDeleted ? null : updatedProfile ? updatedProfile.userProfilePictureURL : post.authorAvatarURL,
        post.isDeleted ? null : updatedProfile ? updatedProfile.showGitHubProfile === true ? updatedProfile.githubURL : null : post.githubURL);
    meta.append(author, time);
    const taskValues = Object.fromEntries(Object.entries(post.contextValues).filter(([, value]) => value && value !== 'any'));
    const metadata = [state.allCategories ? post.categoryName : '', Object.keys(taskValues).length ? contextLabel(taskValues) : ''].filter(Boolean);
    if (metadata.length) meta.append(node('span', 'discussion-context-badge', metadata.join(' / ')));
    const mentions = node('div', 'discussion-mentions');
    for (const mention of post.mentions) {
        const link = node('a', '', `@${mention.label}`);
        if (mention.benchmarkID) link.href = discussionURL({ benchmarkID: mention.benchmarkID, conditionID: mention.conditionID });
        mentions.append(link);
    }
    const actions = node('div', 'discussion-post-actions');
    for (const [value, count, icon, label] of [[1, post.upvotes, 'fa-thumbs-up', 'Like'], [-1, post.downvotes, 'fa-thumbs-down', 'Dislike']]) {
        const button = createAction({ label: String(count), icon: `fa-regular ${icon}`, variant: 'quiet' });
        button.setAttribute('aria-label', `${label} post ${post.ID}: ${count}`);
        button.setAttribute('aria-pressed', String(post.myVote === value));
        button.dataset.tooltip = label;
        button.disabled = post.isOwn || post.isDeleted;
        button.addEventListener('click', async () => {
            if (!isCurrentView() || !canReadDiscussion()) return;
            if (!state.authenticated) { loginWithGitHub(); return; }
            button.disabled = true;
            try {
                await pageAccountWriteScope.write(postJSON, '/api/vote_discussion', { postID: post.ID, value: post.myVote === value ? 0 : value });
                if (isCurrentView()) await load(false);
            } catch (error) { if (isCurrentView() && canReadDiscussion()) showError(error); }
            finally { button.disabled = post.isOwn || post.isDeleted; }
        });
        actions.append(button);
    }
    if (post.parentID === null && !isRoot) {
        const reply = createAction({ label: `${post.replyCount} replies`, icon: 'fa-regular fa-comment',
            href: discussionURL({ threadID: post.ID }), variant: 'quiet' });
        actions.append(reply);
    }
    const permalink = createAction({ label: 'Link to this message', icon: 'fa-solid fa-link',
        href: discussionURL({ threadID: post.ID }), variant: 'quiet', iconOnly: true });
    const report = createAction({ label: 'Report this message', icon: 'fa-regular fa-flag',
        href: buildContributionURL('report', { postID: post.ID }), variant: 'quiet', iconOnly: true, className: 'discussion-report' });
    report.setAttribute('aria-label', `Report post ${post.ID}`);
    actions.append(permalink);
    if (!post.isDeleted) actions.append(report);
    if (post.isDeleted) actions.querySelectorAll('button').forEach(button => button.remove());
    if (post.isOwn && !post.isDeleted) {
        const remove = createAction({ label: 'Delete your message', icon: 'fa-regular fa-trash-can',
            variant: 'quiet', iconOnly: true, className: 'discussion-delete' });
        remove.addEventListener('click', () => {
            if (!isCurrentView() || !canReadDiscussion()) return;
            if (article.querySelector('.discussion-delete-confirm')) return;
            const confirmation = node('div', 'discussion-delete-confirm');
            confirmation.setAttribute('role', 'group'); confirmation.setAttribute('aria-label', 'Confirm deletion');
            confirmation.append(node('p', '', 'Delete this message? Other people\'s replies will stay.'));
            const cancel = node('button', '', 'Cancel'), confirm = node('button', '', 'Delete');
            cancel.type = confirm.type = 'button';
            cancel.addEventListener('click', () => { confirmation.remove(); remove.focus(); });
            confirm.addEventListener('click', async () => {
                if (!isCurrentView() || !canReadDiscussion()) return;
                confirm.disabled = cancel.disabled = true;
                try {
                    await pageAccountWriteScope.write(postJSON, '/api/delete_discussion_post', { postID: post.ID });
                    window.dispatchEvent(new CustomEvent('benchpoll:discussion-posted'));
                    if (isCurrentView()) await load();
                } catch (error) { if (isCurrentView() && canReadDiscussion()) showError(error); }
                finally { confirm.disabled = cancel.disabled = false; }
            });
            confirmation.append(cancel, confirm); article.append(confirmation); cancel.focus();
        });
        actions.append(remove);
    }
    article.append(meta, node('p', 'discussion-post-body', post.isDeleted ? 'This message was deleted by its author.' : post.text), mentions, actions);
    return article;
}
function renderDiscussionScope() {
    const toggle = $('discussion-scope-toggle');
    toggle.hidden = !state.benchmarkID || Boolean(state.threadID) || informationOnly;
    toggle.setAttribute('aria-pressed', String(state.allCategories));
    toggle.dataset.tooltip = state.allCategories ? 'Show this benchmark in this topic' : 'Show this benchmark across all topics';
    $('discussion-scope-label').textContent = state.allCategories ? 'All topics' : 'This topic';
    $('benchmark-discussion-heading').textContent = state.allCategories
        ? 'Discussion about this benchmark across all topics' : 'Discussion about this benchmark in this topic';
}
function renderContext(data, requestedContextValues) {
    discussionScenes = orderedScenes(data.context.scenes ?? []);
    state.categoryID = Number(data.context.categoryID);
    if (JSON.stringify(state.contextValues) === JSON.stringify(requestedContextValues)) {
        state.contextValues = { ...(data.root?.contextValues ?? data.context.contextValues) };
    }
    $('category-path').textContent = data.context.categoryName ?? data.context.lineage?.at(-1)?.name ?? (data.context.categoryPath ?? '').replaceAll('/', ' / ');
    $('posting-context').replaceChildren();
    $('posting-context').hidden = !state.contextValues.scene;
    if (data.root) {
        state.threadID = data.root.ID;
        $('posting-context').textContent = contextLabel(data.root.contextValues);
    } else $('posting-context').textContent = contextLabel(state.contextValues);
    panel.dataset.view = state.threadID ? 'thread' : 'feed';
    const filter = $('discussion-context');
    const focusedScene = filter.contains(document.activeElement) ? document.activeElement.dataset.sceneId : null;
    const scrollLeft = filter.scrollLeft;
    const oldTabs = new Map([...filter.children].map(button => [button.dataset.sceneId, button]));
    if (sceneTabScope !== state.categoryID) { delete filter.dataset.uiReady; delete filter.dataset.sceneAnimated; }
    sceneTabScope = state.categoryID;
    const tabs = discussionScenes.map(scene => {
        let button = oldTabs.get(String(scene.ID));
        if (!button) {
            button = node('button', 'bp-scene-tab'); button.type = 'button';
            button.append(node('span', '', scene.name));
            button.addEventListener('click', () => {
                if (state.allScenes || String(scene.ID) === state.contextValues.scene) return;
                saveDraft(); viewSequence++; state.contextID = null; state.contextValues = { scene: String(scene.ID) };
                filter.dataset.sceneAnimated = 'true';
                for (const tab of filter.children) tab.setAttribute('aria-selected', String(tab === button));
                refreshSceneTabs(true);
                restoreDraft(); setComposerExpanded(Boolean(text.value || state.mentions.length)); void load();
            });
        }
        button.firstChild.textContent = scene.name;
        button.dataset.sceneId = String(scene.ID); button.setAttribute('role', 'tab');
        button.setAttribute('aria-controls', 'discussion-feed');
        button.setAttribute('aria-selected', String(Number(state.contextValues.scene) === Number(scene.ID)));
        button.tabIndex = String(scene.ID) === (focusedScene ?? state.contextValues.scene) ? 0 : -1;
        return button;
    });
    for (const button of oldTabs.values()) if (!tabs.includes(button)) button.remove();
    tabs.forEach((button, index) => { if (filter.children[index] !== button) filter.insertBefore(button, filter.children[index] ?? null); });
    filter.scrollLeft = scrollLeft;
    if (focusedScene) filter.querySelector(`[data-scene-id="${focusedScene}"]`)?.focus({ preventScroll: true });
    $('context-filter-label').hidden = Boolean(state.threadID || state.allCategories || !discussionScenes.length);
    renderSceneScope(); refreshSceneTabs(true);
    document.querySelector('.discussion-sort').hidden = Boolean(state.threadID);
    renderDiscussionScope();
    $('all-threads').hidden = !state.threadID;
    $('all-threads').href = discussionURL();
    $('composer-title').textContent = state.threadID ? 'Write a reply' : 'Write a message';
    $('post-discussion').textContent = state.authenticated ? (state.threadID ? 'Post reply' : 'Post message') : 'Sign in to participate';
}
function canReadDiscussion() {
    return isOpen && !informationOnly && !showingScores;
}
function syncDiscussionAutoLoad() {
    autoLoader.setActive(canReadDiscussion() && !loading && hasMore && retryAppend === null);
}
function stopDiscussionRead() {
    loadSequence++;
    readController?.abort();
    readController = null;
    loading = false;
    autoLoader.setActive(false);
    $('discussion-feed').setAttribute('aria-busy', 'false');
    $('discussion-more').disabled = false;
    $('discussion-more').textContent = retryAppend !== null ? 'Retry' : 'Load more';
}
async function load(append = false) {
    if (!canReadDiscussion()) { if (!append) feedLoaded = false; return; }
    if (append && (loading || !hasMore)) return;
    const sequence = ++loadSequence;
    readController?.abort();
    const controller = new globalThis.AbortController();
    readController = controller;
    const requestedContextValues = structuredClone(state.contextValues);
    if (!append) {
        hasMore = false; feedLoaded = false; state.offset = 0;
        $('thread-root').replaceChildren();
        $('discussion-feed').replaceChildren();
    }
    retryAppend = null;
    loading = true;
    syncDiscussionAutoLoad();
    $('discussion-feed').setAttribute('aria-busy', 'true');
    $('discussion-more').disabled = true;
    $('discussion-more').hidden = false;
    setLoading($('discussion-more'), state.threadID ? 'Loading replies' : 'Loading discussions');
    $('discussion-error').hidden = true;
    try {
        const data = await postJSON('/api/get_discussion', { categoryID: state.categoryID, contextValues: state.contextValues,
            threadID: state.threadID, benchmarkID: state.benchmarkID, conditionID: state.conditionID, contextID: state.contextID, sort: state.sort,
            allCategories: state.allCategories, allScenes: state.allScenes, offset: append ? state.offset : 0 }, { timeoutMs: 60000, signal: controller.signal });
        if (sequence !== loadSequence || !canReadDiscussion()) return;
        pageAccountWriteScope.bind(data.authenticated ? data.userID : null);
        state.authenticated = data.authenticated;
        if (!append) {
            const previousDraftKey = draftKey();
            renderContext(data, requestedContextValues);
            if (previousDraftKey !== draftKey() && !text.value && !state.mentions.length) {
                restoreDraft();
                if (text.value || state.mentions.length) setComposerExpanded(true);
            }
        }
        const feed = $('discussion-feed');
        if (!append) { feed.replaceChildren(); state.offset = 0; animateContent(feed); }
        if (!append) $('thread-root').replaceChildren(...(data.root ? [renderPost(data.root, true)] : []));
        let added = 0;
        data.posts.forEach(post => { if (!$(`post-${post.ID}`)) { feed.append(renderPost(post)); added++; } });
        state.offset += data.posts.length;
        feedLoaded = true;
        hasMore = Boolean(data.hasMore && data.posts.length && added);
        if (!data.total && !feed.children.length) feed.append(node('p', 'discussion-empty', state.threadID ? 'No replies yet. Add your perspective.' : 'No discussions yet. Start with a benchmark you trust, or one you question.'));
        $('discussion-more').hidden = !hasMore;
        $('discussion-more').textContent = 'Load more';
        return sequence;
    } catch (error) {
        if (sequence === loadSequence && canReadDiscussion()) {
            showError(error);
            retryAppend = append;
            $('discussion-more').hidden = false;
            $('discussion-more').textContent = 'Retry';
            if (error.status === 404) {
                $('thread-root').replaceChildren(); $('discussion-feed').replaceChildren();
                hasMore = false; feedLoaded = false; retryAppend = false;
            }
        }
    }
    finally {
        if (sequence === loadSequence) {
            readController = null;
            loading = false;
            $('discussion-more').disabled = false;
            $('discussion-feed').setAttribute('aria-busy', 'false');
            syncDiscussionAutoLoad();
        }
    }
}
function renderMentions() {
    $('composer-mentions').replaceChildren();
    state.mentions.forEach((mention, index) => {
        const button = node('button', '', `@${mention.label} ×`);
        button.type = 'button'; button.setAttribute('aria-label', `Remove reference to ${mention.label}`);
        button.addEventListener('click', () => { state.mentions.splice(index, 1); renderMentions(); });
        $('composer-mentions').append(button);
    });
}
function closeSuggestions() {
    mentionSequence++; mentionMatches = []; mentionIndex = 0;
    $('mention-suggestions').replaceChildren(); $('mention-suggestions').hidden = true;
    text.removeAttribute('aria-activedescendant');
}
function selectMention(index) {
    const selected = mentionMatches[index];
    if (!selected) return;
    const currentMatch = text.value.slice(0, text.selectionStart).match(/(?:^|\s)@([^@\n]{0,128})$/);
    if (!currentMatch) { closeSuggestions(); return; }
    mentionStart = text.selectionStart - currentMatch[1].length - 1;
    if (state.mentions.length >= 10) { $('composer-status').textContent = 'You can reference up to 10 benchmarks.'; return; }
    const label = selected.name;
    if (!state.mentions.some(item => item.conditionID === Number(selected.conditionID))) state.mentions.push({ benchmarkID: Number(selected.benchmarkID), conditionID: Number(selected.conditionID), label });
    if (mentionStart !== null) text.setRangeText(`@${label} `, mentionStart, text.selectionStart, 'end');
    renderMentions(); closeSuggestions(); text.focus();
}
async function suggest() {
    closeSuggestions();
    const match = text.value.slice(0, text.selectionStart).match(/(?:^|\s)@([^@\n]{0,128})$/);
    if (!match) { closeSuggestions(); return; }
    mentionStart = text.selectionStart - match[1].length - 1;
    const sequence = ++mentionSequence;
    try {
        const data = await postJSON('/api/search_discussion_benchmarks', { query: match[1] });
        if (sequence !== mentionSequence) return;
        mentionMatches = data.benchmarks; mentionIndex = 0;
        const panel = $('mention-suggestions'); panel.replaceChildren(); panel.hidden = false;
        if (!mentionMatches.length) panel.append(node('p', '', 'No matching benchmarks.'));
        mentionMatches.forEach((item, index) => {
            const button = node('button', '', item.name);
            button.type = 'button'; button.id = `mention-option-${index}`; button.setAttribute('role', 'option');
            button.setAttribute('aria-selected', String(index === 0));
            button.addEventListener('mousedown', event => event.preventDefault());
            button.addEventListener('click', () => selectMention(index)); panel.append(button);
        });
    } catch (error) { if (sequence === mentionSequence) showError(error); }
}
text.addEventListener('input', () => {
    const draft = drafts.get(draftKey());
    if (draft) delete draft.error;
    $('composer-status').textContent = '';
    void suggest();
});
text.addEventListener('keydown', event => {
    if ($('mention-suggestions').hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); closeSuggestions(); return; }
    if ((event.key === 'Tab' || event.key === 'Enter') && mentionMatches.length) { event.preventDefault(); selectMention(mentionIndex); }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && mentionMatches.length) {
        event.preventDefault(); mentionIndex = (mentionIndex + (event.key === 'ArrowDown' ? 1 : -1) + mentionMatches.length) % mentionMatches.length;
        [...$('mention-suggestions').children].forEach((element, index) => element.setAttribute('aria-selected', String(index === mentionIndex)));
        text.setAttribute('aria-activedescendant', `mention-option-${mentionIndex}`);
        $(`mention-option-${mentionIndex}`).scrollIntoView({ block: 'nearest' });
    }
});
document.addEventListener('click', event => { if (!event.target.closest('#discussion-text, #mention-suggestions, #mention-button')) closeSuggestions(); });
$('mention-button').addEventListener('click', () => { text.focus(); text.setRangeText(' @', text.selectionStart, text.selectionEnd, 'end'); suggest(); });
$('discussion-composer').addEventListener('submit', async event => {
    event.preventDefault();
    if (!state.authenticated) { loginWithGitHub(); return; }
    const button = $('post-discussion');
    if (button.disabled) return;
    button.disabled = true;
    const submittedDraft = draftKey();
    const submittedSnapshot = draftSnapshot();
    try {
        const mentions = state.mentions.map(({ benchmarkID, conditionID }) => ({ benchmarkID, conditionID }));
        if (!state.threadID && state.conditionID && !mentions.some(mention => mention.conditionID === state.conditionID)) {
            if (!benchmarkInformation) throw new Error('Benchmark information has not loaded');
            mentions.push({ benchmarkID: state.benchmarkID, conditionID: state.conditionID });
        }
        const result = await pageAccountWriteScope.write(postJSON, '/api/create_discussion_post', { categoryID: state.categoryID, contextValues: state.contextValues,
            text: submittedSnapshot.text, parentID: state.threadID, mentions });
        window.dispatchEvent(new CustomEvent('benchpoll:discussion-posted'));
        const currentDraft = isOpen && draftKey() === submittedDraft ? draftSnapshot() : drafts.get(submittedDraft);
        const unchanged = sameDraft(currentDraft, submittedSnapshot);
        if (unchanged) drafts.delete(submittedDraft);
        if (!isOpen || draftKey() !== submittedDraft) return;
        if (unchanged) {
            text.value = ''; state.mentions = []; renderMentions();
            setComposerExpanded(false, !$('discussion-composer').hidden);
        }
        $('composer-status').textContent = unchanged ? 'Posted.' : 'Posted. Your new draft has been kept.';
        state.sort = 'new';
        document.querySelectorAll('[data-sort]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.sort === state.sort)));
        let sequence = await load();
        const canRevealPost = () => sequence === loadSequence && canReadDiscussion() && draftKey() === submittedDraft && !text.value;
        // Replies are oldest-first; advance to the submitted reply without bypassing paging guards.
        while (canRevealPost() && state.threadID && hasMore && !$(`post-${result.ID}`)) sequence = await load(true);
        if (canRevealPost()) {
            $(`post-${result.ID}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    } catch (error) {
        const current = isOpen && draftKey() === submittedDraft;
        drafts.set(submittedDraft, { ...(current ? draftSnapshot() : drafts.get(submittedDraft) ?? submittedSnapshot),
            error: isAccountWriteError(error) ? error.message
                : errors[error.message] || 'Could not post your message. Your draft has been kept.' });
        if (current) showError(error);
    }
    finally { button.disabled = false; }
});
$('post-discussion').addEventListener('click', event => { if (!state.authenticated) { event.preventDefault(); loginWithGitHub(); } });
document.querySelectorAll('[data-sort]').forEach(button => button.addEventListener('click', () => {
    viewSequence++;
    state.sort = button.dataset.sort;
    document.querySelectorAll('[data-sort]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    load();
}));
$('discussion-context').addEventListener('keydown', event => {
    if (state.allScenes) return;
    const tabs = [...event.currentTarget.querySelectorAll('[role="tab"]')], index = tabs.indexOf(event.target);
    if (index < 0) return;
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft'
        ? (index - 1 + tabs.length) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); tabs.forEach((tab, i) => { tab.tabIndex = i === next ? 0 : -1; });
    tabs[next].focus({ preventScroll: true }); tabs[next].scrollIntoView({ block: 'nearest', inline: 'nearest' });
});
$('discussion-all-scenes').addEventListener('click', () => {
    if (state.threadID || !discussionScenes.length) return;
    state.allScenes = !state.allScenes; state.contextID = null; viewSequence++;
    renderSceneScope();
    if (new URL(location.href).searchParams.has('discussion')) {
        const url = new URL(location.href);
        if (state.allScenes) url.searchParams.set('allScenes', '1'); else url.searchParams.delete('allScenes');
        history.replaceState(history.state, '', url);
    }
    void load();
});
$('discussion-scope-toggle').addEventListener('click', () => {
    if (!state.benchmarkID || state.threadID) return;
    viewSequence++;
    state.allCategories = !state.allCategories;
    state.contextID = null;
    renderDiscussionScope();
    $('context-filter-label').hidden = state.allCategories || $('posting-context').hidden;
    load();
});
$('discussion-more').addEventListener('click', () => {
    if (!loading && canReadDiscussion() && (retryAppend !== null || hasMore)) void load(retryAppend ?? true);
});
$('discussion-close').addEventListener('click', closeDiscussion);
$('discussion-compose-toggle').addEventListener('click', () => setComposerExpanded($('discussion-compose-fields').hidden, true));
mobile.addEventListener('change', updatePanelAccess);
window.addEventListener('keydown', event => {
    if (!isOpen || event.defaultPrevented || !panel.contains(document.activeElement)) return;
    if (event.key === 'Escape') { event.preventDefault(); closeDiscussion(); }
    if (event.key === 'Tab' && mobile.matches && !isMobilePage()) {
        const focusable = [...panel.querySelectorAll('a[href], button:not(:disabled), textarea, select, input')].filter(element => element.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
});
window.addEventListener('beforeunload', event => {
    if (isOpen) saveDraft();
    if ([...drafts.values()].some(draft => draft.text.trim() || draft.mentions.length)) { event.preventDefault(); event.returnValue = ''; }
});
async function profile() {
    if (!isOpen) return;
    const sequence = ++profileSequence, view = viewSequence;
    const isCurrentView = () => isOpen && sequence === profileSequence && view === viewSequence;
    try {
        const user = await postJSON('/api/get_user_profile', {});
        if (!isCurrentView()) return;
        pageAccountWriteScope.bind(user?.userID ?? null);
        state.authenticated = Boolean(user);
        $('post-discussion').textContent = user ? (state.threadID ? 'Post reply' : 'Post message') : 'Sign in to participate';
    } catch (error) { if (isCurrentView()) showError(error); }
}
window.addEventListener('focus', profile);
window.addEventListener('storage', profile);
updatePanelAccess();
const initialDiscussionContext = readDiscussionEntryContext();
if (initialDiscussionContext) updateWorkspaceContext({ detail: initialDiscussionContext });
