// Rankings scroll inside the list on desktop, the page on mobile, or a chart.
export function modelScrollViewport(rows) {
    if (!rows.isConnected || rows.closest('[hidden], [inert]')) return null;
    const win = rows.ownerDocument.defaultView;
    const chart = rows.querySelector('.bp-model-chart-scroll');
    const horizontal = Boolean(chart);
    const bounds = (chart ?? rows).getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0 || bounds.right <= 0 || bounds.left >= win.innerWidth
        || bounds.bottom <= 0 || bounds.top >= win.innerHeight) return null;
    let root = chart ?? rows;
    if (!horizontal) {
        while (root && !/(auto|scroll)/.test(win.getComputedStyle(root).overflowY)) root = root.parentElement;
        root ??= rows.ownerDocument.scrollingElement;
    }
    const viewport = root === rows.ownerDocument.scrollingElement
        ? { top: 0, bottom: win.innerHeight, left: 0, right: win.innerWidth } : root.getBoundingClientRect();
    const start = Math.max(0, horizontal ? viewport.left : viewport.top);
    const end = Math.min(horizontal ? win.innerWidth : win.innerHeight, horizontal ? viewport.right : viewport.bottom);
    if (end <= start) return null;
    return { root, horizontal, start, end,
        position: node => node.getBoundingClientRect()[horizontal ? 'left' : 'top'],
        tail: node => node.getBoundingClientRect()[horizontal ? 'right' : 'bottom'] };
}

export function visibleModelAnchor(rows) {
    const viewport = modelScrollViewport(rows);
    if (!viewport) return null;
    const node = [...rows.querySelectorAll('[data-model-key]')].find(node =>
        viewport.tail(node) > viewport.start && viewport.position(node) < viewport.end);
    if (!node) return null;
    const key = node.dataset.modelKey, position = viewport.position(node);
    return { targetModel: node.dataset.comparisonIdentity || node.dataset.modelFocusId,
        restore() {
            const current = [...rows.querySelectorAll('[data-model-key]')].find(node => node.dataset.modelKey === key);
            const nextViewport = modelScrollViewport(rows);
            if (!current || !nextViewport) return;
            const delta = nextViewport.position(current) - position;
            // Measure after layout: browsers that already anchored need no second adjustment.
            if (Math.abs(delta) > .5) nextViewport.root[nextViewport.horizontal ? 'scrollLeft' : 'scrollTop'] += delta;
        } };
}

export function modelWindowEdge(rows, page) {
    const viewport = modelScrollViewport(rows);
    const models = rows.querySelectorAll('[data-model-key]');
    if (!viewport || !models.length) return null;
    const threshold = Math.min(240, (viewport.end - viewport.start) * .5);
    if (page.offset > 0 && viewport.position(models[0]) >= viewport.start - threshold) return 'previous';
    if (page.hasMore && viewport.tail(models[models.length - 1]) <= viewport.end + threshold) return 'next';
    return null;
}
