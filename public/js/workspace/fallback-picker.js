import { setLoading } from '../shared/loading.js';
import { familyKey } from '../shared/benchmark-families.js';
import { COMMUNITY_FALLBACK_EXPLANATION } from '../shared/fallback-choice.js';
import { createBenchmarkInformationLink } from './benchmark-link.js';
import { setHelpText } from '../shared/help-popover.js?v=help-popovers-20261008';
import { createFallbackPickerScroll } from './fallback-picker-scroll.js?v=fallback-picker-20261008';
import { createAction, configureAction } from '../shared/ui-components.js';
import { AA_EXCLUSION_MESSAGE, excludedFromRanking } from '../shared/aa-ranking-policy.js';

const element = (tag, className = '', text) => {
    const node = document.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};
const button = (className, label, icon) => {
    const node = element('button', className); node.type = 'button';
    if (icon) {
        const glyph = element('i', `fa-solid fa-${icon}`); glyph.setAttribute('aria-hidden', 'true'); node.append(glyph);
    }
    if (label) node.append(element('span', '', label));
    return node;
};
const percentage = points => points > 0 && points < 1 ? '<0.01%' : `${Number((points / 100).toFixed(2))}%`;

export function fallbackPickerChoices(primary, { catalogue, composition, current = null, action = 'add' }) {
    const shares = new Map((composition?.isDefault ? [] : composition?.families ?? []).map(family => [familyKey(primary.ID, family.entries), family.weightBasisPoints]));
    const choices = new Map();
    const add = (entries, familyID, featured = false, custom = false, selectionSource = 'selected') => {
        const key = familyKey(primary.ID, entries);
        if (!choices.has(key)) choices.set(key, { key, entries, familyID, featured, custom, selectionSource,
            shareBasisPoints: shares.has(key) ? shares.get(key) : composition || !entries.length ? 0 : null });
    };
    if (action === 'replace' && current) add(current.entries, current.familyID ?? null, false, true, current.selectionSource);
    for (const row of catalogue.featured) if (row.familyEntries.length) add(row.familyEntries, row.familyID, true);
    for (const row of catalogue.items) if (row.familyEntries.length) add(row.familyEntries, row.familyID);
    for (const family of composition?.families ?? []) add(family.entries, family.familyID ?? null);
    add([], null);
    const currentKey = action === 'replace' && current ? familyKey(primary.ID, current.entries) : null;
    return [...choices.values()].sort((a, b) => Number(b.key === currentKey) - Number(a.key === currentKey)
        || (b.shareBasisPoints ?? 0) - (a.shareBasisPoints ?? 0));
}

