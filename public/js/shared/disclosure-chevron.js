const directionClass = /^fa-(?:chevron|angle|caret)-(?:left|right|up|down)$/;
const candidates = 'details > summary, [data-ui-disclosure]';
const observers = new WeakMap();

export function createDisclosureChevron({ document = globalThis.document, className = '' } = {}) {
    const icon = document.createElement('i');
    icon.className = `fa-solid fa-chevron-right bp-ui-disclosure-chevron ${className}`.trim();
    icon.setAttribute('aria-hidden', 'true');
    return icon;
}

// Presentation only: the owner retains events, focus, and aria-expanded.
export function mountDisclosureChevron(trigger, { icon } = {}) {
    if (!trigger) return null;
    if (trigger.matches('summary') && (trigger.getAttribute('aria-haspopup') === 'menu'
        || (!trigger.textContent.trim() && trigger.children.length === 1
            && trigger.firstElementChild.matches('i.fa-ellipsis, i.fa-ellipsis-vertical')))) return null;
    icon ??= [...trigger.children].find(child => child.classList.contains('bp-ui-disclosure-chevron'))
        ?? [...trigger.children].find(child => child.matches('i') && [...child.classList].some(name => directionClass.test(name)));
    icon ??= createDisclosureChevron({ document: trigger.ownerDocument });
    for (const name of [...icon.classList]) if (directionClass.test(name) && name !== 'fa-chevron-right') icon.classList.remove(name);
    icon.classList.add('fa-solid', 'fa-chevron-right', 'bp-ui-disclosure-chevron');
    icon.setAttribute('aria-hidden', 'true');
    if (icon.parentElement !== trigger) trigger.append(icon);
    if (!trigger.hasAttribute('data-ui-disclosure')) trigger.setAttribute('data-ui-disclosure', '');
    return icon;
}

export function observeDisclosureChevrons(root = document) {
    const document = root.ownerDocument ?? root;
    const adopt = node => {
        if (node.matches?.(candidates)) mountDisclosureChevron(node);
        node.querySelectorAll?.(candidates).forEach(element => mountDisclosureChevron(element));
    };
    adopt(root);
    if (observers.has(document)) return;
    const observer = new document.defaultView.MutationObserver(records => {
        for (const record of records) {
            if (record.type === 'attributes') {
                if (record.target.hasAttribute('data-ui-disclosure')) mountDisclosureChevron(record.target);
            } else {
                if (record.target.matches?.(candidates)) mountDisclosureChevron(record.target);
                for (const node of record.addedNodes) adopt(node);
            }
        }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['data-ui-disclosure'] });
    observers.set(document, observer);
}
