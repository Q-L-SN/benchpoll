export function initializeMobilePanels(workspace) {
    const controls = [...workspace.querySelectorAll('button[data-mobile-panel]')];
    controls.forEach(control => {
        control.addEventListener('click', () => {
            workspace.dataset.mobilePanel = control.dataset.mobilePanel;
            controls.forEach(button => button.setAttribute('aria-pressed', String(button === control)));
        });
    });
}
