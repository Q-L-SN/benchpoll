import { postJSON } from './http.js';
import { canonicalAccountID, pageAccountWriteScope } from './account-identity.js';
import { profileAvatarURL } from './profile-editor.js';
import { listenAccountChange } from './sign-in.js';
import './help-popover.js?v=help-popovers-20261008';

// The same navigation is used in the home header and standalone page headers.
export function mountSiteActions(nav, { accountID = 'site-account', moreID = 'site-more',
    accountButton = false, manageAccount = false, extraActions = [], minimal = false, prioritizeAccount = false } = {}) {
    nav.classList.add('bp-site-links', 'th-header-links');
    nav.setAttribute('aria-label', 'About and account');
    nav.innerHTML = `<a class="th-quiet th-social" href="https://x.com/BenchPoll" target="_blank" rel="noopener noreferrer" aria-label="BenchPoll on X" data-tooltip="BenchPoll on X"><i class="th-x-mark" aria-hidden="true">&#120143;</i></a>
        ${minimal ? '' : `<a class="th-quiet" href="/how-it-works" aria-label="How it works" data-tooltip="How it works"><i class="fa-regular fa-circle-question" aria-hidden="true"></i><span>How it works</span></a>
        ${accountButton ? '<button class="th-quiet" type="button" disabled>' : '<a class="th-quiet" href="/login">'}<i class="fa-regular fa-user" aria-hidden="true"></i><span>Sign in</span>${accountButton ? '</button>' : '</a>'}`}
        <details class="th-more"${minimal ? ' hidden' : ''}><summary class="th-quiet" role="button" aria-label="More information" data-tooltip="More information"><i class="fa-solid fa-ellipsis" aria-hidden="true"></i></summary>
            <nav aria-label="More information"><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/cookies">Cookies</a><a href="/community-guidelines">Community guidelines</a></nav></details>`;
    const account = minimal ? null : nav.querySelector(accountButton ? 'button' : 'a[href="/login"]');
    if (account) { account.id = accountID; account.dataset.tooltip = 'Account'; }
    if (prioritizeAccount && account) account.dataset.priorityAccount = 'true';
    const more = nav.querySelector('details');
    more.id = moreID;
    for (const action of extraActions) nav.insertBefore(action, prioritizeAccount && account ? account : more);
    const inner = nav.parentElement;
    const actions = [...nav.children].filter(node => node !== more);
    const menu = more.querySelector('nav');
    const firstLegal = menu.firstElementChild;
    const directory = inner.querySelector('.th-directory-nav');
    let layoutFrame = null;
    const syncOverflow = () => {
        if (!directory) return;
        const max = directory.scrollWidth - directory.clientWidth;
        directory.classList.toggle('has-overflow-start', directory.scrollLeft > 1);
        directory.classList.toggle('has-overflow-end', max > 1 && directory.scrollLeft < max - 1);
    };
    const refreshLayout = () => {
        if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
        layoutFrame = requestAnimationFrame(() => {
            layoutFrame = null;
            const active = nav.getRootNode().activeElement;
            const wasActionFocused = actions.includes(active) || actions.some(action => action.contains(active));
            for (const action of actions) nav.insertBefore(action, more);
            nav.classList.remove('has-compact-account');
            more.hidden = minimal;
            const visible = [...inner.children].filter(node => node !== nav && node.getClientRects().length);
            const gap = Number.parseFloat(getComputedStyle(inner).columnGap) || 0;
            const occupied = visible.reduce((total, node) => total + (node === directory
                ? node.querySelector('.th-directory-controls')?.scrollWidth ?? node.scrollWidth
                : Math.max(node.getBoundingClientRect().width, node.scrollWidth)), 0);
            // The workspace supplies its own compact icon row and drawer. Keep
            // those primary controls in place instead of nesting them in More.
            const overflows = () => occupied + nav.scrollWidth + gap * visible.length > inner.clientWidth + 1;
            if (!minimal && prioritizeAccount && account) {
                for (const action of actions.filter(action => action !== account)) {
                    if (!overflows()) break;
                    menu.insertBefore(action, firstLegal);
                }
                if (overflows()) nav.classList.add('has-compact-account');
                if (overflows()) menu.insertBefore(account, firstLegal);
            } else if (!minimal && overflows()) {
                more.hidden = false;
                for (const action of actions) menu.insertBefore(action, firstLegal);
            }
            const compact = actions.some(action => action.parentElement === menu);
            nav.classList.toggle('is-compact', compact);
            if (wasActionFocused && active?.isConnected) active.focus({ preventScroll: true });
            syncOverflow();
        });
    };
    directory?.addEventListener('scroll', syncOverflow, { passive: true });
    if (directory) new window.ResizeObserver(syncOverflow).observe(directory);
    new window.ResizeObserver(refreshLayout).observe(inner);
    window.addEventListener('resize', refreshLayout);
    document.fonts?.ready.then(refreshLayout);
    refreshLayout();
    if (manageAccount && account) {
        let profile = null, serial = 0;
        const render = () => {
            const name = profile?.userName?.trim() || 'Your account';
            account.replaceChildren();
            const url = profile && profileAvatarURL(profile.userProfilePictureURL);
            const mark = document.createElement(url ? 'img' : 'i');
            if (url) { mark.src = url; mark.alt = ''; mark.referrerPolicy = 'no-referrer'; }
            else { mark.className = 'fa-regular fa-user'; mark.setAttribute('aria-hidden', 'true'); }
            const label = document.createElement('span'); label.textContent = profile ? name : 'Sign in';
            account.append(mark, label);
            account.setAttribute('aria-label', profile ? `View your profile: ${name}` : 'Sign in');
            account.dataset.tooltip = profile ? 'Your profile' : 'Sign in';
            account.removeAttribute('aria-haspopup');
            if (account.tagName === 'A') account.href = profile ? '/me' : '/login';
        };
        const refresh = async () => {
            const current = ++serial;
            try {
                const result = await postJSON('/api/get_user_profile', {}, { timeoutMs: 15000, requireJSON: true });
                if (current !== serial) return;
                profile = result && canonicalAccountID(result.userID) === result.userID ? result : null;
                if (profile) pageAccountWriteScope.bind(profile.userID);
            } catch { if (current === serial) profile = null; }
            if (current === serial) { render(); refreshLayout(); }
        };
        if (account.tagName !== 'A') account.addEventListener('click', () => { if (profile) location.assign('/me'); });
        document.addEventListener('benchpoll:profile-updated', event => {
            if (profile?.userID !== event.detail?.userID) return;
            profile = { ...profile, ...event.detail }; render(); refreshLayout();
        });
        listenAccountChange(() => { void refresh(); });
        void refresh();
    }
    nav.addEventListener('keydown', event => {
        if (event.key === 'Escape' && more.open) { event.preventDefault(); more.open = false; more.querySelector('summary').focus(); }
    });
    for (const action of extraActions) action.addEventListener('click', () => { more.open = false; });
    document.addEventListener('click', event => {
        const path = event.composedPath();
        if (more.open && !path.includes(more) && !path.some(node => node instanceof globalThis.HTMLDialogElement)) more.open = false;
    });
    return { account, more, refreshLayout };
}
