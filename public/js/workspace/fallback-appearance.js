let refreshNodeAlignment;

export function initializeFallbackAppearance() {
    if (refreshNodeAlignment) return refreshNodeAlignment;
    const selector = '.bp-fallback-chain > .bp-fallback-chain-step';
    const rows = new Map();
    let frame = 0, rescan = true;
    const range = document.createRange();
    const nameFor = row => row.querySelector('.bp-benchmark-link-name')
        ?? row.querySelector('.bp-auto-version-label strong')
        ?? row.querySelector('.bp-benchmark-information-link')
        ?? row.firstElementChild;
    const queue = scan => {
        if (scan === true) rescan = true;
        if (!frame) frame = requestAnimationFrame(update);
    };
    const resize = globalThis.ResizeObserver ? new globalThis.ResizeObserver(() => queue()) : null;
    function update() {
        frame = 0;
        for (const [row, name] of rows) if (!row.isConnected || nameFor(row) !== name) {
            resize?.unobserve(row); resize?.unobserve(name); rows.delete(row);
        }
        if (rescan) {
            rescan = false;
            for (const row of document.querySelectorAll(selector)) if (!rows.has(row)) {
                const name = nameFor(row);
                if (name) { rows.set(row, name); resize?.observe(row); resize?.observe(name); }
            }
        }
        const positions = [];
        // Read every name before writing positions so long chains do not force repeated layout.
        for (const [row, name] of rows) {
            const box = row.getBoundingClientRect();
            if (!box.height || !row.offsetHeight) continue;
            range.selectNodeContents(name);
            const text = [...range.getClientRects()].find(rect => rect.width > 0 && rect.height > 0);
            if (!text) continue;
            const scale = box.height / row.offsetHeight;
            const y = (text.top + text.height / 2 - box.top) / scale;
            positions.push([row, `${Math.round(y * 100) / 100}px`]);
        }
        for (const [row, y] of positions) if (row.style.getPropertyValue('--bp-chain-node-y') !== y)
            row.style.setProperty('--bp-chain-node-y', y);
    }
    new MutationObserver(records => {
        if (records.some(record => record.target.closest?.('.bp-fallback-chain')
            || [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1
                && (node.matches('.bp-fallback-chain') || node.querySelector('.bp-fallback-chain'))))) queue(true);
    }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', () => queue());
    document.fonts?.ready.then(() => queue());
    refreshNodeAlignment = () => queue(true);
    refreshNodeAlignment();
    return refreshNodeAlignment;
}

