const selector = '.bp-benchmark-family-chain';

export function horizontalScrollEdges({ scrollLeft, scrollWidth, clientWidth }) {
    if (clientWidth <= 0) return { left: false, right: false };
    const limit = Math.max(0, scrollWidth - clientWidth);
    const offset = Math.min(limit, Math.max(0, scrollLeft));
    return { left: offset > 1, right: limit - offset > 1 };
}

export function createChainScrollEdges(container) {
    const observed = new Set();
    const fonts = container.ownerDocument.fonts;
    let frame = null;
    let destroyed = false;

    function update(chain) {
        const edges = horizontalScrollEdges(chain);
        chain.parentElement.classList.toggle('can-scroll-left', edges.left);
        chain.parentElement.classList.toggle('can-scroll-right', edges.right);
    }

    function sync() {
        frame = null;
        const chains = [...container.querySelectorAll(selector)];
        // One observer serves every row; replaced rows must not stay retained.
        const current = new Set(chains.flatMap(chain => [chain, ...chain.children]));
        for (const node of observed) {
            if (current.has(node)) continue;
            resize.unobserve(node);
            observed.delete(node);
        }
        for (const node of current) {
            if (observed.has(node)) continue;
            observed.add(node);
            resize.observe(node);
        }
        chains.forEach(update);
    }

    function refresh() {
        if (!destroyed && frame === null) frame = requestAnimationFrame(sync);
    }

    function onScroll(event) {
        if (event.target.matches(selector)) update(event.target);
    }

    const resize = new globalThis.ResizeObserver(refresh);
    const mutations = new MutationObserver(refresh);
    mutations.observe(container, { childList: true, subtree: true });
    container.addEventListener('scroll', onScroll, { capture: true, passive: true });
    fonts?.addEventListener('loadingdone', refresh);
    refresh();

    return {
        refresh,
        destroy() {
            destroyed = true;
            if (frame !== null) cancelAnimationFrame(frame);
            resize.disconnect();
            mutations.disconnect();
            container.removeEventListener('scroll', onScroll, true);
            fonts?.removeEventListener('loadingdone', refresh);
            for (const node of container.querySelectorAll(selector)) {
                node.parentElement.classList.remove('can-scroll-left', 'can-scroll-right');
            }
            observed.clear();
        }
    };
}
