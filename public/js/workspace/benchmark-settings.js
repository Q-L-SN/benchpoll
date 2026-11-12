import { createAction, createDisclosureTrigger, mountSegmentedControl } from '../shared/ui-components.js';
import { versionChoiceOrder } from '../shared/benchmark-version-choice.js';
import { createEvidenceCount } from '../shared/evidence-count.js';
import { setHelpText } from '../shared/help-popover.js';
import { createChoicePager } from '../shared/choice-pager.js';
import { createExclusiveDisclosure } from '../shared/exclusive-disclosure.js';
import { createFallbackPicker } from './fallback-picker.js';

const STYLE_KEY = 'benchpoll:benchmark-settings-style';
const node = (tag, className = '', text) => {
    const result = document.createElement(tag); result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
};
const versionName = version => version.conditionName?.toLowerCase() === 'default' ? 'Default evaluation' : version.conditionName;
const shareLabel = points => points > 0 && points < 1 ? '<0.01%' : `${Number(((points ?? 0) / 100).toFixed(2))}%`;
const versionHelp = 'Your version choice contributes to community proportions, weighted by your allocation to this benchmark. '
    + 'Versions are ordered by selection share, then approved score count. Click your selected version again to clear your vote and follow the community.';
function readStyle() {
    try { return localStorage.getItem(STYLE_KEY) === 'accordion' ? 'accordion' : 'pages'; }
    catch { return 'pages'; }
}
let nextID = 0;

