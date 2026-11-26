import { postJSON } from './shared/http.js';
import { pageAccountWriteScope } from './shared/account-identity.js';
import { publicProfileID } from './shared/profile-identity.js';
import { publicGitHubURL } from './shared/topic-identity.js';
import { createTopicCard } from './shared/topic-card.js';
import { FAVORITE_EVENT } from './shared/topic-actions.js';
import { listenAccountChange } from './shared/sign-in.js';
import { parseTopicPath } from './shared/topics.js';
import { setLoading } from './shared/loading.js';
import { mountSegmentedControl } from './shared/ui-components.js';
import { element, icon, link, avatar, initializeProfileHeader, showFailure } from './shared/profile-page.js';
import { createPrivateTopicEditor } from './shared/private-topic-editor.js';

initializeProfileHeader();
const status = document.getElementById('profile-status');
const identity = document.getElementById('profile-identity');
const tablist = document.getElementById('profile-tabs');
const panel = document.getElementById('profile-topics');
let cards = [], blocked = false;
let discussionRequest = null;
let tabMotion = null;
let topicEditor = null;
const profileEvents = new globalThis.AbortController();

const tabAppearance = {
    created: ['Topics I created', 'layer-group'],
    published: ['Published', 'layer-group'],
    favorites: ['Favorites', 'star'],
    configured: ['Configured', 'sliders'],
    discussion: ['Discussion', 'comments']
};

