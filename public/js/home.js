import { createSidebarNavigation } from './navigation/sidebar.js?v=sidebar-navigation-20260922';
import { navigationChannel } from './shared/navigation-channel.js';
import { locationURL } from './navigation/model.js';
import { postJSON as requestJSON } from './shared/http.js';
import { workspaceChannel } from './shared/workspace-channel.js';
import { buildContributionURL as buildContributeURL } from './shared/contribution-navigation.js?v=clean-20260908';
import * as S from '/js/shared.js';
import * as G from '/js/global.js';

const treeContent = document.getElementById('tree-content');
const taxonomyToggle = document.getElementById('taxonomy-toggle');
const taxonomyClose = document.getElementById('taxonomy-close');
const taxonomyScrim = document.getElementById('taxonomy-scrim');
const loginButton = document.getElementById('login-button');
const userProfile = document.getElementById('user-profile');
const userProfilePicture = document.getElementById('user-profile-picture');
const userProfileName = document.getElementById('user-profile-name');
const accountDialogPicture = document.getElementById('account-dialog-picture');
const accountDialogName = document.getElementById('account-dialog-name');
const userAccountDialog = document.getElementById('user-account-dialog');
const logoutButton = document.getElementById('logout-button');
const deleteAccountButton = document.getElementById('delete-account-button');
const logoutDialog = document.getElementById('logout-dialog');
const deleteAccountDialog = document.getElementById('delete-account-dialog');
const loginSuccessDialog = document.getElementById('login-success-dialog');
const logoutSuccessDialog = document.getElementById('logout-success-dialog');
const deleteAccountSuccessDialog = document.getElementById('delete-account-success-dialog');
const logoutThisDeviceButton = logoutDialog.querySelector('.dialog-logout-this-device-button');
const logoutAllDevicesButton = logoutDialog.querySelector('.dialog-logout-all-devices-button');
const deleteAccountConfirmButton = deleteAccountDialog.querySelector('.dialog-delete-account-button');
const revokeGitHubAuthLink = document.getElementById('revoke-github-auth-link');
const contributeButton = document.getElementById('contribute-button');
const contributeDataButton = document.getElementById('contribute-data-button');
const newCategoryButton = document.getElementById('new-category-button');
const categoryIssueButton = document.getElementById('category-issue-button');
const categoryActionsMenu = document.getElementById('category-actions-menu');

let currentCategoryID = null;
let currentCategoryPath = '';
let currentCategoryName = '';
let currentUserProfile = null;
let currentTree = [];
let navigationBusy = false;
let profileSequence = 0;
let lastWorkspaceURL = window.location.href;
const sidebarNavigation = createSidebarNavigation({
    onNavigate(entry) {
        const url = new URL(locationURL(entry), window.location.origin);
        return selectCategory({ ID: entry.categoryID, name: entry.categoryName },
            url.pathname.slice('/rankings/'.length), { contextValues: entry.contextValues, lineage: entry.lineage });
    },
    onLogin: () => loginButton.click(),
    onSessionChange: () => { void loadUserProfile().catch(showNavigationError); }
});
navigationChannel.subscribe(() => { lastWorkspaceURL = window.location.href; });

function displayURLPart(value) {
    return encodeURIComponent(String(value ?? '').trim().replace(/\s+/g, '-'));
}

function appendCategoryPath(path, name) {
    const part = displayURLPart(name);
    return path ? `${path}/${part}` : part;
}

function rankingURL(path = currentCategoryPath) {
    return path ? `/rankings/${path}` : '/';
}

async function postJSON(url, body = {}) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (response.status === 204) return null;
    return G.checkErrorCodeInURL(response);
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
    newCategoryButton.hidden = !authenticated;
    categoryIssueButton.hidden = !authenticated || currentCategoryID === null;
    categoryActionsMenu.hidden = !authenticated;
    if (!authenticated) categoryActionsMenu.open = false;

    contributeButton.href = buildContributeURL('new_benchmark');
    contributeDataButton.href = buildContributeURL('benchmark_result', {
        pageURL: window.location.origin + rankingURL()
    });
    newCategoryButton.href = buildContributeURL('new_category', {
        parentPath: currentCategoryPath || '/',
        parentName: currentCategoryName || 'Root',
        pageURL: window.location.origin + rankingURL()
    });
    categoryIssueButton.href = buildContributeURL('delete_or_migrate_category', {
        targetName: currentCategoryName,
        categoryPath: currentCategoryPath,
        targetCategoryID: currentCategoryID,
        targetKind: 'category',
        pageURL: window.location.origin + rankingURL()
    });
}

