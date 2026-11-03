import { setLoading } from './loading.js';
import { postJSON } from './http.js';
import { pageAccountWriteScope, canonicalAccountID, accountWriteError, isAccountWriteError } from './account-identity.js';
import { openProfileEditor, profileAvatarURL } from './profile-editor.js';
import { createAction } from './ui-components.js';
import { CLIENT_ID } from '../shared.js';
import { publicGitHubURL } from './topic-identity.js';

let activeCenter = null;

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function ensureStyles() {
    if (document.querySelector('link[data-bp-account-center]')) return;
    const link = element('link');
    link.rel = 'stylesheet';
    link.href = new URL('../../css/ui/account-center.css', import.meta.url).href;
    link.dataset.bpAccountCenter = '';
    document.head.append(link);
}

function privacyLink(label = 'Privacy & account choices', href = '/account/privacy') {
    const link = createAction({ label, href, icon: 'fa-solid fa-shield-halved' });
    link.target = '_blank';
    link.rel = 'noopener';
    return link;
}

function errorMessage(error) {
    if (isAccountWriteError(error)) return error.message;
    if (error?.status === 401) return 'Your session ended. Refresh this page and sign in again.';
    if (error?.payload?.error === 'legal_acceptance_required') return error.message;
    return 'Could not complete the account action. Please try again.';
}

