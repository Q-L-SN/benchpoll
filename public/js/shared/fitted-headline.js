export function mountFittedHeadline(headline) {
    const phrases = [...headline.children];
    let width = 0, frame = 0, disposed = false;
    const refresh = () => {
        if (disposed || !headline.clientWidth || !phrases.length) return;
        const style = getComputedStyle(headline);
        const max = Number(style.getPropertyValue('--headline-max-size')) || 58;
        const min = Number(style.getPropertyValue('--headline-min-size')) || 18;
        width = headline.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        headline.style.setProperty('--headline-size', `${max}px`);
        const naturalWidth = Math.max(...phrases.map(phrase => phrase.getBoundingClientRect().width));
        const size = Math.max(min, Math.min(max, Math.floor(max * (width - 1) / naturalWidth * 100) / 100));
        headline.style.setProperty('--headline-size', `${size}px`);
    };
    const resize = new ResizeObserver(entries => {
        if (!frame && Math.abs(entries[0].contentRect.width - width) >= 1) {
            frame = requestAnimationFrame(() => { frame = 0; refresh(); });
        }
    });
    resize.observe(headline);
    document.fonts?.ready.then(refresh);
    document.fonts?.addEventListener('loadingdone', refresh);
    refresh();
    return {
        refresh,
        destroy() {
            disposed = true;
            cancelAnimationFrame(frame);
            resize.disconnect();
            document.fonts?.removeEventListener('loadingdone', refresh);
        }
    };
}
