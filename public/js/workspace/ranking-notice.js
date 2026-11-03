export function createRankingNotice({ status, rows }) {
    const viewport = status.closest('.bp-model-viewport');
    const spacer = document.createElement('div');
    spacer.className = 'bp-model-ranking-spacer'; spacer.setAttribute('aria-hidden', 'true');
    const content = document.createElement('div'); content.className = 'bp-model-ranking-status-content';
    const icon = document.createElement('i'); icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span'); content.append(icon, text); status.replaceChildren(content);
    const mobile = window.matchMedia('(max-width: 760px)');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const mobilePage = rows.closest('.bp-right-workspace');
    let height = 0, frame = 0, lastIdentity = '', destroyed = false;
    let lastScroll = null, scrollRemainder = 0, lastMobile = mobile.matches;

    function setHeight(value) {
        const delta = value - height;
        const scrollRoot = mobile.matches ? mobilePage : rows;
        const mobileTop = mobilePage.getBoundingClientRect().top;
        viewport.style.setProperty('--ranking-notice-top', '0px');
        const scrollTop = scrollRoot.scrollTop;
        const anchor = rows.getClientRects().length > 0
            && (mobile.matches ? rows.getBoundingClientRect().top + height < mobileTop : scrollTop > .5);
        if (lastMobile !== mobile.matches || lastScroll === null || Math.abs(lastScroll - scrollTop) > .01) scrollRemainder = 0;
        lastMobile = mobile.matches;
        height = value;
        viewport.style.setProperty('--ranking-notice-height', `${height}px`);
        // Set an absolute target after layout so native scroll anchoring cannot add the delta twice.
        if (anchor && spacer.isConnected) {
            spacer.getBoundingClientRect();
            const target = Math.max(0, scrollTop + delta + scrollRemainder);
            scrollRoot.scrollTo({ top: target, behavior: 'instant' });
            lastScroll = scrollRoot.scrollTop;
            // Preserve fractional pixels across frames on browsers that round scroll offsets.
            scrollRemainder = target - lastScroll;
        } else { lastScroll = null; scrollRemainder = 0; }
    }

    function animateTo(target) {
        window.cancelAnimationFrame(frame); frame = 0;
        status.dataset.motion = target ? height < target ? 'opening' : 'open' : 'closing';
        const finish = () => {
            setHeight(target); status.dataset.motion = target ? 'open' : 'closed';
            status.hidden = target === 0;
        };
        if (reduced.matches || Math.abs(target - height) < .1) { finish(); return; }
        const startHeight = height, duration = target ? 320 : 620;
        let start = null;
        const tick = time => {
            if (destroyed) return;
            start ??= time;
            const progress = Math.min(1, (time - start) / duration);
            const eased = progress * progress * (3 - 2 * progress);
            setHeight(startHeight + (target - startHeight) * eased);
            if (progress < 1) frame = window.requestAnimationFrame(tick);
            else { frame = 0; finish(); }
        };
        frame = window.requestAnimationFrame(tick);
    }

    function update({ pending, error, version, scope }) {
        const phase = error ? 'error' : pending ? 'updating' : 'ready';
        const identity = JSON.stringify([phase, error || '', version, scope]);
        rows.closest('#model-card')?.setAttribute('aria-busy', String(pending && !error));
        if (identity === lastIdentity) return;
        lastIdentity = identity; status.dataset.phase = phase;
        // Normal progress lives beside the topic title; retain actionable errors here.
        if (!error) { animateTo(0); return; }
        status.hidden = false;
        text.textContent = error;
        icon.className = 'fa-solid fa-triangle-exclamation';
        animateTo(Math.max(44, content.scrollHeight));
    }

    const observer = new window.ResizeObserver(() => {
        if (!status.hidden && status.dataset.motion !== 'closing') animateTo(Math.max(44, content.scrollHeight));
    });
    observer.observe(content);
    observer.observe(mobilePage);
    const destroy = () => {
        destroyed = true; window.cancelAnimationFrame(frame); observer.disconnect();
    };
    window.addEventListener('pagehide', destroy, { once: true });
    return { update, resetRows() { rows.replaceChildren(spacer); }, hide() {
        lastIdentity = ''; status.dataset.phase = 'idle';
        animateTo(0);
    }, destroy };
}