function updateTreeSelection() {
    treeContent.querySelectorAll('[data-category-id]').forEach(element => {
        const selected = Number(element.dataset.categoryId) === Number(currentCategoryID);
        element.classList.toggle('selected', selected);
        element.setAttribute('aria-current', selected ? 'page' : 'false');
        const group = element.closest('.tree-group');
        if (group && element.classList.contains('tree-root-item')) {
            group.classList.toggle('selected', selected);
        }
    });
}

function mergeCategoryTree(previous, incoming) {
    const old = new Map(previous.map(category => [Number(category.ID), category]));
    return incoming.map(category => {
        const retained = old.get(Number(category.ID));
        return { ...retained, ...category,
            children: Array.isArray(category.children)
                ? mergeCategoryTree(retained?.children ?? [], category.children) : retained?.children };
    });
}

function showNavigationError() {
    const feedback = document.getElementById('navigation-feedback');
    feedback.textContent = 'Could not open this category or context. Try again.';
    document.getElementById('navigation-retry').hidden = false;
}

async function selectCategory(category, path, { replace = false, contextValues, lineage } = {}) {
    if (navigationBusy) return false;
    navigationBusy = true;
    try {
        if (!await prepareWorkspaceContextChange()) return false;
        if (lineage) {
            // Resolve the real taxonomy path as well, including lazy/unvisited nodes.
            const payload = await requestJSON(`/api/get_page${rankingURL(path)}`, { treeOnly: true });
            if (Number(payload.currentCategoryID) !== Number(category.ID)) throw new Error('Category changed');
            currentTree = mergeCategoryTree(currentTree, payload.categoryTree);
            lineage.slice(0, -1).forEach(parent => sidebarNavigation.rememberExpansion(parent.ID, true));
        }
        currentCategoryID = category?.ID ?? null;
        currentCategoryPath = path || '';
        currentCategoryName = category?.name ?? '';
        const url = new URL(rankingURL(), window.location.origin);
        if (contextValues !== undefined) {
            Object.keys(contextValues).sort().forEach(key => url.searchParams.set(`context_${key}`, contextValues[key]));
        }
        window.history[replace ? 'replaceState' : 'pushState']({}, '', url);
        if (lineage) renderTree();
        else updateTreeSelection();
        updateContributionLinks();
        const pendingWorkspace = publishWorkspaceState({ contextValues });
        setTaxonomyOpen(false);
        await pendingWorkspace;
        return true;
    } catch {
        showNavigationError();
        return false;
    } finally { navigationBusy = false; }
}

async function loadChildren(category) {
    if (Array.isArray(category.children)) return category.children;
    const payload = await postJSON('/api/load_benchmarks_and_subcategories', {
        targetCategory: { ID: Number(category.ID) },
        doNotGetChildren: false,
        treeOnly: true
    });
    category.children = payload?.subcategories ?? [];
    return category.children;
}

