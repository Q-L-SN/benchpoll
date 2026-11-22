import { postJSON, postWriteJSON } from './http.js';
import { pageAccountWriteScope } from './account-identity.js';
import { createToast } from './toast.js';
import { buildContributionURL, activateContributionURL } from './contribution-navigation.js';

export const FAVORITE_EVENT = 'benchpoll:topic-favorite';
const pending = new Map();
let errorToast;
const favoriteMessages = {
    authentication_required: 'Sign in to favorite a topic.',
    account_identity_required: 'Sign in to favorite a topic.',
    account_changed: 'Sign in again to update your favorites.',
    topic_not_found: 'This topic is no longer available.'
};

export async function writeTopicAction(path, body, requestKey) {
    pageAccountWriteScope.capture();
    const security = await postJSON('/api/get_privacy_status', {}, { timeoutMs: 15000, requireJSON: true });
    return pageAccountWriteScope.write((url, request) => postWriteJSON(url, request, { timeoutMs: 30000, requestKey }),
        path, { ...body, csrfToken: security.csrfToken });
}

export function setTopicVisibility(topic, isPublic) {
    return writeTopicAction('/api/set_topic_visibility', { categoryID: Number(topic.categoryID ?? topic.ID), isPublic,
        ...(topic.editRevision ? { expectedRevision: topic.editRevision } : {}) });
}

function favoriteDisplay(edit) {
    const { confirmed, desired } = edit;
    return { isFavorited: desired,
        favoriteCount: Math.max(0, confirmed.favoriteCount + Number(desired) - Number(confirmed.isFavorited)) };
}

function publishFavorite(categoryID, fields) {
    window.dispatchEvent(new CustomEvent(FAVORITE_EVENT, { detail: { categoryID, ...fields } }));
}

async function saveFavorite(categoryID, edit) {
    let failure;
    // Send absolute states in order. Intermediate clicks can cancel each other while a write is in flight.
    for (;;) {
        const requested = edit.desired;
        try {
            const result = await writeTopicAction('/api/set_topic_favorite', { categoryID, isFavorited: requested }, globalThis.crypto.randomUUID());
            if (result?.categoryID !== categoryID || result.isFavorited !== requested
                || !Number.isSafeInteger(result.favoriteCount) || result.favoriteCount < 0) throw new Error('Invalid favorite response');
            edit.confirmed = { isFavorited: result.isFavorited, favoriteCount: result.favoriteCount };
        } catch (error) {
            // A timed-out write may have reached the server. Send the newer choice explicitly.
            if (requested !== edit.desired) continue;
            failure = error;
            break;
        }
        if (requested === edit.desired) break;
        publishFavorite(categoryID, favoriteDisplay(edit));
    }
    pending.delete(categoryID);
    publishFavorite(categoryID, edit.confirmed);
    if (failure) {
        const message = favoriteMessages[failure.payload?.error ?? failure.code]
            ?? (failure.status === 401 ? favoriteMessages.authentication_required : 'Could not update your favorites. Please try again.');
        errorToast ??= createToast({ duration: 5500, iconClass: 'fa-circle-exclamation', avoid: document.querySelector('.bp-mobile-panels') });
        errorToast.show(message);
        edit.onError?.(failure, message);
    }
}

export function createFavoriteButton(topic, { onChange = () => {}, onError, className = '' } = {}) {
    const button = document.createElement('button'); button.type = 'button';
    button.className = `bp-topic-favorite ${className}`.trim();
    const icon = document.createElement('i'); icon.setAttribute('aria-hidden', 'true');
    const count = document.createElement('span'); count.className = 'bp-topic-favorite-count';
    button.append(icon, count);
    let current = { ...topic }, lastAnimation = null;
    const ID = Number(topic.categoryID ?? topic.ID);
    function render(update) {
        const edit = pending.get(ID);
        current = { ...current, ...update, ...(edit ? favoriteDisplay(edit) : {}) };
        const active = current.isFavorited === true;
        icon.className = active ? 'fa-solid fa-star' : 'fa-regular fa-star';
        count.textContent = Number(current.favoriteCount ?? 0).toLocaleString();
        button.setAttribute('aria-pressed', String(active));
        button.setAttribute('aria-label', `${active ? 'Remove favorite' : 'Favorite topic'} · ${count.textContent} favorites`);
        button.setAttribute('aria-busy', String(Boolean(edit)));
        button.dataset.tooltip = active ? 'Remove favorite' : 'Favorite topic';
    }
    const sync = event => {
        if (event.detail.categoryID !== ID) return;
        render(event.detail);
        onChange({ ...current });
    };
    window.addEventListener(FAVORITE_EVENT, sync);
    button.updateTopic = update => {
        render(update);
        if (pending.has(ID)) onChange({ ...current });
    };
    button.dispose = () => window.removeEventListener(FAVORITE_EVENT, sync);
    button.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation();
        lastAnimation?.cancel();
        if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
            lastAnimation = button.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }], { duration: 220 });
        }
        const existing = pending.get(ID);
        const confirmed = { isFavorited: current.isFavorited === true, favoriteCount: Number(current.favoriteCount ?? 0) };
        const edit = existing ?? { confirmed, desired: confirmed.isFavorited };
        edit.desired = !edit.desired;
        edit.onError = onError;
        pending.set(ID, edit);
        publishFavorite(ID, favoriteDisplay(edit));
        if (!existing) void saveFavorite(ID, edit);
    });
    render(topic); return button;
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
