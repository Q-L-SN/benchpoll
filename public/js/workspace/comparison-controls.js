import { canonicalNumber, fieldDisplayValue, fieldKey, fieldNameKey } from '../shared/score-fields.js';
import { createComparisonProfileMenu } from './comparison-profile-menu.js';
import { animateContent, setVisible } from '../shared/motion.js?v=workspace-ui-20261008';
import { searchItems } from '../shared/search.js';
import { protectModelName } from '../shared/model-name.js?v=model-name-translation-20261006';
import { defaultComparison, quickComparisonFields, readComparisonSettings, writeComparisonSettings } from './comparison-settings.js?v=comparison-experiment-20261007';
import { createOrganizationMark } from '../shared/organization-logos.js?v=organization-logos-20261006';
import { refreshHelpPopover, setHelpText } from '../shared/help-popover.js?v=help-popovers-20261008';
import { adaptRunComparison } from '../shared/score-field-presets.js';
import { createFloatingSearchLayer } from '../shared/floating-search-layer.js';

const needsValue = operator => ['eq', 'gt', 'lt'].includes(operator);

export function createComparisonControls({ onChange, onInvalid, onSaveProfile, onRenameProfile, onDeleteProfile }) {
    const toggle = document.getElementById('model-comparison-toggle');
    const panel = document.getElementById('model-comparison-panel');
    const keys = document.getElementById('model-comparison-keys');
    const modeSwitch = document.getElementById('model-comparison-mode');
    const note = document.getElementById('model-comparison-note');
    const keyHeading = document.getElementById('model-comparison-keys-heading');
    const close = document.getElementById('model-comparison-close');
    const experiment = document.getElementById('experimental-comparison');
    const experimentStatus = document.getElementById('comparison-experiment-status');
    const quickButtons = [...document.querySelectorAll('[data-quick-comparison]')];
    const quickHelp = document.getElementById('quick-comparison-help');
    const quickTooltip = document.getElementById('quick-comparison-tooltip');
    let accountID = null;
    let settings = readComparisonSettings(null);
    let experimental = false;
    let lastProfile = null;
    let profileSnapshot = null;
    let activeModelMenu = null;
    const modelSearchLayers = new Set();
    const closeModelMenu = () => activeModelMenu?.close();
    function setPanelOpen(open) {
        open = experimental && open;
        toggle.setAttribute('aria-expanded', String(open));
        if (!open) { profileMenu.close(); closeModelMenu(); fieldSearchLayer.close(); }
        setVisible(panel, open, { collapse: true });
    }
    function closePanel() { setPanelOpen(false); if (!toggle.hidden) toggle.focus(); }
    close.addEventListener('click', closePanel);
    panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); closePanel(); } });
    toggle.disabled = true;
    toggle.addEventListener('click', () => {
        setPanelOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });

    const selections = { best: ['model'], matched: ['model'] };
    let currentMode = 'best';
    let initialized = false;
    let unconfiguredCount = 0;
    let availableKeys = [];
    let metadata = { fields: [], models: [] };
    let metadataSignature = '';
    let keySignature = '';
    let nextFilterID = 0;
    let appliedFilters = [];
    let filterTimer = null;
    let lastNotifiedSignature = '';
    const filters = new Map();
    const appliedFilterRows = new Map();
    const help = document.createElement('button'); help.type = 'button'; help.className = 'bp-comparison-help';
    help.setAttribute('aria-label', 'How comparison works');
    help.innerHTML = '<i class="fa-regular fa-circle-question" aria-hidden="true"></i>';
    keyHeading.append(help);
    const profileMenu = createComparisonProfileMenu({ heading: panel.querySelector('.bp-comparison-heading'),
        getComparison: currentOptions, isInvalid: () => Boolean(describe()) || !normalizedDraftFilters(), onUse: useProfile,
        onSave: onSaveProfile, onRename: onRenameProfile, onDelete: onDeleteProfile });
    function setProfiles(next) {
        profileSnapshot = next;
        lastProfile = next.last;
        profileMenu.render({ ...next, last: adaptRunComparison(next.last, metadata.fields ?? []),
            profiles: next.profiles.map(profile => ({ ...profile, comparison: adaptRunComparison(profile.comparison, metadata.fields ?? []) })) });
    }
    function persistSettings() {
        experimentStatus.textContent = writeComparisonSettings(settings, accountID)
            ? '' : 'This preference could not be saved on this device.';
    }
    function renderExperiment() {
        experiment.checked = experimental;
        experiment.disabled = accountID === null;
        toggle.hidden = !experimental;
        if (!experimental) setPanelOpen(false);
    }
    function configureAccount(userID, profiles) {
        accountID = userID;
        settings = readComparisonSettings(accountID);
        experimental = settings.experimental;
        setProfiles(profiles);
        const options = experimental ? profiles.last ?? settings.basic : settings.basic;
        assignComparison(options);
        initialized = true;
        renderExperiment();
        return structuredClone(options);
    }
    function resetToDefault() {
        clearTimeout(filterTimer);
        lastNotifiedSignature = '';
        selections.best = ['model'];
        selections.matched = ['model'];
        currentMode = 'best';
        appliedFilters = [];
        filters.clear();
        appliedFilterRows.clear();
        initialized = false;
        if (!experimental) { settings.basic = defaultComparison(); persistSettings(); }
        renderMode();
        renderFilterRows();
        renderSuggestions();
        profileMenu.render();
        renderQuickControls();
    }
    function assignComparison(comparison) {
        clearTimeout(filterTimer);
        comparison = adaptRunComparison(comparison, metadata.fields ?? []);
        currentMode = comparison.mode;
        selections[currentMode] = [...comparison.keys];
        appliedFilters = structuredClone(comparison.filters);
        filters.clear();
        appliedFilterRows.clear();
        for (const filter of appliedFilters) {
            const id = ++nextFilterID;
            filters.set(id, structuredClone(filter));
            appliedFilterRows.set(id, structuredClone(filter));
        }
        renderMode();
        renderFilterRows();
        renderSuggestions();
    }
    function useProfile(comparison) {
        assignComparison(comparison);
        changed();
        animateContent(filterRows);
    }

    const filterSection = document.createElement('div');
    filterSection.className = 'bp-value-filters';
    const filterHeading = document.createElement('strong');
    filterHeading.textContent = 'Limit values';
    const suggestions = document.createElement('div');
    suggestions.className = 'bp-filter-suggestions';
    suggestions.setAttribute('aria-label', 'Suggested fields');
    const searchWrap = document.createElement('div');
    searchWrap.className = 'bp-filter-search-wrap';
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'bp-filter-search';
    search.placeholder = 'Search a field to add...';
    search.autocomplete = 'off';
    search.setAttribute('aria-label', 'Search fields to limit');
    const searchResults = document.createElement('div');
    searchResults.className = 'bp-filter-search-results';
    searchResults.id = 'comparison-field-search-results';
    searchResults.setAttribute('role', 'listbox');
    searchResults.setAttribute('aria-label', 'Fields to limit');
    searchResults.hidden = true;
    search.setAttribute('aria-controls', searchResults.id);
    search.setAttribute('aria-expanded', 'false');
    searchWrap.append(search, searchResults);
    const fieldSearchLayer = createFloatingSearchLayer({ anchor: search, panel: searchResults, scope: searchWrap,
        align: 'start', width: () => Math.max(search.getBoundingClientRect().width, 220), maxHeight: 192, gap: 3, margin: 8,
        onClose(reason) {
            searchActive = false;
            search.setAttribute('aria-expanded', 'false');
            if (reason === 'escape') search.value = '';
        }
    });
    const filterRows = document.createElement('div');
    filterRows.className = 'bp-filter-rows';
    const reset = document.createElement('button');
    reset.type = 'button'; reset.className = 'bp-filter-reset'; reset.textContent = 'Reset'; reset.dataset.tooltip = 'Reset comparison and value filters';
    const actions = document.createElement('div');
    actions.className = 'bp-filter-actions';
    actions.append(reset);
    filterSection.append(filterHeading, suggestions, searchWrap, filterRows, actions);
    panel.insertBefore(filterSection, note);

    function fieldFor(key) { return metadata.fields?.find(field => fieldKey(field.ID) === key); }
    function labelFor(key) { return key === 'model' ? 'Model' : fieldFor(key)?.name ?? key.replaceAll('_', ' '); }
    function choicesFor(key) {
        if (key === 'model') {
            const counts = new Map();
            for (const model of metadata.models ?? []) counts.set(fieldNameKey(model.name), (counts.get(fieldNameKey(model.name)) ?? 0) + 1);
            const choices = (metadata.models ?? []).map(model => ({
                ID: model.ID,
                vendor: model.vendor,
                label: counts.get(fieldNameKey(model.name)) > 1
                    ? model.name + ', ' + (model.vendor ?? '#' + model.ID) : model.name
            }));
            const duplicates = new Map();
            for (const choice of choices) duplicates.set(fieldNameKey(choice.label), (duplicates.get(fieldNameKey(choice.label)) ?? 0) + 1);
            return choices.map(choice => duplicates.get(fieldNameKey(choice.label)) > 1
                ? { ...choice, label: choice.label + ' #' + choice.ID } : choice);
        }
        return fieldFor(key)?.type === 'enum'
            ? (fieldFor(key).options ?? []).map(option => ({ ID: option.ID, label: option.label }))
            : [];
    }
    function renderMode() {
        modeSwitch.dataset.mode = currentMode;
        modeSwitch.querySelectorAll('button').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.mode === currentMode));
        });
    }
    function describe() {
        const missing = currentMode === 'matched' && selections.matched.length === 0;
        const unavailable = selections[currentMode].filter(key => !availableKeys.includes(key));
        const unavailableFilters = appliedFilters.filter(filter => !availableKeys.includes(filter.key));
        const error = unavailable.length ? 'These fields are no longer available: ' + unavailable.map(labelFor).join(', ') + '. Uncheck them to continue.'
            : unavailableFilters.length ? 'These filters are no longer available. Remove them.'
                : missing ? 'Choose at least one field to compare.' : '';
        keys.setAttribute('aria-label', 'Fields to compare');
        note.setAttribute('role', 'status');
        note.classList.toggle('is-invalid', Boolean(error));
        note.textContent = error;
        let helpText = (currentMode === 'matched'
            ? 'Compare your selected fields under the same other settings. For example, compare harnesses on the same model. Fallback is off.'
            : 'On: separate ranking entries. Off: combine runs and use their best score on each test.');
        if (unconfiguredCount) helpText += ' ' + unconfiguredCount + ' runs have no recorded settings.';
        setHelpText(help, helpText);
        return error;
    }
    function currentOptions() {
        return { mode: currentMode, keys: [...selections[currentMode]], filters: structuredClone(appliedFilters) };
    }
    function changed() {
        clearTimeout(filterTimer);
        updateAppliedFilters();
        profileMenu.render();
        renderKeys();
        renderQuickControls();
        const error = describe();
        if (error) { lastNotifiedSignature = ''; onInvalid(error); return; }
        const options = currentOptions();
        const signature = JSON.stringify(options);
        if (signature === lastNotifiedSignature) return;
        lastNotifiedSignature = signature;
        if (!experimental) { settings.basic = structuredClone(options); persistSettings(); }
        onChange(options, { experimental });
    }
    experiment.addEventListener('change', () => {
        if (accountID === null) { experiment.checked = false; return; }
        experimental = experiment.checked;
        settings.experimental = experimental;
        persistSettings();
        renderExperiment();
        assignComparison(experimental ? lastProfile ?? settings.basic : settings.basic);
        changed();
    });
    function renderQuickControls() {
        const fields = quickComparisonFields(metadata.fields ?? [], availableKeys);
        for (const button of quickButtons) {
            const key = fields[button.dataset.quickComparison];
            button.disabled = !key;
            button.dataset.fieldKey = key ?? '';
            button.setAttribute('aria-pressed', String(Boolean(key && selections[currentMode].includes(key))));
            button.dataset.tooltip = !key ? 'This field is not available in the current data.'
                : button.dataset.quickComparison === 'reasoning' ? 'Compare effort separately' : 'Compare harnesses separately';
        }
        const heading = document.createElement('strong');
        heading.textContent = currentMode === 'matched' ? 'Keep other settings the same' : 'Separate or combine runs';
        const rules = currentMode === 'matched' ? [
            'Selected fields get separate entries. Other recorded settings must match.',
            'Example: compare harnesses using the same model and effort.',
            'Runs that do not match are left out of that test. Fallback is off.'
        ] : [
            'Effort: separate reasoning or image-quality settings.',
            'Harness: separate software setups.',
            'Off: combine runs and use their best score.',
            'Missing settings: keep an unknown group.'
        ];
        const list = document.createElement('ul');
        for (const text of rules) { const item = document.createElement('li'); item.textContent = text; list.append(item); }
        quickTooltip.replaceChildren(heading, list);
        refreshHelpPopover(quickHelp);
    }
    quickButtons.forEach(button => button.addEventListener('click', () => {
        const key = button.dataset.fieldKey;
        if (!key || button.disabled) return;
        selections[currentMode] = selections[currentMode].includes(key)
            ? selections[currentMode].filter(value => value !== key) : [...selections[currentMode], key];
        changed();
    }));
    modeSwitch.addEventListener('click', event => {
        const button = event.target.closest('button[data-mode]');
        if (!experimental || !button || button.dataset.mode === currentMode) return;
        currentMode = button.dataset.mode;
        renderMode();
        changed();
        animateContent(keys);
    });
    keys.addEventListener('change', () => {
        if (!experimental) return;
        selections[currentMode] = [...keys.querySelectorAll('input:checked')].map(input => input.value);
        changed();
    });
    function renderKeys() {
        const visibleKeys = [...new Set([...availableKeys, ...selections[currentMode]])]
            .sort((left, right) => left === 'model' ? -1 : right === 'model' ? 1 : labelFor(left).localeCompare(labelFor(right)));
        const signature = JSON.stringify([availableKeys, visibleKeys.map(key => [key, labelFor(key)])]);
        if (keySignature === signature) {
            keys.querySelectorAll('input').forEach(input => { input.checked = selections[currentMode].includes(input.value); });
            return;
        }
        keySignature = signature;
        keys.replaceChildren();
        for (const key of visibleKeys) {
            const label = document.createElement('label');
            const input = document.createElement('input');
            input.type = 'checkbox'; input.value = key;
            input.checked = selections[currentMode].includes(key);
            const text = document.createElement('span');
            text.textContent = labelFor(key) + (availableKeys.includes(key) ? '' : ' (unavailable)');
            label.append(input, text);
            keys.append(label);
        }
    }
    function canAddKey(key) {
        if (filters.size >= 65) return false;
        const existing = [...filters.values()].filter(filter => filter.key === key);
        if (!existing.length) return true;
        return fieldFor(key)?.type === 'number' && existing.length === 1 && ['gt', 'lt'].includes(existing[0].operator);
    }
    function availableToAdd() {
        return availableKeys.filter(canAddKey).sort((a, b) => {
            if (a === 'model') return -1;
            if (b === 'model') return 1;
            return labelFor(a).localeCompare(labelFor(b));
        });
    }
    let searchActive = false;
    function addFilter(key) {
        if (!canAddKey(key)) return;
        const existing = [...filters.values()].find(filter => filter.key === key);
        const operator = existing?.operator === 'gt' ? 'lt'
            : existing?.operator === 'lt' ? 'gt'
                : fieldFor(key)?.type === 'presence' ? 'present' : 'eq';
        const id = ++nextFilterID;
        filters.set(id, { key, operator, ...(needsValue(operator) ? { value: '' } : {}) });
        search.value = '';
        searchActive = false;
        renderFilterRows();
        renderSuggestions();
        animateContent(filterRows.querySelector('[data-filter-id="' + id + '"]'));
        filterRows.querySelector('[data-filter-id="' + id + '"] input, [data-filter-id="' + id + '"] select')?.focus();
        commitFilters();
    }
    function addButton(key, className) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        if (className === 'bp-filter-suggestion') {
            const icon = document.createElement('i');
            icon.className = 'fa-solid fa-plus';
            icon.setAttribute('aria-hidden', 'true');
            button.append(icon);
        }
        button.append(document.createTextNode(labelFor(key)));
        button.setAttribute('aria-label', 'Add ' + labelFor(key) + ' filter');
        if (className === 'bp-filter-search-result') { button.setAttribute('role', 'option'); button.tabIndex = -1; }
        button.addEventListener('click', () => addFilter(key));
        return button;
    }
    function renderSuggestions() {
        const available = availableToAdd();
        suggestions.replaceChildren(...available.slice(0, 9).map(key => addButton(key, 'bp-filter-suggestion')));
        const query = fieldNameKey(search.value);
        const matches = searchItems(available, query, labelFor);
        searchResults.replaceChildren(...matches.slice(0, 12).map(key => addButton(key, 'bp-filter-search-result')));
        if (searchActive && matches.length > 0) search.setAttribute('aria-expanded', String(fieldSearchLayer.open()));
        else fieldSearchLayer.close();
    }
    search.addEventListener('focus', () => { searchActive = true; renderSuggestions(); });
    search.addEventListener('click', () => { searchActive = true; renderSuggestions(); });
    search.addEventListener('input', () => { searchActive = true; renderSuggestions(); });
    searchResults.addEventListener('mousedown', event => {
        if (event.target.closest('button')) event.preventDefault();
    });
    search.addEventListener('keydown', event => {
        if (event.key === 'Escape') { searchActive = false; fieldSearchLayer.close(); search.value = ''; event.stopPropagation(); return; }
        if ((event.key === 'Enter' || event.key === 'Tab' && !event.shiftKey) && search.value.trim() && !searchResults.hidden) {
            const first = searchResults.querySelector('button');
            if (first) { event.preventDefault(); first.click(); }
        }
    });

    function displayValue(filter) {
        if (filter.value === undefined || filter.value === null || filter.value === '') return '';
        const choices = choicesFor(filter.key);
        if (choices.length && Number.isSafeInteger(filter.value)) {
            return choices.find(choice => choice.ID === filter.value)?.label ?? '';
        }
        const field = fieldFor(filter.key);
        return field?.type === 'number' && typeof filter.value === 'string'
            ? fieldDisplayValue(field, filter.value) : String(filter.value);
    }
    function operatorsFor(key, id) {
        if (key === 'model') return [['eq', 'Equals']];
        const field = fieldFor(key);
        if (field?.type === 'presence') return [['present', 'Present'], ['absent', 'Absent']];
        const operators = [['eq', 'Equals'], ...(field?.type === 'number' ? [['gt', 'Greater than'], ['lt', 'Less than']] : []),
            ['present', 'Present'], ['absent', 'Absent']];
        return [...filters].some(([otherID, filter]) => otherID !== id && filter.key === key)
            ? operators.filter(([value]) => value === filters.get(id).operator) : operators;
    }
    function normalizeDraft(filter, input) {
        if (!needsValue(filter.operator)) return { key: filter.key, operator: filter.operator };
        const text = input.value.trim();
        if (!text) throw new Error('Enter a value.');
        const choices = choicesFor(filter.key);
        if (filter.key === 'model' || fieldFor(filter.key)?.type === 'enum') {
            const matches = choices.filter(choice => fieldNameKey(choice.label) === fieldNameKey(text));
            if (matches.length !== 1) throw new Error('Choose an existing ' + (filter.key === 'model' ? 'model' : 'value') + '.');
            return { key: filter.key, operator: filter.operator, value: matches[0].ID };
        }
        if (fieldFor(filter.key)?.type === 'number') {
            try { return { key: filter.key, operator: filter.operator, value: canonicalNumber(text) }; }
            catch { throw new Error('Enter a valid number.'); }
        }
        if (text.length > 2000) throw new Error('This value is too long.');
        return { key: filter.key, operator: filter.operator, value: input.value };
    }
    function validateRow(row, filter, showError = true) {
        const input = row.querySelector('.bp-filter-value-input');
        const error = row.querySelector('.bp-filter-error');
        if (!input) { error.textContent = ''; return { key: filter.key, operator: filter.operator }; }
        try {
            const normalized = normalizeDraft(filter, input);
            input.setCustomValidity('');
            input.removeAttribute('aria-invalid');
            error.textContent = '';
            return normalized;
        } catch (cause) {
            if (!showError) return null;
            input.setCustomValidity(cause.message);
            input.setAttribute('aria-invalid', 'true');
            error.textContent = cause.message;
            return null;
        }
    }
    function renderFilterRows() {
        closeModelMenu();
        for (const layer of modelSearchLayers) layer.destroy();
        modelSearchLayers.clear();
        filterRows.replaceChildren();
        for (const [id, filter] of filters) {
            const row = document.createElement('div');
            row.className = 'bp-value-filter';
            row.dataset.filterId = String(id);
            const name = document.createElement('span');
            name.className = 'bp-value-filter-name';
            name.textContent = labelFor(filter.key);
            const controls = document.createElement('div');
            controls.className = 'bp-value-filter-controls';
            const operator = document.createElement('select');
            operator.setAttribute('aria-label', labelFor(filter.key) + ' filter');
            for (const [value, text] of operatorsFor(filter.key, id)) operator.add(new window.Option(text, value));
            operator.value = filter.operator;
            const valueHost = document.createElement('span');
            const error = document.createElement('small');
            error.className = 'bp-filter-error';
            error.setAttribute('aria-live', 'polite');
            const remove = document.createElement('button');
            let modelSearchLayer = null;
            remove.type = 'button';
            remove.className = 'bp-filter-remove';
            remove.dataset.tooltip = 'Remove ' + labelFor(filter.key) + ' filter';
            remove.setAttribute('aria-label', remove.dataset.tooltip);
            const icon = document.createElement('i');
            icon.className = 'fa-solid fa-xmark';
            icon.setAttribute('aria-hidden', 'true');
            remove.append(icon);
            remove.addEventListener('click', () => {
                modelSearchLayer?.destroy(); modelSearchLayers.delete(modelSearchLayer);
                filters.delete(id);
                appliedFilterRows.delete(id);
                refreshFilterOperators();
                void setVisible(row, false, { collapse: true }).then(() => row.remove());
                renderSuggestions();
                commitFilters();
            });
            function renderValue() {
                closeModelMenu();
                modelSearchLayer?.destroy(); modelSearchLayers.delete(modelSearchLayer);
                modelSearchLayer = null;
                valueHost.replaceChildren();
                controls.classList.toggle('has-value', needsValue(filter.operator));
                error.textContent = '';
                if (!needsValue(filter.operator)) return;
                const enumValue = filter.key !== 'model' && fieldFor(filter.key)?.type === 'enum';
                const input = document.createElement(enumValue ? 'select' : 'input');
                if (!enumValue) input.type = 'text';
                input.className = 'bp-filter-value-input bp-ui-input';
                input.autocomplete = 'off';
                input.inputMode = 'text';
                input.value = displayValue(filter);
                input.setAttribute('aria-label', labelFor(filter.key) + ' value');
                input.placeholder = filter.key === 'model' ? 'Search or enter a model' : 'Enter a value';
                if (filter.key === 'model') protectModelName(input);
                const choices = choicesFor(filter.key);
                if (filter.key === 'model') {
                    const valueWrap = document.createElement('span');
                    valueWrap.className = 'bp-model-limit-value';
                    const mark = document.createElement('span');
                    mark.className = 'bp-model-limit-mark';
                    mark.hidden = true;
                    const results = document.createElement('div');
                    results.className = 'bp-model-limit-results';
                    results.id = `bp-model-limit-${id}`;
                    results.setAttribute('role', 'listbox');
                    results.setAttribute('aria-label', 'Models');
                    results.hidden = true;
                    input.setAttribute('role', 'combobox');
                    input.setAttribute('aria-autocomplete', 'list');
                    input.setAttribute('aria-controls', results.id);
                    input.setAttribute('aria-expanded', 'false');
                    let active = -1;
                    let items = [];
                    const layer = createFloatingSearchLayer({ anchor: input, panel: results, scope: valueWrap,
                        align: 'start', width: () => Math.max(valueWrap.getBoundingClientRect().width, 220),
                        getAnchorRect: () => valueWrap.getBoundingClientRect(), maxHeight: 190, margin: 8,
                        onClose() {
                            input.setAttribute('aria-expanded', 'false');
                            input.removeAttribute('aria-activedescendant');
                            active = -1;
                            if (activeModelMenu === layer) activeModelMenu = null;
                        }
                    });
                    modelSearchLayer = layer; modelSearchLayers.add(layer);
                    function updateMark() {
                        const match = choices.find(choice => fieldNameKey(choice.label) === fieldNameKey(input.value));
                        mark.hidden = !match;
                        mark.replaceChildren(...(match ? [createOrganizationMark(match.vendor, 'bp-filter-vendor-mark')] : []));
                    }
                    function closeResults() {
                        layer.close();
                    }
                    function showResults() {
                        if (activeModelMenu !== layer) closeModelMenu();
                        items = searchItems(choices, input.value, choice => [choice.label, choice.vendor]).slice(0, 20);
                        active = -1;
                        results.replaceChildren(...items.map((choice, index) => {
                            const button = document.createElement('button');
                            button.type = 'button';
                            button.tabIndex = -1;
                            button.id = `${results.id}-${index}`;
                            button.setAttribute('role', 'option');
                            button.setAttribute('aria-selected', 'false');
                            const label = document.createElement('span');
                            label.textContent = choice.label;
                            protectModelName(label);
                            button.append(createOrganizationMark(choice.vendor, 'bp-filter-vendor-mark'), label);
                            button.addEventListener('pointerdown', event => event.preventDefault());
                            button.addEventListener('click', () => {
                                input.value = choice.label;
                                filter.value = choice.label;
                                updateMark();
                                validateRow(row, filter);
                                commitFilters();
                                input.focus();
                                closeResults();
                            });
                            return button;
                        }));
                        if (!items.length) { closeResults(); return; }
                        if (!layer.open()) return;
                        activeModelMenu = layer;
                        input.setAttribute('aria-expanded', 'true');
                        input.removeAttribute('aria-activedescendant');
                    }
                    input.addEventListener('focus', showResults);
                    input.addEventListener('click', showResults);
                    input.addEventListener('input', () => { showResults(); updateMark(); });
                    input.addEventListener('keydown', event => {
                        if (event.key === 'Escape' && !results.hidden) { event.preventDefault(); event.stopPropagation(); closeResults(); return; }
                        if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
                            event.preventDefault();
                            if (results.hidden) showResults();
                            if (!items.length) return;
                            active = active < 0 ? event.key === 'ArrowDown' ? 0 : items.length - 1
                                : (active + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
                            [...results.children].forEach((button, index) => button.setAttribute('aria-selected', String(index === active)));
                            input.setAttribute('aria-activedescendant', results.children[active].id);
                            const option = results.children[active].getBoundingClientRect(), bounds = results.getBoundingClientRect();
                            if (option.top < bounds.top) results.scrollTop -= bounds.top - option.top;
                            else if (option.bottom > bounds.bottom) results.scrollTop += option.bottom - bounds.bottom;
                        } else if (event.key === 'Enter' && !results.hidden && active >= 0) {
                            event.preventDefault();
                            results.children[active].click();
                        }
                    });
                    valueWrap.append(mark, input, results);
                    valueHost.append(valueWrap);
                    updateMark();
                } else if (enumValue) {
                    input.append(new window.Option('Choose a value', ''));
                    for (const choice of choices) {
                        input.append(new window.Option(choice.label, choice.label));
                    }
                    input.value = displayValue(filter);
                    if (input.selectedIndex < 0) {
                        const unavailable = new window.Option('Value unavailable', displayValue(filter));
                        unavailable.disabled = true; input.append(unavailable); input.value = unavailable.value;
                    }
                    valueHost.append(input);
                } else valueHost.append(input);
                input.addEventListener('input', () => {
                    filter.value = input.value;
                    input.setCustomValidity('');
                    input.removeAttribute('aria-invalid');
                    error.textContent = '';
                    clearTimeout(filterTimer);
                    filterTimer = setTimeout(commitFilters, 300);
                });
                input.addEventListener('blur', () => { validateRow(row, filter); commitFilters(); });
            }
            operator.addEventListener('change', () => {
                filter.operator = operator.value;
                delete filter.value;
                renderValue();
                renderSuggestions();
                animateContent(controls);
                valueHost.querySelector('input')?.focus();
                commitFilters();
            });
            renderValue();
            controls.append(operator, valueHost);
            row.append(name, controls, remove, error);
            filterRows.append(row);
        }
    }
    function refreshFilterOperators() {
        for (const [id, filter] of filters) {
            const operator = filterRows.querySelector('[data-filter-id="' + id + '"] select');
            operator.replaceChildren();
            for (const [value, text] of operatorsFor(filter.key, id)) operator.add(new window.Option(text, value));
            operator.value = filter.operator;
        }
    }
    function normalizedDraftFilters() {
        const normalized = [];
        for (const [id, filter] of filters) {
            const row = filterRows.querySelector('[data-filter-id="' + id + '"]');
            if (!row) throw new Error('A filter draft has no input row');
            const result = validateRow(row, filter, false);
            if (result) normalized.push(result);
            else return null;
        }
        return normalized;
    }
    function commitFilters() {
        clearTimeout(filterTimer);
        const previous = JSON.stringify(appliedFilters);
        updateAppliedFilters();
        if (previous === JSON.stringify(appliedFilters)) return;
        changed();
    }
    function updateAppliedFilters() {
        const next = [];
        for (const [id, filter] of filters) {
            const row = filterRows.querySelector('[data-filter-id="' + id + '"]');
            if (!row) throw new Error('A filter draft has no input row');
            const result = validateRow(row, filter, false);
            if (result) appliedFilterRows.set(id, result);
            // Incomplete edits keep only this row's last valid value; other rows still update.
            const applied = appliedFilterRows.get(id);
            if (applied) next.push(applied);
        }
        appliedFilters = next;
    }
    reset.addEventListener('click', () => {
        clearTimeout(filterTimer);
        filters.clear();
        appliedFilterRows.clear();
        appliedFilters = [];
        selections.best = ['model'];
        selections.matched = ['model'];
        currentMode = 'best';
        renderMode();
        renderFilterRows();
        renderSuggestions();
        changed();
        animateContent(keys);
    });
    function render(incoming) {
        metadata = adaptRunComparison(incoming, incoming.fields ?? []);
        for (const mode of ['best', 'matched']) selections[mode] = adaptRunComparison({ keys: selections[mode] }, metadata.fields).keys;
        appliedFilters = adaptRunComparison({ filters: appliedFilters }, metadata.fields).filters;
        const remapped = new Map();
        for (const [id, draft] of filters) {
            const filter = adaptRunComparison({ filters: [draft] }, metadata.fields).filters[0];
            const signature = JSON.stringify(filter);
            const originalKey = remapped.get(signature);
            if (originalKey !== undefined && originalKey !== draft.key) {
                filters.delete(id); appliedFilterRows.delete(id); continue;
            }
            remapped.set(signature, draft.key);
            if (signature !== JSON.stringify(draft)) Object.assign(draft, filter);
            if (appliedFilterRows.has(id)) appliedFilterRows.set(id,
                adaptRunComparison({ filters: [appliedFilterRows.get(id)] }, metadata.fields).filters[0]);
        }
        if (profileSnapshot) setProfiles(profileSnapshot);
        if (!initialized) {
            currentMode = metadata.mode;
            selections[currentMode] = [...metadata.keys];
            appliedFilters = structuredClone(metadata.filters ?? []);
            for (const filter of appliedFilters) {
                const id = ++nextFilterID;
                filters.set(id, structuredClone(filter));
                appliedFilterRows.set(id, structuredClone(filter));
            }
            initialized = true;
            renderMode();
        }
        const isDefault = metadata.mode === 'best' && metadata.keys?.length === 1
            && metadata.keys[0] === 'model' && !metadata.filters?.length;
        const activeCount = (metadata.keys?.length ?? 0) + (metadata.filters?.length ?? 0);
        toggle.classList.toggle('has-active-filters', !isDefault);
        toggle.dataset.tooltip = isDefault ? 'Advanced filters (experimental)' : 'Advanced filters (experimental): ' + activeCount + ' criteria';
        toggle.disabled = false;
        unconfiguredCount = metadata.unconfiguredCount;
        availableKeys = [...metadata.availableKeys];
        const signature = JSON.stringify([availableKeys, metadata.fields, metadata.models]);
        if (signature !== metadataSignature) {
            metadataSignature = signature;
            renderFilterRows();
            renderSuggestions();
        }
        renderKeys();
        renderQuickControls();
        const error = describe();
        if (error) {
            setPanelOpen(true);
            onInvalid(error);
        }
    }
    return { render, setProfiles, resetToDefault, configureAccount, isExperimental: () => experimental };
}
