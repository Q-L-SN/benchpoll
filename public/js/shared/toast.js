export function createToast({ duration = 3500, avoid = null } = {}) {
    const root = document.createElement('div');
    root.className = 'bp-toast';
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
    root.setAttribute('aria-atomic', 'true');
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-check';
    icon.setAttribute('aria-hidden', 'true');
    const message = document.createElement('span');
    root.append(icon, message);
    document.body.append(root);
    let timer = null;
    const reposition = () => {
        const bounds = avoid?.getBoundingClientRect();
        if (bounds?.height > 0) root.style.setProperty('--toast-bottom', `${window.innerHeight - bounds.top + 12}px`);
        else root.style.removeProperty('--toast-bottom');
    };
    if (avoid) new window.ResizeObserver(reposition).observe(avoid);

    function dismiss() {
        clearTimeout(timer);
        timer = null;
        root.classList.remove('is-visible');
        message.textContent = '';
    }

    return {
        show(text) {
            clearTimeout(timer);
            message.textContent = text;
            reposition();
            root.classList.add('is-visible');
            timer = setTimeout(dismiss, duration);
        },
        dismiss
    };
}
