import { mountCustomSelect } from '../shared/custom-select.js?v=custom-select-20261013';
import { topicCollections } from './collections.js';

// Search replaces the select in its own slot. Focusing during the selection
// gesture also opens the software keyboard on iOS.
export function mountTopicCollectionPicker(host, { onSelect, onQuery, onResults }) {
    const select = host.querySelector('select');
    const editor = host.querySelector('.bp-topic-query');
    const input = editor.querySelector('input');
    const action = editor.querySelector('button');
    for (const [key, label] of Object.entries(topicCollections)) {
        const option = document.createElement('option');
        option.value = key; option.textContent = label;
        select.append(option);
    }
    const control = mountCustomSelect(select);
    control.popup.classList.add('bp-topic-collection-options');
    let current = 'popular', previous = 'popular';

    function updateAction() {
        const label = input.value ? 'Clear search' : 'Close search';
        action.setAttribute('aria-label', label);
        action.dataset.tooltip = label;
    }
    function setView(view, { focus = false } = {}) {
        if (view === 'search' && current !== 'search') previous = current;
        current = view;
        const searching = current === 'search';
        select.value = current;
        select.hidden = searching;
        control.refresh();
        editor.hidden = !searching;
        if (!searching) input.value = '';
        updateAction();
        if (focus) (searching ? input : control.trigger).focus({ preventScroll: true });
    }
    function exitSearch() { onSelect(previous, { focus: true }); }
    select.addEventListener('change', () => onSelect(select.value, { focus: true }));
    input.addEventListener('input', () => { updateAction(); onQuery(); });
    action.addEventListener('click', () => {
        if (!input.value) { exitSearch(); return; }
        input.value = '';
        updateAction(); onQuery();
        input.focus({ preventScroll: true });
    });
    editor.addEventListener('keydown', event => {
        if (event.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); exitSearch(); }
        if (event.key === 'ArrowDown' && onResults?.()) event.preventDefault();
    });
    return { setView, input, exitSearch };
}
