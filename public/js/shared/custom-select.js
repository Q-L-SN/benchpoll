import { mountDisclosureChevron } from './disclosure-chevron.js';

// The native select remains the form/event backing; only this field can receive user input.
const mounted = new WeakMap();
const environments = new WeakMap();
let sequence = 0;

function icon(document, className) {
    const element = document.createElement('i');
    element.className = `fa-solid ${className}`;
    element.setAttribute('aria-hidden', 'true');
    return element;
}

function attribute(element, name, value) {
    if (value === null) element.removeAttribute(name);
    else if (element.getAttribute(name) !== String(value)) element.setAttribute(name, String(value));
}

function labelText(select) {
    return [...select.labels ?? []].map(label => {
        const filter = select.ownerDocument.defaultView.NodeFilter;
        const walker = select.ownerDocument.createTreeWalker(label, filter.SHOW_ELEMENT | filter.SHOW_TEXT, {
            acceptNode(node) {
                if (node.nodeType === 1) return node.matches('select, input, textarea, button, .bp-ui-select, script, style, [aria-hidden="true"]')
                    ? filter.FILTER_REJECT : filter.FILTER_SKIP;
                return filter.FILTER_ACCEPT;
            }
        });
        const parts = [];
        while (walker.nextNode()) parts.push(walker.currentNode.textContent.trim());
        return parts.filter(Boolean).join(' ');
    }).filter(Boolean).join(' ');
}

export function handleCustomSelectKeydown(event) {
    const controller = environments.get(event.target.ownerDocument)?.active;
    if (!controller || !event.composedPath().includes(controller.trigger)) return false;
    if (event.key === 'Escape') {
        controller.close();
        event.preventDefault();
        event.stopImmediatePropagation();
        return true;
    }
    if (event.key === 'Tab') controller.close({ commit: true });
    return false;
}

function environment(document) {
    if (environments.has(document)) return environments.get(document);
    const view = document.defaultView;
    const state = { controllers: new Set(), active: null, timer: null, observing: false };
    environments.set(document, state);
    const nativeFocus = view.HTMLSelectElement.prototype.focus;
    Object.defineProperty(view.HTMLSelectElement.prototype, 'focus', { configurable: true, writable: true,
        value(options) {
            const controller = mounted.get(this) ?? (this.parentNode ? mountCustomSelect(this) : null);
            if (controller) controller.trigger.focus(options);
            else nativeFocus.call(this, options);
        } });
    const reposition = event => {
        if (!state.active || (event?.target instanceof view.Node && state.active.popup.contains(event.target))) return;
        state.active.position();
    };
    document.addEventListener('keydown', handleCustomSelectKeydown, true);
    document.addEventListener('pointerdown', event => {
        if (state.active && !event.composedPath().includes(state.active.root)
            && !event.composedPath().includes(state.active.popup)) state.active.close();
    }, true);
    document.addEventListener('click', event => {
        const label = event.target.closest?.('label');
        const controller = mounted.get(label?.control);
        if (!controller || event.target.closest('button, a, input, textarea, .bp-ui-select')) return;
        event.preventDefault();
        controller.trigger.focus();
    });
    document.addEventListener('reset', event => {
        // Reset changes selectedness after the reset event has finished dispatching.
        view.queueMicrotask(() => {
            if (event.defaultPrevented) return;
            for (const controller of state.controllers) {
                if (controller.select.form === event.target) {
                    controller.close();
                    controller.clearValidation();
                    controller.refresh();
                }
            }
        });
    }, true);
    document.addEventListener('scroll', reposition, true);
    view.addEventListener('resize', reposition);
    view.visualViewport?.addEventListener('resize', reposition);
    view.visualViewport?.addEventListener('scroll', reposition);
    return state;
}

