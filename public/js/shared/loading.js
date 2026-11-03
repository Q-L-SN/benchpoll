// One visual loading indicator, with contextual copy available to assistive technology.
export function createLoadingIndicator(label = 'Loading', root = globalThis.document) {
    const indicator = root.createElement('span');
    indicator.className = 'bp-loading-indicator';
    indicator.setAttribute('role', 'status');
    const ring = root.createElement('span');
    ring.className = 'bp-spinner';
    ring.setAttribute('aria-hidden', 'true');
    const text = root.createElement('span');
    text.className = 'bp-loading-label';
    text.textContent = label;
    indicator.append(ring, text);
    return indicator;
}

export function setLoading(container, label = 'Loading') {
    container.replaceChildren(createLoadingIndicator(label, container.ownerDocument ?? globalThis.document));
}

const busyButtons = new WeakMap();

// Preserve the button's width, focus and original nodes while a request is pending.
export function setButtonLoading(button, busy, label = 'Loading') {
    const previous = busyButtons.get(button);
    if (!busy) {
        if (!previous) return;
        button.replaceChildren(...previous.content.childNodes);
        button.classList.remove('bp-button-busy');
        if (previous.ariaBusy === null) button.removeAttribute('aria-busy');
        else button.setAttribute('aria-busy', previous.ariaBusy);
        busyButtons.delete(button);
        return;
    }
    if (previous) {
        previous.indicator.querySelector('.bp-loading-label').textContent = label;
        return;
    }
    const root = button.ownerDocument ?? globalThis.document;
    const content = root.createElement('span');
    content.className = 'bp-loading-button-content';
    content.setAttribute('aria-hidden', 'true');
    content.append(...button.childNodes);
    const indicator = createLoadingIndicator(label, root);
    busyButtons.set(button, { content, indicator, ariaBusy: button.getAttribute('aria-busy') });
    button.replaceChildren(content, indicator);
    button.classList.add('bp-button-busy');
    button.setAttribute('aria-busy', 'true');
}
