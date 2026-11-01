let layout;

export function mountBarEndpointLabel(track, label, position, start = 0, { overflow = 'outside' } = {}) {
    label.classList.add('bp-bar-endpoint-label');
    label.dataset.barLabelFallback = overflow;
    label.style.setProperty('--bar-label-position', `${Math.max(0, Math.min(100, position))}%`);
    label.style.setProperty('--bar-label-start', `${Math.max(0, Math.min(100, start))}%`);
    track.dataset.tooltip = label.textContent;
    track.append(label);
    if (!globalThis.ResizeObserver || !document.body) return;
    if (!layout) {
        const pairs = new Map();
        let frame = 0;
        const update = () => {
            frame = 0;
            const sizes = [];
            for (const [label, track] of pairs) {
                if (!label.isConnected) { resize.unobserve(label); resize.unobserve(track); pairs.delete(label); continue; }
                const end = parseFloat(label.style.getPropertyValue('--bar-label-position'));
                const start = parseFloat(label.style.getPropertyValue('--bar-label-start'));
                sizes.push([label, label.getBoundingClientRect().width, track.clientWidth * Math.max(0, end - start) / 100]);
            }
            // Keep true bar lengths; score labels can move outside instead of changing the scale.
            for (const [label, width, available] of sizes) label.dataset.barLabelOverflow = String(available < width);
        };
        const queue = () => { if (!frame) frame = requestAnimationFrame(update); };
        const resize = new globalThis.ResizeObserver(queue);
        new MutationObserver(queue).observe(document.body, { childList: true, subtree: true });
        layout = (track, label) => { pairs.set(label, track); resize.observe(track); resize.observe(label); queue(); };
    }
    layout(track, label);
}
