import { createSidebarNavigation } from './navigation/sidebar.js?v=comparison-experiment-20261007';
import { navigationChannel } from './shared/navigation-channel.js';
import { locationURL } from './navigation/model.js';
import { postJSON as requestJSON } from './shared/http.js';
import { workspaceChannel } from './shared/workspace-channel.js';
import { createOverlayScrollbar } from './workspace/overlay-scrollbar.js';
import { buildContributionURL as buildContributeURL } from './shared/contribution-navigation.js?v=taxonomy-20260929';
import { createTaxonomyDrawer } from './shared/taxonomy-drawer.js?v=20260928';
import { topicURL, topicSlug, scenePath } from './shared/topics.js';
import { createConfigSidebar } from './shared/config-sidebar.js';
import { openPrivateTopicEditor } from './shared/private-topic-editor.js';
import { pageAccountWriteScope, isAccountWriteError } from './shared/account-identity.js';
import { createToast } from './shared/toast.js';
import * as S from '/js/shared.js';
import * as G from '/js/global.js';

const treeContent = document.getElementById('tree-content');
const taxonomyToggle = document.getElementById('taxonomy-toggle');
const taxonomyClose = document.getElementById('taxonomy-close');
const taxonomyScrim = document.getElementById('taxonomy-scrim');
const setTaxonomyOpen = createTaxonomyDrawer(taxonomyToggle, document.querySelector('.bp-sidebar'));
const loginButton = document.getElementById('login-button');
const userProfile = document.getElementById('user-profile');
const userProfilePicture = document.getElementById('user-profile-picture');
const userProfileName = document.getElementById('user-profile-name');
const headerUserProfile = document.getElementById('header-user-profile');
const headerLoginButton = document.getElementById('header-login-button');
const logoutSuccessDialog = document.getElementById('logout-success-dialog');
const deleteAccountSuccessDialog = document.getElementById('delete-account-success-dialog');
const revokeGitHubAuthLink = document.getElementById('revoke-github-auth-link');
const contributeButton = document.getElementById('contribute-button');
const contributeDataButton = document.getElementById('contribute-data-button');

let currentCategoryID = null;
let currentCategoryPath = '';
let currentCategoryName = '';
let currentUserProfile = null;
let navigationBusy = false;
let profileSequence = 0;
let lastWorkspaceURL = window.location.href;
let signInToast;
createOverlayScrollbar(document.getElementById('pie-home-slot'));
createConfigSidebar();
const sidebarNavigation = createSidebarNavigation({
    onNavigate(entry) {
        return selectTopic(entry);
    },
    onLogin: () => loginButton.click(),
    onCreatePrivate: trigger => openPrivateTopicEditor(null, trigger),
    onSessionChange: () => { void loadUserProfile().catch(showNavigationError); }
});
navigationChannel.subscribe(() => { lastWorkspaceURL = window.location.href; });

function rankingURL(path = currentCategoryPath) {
    return path ? `/${path}` : '/';
}

async function prepareWorkspaceContextChange() {
    try {
        return await workspaceChannel.prepareChange();
    } catch (error) {
        console.error('[BenchPoll] Could not save the current personal weights.', error);
        return false;
    }
}

function publishWorkspaceState(options = {}) {
    const detail = {
        categoryPath: currentCategoryPath,
        categoryName: currentCategoryName,
        currentCategoryID,
        ...options
    };
    return workspaceChannel.publish(detail);
}

function updateContributionLinks() {
    const authenticated = currentUserProfile !== null;
    contributeButton.hidden = !authenticated;
    contributeDataButton.hidden = !authenticated;
    contributeButton.href = buildContributeURL('new_benchmark');
    contributeDataButton.href = buildContributeURL('benchmark_result', {
        pageURL: window.location.origin + rankingURL()
    });
}

function showNavigationError(error) {
    const feedback = document.getElementById('navigation-feedback');
    feedback.textContent = isAccountWriteError(error) ? error.message : 'Could not open this topic. Please try again.';
    treeContent.setAttribute('aria-busy', 'false');
}

