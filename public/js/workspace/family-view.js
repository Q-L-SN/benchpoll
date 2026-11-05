import { groupSmallFamilies, familyKey, familyEntryKey } from '../shared/benchmark-families.js';
import { benchmarkAccessibleName } from './weights.js';
import { setVisible } from '../shared/motion.js';
import { mountDisclosureChevron } from '../shared/ui-components.js';
import { PIE_GRADIENTS } from './constants.js';
import { createBenchmarkInformationLink, appendBenchmarkIdentity } from './benchmark-link.js';

const percentage = points => points > 0 && points < 1 ? '<0.01%' : `${Number((points / 100).toFixed(2))}%`;
export const familyMemberName = benchmarkAccessibleName;
const chainLabel = (primary, entries) => [primary, ...entries].map(familyMemberName).join(', then ');
const iconButton = (icon, label, action) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'bp-family-action'; button.dataset.tooltip = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = `<i class="fa-solid fa-${icon}" aria-hidden="true"></i>`;
    button.addEventListener('click', event => { event.stopPropagation(); action(); });
    return button;
};

export function createFamilyView({ container, onMove, onRemove, getMemberURL, onInspectVersion }) {
    const informationLink = member => createBenchmarkInformationLink(member,
        { getURL: getMemberURL, onInspect: onInspectVersion });
    let expandedPrimaryID = null;
    let smallExpanded = false;
    const expandedFamilies = new Set();
    let cancelDrag = null;
    let personalRenderKey = '';
    let reorderPositions = null;

    function moveWithAnimation(list, key, index, target) {
        const rows = [...list.querySelectorAll('.bp-family-member')];
        const order = rows.map(row => ({ key: row.dataset.conditionId, top: row.getBoundingClientRect().top }));
        order.splice(target, 0, order.splice(index, 1)[0]);
        reorderPositions = new Map(order.map(item => [item.key, item.top]));
        if (onMove(key, target) === false) reorderPositions = null;
    }

    function animateReorder(list) {
        const previous = reorderPositions; reorderPositions = null;
        if (!previous || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        for (const row of list.querySelectorAll('.bp-family-member')) {
            const top = previous.get(row.dataset.conditionId);
            const delta = top === undefined ? 0 : top - row.getBoundingClientRect().top;
            if (Math.abs(delta) > .5) row.animate([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
                { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)' });
        }
    }

    function reset(className) {
        cancelDrag?.(); cancelDrag = null;
        const focus = container.contains(document.activeElement) ? document.activeElement.dataset.familyFocus : null;
        container.classList.remove('is-personal-chain', 'is-public-families');
        container.classList.add(className); container.replaceChildren();
        return () => {
            if (focus) [...container.querySelectorAll('[data-family-focus]')].find(node => node.dataset.familyFocus === focus)?.focus({ preventScroll: true });
        };
    }

    function bindDrag(handle, row, list, memberKey, index, disabled) {
        let drag = null;
        let suppressClick = false;
        handle.style.touchAction = 'none';
        const clear = () => {
            if (cancelDrag === clear) cancelDrag = null;
            if (!drag) return;
            const pointer = drag.pointer; drag = null;
            row.classList.remove('is-dragging'); list.classList.remove('is-reordering');
            for (const item of list.children) { item.style.transform = ''; item.classList.remove('is-drop-target'); }
            if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
        };
        handle.addEventListener('pointerdown', event => {
            if (disabled || !event.isPrimary || event.button !== 0) return;
            event.preventDefault(); event.stopPropagation();
            drag = { pointer: event.pointerId, y: event.clientY, target: index, moved: false, scrollTop: container.scrollTop };
            handle.setPointerCapture(event.pointerId); cancelDrag = clear;
        });
        handle.addEventListener('pointermove', event => {
            if (!drag || drag.pointer !== event.pointerId) return;
            event.preventDefault();
            let delta = event.clientY - drag.y + container.scrollTop - drag.scrollTop;
            if (Math.abs(delta) < 5 && !drag.moved) return;
            if (!drag.moved) {
                const before = row.getBoundingClientRect().top;
                list.classList.add('is-reordering');
                drag.layoutOffset = before - row.getBoundingClientRect().top;
            }
            delta += drag.layoutOffset;
            drag.moved = true; row.classList.add('is-dragging');
            row.style.transform = `translateY(${delta}px)`;
            const bounds = container.getBoundingClientRect();
            if (event.clientY < bounds.top + 35) container.scrollTop -= 12;
            if (event.clientY > bounds.bottom - 35) container.scrollTop += 12;
            const rows = [...list.children].filter(item => item.classList.contains('bp-family-member'));
            const originalCenter = row.getBoundingClientRect().top - delta + row.offsetHeight / 2;
            const center = originalCenter + delta;
            let target = index;
            rows.forEach((item, position) => {
                if (position === index) return;
                const rect = item.getBoundingClientRect();
                if (position < index && center <= rect.top + rect.height / 2 + .5) target = Math.min(target, position);
                if (position > index && center >= rect.top + rect.height / 2 - .5) target = Math.max(target, position);
            });
            drag.target = target;
            rows.forEach((item, position) => item.classList.toggle('is-drop-target', position === target && position !== index));
        });
        handle.addEventListener('pointerup', event => {
            if (!drag || drag.pointer !== event.pointerId) return;
            const { target, moved } = drag; clear(); cancelDrag = null;
            suppressClick = true;
            if (moved && target !== index) onMove(memberKey, target);
        });
        handle.addEventListener('pointercancel', () => { clear(); cancelDrag = null; });
        handle.addEventListener('lostpointercapture', clear);
        handle.addEventListener('click', event => {
            if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; }
        }, true);
    }

    function createPersonalList({ primary, entries, active, disabled, editing }) {
        if (!entries.length) {
            const empty = document.createElement('span'); empty.className = editing ? 'bp-inline-fallback-empty' : 'bp-fallback-preview-empty';
            empty.textContent = editing ? (active ? 'Use + in the Evaluation items list to add a fallback' : 'Use Add fallback benchmark below to choose a backup') : 'No fallback';
            return empty;
        }
        const list = document.createElement('ol'); list.className = `bp-family-chain bp-fallback-chain${editing ? '' : ' is-preview'}`;
        list.setAttribute('role', 'list');
        list.setAttribute('aria-label', `Fallback order for ${benchmarkAccessibleName(primary)}`);
        entries.forEach((entry, index) => {
            const key = familyEntryKey(entry, index);
            const name = familyMemberName(entry);
            const row = document.createElement('li'); row.className = 'bp-family-member bp-fallback-chain-step';
            row.dataset.conditionId = String(key);
            const identity = document.createElement('span'); identity.className = 'bp-family-member-name';
            appendBenchmarkIdentity(identity, entry, { showVersion: true });
            if (editing) {
                const handle = iconButton('grip-vertical', 'Drag to reorder this fallback', () => {});
                handle.classList.add('bp-family-drag'); handle.disabled = disabled; handle.dataset.familyFocus = `drag-${key}`;
                bindDrag(handle, row, list, key, index, disabled);
                const actions = document.createElement('span'); actions.className = 'bp-family-actions';
                const up = iconButton('arrow-up', `Move ${name} earlier`, () => moveWithAnimation(list, key, index, index - 1));
                const down = iconButton('arrow-down', `Move ${name} later`, () => moveWithAnimation(list, key, index, index + 1));
                const remove = iconButton('trash-can', `Remove ${name} from fallback`, () => onRemove(key));
                up.disabled = disabled || index === 0; down.disabled = disabled || index === entries.length - 1; remove.disabled = disabled;
                up.dataset.familyFocus = `up-${key}`; down.dataset.familyFocus = `down-${key}`; remove.dataset.familyFocus = `remove-${key}`;
                actions.append(up, down, remove); row.append(handle, identity, actions);
            } else row.append(identity);
            list.append(row);
        });
        return list;
    }

    function renderPersonal({ primary, entries, active, disabled }) {
        const key = JSON.stringify([primary, entries, active, disabled]);
        if (cancelDrag && personalRenderKey === key) return;
        personalRenderKey = key;
        const restoreFocus = reset('is-personal-chain');
        const list = createPersonalList({ primary, entries, active, disabled, editing: true });
        container.append(list); restoreFocus(); animateReorder(list);
    }

    function renderPreview(preview, { primary, entries }) {
        cancelDrag?.(); cancelDrag = null;
        preview.replaceChildren();
        preview.append(createPersonalList({ primary, entries, editing: false }));
    }

    function renderPublic({ primary, families }) {
        reset('is-public-families');
        if (expandedPrimaryID !== primary.ID) { expandedPrimaryID = primary.ID; smallExpanded = false; expandedFamilies.clear(); }
        const grouped = groupSmallFamilies(families);
        const bar = document.createElement('div'); bar.className = 'bp-family-composition-bar';
        bar.setAttribute('aria-label', `Fallback configuration shares within ${benchmarkAccessibleName(primary)}`);
        const list = document.createElement('ul'); list.className = 'bp-family-composition-list';
        const toggles = new Map();
        const appendFamily = (family, index, parent) => {
            const key = familyKey(primary.ID, family.entries);
            const row = document.createElement('li'); row.className = 'bp-family-composition-row';
            row.style.setProperty('--bp-family-color', `var(--bp-chart-${index % PIE_GRADIENTS.length}-start, ${PIE_GRADIENTS[index % PIE_GRADIENTS.length][0]})`);
            const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'bp-family-summary';
            const title = document.createElement('span'); title.className = 'bp-family-label';
            title.textContent = family.entries.length ? `Fallback configuration ${index + 1}` : 'No fallback';
            const count = document.createElement('small'); count.textContent = family.entries.length ? `${family.entries.length} fallback ${family.entries.length === 1 ? 'step' : 'steps'}` : 'Entrance only';
            title.append(count);
            const weight = document.createElement('strong'); weight.textContent = percentage(family.weightBasisPoints);
            toggle.append(title, weight);
            mountDisclosureChevron(toggle);
            toggle.dataset.tooltip = `${percentage(family.overallWeightBasisPoints)} of Public Weights`;
            const details = document.createElement('ol'); details.className = 'bp-family-expanded-chain bp-fallback-chain';
            details.setAttribute('role', 'list');
            details.setAttribute('aria-label', `Fallback order for ${benchmarkAccessibleName(primary)}`);
            details.hidden = !expandedFamilies.has(key);
            for (const member of [primary, ...family.entries]) {
                const item = document.createElement('li'); item.className = 'bp-fallback-chain-step';
                item.append(informationLink(member));
                details.append(item);
            }
            const sync = () => toggle.setAttribute('aria-expanded', String(expandedFamilies.has(key)));
            const expand = () => {
                if (expandedFamilies.has(key)) expandedFamilies.delete(key); else expandedFamilies.add(key);
                sync(); void setVisible(details, expandedFamilies.has(key), { collapse: true });
            };
            sync(); toggle.addEventListener('click', expand); toggles.set(key, expand);
            row.append(toggle, details); parent.append(row);
        };
        const addSegment = (weight, index, label, action, other = false) => {
            const segment = document.createElement('button'); segment.type = 'button'; segment.className = 'bp-family-composition-segment';
            segment.classList.toggle('is-other', other); segment.style.setProperty('--bp-family-share', `${weight / 100}%`);
            segment.style.setProperty('--bp-family-color', `var(--bp-chart-${index % PIE_GRADIENTS.length}-start, ${PIE_GRADIENTS[index % PIE_GRADIENTS.length][0]})`);
            segment.dataset.tooltip = label; segment.setAttribute('aria-label', label);
            if (weight >= 1000) segment.textContent = percentage(weight);
            segment.addEventListener('click', action); bar.append(segment);
        };
        grouped.visible.forEach((family, index) => {
            appendFamily(family, index, list);
            addSegment(family.weightBasisPoints, index, `${chainLabel(primary, family.entries)}: ${percentage(family.weightBasisPoints)}`,
                () => toggles.get(familyKey(primary.ID, family.entries))());
        });
        container.append(bar, list);
        if (grouped.other.length) {
            const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'bp-family-other-toggle';
            toggle.innerHTML = '<span></span><strong></strong>';
            mountDisclosureChevron(toggle);
            toggle.querySelector('span').textContent = `Other fallback configurations (${grouped.other.length})`;
            toggle.querySelector('strong').textContent = percentage(grouped.otherWeightBasisPoints);
            const details = document.createElement('ul'); details.className = 'bp-family-composition-list bp-family-other-list'; details.hidden = !smallExpanded;
            grouped.other.forEach((family, index) => appendFamily(family, index + grouped.visible.length, details));
            const sync = () => toggle.setAttribute('aria-expanded', String(smallExpanded));
            const expand = () => { smallExpanded = !smallExpanded; sync(); void setVisible(details, smallExpanded, { collapse: true }); };
            sync(); toggle.addEventListener('click', expand);
            addSegment(grouped.otherWeightBasisPoints, 0, `Other fallback configurations: ${percentage(grouped.otherWeightBasisPoints)}`, expand, true);
            container.append(toggle, details);
        }
    }
    return { renderPersonal, renderPreview, renderPublic };
}
