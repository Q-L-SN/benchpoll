import { createFloatingSearchLayer } from './floating-search-layer.js';

export function createModelSearch({ container, search, onSelect, label = 'Search models' }) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'bp-model-search-toggle';
    button.setAttribute('aria-label', label); button.dataset.tooltip = label;
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = '<i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>';
    const panel = document.createElement('div'); panel.className = 'bp-model-search-panel'; panel.hidden = true;
    const input = document.createElement('input');
    input.type = 'search'; input.maxLength = 120; input.autocomplete = 'off'; input.placeholder = label;
    input.setAttribute('aria-label', label); input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-expanded', 'false');
    const list = document.createElement('div'); list.className = 'bp-model-search-results';
    list.id = `model-search-results-${Math.random().toString(36).slice(2)}`;
    list.setAttribute('role', 'listbox'); input.setAttribute('aria-controls', list.id);
    list.setAttribute('aria-label', label);
    panel.id = `${list.id}-panel`; panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', label);
    button.setAttribute('aria-controls', panel.id);
    const status = document.createElement('p'); status.className = 'bp-model-search-status'; status.setAttribute('role', 'status');
    panel.append(input, list, status); container.append(button, panel);
    let timer, controller, sequence = 0, items = [], active = -1;
    const toolbar = container.closest('.th-filter-bar');
    const layer = createFloatingSearchLayer({ anchor: button, panel,
        getAnchorRect: () => (toolbar ?? button).getBoundingClientRect(), align: toolbar ? 'start' : 'end', onClose: reset });

    function reset() {
        ++sequence; clearTimeout(timer); controller?.abort(); controller = null;
        button.setAttribute('aria-expanded', 'false');
        input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
        list.replaceChildren(); status.textContent = ''; items = []; active = -1;
    }
    function close() { layer.close(); }
    function activate(index) {
        const nodes = [...list.children];
        active = Math.max(-1, Math.min(index, nodes.length - 1));
        nodes.forEach((node, item) => node.setAttribute('aria-selected', String(item === active)));
        if (active < 0) input.removeAttribute('aria-activedescendant');
        else {
            input.setAttribute('aria-activedescendant', nodes[active].id);
            const bounds = nodes[active].getBoundingClientRect(), viewport = list.getBoundingClientRect();
            if (bounds.top < viewport.top) list.scrollTop -= viewport.top - bounds.top;
            else if (bounds.bottom > viewport.bottom) list.scrollTop += bounds.bottom - viewport.bottom;
        }
    }
    function choose(item) {
        close(); onSelect(item); button.focus({ preventScroll: true });
    }
    function render(results) {
        items = results; list.replaceChildren(); active = -1;
        results.forEach((item, index) => {
            const option = document.createElement('button'); option.type = 'button'; option.className = 'bp-model-search-option';
            option.tabIndex = -1;
            option.id = `${list.id}-${index}`; option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false');
            for (const part of item.parts) {
                const text = document.createElement('span'); text.className = part.kind === 'parameter' ? 'bp-model-search-parameter' : 'bp-model-search-name';
                if (part.icon && /^fa-[a-z0-9-]+$/.test(part.icon)) {
                    const icon = document.createElement('i'); icon.className = `fa-solid ${part.icon}`; icon.setAttribute('aria-hidden', 'true'); text.append(icon);
                }
                const value = document.createElement('span'); value.textContent = part.text; text.append(value);
                if (part.title) text.dataset.tooltip = part.title;
                option.append(text);
            }
            option.addEventListener('click', () => choose(item)); list.append(option);
        });
        input.setAttribute('aria-expanded', String(results.length > 0));
        status.textContent = results.length ? '' : 'No matching models.';
        layer.reposition();
    }
    function update() {
        ++sequence; clearTimeout(timer); controller?.abort(); controller = null;
        list.replaceChildren(); input.removeAttribute('aria-activedescendant');
        input.setAttribute('aria-expanded', 'false'); items = []; active = -1;
        const value = input.value.trim();
        if (!value) { status.textContent = ''; return; }
        const current = sequence;
        status.textContent = 'Searching...';
        timer = setTimeout(async () => {
            controller = new globalThis.AbortController();
            try {
                const results = await search(value, { signal: controller.signal });
                if (current !== sequence || panel.hidden) return;
                if (!Array.isArray(results) || results.length > 10 || results.some(item => !item
                    || typeof item.targetModel !== 'string' || !Array.isArray(item.parts)
                    || item.parts.some(part => !part || typeof part.text !== 'string'))) throw new TypeError('Invalid model search results');
                render(results);
            } catch (error) {
                if (current === sequence && !panel.hidden && error?.name !== 'AbortError') status.textContent = 'Could not search models. Try again.';
            }
        }, 180);
    }
    button.addEventListener('click', () => {
        if (layer.isOpen) { close(); return; }
        if (!layer.open()) return;
        button.setAttribute('aria-expanded', 'true'); input.focus({ preventScroll: true });
        if (input.value.trim()) update();
    });
    input.addEventListener('input', update);
    input.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' && items.length) { event.preventDefault(); activate(active + 1); }
        else if (event.key === 'ArrowUp' && items.length) { event.preventDefault(); activate(active < 0 ? items.length - 1 : active - 1); }
        else if (event.key === 'Enter' && active >= 0) { event.preventDefault(); choose(items[active]); }
    });
    return { close, refresh() { if (layer.isOpen) update(); }, destroy() { layer.destroy(); reset(); button.remove(); panel.remove(); } };
}
