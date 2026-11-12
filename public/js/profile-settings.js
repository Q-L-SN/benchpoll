import { postJSON } from './shared/http.js';
import { pageAccountWriteScope, isAccountWriteError } from './shared/account-identity.js';
import { profileDisplayName, prepareProfileAvatar } from './shared/profile-editor.js';
import { publicProfileID, publicProfileBio } from './shared/profile-identity.js';
import { listenAccountChange } from './shared/sign-in.js';
import { element, link, avatar, initializeProfileHeader, showFailure } from './shared/profile-page.js';
import './shared/legal-acceptance.js';

initializeProfileHeader();
const status = document.getElementById('settings-status'), view = document.getElementById('settings-view');
const path = location.pathname, section = path.split('/')[2] || 'home';
const titles = { home: 'Settings', profile: 'Profile', privacy: 'Privacy', 'delete-account': 'Delete account', logout: 'Log out' };
document.getElementById('settings-title').textContent = titles[section] || 'Settings';
document.title = `${titles[section] || 'Settings'} · BenchPoll`;
document.querySelector(`.pf-settings-nav a[href="${path}"]`)?.setAttribute('aria-current', 'page');
const request = (url, body = {}) => postJSON(url, body, { timeoutMs: 20000, requireJSON: true });
let profile = null, busy = false, blocked = false;

const messages = {
    profile_public_id_invalid: 'Use 1–32 letters, numbers, hyphens or underscores. Start and end with a letter or number. Numeric IDs must be positive, without leading zeros.',
    profile_public_id_taken: 'That user ID is already taken. Choose another.',
    profile_bio_invalid: 'Keep your bio within 280 characters and remove control characters.',
    profile_display_name_invalid: 'Enter a display name with 1–60 characters.',
    profile_github_reauthentication_required: 'Sign in again to connect your GitHub profile.',
    profile_avatar_invalid: 'The image could not be verified. Please choose it again.',
    profile_payload_too_large: 'Choose a smaller avatar image.',
    legal_acceptance_required: 'Review the current terms before saving. Your changes are kept.'
};
function report(error) {
    status.classList.add('is-error');
    status.textContent = isAccountWriteError(error) ? error.message : messages[error.payload?.error]
        || (error.status === 401 ? 'Sign in again before saving.' : 'Could not save your changes. Your draft is kept; try again.');
    if (isAccountWriteError(error) || error.status === 401) blocked = true;
}
function button(text, className = '') { const result = element('button', `pf-button ${className}`.trim(), text); result.type = 'button'; return result; }
function field(label, name, value, type = 'text', help = '') {
    const wrapper = element('div', 'pf-field'), caption = element('label', '', label);
    const input = element(type === 'textarea' ? 'textarea' : 'input'); input.id = `profile-${name}`; input.name = name;
    if (type !== 'textarea') input.type = type;
    if (type !== 'file') input.value = value ?? '';
    caption.htmlFor = input.id; wrapper.append(caption, input);
    if (help) { const hint = element('small', '', help); hint.id = `${input.id}-hint`; wrapper.append(hint); input.setAttribute('aria-describedby', hint.id); }
    return { wrapper, input };
}
function toggle(label, name, checked, disabled = false) {
    const wrapper = element('label', 'pf-toggle'), input = element('input');
    input.type = 'checkbox'; input.id = `profile-${name}`; input.name = name; input.checked = checked; input.disabled = disabled;
    input.setAttribute('role', 'switch'); wrapper.append(element('span', '', label), input);
    return { wrapper, input };
}
async function guardedWrite(url, body, success) {
    if (busy || blocked) return;
    busy = true; status.textContent = ''; status.classList.remove('is-error'); view.setAttribute('aria-busy', 'true');
    const controls = [...view.querySelectorAll('button, input, textarea')], disabled = controls.map(item => item.disabled);
    controls.forEach(item => { item.disabled = true; });
    try {
        const saved = await pageAccountWriteScope.write(request, url, body);
        if (blocked) return;
        await success(saved);
    } catch (error) { report(error); }
    finally {
        busy = false; view.setAttribute('aria-busy', 'false');
        controls.forEach((item, i) => { item.disabled = blocked || disabled[i]; });
    }
}

