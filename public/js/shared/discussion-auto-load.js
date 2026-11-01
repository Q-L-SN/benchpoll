const PREFETCH_PX = 160;

export function isDiscussionSentinelNear(root, sentinel, margin = PREFETCH_PX) {
    if (!root || !sentinel || sentinel.hidden || !root.contains(sentinel) || root.clientHeight <= 0
        || !root.getClientRects().length || !sentinel.getClientRects().length) return false;
    const bounds = root.getBoundingClientRect(), target = sentinel.getBoundingClientRect();
    const view = root.ownerDocument.defaultView;
    const top = Math.max(0, bounds.top + root.clientTop);
    const bottom = Math.min(view.innerHeight, bounds.top + root.clientTop + root.clientHeight);
    return bottom > top && bounds.right > 0 && bounds.left < view.innerWidth
        && target.right > bounds.left && target.left < bounds.right
        && target.bottom >= top && target.top <= bottom + margin;
}

export function createDiscussionAutoLoader({ root, sentinel, canLoad, loadMore }) {
    const view = root?.ownerDocument.defaultView;
    let active = false, frame = null;
    const refresh = () => {
        if (!active || frame !== null) return;
        frame = view.requestAnimationFrame(() => {
            frame = null;
            // Observer records can be stale after an append or a view change.
            if (active && canLoad() && isDiscussionSentinelNear(root, sentinel)) void loadMore();
        });
    };
    const intersection = view?.IntersectionObserver ? new view.IntersectionObserver(refresh,
        { root, rootMargin: `0px 0px ${PREFETCH_PX}px 0px` }) : null;
    const resize = view?.ResizeObserver ? new view.ResizeObserver(refresh) : null;
    function setActive(next) {
        next = Boolean(next && view);
        if (next === active) { if (active) refresh(); return; }
        active = next;
        if (active) {
            root.addEventListener('scroll', refresh, { passive: true });
            view.addEventListener('resize', refresh, { passive: true });
            intersection?.observe(sentinel);
            resize?.observe(root);
            resize?.observe(sentinel);
            refresh();
        } else {
            root.removeEventListener('scroll', refresh);
            view.removeEventListener('resize', refresh);
            intersection?.disconnect();
            resize?.disconnect();
            if (frame !== null) view.cancelAnimationFrame(frame);
            frame = null;
        }
    }
    return { refresh, setActive, destroy() { setActive(false); } };
}
