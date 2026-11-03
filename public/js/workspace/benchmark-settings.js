import { createAction } from '../shared/ui-components.js';
import { versionChoiceOrder } from '../shared/benchmark-version-choice.js';
import { fallbackStatusLabel } from '../shared/fallback-choice.js';

const node = (tag, className = '', text) => {
    const result = document.createElement(tag); result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
};
const versionName = version => version.conditionName?.toLowerCase() === 'default' ? 'Default evaluation' : version.conditionName;
const shareLabel = points => points > 0 && points < 1 ? '<0.01%' : `${Number(((points ?? 0) / 100).toFixed(2))}%`;

export function createBenchmarkSettings({ getScope, getData, onVersion, onContribute, onFallback, onCustom }) {
    const dialog = node('global-dialog', 'bp-benchmark-settings'); dialog.id = 'benchmark-settings'; dialog.hidden = true;
    const heading = node('div', 'bp-fallback-picker-heading'); heading.slot = 'title';
    const title = node('span', '', 'Help the community configure this benchmark'); heading.append(title);
    const closeButton = node('button', 'bp-fallback-picker-close'); closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Close benchmark settings');
    const closeIcon = node('i', 'fa-solid fa-xmark'); closeIcon.setAttribute('aria-hidden', 'true'); closeButton.append(closeIcon);
    heading.append(closeButton);
    const body = node('div', 'bp-benchmark-settings-body'); body.slot = 'body';
    const actions = node('div'); actions.slot = 'actions';
    const done = createAction({ label: 'Done' }); actions.append(done);
    dialog.append(heading, body, actions); document.body.append(dialog);
    let intent = null, signature = '', customEntries = null, customPrimaryID = null;
    function close() { dialog.hidden = true; intent = null; signature = ''; customEntries = null; }
    closeButton.addEventListener('click', close); done.addEventListener('click', close);
    dialog.addEventListener('cancel', close);

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
        title.textContent = current.isPrivate ? 'Configure versions and fallback' : 'Help the community configure this benchmark';
        const selected = entries.length === 1 && entries[0].followCommunityVersion !== true ? entries[0].conditionID : null;
        if (customEntries && selected !== customPrimaryID) customEntries = null;
        const nextSignature = JSON.stringify([group, entries, rule, editable, customEntries]);
        if (signature === nextSignature) return;
        const focusKey = body.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
        signature = nextSignature;
        body.replaceChildren(node('p', 'bp-benchmark-settings-name', group.name), node('p', 'bp-benchmark-settings-intro',
            'Help choose versions and fallback for this topic and scene. Each choice is optional.'));
        const explanation = node('p', 'bp-benchmark-settings-explanation', current.isPrivate
            ? 'These choices stay private. Without an explicit version, this ranking uses the designated primary version.'
            : 'Only explicit choices shape community proportions, weighted by your allocation to this benchmark. Following the community does not add a vote.');
        body.append(explanation);
        if (!editable && !current.busy) {
            const contribute = createAction({ label: 'Configure in Personal Weights', variant: 'primary' });
            contribute.addEventListener('click', async () => {
                contribute.disabled = true;
                await onContribute(group);
                if (data()) { signature = ''; refresh(); }
            });
            body.append(contribute);
        }
        const versions = node('section', 'bp-benchmark-settings-section');
        versions.append(node('h3', '', '1. Benchmark version'), node('p', 'bp-benchmark-settings-hint',
            `${group.configuredPieCount} explicit ${group.configuredPieCount === 1 ? 'choice' : 'choices'} in this topic / scene. Ordered by selection share, then approved score count.`));
        const community = createAction({ className: 'bp-version-community', label: 'Follow community', variant: 'secondary' });
        community.dataset.focusKey = 'community';
        community.setAttribute('aria-pressed', String(entries.length === 1 && entries[0].followCommunityVersion === true));
        community.disabled = !editable;
        community.addEventListener('click', () => choose(null));
        versions.append(community, node('p', 'bp-benchmark-settings-hint', group.isDefault
            ? 'No explicit version choices yet. The designated primary version is used until someone contributes.'
            : 'With no version selected, your benchmark weight follows the community’s version proportions.'));
        if (entries.length > 1) versions.append(node('p', 'bp-benchmark-settings-hint',
            'Your saved mix includes multiple versions. Choosing one combines their benchmark weights and clears their fallback choices.'));
        const list = node('div', 'bp-version-choices'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', 'Benchmark versions');
        for (const version of [...group.versions].sort(versionChoiceOrder)) {
            const choice = node('button', 'bp-version-choice'); choice.type = 'button';
            choice.dataset.conditionId = String(version.conditionID); choice.dataset.focusKey = `version-${version.conditionID}`;
            choice.disabled = !editable; choice.setAttribute('aria-pressed', String(selected === version.conditionID));
            const label = node('span', 'bp-version-choice-name', versionName(version));
            const detail = node('small', '', `${version.scoreCount} approved scores${group.isDefault && version.conditionID === group.primaryConditionID ? ' · Primary version' : ''}`);
            const share = node('span', 'bp-version-choice-share', shareLabel(version.selectionBasisPoints));
            const copy = node('span'); copy.append(label, detail); choice.append(copy, share);
            choice.addEventListener('click', () => choose(selected === version.conditionID ? null : version.conditionID));
            list.append(choice);
        }
        versions.append(list); body.append(versions);
        const fallback = node('section', 'bp-benchmark-settings-section');
        fallback.append(node('h3', '', '2. Fallback configuration'));
        const primary = group.versions.find(version => version.conditionID === selected);
        fallback.append(node('p', 'bp-benchmark-settings-hint', primary
            ? `Starts with ${versionName(primary)}. You can leave fallback on Follow community without changing your version choice.`
            : 'Select a version first to choose a fallback order starting with that version.'));
        const configure = createAction({ label: `Fallback: ${rule && !rule.entries.length ? 'No fallback' : fallbackStatusLabel(rule)}`, icon: 'fa-solid fa-sliders', variant: 'secondary' });
        configure.disabled = !editable || !primary;
        configure.addEventListener('click', () => {
            const latest = data();
            if (!latest?.editable || latest.entries.length !== 1 || latest.entries[0].followCommunityVersion) return;
            close(); onFallback(primary);
        });
        fallback.append(configure);
        if (primary && rule) {
            const follow = createAction({ label: 'Follow community instead', variant: 'quiet' });
            follow.disabled = !editable;
            follow.addEventListener('click', () => { onCustom(primary, null); signature = ''; refresh(); });
            fallback.append(follow);
            const edit = createAction({ label: 'Edit fallback order', icon: 'fa-regular fa-pen-to-square', variant: 'quiet' });
            edit.disabled = !editable;
            edit.addEventListener('click', () => {
                const latest = data(); if (!latest?.editable) return;
                customEntries = structuredClone(latest.rule?.entries ?? []); customPrimaryID = primary.conditionID;
                signature = ''; refresh();
            });
            fallback.append(edit);
        }
        if (customEntries && primary) renderCustom(fallback, current, primary);
        body.append(fallback);
        if (focusKey) [...body.querySelectorAll('[data-focus-key]')].find(item => item.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
    }
    function renderCustom(host, current, primary) {
        const editor = node('div', 'bp-custom-fallback-editor');
        editor.append(node('h4', '', 'Your fallback order'), node('p', 'bp-benchmark-settings-hint',
            'Try the selected version first, then the backups below in order. An empty order explicitly chooses No fallback.'));
        const ordered = node('ol');
        ordered.append(node('li', '', `${current.group.name} · ${versionName(primary)} (first)`));
        customEntries.forEach((entry, index) => {
            const item = node('li'); item.append(node('span', '', `${entry.name} · ${versionName(entry)}`));
            for (const [label, delta] of [['Move up', -1], ['Move down', 1], ['Remove', 0]]) {
                const action = createAction({ label, variant: 'quiet' }); action.disabled = !current.editable
                    || delta < 0 && index === 0 || delta > 0 && index === customEntries.length - 1;
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
        intent = { benchmarkID: primary.benchmarkID, scope: getScope() }; dialog.hidden = false; signature = '';
        const current = data();
        if (!current) { close(); return; }
        customEntries = custom ? structuredClone(current.rule?.entries ?? []) : null;
        customPrimaryID = custom ? primary.conditionID ?? primary.ID : null;
        refresh();
        return true;
    } };
}