function renderProfileForm() {
    const form = element('form'); form.noValidate = true;
    const avatarRow = element('div', 'pf-avatar-field'), picture = avatar(profile);
    const upload = field('Avatar', 'avatar', null, 'file', 'PNG, JPEG or WebP. Your image is cropped to a square.');
    upload.input.accept = 'image/png,image/jpeg,image/webp';
    const reset = button('Reset avatar'); upload.wrapper.append(reset); avatarRow.append(picture, upload.wrapper);
    const displayName = field('Display name', 'displayName', profile.userName); displayName.input.maxLength = 240; displayName.input.autocomplete = 'nickname';
    const publicID = field('User ID', 'publicID', profile.publicID, 'text', 'Your profile address is benchpoll.com/@userid. IDs are unique and case-insensitive.');
    publicID.input.maxLength = 32; publicID.input.spellcheck = false; publicID.input.autocomplete = 'off';
    const bio = field('Bio', 'bio', profile.bio, 'textarea', 'Optional. Up to 280 characters.'); bio.input.maxLength = 1120;
    const github = toggle('Show GitHub profile link', 'showGitHubProfile', profile.showGitHubProfile === true,
        profile.canShowGitHubProfile !== true && profile.showGitHubProfile !== true);
    const actions = element('div', 'pf-form-actions'), save = button('Save profile', 'is-primary'); save.type = 'submit';
    actions.append(save, link('/me', 'View profile'));
    form.append(avatarRow, displayName.wrapper, publicID.wrapper, bio.wrapper, github.wrapper);
    if (github.input.disabled) form.append(link('/login', 'Sign in again to connect GitHub'));
    form.append(actions); view.append(form);
    let changedAvatar = false, preparedAvatar = null, processing = false, uploadGeneration = 0;
    let uploadController = null;
    function showAvatar(value) { const next = avatar({ userName: displayName.input.value, userProfilePictureURL: value }); picture.replaceChildren(...next.childNodes); }
    reset.addEventListener('click', () => {
        uploadGeneration++; uploadController?.abort(); changedAvatar = true; preparedAvatar = null; processing = false;
        upload.input.value = ''; save.disabled = false; showAvatar(profile.defaultUserProfilePictureURL); status.textContent = '';
    });
    upload.input.addEventListener('change', async () => {
        const selected = upload.input.files?.[0]; if (!selected || busy || blocked) return;
        const generation = ++uploadGeneration; uploadController?.abort(); uploadController = new globalThis.AbortController();
        processing = true; save.disabled = true; status.textContent = 'Preparing avatar…';
        try {
            const value = await prepareProfileAvatar(selected, { signal: uploadController.signal });
            if (generation !== uploadGeneration || blocked) return;
            preparedAvatar = value; changedAvatar = true; showAvatar(value); status.textContent = '';
        } catch (error) { if (generation === uploadGeneration && error.name !== 'AbortError') { status.textContent = error.message; status.classList.add('is-error'); } }
        finally { if (generation === uploadGeneration) { processing = false; save.disabled = blocked; upload.input.value = ''; } }
    });
    form.addEventListener('submit', event => {
        event.preventDefault(); if (processing) return;
        const values = { displayName: profileDisplayName(displayName.input.value), publicID: publicProfileID(publicID.input.value),
            bio: publicProfileBio(bio.input.value), showGitHubProfile: github.input.checked };
        for (const [key, control, code] of [['displayName', displayName.input, 'profile_display_name_invalid'],
            ['publicID', publicID.input, 'profile_public_id_invalid'], ['bio', bio.input, 'profile_bio_invalid']]) {
            const invalid = values[key] === null; control.setAttribute('aria-invalid', String(invalid));
            if (invalid) { status.textContent = messages[code]; status.classList.add('is-error'); control.focus(); return; }
        }
        const body = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== (key === 'displayName' ? profile.userName : profile[key])));
        if (changedAvatar) body.avatar = preparedAvatar;
        if (!Object.keys(body).length) { status.textContent = 'Your profile is up to date.'; return; }
        void guardedWrite('/api/save_user_profile', body, saved => {
            if (saved?.userID !== profile.userID || !publicProfileID(saved.publicID)) throw new Error('Unconfirmed profile.');
            profile = saved; publicID.input.value = saved.publicID; displayName.input.value = saved.userName;
            changedAvatar = false; status.textContent = 'Profile saved.';
            document.dispatchEvent(new CustomEvent('benchpoll:profile-updated', { detail: saved }));
        });
    });
}