function normalizeTopic(topic) {
    const categoryID = Number(topic.categoryID ?? topic.ID);
    const categoryName = String(topic.categoryName ?? topic.name ?? '');
    if (!Number.isSafeInteger(categoryID) || categoryID < 1 || !categoryName) throw new TypeError('Invalid topic');
    return { ...topic, categoryID, categoryName, isPrivate: topic.isPrivate === true,
        lineage: [{ ID: categoryID, name: categoryName }], contextValues: topic.contextValues ?? {},
        dimensions: topic.dimensions ?? [] };
}

function setCurrentTopic(topic) {
    currentCategoryID = topic.categoryID;
    currentCategoryName = topic.categoryName;
    currentCategoryPath = (topic.url || topicURL(topic.categoryID, topic.categoryName, topic.isPrivate, topic.slug)).slice(1);
    sidebarNavigation.setCurrentTopic(topic);
    updateContributionLinks();
}

async function selectTopic(entry) {
    if (navigationBusy) return false;
    navigationBusy = true;
    treeContent.setAttribute('aria-busy', 'true');
    try {
        if (!await prepareWorkspaceContextChange()) return false;
        const metadata = await requestJSON('/api/get_topic', { categoryID: entry.categoryID });
        const topic = normalizeTopic({ ...metadata, isPrivate: entry.isPrivate === true });
        if (topic.categoryID !== Number(entry.categoryID)) throw new Error('Topic identity changed');
        const defaultScene = topic.scenes?.find(scene => scene.isDefault);
        const contextValues = entry.contextValues?.scene ? entry.contextValues : defaultScene ? { scene: String(defaultScene.ID) } : {};
        setCurrentTopic({ ...topic, contextValues });
        const url = new URL(locationURL({ ...topic, contextValues }), window.location.origin);
        window.history.pushState({}, '', url);
        const pendingWorkspace = publishWorkspaceState({ contextValues, isPrivate: topic.isPrivate });
        setTaxonomyOpen(false);
        await pendingWorkspace;
        return true;
    } catch (error) {
        showNavigationError(error);
        return false;
    } finally { navigationBusy = false; treeContent.setAttribute('aria-busy', 'false'); }
}

function showUserProfile(profile, { refreshNavigation = true } = {}) {
    try { pageAccountWriteScope.bind(profile.userID); }
    catch (error) {
        sidebarNavigation.setAccount(null);
        throw error;
    }
    currentUserProfile = profile;
    if (refreshNavigation) sidebarNavigation.setAccount(profile.userID);
    const picture = String(profile?.userProfilePictureURL ?? '');
    userProfilePicture.style.backgroundImage = picture ? `url("${picture.replaceAll('"', '%22')}")` : '';
    userProfileName.textContent = profile.userName;
    headerUserProfile.dataset.tooltip = profile.userName;
    headerUserProfile.setAttribute('aria-label', `Your account: ${profile.userName}`);
    headerUserProfile.querySelector('[data-account-picture]').style.backgroundImage = userProfilePicture.style.backgroundImage;
    headerUserProfile.querySelector('[data-account-picture]').dataset.hasPicture = String(Boolean(picture));
    userProfile.hidden = false;
    headerUserProfile.hidden = false;
    loginButton.hidden = true;
    headerLoginButton.hidden = true;
    updateContributionLinks();
}

function clearUserProfile() {
    if (currentUserProfile) pageAccountWriteScope.invalidate();
    currentUserProfile = null;
    sidebarNavigation.setAccount(null);
    userProfile.hidden = true;
    headerUserProfile.hidden = true;
    loginButton.hidden = false;
    headerLoginButton.hidden = false;
    headerUserProfile.dataset.tooltip = '';
    headerUserProfile.querySelector('[data-account-picture]').style.backgroundImage = '';
    headerUserProfile.querySelector('[data-account-picture]').dataset.hasPicture = 'false';
    userProfileName.textContent = '';
    userProfilePicture.style.backgroundImage = '';
    updateContributionLinks();
}