export function createBenchmarkSettings({ host, selectedHeader, getScope, getData, onVersion, onEdit, editor, fallbackPickerOptions }) {
    const panel = host, prefix = host.id || `benchmark-settings-${++nextID}`;
    const title = node('h3', 'bp-benchmark-settings-title'); title.hidden = Boolean(selectedHeader);
    const readOnlyNotice = node('p', 'bp-benchmark-settings-readonly', 'Read-only · Explore community versions and fallback configurations.');
    const controls = node('div', 'bp-benchmark-settings-controls');
    const styleLabel = node('span', 'bp-benchmark-settings-style-label', 'Test style');
    const styles = node('div', 'bp-benchmark-settings-styles');
    styles.setAttribute('role', 'group'); styles.setAttribute('aria-label', 'Configuration test style');
    const styleButtons = ['pages', 'accordion'].map(style => {
        const control = node('button', '', style === 'pages' ? 'Pages' : 'Accordion'); control.type = 'button';
        control.dataset.settingsStyle = style;
        control.addEventListener('click', () => setStyle(style)); return control;
    });
    styles.append(...styleButtons); controls.append(styleLabel, styles);
    const segmented = mountSegmentedControl(styles);
    const status = node('p', 'bp-benchmark-settings-status'); status.setAttribute('role', 'status');
    const body = node('div', 'bp-benchmark-settings-body');
    const scroller = node('div', 'bp-benchmark-settings-scroll');
    const section = (key, label) => {
        const element = node('section', `bp-benchmark-settings-section bp-benchmark-settings-${key}`);
        const heading = node('div', 'bp-benchmark-settings-section-heading');
        const trigger = createDisclosureTrigger({ name: label, className: 'bp-benchmark-settings-disclosure' });
        trigger.id = `${prefix}-${key}-trigger`;
        const state = node('span', 'bp-benchmark-settings-choice-state', 'Not selected');
        trigger.querySelector('.bp-ui-disclosure-label').append(state);
        const content = node('div', 'bp-benchmark-settings-section-content'); content.id = `${prefix}-${key}-content`;
        trigger.setAttribute('aria-controls', content.id);
        heading.append(trigger); element.append(heading, content);
        return { key, section: element, heading, trigger, panel: content, state };
    };
    const versions = section('versions', 'Choose version');
    const help = createAction({ label: 'About community version choices', icon: 'fa-regular fa-circle-question', iconOnly: true });
    setHelpText(help, versionHelp);
    versions.heading.append(help);
    const list = node('div', 'bp-version-choices'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', 'Benchmark versions');
    const fallback = section('fallback', 'Choose fallback configuration');
    const placeholder = node('p', 'bp-benchmark-settings-placeholder', 'Select a version above to choose its fallback.');
    const pickerHost = node('div');
    const editorHost = node('div', 'bp-benchmark-settings-editor'); editorHost.hidden = true;
    const pickerActions = node('div', 'bp-benchmark-settings-actions');
    fallback.panel.append(placeholder, pickerHost, editorHost, pickerActions);
    scroller.append(versions.section, fallback.section); body.append(status, scroller);
    panel.append(title, readOnlyNotice, controls, body);
    const editorHome = editor.parentElement, editorNext = editor.nextSibling;
    let intent = null, pickerKey = '', inspectedVersion = null, style = readStyle();
    const versionOrder = new Map();
    const versionPager = createChoicePager({ list, label: 'Versions', pageSize: 6, neighbors: 3,
        getKey: version => version.conditionID, renderItem: createVersion, onRender: updateVersionSelection });
    versions.panel.append(versionPager.element);
    const disclosure = createExclusiveDisclosure({ items: [versions, fallback], initial: 'versions',
        canOpen: key => key !== 'fallback' || selectedVersion(data()) !== null,
        onChange: () => { updateActivePanels(); revealPanels(); } });
    const picker = createFallbackPicker({ ...fallbackPickerOptions, host: pickerHost, actionsHost: pickerActions,
        helpHost: fallback.heading,
        onInspectVersion(event) { pickerKey = ''; fallbackPickerOptions.onInspectVersion?.(event); refresh(); },
        onCustomize(primary) {
            const current = data();
            if (!current?.editable || current.readOnly || !onEdit(primary)) return false;
            disclosure.open('fallback'); refresh(); return true;
        }
    });
    let observedScrollRoot = null;
    const layoutResize = new ResizeObserver(updateStickyGeometry);
    if (selectedHeader) layoutResize.observe(selectedHeader);
    window.addEventListener('resize', updateStickyGeometry);

    function scrollParent() {
        for (let parent = panel.parentElement; parent; parent = parent.parentElement) {
            if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent;
        }
        return null;
    }
    function updateStickyGeometry() {
        const root = scrollParent();
        if (root !== observedScrollRoot) {
            if (observedScrollRoot) layoutResize.unobserve(observedScrollRoot);
            observedScrollRoot = root;
            if (root) layoutResize.observe(root);
        }
        const top = selectedHeader ? selectedHeader.getBoundingClientRect().height
            + (parseFloat(getComputedStyle(selectedHeader).top) || 0) : 0;
        const rootStyle = root && getComputedStyle(root);
        const paddingTop = parseFloat(rootStyle?.paddingTop) || 0, paddingBottom = parseFloat(rootStyle?.paddingBottom) || 0;
        const reservedBottom = parseFloat(rootStyle?.scrollPaddingBottom) || 0;
        // Sticky positioning already respects the pane's content padding. Add
        // only the part of the mobile dock reservation not supplied by padding.
        const bottom = Math.max(0, reservedBottom - paddingBottom);
        const available = Math.max(0, (root?.clientHeight ?? window.innerHeight)
            - paddingTop - top - Math.max(reservedBottom, paddingBottom));
        panel.style.setProperty('--bp-settings-sticky-top', `${top}px`);
        panel.style.setProperty('--bp-settings-sticky-bottom', `${bottom}px`);
        panel.style.setProperty('--bp-settings-bottom-cover', `${Math.max(reservedBottom, paddingBottom)}px`);
        panel.style.setProperty('--bp-settings-available-height', `${available}px`);
    }
    function revealPanels() {
        if (style !== 'accordion' || !intent) return;
        const active = intent;
        requestAnimationFrame(() => {
            if (intent !== active || panel.hidden || style !== 'accordion') return;
            updateStickyGeometry();
            const root = scrollParent();
            const top = parseFloat(panel.style.getPropertyValue('--bp-settings-sticky-top')) || 0;
            const padding = root ? parseFloat(getComputedStyle(root).paddingTop) || 0 : 0;
            const distance = scroller.getBoundingClientRect().top - (root?.getBoundingClientRect().top ?? 0) - padding - top;
            if (root) root.scrollTop += distance;
            else window.scrollBy({ top: distance, behavior: 'instant' });
        });
    }

    function close() {
        versionPager.setActive(false); picker.setActive(false); picker.close({ restore: false }); pickerKey = '';
        versionOrder.clear(); inspectedVersion = null;
        if (editor.parentElement === editorHost) editorHome.insertBefore(editor, editorNext);
        panel.hidden = true; intent = null; disclosure.reset();
        versionPager.setItems([]); versionPager.reset();
    }
    function data() {
        if (!intent || panel.hidden) return null;
        if (intent.scope !== getScope()) { close(); return null; }
        return getData(intent.benchmarkID);
    }
    function selectedVersion(current) {
        if (!current) return null;
        const selected = current.readOnly ? inspectedVersion
            : current.entries.length === 1 && current.entries[0].followCommunityVersion !== true ? current.entries[0].conditionID : null;
        return current.group.versions.find(version => version.conditionID === selected) ?? null;
    }
    function retarget(primary) {
        const scope = getScope();
        if (intent?.scope !== scope || intent?.benchmarkID !== primary.benchmarkID) {
            close(); intent = { benchmarkID: primary.benchmarkID, scope };
        }
        panel.hidden = false;
    }
    function choose(conditionID) {
        const current = data();
        if (!current || current.busy) return;
        const selected = selectedVersion(current)?.conditionID;
        const next = conditionID === selected ? null : conditionID;
        if (current.readOnly) inspectedVersion = next;
        else if (!current.editable || !onVersion(current.group, next)) return;
        // Only a concrete new choice advances to fallback. Clearing a choice
        // remains on Versions, including the inspection-only public view.
        if (next !== null) disclosure.open('fallback');
        else disclosure.open('versions');
        refresh();
        if (style === 'accordion' && next !== null) fallback.trigger.focus({ preventScroll: true });
    }
    function createVersion(version) {
        const choice = node('button', 'bp-version-choice'); choice.type = 'button';
        choice.dataset.conditionId = String(version.conditionID);
        const count = createEvidenceCount(version.scoreCount); count.removeAttribute('tabindex');
        choice.append(node('span', 'bp-version-choice-name', versionName(version)), count,
            node('span', 'bp-version-choice-share', shareLabel(version.selectionBasisPoints)));
        if (version.isPrimaryCondition) {
            choice.dataset.defaultVersion = 'true';
            choice.setAttribute('aria-description', 'Primary version when there are no community choices.');
        }
        choice.addEventListener('click', () => choose(version.conditionID));
        return choice;
    }
    function updateVersionSelection() {
        const current = data();
        if (!current) return;
        const selected = selectedVersion(current)?.conditionID;
        for (const choice of list.querySelectorAll('.bp-version-choice')) {
            choice.disabled = Boolean(current.busy) || !current.readOnly && !current.editable;
            choice.setAttribute('aria-pressed', String(!current.readOnly && Number(choice.dataset.conditionId) === selected));
            if (current.readOnly && Number(choice.dataset.conditionId) === selected) choice.setAttribute('aria-current', 'true');
            else choice.removeAttribute('aria-current');
        }
    }
    function orderedVersions(values) {
        const ordered = [...values].sort(versionChoiceOrder);
        for (const version of ordered) {
            if (!versionOrder.has(version.conditionID)) versionOrder.set(version.conditionID, versionOrder.size);
        }
        return ordered.sort((a, b) => versionOrder.get(a.conditionID) - versionOrder.get(b.conditionID));
    }
    function updateActivePanels() {
        const open = Boolean(intent) && !panel.hidden;
        versionPager.setActive(open && (style === 'pages' || disclosure.current() === 'versions'));
        picker.setActive(open && (style === 'pages' || disclosure.current() === 'fallback'));
    }
    function applyStyle() {
        panel.dataset.style = style;
        for (const control of styleButtons) control.setAttribute('aria-pressed', String(control.dataset.settingsStyle === style));
        disclosure.setEnabled(style === 'accordion');
        versionPager.setMode(style === 'accordion' ? 'continuous' : 'pages');
        picker.setLayout(style);
        updateActivePanels(); updateStickyGeometry(); segmented.refresh();
    }
    function setStyle(value) {
        if (style === value) return;
        style = value;
        try { localStorage.setItem(STYLE_KEY, style); } catch { /* The session still uses the selected style. */ }
        disclosure.reset(); applyStyle(); refresh(); revealPanels();
    }
    function refresh(primary, expanded) {
        if (primary !== undefined) {
            if (!primary || !expanded) { close(); return; }
            retarget(primary);
        }
        const current = data();
        if (!current) { close(); return; }
        const { group, entries, rule, readOnly, editing } = current;
        const selected = selectedVersion(current);
        title.textContent = group.name;
        readOnlyNotice.hidden = !readOnly;
        setHelpText(help, readOnly
            ? 'Inspect any version to view its fallback configurations. Community proportions are weighted by each person’s allocation to this benchmark.'
            : versionHelp);
        panel.dataset.readonly = String(Boolean(readOnly));
        status.hidden = Boolean(readOnly);
        status.textContent = entries.length > 1 ? 'Choose a version to replace your saved mix.'
            : !selected ? current.isPrivate ? 'Using the default version and fallback.' : 'Versions and fallback follow community.'
                : !rule ? current.isPrivate ? 'Using the default fallback.' : 'Fallback follows community.'
                    : 'Select an option again to deselect it.';
        status.dataset.selection = !selected ? 'community' : !rule ? 'version' : 'manual';
        versions.state.textContent = selected ? versionName(selected) : 'Not selected';
        fallback.state.textContent = !readOnly && selected && rule ? 'Selected' : 'Not selected';
        fallback.trigger.setAttribute('aria-disabled', String(!selected));
        if (!selected) {
            fallback.trigger.dataset.tooltip = 'Select a version first to inspect its fallback configurations.';
            disclosure.open('versions');
        } else fallback.trigger.removeAttribute('data-tooltip');
        versionPager.setItems(orderedVersions(group.versions));
        placeholder.hidden = Boolean(selected);
        editorHost.hidden = readOnly || !editing;
        if (editing && !readOnly && editor.parentElement !== editorHost) editorHost.append(editor);
        if (!selected || editing && !readOnly) { picker.close({ restore: false }); pickerKey = ''; }
        else {
            const action = readOnly ? 'view' : 'replace', key = `${selected.conditionID}:${action}`;
            if (pickerKey !== key) {
                pickerKey = key;
                picker.open({ ...selected, ID: selected.conditionID }, { action, visit: intent });
            } else picker.refresh();
        }
        applyStyle();
    }
    applyStyle();
    return { refresh, close, open(primary, { custom = false } = {}) {
        retarget(primary);
        const current = data();
        if (!current) { close(); return; }
        if (custom && (!current.editable || current.readOnly || !onEdit(primary))) return false;
        if (custom) disclosure.open('fallback');
        refresh(); revealPanels(); return true;
    } };
}