function renderPrivacy() {
    const form = element('form'), favorites = toggle('Publish my favorites', 'publishFavorites', profile.publishFavorites === true);
    const configured = toggle('Publish my configured topics', 'publishConfiguredTopics', profile.publishConfiguredTopics === true);
    const save = button('Save privacy settings', 'is-primary'); save.type = 'submit';
    const actions = element('div', 'pf-form-actions'); actions.append(save);
    form.append(element('p', 'pf-muted', 'Choose which collections appear on your public profile. Private topics are never listed publicly.'),
        favorites.wrapper, configured.wrapper, actions, link('/account/privacy', 'Privacy & account choices', 'shield-halved'));
    form.addEventListener('submit', event => {
        event.preventDefault();
        const body = { publishFavorites: favorites.input.checked, publishConfiguredTopics: configured.input.checked };
        void guardedWrite('/api/save_profile_privacy', body, saved => {
            if (saved?.userID !== profile.userID || saved.publishFavorites !== body.publishFavorites
                || saved.publishConfiguredTopics !== body.publishConfiguredTopics) throw new Error('Unconfirmed privacy settings.');
            Object.assign(profile, saved); status.textContent = 'Privacy settings saved.';
        });
    });
    view.append(form);
}

function accountAction(url) {
    void guardedWrite(url, {}, () => {
        pageAccountWriteScope.invalidate();
        try { localStorage.setItem('user-profile-update', 'null'); } catch { /* Optional cross-tab notification. */ }
        location.assign('/');
    });
}
async function renderLogout() {
    view.append(element('p', '', 'Log out of BenchPoll on this device.'));
    const actions = element('div', 'pf-form-actions'), current = button('Log out', 'is-primary');
    current.addEventListener('click', () => accountAction('/api/logout')); actions.append(current); view.append(actions);
    try {
        const result = await request('/api/get_device_count');
        if (!blocked && Number.isSafeInteger(result?.deviceCount) && result.deviceCount > 1) {
            const all = button(`Log out on all ${result.deviceCount} devices`);
            all.addEventListener('click', () => accountAction('/api/logout?all')); actions.append(all);
        }
    } catch { /* Logging out of this device remains available. */ }
}
function renderDelete() {
    view.append(element('p', '', 'Deleting your account ends all sessions and removes saved comparison profiles. Your weights, private topics and review records are retained. Signing in with GitHub again reactivates the account.'),
        link('/account/privacy#request', 'Request data erasure', 'shield-halved'));
    const form = element('form'), confirm = toggle('I understand what will be retained.', 'confirmDelete', false);
    const remove = button('Delete account', 'is-danger'); remove.type = 'submit'; remove.disabled = true;
    confirm.input.addEventListener('change', () => { remove.disabled = !confirm.input.checked || busy || blocked; });
    form.append(confirm.wrapper, remove); view.append(form);
    form.addEventListener('submit', event => { event.preventDefault(); if (confirm.input.checked) accountAction('/api/delete_account'); });
}

listenAccountChange(() => {
    blocked = true; pageAccountWriteScope.invalidate();
    view.querySelectorAll('input, textarea, button').forEach(item => { item.disabled = true; });
    status.textContent = 'Your account changed. Refresh before editing settings.';
});
request('/api/get_user_profile').then(result => {
    if (blocked) return;
    if (!result) throw Object.assign(new Error('Sign in.'), { status: 401 });
    pageAccountWriteScope.bind(result.userID); profile = result; status.textContent = '';
    if (section === 'profile') renderProfileForm();
    else if (section === 'privacy') renderPrivacy();
    else if (section === 'logout') void renderLogout();
    else if (section === 'delete-account') renderDelete();
    else view.append(element('p', 'pf-muted', 'Manage your public profile, privacy and account.'));
}).catch(error => showFailure(status, error, 'Settings could not be loaded. Refresh to try again.'));