async function loadUserProfile() {
    const sequence = ++profileSequence;
    const response = await (globalThis.__benchpollInitialReads?.take('/api/get_user_profile') ?? fetch('/api/get_user_profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }));
    if (sequence !== profileSequence) return;
    if (response.status === 204) {
        clearUserProfile();
        return;
    }
    const profile = await G.checkErrorCodeInURL(response);
    if (sequence === profileSequence) showUserProfile(profile);
}

let accountCenterOpening = false;
async function openCurrentAccount(event) {
    if (!currentUserProfile || accountCenterOpening) return;
    event?.currentTarget?.focus({ preventScroll: true });
    const owner = String(currentUserProfile.userID);
    accountCenterOpening = true;
    try {
        const { openAccountCenter } = await import('./shared/account-center.js');
        if (!currentUserProfile || String(currentUserProfile.userID) !== owner) return;
        if (pageAccountWriteScope.capture() !== owner) return;
        const outcome = await openAccountCenter({ profile: { ...currentUserProfile },
            onProfileSaved: profile => updateEffectiveProfile(profile, owner),
            onSignedOut: () => {
                if (currentUserProfile && String(currentUserProfile.userID) === owner) {
                    ++profileSequence;
                    clearUserProfile();
                }
            }
        });
        if (outcome?.action) window.location.reload();
    } catch (error) { showNavigationError(error); }
    finally { accountCenterOpening = false; }
}

async function initializeTopic({ fromURL = false } = {}) {
    const privateMatch = window.location.pathname.match(/^\/personal\/([1-9]\d*)(?:\/([a-z0-9]+(?:-[a-z0-9]+)*))?\/?$/);
    const shortMatch = window.location.pathname.match(/^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/([a-z0-9]+(?:-[a-z0-9]+)*))?\/?$/);
    const publicMatch = window.location.pathname.match(/^\/topics\/([1-9]\d*)(?:\/[^/]+)?\/?$/);
    let topic;
    if (privateMatch) {
        topic = normalizeTopic({ ...await requestJSON('/api/get_topic', { categoryID: Number(privateMatch[1]) }), isPrivate: true });
    } else if (publicMatch) {
        topic = normalizeTopic(await requestJSON('/api/get_topic', { categoryID: Number(publicMatch[1]) }));
        if (topic.categoryID !== Number(publicMatch[1])) throw new Error('Topic identity changed');
    } else if (shortMatch) {
        topic = normalizeTopic(await requestJSON('/api/get_topic', { slug: shortMatch[1] }));
    } else {
        const payload = await requestJSON(`/api/get_page${window.location.pathname}`, { treeOnly: true });
        if (payload?.jump) { window.location.replace('/'); return; }
        const selected = payload?.categoryTree?.find(entry => Number(entry.ID) === Number(payload.currentCategoryID));
        if (!selected) throw new Error('Current topic is missing');
        topic = normalizeTopic(selected);
    }
    const url = new URL(window.location.href);
    if (url.searchParams.has('scene') || url.searchParams.has('context_scene')) throw new Error('Scenes use named URL paths.');
    const requestedScene = privateMatch ? privateMatch[2] : publicMatch ? null : shortMatch?.[2];
    const scene = requestedScene ? topic.scenes?.find(item => (item.slug || topicSlug(item.name)) === requestedScene)
        : topic.scenes?.find(item => item.isDefault);
    if (requestedScene && !scene) throw new Error('This scene is unavailable.');
    const contextValues = scene ? { scene: String(scene.ID) } : {};
    setCurrentTopic({ ...topic, contextValues });
    const base = topic.url || topicURL(topic.categoryID, topic.categoryName, topic.isPrivate, topic.slug);
    url.pathname = scene ? new URL(scenePath(base, scene), window.location.origin).pathname : base;
    url.searchParams.delete('view');
    window.history.replaceState(window.history.state, '', url);
    await publishWorkspaceState({ fromURL, contextValues, isPrivate: topic.isPrivate });
}

// Back/forward changes the location, never the selected sidebar or pie mode.
G.setHistoryNavigationHandler(async () => {
    const target = window.location.href;
    const contextAddress = input => {
        const url = new URL(input);
        ['discussion', 'categoryID', 'benchmarkID', 'threadID'].forEach(key => url.searchParams.delete(key));
        return url.pathname + url.search;
    };
    if (contextAddress(target) === contextAddress(lastWorkspaceURL)) return;
    if (navigationBusy) { history.replaceState(history.state, '', lastWorkspaceURL); return; }
    navigationBusy = true;
    const previous = lastWorkspaceURL;
    // A queued save still belongs to the old location; don't let its URL sync
    // overwrite the destination chosen by the browser's history controls.
    history.replaceState(history.state, '', previous);
    try {
        if (!await prepareWorkspaceContextChange()) return;
        history.replaceState(history.state, '', target);
        await initializeTopic({ fromURL: true });
    } catch { showNavigationError(); }
    finally { navigationBusy = false; }
});
window.addEventListener('focus', () => { void loadUserProfile().catch(showNavigationError); });

taxonomyToggle.addEventListener('click', () => setTaxonomyOpen(!document.body.classList.contains('taxonomy-open')));
document.getElementById('bp-breadcrumb').addEventListener('click', event => {
    if (event.target.closest('[data-taxonomy-trigger]') && window.matchMedia('(max-width: 760px)').matches) {
        setTaxonomyOpen(true);
    }
});
window.matchMedia('(max-width: 760px)').addEventListener('change', event => {
    if (!event.matches) setTaxonomyOpen(false);
});
taxonomyClose.addEventListener('click', () => setTaxonomyOpen(false));
taxonomyScrim.addEventListener('click', () => setTaxonomyOpen(false));
window.addEventListener('keydown', event => {
    if (event.key === 'Escape') setTaxonomyOpen(false);
});

loginButton.addEventListener('click', G.loginWithGitHub);
headerLoginButton.addEventListener('click', G.loginWithGitHub);
userProfile.addEventListener('click', openCurrentAccount);
headerUserProfile.addEventListener('click', openCurrentAccount);
function updateEffectiveProfile(profile, owner) {
    if (!profile || !currentUserProfile || String(currentUserProfile.userID) !== owner
        || profile.userID != null && String(profile.userID) !== owner) return;
    try { if (pageAccountWriteScope.capture() !== owner) return; } catch { return; }
    ++profileSequence;
    showUserProfile({ ...currentUserProfile, ...profile, userID: owner }, { refreshNavigation: false });
}
document.addEventListener('benchpoll:profile-updated', event => {
    const profile = event.detail?.profile ?? event.detail;
    if (profile?.userID != null) updateEffectiveProfile(profile, String(profile.userID));
});

document.querySelectorAll('.dialog-close-button').forEach(button => {
    button.addEventListener('click', () => {
        const dialog = button.closest('global-dialog');
        if (dialog) dialog.hidden = true;
    });
});
[logoutSuccessDialog, deleteAccountSuccessDialog].forEach(dialog => {
    dialog.querySelector('.dialog-close-button').addEventListener('click', () => window.location.reload());
});

revokeGitHubAuthLink.href = `https://github.com/settings/connections/applications/${S.CLIENT_ID}`;
revokeGitHubAuthLink.textContent = revokeGitHubAuthLink.href;

G.listenStorageChange('user-profile-update', async profileSignal => {
    ++profileSequence;
    sidebarNavigation.setAccount(null);
    if (profileSignal === null) {
        clearUserProfile();
        logoutSuccessDialog.hidden = false;
        return;
    }
    try {
        await loadUserProfile();
        await publishWorkspaceState({ accountRefresh: true });
        (signInToast ??= createToast()).show('Signed in');
    } catch (error) { showNavigationError(error); }
});

await Promise.all([initializeTopic().catch(showNavigationError), loadUserProfile().catch(showNavigationError)]);