export function mountCustomSelect(select) {
    if (mounted.has(select)) return mounted.get(select);
    if (!select.parentNode) return null;
    const document = select.ownerDocument, view = document.defaultView;
    const wasFocused = document.activeElement === select;
    const state = environment(document);
    const cloned = select.classList.contains('bp-ui-select-native');
    const sibling = select.nextElementSibling;
    if (cloned && sibling?.matches('.bp-ui-select') && ![...state.controllers].some(item => item.root === sibling)) sibling.remove();
    const ID = `bp-select-${++sequence}`;
    const root = document.createElement('span');
    root.className = 'bp-ui-select';
    root.dataset.uiComponent = 'field';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.id = `${ID}-trigger`;
    trigger.className = 'bp-ui-field bp-ui-select-trigger';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', `${ID}-list`);
    const value = document.createElement('span');
    value.className = 'bp-ui-select-value';
    trigger.append(icon(document, 'fa-list-ul'), value);
    mountDisclosureChevron(trigger);
    const popup = document.createElement('span');
    popup.className = 'bp-ui-select-popup';
    popup.id = `${ID}-list`;
    popup.setAttribute('role', 'listbox');
    popup.setAttribute('aria-labelledby', trigger.id);
    if (typeof popup.showPopover === 'function') popup.setAttribute('popover', 'manual');
    popup.hidden = true;
    const error = document.createElement('span');
    error.className = 'bp-ui-select-error';
    error.id = `${ID}-error`;
    error.setAttribute('role', 'alert');
    error.hidden = true;
    root.append(trigger, popup, error);
    select.after(root);

    const originalAttributes = new Map(['tabindex', 'aria-hidden'].map(name => [name, cloned ? null : select.getAttribute(name)]));
    const propertyRestores = new Map();
    const optionRestores = new Map();
    let items = [], activeIndex = -1, open = false, disposed = false, validationShown = false, layer = null;
    let typed = '', typedAt = 0, selectionSignature = '';

    function intercept(object, property, after, restores) {
        if (restores.get(object)?.has(property)) return;
        const own = Object.getOwnPropertyDescriptor(object, property);
        if (own && !own.configurable) return;
        let prototype = object, descriptor = own;
        while (!descriptor && (prototype = Object.getPrototypeOf(prototype))) descriptor = Object.getOwnPropertyDescriptor(prototype, property);
        if (!descriptor?.set || !descriptor.get) return;
        if (!restores.has(object)) restores.set(object, new Map());
        restores.get(object).set(property, own);
        Object.defineProperty(object, property, { configurable: true, enumerable: descriptor.enumerable,
            get() { return descriptor.get.call(this); },
            set(next) { descriptor.set.call(this, next); after(); } });
    }

    function restoreProperties(restores) {
        for (const [object, properties] of restores) for (const [property, descriptor] of properties) {
            if (descriptor) Object.defineProperty(object, property, descriptor);
            else delete object[property];
        }
        restores.clear();
    }

    function enabled(item) { return !item.option.disabled && !item.option.parentElement?.disabled && !item.option.hidden && !item.option.parentElement?.hidden; }
    function available() { return items.filter(enabled); }
    function syncActive({ scroll = false } = {}) {
        for (const item of items) item.node.dataset.active = String(open && item.index === activeIndex);
        const active = items.find(item => item.index === activeIndex && enabled(item));
        if (open && active) {
            trigger.setAttribute('aria-activedescendant', active.node.id);
            if (scroll) {
                const bounds = active.node.getBoundingClientRect(), menu = popup.getBoundingClientRect();
                if (bounds.top < menu.top + 5) popup.scrollTop -= menu.top + 5 - bounds.top;
                else if (bounds.bottom > menu.bottom - 5) popup.scrollTop += bounds.bottom - menu.bottom + 5;
            }
        } else trigger.removeAttribute('aria-activedescendant');
    }

    function renderOptions() {
        restoreProperties(optionRestores);
        items = [];
        const content = document.createDocumentFragment();
        for (const child of select.children) {
            let host = content;
            if (child.tagName === 'OPTGROUP') {
                host = document.createElement('span');
                host.className = 'bp-ui-select-group';
                host.setAttribute('role', 'group');
                host.setAttribute('aria-label', child.label);
                const heading = document.createElement('span');
                heading.className = 'bp-ui-select-group-label';
                heading.textContent = child.label;
                heading.setAttribute('aria-hidden', 'true');
                host.append(heading);
                host.hidden = child.hidden;
                content.append(host);
            }
            const options = child.tagName === 'OPTGROUP' ? [...child.children] : [child];
            for (const option of options) {
                if (option.tagName !== 'OPTION') continue;
                const index = option.index;
                const node = document.createElement('span');
                node.className = 'bp-ui-select-option';
                node.id = `${ID}-option-${index}`;
                node.dataset.index = String(index);
                node.setAttribute('role', 'option');
                node.hidden = option.hidden;
                const text = document.createElement('span');
                text.textContent = option.label;
                node.append(text, icon(document, 'fa-check'));
                host.append(node);
                items.push({ option, index, node });
                intercept(option, 'selected', refresh, optionRestores);
            }
        }
        popup.replaceChildren(content);
        selectionSignature = '';
        refresh();
    }

    function refresh() {
        if (disposed) return;
        if (select.isConnected && select.nextElementSibling !== root) select.after(root);
        root.hidden = select.hidden || select.style.display === 'none' || select.style.visibility === 'hidden';
        if (trigger.disabled !== select.matches(':disabled')) trigger.disabled = select.matches(':disabled');
        attribute(trigger, 'tabindex', Number(originalAttributes.get('tabindex') ?? 0));
        attribute(trigger, 'data-tooltip', select.getAttribute('data-tooltip'));
        attribute(trigger, 'aria-required', select.required);
        const name = select.getAttribute('aria-label') || labelText(select) || select.dataset.tooltip || select.name || 'Choose an option';
        if (trigger.getAttribute('aria-label') !== name) trigger.setAttribute('aria-label', name);
        const labelledBy = select.getAttribute('aria-labelledby');
        attribute(trigger, 'aria-labelledby', labelledBy);
        if (!select.willValidate || select.validity.valid) clearValidation();
        const description = [select.getAttribute('aria-describedby'), validationShown && !error.hidden ? error.id : ''].filter(Boolean).join(' ');
        attribute(trigger, 'aria-describedby', description || null);
        attribute(trigger, 'aria-invalid', validationShown || select.getAttribute('aria-invalid') === 'true');
        attribute(popup, 'aria-multiselectable', select.multiple ? 'true' : null);
        const selected = [...select.selectedOptions];
        const signature = JSON.stringify(selected.map(option => [option.index, option.label]));
        if (signature !== selectionSignature) {
            selectionSignature = signature;
            value.textContent = selected.map(option => option.label).join(', ') || select.dataset.placeholder || 'Choose an option';
            value.dataset.tooltip = value.textContent;
            root.dataset.empty = String(!selected.length || !select.value);
        }
        for (const item of items) {
            attribute(item.node, 'aria-selected', item.option.selected);
            attribute(item.node, 'aria-disabled', !enabled(item));
        }
        if (open && (trigger.disabled || root.hidden || !trigger.getClientRects().length || trigger.closest('[hidden], [inert]'))) close();
        if (open && !items.some(item => item.index === activeIndex && enabled(item))) activeIndex = available()[0]?.index ?? -1;
        syncActive();
    }

    function clearValidation() {
        validationShown = false;
        error.hidden = true;
        error.textContent = '';
    }

    function replacementFocus() {
        const name = select.getAttribute('aria-label') || labelText(select);
        const matches = candidate => select.id ? candidate.id === select.id
            : candidate.name === select.name && (candidate.getAttribute('aria-label') || labelText(candidate)) === name;
        const ordinal = [...document.querySelectorAll('select')].filter(matches).indexOf(select);
        return () => {
            if (trigger.isConnected || document.activeElement !== document.body) return;
            const replacement = [...document.querySelectorAll('select')].filter(matches)[Math.max(0, ordinal)];
            if (replacement) mountCustomSelect(replacement)?.trigger.focus({ preventScroll: true });
        };
    }

    function commit(index = activeIndex) {
        const item = items.find(item => item.index === index);
        if (!item || !enabled(item) || trigger.disabled) return;
        const restore = replacementFocus();
        const before = [...select.selectedOptions].map(option => option.index).join(',');
        if (select.multiple) item.option.selected = !item.option.selected;
        else select.selectedIndex = item.index;
        refresh();
        if (before !== [...select.selectedOptions].map(option => option.index).join(',')) {
            select.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
            select.dispatchEvent(new view.Event('change', { bubbles: true, composed: true }));
        }
        if (!trigger.isConnected) { restore(); view.queueMicrotask(restore); }
    }

    function close({ commit: shouldCommit = false } = {}) {
        if (!open) return;
        if (shouldCommit && !select.multiple) commit();
        open = false;
        if (state.active === controller) state.active = null;
        if (popup.hasAttribute('popover') && popup.matches(':popover-open')) popup.hidePopover();
        popup.hidden = true;
        if (layer) { root.append(popup); layer.remove(); layer = null; }
        delete popup.dataset.uiOpen;
        trigger.setAttribute('aria-expanded', 'false');
        typed = '';
        syncActive();
    }

    function position() {
        if (!open) return;
        const bounds = trigger.getBoundingClientRect(), viewport = view.visualViewport;
        const left = (viewport?.offsetLeft ?? 0) + 8, top = (viewport?.offsetTop ?? 0) + 8;
        const right = left + (viewport?.width ?? view.innerWidth) - 16;
        const bottom = top + (viewport?.height ?? view.innerHeight) - 16;
        if (bounds.bottom <= top || bounds.top >= bottom || !trigger.getClientRects().length) { close(); return; }
        const width = Math.min(Math.max(bounds.width, 200), right - left);
        popup.style.width = `${width}px`;
        const below = Math.max(0, bottom - bounds.bottom - 5), above = Math.max(0, bounds.top - top - 5);
        const upward = below < Math.min(popup.scrollHeight, 220) && above > below;
        const height = Math.min(320, upward ? above : below);
        popup.style.maxHeight = `${height}px`;
        const x = view.getComputedStyle(trigger).direction === 'rtl' ? bounds.right - width : bounds.left;
        popup.style.left = `${Math.max(left, Math.min(x, right - width))}px`;
        popup.style.top = `${upward ? Math.max(top, bounds.top - Math.min(popup.scrollHeight + 2, height) - 5) : bounds.bottom + 5}px`;
        popup.dataset.placement = upward ? 'above' : 'below';
    }

    function show() {
        refresh();
        if (open || trigger.disabled || root.hidden || !available().length || !trigger.getClientRects().length || trigger.closest('[hidden], [inert]')) return;
        trigger.focus({ preventScroll: true });
        if (!trigger.isConnected) return;
        state.active?.close();
        state.active = controller;
        open = true;
        activeIndex = items.find(item => item.option.selected && enabled(item))?.index ?? available()[0].index;
        popup.hidden = false;
        popup.dataset.uiOpen = 'true';
        if (popup.hasAttribute('popover')) popup.showPopover();
        else {
            // A fixed fallback must escape transformed/scrolled custom dialog content.
            layer = document.createElement('span');
            layer.className = 'bp-ui-select bp-ui-select-layer';
            const styles = view.getComputedStyle(root);
            for (const name of ['--bp-accent', '--bp-text', '--bp-ink', '--bp-muted', '--bp-line', '--bp-line-strong', '--bp-hover', '--bp-selected', '--bp-surface', '--font-sans']) {
                layer.style.setProperty(name, styles.getPropertyValue(name));
            }
            (select.closest('dialog[open]') ?? document.body).append(layer);
            layer.append(popup);
        }
        trigger.setAttribute('aria-expanded', 'true');
        position();
        syncActive({ scroll: true });
    }

    function move(direction) {
        const choices = available();
        const current = choices.findIndex(item => item.index === activeIndex);
        const next = direction === 'first' ? 0 : direction === 'last' ? choices.length - 1
            : Math.max(0, Math.min(choices.length - 1, current + direction));
        activeIndex = choices[next]?.index ?? -1;
        syncActive({ scroll: true });
    }

    function onKeydown(event) {
        if (handleCustomSelectKeydown(event) || trigger.disabled || event.isComposing) return;
        const wasOpen = open;
        if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'PageDown', 'PageUp'].includes(event.key)) {
            if (event.ctrlKey || event.metaKey) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.key === 'ArrowUp' && event.altKey && open) { close({ commit: true }); return; }
            show();
            if (event.key === 'Home') move('first');
            else if (event.key === 'End') move('last');
            else if (wasOpen && ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].includes(event.key)) {
                move({ ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }[event.key]);
            } else if (wasOpen && ['Enter', ' '].includes(event.key)) {
                commit();
                if (!select.multiple) close();
            }
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            event.stopPropagation();
            show();
            const now = Date.now();
            typed = now - typedAt > 700 ? event.key : typed + event.key;
            typedAt = now;
            const characters = [...typed.toLocaleLowerCase()];
            const query = characters.every(character => character === characters[0]) ? characters[0] : characters.join('');
            const choices = available(), current = choices.findIndex(item => item.index === activeIndex);
            const start = query.length === 1 ? current + 1 : current;
            for (let offset = 0; offset < choices.length; offset++) {
                const choice = choices[(Math.max(0, start) + offset) % choices.length];
                if (choice.option.label.trim().toLocaleLowerCase().startsWith(query)) {
                    activeIndex = choice.index;
                    syncActive({ scroll: true });
                    break;
                }
            }
        }
    }

    function onClick(event) {
        event.preventDefault();
        trigger.focus({ preventScroll: true });
        if (open) close();
        else show();
    }
    function onPopupClick(event) {
        event.preventDefault();
        event.stopPropagation();
        const option = event.target.closest('[data-index]');
        if (!option || option.getAttribute('aria-disabled') === 'true') return;
        activeIndex = Number(option.dataset.index);
        commit();
        if (!select.multiple) close();
        if (trigger.isConnected) trigger.focus({ preventScroll: true });
    }
    function onInvalid(event) {
        event.preventDefault();
        validationShown = true;
        error.textContent = select.validationMessage;
        error.hidden = false;
        refresh();
        trigger.focus();
    }
    const stopNativeClick = event => event.preventDefault();
    const keepFocus = event => event.preventDefault();
    const onFocus = event => {
        refresh();
        select.dispatchEvent(new view.FocusEvent('focus', { relatedTarget: event.relatedTarget }));
        select.dispatchEvent(new view.FocusEvent('focusin', { bubbles: true, composed: true, relatedTarget: event.relatedTarget }));
    };
    const onBlur = event => {
        select.dispatchEvent(new view.FocusEvent('blur', { relatedTarget: event.relatedTarget }));
        select.dispatchEvent(new view.FocusEvent('focusout', { bubbles: true, composed: true, relatedTarget: event.relatedTarget }));
        view.queueMicrotask(() => { if (document.activeElement !== trigger) close(); });
    };
    trigger.addEventListener('click', onClick);
    trigger.addEventListener('keydown', onKeydown);
    trigger.addEventListener('focus', onFocus);
    trigger.addEventListener('blur', onBlur);
    popup.addEventListener('mousedown', keepFocus);
    popup.addEventListener('click', onPopupClick);
    select.addEventListener('input', refresh);
    select.addEventListener('change', refresh);
    select.addEventListener('invalid', onInvalid);
    select.addEventListener('click', stopNativeClick);
    const observer = new view.MutationObserver(records => {
        if (records.some(record => record.type !== 'attributes' || record.target !== select)) renderOptions();
        else refresh();
        if (open) position();
    });
    observer.observe(select, { attributes: true, childList: true, characterData: true, subtree: true });

    const originalFocus = Object.getOwnPropertyDescriptor(select, 'focus');
    const originalPicker = Object.getOwnPropertyDescriptor(select, 'showPicker');
    Object.defineProperty(select, 'focus', { configurable: true, value: options => trigger.focus(options) });
    Object.defineProperty(select, 'showPicker', { configurable: true, value: show });
    const controller = { select, root, trigger, popup, refresh, position, open: show, close, clearValidation,
        destroy() {
            close();
            disposed = true;
            observer.disconnect();
            restoreProperties(propertyRestores);
            restoreProperties(optionRestores);
            for (const [property, descriptor] of [['focus', originalFocus], ['showPicker', originalPicker]]) {
                if (descriptor) Object.defineProperty(select, property, descriptor);
                else delete select[property];
            }
            for (const [name, original] of originalAttributes) {
                if (original === null) select.removeAttribute(name);
                else select.setAttribute(name, original);
            }
            select.classList.remove('bp-ui-select-native');
            select.removeEventListener('input', refresh);
            select.removeEventListener('change', refresh);
            select.removeEventListener('invalid', onInvalid);
            select.removeEventListener('click', stopNativeClick);
            root.remove();
            mounted.delete(select);
            state.controllers.delete(controller);
            if (!state.controllers.size) { view.clearInterval(state.timer); state.timer = null; }
        } };
    mounted.set(select, controller);
    state.controllers.add(controller);
    select.classList.add('bp-ui-select-native');
    select.setAttribute('aria-hidden', 'true');
    select.tabIndex = -1;
    intercept(select, 'value', refresh, propertyRestores);
    intercept(select, 'selectedIndex', refresh, propertyRestores);
    renderOptions();
    if (wasFocused) trigger.focus({ preventScroll: true });
    // Native reset/autofill and collection/prototype setters do not emit DOM mutations.
    if (!state.timer) state.timer = view.setInterval(() => {
        for (const item of state.controllers) {
            if (!item.select.isConnected) item.destroy();
            else item.refresh();
        }
    }, 200);
    return controller;
}

export function observeCustomSelects(root = document) {
    const document = root.ownerDocument ?? root;
    const state = environment(document);
    const adopt = node => {
        if (node.matches?.('select')) mountCustomSelect(node);
        node.querySelectorAll?.('select').forEach(mountCustomSelect);
    };
    adopt(root);
    if (state.observing) return;
    state.observing = true;
    const observer = new document.defaultView.MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) adopt(node);
        for (const controller of state.controllers) {
            if (!controller.select.isConnected) controller.destroy();
            else if (records.some(record => !record.target.closest?.('.bp-ui-select') && !controller.select.contains(record.target))) controller.refresh();
        }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['disabled', 'hidden', 'inert', 'style', 'aria-label', 'aria-labelledby', 'aria-describedby'] });
}
