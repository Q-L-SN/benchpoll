import { postJSON } from './shared/http.js';
import { pageAccountWriteScope } from './shared/account-identity.js';
import { publicProfileID } from './shared/profile-identity.js';
import { publicGitHubURL } from './shared/topic-identity.js';
import { createTopicCard } from './shared/topic-card.js';
import { listenAccountChange } from './shared/sign-in.js';
import { element, icon, link, avatar, initializeProfileHeader, showFailure } from './shared/profile-page.js';

initializeProfileHeader();
const status = document.getElementById('profile-status');
const identity = document.getElementById('profile-identity');
const tablist = document.getElementById('profile-tabs');
const panel = document.getElementById('profile-topics');
let cards = [], blocked = false;

function renderProfile(data) {
    if (blocked) return;
    const { profile, tabs, isSelf, viewerID } = data;
    if (!publicProfileID(profile?.publicID) || !Array.isArray(tabs)) throw new Error('Invalid profile.');
    if (viewerID !== null) pageAccountWriteScope.bind(viewerID);
    document.title = `${profile.userName} · BenchPoll`;
    const details = element('div', 'pf-identity-copy');
    details.append(element('h1', 'pf-name', profile.userName), element('p', 'pf-handle', `@${profile.publicID}`));
    if (profile.bio) details.append(element('p', 'pf-bio', profile.bio));
    const github = publicGitHubURL(profile.githubURL);
    if (github) {
        const external = link(github, 'GitHub', null, 'pf-github');
        const githubIcon = element('i', 'fa-brands fa-github'); githubIcon.setAttribute('aria-hidden', 'true');
        external.prepend(githubIcon);
        external.target = '_blank'; external.rel = 'noopener noreferrer nofollow'; external.referrerPolicy = 'no-referrer';
        details.append(external);
    }
    identity.append(avatar(profile), details);
    if (isSelf) {
        const actions = element('nav', 'pf-own-actions'); actions.setAttribute('aria-label', 'Your profile');
        actions.append(link('/me/history', 'History', 'clock-rotate-left'), link('/settings', 'Settings', 'gear'));
        identity.append(actions);
    }
    identity.hidden = false;
    status.textContent = '';
    if (!tabs.length) { panel.hidden = false; panel.append(element('p', 'pf-empty', 'No public topics to show yet.')); return; }
    const selectTab = selected => {
        for (const button of tablist.children) {
            const active = button.dataset.key === selected.key;
            button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
        }
        cards.forEach(card => card.dispose?.()); cards = [];
        panel.replaceChildren(); panel.setAttribute('aria-labelledby', `profile-tab-${selected.key}`);
        if (selected.private) {
            const note = element('p', 'pf-collection-note pf-private-note', 'Only you can see this collection.');
            note.prepend(icon('lock')); panel.append(note);
        }
        for (const topic of selected.topics) {
            const card = createTopicCard(topic, { onError: (_error, message) => {
                status.textContent = viewerID === null ? 'Sign in to favorite a topic.' : message;
                if (viewerID === null) status.append(' ', link('/login', 'Sign in'));
            },
                onFavoriteChange: updated => { Object.assign(topic, updated); } });
            cards.push(card); panel.append(card);
        }
        if (!selected.topics.length) panel.append(element('p', 'pf-empty', {
            published: 'No published topics yet.', favorites: 'No favorited topics yet.', configured: 'No configured topics yet.'
        }[selected.key] || 'No topics yet.'));
    };
    for (const tab of tabs) {
        const button = element('button', '', tab.label); button.type = 'button'; button.id = `profile-tab-${tab.key}`;
        button.dataset.key = tab.key; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', panel.id);
        if (tab.private) { button.append(icon('lock')); button.setAttribute('aria-label', `${tab.label}, only you`); }
        button.addEventListener('click', () => selectTab(tab));
        button.addEventListener('keydown', event => {
            const index = tabs.indexOf(tab);
            const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft'
                ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
            if (next === null) return;
            event.preventDefault(); tablist.children[next].click(); tablist.children[next].focus();
        });
        tablist.append(button);
    }
    tablist.hidden = panel.hidden = false;
    selectTab(tabs[0]);
}

listenAccountChange(() => {
    blocked = true; pageAccountWriteScope.invalidate();
    cards.forEach(card => card.dispose?.()); cards = [];
    panel.replaceChildren(); tablist.replaceChildren(); identity.replaceChildren();
    panel.hidden = tablist.hidden = identity.hidden = true;
    status.textContent = 'Your account changed. Refresh to view this profile.';
});

const query = location.pathname === '/me' ? { self: true } : { publicID: decodeURIComponent(location.pathname.slice(2)) };
postJSON('/api/get_public_profile', query, { timeoutMs: 20000, requireJSON: true }).then(renderProfile)
    .catch(error => showFailure(status, error, 'This profile could not be loaded. Refresh to try again.'));
