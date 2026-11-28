import { configureAction, createAction } from '../shared/ui-components.js';
import { searchItems } from '../shared/search.js';

const pageSize = 24;
const searchFields = version => [version.name, version.versionLabel, ...(version.tags ?? [])];

export function createExternalVersionPicker({ trigger, scrollAnchor, onChoose }) {
    const panel = document.createElement('section');
    panel.id = 'external-version-picker';
    panel.className = 'bp-external-version-picker';
    panel.setAttribute('aria-label', 'Choose an external version');
    panel.hidden = true;
    const content = document.createElement('div');
    content.className = 'bp-external-version-picker-content';
    const hint = document.createElement('p');
    hint.textContent = 'Choose a version to support it. Select Add version again to close.';
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Search benchmarks or versions…';
    search.setAttribute('aria-label', 'Search benchmarks or versions');
    const results = document.createElement('div');
    results.className = 'bp-external-version-results';
    const list = document.createElement('ul');
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', 'Versions available to nominate');
    const empty = document.createElement('p');
    empty.textContent = 'No matching versions.';
    empty.setAttribute('role', 'status');
    const more = createAction({ label: 'Show more versions' });
    results.append(list, empty, more);
    content.append(hint, search, results);
    panel.append(content);

    let current = { versions: [], nominatedIDs: new Set(), disabled: true }, limit = pageSize;
    trigger.setAttribute('aria-controls', panel.id);
    trigger.setAttribute('aria-expanded', 'false');

    function close({ restoreFocus = false } = {}) {
        if (panel.hidden) return;
        panel.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        search.value = '';
        limit = pageSize;
        if (restoreFocus && !trigger.hidden) trigger.focus({ preventScroll: true });
    }

    function render() {
        const query = search.value.trim();
        const matches = (query ? searchItems(current.versions, query, searchFields) : current.versions)
            .filter(version => !current.nominatedIDs.has(version.conditionID));
        list.replaceChildren(...matches.slice(0, limit).map(version => {
            const item = document.createElement('li');
            item.dataset.conditionId = String(version.conditionID);
            const action = configureAction(document.createElement('button'));
            action.type = 'button';
            action.setAttribute('aria-label', `Nominate ${version.name}, ${version.versionLabel}`);
            action.disabled = current.disabled;
            action.classList.add('bp-external-version-option');
            const identity = document.createElement('span');
            const benchmark = document.createElement('strong');
            benchmark.textContent = version.name;
            const label = document.createElement('small');
            label.textContent = version.versionLabel;
            identity.append(benchmark, label);
            const glyph = document.createElement('i');
            glyph.className = 'fa-solid fa-plus';
            glyph.setAttribute('aria-hidden', 'true');
            action.append(identity, glyph);
            action.addEventListener('click', () => {
                if (onChoose(version)) close({ restoreFocus: true });
            });
            item.append(action);
            return item;
        }));
        empty.hidden = matches.length > 0;
        more.hidden = matches.length <= limit;
    }

    trigger.addEventListener('click', () => {
        if (!panel.hidden) { close({ restoreFocus: true }); return; }
        if (current.disabled) return;
        panel.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        render();
        content.scrollTop = 0;
        scrollAnchor?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        search.focus({ preventScroll: true });
    });
    search.addEventListener('input', () => {
        limit = pageSize;
        render();
        content.scrollTop = 0;
    });
    more.addEventListener('click', () => {
        const firstNewIndex = limit;
        limit += pageSize;
        render();
        list.children[firstNewIndex]?.firstElementChild.focus();
    });
    panel.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        close({ restoreFocus: true });
    });
    trigger.addEventListener('keydown', event => {
        if (panel.hidden || event.key !== 'Escape') return;
        event.preventDefault();
        close();
    });

    return { panel, close, update(versions, nominatedIDs, disabled) {
        current = { versions, nominatedIDs, disabled };
        trigger.disabled = disabled && panel.hidden;
        if (!panel.hidden) render();
    } };
}