function makeCategoryRow(category, path) {
    const hasChildren = Boolean(category.hasChildren);
    category.expanded = sidebarNavigation.expansionFor(category.ID, Boolean(category.expanded));
    const group = document.createElement('div');
    group.className = 'tree-group';
    if (category.expanded) group.classList.add('expanded');

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'tree-root-item';
    row.dataset.categoryId = String(category.ID);
    row.dataset.path = path;

    const expander = document.createElement('span');
    expander.className = 'icon-folder';
    expander.setAttribute('role', 'button');
    expander.setAttribute('tabindex', '0');
    expander.setAttribute('aria-label', `Toggle ${category.name}`);
    expander.setAttribute('aria-expanded', String(Boolean(category.expanded)));
    const label = document.createElement('span');
    label.textContent = category.name;
    row.append(expander, label);

    const children = document.createElement('div');
    children.className = 'tree-children';
    children.hidden = !category.expanded;
    group.append(row, children);

    const renderChildren = entries => {
        children.replaceChildren(...entries.map(child => makeCategoryNode(child, appendCategoryPath(path, child.name))));
    };
    if (Array.isArray(category.children)) renderChildren(category.children);
    else if (category.expanded && hasChildren) {
        // Restore expanded lazy branches after a full document reload as well.
        void loadChildren(category).then(entries => {
            if (!group.isConnected) return;
            renderChildren(entries);
            updateTreeSelection();
            sidebarNavigation.updateTreeMarkers();
            sidebarNavigation.restoreScroll();
        }).catch(showNavigationError);
    }

    const toggle = async event => {
        event.preventDefault();
        event.stopPropagation();
        const expanding = !group.classList.contains('expanded');
        if (expanding) renderChildren(await loadChildren(category));
        group.classList.toggle('expanded', expanding);
        children.hidden = !expanding;
        expander.setAttribute('aria-expanded', String(expanding));
        category.expanded = expanding;
        sidebarNavigation.rememberExpansion(category.ID, expanding);
        sidebarNavigation.updateTreeMarkers();
    };
    expander.addEventListener('click', toggle);
    expander.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') void toggle(event);
    });
    row.addEventListener('click', event => {
        if (event.target === expander) return;
        void selectCategory(category, path);
    });

    if (!hasChildren) expander.hidden = true;
    return group;
}

function makeCategoryNode(category, path) {
    if (category.hasChildren) return makeCategoryRow(category, path);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'tree-leaf';
    row.dataset.categoryId = String(category.ID);
    row.dataset.path = path;
    const label = document.createElement('span');
    label.textContent = category.name;
    row.append(label);
    row.addEventListener('click', () => void selectCategory(category, path));
    return row;
}

function renderTree() {
    treeContent.replaceChildren(...currentTree.map(category => (
        makeCategoryNode(category, appendCategoryPath('', category.name))
    )));
    updateTreeSelection();
    sidebarNavigation.updateTreeMarkers();
    sidebarNavigation.restoreScroll();
}

function findCategoryByID(entries, targetID) {
    for (const category of entries) {
        if (Number(category.ID) === Number(targetID)) return category;
        const nested = Array.isArray(category.children)
            ? findCategoryByID(category.children, targetID)
            : null;
        if (nested) return nested;
    }
    return null;
}

function setTaxonomyOpen(open) {
    document.body.classList.toggle('taxonomy-open', open);
    taxonomyToggle.setAttribute('aria-expanded', String(open));
}

function showUserProfile(profile) {
    if (currentUserProfile && currentUserProfile.userID !== profile.userID) {
        // Never keep an old account's editable workspace under a new session.
        sidebarNavigation.setAccount(null);
        window.location.reload();
        return;
    }
    currentUserProfile = profile;
    sidebarNavigation.setAccount(profile.userID);
    const picture = String(profile?.userProfilePictureURL ?? '');
    userProfilePicture.style.backgroundImage = picture ? `url("${picture.replaceAll('"', '%22')}")` : '';
    accountDialogPicture.style.backgroundImage = picture ? `url("${picture.replaceAll('"', '%22')}")` : '';
    userProfileName.textContent = profile.userName;
    accountDialogName.textContent = profile.userName;
    userProfile.hidden = false;
    loginButton.hidden = true;
    updateContributionLinks();
}

function clearUserProfile() {
    currentUserProfile = null;
    sidebarNavigation.setAccount(null);
    userProfile.hidden = true;
    loginButton.hidden = false;
    userProfileName.textContent = '';
    userProfilePicture.style.backgroundImage = '';
    accountDialogName.textContent = '';
    accountDialogPicture.style.backgroundImage = '';
    updateContributionLinks();
}

