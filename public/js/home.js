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

function publishWorkspaceState() {
    const detail = {
        categoryPath: currentCategoryPath,
        categoryName: currentCategoryName,
        currentCategoryID
    };
    workspaceChannel.publish(detail);
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

async function selectCategory(category, path, { replace = false } = {}) {
    if (!await prepareWorkspaceContextChange()) return;
    currentCategoryID = category?.ID ?? null;
    currentCategoryPath = path || '';
    currentCategoryName = category?.name ?? '';
    window.history[replace ? 'replaceState' : 'pushState']({}, '', rankingURL());
    updateTreeSelection();
    updateContributionLinks();
    publishWorkspaceState();
    setTaxonomyOpen(false);
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

    const toggle = async event => {
        event.preventDefault();
        event.stopPropagation();
        const expanding = !group.classList.contains('expanded');
        if (expanding) renderChildren(await loadChildren(category));
        group.classList.toggle('expanded', expanding);
        children.hidden = !expanding;
        expander.setAttribute('aria-expanded', String(expanding));
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
    currentUserProfile = profile;
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
    userProfile.hidden = true;
    loginButton.hidden = false;
    userProfileName.textContent = '';
    userProfilePicture.style.backgroundImage = '';
    accountDialogName.textContent = '';
    accountDialogPicture.style.backgroundImage = '';
    updateContributionLinks();
}

async function loadUserProfile() {
    const response = await fetch('/api/get_user_profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    });
    if (response.status === 204) {
        clearUserProfile();
        return;
    }
    showUserProfile(await G.checkErrorCodeInURL(response));
}

async function runAccountAction(url, dialog, successDialog) {
    const actions = dialog.querySelector('[slot="actions"]');
    actions.hidden = true;
    try {
        await postJSON(url);
        dialog.hidden = true;
        successDialog.hidden = false;
    } catch (error) {
        actions.hidden = false;
        throw error;
    }
}

async function initializeTree() {
    const payload = await postJSON(`/api/get_page${window.location.pathname}`, { treeOnly: true });
    if (payload?.jump) {
        window.location.replace('/');
        return;
    }
    currentTree = payload?.categoryTree ?? [];
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
    publishWorkspaceState();
}

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
    if (profileSignal === null) {
        clearUserProfile();
        logoutSuccessDialog.hidden = false;
        return;
    }
    await loadUserProfile();
    loginSuccessDialog.hidden = false;
});

await Promise.all([initializeTree(), loadUserProfile()]);