function renderDiscussion(publicID) {
    const controller = new window.AbortController();
    discussionRequest = controller;
    const list = element('ul', 'pf-discussion-list');
    const feedback = element('p', 'pf-status');
    feedback.setAttribute('role', 'status');
    const more = element('button', 'pf-button', 'Load more');
    more.type = 'button';
    more.hidden = true;
    panel.append(list, feedback, more);
    let cursor = null;

    function renderPost(post) {
        if (!parseTopicPath(post.url)?.publicID) throw new Error('Invalid discussion link.');
        const item = element('li', 'pf-discussion-item');
        const meta = element('div', 'pf-discussion-meta');
        const topic = [post.categoryName, post.sceneName].filter(Boolean).join(' / ');
        const destination = link(post.url, topic, null, 'pf-discussion-link');
        destination.append(icon('arrow-right'));
        const date = new Date(post.createdAt);
        const time = element('time', '', date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
        time.dateTime = date.toISOString();
        meta.append(destination, element('span', 'pf-discussion-type', post.parentID === null ? 'Post' : 'Reply'), time);
        item.append(meta, element('p', 'pf-discussion-text', post.text));
        return item;
    }

    async function load() {
        more.disabled = true;
        feedback.classList.remove('is-error');
        setLoading(feedback, 'Loading discussion posts');
        try {
            const page = await postJSON('/api/get_profile_discussion', { publicID, ...(cursor ? { before: cursor } : {}) },
                { timeoutMs: 15000, requireJSON: true, signal: controller.signal });
            if (controller.signal.aborted) return;
            if (!Array.isArray(page?.posts)) throw new Error('Invalid discussion history.');
            list.append(...page.posts.map(renderPost));
            cursor = page.nextCursor;
            more.hidden = !cursor;
            more.textContent = 'Load more';
            feedback.textContent = list.children.length ? '' : 'No discussion posts yet.';
        } catch (error) {
            if (controller.signal.aborted) return;
            showFailure(feedback, error, 'Discussion posts could not be loaded.');
            more.textContent = 'Try again';
            more.hidden = false;
        } finally {
            more.disabled = false;
        }
    }
    more.addEventListener('click', load);
    void load();
}

function renderProfile(data) {
    if (blocked) return;
    const { profile, isSelf, viewerID } = data;
    if (!publicProfileID(profile?.publicID) || !Array.isArray(data.tabs)) throw new Error('Invalid profile.');
    const discussion = { key: 'discussion', label: 'Discussion' };
    const tabs = [...data.tabs, discussion];
    const ownFavorites = isSelf ? tabs.find(tab => tab.key === 'favorites') : null;
    let activeTab;
    if (viewerID !== null) pageAccountWriteScope.bind(viewerID);
    document.title = `${profile.userName} · BenchPoll`;
    const intro = element('div', 'pf-profile-intro');
    const heading = element('div', 'pf-profile-heading');
    const details = element('div');
    const name = element('h1', 'pf-name', profile.userName);
    name.id = 'profile-name';
    details.append(name, element('p', 'pf-handle', `@${profile.publicID}`));
    heading.append(avatar(profile), details);
    intro.append(heading);
    if (profile.bio) intro.append(element('p', 'pf-bio', profile.bio));
    const github = publicGitHubURL(profile.githubURL);
    if (github) {
        const external = link(github, 'GitHub', null, 'pf-github');
        const githubIcon = element('i', 'fa-brands fa-github'); githubIcon.setAttribute('aria-hidden', 'true');
        external.prepend(githubIcon);
        external.target = '_blank'; external.rel = 'noopener noreferrer nofollow'; external.referrerPolicy = 'no-referrer';
        intro.append(external);
    }
    identity.append(intro);
    if (isSelf) {
        const actions = element('nav', 'pf-own-actions'); actions.setAttribute('aria-label', 'Your profile');
        const createTopic = element('button', 'pf-button is-primary', 'Create topic');
        createTopic.type = 'button';
        createTopic.setAttribute('aria-haspopup', 'dialog');
        createTopic.prepend(icon('plus'));
        const created = tabs.find(tab => tab.key === 'created');
        topicEditor = createPrivateTopicEditor({
            onSaved(topic) {
                if (blocked) return;
                if (!created.topics.some(item => item.ID === topic.ID)) created.topics.push(topic);
                selectTab(created);
                status.textContent = topic.isPrivate ? `${topic.name} created.` : `${topic.name} published.`;
            }
        });
        createTopic.addEventListener('click', () => void topicEditor.open(null, createTopic));
        actions.append(createTopic, link('/me/history', 'History', 'clock-rotate-left'), link('/settings', 'Settings', 'gear'));
        identity.append(actions);
    }
    identity.hidden = false;
    status.textContent = '';
    const selectTab = selected => {
        activeTab = selected;
        for (const button of tablist.children) {
            const active = button.dataset.key === selected.key;
            button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
        }
        discussionRequest?.abort();
        discussionRequest = null;
        cards.forEach(card => card.dispose?.()); cards = [];
        panel.replaceChildren(); panel.setAttribute('aria-labelledby', `profile-tab-${selected.key}`);
        const showDiscussion = selected === discussion;
        panel.classList.toggle('pf-topics', !showDiscussion);
        panel.classList.toggle('pf-discussion', showDiscussion);
        const url = new URL(location.href);
        if (selected !== tabs[0] || url.searchParams.has('tab')) url.searchParams.set('tab', selected.key);
        if (url.href !== location.href) history.replaceState(history.state, '', url);
        if (showDiscussion) {
            renderDiscussion(profile.publicID);
            return;
        }
        if (selected.private) {
            const note = element('p', 'pf-collection-note pf-private-note', 'Only you can see this collection.');
            note.prepend(icon('lock')); panel.append(note);
        }
        const topics = selected === ownFavorites ? selected.topics.filter(topic => topic.isFavorited) : selected.topics;
        for (const topic of topics) {
            const card = createTopicCard(topic, { onError: (_error, message) => {
                status.textContent = viewerID === null ? 'Sign in to favorite a topic.' : message;
                if (viewerID === null) status.append(' ', link('/login', 'Sign in'));
            } });
            cards.push(card); panel.append(card);
        }
        if (!topics.length) panel.append(element('p', 'pf-empty', {
            created: 'You haven’t created any topics yet.', published: 'No published topics yet.',
            favorites: 'No favorited topics yet.', configured: 'No configured topics yet.'
        }[selected.key] || 'No topics yet.'));
    };
    window.addEventListener(FAVORITE_EVENT, ({ detail: { categoryID, isFavorited, favoriteCount } }) => {
        const matches = topic => Number(topic.categoryID ?? topic.ID) === categoryID;
        const previous = ownFavorites?.topics.find(matches);
        const wasListed = previous?.isFavorited === true;
        let source;
        for (const tab of data.tabs) for (const topic of tab.topics.filter(matches)) {
            Object.assign(topic, { isFavorited, favoriteCount });
            source = topic;
        }
        if (ownFavorites && source && isFavorited && !previous) ownFavorites.topics.push(source);
        if (ownFavorites && activeTab === ownFavorites && wasListed !== isFavorited) selectTab(ownFavorites);
    }, { signal: profileEvents.signal });
    for (const tab of tabs) {
        const [label, symbol] = tabAppearance[tab.key] ?? [tab.label, ''];
        const button = element('button'); button.type = 'button'; button.id = `profile-tab-${tab.key}`;
        if (symbol) {
            const glyph = icon(symbol);
            glyph.classList.add('pf-tab-glyph');
            button.append(glyph);
        }
        button.append(element('span', '', label));
        button.dataset.key = tab.key; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', panel.id);
        button.setAttribute('aria-label', tab.private ? `${tab.label}, only you` : tab.label);
        if (tab.private) button.append(icon('lock'));
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
    const requested = new URLSearchParams(location.search).get('tab');
    selectTab(tabs.find(tab => tab.key === requested) ?? tabs[0]);
    tabMotion = mountSegmentedControl(tablist);
}

listenAccountChange(() => {
    blocked = true; pageAccountWriteScope.invalidate();
    topicEditor?.close();
    profileEvents.abort();
    discussionRequest?.abort();
    discussionRequest = null;
    tabMotion?.destroy();
    cards.forEach(card => card.dispose?.()); cards = [];
    panel.replaceChildren(); tablist.replaceChildren(); identity.replaceChildren();
    panel.hidden = tablist.hidden = identity.hidden = true;
    status.textContent = 'Your account changed. Refresh to view this profile.';
});

const query = location.pathname === '/me' ? { self: true } : { publicID: decodeURIComponent(location.pathname.slice(2)) };
setLoading(status, 'Loading profile');
postJSON('/api/get_public_profile', query, { timeoutMs: 20000, requireJSON: true }).then(renderProfile)
    .catch(error => showFailure(status, error, 'This profile could not be loaded. Refresh to try again.'));
