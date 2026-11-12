import { setLoading } from '../shared/loading.js';
import { familyKey } from '../shared/benchmark-families.js';
import { COMMUNITY_FALLBACK_EXPLANATION } from '../shared/fallback-choice.js';
import { createBenchmarkInformationLink } from './benchmark-link.js';
import { setHelpText } from '../shared/help-popover.js?v=help-popovers-20261008';
import { createChoicePager } from '../shared/choice-pager.js';
import { createAction, configureAction } from '../shared/ui-components.js';
import { excludedFromRanking } from '../shared/aa-ranking-policy.js';

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
    getMemberURL, onInspectVersion, host = null, actionsHost = null, helpHost = null, scrollRoot = null }) {
    const dialog = host ?? element('global-dialog', 'bp-fallback-picker');
    if (host) dialog.classList.add('bp-fallback-picker', 'bp-fallback-picker-embedded');
    else dialog.id = 'fallback-picker';
    dialog.hidden = true;
    const heading = element('div', 'bp-fallback-picker-heading'); heading.slot = 'title';
    const title = element('span', '', 'Choose fallback configuration');
    const help = button('bp-help-trigger', '', 'circle-question');
    help.querySelector('i').className = 'fa-regular fa-circle-question';
    help.setAttribute('aria-label', 'About fallback configuration shares');
    setHelpText(help, 'Community shares come from explicit choices, weighted by each person\'s allocation to this benchmark. Leave the choice open to follow those shares. Choosing No fallback counts as a preference for using the selected version alone.');
    heading.append(title);
    (helpHost ?? heading).append(help);
    const closeButton = button('dialog-close-button bp-fallback-picker-close', '', 'xmark');
    closeButton.setAttribute('aria-label', 'Close fallback chooser'); heading.append(closeButton);
    const body = element('div', 'bp-fallback-picker-body'); body.slot = 'body';
    const readOnlyNotice = element('p', 'bp-fallback-picker-readonly', 'Read-only · Explore community fallback configurations.');
    readOnlyNotice.hidden = true;
    const question = element('p', 'bp-fallback-picker-question');
    const selectionStatus = element('p', 'bp-fallback-picker-selection-status');
    selectionStatus.setAttribute('role', 'status'); selectionStatus.setAttribute('aria-live', 'polite');
    const track = element('div', 'bp-fallback-picker-columns'); track.setAttribute('role', 'list');
    track.setAttribute('aria-label', 'Fallback configurations');
    const feedback = element('div', 'bp-fallback-picker-feedback');
    const status = element('span', 'bp-fallback-picker-status'); status.setAttribute('role', 'status');
    const retry = button('bp-fallback-picker-retry', 'Retry', 'rotate-right');
    retry.hidden = true; feedback.append(status, retry);
    const actions = element('div', 'bp-fallback-picker-actions'); actions.slot = 'actions';
    const cancel = createAction({ className: 'bp-fallback-picker-cancel', label: 'Close' });
    const customAdd = createAction({ className: 'bp-fallback-picker-custom-add', label: 'Skip fallback or create my own', variant: 'primary' });
    const customize = createAction({ className: 'bp-fallback-picker-customize', label: 'Create my own', icon: 'fa-regular fa-pen-to-square', variant: 'quiet' });
    customize.hidden = true; customAdd.hidden = true;
    actions.append(customize, cancel, customAdd);
    let intent = null, applying = false, applyError = '', returnFocus = null, layout = 'pages', active = true;
    const visitChoices = new Map(), visitExpansions = new Map();
    let currentVisit = null, sessionChoices = new Map(), expandedChains = new Set();
    const pager = createChoicePager({ list: track, label: 'Fallback configurations', pageSize: 2, neighbors: 3, scrollRoot,
        getKey: choice => choice.key, renderItem: choice => createColumn(validPrimary(), choice),
        onLoadMore: loadMore, onRender: updateSelection });
    body.append(readOnlyNotice, question, selectionStatus, pager.element, feedback);
    if (host) {
        question.hidden = true; cancel.hidden = true;
        body.removeAttribute('slot'); actions.removeAttribute('slot');
        dialog.append(body); (actionsHost ?? dialog).append(actions);
        if (actionsHost) actions.hidden = true;
    } else { dialog.append(heading, body, actions); document.body.append(dialog); }

    function close({ restore = true } = {}) {
        const focus = returnFocus; intent = null; applying = false;
        pager.setActive(false); dialog.returnFocus = null; dialog.hidden = true;
        pager.setItems([]); pager.reset();
        if (actionsHost) actions.hidden = true;
        if (restore && !host) requestAnimationFrame(() => {
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
            current: intent.action === 'view' ? null : getCurrent(primary.ID), action: intent.action });
        // Preserve this visit's order through saves and newly loaded pages.
        for (const choice of choices) sessionChoices.set(choice.key, { ...choice,
            selectionSource: sessionChoices.get(choice.key)?.selectionSource === 'custom' ? 'custom' : choice.selectionSource });
        return [...sessionChoices.values()];
    }
    function updateSelection() {
        const primary = validPrimary();
        if (!intent || !primary) return;
        const current = intent.action === 'view' ? null : getCurrent(primary.ID);
        const currentKey = current ? familyKey(primary.ID, current.entries) : null;
        selectionStatus.hidden = Boolean(host) || intent.action === 'view';
        selectionStatus.dataset.selection = currentKey ? 'manual' : 'community';
        selectionStatus.textContent = currentKey
            ? current.selectionSource === 'custom' ? 'Using your custom fallback configuration.'
                : current.entries.length ? 'Using your selected fallback configuration.' : 'You have chosen not to use fallback.'
            : COMMUNITY_FALLBACK_EXPLANATION;
        for (const column of track.querySelectorAll('.bp-fallback-picker-column')) {
            const selected = intent.action === 'replace' && column.dataset.familyKey === currentKey;
            column.classList.toggle('is-selected', selected);
            const add = column.querySelector('.bp-fallback-picker-card-add');
            if (add) add.disabled = applying || !canApply(primary.ID, intent.action);
            const toggle = column.querySelector('.bp-fallback-picker-card-toggle');
            if (toggle) {
                toggle.disabled = applying || !canApply(primary.ID, intent.action);
                toggle.setAttribute('aria-pressed', String(selected));
                if (column.dataset.excluded === 'true' && !selected) toggle.setAttribute('aria-disabled', 'true');
                else toggle.removeAttribute('aria-disabled');
                toggle.setAttribute('aria-label', `${selected ? 'Deselect' : 'Use'} ${column.dataset.choiceName}`);
                toggle.querySelector('span').textContent = selected ? 'Selected' : 'Use configuration';
                toggle.querySelector('i').className = selected ? 'fa-solid fa-check' : 'fa-solid fa-plus';
                configureAction(toggle, { variant: selected ? 'primary' : 'secondary' });
            }
        }
        customize.hidden = intent.action !== 'replace' || !host && current?.selectionSource === 'custom';
        customAdd.hidden = intent.action !== 'add';
        if (intent.action === 'view') { cancel.disabled = false; return; }
        customAdd.disabled = applying || !canApply(primary.ID, intent.action);
        customize.disabled = applying || !canApply(primary.ID, intent.action);
        if (host) customize.querySelector('span').textContent = current?.selectionSource === 'custom' ? 'Edit my order' : 'Create my own';
        cancel.disabled = applying;
    }
    function createColumn(primary, choice) {
        const column = element('section', 'bp-fallback-picker-column'); column.dataset.familyKey = choice.key;
        const excluded = excludedFromRanking(primary) || choice.entries.some(excludedFromRanking);
        column.dataset.excluded = String(excluded); column.setAttribute('role', 'listitem');
        const name = !choice.entries.length ? 'No fallback'
            : `fallback through ${choice.entries.map(entry => entry.name).join(', ')}`;
        column.dataset.choiceName = name;
        const label = element('div', 'bp-fallback-picker-column-heading');
        if (!choice.entries.length) label.append(element('strong', 'bp-fallback-picker-column-title', 'No fallback'));
        if (choice.shareBasisPoints !== null) {
            const share = element('span', 'bp-fallback-picker-share');
            share.setAttribute('aria-label', `${percentage(choice.shareBasisPoints)} community share`);
            const icon = element('i', 'fa-solid fa-users'); icon.setAttribute('aria-hidden', 'true');
            share.append(icon, element('strong', '', percentage(choice.shareBasisPoints))); label.append(share);
        }
        const list = element('ol', 'bp-fallback-picker-steps bp-fallback-chain');
        list.setAttribute('aria-label', `${name}: entrance, then fallback steps`);
        const chain = [primary, ...choice.entries];
        const capped = layout === 'pages' && !expandedChains.has(choice.key) && chain.length > 5;
        chain.slice(0, capped ? 5 : undefined).forEach(entry => {
            const item = element('li', 'bp-fallback-chain-step');
            const identity = element('span', 'bp-fallback-picker-step-name');
            identity.append(createBenchmarkInformationLink(entry, { getURL: getMemberURL, showVersion: true,
                onInspect: event => { close({ restore: false }); onInspectVersion?.(event); } }));
            item.append(identity); list.append(item);
        });
        column.append(label, list);
        if (capped) {
            const expand = createAction({ className: 'bp-fallback-picker-expand', label: `Expand (${chain.length - 5} more)`,
                icon: 'fa-solid fa-chevron-down', variant: 'quiet' });
            expand.setAttribute('aria-label', `Expand fallback chain, ${chain.length - 5} more steps`);
            expand.addEventListener('click', () => { expandedChains.add(choice.key); refresh(); });
            column.append(expand);
        }
        if (intent.action === 'add') {
            const add = createAction({ className: 'bp-fallback-picker-card-add', label: 'Add', icon: 'fa-solid fa-plus', variant: 'primary' });
            add.setAttribute('aria-label', `Add benchmark with ${name.toLowerCase()}`);
            if (excluded) add.setAttribute('aria-disabled', 'true');
            add.addEventListener('click', () => {
                const activePrimary = validPrimary();
                if (!activePrimary || intent.action !== 'add' || add.disabled || excluded) return;
                void applyChoice(choicesFor(activePrimary).find(candidate => candidate.key === choice.key));
            });
            column.append(add);
        }
        if (intent.action === 'replace') {
            const toggle = createAction({ className: 'bp-fallback-picker-card-toggle', label: 'Use configuration', icon: 'fa-solid fa-plus' });
            if (excluded) toggle.setAttribute('aria-disabled', 'true');
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
    async function loadMore() {
        const primary = validPrimary();
        if (!primary) return;
        const view = catalogue.view(primary);
        if (view.loading || view.suspended) return;
        await catalogue.load(Number(primary.ID));
        if (validPrimary()?.ID === primary.ID) refresh();
    }
    function refresh() {
        if (!intent || dialog.hidden) return;
        const primary = validPrimary();
        if (!primary) { close(); return; }
        const view = catalogue.view(primary), choices = choicesFor(primary);
        pager.setItems(choices.map(choice => ({ ...choice, layout, expanded: expandedChains.has(choice.key) })),
            { hasMore: view.hasMore || !view.loaded && !Object.hasOwn(primary, 'fallbackConfigCount'),
                loading: view.loading || view.suspended, error: view.error });
        question.replaceChildren(createBenchmarkInformationLink(primary, { getURL: getMemberURL, showVersion: true,
            onInspect: event => { close({ restore: false }); onInspectVersion?.(event); } }));
        if (!applyError && (view.loading || view.suspended)) setLoading(status, view.suspended ? 'Refreshing configurations' : 'Loading configurations');
        else status.textContent = applyError || view.error || '';
        retry.hidden = !view.error; retry.disabled = view.loading || view.suspended;
        const recommended = view.featured.some(row => row.familyEntries.length > 0);
        configureAction(customAdd, { variant: recommended ? 'quiet' : 'primary' });
        dialog.setAttribute('aria-busy', String(Boolean(view.loading)));
        updateSelection();
    }
    function open(primary, { action = 'add', getReturnFocus, visit = null } = {}) {
        pager.setActive(false);
        returnFocus = getReturnFocus ?? (() => document.getElementById('inline-fallback-configurations'));
        intent = { primary, action, scope: getScope() };
        if (!visit || currentVisit !== visit) {
            visitChoices.clear(); visitExpansions.clear(); currentVisit = visit;
        }
        const visitKey = `${primary.ID}:${action}`;
        if (!visitChoices.has(visitKey)) {
            visitChoices.set(visitKey, new Map()); visitExpansions.set(visitKey, new Set());
        }
        sessionChoices = visitChoices.get(visitKey); expandedChains = visitExpansions.get(visitKey);
        applying = false; applyError = '';
        dialog.dataset.conditionId = String(primary.ID); dialog.dataset.action = action;
        const readOnly = action === 'view';
        setHelpText(help, readOnly
            ? 'Community shares come from explicit choices, weighted by each person’s allocation to this benchmark. The chain shows which backup is tried next when a score is missing.'
            : 'Community shares come from explicit choices, weighted by each person\'s allocation to this benchmark. Leave the choice open to follow those shares. Choosing No fallback counts as a preference for using the selected version alone.');
        title.textContent = readOnly ? 'Public fallback configurations' : 'Choose fallback configuration';
        closeButton.setAttribute('aria-label', readOnly ? 'Close fallback configurations' : 'Close fallback chooser');
        track.setAttribute('role', 'list');
        track.setAttribute('aria-label', readOnly ? 'Public fallback configurations' : 'Fallback configurations');
        readOnlyNotice.hidden = Boolean(host) || !readOnly;
        dialog.hidden = false;
        if (actionsHost) actions.hidden = readOnly;
        // Clear the previous entrance before resetting the page renderer.
        pager.setItems([]); pager.reset(); refresh(); pager.setActive(active);
    }
    closeButton.addEventListener('click', () => close()); cancel.addEventListener('click', () => close());
    retry.addEventListener('click', () => { void loadMore(); });
    async function applyChoice(chosen, editCurrent = false) {
        const primary = validPrimary();
        if (!primary || intent.action === 'view' || !chosen || applying || !canApply(primary.ID, intent.action)) return;
        const currentIntent = intent; applying = true; applyError = ''; updateSelection();
        try {
            const applied = editCurrent ? await onCustomize(primary) : await onApply(primary, chosen, currentIntent.action);
            if (intent !== currentIntent) return;
            if (applied && (editCurrent || currentIntent.action === 'add')) close({ restore: !editCurrent });
            else if (applied) { applying = false; refresh(); }
            else { applyError = 'Could not apply this configuration. Please try again.'; applying = false; refresh(); }
        } catch {
            if (intent !== currentIntent) return;
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
    return { open, close, refresh,
        setLayout(value) {
            layout = value === 'accordion' ? 'accordion' : 'pages';
            pager.setMode(layout === 'accordion' ? 'continuous' : 'pages'); refresh();
        },
        setActive(value) { active = value; pager.setActive(value && Boolean(intent) && !dialog.hidden); }
    };
}
