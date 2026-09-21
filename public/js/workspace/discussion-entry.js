import { postJSON } from '../shared/http.js';

export function categoryDiscussionURL(categoryID, contextValues, benchmarkID = null) {
    const params = new URLSearchParams({ discussion: '1', categoryID: String(categoryID) });
    for (const [key, value] of Object.entries(contextValues)) params.set(`context_${key}`, value);
    if (benchmarkID !== null) params.set('benchmarkID', String(benchmarkID));
    return `${window.location.pathname}?${params}`;
}

export function createDiscussionEntry(element) {
    let lastCategory = null;
    let sequence = 0;
    let current = null;
    let fetchedAt = 0;
    const update = async (categoryID, contextValues) => {
        if (!element) return;
        current = { categoryID, contextValues };
        window.dispatchEvent(new CustomEvent('benchpoll:discussion-context', { detail: current }));
        element.href = categoryDiscussionURL(categoryID, contextValues);
        if (lastCategory === categoryID && Date.now() - fetchedAt < 60000) return;
        lastCategory = categoryID;
        fetchedAt = Date.now();
        const request = ++sequence;
        const count = element.querySelector('[data-discussion-count]');
        count.textContent = 'Discussions';
        try {
            const data = await postJSON('/api/get_discussion_summary', { categoryID });
            if (request !== sequence) return;
            count.textContent = `${data.count} discussion${data.count === 1 ? '' : 's'}`;
        } catch {
            if (request !== sequence) return;
            lastCategory = null;
        }
    };
    window.addEventListener('focus', () => {
        if (current) { lastCategory = null; update(current.categoryID, current.contextValues); }
    });
    window.addEventListener('benchpoll:discussion-posted', () => {
        if (current) { lastCategory = null; update(current.categoryID, current.contextValues); }
    });
    return update;
}
