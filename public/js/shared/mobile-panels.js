export function initializeMobilePanels(workspace) {
    const identity = workspace.querySelector('.bp-context-identity');
    if (identity) {
        const updateHeight = () => workspace.style.setProperty('--bp-mobile-topic-height', `${identity.getBoundingClientRect().height}px`);
        new window.ResizeObserver(updateHeight).observe(identity);
        updateHeight();
    }
    const controls = [...workspace.querySelectorAll('button[data-mobile-panel]')];
    controls.forEach(control => {
        control.addEventListener('click', () => {
            if (workspace.dataset.mobilePanel === control.dataset.mobilePanel) return;
            workspace.dataset.mobilePanel = control.dataset.mobilePanel;
            controls.forEach(button => button.setAttribute('aria-pressed', String(button === control)));
            if (window.matchMedia('(max-width: 760px) and (prefers-reduced-motion: no-preference)').matches) {
                const panel = workspace.querySelector(control.dataset.mobilePanel === 'models'
                    ? '.bp-right-workspace' : '.bp-left-workspace');
                panel?.animate([
                    { opacity: 0, transform: 'translateX(12px)' },
                    { opacity: 1, transform: 'translateX(0)' }
                ], { duration: 240, easing: 'cubic-bezier(.22, 1, .36, 1)' });
            }
        });
    });
}