export function createFallbackPicker({ catalogue, getScope, getPrimary, getComposition, getCurrent, canApply, onApply, onCustomize,
    getMemberURL, onInspectVersion }) {
    const dialog = element('global-dialog', 'bp-fallback-picker'); dialog.id = 'fallback-picker'; dialog.hidden = true;
    const heading = element('div', 'bp-fallback-picker-heading'); heading.slot = 'title';
    const title = element('span', '', 'Choose fallback configuration');
    heading.append(title);
    const closeButton = button('dialog-close-button bp-fallback-picker-close', '', 'xmark');
    closeButton.setAttribute('aria-label', 'Close fallback chooser'); heading.append(closeButton);
    const body = element('div', 'bp-fallback-picker-body'); body.slot = 'body';
    const question = element('p', 'bp-fallback-picker-question');
    const selectionStatus = element('p', 'bp-fallback-picker-selection-status');
    selectionStatus.setAttribute('role', 'status');
    selectionStatus.setAttribute('aria-live', 'polite');
    const toolbar = element('div', 'bp-fallback-picker-toolbar');
    const help = button('bp-help-trigger', '', 'circle-question');
    help.querySelector('i').className = 'fa-regular fa-circle-question';
    help.setAttribute('aria-label', 'About fallback configuration shares');
    setHelpText(help, 'Only explicit choices shape community shares, weighted by each person\'s allocation to this benchmark. Following the community is not a vote. No fallback is an explicit choice; missing-score estimation remains separate.');
    const electorate = element('span', 'bp-fallback-picker-electorate');
    const navigation = element('div', 'bp-fallback-picker-navigation');
    const previous = button('bp-fallback-picker-arrow', '', 'chevron-left'); previous.setAttribute('aria-label', 'Previous fallback order');
    const next = button('bp-fallback-picker-arrow', '', 'chevron-right'); next.setAttribute('aria-label', 'Next fallback order');
    navigation.append(previous, next); toolbar.append(help, electorate, navigation);
    const shell = element('div', 'bp-fallback-picker-columns-shell');
    const viewport = element('div', 'bp-fallback-picker-viewport');
    const track = element('div', 'bp-fallback-picker-columns'); track.setAttribute('role', 'list');
    track.setAttribute('aria-label', 'Fallback orders'); viewport.append(track); shell.append(viewport);
    const feedback = element('div', 'bp-fallback-picker-feedback');
    const status = element('span', 'bp-fallback-picker-status'); status.setAttribute('role', 'status');
    const more = button('bp-fallback-picker-more', 'More configurations', 'plus');
    feedback.append(status, more); body.append(question, selectionStatus, toolbar, shell, feedback);
    const actions = element('div', 'bp-fallback-picker-actions'); actions.slot = 'actions';
    const cancel = createAction({ className: 'bp-fallback-picker-cancel', label: 'Close' });
    const customAdd = createAction({ className: 'bp-fallback-picker-custom-add', label: 'Skip fallback or create my own', variant: 'primary' });
    const customize = createAction({ className: 'bp-fallback-picker-customize', label: 'Create my own', icon: 'fa-regular fa-pen-to-square', variant: 'quiet' });
    customize.hidden = true;
    customAdd.hidden = true;
    actions.append(customize, cancel, customAdd); dialog.append(heading, body, actions); document.body.append(dialog);
    const scrolling = createFallbackPickerScroll({ shell, viewport, track, previous, next });
    let intent = null;
    const sessionChoices = new Map();
    let renderedKey = '';
    let applying = false;
    let applyError = '';
    let returnFocus = null;

    function close({ restore = true } = {}) {
        const focus = returnFocus; intent = null; applying = false; renderedKey = '';
        dialog.returnFocus = null; dialog.hidden = true;
        if (restore) requestAnimationFrame(() => {
            const target = focus?.();
            if (target?.isConnected && !target.disabled && !target.closest('[hidden], [inert]')) target.focus({ preventScroll: true });
        });
    }
    function validPrimary() {
        if (!intent || dialog.hidden || getScope() !== intent.scope) return null;
        return getPrimary(intent.primary.ID) ?? intent.primary;
    }
    function choicesFor(primary) {
        const choices = fallbackPickerChoices(primary, { catalogue: catalogue.view(primary), composition: getComposition(primary.ID),
            current: getCurrent(primary.ID), action: intent.action });
        if (intent.action !== 'replace') return choices;
        // Keep cards in place, including a custom order after its selection is cleared.
        for (const choice of choices) sessionChoices.set(choice.key, { ...choice,
            initialShare: sessionChoices.get(choice.key)?.initialShare ?? choice.shareBasisPoints ?? 0,
            selectionSource: sessionChoices.get(choice.key)?.selectionSource === 'custom' ? 'custom' : choice.selectionSource });
        return [...sessionChoices.values()].sort((a, b) => Number(b.key === intent.openingChoice) - Number(a.key === intent.openingChoice)
            || b.initialShare - a.initialShare);
    }
    function updateSelection() {
        const primary = validPrimary();
        const current = primary ? getCurrent(primary.ID) : null;
        const currentKey = current ? familyKey(primary.ID, current.entries) : null;
        selectionStatus.hidden = intent.action === 'view';
        selectionStatus.dataset.selection = currentKey ? 'manual' : 'community';
        selectionStatus.textContent = currentKey
            ? current.selectionSource === 'custom' ? 'Using your custom fallback configuration.'
                : current.entries.length ? 'Using your selected fallback configuration.' : 'You have chosen not to use fallback.'
            : COMMUNITY_FALLBACK_EXPLANATION;
        for (const column of track.children) {
            const selected = intent.action === 'replace' && column.dataset.familyKey === currentKey;
            column.classList.toggle('is-selected', selected);
            const add = column.querySelector('.bp-fallback-picker-card-add');
            if (add) add.disabled = applying || !primary || !canApply(primary.ID, intent.action);
            const toggle = column.querySelector('.bp-fallback-picker-card-toggle');
            if (toggle) {
                toggle.disabled = applying || !primary || !canApply(primary.ID, intent.action);
                toggle.setAttribute('aria-pressed', String(selected));
                if (column.dataset.excluded === 'true' && !selected) toggle.setAttribute('aria-disabled', 'true');
                else toggle.removeAttribute('aria-disabled');
                toggle.setAttribute('aria-label', `${selected ? 'Deselect' : 'Use'} ${column.dataset.choiceName}`);
                toggle.querySelector('span').textContent = selected ? 'Selected' : 'Use configuration';
                toggle.querySelector('i').className = selected ? 'fa-solid fa-check' : 'fa-solid fa-plus';
                configureAction(toggle, { variant: selected ? 'primary' : 'secondary' });
            }
        }
        if (intent.action === 'view') { cancel.disabled = false; return; }
        customAdd.disabled = applying || !primary || !canApply(primary.ID, intent.action);
        customize.disabled = applying || !primary || !canApply(primary.ID, intent.action);
        customize.hidden = intent.action !== 'replace' || current?.selectionSource === 'custom';
        cancel.disabled = applying;
    }

    function createColumn(primary, choice, index) {
        const column = element('section', 'bp-fallback-picker-column'); column.dataset.familyKey = choice.key;
        const excluded = excludedFromRanking(primary) || choice.entries.some(excludedFromRanking);
        column.dataset.excluded = String(excluded);
        column.setAttribute('role', 'listitem');
        const label = element('div', 'bp-fallback-picker-column-heading');
        if (excluded) column.dataset.tooltip = AA_EXCLUSION_MESSAGE;
        const order = index + 1;
        const name = !choice.entries.length ? 'No fallback' : choice.selectionSource === 'custom' ? 'Your configuration' : `Order ${order}`;
        column.dataset.choiceName = name;
        const title = element('span', 'bp-fallback-picker-column-title');
        title.append(element('strong', '', name));
        const badge = choice.featured ? 'Popular' : '';
        if (badge) title.append(element('span', 'bp-fallback-picker-badge', badge));
        const share = element('span', 'bp-fallback-picker-share');
        share.append(element('strong', '', choice.shareBasisPoints === null ? 'No explicit share' : percentage(choice.shareBasisPoints)));
        if (choice.shareBasisPoints !== null) share.append(element('small', '', 'Community share'));
        label.append(title, share);
        const list = element('ol', 'bp-fallback-picker-steps bp-fallback-chain');
        list.setAttribute('role', 'list');
        list.setAttribute('aria-label', `${name}: entrance, then fallback steps`); list.tabIndex = 0;
        [primary, ...choice.entries].forEach(entry => {
            const item = element('li', 'bp-fallback-chain-step');
            const identity = element('span', 'bp-fallback-picker-step-name');
            identity.append(createBenchmarkInformationLink(entry, { getURL: getMemberURL,
                onInspect: event => { close({ restore: false }); onInspectVersion?.(event); } }));
            item.append(identity); list.append(item);
        });
        column.append(label, list);
        if (intent.action === 'add') {
            const add = createAction({ className: 'bp-fallback-picker-card-add', label: 'Add', icon: 'fa-solid fa-plus', variant: 'primary' });
            add.setAttribute('aria-label', `Add benchmark with ${name.toLowerCase()}${excluded ? `. ${AA_EXCLUSION_MESSAGE}` : ''}`);
            if (excluded) { add.setAttribute('aria-disabled', 'true'); add.dataset.tooltip = AA_EXCLUSION_MESSAGE; }
            add.addEventListener('click', () => {
                const activePrimary = validPrimary();
                if (!activePrimary || intent.action !== 'add' || add.disabled || excluded) return;
                const activeChoice = choicesFor(activePrimary).find(candidate => candidate.key === choice.key);
                void applyChoice(activeChoice);
            });
            column.append(add);
        }
        if (intent.action === 'replace') {
            const toggle = createAction({ className: 'bp-fallback-picker-card-toggle', label: 'Use configuration',
                icon: 'fa-solid fa-plus' });
            if (excluded) { toggle.setAttribute('aria-disabled', 'true'); toggle.dataset.tooltip = AA_EXCLUSION_MESSAGE; }
            toggle.addEventListener('click', () => {
                const activePrimary = validPrimary();
                if (!activePrimary || intent.action !== 'replace' || toggle.disabled) return;
                const current = getCurrent(activePrimary.ID);
                const selected = current && familyKey(activePrimary.ID, current.entries) === choice.key;
                if (!selected && excluded) return;
                void applyChoice(selected ? { community: true, entries: [] }
                    : choicesFor(activePrimary).find(candidate => candidate.key === choice.key));
            });
            column.append(toggle);
        }
        return column;
    }

    function refresh() {
        if (!intent || dialog.hidden) return;
        const primary = validPrimary();
        if (!primary) { close(); return; }
        const view = catalogue.view(primary), choices = choicesFor(primary);
        const current = getCurrent(primary.ID);
        const currentKey = current ? familyKey(primary.ID, current.entries) : 'community';
        const signature = JSON.stringify([primary.name, primary.conditionName, currentKey,
            choices.map(choice => [choice.key, choice.entries, choice.shareBasisPoints, choice.featured, choice.custom, choice.selectionSource])]);
        if (renderedKey !== signature) {
            const oldFocus = track.contains(document.activeElement) ? document.activeElement : null;
            const focusKey = oldFocus?.closest('.bp-fallback-picker-column')?.dataset.familyKey;
            const focusAdd = oldFocus?.classList.contains('bp-fallback-picker-card-add');
            const focusToggle = oldFocus?.classList.contains('bp-fallback-picker-card-toggle');
            const scrolls = new Map([...track.children].map(column => [column.dataset.familyKey,
                column.querySelector('.bp-fallback-picker-steps').scrollTop]));
            const horizontal = viewport.scrollLeft, vertical = viewport.scrollTop;
            track.replaceChildren(...choices.map((choice, index) => createColumn(primary, choice, index)));
            for (const column of track.children) column.querySelector('.bp-fallback-picker-steps').scrollTop = scrolls.get(column.dataset.familyKey) ?? 0;
            viewport.scrollLeft = horizontal; viewport.scrollTop = vertical;
            if (focusKey) {
                const column = [...track.children].find(node => node.dataset.familyKey === focusKey);
                column?.querySelector(focusToggle ? '.bp-fallback-picker-card-toggle' : focusAdd ? '.bp-fallback-picker-card-add' : '.bp-fallback-picker-steps')?.focus({ preventScroll: true });
            }
            renderedKey = signature;
        }
        question.replaceChildren(createBenchmarkInformationLink(primary, { getURL: getMemberURL,
            onInspect: event => { close({ restore: false }); onInspectVersion?.(event); } }));
        const count = getComposition(primary.ID)?.configuredPieCount ?? 0;
        electorate.textContent = count ? `${count} explicit ${count === 1 ? 'choice' : 'choices'}` : 'No community choices yet';
        if (!applyError && (view.loading || view.suspended)) setLoading(status, view.suspended ? 'Refreshing configurations' : 'Loading configurations');
        else status.textContent = applyError || view.error || (!choices.length && !view.hasMore ? 'No fallback configurations yet.' : '');
        more.hidden = !view.hasMore && !view.error;
        more.disabled = view.loading || view.suspended;
        more.querySelector('span').textContent = view.error && !view.suspended ? 'Retry' : 'More configurations';
        const recommended = view.featured.some(row => row.familyEntries.length > 0);
        customAdd.hidden = intent.action !== 'add';
        configureAction(customAdd, { variant: recommended ? 'quiet' : 'primary' });
        customAdd.querySelector('span').textContent = `Skip fallback or create my own${recommended ? ' (not recommended)' : ''}`;
        shell.setAttribute('aria-busy', String(view.loading));
        updateSelection(); scrolling.refresh();
    }

    function open(primary, { action = 'add', getReturnFocus } = {}) {
        returnFocus = getReturnFocus ?? (() => document.getElementById('inline-fallback-configurations'));
        const current = getCurrent(primary.ID);
        intent = { primary, action, scope: getScope(), openingChoice: current ? familyKey(primary.ID, current.entries) : null };
        sessionChoices.clear();
        renderedKey = ''; applying = false; applyError = '';
        dialog.dataset.conditionId = String(primary.ID);
        dialog.dataset.action = action;
        const readOnly = action === 'view';
        title.textContent = readOnly ? 'Public fallback configurations'
            : 'Choose fallback configuration';
        closeButton.setAttribute('aria-label', readOnly ? 'Close fallback configurations' : 'Close fallback chooser');
        track.setAttribute('role', 'list');
        track.setAttribute('aria-label', readOnly ? 'Public fallback configurations' : 'Fallback orders');
        dialog.hidden = false; refresh();
        scrolling.reset();
        const view = catalogue.view(primary);
        if (!view.loaded && !view.loading && (view.hasMore || !Object.hasOwn(primary, 'fallbackConfigCount'))) void catalogue.load(Number(primary.ID));
    }
    closeButton.addEventListener('click', () => close()); cancel.addEventListener('click', () => close());
    more.addEventListener('click', () => { const primary = validPrimary(); if (primary) void catalogue.load(Number(primary.ID)); });
    async function applyChoice(chosen, editCurrent = false) {
        const primary = validPrimary();
        if (!primary || intent.action === 'view' || !chosen || applying || !canApply(primary.ID, intent.action)) return;
        const active = intent; applying = true; applyError = ''; updateSelection();
        try {
            const applied = editCurrent ? await onCustomize(primary) : await onApply(primary, chosen, active.action);
            if (intent !== active) return;
            if (applied && (editCurrent || active.action === 'add')) close({ restore: !editCurrent });
            else if (applied) { applying = false; refresh(); }
            else { applyError = 'Could not apply this configuration. Please try again.'; applying = false; refresh(); }
        } catch {
            if (intent !== active) return;
            applyError = 'Could not apply this configuration. Please try again.'; applying = false; refresh();
        }
    }
    customAdd.addEventListener('click', () => {
        const primary = validPrimary();
        if (!primary || intent.action !== 'add' || customAdd.disabled) return;
        void applyChoice({ key: familyKey(primary.ID, []), entries: [], familyID: null, configureOwn: true });
    });
    customize.addEventListener('click', () => {
        const primary = validPrimary();
        if (!primary || intent.action !== 'replace' || customize.disabled) return;
        void applyChoice(getCurrent(primary.ID) ?? { entries: [] }, true);
    });
    return { open, close, refresh };
}
