import { createAction } from './ui-components.js';

export function choicePageWindow({ count, index = 0, pageSize, neighbors = 3 }) {
    const pages = Math.max(1, Math.ceil(count / pageSize));
    const current = Math.max(0, Math.min(pages - 1, index));
    return { current, pages, first: Math.max(0, current - neighbors), last: Math.min(pages - 1, current + neighbors),
        preloadThrough: (current + neighbors + 1) * pageSize };
}

const node = (tag, className) => {
    const element = document.createElement(tag); element.className = className; return element;
};

// A bounded page window and an automatically growing list share one rendering
// and loading contract. Only the page window is mounted in paged mode.
export function createChoicePager({ list, label, pageSize = 6, neighbors = 3,
    getKey, renderItem, onLoadMore, scrollRoot = null, onRender = () => {} }) {
    const element = node('div', 'bp-choice-pager');
    const viewport = node('div', 'bp-choice-viewport');
    const navigation = node('nav', 'bp-choice-pagination');
    navigation.setAttribute('aria-label', `${label} pages`);
    const previous = createAction({ className: 'bp-choice-page-arrow', label: `Previous ${label.toLowerCase()} page`,
        icon: 'fa-solid fa-chevron-up', iconOnly: true });
    const next = createAction({ className: 'bp-choice-page-arrow', label: `Next ${label.toLowerCase()} page`,
        icon: 'fa-solid fa-chevron-down', iconOnly: true });
    const position = node('span', 'bp-choice-page-position');
    position.setAttribute('role', 'status'); position.setAttribute('aria-live', 'polite');
    const sentinel = node('div', 'bp-choice-load-sentinel'); sentinel.setAttribute('aria-hidden', 'true');
    navigation.append(previous, position, next);
    viewport.append(list); element.append(viewport, navigation);
    let items = [], index = 0, mode = 'pages', visibleCount = pageSize * 2, active = false;
    let hasMore = false, loading = false, error = false, pending = false, atEnd = false, generation = 0;
    let cache = new Map();

    function render() {
        const focused = list.contains(document.activeElement) ? document.activeElement : null;
        const focusable = 'a[href], button, input, select, textarea, [tabindex]';
        let focusTarget = null;
        if (focused) for (const [key, entry] of cache) {
            if (entry.element.contains(focused)) {
                focusTarget = { key, root: entry.element === focused,
                    index: [...entry.element.querySelectorAll(focusable)].indexOf(focused) };
                break;
            }
        }
        const page = choicePageWindow({ count: items.length, index, pageSize, neighbors });
        index = page.current;
        element.dataset.mode = mode; element.dataset.page = String(index + 1);
        element.dataset.preloadPages = String(neighbors);
        navigation.hidden = mode !== 'pages';
        previous.disabled = index === 0;
        next.disabled = index === page.pages - 1 && (!hasMore || loading || Boolean(error));
        position.textContent = `${index + 1} / ${page.pages}${hasMore ? '+' : ''}`;
        position.setAttribute('aria-label', `Page ${index + 1} of ${page.pages}${hasMore ? ', more available' : ''}`);
        const mounted = new Map(), pages = [];
        const first = mode === 'pages' ? page.first : 0, last = mode === 'pages' ? page.last : 0;
        for (let pageIndex = first; pageIndex <= last; pageIndex++) {
            const section = node('div', 'bp-choice-page');
            section.setAttribute('role', 'presentation');
            section.dataset.page = String(pageIndex + 1);
            section.hidden = mode === 'pages' && pageIndex !== index;
            const start = mode === 'pages' ? pageIndex * pageSize : 0;
            const end = mode === 'pages' ? start + pageSize : visibleCount;
            for (const item of items.slice(start, end)) {
                const key = getKey(item), signature = JSON.stringify(item);
                const old = cache.get(key);
                const entry = old?.signature === signature ? old : { signature, element: renderItem(item) };
                mounted.set(key, entry); section.append(entry.element);
            }
            pages.push(section);
        }
        cache = mounted;
        list.replaceChildren(...pages);
        if (mode === 'continuous') list.append(sentinel);
        observer?.unobserve(sentinel); observer?.observe(sentinel);
        onRender();
        const replacement = cache.get(focusTarget?.key)?.element;
        const restore = focused?.isConnected ? focused : focusTarget?.root ? replacement
            : replacement?.querySelectorAll(focusable)[focusTarget?.index];
        if (restore && list.contains(restore) && !restore.closest('[hidden]')) restore.focus({ preventScroll: true });
        scheduleMore();
    }

    function needsMore() {
        if (!active || loading || error || pending) return false;
        if (mode === 'pages') return hasMore
            && items.length < choicePageWindow({ count: items.length, index, pageSize, neighbors }).preloadThrough;
        return atEnd && (visibleCount < items.length || hasMore);
    }
    function scheduleMore() {
        if (!needsMore()) return;
        if (mode === 'continuous' && visibleCount < items.length) {
            // Let layout and IntersectionObserver decide whether the newly
            // revealed batch still leaves the end of the list in view.
            atEnd = false; visibleCount += pageSize; render();
            return;
        }
        if (!onLoadMore) return;
        pending = true;
        const started = generation, count = items.length;
        Promise.resolve().then(() => {
            if (started === generation && active) return onLoadMore();
        }).catch(() => {}).finally(() => {
            if (started !== generation) return;
            pending = false;
            // A failed or suspended request must not become a retry loop.
            if (items.length > count) scheduleMore();
        });
    }

    const observer = typeof window.IntersectionObserver === 'function'
        ? new window.IntersectionObserver(entries => {
            atEnd = entries.some(entry => entry.isIntersecting);
            scheduleMore();
        }, { root: scrollRoot, rootMargin: '160px 0px' }) : null;
    observer?.observe(sentinel);
    async function goTo(target) {
        if (!active || target < 0) return;
        if (target * pageSize >= items.length && hasMore && !loading && !error && onLoadMore) {
            const started = generation;
            await onLoadMore();
            if (!active || started !== generation) return;
        }
        const nextIndex = choicePageWindow({ count: items.length, index: target, pageSize, neighbors }).current;
        if (nextIndex === index) return;
        const direction = Math.sign(nextIndex - index);
        index = nextIndex; render();
        if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            list.animate?.([{ transform: `translateY(${direction * 10}px)`, opacity: .65 }, { transform: 'translateY(0)', opacity: 1 }],
                { duration: 160, easing: 'ease-out' });
        }
    }
    previous.addEventListener('click', () => { void goTo(index - 1); });
    next.addEventListener('click', () => { void goTo(index + 1); });
    return { element, previous, next,
        setItems(nextItems, state = {}) {
            items = nextItems; hasMore = Boolean(state.hasMore); loading = Boolean(state.loading); error = Boolean(state.error);
            render();
        },
        setMode(value) {
            const nextMode = value === 'continuous' ? 'continuous' : 'pages';
            if (mode === nextMode) return;
            mode = nextMode; atEnd = false; visibleCount = pageSize * 2; render();
        },
        setActive(value) { active = value; if (active) scheduleMore(); },
        reset() { generation++; pending = false; index = 0; visibleCount = pageSize * 2; cache.clear(); render(); },
        destroy() { generation++; active = false; observer?.disconnect(); },
        goTo
    };
}