async function loadUserProfile() {
    const sequence = ++profileSequence;
    const response = await fetch('/api/get_user_profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    });
    if (sequence !== profileSequence) return;
    if (response.status === 204) {
        clearUserProfile();
        return;
    }
    const profile = await G.checkErrorCodeInURL(response);
    if (sequence === profileSequence) showUserProfile(profile);
}

async function runAccountAction(url, dialog, successDialog) {
    const actions = dialog.querySelector('[slot="actions"]');
    actions.hidden = true;
    try {
        await postJSON(url);
        ++profileSequence;
        clearUserProfile();
        dialog.hidden = true;
        successDialog.hidden = false;
    } catch (error) {
        actions.hidden = false;
        throw error;
    }
}

async function initializeTree({ fromURL = false } = {}) {
    const payload = await requestJSON(`/api/get_page${window.location.pathname}`, { treeOnly: true });
    if (payload?.jump) {
        window.location.replace('/');
        return;
    }
    currentTree = mergeCategoryTree(currentTree, payload?.categoryTree ?? []);
    currentCategoryID = payload?.currentCategoryID ?? null;
    const selected = findCategoryByID(currentTree, currentCategoryID)
        ?? (currentCategoryID === null && currentTree.length === 1 ? currentTree[0] : null);
    currentCategoryID = selected?.ID ?? null;
    currentCategoryName = selected?.name ?? '';
    currentCategoryPath = window.location.pathname.startsWith('/rankings/')
        ? window.location.pathname.slice('/rankings/'.length).replace(/^\/+|\/+$/g, '')
        : selected ? appendCategoryPath('', selected.name) : '';
    renderTree();
    updateContributionLinks();
    await publishWorkspaceState({ fromURL });
}

// Back/forward changes the location, never the selected sidebar or pie mode.
window.addEventListener('popstate', async () => {
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
        await initializeTree({ fromURL: true });
    } catch { showNavigationError(); }
    finally { navigationBusy = false; }
});
window.addEventListener('focus', () => { void loadUserProfile().catch(showNavigationError); });

taxonomyToggle.addEventListener('click', () => setTaxonomyOpen(!document.body.classList.contains('taxonomy-open')));
taxonomyClose.addEventListener('click', () => setTaxonomyOpen(false));
taxonomyScrim.addEventListener('click', () => setTaxonomyOpen(false));
window.addEventListener('keydown', event => {
    if (event.key === 'Escape') setTaxonomyOpen(false);
});

loginButton.addEventListener('click', G.loginWithGitHub);
userProfile.addEventListener('click', () => {
    if (currentUserProfile) userAccountDialog.hidden = false;
});
logoutButton.addEventListener('click', async () => {
    userAccountDialog.hidden = true;
    logoutDialog.hidden = false;
    const actions = logoutDialog.querySelector('[slot="actions"]');
    actions.hidden = true;
    try {
        const payload = await postJSON('/api/get_device_count');
        const count = Number(payload.deviceCount);
        logoutThisDeviceButton.textContent = count > 1 ? 'Log out on this device only' : 'Log out';
        logoutAllDevicesButton.textContent = `Log out on all ${count} devices`;
        logoutAllDevicesButton.hidden = count <= 1;
        actions.hidden = false;
    } catch (error) {
        logoutDialog.hidden = true;
        throw error;
    }
});
deleteAccountButton.addEventListener('click', () => {
    userAccountDialog.hidden = true;
    deleteAccountDialog.hidden = false;
});
logoutThisDeviceButton.addEventListener('click', () => runAccountAction('/api/logout', logoutDialog, logoutSuccessDialog));
logoutAllDevicesButton.addEventListener('click', () => runAccountAction('/api/logout?all', logoutDialog, logoutSuccessDialog));
deleteAccountConfirmButton.addEventListener('click', () => runAccountAction('/api/delete_account', deleteAccountDialog, deleteAccountSuccessDialog));

document.querySelectorAll('.dialog-close-button').forEach(button => {
    button.addEventListener('click', () => {
        const dialog = button.closest('global-dialog');
        if (dialog) dialog.hidden = true;
    });
});
[loginSuccessDialog, logoutSuccessDialog, deleteAccountSuccessDialog].forEach(dialog => {
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
    await loadUserProfile();
    loginSuccessDialog.hidden = false;
});

await Promise.all([initializeTree(), loadUserProfile()]);