// Resolves on dismissal: null, or { action } after a successful sign-out.
// onSignedOut runs immediately after the guarded write, before dismissal.
export async function openAccountCenter({ profile = null, onProfileSaved, onSignedOut } = {}) {
    const owner = profile === null ? null : canonicalAccountID(profile.userID);
    if (profile !== null) {
        if (typeof profile.userID !== 'string' || !owner) throw accountWriteError('account_identity_required');
        pageAccountWriteScope.bind(owner);
    }
    if (activeCenter) {
        if (activeCenter.owner !== owner) throw accountWriteError();
        activeCenter.dialog.focus();
        return activeCenter.result;
    }
    ensureStyles();
    const trigger = document.activeElement;
    const dialog = element('dialog', 'bp-account-center');
    dialog.id = 'user-account-dialog';
    dialog.setAttribute('aria-labelledby', 'bp-account-center-title');
    const header = element('header', 'bp-account-center-header');
    const title = element('h2', '', 'Your account');
    title.id = 'bp-account-center-title';
    const close = createAction({ label: 'Close your account', icon: 'fa-solid fa-xmark', iconOnly: true, className: 'dialog-close-button' });
    header.append(title, close);
    const body = element('div', 'bp-account-center-body');
    const status = element('p', 'bp-account-center-status');
    status.setAttribute('role', 'alert');
    const liveStatus = element('p', 'bp-account-center-live');
    liveStatus.setAttribute('role', 'status');
    liveStatus.setAttribute('aria-atomic', 'true');
    dialog.append(header, body, status, liveStatus);
    let resolveResult;
    const result = new Promise(resolve => { resolveResult = resolve; });
    let current = profile && { ...profile }, view = 'root', closed = false, busy = false, blocked = false;
    let epoch = 0, readController = null, profileController = null, outcome = null;
    let editButton = null, picture = null, name = null, githubToggle = null;
    const assertOwner = () => {
        if (blocked || owner === null || pageAccountWriteScope.capture() !== owner) throw accountWriteError();
    };
    const syncIdentity = () => {
        if (!name || !picture) return;
        name.textContent = current.userName || 'Your account';
        const url = profileAvatarURL(current.userProfilePictureURL);
        picture.style.backgroundImage = url ? 'url("' + url + '")' : '';
        picture.dataset.hasPicture = String(Boolean(url));
        picture.textContent = url ? '' : [...name.textContent][0]?.toLocaleUpperCase() || '?';
    };
    const syncGitHubToggle = () => {
        if (!githubToggle || !current) return;
        githubToggle.checked = current.showGitHubProfile === true;
        githubToggle.disabled = busy || blocked || (current.canShowGitHubProfile !== true && !githubToggle.checked);
    };
    const acceptProfile = saved => {
        current = { ...current, ...saved };
        if (saved.showGitHubProfile !== true) delete current.githubURL;
        syncIdentity();
        syncGitHubToggle();
    };
    const finish = () => {
        if (closed || busy) return;
        closed = true;
        epoch++;
        readController?.abort();
        profileController?.abort();
        document.removeEventListener('benchpoll:profile-updated', profileUpdated);
        window.removeEventListener('storage', storageChanged);
        if (dialog.open) dialog.close();
        dialog.remove();
        activeCenter = null;
        if (trigger?.isConnected && !trigger.hidden) trigger.focus({ preventScroll: true });
        resolveResult(outcome);
    };
    const startView = (next, heading) => {
        epoch++;
        readController?.abort();
        view = next;
        title.textContent = heading;
        status.textContent = '';
        liveStatus.textContent = '';
        body.replaceChildren();
        name = picture = editButton = githubToggle = null;
    };
    const action = (label, icon, callback, id) => {
        const button = createAction({ label, icon });
        if (id) button.id = id;
        button.addEventListener('click', callback);
        return button;
    };
    const renderRoot = (focusID = null) => {
        startView('root', 'Your account');
        if (current) {
            const summary = element('div', 'bp-account-center-summary');
            picture = element('span', 'bp-account-center-picture');
            picture.id = 'account-dialog-picture';
            picture.setAttribute('aria-hidden', 'true');
            const copy = element('div', 'bp-account-center-copy');
            name = element('strong');
            name.id = 'account-dialog-name';
            copy.append(name, element('small', '', 'GitHub account'));
            summary.append(picture, copy);
            body.append(summary);
            syncIdentity();
        }
        const operations = element('nav', 'bp-account-center-operations');
        operations.setAttribute('aria-label', 'Account actions');
        if (current) {
            editButton = action('Edit profile', 'fa-regular fa-pen-to-square', async () => {
                if (busy || blocked) return;
                try {
                    assertOwner();
                    editButton.disabled = true;
                    await openProfileEditor({ profile: current, onSaved: async saved => {
                        assertOwner();
                        acceptProfile(saved);
                        await onProfileSaved?.(saved);
                    } });
                } catch (error) { if (!closed) status.textContent = errorMessage(error); }
                finally {
                    if (!closed && view === 'root') {
                        editButton.disabled = blocked;
                        editButton.focus({ preventScroll: true });
                    }
                }
            }, 'edit-profile-button');
            operations.append(editButton);
            const choice = element('label', 'bp-account-center-github');
            const icon = element('i', 'fa-brands fa-github');
            icon.setAttribute('aria-hidden', 'true');
            githubToggle = element('input');
            githubToggle.type = 'checkbox';
            githubToggle.id = 'account-public-github';
            githubToggle.setAttribute('role', 'switch');
            choice.append(icon, element('span', 'bp-ui-action-label', 'Show my GitHub profile'), githubToggle);
            githubToggle.addEventListener('change', () => {
                const next = githubToggle.checked;
                syncGitHubToggle();
                void saveGitHubVisibility(next);
            });
            operations.append(choice);
            syncGitHubToggle();
            if (current.canShowGitHubProfile !== true && current.showGitHubProfile !== true) {
                operations.append(createAction({ label: 'Sign in again to connect GitHub', icon: 'fa-brands fa-github', href: '/github_login' }));
            }
        } else {
            operations.append(createAction({ label: 'Sign in with GitHub', icon: 'fa-brands fa-github', href: '/github_login' }));
        }
        operations.append(privacyLink());
        if (current) {
            operations.append(action('Log out', 'fa-solid fa-arrow-right-from-bracket', () => { void renderLogout(); }, 'logout-button'));
            const deactivate = action('Deactivate account', 'fa-solid fa-user-xmark', renderDeactivate, 'delete-account-button');
            deactivate.classList.add('is-danger');
            operations.append(deactivate);
        }
        body.append(operations);
        if (focusID) body.querySelector('#' + focusID)?.focus({ preventScroll: true });
    };
    const saveGitHubVisibility = async next => {
        if (busy || blocked || closed || !current || next === (current.showGitHubProfile === true)) return;
        try { assertOwner(); } catch (error) { status.textContent = errorMessage(error); return; }
        busy = true;
        status.textContent = '';
        liveStatus.textContent = 'Saving GitHub profile visibility.';
        dialog.setAttribute('aria-busy', 'true');
        const restoreFocus = document.activeElement === githubToggle;
        const controls = [...dialog.querySelectorAll('button, input')];
        const disabled = controls.map(control => control.disabled);
        controls.forEach(control => { control.disabled = true; });
        profileController = new globalThis.AbortController();
        try {
            const saved = await pageAccountWriteScope.write((path, payload) => postJSON(path, payload,
                { signal: profileController.signal, timeoutMs: 20000, requireJSON: true }),
            '/api/save_user_profile', { showGitHubProfile: next });
            assertOwner();
            if (closed) return;
            if (saved?.userID !== owner || saved.showGitHubProfile !== next
                || (next ? !publicGitHubURL(saved.githubURL) : Object.hasOwn(saved, 'githubURL'))) {
                throw new Error('profile_save_unconfirmed');
            }
            acceptProfile(saved);
            liveStatus.textContent = 'GitHub profile visibility saved.';
            document.dispatchEvent(new CustomEvent('benchpoll:profile-updated', { detail: saved }));
            try { await onProfileSaved?.(saved); }
            catch (error) { console.error('Profile saved, but its view could not be refreshed.', error); }
        } catch (error) {
            liveStatus.textContent = '';
            if (!closed) status.textContent = error?.payload?.error === 'profile_github_reauthentication_required'
                ? 'Sign in again before sharing your GitHub profile.'
                : isAccountWriteError(error) || error?.status === 401 || error?.payload?.error === 'legal_acceptance_required'
                    ? errorMessage(error) : 'Could not confirm the setting. Please retry or refresh.';
            if (isAccountWriteError(error) || error?.status === 401) blocked = true;
        } finally {
            busy = false;
            profileController = null;
            dialog.setAttribute('aria-busy', 'false');
            controls.forEach((control, index) => { control.disabled = disabled[index] || (blocked && control !== close); });
            syncGitHubToggle();
            if (blocked) finish();
            else if (!closed && restoreFocus) githubToggle?.focus({ preventScroll: true });
        }
    };
    const controls = () => {
        const footer = element('footer', 'bp-account-center-actions');
        footer.append(action('Cancel', null, () => renderRoot(view === 'logout' ? 'logout-button' : 'delete-account-button')));
        body.append(footer);
        return footer;
    };
    const commit = async (path, kind) => {
        if (busy || closed) return;
        try { assertOwner(); } catch (error) { status.textContent = errorMessage(error); return; }
        busy = true;
        epoch++;
        readController?.abort();
        dialog.setAttribute('aria-busy', 'true');
        status.textContent = '';
        const buttons = [...dialog.querySelectorAll('button')];
        const disabled = buttons.map(button => button.disabled);
        buttons.forEach(button => { button.disabled = true; });
        try {
            await pageAccountWriteScope.write((url, payload) => postJSON(url, payload, { timeoutMs: 20000, requireJSON: true }), path);
            outcome = { action: kind };
            pageAccountWriteScope.invalidate();
            current = null;
            try { localStorage.setItem('user-profile-update', 'null'); } catch { /* Notification is optional. */ }
            startView('success', kind === 'deactivate' ? 'Account deactivated' : 'You have been logged out');
            if (kind === 'deactivate') {
                body.append(element('p', '', 'Your account records have not been completely erased. Signing in with GitHub again reactivates the account.'));
                body.append(privacyLink('Privacy Policy', '/privacy#rights'));
                body.append(privacyLink('Revoke GitHub access', 'https://github.com/settings/connections/applications/' + CLIENT_ID));
            }
            const dismiss = createAction({ label: 'Close', variant: 'primary' });
            dismiss.addEventListener('click', finish);
            const footer = element('footer', 'bp-account-center-actions');
            footer.append(dismiss);
            body.append(footer);
            try { Promise.resolve(onSignedOut?.(outcome)).catch(error => console.error('Account action completed, but its view could not be refreshed.', error)); }
            catch (error) { console.error('Account action completed, but its view could not be refreshed.', error); }
        } catch (error) {
            status.textContent = errorMessage(error);
            if (isAccountWriteError(error) || error?.status === 401) blocked = true;
            if (error?.payload?.error === 'legal_acceptance_required') body.append(privacyLink());
        } finally {
            busy = false;
            close.disabled = false;
            dialog.setAttribute('aria-busy', 'false');
            if (!outcome) buttons.forEach((button, index) => { button.disabled = disabled[index] || (blocked && button !== close); });
            if (outcome) body.querySelector('button')?.focus({ preventScroll: true });
        }
    };
    const renderLogout = async () => {
        if (busy || blocked) return;
        startView('logout', 'Log out?');
        const countStatus = element('p', '');
        setLoading(countStatus, 'Checking signed-in devices');
        body.append(countStatus);
        const footer = controls();
        const thisDevice = action('Log out on this device', 'fa-solid fa-arrow-right-from-bracket', () => { void commit('/api/logout', 'logout'); });
        footer.append(thisDevice);
        const requestEpoch = epoch;
        readController = new globalThis.AbortController();
        close.focus();
        try {
            assertOwner();
            const payload = await postJSON('/api/get_device_count', {}, { signal: readController.signal, timeoutMs: 15000, requireJSON: true });
            if (closed || epoch !== requestEpoch) return;
            assertOwner();
            const count = payload?.deviceCount;
            if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid device count.');
            countStatus.textContent = count === 1 ? 'This signs you out on this device.' : 'You are signed in on ' + count + ' devices.';
            if (count > 1) footer.append(action('Log out on all ' + count + ' devices', 'fa-solid fa-right-from-bracket', () => { void commit('/api/logout?all', 'logout-all'); }));
        } catch (error) {
            if (closed || epoch !== requestEpoch) return;
            countStatus.textContent = 'Could not check other signed-in devices.';
            status.textContent = errorMessage(error);
            if (isAccountWriteError(error) || error?.status === 401) thisDevice.disabled = true;
            else body.append(action('Retry device count', 'fa-solid fa-arrow-rotate-right', () => { void renderLogout(); }));
        }
    };
    const renderDeactivate = () => {
        if (busy || blocked) return;
        startView('deactivate', 'Deactivate your account?');
        body.append(element('p', '', 'This signs you out on all devices and removes saved comparison profiles. Weights, private topics and review records are retained. Signing in again reactivates the account.'));
        body.append(privacyLink('Privacy Policy and erasure requests', '/privacy#rights'));
        const footer = controls();
        const confirm = action('Deactivate account', 'fa-solid fa-user-xmark', () => { void commit('/api/delete_account', 'deactivate'); });
        confirm.classList.add('is-danger');
        footer.append(confirm);
        close.focus();
    };
    const profileUpdated = event => {
        const saved = event.detail?.profile ?? event.detail;
        if (!current || saved?.userID !== owner) return;
        try { assertOwner(); } catch { return; }
        acceptProfile(saved);
    };
    const storageChanged = event => {
        if ((event.key !== 'user-profile-update' && event.key !== null) || !current) return;
        pageAccountWriteScope.invalidate();
        blocked = true;
        profileController?.abort();
        if (!busy) finish();
    };
    close.addEventListener('click', finish);
    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        if (busy) return;
        if (view === 'logout' || view === 'deactivate') renderRoot();
        else finish();
    });
    dialog.addEventListener('close', finish);
    dialog.addEventListener('keydown', event => {
        if (event.key === 'Escape' || event.key === 'Tab') event.stopPropagation();
        if (event.key !== 'Tab') return;
        const items = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), a[href]')].filter(node => node.getClientRects().length);
        if (!items.length) return;
        event.preventDefault();
        const index = items.indexOf(document.activeElement);
        const next = event.shiftKey ? (index <= 0 ? items.length - 1 : index - 1) : (index + 1) % items.length;
        items[next].focus();
    });
    document.addEventListener('benchpoll:profile-updated', profileUpdated);
    window.addEventListener('storage', storageChanged);
    activeCenter = { owner, dialog, result };
    document.body.append(dialog);
    renderRoot();
    try { dialog.showModal(); close.focus({ preventScroll: true }); }
    catch (error) { finish(); throw error; }
    return result;
}
