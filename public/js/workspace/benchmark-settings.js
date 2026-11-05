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

export function createBenchmarkSettings({ host, getScope, getData, onVersion, onContribute, onEdit, editor, fallbackPickerOptions }) {
    const panel = host;
    const title = node('h3', 'bp-benchmark-settings-title');
    const body = node('div', 'bp-benchmark-settings-body');
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
    const actions = node('div', 'bp-benchmark-settings-actions');
    const pickerActions = node('div'); actions.append(pickerActions);
    panel.append(title, body, actions);
    const editorHome = editor.parentElement, editorNext = editor.nextSibling;
    let intent = null, signature = '', pickerKey = '';
    const versionOrder = new Map();
    const picker = createFallbackPicker({ ...fallbackPickerOptions, host: pickerHost, actionsHost: pickerActions,
        onInspectVersion(event) { pickerKey = ''; fallbackPickerOptions.onInspectVersion?.(event); refresh(); },
        onCustomize(primary) {
            const current = data();
            if (!current?.editable) return false;
            if (!onEdit(primary)) return false;
            signature = ''; refresh(); return true;
        }
    });
    function close() {
        picker.close({ restore: false }); pickerKey = '';
        versionOrder.clear();
        if (editor.parentElement === editorHost) editorHome.insertBefore(editor, editorNext);
        panel.hidden = true; intent = null; signature = '';
    }
    contribute.addEventListener('click', async () => {
        const current = data(); if (!current || current.busy) return;
        contribute.disabled = true;
        try { await onContribute(current.group); }
        finally { if (data()) { signature = ''; refresh(); } }
    });
    function data() {
        if (!intent || panel.hidden) return null;
        if (intent.scope !== getScope()) { close(); return null; }
        return getData(intent.benchmarkID);
    }
    function retarget(primary) {
        const scope = getScope();
        if (intent?.scope !== scope || intent?.benchmarkID !== primary.benchmarkID) {
            close();
            intent = { benchmarkID: primary.benchmarkID, scope };
        }
        panel.hidden = false;
    }
    function choose(conditionID) {
        const current = data();
        if (!current?.editable || !onVersion(current.group, conditionID)) return;
        signature = ''; refresh();
    }
    function orderedVersions(versions) {
        const ordered = [...versions].sort(versionChoiceOrder);
        // Keep this visit's positions while shares and selection update after saves.
        // Newly available versions append; reopening starts with a fresh ranking.
        for (const version of ordered) {
            if (!versionOrder.has(version.conditionID)) versionOrder.set(version.conditionID, versionOrder.size);
        }
        return ordered.sort((a, b) => versionOrder.get(a.conditionID) - versionOrder.get(b.conditionID));
    }
    function refresh(primary, expanded) {
        if (primary !== undefined) {
            if (!primary || !expanded) { close(); return; }
            retarget(primary);
        }
        const current = data();
        if (!current) { close(); return; }
        const { group, entries, rule, editable, editing } = current;
        const selected = entries.length === 1 && entries[0].followCommunityVersion !== true ? entries[0].conditionID : null;
        title.textContent = group.name;
        status.textContent = entries.length > 1 ? 'Choose a version to replace your saved mix.'
            : selected === null ? current.isPrivate ? 'Using the default version and fallback.' : 'Versions and fallback follow community.'
                : !rule ? current.isPrivate ? 'Using the default fallback.' : 'Fallback follows community.'
                    : 'Select an option again to deselect it.';
        status.dataset.selection = selected === null ? 'community' : !rule ? 'version' : 'manual';
        contribute.hidden = editable || current.busy; contribute.disabled = current.busy;
        const nextSignature = JSON.stringify([group, entries, rule, editable, editing]);
        if (signature !== nextSignature) {
            const focusKey = body.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
            const scroll = list.scrollTop;
            signature = nextSignature;
            list.replaceChildren(...orderedVersions(group.versions).map(version => {
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
            if (focusKey) [...body.querySelectorAll('[data-focus-key]')].find(item => item.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
        }
        const selectedVersion = group.versions.find(version => version.conditionID === selected);
        placeholder.hidden = Boolean(selectedVersion);
        editorHost.hidden = !editing;
        if (editing && editor.parentElement !== editorHost) editorHost.append(editor);
        if (!selectedVersion || editing) { picker.close({ restore: false }); pickerKey = ''; return; }
        const action = editable || current.busy ? 'replace' : 'view';
        const key = `${selectedVersion.conditionID}:${action}`;
        if (pickerKey !== key) {
            pickerKey = key;
            picker.open({ ...selectedVersion, ID: selectedVersion.conditionID }, { action });
        } else picker.refresh();
    }
    return { refresh, close, open(primary, { custom = false } = {}) {
        retarget(primary); signature = '';
        const current = data();
        if (!current) { close(); return; }
        if (custom && (!current.editable || !onEdit(primary))) return false;
        refresh(); return true;
    } };
}
