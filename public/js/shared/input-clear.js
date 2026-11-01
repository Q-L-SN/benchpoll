// Clear is a field behavior; existing search actions retain their own click/keyboard contracts.
const mounted = new WeakMap();
const environments = new WeakMap();
const candidates = 'input[type="search"], input[role="searchbox"], input[data-ui-clearable], input.bp-ui-select-search';
const fieldHosts = '.bp-ui-field, .bp-benchmark-search, .bp-navigation-search, .bp-model-scores-search, .picker-search, .bp-filter-search-wrap, .bp-ui-select-search';
const existingActions = new Map([['topic-search', 'topic-search-close'], ['configured-search', 'navigation-search-close']]);

function clearable(input) {
    return input.matches?.(candidates) && ['search', 'text', 'email', 'url', 'tel'].includes(input.type)
        && input.dataset.uiClearable !== 'false';
}

function watchValue(input, refresh) {
    const own = Object.getOwnPropertyDescriptor(input, 'value');
    if (own && !own.configurable) return () => {};
    let prototype = input, descriptor = own;
    while (!descriptor && (prototype = Object.getPrototypeOf(prototype))) descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (!descriptor?.get || !descriptor.set) return () => {};
    const get = function () { return descriptor.get.call(this); };
    const set = function (value) { descriptor.set.call(this, value); refresh(); };
    Object.defineProperty(input, 'value', { configurable: true, enumerable: descriptor.enumerable, get, set });
    return () => {
        const current = Object.getOwnPropertyDescriptor(input, 'value');
        if (current?.get !== get || current.set !== set) return;
        if (own) Object.defineProperty(input, 'value', own);
        else delete input.value;
    };
}

function environment(document) {
    if (environments.has(document)) return environments.get(document);
    const state = { controllers: new Set(), observer: null };
    environments.set(document, state);
    document.addEventListener('reset', event => {
        document.defaultView.queueMicrotask(() => {
            if (event.defaultPrevented) return;
            for (const controller of state.controllers) if (controller.input.form === event.target) controller.refresh();
        });
    }, true);
    return state;
}

export function mountInputClear(input) {
    if (mounted.has(input)) return mounted.get(input);
    if (!input.parentElement || !clearable(input)) return null;
    const document = input.ownerDocument, view = document.defaultView;
    const state = environment(document);
    const parent = input.parentElement;
    const action = document.getElementById(existingActions.get(input.id));
    const existing = action?.matches('button') && action.parentElement === parent ? action : null;
    const originalClasses = new Map(['bp-ui-input', 'bp-ui-clear-input'].map(name => [name, input.classList.contains(name)]));
    let host = parent, shell = null, disposed = false;
    const wasFocused = document.activeElement === input;
    if (!existing && (!parent.matches(fieldHosts + ', .bp-ui-input-shell') || parent.querySelectorAll('input').length > 1)) {
        shell = document.createElement('span');
        shell.className = 'bp-ui-input-shell';
        shell.dataset.uiComponent = 'field';
        input.before(shell);
        shell.append(input);
        host = shell;
    } else if (parent.matches('.bp-ui-input-shell')) shell = parent;
    const hostHadClass = host.classList.contains('bp-ui-field-clearable');
    host.classList.add('bp-ui-field-clearable');
    input.classList.add('bp-ui-clear-input');
    if (!existing) input.classList.add('bp-ui-input');
    const button = existing ?? host.querySelector(':scope > button[data-ui-clear-generated]') ?? document.createElement('button');
    const buttonHadClass = button.classList.contains('bp-ui-field-clear');
    button.classList.add('bp-ui-field-clear');
    if (!existing) {
        button.type = 'button';
        button.dataset.uiClearGenerated = '';
        button.setAttribute('aria-label', 'Clear search');
        button.dataset.tooltip = 'Clear search';
        const glyph = document.createElement('i');
        glyph.className = 'fa-solid fa-xmark';
        glyph.setAttribute('aria-hidden', 'true');
        button.replaceChildren(glyph);
        host.append(button);
    }

    function refresh() {
        if (disposed || existing) return;
        const disabled = input.matches(':disabled') || input.readOnly;
        if (button.disabled !== disabled) button.disabled = disabled;
        const hidden = !input.value || disabled || input.hidden;
        if (button.hidden !== hidden) button.hidden = hidden;
        const label = input.type === 'search' || input.getAttribute('role') === 'searchbox' ? 'Clear search' : 'Clear input';
        if (button.getAttribute('aria-label') !== label) {
            button.setAttribute('aria-label', label);
            button.dataset.tooltip = label;
        }
    }

    function clear(event) {
        event.preventDefault();
        if (!input.isConnected || input.matches(':disabled') || input.readOnly || !input.value) return;
        input.focus({ preventScroll: true });
        input.value = '';
        input.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
        input.dispatchEvent(new view.Event('change', { bubbles: true, composed: true }));
        refresh();
    }
    const keepFocus = event => { if (event.button === 0) event.preventDefault(); };
    let restoreValue = () => {};
    if (!existing) {
        button.addEventListener('mousedown', keepFocus);
        button.addEventListener('click', clear);
        input.addEventListener('input', refresh);
        input.addEventListener('change', refresh);
        input.addEventListener('focus', refresh);
        restoreValue = watchValue(input, refresh);
    }
    const controller = { input, button, host, refresh,
        destroy() {
            if (disposed) return;
            disposed = true;
            restoreValue();
            if (!existing) {
                button.removeEventListener('mousedown', keepFocus);
                button.removeEventListener('click', clear);
                input.removeEventListener('input', refresh);
                input.removeEventListener('change', refresh);
                input.removeEventListener('focus', refresh);
                button.remove();
            } else if (!buttonHadClass) button.classList.remove('bp-ui-field-clear');
            for (const [name, present] of originalClasses) if (!present) input.classList.remove(name);
            if (!hostHadClass) host.classList.remove('bp-ui-field-clearable');
            if (shell && input.parentElement === shell) { shell.before(input); shell.remove(); }
            else if (shell && !shell.children.length) shell.remove();
            mounted.delete(input);
            state.controllers.delete(controller);
        } };
    mounted.set(input, controller);
    state.controllers.add(controller);
    refresh();
    if (wasFocused && document.activeElement !== input) input.focus({ preventScroll: true });
    return controller;
}

export function observeInputClears(root = document) {
    const document = root.ownerDocument ?? root;
    const state = environment(document);
    const adopt = node => {
        if (clearable(node)) mountInputClear(node);
        node.querySelectorAll?.(candidates).forEach(mountInputClear);
    };
    adopt(root);
    if (state.observer) return;
    state.observer = new document.defaultView.MutationObserver(records => {
        for (const record of records) {
            if (record.type === 'attributes') adopt(record.target);
            else for (const node of record.addedNodes) adopt(node);
        }
        for (const controller of state.controllers) {
            if (!controller.input.isConnected || !clearable(controller.input)) controller.destroy();
            else if (controller.input.parentElement !== controller.host || controller.button.parentElement !== controller.host) {
                const input = controller.input;
                controller.destroy();
                mountInputClear(input);
            }
            else controller.refresh();
        }
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['type', 'role', 'data-ui-clearable', 'disabled', 'readonly', 'value', 'hidden'] });
}
