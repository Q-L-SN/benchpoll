import { fieldDisplayValue, fieldKey, fieldNameKey } from './score-fields.js';
import { protectModelName } from './model-name.js?v=model-name-translation-20261006';
import { runFieldIcon } from './score-field-presets.js';

let labelLayout;

function updateParameterEdges(region) {
    const end = Math.max(0, region.scrollWidth - region.clientWidth);
    const position = Math.max(0, Math.min(end, region.scrollLeft));
    region.classList.toggle('can-scroll-left', position > 1);
    region.classList.toggle('can-scroll-right', end - position > 1);
}

function observeLabelLayout(target) {
    if (!globalThis.ResizeObserver || !globalThis.MutationObserver || !globalThis.document?.body) return;
    if (!labelLayout) {
        const labels = new Set();
        let frame = null;
        const refresh = () => {
            if (frame !== null) return;
            frame = requestAnimationFrame(() => {
                frame = null;
                for (const label of labels) {
                    if (!label.isConnected) {
                        resize.unobserve(label);
                        labels.delete(label);
                        continue;
                    }
                    updateParameterEdges(label);
                }
            });
        };
        const resize = new globalThis.ResizeObserver(refresh);
        const mutations = new MutationObserver(refresh);
        mutations.observe(document.body, { childList: true, characterData: true, subtree: true });
        document.fonts?.addEventListener('loadingdone', refresh);
        labelLayout = label => {
            if (!labels.has(label)) {
                labels.add(label);
                resize.observe(label);
            }
            refresh();
        };
    }
    labelLayout(target);
}

function createParameterRegion(items) {
    const region = document.createElement('span');
    region.className = 'bp-model-parameters';
    region.tabIndex = 0;
    region.setAttribute('role', 'group');
    region.setAttribute('aria-label', 'Run settings');
    region.append(...items);
    let pointer = null, dragged = false;
    const trackPointer = event => {
        if (pointer?.id === event.pointerId && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 6) dragged = true;
    };
    region.addEventListener('pointerdown', event => {
        pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
        dragged = false;
    });
    region.addEventListener('pointermove', trackPointer);
    region.addEventListener('pointerup', event => { trackPointer(event); pointer = null; });
    region.addEventListener('pointercancel', () => { pointer = null; dragged = true; });
    region.addEventListener('scroll', () => {
        if (pointer) dragged = true;
        updateParameterEdges(region);
    }, { passive: true });
    // A swipe can finish over a clickable ranking row or disclosure heading.
    region.addEventListener('click', event => {
        if (!dragged || event.detail === 0) return;
        dragged = false;
        event.preventDefault();
        event.stopPropagation();
    }, true);
    region.addEventListener('keydown', event => {
        if (event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? region.scrollWidth
            : region.scrollLeft + (event.key === 'ArrowRight' ? 48 : -48);
        region.scrollTo({ left: next });
    });
    observeLabelLayout(region);
    return region;
}

function iconFor(name) {
    const preset = runFieldIcon({ name });
    if (preset) return preset;
    const key = fieldNameKey(name);
    if (/harness.*version/.test(key)) return 'fa-code-branch';
    if (/harness/.test(key)) return 'fa-puzzle-piece';
    if (/reasoning|thinking/.test(key)) return 'fa-brain';
    if (/token|budget/.test(key)) return 'fa-coins';
    if (/search|web/.test(key)) return 'fa-globe';
    if (/temperature/.test(key)) return 'fa-temperature-half';
    if (/tool/.test(key)) return 'fa-screwdriver-wrench';
    return 'fa-tag';
}

export function comparisonDisplayParts(model, comparison = { keys: ['model'], fields: [], models: [] }) {
    let projection;
    try {
        const parsed = JSON.parse(model.comparisonIdentity);
        if (Array.isArray(parsed) && parsed.every(part => Array.isArray(part) && part.length === 3 && typeof part[0] === 'string' && typeof part[1] === 'boolean')) projection = parsed;
    } catch { /* Ungrouped evidence uses its recorded assignments instead. */ }
    if (!projection) {
        const configuration = model.members?.[0]?.condition ?? model.condition;
        const values = { ...(configuration?.parameters ?? {}), model: model.modelID };
        for (const assignment of configuration?.scoreFields ?? []) values[fieldKey(assignment.fieldID)] = assignment.value;
        projection = (comparison.keys ?? ['model']).map(key => [key, Object.hasOwn(values, key), values[key] ?? null]);
    }
    const selected = new Set(comparison.keys ?? ['model']);
    const parts = projection.filter(([key]) => selected.has(key)).map(([key, present, value]) => {
        if (key === 'model') {
            const name = comparison.models?.find(item => item.ID === value)?.name ?? model.modelName ?? model.name;
            return { kind: 'model', key, text: name, title: name };
        }
        const field = comparison.fields?.find(item => fieldKey(item.ID) === key);
        const fieldName = field?.name ?? key.replaceAll('_', ' ');
        const text = !present ? 'Not recorded' : field ? fieldDisplayValue(field, value) : value === null ? 'Empty' : String(value);
        return { kind: 'parameter', key, text, icon: iconFor(fieldName), title: `${fieldName}: ${text}` };
    });
    parts.sort((left, right) => left.kind === right.kind ? 0 : left.kind === 'model' ? -1 : 1);
    return parts.length ? parts : [{ kind: 'label', key: '', text: model.name, title: model.name }];
}

export function renderComparisonName(target, model, comparison, { fitParameters = true } = {}) {
    target.classList.add('bp-comparison-entry-label');
    const parts = comparisonDisplayParts(model, comparison);
    const items = parts.map(part => {
        const item = document.createElement('span');
        item.className = part.kind === 'parameter' ? 'bp-model-display-parameter' : 'bp-model-display-name';
        item.dataset.entryPart = part.key;
        item.dataset.tooltip = part.title;
        if (part.icon) {
            const icon = document.createElement('i');
            icon.className = `fa-solid ${part.icon}`;
            icon.setAttribute('aria-hidden', 'true');
            item.append(icon);
            item.setAttribute('aria-label', part.title);
        }
        const text = document.createElement('span');
        text.textContent = part.text;
        if (part.kind === 'model') protectModelName(text);
        item.append(text);
        return item;
    });
    const parameters = fitParameters ? items.filter((item, index) => parts[index].kind === 'parameter') : [];
    target.classList.toggle('has-scrollable-parameters', parameters.length > 0);
    target.replaceChildren(...(parameters.length
        ? [...items.filter((item, index) => parts[index].kind !== 'parameter'), createParameterRegion(parameters)] : items));
    if (target.classList.contains('bp-model-name')) {
        for (const item of items.filter((item, index) => parts[index].kind !== 'parameter')) observeLabelLayout(item);
    }
}
