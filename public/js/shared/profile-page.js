import { mountSiteActions } from './site-header.js';
import { installSignInLinks } from './sign-in.js';
import { profileAvatarURL } from './profile-editor.js';

export function element(tag, className = '', text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
}

export function icon(name) {
    const result = element('i', `fa-solid fa-${name}`);
    result.setAttribute('aria-hidden', 'true');
    return result;
}

export function link(href, label, symbol = null, className = 'pf-action') {
    const result = element('a', className);
    result.href = href;
    if (symbol) result.append(icon(symbol));
    result.append(document.createTextNode(label));
    return result;
}

export function avatar(profile) {
    const result = element('div', 'pf-avatar');
    const fallback = () => result.replaceChildren(document.createTextNode([...String(profile.userName || '?')][0].toUpperCase()));
    const src = profileAvatarURL(profile.userProfilePictureURL);
    if (src) {
        const img = element('img'); img.src = src; img.alt = ''; img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', fallback, { once: true }); result.append(img);
    } else fallback();
    result.setAttribute('aria-hidden', 'true');
    return result;
}

export function initializeProfileHeader() {
    mountSiteActions(document.getElementById('profile-site-links'), { manageAccount: true });
    installSignInLinks();
}

export function showFailure(status, error, fallback) {
    status.classList.add('is-error');
    status.textContent = error.status === 401 ? 'Sign in to continue.' : error.status === 404 ? 'This profile is not available.' : fallback;
    if (error.status === 401) status.append(' ', link('/login', 'Sign in'));
}
