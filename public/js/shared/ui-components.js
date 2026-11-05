import { mountCustomSelect, observeCustomSelects } from './custom-select.js?v=custom-select-20261013';
import { observeInputClears } from './input-clear.js';
import { mountDisclosureChevron, observeDisclosureChevrons } from './disclosure-chevron.js';
import { observeTextareaAutosize } from './textarea-autosize.js';
export { createDisclosureChevron, mountDisclosureChevron, observeDisclosureChevrons } from './disclosure-chevron.js';
export { observeCustomSelects, handleCustomSelectKeydown } from './custom-select.js?v=custom-select-20261013';
export { mountInputClear, observeInputClears } from './input-clear.js';

// Controls share presentation while preserving their form and navigation semantics.
export const UI_COMPONENTS = Object.freeze(['action', 'segmented', 'field', 'disclosure', 'dialog']);

export function configureAction(element, { variant = 'quiet', iconOnly = false } = {}) {
    element.classList.add('bp-ui-action');
    element.dataset.uiVariant = variant;
    element.classList.toggle('is-icon-only', iconOnly);
    return element;
}

export function createAction({ label, icon, href, variant = 'quiet', iconOnly = false, className = '' }) {
    const element = document.createElement(href ? 'a' : 'button');
    if (href) element.href = href;
    else element.type = 'button';
    element.className = className;
    configureAction(element, { variant, iconOnly });
    if (icon) {
        const glyph = document.createElement('i');
        glyph.className = icon;
        glyph.setAttribute('aria-hidden', 'true');
        element.append(glyph);
    }
    if (iconOnly) {
        element.setAttribute('aria-label', label);
        element.dataset.tooltip = label;
    } else {
        const text = document.createElement('span');
        text.className = 'bp-ui-action-label';
        text.textContent = label;
        element.append(text);
    }
    return element;
}

export function createDisclosureTrigger({ name, detail = '', className = '' }) {
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = `bp-ui-disclosure ${className}`.trim();
    trigger.setAttribute('aria-expanded', 'false');
    const label = document.createElement('span');
    label.className = 'bp-ui-disclosure-label';
    const title = document.createElement('strong');
    title.textContent = name;
    label.append(title);
    if (detail) {
        const description = document.createElement('span');
        description.className = 'bp-benchmark-condition';
        description.textContent = detail;
        label.append(description);
    }
    trigger.append(label);
    mountDisclosureChevron(trigger);
    return trigger;
}

const segmentedControls = new WeakMap();

export function mountSegmentedControl(root, { presentation = true } = {}) {
    if (segmentedControls.has(root)) return segmentedControls.get(root);
    if (presentation) {
        root.classList.add('bp-ui-segmented');
        root.dataset.uiComponent = 'segmented';
    }
    let queued = false;
    let disposed = false;
    const refresh = () => {
        queued = false;
        if (disposed) return;
        const selected = [...root.children].find(child => child.matches('button')
            && (child.getAttribute('aria-selected') === 'true' || child.getAttribute('aria-pressed') === 'true'));
        if (!selected || !root.clientWidth) return;
        root.style.setProperty('--ui-segment-x', `${selected.offsetLeft}px`);
        root.style.setProperty('--ui-segment-width', `${selected.offsetWidth}px`);
        root.dataset.uiReady = 'true';
    };
    const queueRefresh = () => {
        if (queued || disposed) return;
        queued = true;
        window.queueMicrotask(refresh);
    };
    const resize = new window.ResizeObserver(queueRefresh);
    resize.observe(root);
    for (const child of root.children) if (child.matches('button')) resize.observe(child);
    const selection = new MutationObserver(queueRefresh);
    selection.observe(root, { attributes: true, subtree: true, attributeFilter: ['aria-selected', 'aria-pressed', 'hidden'] });
    const controller = {
        refresh,
        destroy() {
            disposed = true;
            resize.disconnect();
            selection.disconnect();
            segmentedControls.delete(root);
        }
    };
    segmentedControls.set(root, controller);
    refresh();
    return controller;
}

const ACTION_ADAPTERS = [
    ['.bp-quiet-action, .bp-inline-link, .bp-sidebar-action, .bp-how-primary-link, .contribution-guide a, .quiet-button', 'quiet'],
    ['.add-row-button, .bp-error-state button', 'secondary'],
    ['.primary-button', 'primary'],
    ['.soft-icon-button, .bp-navigation-search-toggle', 'quiet', true]
];

export function enhanceUI(root = document) {
    for (const [selector, variant, iconOnly = false] of ACTION_ADAPTERS) {
        root.querySelectorAll(selector).forEach(element => configureAction(element, { variant,
            iconOnly: iconOnly || (!element.textContent.trim() && Boolean(element.querySelector('i, svg'))) }));
    }
    root.querySelectorAll('[data-ui-component="segmented"]').forEach(mountSegmentedControl);
    root.querySelectorAll('.bp-benchmark-search, .bp-navigation-search, .bp-model-scores-search, .picker-search, .bp-filter-search-wrap')
        .forEach(element => element.classList.add('bp-ui-field'));
    root.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="hidden"]):not([type="file"]):not([type="color"]):not([type="submit"]):not([type="button"]), textarea, select')
        .forEach(element => element.classList.add('bp-ui-input'));
    if (root.matches?.('select')) mountCustomSelect(root);
    observeCustomSelects(root);
    observeInputClears(root);
    observeDisclosureChevrons(root);
}

// Some pages compose primitives without calling enhanceUI for their whole document.
if (typeof document !== 'undefined') {
    const observe = () => { observeInputClears(); observeDisclosureChevrons(); observeTextareaAutosize(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe, { once: true });
    else observe();
}
