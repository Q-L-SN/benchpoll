import { postJSON } from './http.js';
import { pageAccountWriteScope } from './account-identity.js';
import { openSignIn, listenAccountChange } from './sign-in.js';
import { setLoading } from './loading.js';
import { createAction } from './ui-components.js';
import { buildContributionURL } from './contribution-navigation.js';
import { relativeDateAge } from './relative-date.js';

export function mountProposalDiscussion(proposalID) {
    const $ = name => document.getElementById('proposal-discussion-' + name);
    const feed = $('feed'), status = $('status'), textarea = $('text'), form = $('form');
    const node = (tag, text, className = '') => { const value = document.createElement(tag); value.textContent = text; value.className = className; return value; };
    const options = { timeoutMs: 30000, requireJSON: true };
    const drafts = new Map();
    let threadID = new URL(location.href).searchParams.get('threadID'), offset = 0;
    let sequence = 0, authenticated = false, blocked = false, busy = false, reading = false;
    const errors = { topic_proposal_not_found: 'This proposal is no longer available.',
        discussion_post_unavailable: 'This message is no longer available.',
        discussion_post_cooldown: 'Please wait 30 seconds between messages.',
        discussion_daily_limit: 'You have reached today’s message limit.',
        discussion_self_vote: 'You cannot vote on your own message.' };
    const message = error => errors[error.payload?.error] ?? error.message ?? 'Could not load the discussion. Try again.';
    const urlFor = thread => `/topic-proposals/${proposalID}/preview${thread ? '?threadID=' + thread : ''}#discussion`;
    $('back').href = urlFor(null);
    function syncControls() {
        $('submit').disabled = busy || blocked;
        textarea.disabled = busy || blocked;
        $('submit').textContent = authenticated ? threadID ? 'Post reply' : 'Post message' : 'Sign in to participate';
        $('label').textContent = threadID ? 'Write a reply' : 'Write a message';
        $('back').hidden = !threadID;
        $('sort').hidden = Boolean(threadID);
        $('sort').disabled = busy;
        feed.querySelectorAll('button').forEach(button => { button.disabled = busy || blocked; });
    }
    async function write(path, body) {
        if (blocked) throw new Error('Your account changed. Refresh before posting.');
        if (!authenticated) { openSignIn(); return null; }
        return pageAccountWriteScope.write((url, payload) => postJSON(url, payload, options), path, body);
    }
    async function mutate(path, body) {
        if (busy) return;
        busy = true; syncControls(); status.textContent = '';
        try { if (await write(path, body)) await load(); }
        catch (error) { status.textContent = message(error); }
        finally { busy = false; syncControls(); }
    }
    function renderPost(post, root = false) {
        const article = node('article', '', 'pp-discussion-post'); article.id = 'proposal-post-' + post.ID;
        const meta = node('header', '', 'pp-discussion-meta');
        const time = node('time', relativeDateAge(post.createdAt)); time.dateTime = post.createdAt;
        meta.append(node('strong', post.authorName), time);
        article.append(meta, node('p', post.isDeleted ? 'Message deleted.' : post.text, 'pp-discussion-body'));
        const actions = node('div', '', 'pp-discussion-actions');
        if (!post.isDeleted) {
            for (const [value, icon, label, count] of [[1, 'fa-thumbs-up', 'Upvote', post.upvotes], [-1, 'fa-thumbs-down', 'Downvote', post.downvotes]]) {
                const vote = createAction({ label: `${label} (${count})`, icon: 'fa-regular ' + icon });
                vote.setAttribute('aria-pressed', String(post.myVote === value));
                vote.addEventListener('click', () => void mutate('/api/vote_discussion', { postID: post.ID, value: post.myVote === value ? 0 : value }));
                actions.append(vote);
            }
            const report = createAction({ label: 'Report message', icon: 'fa-regular fa-flag', iconOnly: true,
                href: buildContributionURL('report', { postID: post.ID, pageURL: urlFor(post.parentID ?? post.ID) }) });
            actions.append(report);
            if (post.isOwn) {
                const remove = createAction({ label: 'Delete message', icon: 'fa-regular fa-trash-can', iconOnly: true });
                remove.addEventListener('click', () => {
                    if (window.confirm('Delete your message? Replies will remain.')) void mutate('/api/delete_discussion_post', { postID: post.ID });
                }); actions.append(remove);
            }
        }
        if (!threadID && !root) {
            const replies = createAction({ label: `${post.replyCount} replies`, icon: 'fa-regular fa-comment', href: urlFor(post.ID) });
            replies.addEventListener('click', event => {
                if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                event.preventDefault(); void navigate(post.ID);
            }); actions.append(replies);
        }
        article.append(actions); return article;
    }
    async function load(append = false) {
        const request = ++sequence; reading = true; $('more').disabled = true;
        feed.setAttribute('aria-busy', 'true'); setLoading(status, 'Loading discussion');
        try {
            const data = await postJSON('/api/get_discussion', { proposalID, threadID: threadID ? Number(threadID) : null,
                sort: $('sort').value, offset: append ? offset : 0 }, options);
            if (request !== sequence || blocked) return;
            pageAccountWriteScope.bind(data.authenticated ? data.userID : null); authenticated = data.authenticated;
            if (!append) {
                feed.replaceChildren(); offset = 0;
                if (data.root) { threadID = data.root.ID; feed.append(renderPost(data.root, true), node('h3', 'Replies')); }
            }
            for (const post of data.posts) if (!document.getElementById('proposal-post-' + post.ID)) feed.append(renderPost(post));
            offset += data.posts.length;
            if (!feed.children.length) feed.append(node('p', threadID ? 'No replies yet.' : 'No discussions yet. Share your perspective.', 'pp-note'));
            status.textContent = ''; $('more').hidden = !data.hasMore; $('more').textContent = 'Load more';
            if (location.hash === '#discussion' && !append) document.getElementById('discussion').scrollIntoView({ block: 'start', behavior: 'instant' });
        } catch (error) {
            if (request !== sequence) return;
            status.textContent = message(error); $('more').hidden = false; $('more').textContent = 'Retry';
            if (error.status === 404) { feed.replaceChildren(); form.hidden = true; }
        } finally { if (request === sequence) { reading = false; $('more').disabled = false; feed.setAttribute('aria-busy', 'false'); syncControls(); } }
    }
    async function navigate(thread, push = true) {
        if (busy) return;
        drafts.set(String(threadID ?? ''), textarea.value); threadID = thread;
        textarea.value = drafts.get(String(threadID ?? '')) ?? '';
        if (push) history.pushState({}, '', urlFor(thread));
        await load();
    }
    $('back').addEventListener('click', event => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); void navigate(null);
    });
    $('sort').addEventListener('change', () => void load());
    $('more').addEventListener('click', () => { if (!reading) void load($('more').textContent !== 'Retry'); });
    window.addEventListener('popstate', () => void navigate(new URL(location.href).searchParams.get('threadID'), false));
    form.addEventListener('submit', async event => {
        event.preventDefault(); if (busy || blocked) return;
        busy = true; syncControls(); status.textContent = '';
        try {
            const result = await write('/api/create_discussion_post', { proposalID, parentID: threadID ? Number(threadID) : null,
                text: textarea.value, mentions: [] });
            if (result) { textarea.value = ''; drafts.delete(String(threadID ?? '')); await load(); }
        } catch (error) { status.textContent = message(error); }
        finally { busy = false; syncControls(); }
    });
    listenAccountChange(() => {
        blocked = true; sequence++; drafts.clear(); textarea.value = ''; pageAccountWriteScope.invalidate();
        status.textContent = 'Your account changed. Refresh to continue this discussion.'; syncControls();
    });
    void load();
}
