import { createAction } from '../shared/ui-components.js';
import { versionChoiceOrder } from '../shared/benchmark-version-choice.js';
import { createEvidenceCount } from '../shared/evidence-count.js';
import { setHelpText } from '../shared/help-popover.js';
import { createFallbackPicker } from './fallback-picker.js';

const node = (tag, className = '', text) => {
    const result = document.createElement(tag); result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
};
const versionName = version => version.conditionName?.toLowerCase() === 'default' ? 'Default evaluation' : version.conditionName;
const shareLabel = points => points > 0 && points < 1 ? '<0.01%' : `${Number(((points ?? 0) / 100).toFixed(2))}%`;

export function createBenchmarkSettings({ getScope, getData, onVersion, onContribute, onCustom, fallbackPickerOptions }) {
    const dialog = node('global-dialog', 'bp-benchmark-settings'); dialog.id = 'benchmark-settings'; dialog.hidden = true;
    const heading = node('div', 'bp-fallback-picker-heading'); heading.slot = 'title';
    const title = node('span'); heading.append(title);
    const closeButton = createAction({ className: 'bp-fallback-picker-close', label: 'Close benchmark settings', icon: 'fa-solid fa-xmark', iconOnly: true });
    heading.append(closeButton);
    const body = node('div', 'bp-benchmark-settings-body'); body.slot = 'body';
    const status = node('p', 'bp-benchmark-settings-status'); status.setAttribute('role', 'status');
    const contribute = createAction({ className: 'bp-benchmark-settings-contribute', label: 'Configure in Personal Weights', variant: 'primary' });
    const versions = node('section', 'bp-benchmark-settings-section bp-benchmark-settings-versions');
    const versionHeading = node('div', 'bp-benchmark-settings-section-heading');
    const help = createAction({ label: 'About community version choices', icon: 'fa-regular fa-circle-question', iconOnly: true });
    setHelpText(help, 'Your version choice contributes to community proportions, weighted by your allocation to this benchmark. '
        + 'Versions are ordered by selection share, then approved score count. Click your selected version again to clear your vote and follow the community.');
    versionHeading.append(node('h3', '', 'Benchmark version'), help);
    const list = node('div', 'bp-version-choices'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', 'Benchmark versions');
    versions.append(versionHeading, list);
    const fallback = node('section', 'bp-benchmark-settings-section bp-benchmark-settings-fallback');
    fallback.append(node('h3', '', 'Fallback configuration'));
    const placeholder = node('p', 'bp-benchmark-settings-placeholder', 'Select a version above to choose its fallback.');
    const pickerHost = node('div');
    const editorHost = node('div', 'bp-benchmark-settings-editor'); editorHost.hidden = true;
    fallback.append(placeholder, pickerHost, editorHost);
    body.append(status, contribute, versions, fallback);
    const actions = node('div', 'bp-benchmark-settings-actions'); actions.slot = 'actions';
    const pickerActions = node('div'); actions.append(pickerActions);
    const done = createAction({ label: 'Done' }); actions.append(done);
    dialog.append(heading, body, actions); document.body.append(dialog);
    let intent = null, signature = '', customEntries = null, customPrimaryID = null, pickerKey = '';
    const picker = createFallbackPicker({ ...fallbackPickerOptions, host: pickerHost, actionsHost: pickerActions,
        onInspectVersion(event) { close(); fallbackPickerOptions.onInspectVersion?.(event); },
        onCustomize(primary) {
            const current = data();
            if (!current?.editable) return false;
            customEntries = structuredClone(current.rule?.entries ?? []); customPrimaryID = primary.conditionID ?? primary.ID;
            signature = ''; refresh(); return true;
        }
    });
    function close() {
        picker.close({ restore: false }); pickerKey = '';
        dialog.hidden = true; intent = null; signature = ''; customEntries = null;
    }
    closeButton.addEventListener('click', close); done.addEventListener('click', close);
    dialog.addEventListener('cancel', close);
    contribute.addEventListener('click', async () => {
        const current = data(); if (!current || current.busy) return;
        contribute.disabled = true;
        try { await onContribute(current.group); }
        finally { if (data()) { signature = ''; refresh(); } }
    });
    function data() {
        if (!intent || dialog.hidden) return null;
        if (intent.scope !== getScope()) { close(); return null; }
        return getData(intent.benchmarkID);
    }
    function choose(conditionID) {
        const current = data();
        if (!current?.editable || !onVersion(current.group, conditionID)) return;
        customEntries = null; signature = ''; refresh();
    }
    function refresh() {
        const current = data();
        if (!current) return;
        const { group, entries, rule, editable } = current;
        const selected = entries.length === 1 && entries[0].followCommunityVersion !== true ? entries[0].conditionID : null;
        if (customEntries && selected !== customPrimaryID) customEntries = null;
        title.textContent = group.name;
        status.textContent = entries.length > 1 ? 'Choose a version to replace your saved mix.'
            : selected === null ? current.isPrivate ? 'Using the default version and fallback.' : 'Versions and fallback follow community.'
                : !rule ? current.isPrivate ? 'Using the default fallback.' : 'Fallback follows community.'
                    : 'Select an option again to deselect it.';
        status.dataset.selection = selected === null ? 'community' : !rule ? 'version' : 'manual';
        contribute.hidden = editable || current.busy; contribute.disabled = current.busy;
        const nextSignature = JSON.stringify([group, entries, rule, editable, customEntries]);
        if (signature !== nextSignature) {
            const focusKey = body.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
            const scroll = list.scrollTop;
            signature = nextSignature;
            list.replaceChildren(...[...group.versions].sort(versionChoiceOrder).map(version => {
                const choice = node('button', 'bp-version-choice'); choice.type = 'button';
                choice.dataset.conditionId = String(version.conditionID); choice.dataset.focusKey = `version-${version.conditionID}`;
                choice.disabled = !editable; choice.setAttribute('aria-pressed', String(selected === version.conditionID));
                const count = createEvidenceCount(version.scoreCount); count.removeAttribute('tabindex');
                choice.append(node('span', 'bp-version-choice-name', versionName(version)), count,
                    node('span', 'bp-version-choice-share', shareLabel(version.selectionBasisPoints)));
                if (group.isDefault && version.conditionID === group.primaryConditionID) {
                    choice.dataset.defaultVersion = 'true';
                    choice.setAttribute('aria-description', 'Primary version when there are no community choices.');
                }
                choice.addEventListener('click', () => choose(selected === version.conditionID ? null : version.conditionID));
                return choice;
            }));
            list.scrollTop = scroll;
            editorHost.replaceChildren();
            if (customEntries) renderCustom(editorHost, current, group.versions.find(version => version.conditionID === selected));
            if (focusKey) [...body.querySelectorAll('[data-focus-key]')].find(item => item.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
        }
        const primary = group.versions.find(version => version.conditionID === selected);
        placeholder.hidden = Boolean(primary);
        editorHost.hidden = !customEntries;
        if (!primary || customEntries) { picker.close({ restore: false }); pickerKey = ''; return; }
        const action = editable || current.busy ? 'replace' : 'view';
        const key = `${primary.conditionID}:${action}`;
        if (pickerKey !== key) {
            pickerKey = key;
            picker.open({ ...primary, ID: primary.conditionID }, { action });
        } else picker.refresh();
    }
    function renderCustom(host, current, primary) {
        const editor = node('div', 'bp-custom-fallback-editor');
        const back = createAction({ label: 'Back to configurations', icon: 'fa-solid fa-arrow-left', variant: 'quiet' });
        back.addEventListener('click', () => { customEntries = null; signature = ''; refresh(); });
        editor.append(back, node('p', 'bp-benchmark-settings-hint', 'Try these backups in order after the selected version.'));
        const ordered = node('ol', 'bp-fallback-chain');
        ordered.append(node('li', '', `${current.group.name} · ${versionName(primary)}`));
        customEntries.forEach((entry, index) => {
            const item = node('li'); item.append(node('span', '', `${entry.name} · ${versionName(entry)}`));
            for (const [label, delta, icon] of [['Move up', -1, 'arrow-up'], ['Move down', 1, 'arrow-down'], ['Remove', 0, 'xmark']]) {
                const action = createAction({ label, icon: `fa-solid fa-${icon}`, iconOnly: true, variant: 'quiet' });
                action.disabled = !current.editable || delta < 0 && index === 0 || delta > 0 && index === customEntries.length - 1;
                action.addEventListener('click', () => {
                    if (!data()?.editable) return;
                    if (!delta) customEntries.splice(index, 1);
                    else [customEntries[index], customEntries[index + delta]] = [customEntries[index + delta], customEntries[index]];
                    signature = ''; refresh();
                });
                item.append(action);
            }
            ordered.append(item);
        });
        const search = node('input'); search.type = 'search'; search.placeholder = 'Find a backup benchmark or version';
        search.setAttribute('aria-label', 'Find fallback versions');
        const results = node('div', 'bp-custom-fallback-results');
        function searchVersions() {
            const query = search.value.trim().toLowerCase();
            const candidates = current.allVersions.filter(version => version.conditionID !== primary.conditionID
                && !customEntries.some(entry => entry.conditionID === version.conditionID)
                && `${version.name} ${version.conditionName}`.toLowerCase().includes(query)).slice(0, 30);
            results.replaceChildren(...candidates.map(version => {
                const add = createAction({ label: `${version.name} · ${versionName(version)}`, icon: 'fa-solid fa-plus', variant: 'quiet' });
                add.disabled = !current.editable;
                add.addEventListener('click', () => { if (!data()?.editable) return; customEntries.push({ ...version }); signature = ''; refresh(); });
                return add;
            }));
        }
        search.addEventListener('input', searchVersions); searchVersions();
        const save = createAction({ label: 'Use this fallback order', variant: 'primary' }); save.disabled = !current.editable;
        save.addEventListener('click', () => {
            if (!data()?.editable || !onCustom(primary, customEntries)) return;
            customEntries = null; signature = ''; refresh();
        });
        editor.append(ordered, search, results, save); host.append(editor);
    }
    return { refresh, close, open(primary, { custom = false } = {}) {
        picker.close({ restore: false }); pickerKey = '';
        intent = { benchmarkID: primary.benchmarkID, scope: getScope() }; dialog.hidden = false; signature = '';
        const current = data();
        if (!current) { close(); return; }
        customEntries = custom ? structuredClone(current.rule?.entries ?? []) : null;
        customPrimaryID = custom ? primary.conditionID ?? primary.ID : null;
        refresh(); return true;
    } };
}
