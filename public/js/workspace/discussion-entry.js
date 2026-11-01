import { postJSON } from '../shared/http.js';

export function categoryDiscussionURL(categoryID, contextValues, benchmarkID = null, conditionID = null) {
    const params = new URLSearchParams({ discussion: '1', categoryID: String(categoryID) });
    for (const [key, value] of Object.entries(contextValues)) params.set(key === 'scene' ? key : `context_${key}`, value);
    if (benchmarkID !== null) params.set('benchmarkID', String(benchmarkID));
    if (conditionID !== null) params.set('conditionID', String(conditionID));
    return `${window.location.pathname}?${params}`;
}

function renderDiscussionEntry(element) {
    const count = element.querySelector('[data-discussion-count]');
    const benchmarkOpen = element.dataset.benchmarkDiscussionOpen === 'true';
    const total = element.dataset.discussionCount;
    count.textContent = benchmarkOpen ? 'Category discussion' : total === undefined ? 'Discussions'
        : `${total} discussion${Number(total) === 1 ? '' : 's'}`;
    element.dataset.tooltip = benchmarkOpen ? 'Open topic discussion' : 'Discussions in this topic or scene';
}

export function setDiscussionEntryView(element, benchmarkOpen) {
    if (!element) return;
    element.dataset.benchmarkDiscussionOpen = String(benchmarkOpen);
    renderDiscussionEntry(element);
}

export function createDiscussionEntry(element) {
    let lastContext = null;
    let sequence = 0;
    let current = null;
    let fetchedAt = 0;
    const update = async (categoryID, contextValues, isPrivate = false) => {
        if (!element) return;
        element.hidden = isPrivate;
        if (isPrivate) {
            ++sequence; current = null; lastContext = null;
            delete element.dataset.discussionCount;
            window.dispatchEvent(new CustomEvent('benchpoll:discussion-context', { detail: { categoryID, contextValues, isPrivate } }));
            return;
        }
        contextValues = { ...contextValues };
        current = { categoryID, contextValues, isPrivate };
        window.dispatchEvent(new CustomEvent('benchpoll:discussion-context', { detail: current }));
        element.href = categoryDiscussionURL(categoryID, contextValues);
        renderDiscussionEntry(element);
        const contextKey = JSON.stringify([categoryID, Object.entries(contextValues).sort(([a], [b]) => a.localeCompare(b))]);
        if (lastContext === contextKey && Date.now() - fetchedAt < 60000) return;
        lastContext = contextKey;
        fetchedAt = Date.now();
        const request = ++sequence;
        delete element.dataset.discussionCount;
        renderDiscussionEntry(element);
        try {
            const data = await postJSON('/api/get_discussion_summary', { categoryID, contextValues });
            if (request !== sequence) return;
            element.dataset.discussionCount = String(data.count);
            renderDiscussionEntry(element);
        } catch {
            if (request !== sequence) return;
            lastContext = null;
        }
    };
    window.addEventListener('focus', () => {
        if (current) { lastContext = null; update(current.categoryID, current.contextValues); }
    });
    window.addEventListener('benchpoll:discussion-posted', () => {
        if (current) { lastContext = null; update(current.categoryID, current.contextValues); }
    });
    return update;
}
