import { topicCollections } from './collections.js';

const sorts = Object.keys(topicCollections).filter(view => view !== 'search');

export function mountTopicCollectionPicker(host, { onSelect, onQuery, onResults }) {
    const trigger = host.querySelector('.bp-collection-trigger');
    const label = trigger.firstElementChild;
    const list = host.querySelector('[role="listbox"]');
    const editor = host.querySelector('.bp-topic-query');
    const input = editor.querySelector('input');
    const action = editor.querySelector('button');
    const surface = host.closest('[data-collection-surface]');
    const backdrop = document.createElement('div');
    backdrop.className = 'bp-collection-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.dataset.sidebarSwipe = 'ignore';
    surface.append(backdrop);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let current = 'popular', previous = 'popular', active = null, flight = null;
    let available = ['search'];
    let typed = '', lastTyped = 0;

    function stopFlight() {
        if (!flight) return;
        flight.animation.cancel();
        flight.text.remove();
        host.classList.remove('is-landing');
        flight = null;
    }

    function positionList() {
        if (list.inert) return;
        const anchor = host.getBoundingClientRect(), backdropBounds = backdrop.getBoundingClientRect();
        if (!anchor.height || surface.inert) { close(); return; }
        const viewport = window.visualViewport;
        const top = Math.max(viewport?.offsetTop ?? 0, backdropBounds.top);
        const bottom = Math.min(viewport ? viewport.offsetTop + viewport.height : window.innerHeight, backdropBounds.bottom);
        const below = bottom - anchor.bottom, above = anchor.top - top;
        const openAbove = below < list.scrollHeight && above > below;
        list.toggleAttribute('data-above', openAbove);
        list.style.setProperty('--bp-collection-room', Math.max(0, (openAbove ? above : below) - 4) + 'px');
    }

    function highlight(option) {
        active?.classList.remove('is-active');
        active = option;
        active.classList.toggle('is-active', active.dataset.view !== current);
        trigger.setAttribute('aria-activedescendant', active.id);
        if (active.dataset.view === current) { list.scrollTop = 0; return; }
        const row = active.getBoundingClientRect(), bounds = list.getBoundingClientRect();
        list.scrollTop += row.top < bounds.top ? row.top - bounds.top : Math.max(0, row.bottom - bounds.bottom);
    }

    function renderOptions(preferred = current) {
        const keys = available.includes(current) ? [current, ...available.filter(key => key !== current)] : available;
        list.replaceChildren(...keys.map(key => {
            const option = document.createElement('div'), text = document.createElement('span');
            option.id = list.id + '-' + key;
            option.className = 'bp-collection-option';
            option.dataset.view = key;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', String(key === current));
            text.textContent = topicCollections[key];
            option.append(text);
            return option;
        }));
        positionList();
        if (!list.inert) highlight(list.children[keys.indexOf(preferred)] ?? list.firstElementChild);
    }

    function open() {
        stopFlight();
        list.inert = false;
        surface.classList.add('is-choosing-collection');
        trigger.setAttribute('aria-expanded', 'true');
        trigger.focus({ preventScroll: true });
        renderOptions();
    }

    function close() {
        list.inert = true;
        active = null;
        typed = '';
        trigger.removeAttribute('aria-activedescendant');
        trigger.setAttribute('aria-expanded', 'false');
        surface.classList.remove('is-choosing-collection');
    }

    function updateAction() {
        const name = input.value ? 'Clear search' : 'Close search';
        action.setAttribute('aria-label', name);
        action.dataset.tooltip = name;
        action.hidden = !input.value && available.length === 1;
    }
    function setAvailability(status) {
        const next = [...sorts.filter(view => status[view] === true), 'search'];
        const changed = next.length !== available.length || next.some((view, index) => view !== available[index]);
        available = next;
        // Undefined means the data is still pending or unavailable. Omit those options
        // from the list, but give a previously selected view time to load.
        if (current !== 'search' && status[current] === false && (available.length > 1 || sorts.every(view => status[view] === false))) {
            onSelect(available[0], { focus: host.contains(document.activeElement) });
            return true;
        }
        if (changed) {
            updateAction();
            if (!list.inert) renderOptions(active?.dataset.view);
        }
        return false;
    }
    function setView(view, { focus = false } = {}) {
        stopFlight();
        close();
        if (view === 'search' && current !== 'search') previous = current;
        current = view;
        const searching = view === 'search';
        label.textContent = topicCollections[view];
        trigger.hidden = searching;
        editor.hidden = !searching;
        if (!searching) input.value = '';
        updateAction();
        if (focus) (searching ? input : trigger).focus({ preventScroll: true });
    }
    function clearQuery() {
        input.value = '';
        updateAction();
        onQuery();
        input.focus({ preventScroll: true });
    }

    function exitSearch() {
        const next = available.includes(previous) ? previous : available[0];
        if (next !== 'search') onSelect(next, { focus: true });
        else if (input.value) clearQuery();
    }

    function choose(option) {
        const view = option.dataset.view;
        if (view === current) { close(); return; }
        const text = option.firstElementChild, start = text.getBoundingClientRect();
        // Keep focus inside the activation gesture so choosing Search opens the iOS keyboard.
        onSelect(view, { focus: true });
        if (reduced.matches) return;
        // Carry the actual word to the anchor after filtering has settled the layout.
        text.className = 'bp-collection-flight';
        text.setAttribute('aria-hidden', 'true');
        text.toggleAttribute('data-search', view === 'search');
        host.append(text);
        host.classList.add('is-landing');
        const end = text.getBoundingClientRect();
        const x = start.left - end.left, y = (start.top + start.bottom - end.top - end.bottom) / 2;
        const animation = text.animate([{ transform: 'translate(' + x + 'px,' + y + 'px)' }, { transform: 'none' }],
            { duration: 240, easing: 'cubic-bezier(.22,.75,.25,1)' });
        flight = { text, animation };
        animation.onfinish = () => { if (flight?.animation === animation) stopFlight(); };
    }

    trigger.addEventListener('click', () => { if (list.inert) open(); else close(); });
    trigger.addEventListener('keydown', event => {
        const { key } = event;
        if (event.isComposing || event.ctrlKey || event.metaKey) return;
        if (key === 'Tab') { close(); return; }
        if (key === 'Escape' && !list.inert) { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (active && (key === 'Enter' || key === ' ' || key === 'ArrowUp' && event.altKey)) {
            event.preventDefault(); choose(active); return;
        }
        const typing = key.length === 1 && key !== ' ' && !event.altKey;
        if (!typing && !['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageUp', 'PageDown'].includes(key)) return;
        event.preventDefault();
        if (list.inert) open();
        if (!active) return;
        const options = [...list.children], index = options.indexOf(active);
        if (typing) {
            const letter = key.toLocaleLowerCase(), now = performance.now();
            const cycle = now - lastTyped > 650 || typed === letter || !typed;
            typed = cycle ? letter : typed + letter;
            lastTyped = now;
            const start = index + Number(cycle);
            const match = [...options.slice(start), ...options.slice(0, start)]
                .find(option => option.textContent.toLocaleLowerCase().startsWith(typed));
            if (match) highlight(match);
            return;
        }
        typed = '';
        const next = ['Home', 'PageUp'].includes(key) ? 0 : ['End', 'PageDown'].includes(key) ? options.length - 1
            : (index + (key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        highlight(options[next]);
    });
    list.addEventListener('pointerdown', event => { if (event.pointerType === 'mouse') event.preventDefault(); });
    list.addEventListener('click', event => {
        const option = event.target.closest('[role="option"]');
        if (option && !list.inert) choose(option);
    });
    backdrop.addEventListener('pointerdown', event => event.preventDefault());
    document.addEventListener('click', event => { if (!list.inert && !host.contains(event.target)) close(); }, true);
    host.addEventListener('focusout', event => { if (event.relatedTarget && !host.contains(event.relatedTarget)) close(); });
    new ResizeObserver(positionList).observe(host);
    window.addEventListener('resize', positionList);
    window.visualViewport?.addEventListener('resize', positionList);
    document.addEventListener('scroll', event => { if (event.target !== list) positionList(); }, { capture: true, passive: true });

    input.addEventListener('input', () => { stopFlight(); updateAction(); onQuery(); });
    action.addEventListener('click', () => {
        if (input.value) clearQuery();
        else exitSearch();
    });
    editor.addEventListener('keydown', event => {
        if (event.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); exitSearch(); }
        if (event.key === 'ArrowDown' && onResults?.()) event.preventDefault();
    });
    return { setView, setAvailability, input, exitSearch };
}
