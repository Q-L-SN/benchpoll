function offset(start, end, near, far, align) {
    if (align === 'center') return (start + end - near - far) / 2;
    if (start >= near && end <= far || start <= near && end >= far) return 0;
    return Math.abs(start - near) < Math.abs(end - far) ? start - near : end - far;
}

// Native scrollIntoView also scrolls clipped ancestors and the layout viewport.
// The regular workspace owns a vertical pane and, on narrow screens, a separate horizontal pager.
export function revealInPanel(target, options) {
    const panel = target.closest('.bp-left-workspace, .bp-right-workspace');
    if (!panel || target.closest('.is-showcase')) { target.scrollIntoView(options); return; }
    let vertical = true, horizontal = true;
    for (let root = target.parentElement; root && panel.contains(root); root = root.parentElement) {
        const style = getComputedStyle(root), bounds = root.getBoundingClientRect(), item = target.getBoundingClientRect();
        const delta = { behavior: options.behavior };
        if (vertical && /auto|scroll/.test(style.overflowY) && root.scrollHeight > root.clientHeight) {
            const top = bounds.top + root.clientTop;
            delta.top = offset(item.top, item.bottom, top + (parseFloat(style.scrollPaddingTop) || 0),
                top + root.clientHeight - (parseFloat(style.scrollPaddingBottom) || 0), options.block);
            vertical = false;
        }
        if (horizontal && /auto|scroll/.test(style.overflowX) && root.scrollWidth > root.clientWidth) {
            const left = bounds.left + root.clientLeft;
            delta.left = offset(item.left, item.right, left, left + root.clientWidth, options.inline);
            horizontal = false;
        }
        if (delta.top || delta.left) root.scrollBy(delta);
    }
    // The desktop table columns can extend horizontally past the sidebar.
    const grid = panel.parentElement;
    if (window.matchMedia('(min-width: 761px)').matches && grid.scrollWidth > grid.clientWidth) {
        const column = target.closest('.bp-pie-scroll-shell, .bp-benchmark-card, .bp-model-card') ?? target;
        const item = column.getBoundingClientRect(), left = grid.getBoundingClientRect().left + grid.clientLeft;
        grid.scrollBy({ left: offset(item.left, item.right, left, left + grid.clientWidth), behavior: options.behavior });
    }
}
