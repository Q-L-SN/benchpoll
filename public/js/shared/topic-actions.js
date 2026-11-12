import { postJSON, postWriteJSON } from './http.js';
import { pageAccountWriteScope } from './account-identity.js';
import { buildContributionURL, activateContributionURL } from './contribution-navigation.js';

const FAVORITE_EVENT = 'benchpoll:topic-favorite';
const pending = new Map();
const favoriteMessages = {
    authentication_required: 'Sign in to favorite a topic.',
    account_identity_required: 'Sign in to favorite a topic.',
    account_changed: 'Your account changed. Refresh before saving.',
    topic_not_found: 'This topic is no longer available.'
};

export async function writeTopicAction(path, body) {
    pageAccountWriteScope.capture();
    const security = await postJSON('/api/get_privacy_status', {}, { timeoutMs: 15000, requireJSON: true });
    return pageAccountWriteScope.write((url, request) => postWriteJSON(url, request, { timeoutMs: 30000 }),
        path, { ...body, csrfToken: security.csrfToken });
}

export function setTopicVisibility(topic, isPublic) {
    return writeTopicAction('/api/set_topic_visibility', { categoryID: Number(topic.categoryID ?? topic.ID), isPublic,
        ...(topic.editRevision ? { expectedRevision: topic.editRevision } : {}) });
}

export function createFavoriteButton(topic, { onChange = () => {}, onError = () => {}, className = '' } = {}) {
    const button = document.createElement('button'); button.type = 'button';
    button.className = `bp-topic-favorite ${className}`.trim();
    const icon = document.createElement('i'); icon.setAttribute('aria-hidden', 'true');
    const count = document.createElement('span'); count.className = 'bp-topic-favorite-count';
    button.append(icon, count);
    let current = { ...topic }, lastAnimation = null;
    const ID = Number(topic.categoryID ?? topic.ID);
    function render(update) {
        current = { ...current, ...update };
        const active = current.isFavorited === true;
        icon.className = active ? 'fa-solid fa-star' : 'fa-regular fa-star';
        count.textContent = Number(current.favoriteCount ?? 0).toLocaleString();
        button.setAttribute('aria-pressed', String(active));
        button.setAttribute('aria-label', `${active ? 'Remove favorite' : 'Favorite topic'} · ${count.textContent} favorites`);
        button.setAttribute('aria-busy', String(pending.has(ID)));
        button.dataset.tooltip = active ? 'Remove favorite' : 'Favorite topic';
    }
    const broadcast = update => window.dispatchEvent(new CustomEvent(FAVORITE_EVENT, { detail: { categoryID: ID, ...update } }));
    const sync = event => {
        if (event.detail.categoryID !== ID) return;
        render(event.detail); onChange({ ...current });
    };
    window.addEventListener(FAVORITE_EVENT, sync);
    button.updateTopic = update => render(update);
    button.dispose = () => window.removeEventListener(FAVORITE_EVENT, sync);
    button.addEventListener('click', async event => {
        event.preventDefault(); event.stopPropagation();
        lastAnimation?.cancel();
        if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
            lastAnimation = button.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }], { duration: 220 });
        }
        // Leave the button interactive so every click receives feedback, but
        // serialize mutations for all on-page instances of the same topic.
        if (pending.has(ID)) return;
        const before = { isFavorited: current.isFavorited === true, favoriteCount: Number(current.favoriteCount ?? 0) };
        const isFavorited = !before.isFavorited;
        const operation = writeTopicAction('/api/set_topic_favorite', { categoryID: ID, isFavorited });
        pending.set(ID, operation);
        broadcast({ isFavorited, favoriteCount: Math.max(0, before.favoriteCount + (isFavorited ? 1 : -1)) });
        try {
            const result = await operation;
            if (result.categoryID !== ID || typeof result.isFavorited !== 'boolean'
                || !Number.isSafeInteger(result.favoriteCount) || result.favoriteCount < 0) throw new Error('Favorite could not be confirmed.');
            broadcast(result);
        } catch (error) {
            broadcast(before);
            const message = favoriteMessages[error.payload?.error ?? error.code] ?? error.message ?? 'Could not update this favorite.';
            button.dataset.tooltip = message;
            button.setAttribute('aria-label', message);
            onError(error, message);
        } finally {
            pending.delete(ID); button.setAttribute('aria-busy', 'false');
            broadcast({ isFavorited: current.isFavorited, favoriteCount: current.favoriteCount });
        }
    });
    render(current); return button;
}

export function createConfiguredIndicator(topic) {
    const dot = document.createElement('span'); dot.className = 'bp-topic-configured-dot';
    dot.hidden = topic.configured !== true;
    dot.setAttribute('role', 'img');
    const context = topic.configuredPersonalContext?.name;
    const label = context ? `Your saved configuration: ${context}` : 'You have saved weights for this topic';
    dot.setAttribute('aria-label', label); dot.dataset.tooltip = label;
    return dot;
}

export function createTopicReportButton(topic, { scene = null, className = '' } = {}) {
    const link = document.createElement('a');
    link.className = `bp-topic-report ${className}`.trim();
    link.href = buildContributionURL('topic_report', {
        targetCategoryID: Number(topic.categoryID ?? topic.ID),
        targetName: topic.categoryName ?? topic.name,
        targetKind: 'category',
        pageURL: new URL(scene?.url ?? topic.url ?? topic.path, location.origin).href
    });
    link.setAttribute('aria-label', 'Report this topic');
    link.dataset.tooltip = 'Report this topic';
    const icon = document.createElement('i');
    icon.className = 'fa-regular fa-flag'; icon.setAttribute('aria-hidden', 'true');
    link.append(icon);
    for (const eventName of ['click', 'auxclick', 'contextmenu']) link.addEventListener(eventName, event => {
        activateContributionURL(link.href);
        event.stopPropagation();
    });
    return link;
}
