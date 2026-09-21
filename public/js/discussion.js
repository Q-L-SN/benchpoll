import { postJSON } from './shared/http.js';
import { loginWithGitHub } from './global.js';
import { buildContributionURL } from './shared/contribution-navigation.js?v=clean-20260908';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const state = { categoryID: params.has('categoryID') ? Number(params.get('categoryID')) : null,
    contextValues: Object.fromEntries([...params].filter(([key]) => key.startsWith('context_')).map(([key, value]) => [key.slice(8), value])),
    benchmarkID: params.has('benchmarkID') ? Number(params.get('benchmarkID')) : null,
    threadID: params.has('threadID') ? Number(params.get('threadID')) : null,
    contextID: null, sort: 'hot', allCategories: false, offset: 0, mentions: [], authenticated: false };
let loadSequence = 0;
let mentionSequence = 0;
let mentionIndex = 0;
let mentionMatches = [];
let mentionStart = null;
let loading = false;
const text = $('discussion-text');
const panel = $('discussion-panel');
const sidebar = document.querySelector('.bp-shell > .bp-sidebar');
const brand = sidebar.querySelector('.bp-brand');
const workspace = document.querySelector('.bp-workspace');
const mobile = window.matchMedia('(max-width: 760px)');
const drafts = new Map();
let isOpen = false;
let returnFocus = null;
let workspaceScrollY = 0;
let workspaceContext = null;
const draftKey = () => `${state.categoryID}:${state.threadID ?? 'new'}:${JSON.stringify(state.contextValues)}`;
function saveDraft() {
    drafts.set(draftKey(), { text: text.value, mentions: structuredClone(state.mentions) });
}
function restoreDraft() {
    const draft = drafts.get(draftKey());
    text.value = draft?.text || '';
    state.mentions = structuredClone(draft?.mentions || []);
    renderMentions();
}
function setComposerExpanded(expanded, focus = false) {
    $('discussion-compose-fields').hidden = !expanded;
    $('discussion-compose-toggle').setAttribute('aria-expanded', String(expanded));
    if (!expanded) closeSuggestions();
    if (focus) (expanded ? text : $('discussion-compose-toggle')).focus({ preventScroll: true });
}
function updatePanelAccess() {
    if (isOpen) (mobile.matches ? $('discussion-brand-slot') : $('workspace-brand-slot')).append(brand);
    else sidebar.prepend(brand);
    sidebar.inert = isOpen;
    sidebar.setAttribute('aria-hidden', String(isOpen));
    workspace.inert = isOpen && mobile.matches;
    panel.inert = !isOpen;
    panel.setAttribute('aria-hidden', String(!isOpen));
    panel.setAttribute('role', mobile.matches ? 'dialog' : 'complementary');
    if (mobile.matches) panel.setAttribute('aria-modal', String(isOpen));
    else panel.removeAttribute('aria-modal');
}
function closeDiscussion() {
    if (!isOpen) return;
    saveDraft();
    isOpen = false;
    document.body.classList.remove('discussion-open');
    $('discussion-entry').setAttribute('aria-expanded', 'false');
    updatePanelAccess();
    closeSuggestions();
    if (mobile.matches) window.scrollTo({ top: workspaceScrollY, behavior: 'instant' });
    (returnFocus?.isConnected ? returnFocus : $('discussion-entry')).focus({ preventScroll: true });
}
async function openDiscussion(url, trigger = null) {
    if (isOpen) saveDraft();
    const query = url.searchParams;
    state.categoryID = query.has('categoryID') ? Number(query.get('categoryID')) : workspaceContext?.categoryID ?? null;
    state.contextValues = Object.fromEntries([...query].filter(([key]) => key.startsWith('context_')).map(([key, value]) => [key.slice(8), value]));
    state.benchmarkID = query.has('benchmarkID') ? Number(query.get('benchmarkID')) : null;
    state.threadID = query.has('threadID') ? Number(query.get('threadID')) : null;
    state.contextID = null; state.allCategories = false;
    restoreDraft();
    setComposerExpanded(Boolean(state.threadID || text.value || state.mentions.length));
    if (!isOpen) {
        returnFocus = trigger || $('discussion-entry');
        workspaceScrollY = window.scrollY;
    }
    isOpen = true;
    document.body.classList.remove('taxonomy-open');
    $('taxonomy-toggle').setAttribute('aria-expanded', 'false');
    document.body.classList.add('discussion-open');
    $('discussion-entry').setAttribute('aria-expanded', 'true');
    updatePanelAccess();
    $('discussion-close').focus({ preventScroll: true });
    await load();
}
document.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (!link || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    const url = new URL(link.href);
    if (url.origin !== location.origin || url.searchParams.get('discussion') !== '1') return;
    event.preventDefault();
    openDiscussion(url, link);
}, { capture: true });
window.addEventListener('benchpoll:discussion-context', event => {
    const next = event.detail;
    const changed = workspaceContext && JSON.stringify(workspaceContext) !== JSON.stringify(next);
    const initialContext = !workspaceContext && isOpen && !state.threadID
        && (state.categoryID === null || Number(state.categoryID) === Number(next.categoryID));
    workspaceContext = next;
    if ((changed || initialContext) && isOpen) {
        const url = new URL(location.href);
        url.search = new URLSearchParams({ discussion: '1', categoryID: String(next.categoryID),
            ...Object.fromEntries(Object.entries(next.contextValues).map(([key, value]) => [`context_${key}`, value])) });
        if (initialContext && state.benchmarkID) url.searchParams.set('benchmarkID', state.benchmarkID);
        openDiscussion(url);
    }
});
const errors = {
    discussion_post_cooldown: 'Please wait 30 seconds between messages.',
    discussion_daily_limit: 'You have reached the daily message limit. Please try again tomorrow.',
    discussion_self_vote: 'You cannot vote on your own message.',
    discussion_post_unavailable: 'This discussion is unavailable or has been hidden by a reviewer.',
    discussion_parent_unavailable: 'This thread is no longer available.',
    authentication_required: 'Please log in to participate.',
    discussion_text_length: 'Write between 2 and 4,000 characters.',
    discussion_benchmark_unavailable: 'A referenced benchmark is no longer available. Remove it and try again.',
    discussion_condition_unavailable: 'A referenced condition is no longer available. Remove it and try again.'
};
function showError(error) {
    $('discussion-error').hidden = false;
    $('discussion-error').textContent = errors[error.message] || 'Could not complete the request. Please try again.';
}
function node(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = content;
    return element;
}
function contextLabel(values) {
    return Object.entries(values).map(([key, value]) => `${key.replaceAll('_', ' ')}: ${value}`).join(' / ') || 'Default context';
}
function discussionURL(extra = {}) {
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set('discussion', '1');
    if (state.categoryID) url.searchParams.set('categoryID', state.categoryID);
    Object.entries(state.contextValues).forEach(([key, value]) => url.searchParams.set(`context_${key}`, value));
    Object.entries(extra).forEach(([key, value]) => { if (value != null) url.searchParams.set(key, value); });
    return url.pathname + url.search;
}
function renderPost(post, isRoot = false) {
    const article = node('article', 'discussion-post');
    article.id = `post-${post.ID}`;
    const meta = node('div', 'discussion-post-meta');
    const time = node('time', '', new Date(post.createdAt).toLocaleString());
    time.dateTime = new Date(post.createdAt).toISOString();
    meta.append(node('strong', '', post.authorName), time,
        node('span', 'discussion-context-badge', `${state.allCategories ? `${post.categoryName} / ` : ''}${contextLabel(post.contextValues)}`));
    const mentions = node('div', 'discussion-mentions');
    for (const mention of post.mentions) {
        const link = node('a', '', `@${mention.label}`);
        if (mention.benchmarkID) link.href = discussionURL({ benchmarkID: mention.benchmarkID });
        mentions.append(link);
    }
    const actions = node('div', 'discussion-post-actions');
    for (const [value, count, icon, label] of [[1, post.upvotes, 'fa-thumbs-up', 'Like'], [-1, post.downvotes, 'fa-thumbs-down', 'Dislike']]) {
        const button = node('button');
        button.type = 'button';
        button.setAttribute('aria-label', `${label} post ${post.ID}: ${count}`);
        button.setAttribute('aria-pressed', String(post.myVote === value));
        button.title = label;
        button.append(node('i', `fa-regular ${icon}`), document.createTextNode(` ${count}`));
        button.disabled = post.isOwn || post.isDeleted;
        button.addEventListener('click', async () => {
            if (!state.authenticated) { loginWithGitHub(); return; }
            button.disabled = true;
            try { await postJSON('/api/vote_discussion', { postID: post.ID, value: post.myVote === value ? 0 : value }); await load(false); }
            catch (error) { showError(error); button.disabled = false; }
        });
        actions.append(button);
    }
    if (post.parentID === null && !isRoot) {
        const reply = node('a', '', `${post.replyCount} replies`);
        reply.href = discussionURL({ threadID: post.ID });
        actions.append(reply);
    }
    const permalink = node('a', '', `#${post.ID}`);
    permalink.href = discussionURL({ threadID: post.ID });
    permalink.title = 'Link to this message';
    const report = node('a', 'discussion-report');
    report.href = buildContributionURL('report', { postID: post.ID });
    report.title = 'Report this message';
    report.setAttribute('aria-label', `Report post ${post.ID}`);
    report.append(node('i', 'fa-regular fa-flag'));
    actions.append(permalink);
    if (!post.isDeleted) actions.append(report);
    if (post.isDeleted) actions.querySelectorAll('button').forEach(button => button.remove());
    if (post.isOwn && !post.isDeleted) {
        const remove = node('button', 'discussion-delete');
        remove.type = 'button'; remove.title = 'Delete your message'; remove.setAttribute('aria-label', remove.title);
        remove.innerHTML = '<i class="fa-regular fa-trash-can" aria-hidden="true"></i>';
        remove.addEventListener('click', () => {
            if (article.querySelector('.discussion-delete-confirm')) return;
            const confirmation = node('div', 'discussion-delete-confirm');
            confirmation.setAttribute('role', 'group'); confirmation.setAttribute('aria-label', 'Confirm deletion');
            confirmation.append(node('p', '', 'Delete this message? Other people\'s replies will stay.'));
            const cancel = node('button', '', 'Cancel'), confirm = node('button', '', 'Delete');
            cancel.type = confirm.type = 'button';
            cancel.addEventListener('click', () => { confirmation.remove(); remove.focus(); });
            confirm.addEventListener('click', async () => {
                confirm.disabled = cancel.disabled = true;
                try {
                    await postJSON('/api/delete_discussion_post', { postID: post.ID });
                    window.dispatchEvent(new CustomEvent('benchpoll:discussion-posted'));
                    await load();
                } catch (error) { showError(error); confirm.disabled = cancel.disabled = false; }
            });
            confirmation.append(cancel, confirm); article.append(confirmation); cancel.focus();
        });
        actions.append(remove);
    }
    article.append(meta, node('p', 'discussion-post-body', post.isDeleted ? 'This message was deleted by its author.' : post.text), mentions, actions);
    return article;
}
function renderContext(data) {
    state.categoryID = Number(data.context.categoryID);
    state.contextValues = { ...data.context.contextValues };
    $('category-path').textContent = data.context.categoryPath.replaceAll('/', ' / ');
    $('posting-context').replaceChildren();
    if (data.root) {
        state.threadID = data.root.ID;
        $('posting-context').textContent = contextLabel(data.root.contextValues);
    } else for (const dimension of data.context.dimensions) {
        const label = node('label', '', dimension.name);
        const select = node('select');
        for (const option of dimension.options) {
            const item = node('option', '', option.name); item.value = option.key; select.append(item);
        }
        select.value = dimension.selectedKey;
        select.addEventListener('change', () => { state.contextValues[dimension.key] = select.value; });
        label.append(select); $('posting-context').append(label);
    }
    const filter = $('discussion-context');
    filter.replaceChildren(new window.Option('All contexts', ''));
    data.contexts.forEach(context => filter.append(new window.Option(contextLabel(context.values), String(context.ID))));
    filter.value = state.contextID == null ? '' : String(state.contextID);
    $('context-filter-label').hidden = Boolean(state.threadID || state.allCategories);
    document.querySelector('.discussion-sort').hidden = Boolean(state.threadID);
    $('scope-filter-label').hidden = !state.benchmarkID || Boolean(state.threadID);
    $('clear-benchmark').hidden = !state.benchmarkID || Boolean(state.threadID);
    $('clear-benchmark').textContent = 'Clear benchmark filter';
    $('all-threads').hidden = !state.threadID;
    $('all-threads').href = discussionURL();
    $('composer-title').textContent = state.threadID ? 'Write a reply' : 'Write a message';
    $('post-discussion').textContent = state.authenticated ? (state.threadID ? 'Post reply' : 'Post message') : 'Log in to participate';
}
async function load(append = false) {
    const sequence = ++loadSequence;
    loading = true;
    $('discussion-more').disabled = true;
    $('discussion-error').hidden = true;
    try {
        const data = await postJSON('/api/get_discussion', { categoryID: state.categoryID, contextValues: state.contextValues,
            threadID: state.threadID, benchmarkID: state.benchmarkID, contextID: state.contextID, sort: state.sort,
            allCategories: state.allCategories, offset: append ? state.offset : 0 });
        if (sequence !== loadSequence) return;
        state.authenticated = data.authenticated;
        renderContext(data);
        const feed = $('discussion-feed');
        if (!append) { feed.replaceChildren(); state.offset = 0; }
        $('thread-root').replaceChildren(...(data.root ? [renderPost(data.root, true)] : []));
        data.posts.forEach(post => { if (!$( `post-${post.ID}`)) feed.append(renderPost(post)); });
        state.offset += data.posts.length;
        if (!data.total) feed.append(node('p', 'discussion-empty', state.threadID ? 'No replies yet. Add your perspective.' : 'No discussions yet. Start with a benchmark you trust, or one you question.'));
        $('discussion-more').hidden = !data.hasMore;
    } catch (error) {
        if (sequence === loadSequence) {
            showError(error);
            if (error.status === 404) { $('thread-root').replaceChildren(); $('discussion-feed').replaceChildren(); }
        }
    }
    finally { if (sequence === loadSequence) { loading = false; $('discussion-more').disabled = false; } }
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
function closeSuggestions() { mentionSequence++; $('mention-suggestions').hidden = true; text.removeAttribute('aria-activedescendant'); }
function selectMention(index) {
    const selected = mentionMatches[index];
    if (!selected) return;
    const currentMatch = text.value.slice(0, text.selectionStart).match(/(?:^|\s)@([^@\n]{0,128})$/);
    if (!currentMatch) { closeSuggestions(); return; }
    mentionStart = text.selectionStart - currentMatch[1].length - 1;
    if (state.mentions.length >= 10) { $('composer-status').textContent = 'You can reference up to 10 benchmarks.'; return; }
    const label = selected.conditionName.toLowerCase() === 'default' ? selected.name : `${selected.name} (${selected.conditionName})`;
    if (!state.mentions.some(item => item.conditionID === Number(selected.conditionID))) state.mentions.push({ benchmarkID: Number(selected.benchmarkID), conditionID: Number(selected.conditionID), label });
    if (mentionStart !== null) text.setRangeText(`@${label} `, mentionStart, text.selectionStart, 'end');
    renderMentions(); closeSuggestions(); text.focus();
}
async function suggest() {
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
            const button = node('button', '', item.conditionName.toLowerCase() === 'default' ? item.name : `${item.name} (${item.conditionName})`);
            button.type = 'button'; button.id = `mention-option-${index}`; button.setAttribute('role', 'option');
            button.setAttribute('aria-selected', String(index === 0));
            button.addEventListener('mousedown', event => event.preventDefault());
            button.addEventListener('click', () => selectMention(index)); panel.append(button);
        });
    } catch (error) { if (sequence === mentionSequence) showError(error); }
}
text.addEventListener('input', suggest);
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
    const button = $('post-discussion'); button.disabled = true;
    const submittedDraft = draftKey();
    try {
        const result = await postJSON('/api/create_discussion_post', { categoryID: state.categoryID, contextValues: state.contextValues,
            text: text.value, parentID: state.threadID, mentions: state.mentions.map(({ benchmarkID, conditionID }) => ({ benchmarkID, conditionID })) });
        window.dispatchEvent(new CustomEvent('benchpoll:discussion-posted'));
        drafts.delete(submittedDraft);
        if (draftKey() !== submittedDraft) return;
        text.value = ''; state.mentions = []; renderMentions();
        $('composer-status').textContent = 'Posted.';
        setComposerExpanded(false, true);
        if (!state.threadID && state.benchmarkID) state.benchmarkID = null;
        state.sort = 'new';
        document.querySelectorAll('[data-sort]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.sort === state.sort)));
        await load();
        $(`post-${result.ID}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (error) { showError(error); }
    finally { button.disabled = false; }
});
$('post-discussion').addEventListener('click', event => { if (!state.authenticated) { event.preventDefault(); loginWithGitHub(); } });
document.querySelectorAll('[data-sort]').forEach(button => button.addEventListener('click', () => {
    state.sort = button.dataset.sort;
    document.querySelectorAll('[data-sort]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    load();
}));
$('discussion-context').addEventListener('change', event => { state.contextID = event.target.value ? Number(event.target.value) : null; load(); });
$('discussion-all-categories').addEventListener('change', event => { state.allCategories = event.target.checked; state.contextID = null; load(); });
$('clear-benchmark').addEventListener('click', () => { state.benchmarkID = null; state.allCategories = false; load(); });
$('discussion-more').addEventListener('click', () => { if (!loading) load(true); });
$('discussion-close').addEventListener('click', closeDiscussion);
$('discussion-compose-toggle').addEventListener('click', () => setComposerExpanded($('discussion-compose-fields').hidden, true));
mobile.addEventListener('change', updatePanelAccess);
window.addEventListener('keydown', event => {
    if (!isOpen || event.defaultPrevented || !panel.contains(document.activeElement)) return;
    if (event.key === 'Escape') { event.preventDefault(); closeDiscussion(); }
    if (event.key === 'Tab' && mobile.matches) {
        const focusable = [...panel.querySelectorAll('a[href], button:not(:disabled), textarea, select, input')].filter(element => element.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
});
window.addEventListener('beforeunload', event => {
    saveDraft();
    if ([...drafts.values()].some(draft => draft.text.trim() || draft.mentions.length)) { event.preventDefault(); event.returnValue = ''; }
});
async function profile() {
    if (!isOpen) return;
    try {
        const user = await postJSON('/api/get_user_profile', {});
        state.authenticated = Boolean(user);
        $('post-discussion').textContent = user ? (state.threadID ? 'Post reply' : 'Post message') : 'Log in to participate';
    } catch (error) { showError(error); }
}
window.addEventListener('focus', profile);
window.addEventListener('storage', profile);
updatePanelAccess();
if (params.get('discussion') === '1') await openDiscussion(new URL(location.href));
